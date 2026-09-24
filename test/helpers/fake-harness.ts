#!/usr/bin/env bun
/**
 * A fake Claude or Pi worker for tests, started by the fake Herdr's
 * agent.start. It behaves like the harness only through the flowryn CLI:
 * the same hook verbs Claude's hooks and the Pi extension call, and the same
 * worker verbs a model would run. What it does comes from `FAKE:` lines in the
 * task file (the dispatch body):
 *
 *   FAKE: sleep <ms>                 a tool call; steers may arrive beside it
 *   FAKE: deliver <file> <text...>   write $FLOWRYN_REPORT_DIR/<file>, deliver --report
 *   FAKE: ask <a,b> <question...>    ask (blocking), then end the turn
 *   FAKE: fail <reason...>           fail
 *   FAKE: report <status>            report
 *   FAKE: crash                      exit 1 at once, like a killed process
 *   FAKE: no-start                   never report worker-start (a trust wedge)
 *   FAKE: cwd <path>                 report this cwd at worker-start (isolation test)
 *   FAKE: ignore-steers              never acknowledge a steer
 *
 * Steps run once per session: a resumed session continues after the last step
 * it finished (state kept next to the task file).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [kind = "claude", ...args] = process.argv.slice(2);
const env = process.env;
const BIN = env.FLOWRYN_BIN ?? "";
const harness = kind === "pi" ? "pi" : "claude";

function flag(name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

const session = flag("--session-id") ?? flag("--resume") ?? "no-session";
const prompt = args[args.length - 1] ?? "";
const taskFile = /Full task: (\S+)/.exec(prompt)?.[1] ?? "";
const taskText = taskFile && existsSync(taskFile) ? readFileSync(taskFile, "utf8") : prompt;
const steps = taskText
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.startsWith("FAKE:"))
  .map((l) => l.slice(5).trim());
const stateFile = join(dirname(taskFile || "."), `fake-state-${session}.json`);
const transcript = join(dirname(taskFile || "."), `fake-transcript-${session}.jsonl`);
const ignoreSteers = steps.includes("ignore-steers");
const cwdOverride = steps.find((s) => s.startsWith("cwd "))?.slice(4) ?? null;

function log(message: string): void {
  process.stdout.write(`${new Date().toISOString()} fake-${harness}: ${message}\n`);
}

function done(): number {
  try {
    return (JSON.parse(readFileSync(stateFile, "utf8")) as { done: number }).done;
  } catch {
    return 0;
  }
}

function markDone(n: number): void {
  writeFileSync(stateFile, JSON.stringify({ done: n }));
}

async function flowryn(argv: string[], stdin = ""): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([BIN, ...argv], { stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe", env });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

async function hook(name: string, input: Record<string, unknown> = {}, extra: string[] = []) {
  return flowryn(["hook", name, "--harness", harness, ...extra], JSON.stringify(input));
}

const acked = new Set<string>();

/** The additionalContext a Claude hook printed, if any. */
function contextOf(stdout: string): string | null {
  try {
    const value = JSON.parse(stdout.trim()) as { hookSpecificOutput?: { additionalContext?: string } };
    return value.hookSpecificOutput?.additionalContext ?? null;
  } catch {
    return null;
  }
}

/** Act on steer text (hook context, a pointer, or a Pi message): ack every id it names, unless told to ignore. */
async function onSteer(text: string): Promise<void> {
  if (ignoreSteers) return;
  const ids = new Set<string>();
  for (const match of text.matchAll(/\bm\d+\b/g)) ids.add(match[0]);
  if (/inbox/.test(text) && !/Flowryn steer \[/.test(text)) {
    const inbox = await flowryn(["inbox", "--json"]);
    for (const match of inbox.stdout.matchAll(/"id":"(m\d+)"/g)) ids.add(match[1]!);
  }
  for (const id of ids) {
    if (acked.has(id)) continue;
    const result = await flowryn(["ack", id]);
    log(`ack ${id} -> ${result.code}`);
    if (result.code === 0) acked.add(id);
  }
}

let interrupted = false;
let abortSleep: (() => void) | null = null;

process.on("SIGINT", () => {
  // The interrupt key: the running tool dies and the transcript records it; no hook fires (M0 c04).
  interrupted = true;
  appendFileSync(transcript, JSON.stringify({ type: "user", message: "[Request interrupted by user for tool use]" }) + "\n");
  abortSleep?.();
});
process.on("SIGTERM", () => process.exit(0));

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    abortSleep = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

/** One tool call, with the busy lease refreshed and a steer possibly riding back on PostToolUse. */
async function tool(run: () => Promise<void>): Promise<void> {
  await hook("pre-tool", { tool_name: "Bash" });
  await run();
  const post = await hook("post-tool", { tool_name: "Bash" });
  const context = contextOf(post.stdout);
  if (context) await onSteer(context);
}

async function runStep(step: string): Promise<"continue" | "end-turn"> {
  const [verb = "", ...rest] = step.split(/\s+/);
  switch (verb) {
    case "sleep":
      await tool(() => sleep(Number(rest[0] ?? 1000)));
      return interrupted ? "end-turn" : "continue";
    case "deliver": {
      const [file = "report.md", ...words] = rest;
      const path = join(env.FLOWRYN_REPORT_DIR ?? ".", file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${words.join(" ") || "fake report"}\n`);
      await tool(async () => {
        const result = await flowryn(["deliver", "--report", path]);
        log(`deliver -> ${result.code} ${result.stdout.trim()}`);
      });
      return "continue";
    }
    case "ask": {
      const [options = "yes,no", ...words] = rest;
      await tool(async () => {
        const result = await flowryn(["ask", "--options", options, "--blocking", "--body-file", "-"], words.join(" ") || "which one?");
        log(`ask -> ${result.code} ${result.stdout.trim()}`);
      });
      return "end-turn";
    }
    case "fail":
      await tool(async () => {
        await flowryn(["fail", "--body-file", "-"], rest.join(" ") || "cannot");
      });
      return "end-turn";
    case "report":
      await tool(async () => {
        await flowryn(["report", rest[0] ?? "progress"]);
      });
      return "continue";
    case "crash":
      log("crash");
      process.exit(1);
    default:
      return "continue";
  }
}

async function endTurn(): Promise<void> {
  // Stop may continue the turn with a steer, at most twice in a row (design section 5).
  for (;;) {
    const stop = await hook("stop");
    const context = contextOf(stop.stdout);
    if (!context) return;
    await onSteer(context);
  }
}

async function claudeIdle(): Promise<never> {
  // The asyncRewake waiter: exit 2 with a line on stderr wakes the session.
  for (;;) {
    const waiter = await hook("wait-steer");
    if (waiter.code === 2) {
      await hook("prompt");
      await onSteer(waiter.stderr);
      await endTurn();
    } else await sleep(200);
  }
}

async function piLoop(): Promise<void> {
  // The extension's long poll runs all the time, busy or idle.
  for (;;) {
    const reply = await hook("wait-steer", {}, ["--json"]);
    const message = (() => {
      try {
        return JSON.parse(reply.stdout.trim().split("\n").pop() ?? "{}") as { exit?: boolean; command?: string; steer?: { id: string; line: string } };
      } catch {
        return {};
      }
    })();
    if (message.exit) return;
    if (message.command === "interrupt") {
      interrupted = true;
      abortSleep?.();
      continue;
    }
    if (message.steer) await onSteer(message.steer.line);
    else await sleep(200);
  }
}

async function main(): Promise<void> {
  if (steps.includes("no-start")) {
    log("no-start: waiting forever");
    for (;;) await sleep(60_000);
  }
  await hook("worker-start", { session_id: session, cwd: cwdOverride ?? process.cwd(), transcript_path: transcript, source: flag("--resume") ? "resume" : "startup" });
  if (harness === "pi") void piLoop();
  await hook("prompt");
  for (let i = done(); i < steps.length; i++) {
    if (steps[i] === "crash") markDone(i + 1);
    const outcome = await runStep(steps[i]!);
    markDone(i + 1);
    if (outcome === "end-turn") break;
  }
  if (!interrupted) await endTurn();
  if (harness === "claude") await claudeIdle();
  for (;;) await sleep(60_000);
}

void main();
