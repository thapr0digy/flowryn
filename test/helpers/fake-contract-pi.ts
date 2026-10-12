#!/usr/bin/env bun
/**
 * A fake Pi 0.87.1 worker for the offline contract test
 * (test/integration/contracts-offline.test.ts), started by the fake Herdr's
 * agent.start in place of the FAKE: worker. It loads the real Flowryn worker
 * extension the daemon wrote next to the run (`-e <file>`) and plays Pi's side
 * of the extension API with the semantics the M0 spikes recorded:
 *   - session_start at launch and resume; agent_start once per run and
 *     agent_settled exactly once per run, an abort included (p04, p14);
 *   - context before every model request, with the custom messages it carries
 *     (p13); tool_call handlers may block a call (p08), and
 *     tool_execution_start/end bracket each one that runs;
 *   - sendMessage: steer while busy arrives after the current tool batch
 *     (p13), followUp while busy after the run's work in the same run (p02),
 *     followUp with triggerTurn while idle starts a run (p03); an abort drops
 *     queued custom messages (p14).
 *
 * The model is the offline scripted provider's (spikes/pi/lib/scripted-provider.ts)
 * only when launched as the contract gate launches Pi: `--model
 * flowryn-scripted/scripted`, the provider loaded with a second `-e`, a
 * scratch PI_CODING_AGENT_DIR and PI_OFFLINE=1. Then the FLOWRYN-SCRIPT line
 * in the task file holds the steps, one per model request, so tool results,
 * steers and follow-ups advance it as in a real turn; `bash <command>` is one
 * Bash call (a contract `perl -e 'sleep N'` sleeps N tenths of a second,
 * fake-contract-shared.ts), `say <text>` a final reply, and an exhausted
 * script says "ok". Launched any other way it plays a real model that ignores
 * steers (the scout's openrouter/free failure): it runs the task's first
 * command, says ONE and never acknowledges anything. The position is kept per
 * session next to the task file, as Pi's session history keeps it across a resume.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { logLine, ToolCall } from "./fake-contract-shared.ts";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;

const args = process.argv.slice(3);
const env = process.env;

function flag(name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

const session = flag("--session-id") ?? "no-session";
const extensionPath = resolve(flag("-e") ?? "");
const taskFile = env.FLOWRYN_TASK_FILE ?? "";
const stateFile = join(dirname(taskFile), `fake-pi-script-${session}.json`);
const resumed = existsSync(stateFile);
const cwd = process.cwd();

function log(message: string): void {
  logLine("fake-contract-pi", message);
}

// ---- the scripted model ----

/**
 * A run's first model request takes this long, as a live one does: the
 * extension's agent_start (prompt) and tool hooks are fire-and-forget, and a
 * first request answered at once could let the tool's hook overtake the run's
 * own. Later requests answer at once, as the scripted provider does.
 */
const FIRST_REQUEST_MS = 300;

/**
 * Every request of the steer-ignoring "real" model takes this long, as a live
 * model's inference does: the extension's steer-seen hook (at the request) and
 * stop hook (at the turn end) are fire-and-forget, and an instant reply could
 * let the turn end land before the steer was marked seen.
 */
const REAL_MODEL_REQUEST_MS = 500;

interface ScriptState {
  steps: string[];
  played: number;
}

/** Launched as the contract gate launches Pi: the scripted model, its provider extension, a scratch agent dir, offline. */
function launchedScripted(): boolean {
  const extensions = args.flatMap((a, i) => (a === "-e" && args[i + 1] ? [args[i + 1]!] : []));
  const agentDir = env.PI_CODING_AGENT_DIR ?? "";
  return (
    flag("--model") === "flowryn-scripted/scripted" &&
    extensions.some((e) => e.endsWith("/pi/scripted-provider.ts") && existsSync(e)) &&
    agentDir !== "" &&
    !agentDir.startsWith(join(env.HOME ?? "/nonexistent", ".pi")) &&
    env.PI_OFFLINE === "1"
  );
}

/** A real model that does the task's first step and ignores every steer. */
const IGNORING_MODEL = ["bash perl -e 'sleep 25'", "say ONE"];

const scripted = launchedScripted();

function loadScript(): ScriptState {
  if (existsSync(stateFile)) return JSON.parse(readFileSync(stateFile, "utf8")) as ScriptState;
  if (!scripted) {
    log(`not launched as the scripted gate (${args.join(" ")}): playing a model that ignores steers`);
    return { steps: IGNORING_MODEL, played: 0 };
  }
  const line = (existsSync(taskFile) ? readFileSync(taskFile, "utf8") : "").split("\n").find((l) => l.includes("FLOWRYN-SCRIPT:")) ?? "";
  const script = line.slice(line.indexOf("FLOWRYN-SCRIPT:") + "FLOWRYN-SCRIPT:".length).trim();
  return { steps: script ? script.split(" ;; ").map((s) => s.trim()) : [], played: 0 };
}

const script = loadScript();

/** The next model reply: a bash call or a final text. */
function nextStep(): { bash: string } | { say: string } {
  const step = script.steps[script.played];
  script.played++;
  writeFileSync(stateFile, JSON.stringify(script));
  if (step?.startsWith("bash ")) return { bash: step.slice(5) };
  return { say: step?.startsWith("say ") ? step.slice(4) : "ok" };
}

// ---- the host ----

const handlers = new Map<string, Handler[]>();
let running = false;
let aborted = false;
let current: ToolCall | null = null;
/** Custom messages for the next model request (steers), and follow-ups for after this run's work. */
let queued: { customType?: string; content: unknown }[] = [];
let followUps: { customType?: string; content: unknown }[] = [];
let toolNo = 0;

const ctx = {
  cwd,
  isIdle: () => !running,
  abort: () => {
    if (!running) return;
    aborted = true;
    current?.abort();
  },
  sessionManager: { getSessionId: () => session, getSessionFile: () => null },
};

async function emit(name: string, event: Record<string, unknown> = {}): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const handler of handlers.get(name) ?? []) results.push(await handler({ type: name, ...event }, ctx));
  return results;
}

const pi = {
  on(name: string, handler: Handler) {
    handlers.set(name, [...(handlers.get(name) ?? []), handler]);
  },
  sendMessage(message: { customType?: string; content: unknown }, options: { deliverAs?: string; triggerTurn?: boolean } = {}) {
    if (!running) {
      if (options.triggerTurn) startRun([message]);
      else followUps.push(message);
      return;
    }
    if (options.deliverAs === "steer") queued.push(message);
    else followUps.push(message);
  },
};

function startRun(messages: { customType?: string; content: unknown }[]): void {
  running = true;
  void run(messages).then(() => {
    running = false;
    if (followUps.length > 0) startRun(followUps.splice(0));
  });
}

/** One agent run: requests and tool calls until a final reply with nothing queued, or an abort. */
async function run(messages: { customType?: string; content: unknown }[]): Promise<void> {
  aborted = false;
  queued.push(...messages);
  await emit("agent_start");
  for (let request = 0; ; request++) {
    await emit("context", { messages: queued.splice(0) });
    if (!scripted) await Bun.sleep(REAL_MODEL_REQUEST_MS);
    else if (request === 0) await Bun.sleep(FIRST_REQUEST_MS);
    const step = nextStep();
    if ("say" in step) {
      log(`say ${step.say}`);
      if (followUps.length === 0) break;
      queued.push(...followUps.splice(0));
      continue;
    }
    const toolCallId = `call_${++toolNo}`;
    const blocked = (await emit("tool_call", { toolName: "bash", toolCallId, input: { command: step.bash } })).find((r) => (r as { block?: boolean } | undefined)?.block);
    if (blocked) {
      log(`blocked ${step.bash}`);
      continue;
    }
    log(`bash ${step.bash}`);
    await emit("tool_execution_start", { toolName: "bash", toolCallId });
    current = new ToolCall();
    await current.run(step.bash, env, cwd);
    current = null;
    await emit("tool_execution_end", { toolName: "bash", toolCallId });
    if (aborted) {
      // An abort ends the run and drops what was queued for it (M0 p14).
      queued = [];
      followUps = [];
      break;
    }
  }
  await emit("agent_settled");
}

process.on("SIGTERM", () => {
  void emit("session_shutdown").finally(() => process.exit(0));
});

const factory = (await import(extensionPath)).default as (api: typeof pi) => void;
factory(pi);
setInterval(() => {}, 60_000);
await emit("session_start", { reason: resumed ? "resume" : "startup" });
const prompt = args[args.length - 1] ?? "";
const attached = args.find((a) => a.startsWith("@"));
startRun([{ content: attached && existsSync(attached.slice(1)) ? `${readFileSync(attached.slice(1), "utf8")}\n${prompt}` : prompt }]);
