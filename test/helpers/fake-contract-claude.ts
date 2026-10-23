#!/usr/bin/env bun
/**
 * A fake Claude Code worker for the offline contract test
 * (test/integration/contracts-offline.test.ts), started by the fake Herdr's
 * agent.start in place of the FAKE: worker. It reaches Flowryn only through
 * the hooks in the real per-run settings file (--settings) and the shell
 * commands a model would run, with the Claude semantics the M0 spikes recorded:
 *   - SessionStart at launch and resume; UserPromptSubmit at each turn start;
 *     PreToolUse and PostToolUse (PostToolUseFailure for a non-zero exit)
 *     around each Bash call; Stop at each turn end;
 *   - PostToolUse and Stop additionalContext reaches the model and a Stop
 *     continuation continues the turn, Stop firing again with
 *     stop_hook_active (c06); a PreToolUse deny skips the tool and hands the
 *     reason to the model;
 *   - an asyncRewake hook runs in the background; exit 2 wakes an idle
 *     session with its stderr as the prompt, and a busy one gets the line
 *     inside its running turn (c01);
 *   - the interrupt key (the fake Herdr's Escape is SIGINT) ends the running
 *     tool and the turn, fires no hook, and writes the marker to the
 *     transcript (c04);
 *   - each Bash call runs as in Claude's sandbox: TMPDIR is
 *     `$CLAUDE_CODE_TMPDIR/claude-<uid>` while that is at most 44 bytes, else
 *     the shared `/tmp/claude-<uid>`, whatever TMPDIR the session inherited
 *     (read in Claude 2.1.309, docs/notes/2026-10-22-give-every-worker-73.md);
 *   - at startup it records the deferred tools it was offered as a
 *     `deferred_tools_delta` transcript attachment (Claude 2.1.295), leaving
 *     out every MCP server the settings' `permissions.deny` names bare, as
 *     Claude does (verified live for the toolkit's static layer).
 *
 * Its "model" follows the contract suite's instructions (contractBody and each
 * steer's text in src/contracts/suite.ts) by fixed rules, no model involved:
 * run the `perl -e 'sleep N'` it is told to (N tenths of a second here,
 * fake-contract-shared.ts), acknowledge each steer (first when the steer says
 * so, otherwise once its work is done), write and deliver the report it is
 * told to, run the command the toolkit step names once and never retry a
 * toolkit denial, and otherwise end its turn. Anything else that continues a turn
 * (a Stop continuation that is not a steer, such as the turn-end guard's
 * reminder) is outside the contract: it has no rule for it and keeps working,
 * as Claude 2.1.291 did in the #32 regression, so the run never goes idle.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendJson, logLine, ToolCall } from "./fake-contract-shared.ts";

interface HookCommand {
  type: string;
  command: string;
  asyncRewake?: boolean;
}

const args = process.argv.slice(3);
const env = process.env;

function flag(name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

const session = flag("--session-id") ?? flag("--resume") ?? "no-session";
const resumed = flag("--resume") !== null;
const settingsPath = flag("--settings") ?? "";
const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { hooks: Record<string, { hooks: HookCommand[] }[]>; permissions?: { deny?: string[] } };
const hooks = settings.hooks;
const transcript = join(dirname(env.FLOWRYN_TASK_FILE ?? settingsPath), `fake-transcript-${session}.jsonl`);
const cwd = process.cwd();

function log(message: string): void {
  logLine("fake-contract-claude", message);
}

const waiters = new Set<ReturnType<typeof Bun.spawn>>();

/** Run one event's hooks: the command hooks in order (their stdout back), the asyncRewake ones in the background. */
async function runHooks(event: string, input: Record<string, unknown>): Promise<string[]> {
  const payload = JSON.stringify({ session_id: session, transcript_path: transcript, cwd, hook_event_name: event, ...input });
  const outputs: string[] = [];
  for (const group of hooks[event] ?? []) {
    for (const hook of group.hooks) {
      // exec: the hook process is this one's child, as a waiter's orphan check expects.
      const proc = Bun.spawn(["sh", "-c", `exec ${hook.command}`], { cwd, env, stdin: new Blob([payload]), stdout: "pipe", stderr: "pipe" });
      if (hook.asyncRewake) {
        waiters.add(proc);
        void proc.exited.then(async (code) => {
          waiters.delete(proc);
          if (code === 2) wake((await new Response(proc.stderr).text()).trim());
        });
        continue;
      }
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      log(`${event} ${hook.command.split(" hook ")[1] ?? hook.command} -> ${code}${stdout.trim() ? ` ${stdout.trim()}` : ""}`);
      outputs.push(stdout);
    }
  }
  return outputs;
}

function hookJson(stdout: string): { hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string; permissionDecisionReason?: string } } {
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return {};
  }
}

function contextOf(outputs: string[]): string | null {
  const parts = outputs.map((o) => hookJson(o).hookSpecificOutput?.additionalContext).filter((c): c is string => typeof c === "string");
  return parts.length > 0 ? parts.join("\n") : null;
}

function denyOf(outputs: string[]): string | null {
  for (const o of outputs) {
    const out = hookJson(o).hookSpecificOutput;
    if (out?.permissionDecision === "deny") return out.permissionDecisionReason ?? "";
  }
  return null;
}

// ---- the model: the contract's instructions, by rule ----

const handled = new Set<string>();
const STEER = /Flowryn steer \[(m\d+)\]: (.*?) \(when done: \$FLOWRYN_BIN ack m\d+\)/g;
const POINTER = /steer (m\d+) from your leader is waiting/;

/** The steers a text carries: their lines, or a pointer's (read with inbox, as the pointer says). */
async function steersIn(text: string): Promise<{ id: string; body: string }[]> {
  let source = text;
  if (POINTER.test(text)) {
    const proc = Bun.spawn([env.FLOWRYN_BIN ?? "flowryn", "inbox", "--json"], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const reply = JSON.parse((await new Response(proc.stdout).text()) || "{}") as { data?: { steers?: { steer: string }[] } };
    source += "\n" + (reply.data?.steers ?? []).map((s) => s.steer).join("\n");
  }
  return [...source.matchAll(STEER)].map((m) => ({ id: m[1]!, body: m[2]! }));
}

/** The commands an instruction asks for, in order. */
function workOf(text: string): string[] {
  const commands: string[] = [];
  const sleep = /perl -e 'sleep \d+'/.exec(text);
  if (sleep) commands.push(sleep[0]);
  const once = /run exactly this command once: (gh --version)/.exec(text);
  if (once) commands.push(once[1]!);
  const tmp = /run exactly this command with your shell tool: (echo "\$TMPDIR" > "\$FLOWRYN_REPORT_DIR\/tmpdir\.txt")/.exec(text);
  if (tmp) commands.push(tmp[1]!);
  const report = /Write one line, "([^"]*)", to (\S+), then run (\$FLOWRYN_BIN deliver --report \S+)/.exec(text);
  if (report) commands.push(`mkdir -p "$(dirname ${report[2]})" && printf '%s\\n' '${report[1]}' > ${report[2]}`, report[3]!);
  return commands;
}

async function plan(text: string): Promise<string[]> {
  const task = /Your full task is in (\S+?);/.exec(text);
  const commands = task && existsSync(task[1]!) ? workOf(readFileSync(task[1]!, "utf8")) : [];
  for (const steer of await steersIn(text)) {
    if (handled.has(steer.id)) continue;
    handled.add(steer.id);
    const ack = `$FLOWRYN_BIN ack ${steer.id}`;
    const steerWork = workOf(steer.body);
    commands.push(...(/acknowledge/i.test(steer.body) ? [ack, ...steerWork] : [...steerWork, ack]));
  }
  return commands;
}

/** The environment of a Bash call inside Claude's sandbox: its own per-uid TMPDIR. */
function sandboxed(): Record<string, string | undefined> {
  const uid = process.getuid?.() ?? 0;
  const own = join(env.CLAUDE_CODE_TMPDIR || "/tmp", `claude-${uid}`);
  return { ...env, TMPDIR: Buffer.byteLength(own) <= 44 ? own : `/tmp/claude-${uid}` };
}

// ---- the session ----

let busy = false;
/** Lines a waiter brought while the turn ran: the model reads them before its next step. */
const inbound: string[] = [];
let current: ToolCall | null = null;
let interrupted = false;
let onInterrupt: (() => void) | null = null;
let toolNo = 0;

function wake(line: string): void {
  log(`waiter: ${line}`);
  if (busy) inbound.push(line);
  else startTurn(line);
}

function startTurn(prompt: string): void {
  busy = true;
  void turn(prompt).then(() => {
    busy = false;
    if (inbound.length > 0) startTurn(inbound.splice(0).join("\n"));
  });
}

/** Run the commands as Bash tool calls; false when an interrupt ended the turn. */
async function work(queue: string[]): Promise<boolean> {
  while (queue.length > 0 || inbound.length > 0) {
    if (interrupted) return false;
    if (inbound.length > 0) queue.unshift(...(await plan(inbound.splice(0).join("\n"))));
    const command = queue.shift();
    if (command === undefined) continue;
    const tool = { tool_name: "Bash", tool_use_id: `toolu_contract_${++toolNo}`, tool_input: { command } };
    const denied = denyOf(await runHooks("PreToolUse", tool));
    if (denied !== null) {
      log(`denied ${command}: ${denied}`);
      // A toolkit denial is final (the toolkit step says not to retry it); an urgent steer's cut is redone unless it says otherwise.
      const redo = /do not run it again|toolkit rule/.test(denied) ? [] : [command];
      queue.unshift(...(await plan(denied)), ...redo);
      continue;
    }
    log(`bash ${command}`);
    current = new ToolCall();
    const code = await current.run(command, sandboxed(), cwd);
    current = null;
    if (interrupted) return false;
    const context = contextOf(await runHooks(code === 0 ? "PostToolUse" : "PostToolUseFailure", { ...tool, tool_response: { exit_code: code } }));
    if (context) queue.unshift(...(await plan(context)));
  }
  return !interrupted;
}

async function turn(prompt: string): Promise<void> {
  interrupted = false;
  log(`turn: ${prompt}`);
  await runHooks("UserPromptSubmit", { prompt });
  if (!(await work(await plan(prompt)))) return;
  let active = false;
  for (;;) {
    const context = contextOf(await runHooks("Stop", { stop_hook_active: active }));
    if (context === null) return;
    active = true;
    log(`stop continuation: ${context}`);
    if (!/Flowryn steer \[m\d+\]|steer m\d+ from your leader/.test(context)) {
      // Outside the contract's instructions: no rule for it, so the turn goes on until an interrupt or exit.
      await new Promise<void>((resolve) => (onInterrupt = resolve));
      return;
    }
    if (!(await work(await plan(context)))) return;
  }
}

process.on("SIGINT", () => {
  if (!busy) return;
  interrupted = true;
  appendJson(transcript, { type: "user", message: "[Request interrupted by user for tool use]" });
  current?.abort();
  onInterrupt?.();
  onInterrupt = null;
});
process.on("SIGTERM", () => {
  for (const waiter of waiters) waiter.kill("SIGTERM");
  process.exit(0);
});

/** The tools this fake Claude has, before `permissions.deny`: a built-in deferred tool and three MCP servers' tools. */
const OFFERED_TOOLS = ["WebFetch", "mcp__claude-in-chrome__tabs_context_mcp", "mcp__claude_ai_Atlassian_MCP__getJiraIssue", "mcp__claude_ai_Docs__read"];

function offeredTools(): string[] {
  const deniedServers = (settings.permissions?.deny ?? []).filter((rule) => rule.startsWith("mcp__") && !rule.slice(5).includes("__"));
  return OFFERED_TOOLS.filter((name) => !deniedServers.some((server) => name.startsWith(`${server}__`)));
}

if (!resumed) appendJson(transcript, { type: "attachment", attachment: { type: "deferred_tools_delta", addedNames: offeredTools(), removedNames: [], readdedNames: [] } });

// An idle session with no waiter running still lives until it is told to exit.
setInterval(() => {}, 60_000);
await runHooks("SessionStart", { source: resumed ? "resume" : "startup" });
startTurn(args[args.length - 1] ?? "");
