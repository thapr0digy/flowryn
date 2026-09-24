#!/usr/bin/env bun
/**
 * A fake Pi 0.87.1 for tests: it loads the real Flowryn leader extension (the
 * file `flowryn lead --pi` writes) and plays Pi's side of the extension API
 * with the semantics the M0 spikes recorded:
 *   - sendMessage nextTurn waits for your next prompt and never starts a turn
 *     (p01); Pi injects it right after before_agent_start handlers;
 *   - followUp while busy arrives after the run's work, in the same run
 *     (p02); followUp with triggerTurn while idle starts a run (p03), and a
 *     half-typed composer is left untouched;
 *   - steer while busy arrives after the current tool batch (p13);
 *   - agent_start once per run here, agent_settled exactly once per run,
 *     including an abort (p04, p14); an abort drops queued custom messages;
 *   - the composer and your keystrokes are visible to the extension (p09).
 * The test drives it with JSON commands on stdin and reads JSON events on
 * stdout: {ev: "seen", text, via} for everything that reached the model.
 *
 *   bun fake-pi-host.ts <extension.ts>
 *   {"id": 1, "cmd": "start" | "prompt" | "prompt_busy" | "finish" | "type" | "clear"
 *                    | "interrupt" | "compact" | "quit", "text"?, "willRetry"?}
 */

export {};

type Handler = (event: any, ctx: any) => unknown;

const extensionPath = process.argv[2];
if (!extensionPath) {
  process.stderr.write("usage: fake-pi-host.ts <extension.ts>\n");
  process.exit(2);
}

const handlers = new Map<string, Handler[]>();
const inputHandlers = new Set<(data: string) => unknown>();
let running = false;
let inTool = false;
let editor = "";
let nextTurn: string[] = [];
let appended: string[] = [];
let followUps: { text: string; custom: boolean }[] = [];
let steers: string[] = [];
let releaseTool: (() => void) | null = null;
let aborted = false;

function out(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function see(text: string, via: string): void {
  out({ ev: "seen", text, via });
}

async function emit(name: string, event: Record<string, unknown> = {}): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const handler of handlers.get(name) ?? []) results.push(await handler({ type: name, ...event }, ctx));
  return results;
}

const ctx = {
  hasUI: true,
  mode: "tui",
  cwd: process.cwd(),
  isIdle: () => !running,
  abort: () => void abortRun(),
  hasPendingMessages: () => followUps.length > 0 || steers.length > 0,
  sessionManager: { getSessionId: () => "fake-pi-session", getSessionFile: () => null },
  ui: {
    getEditorText: () => editor,
    setEditorText: (text: string) => {
      editor = text;
    },
    onTerminalInput: (handler: (data: string) => unknown) => {
      inputHandlers.add(handler);
      return () => inputHandlers.delete(handler);
    },
    notify: () => {},
    confirm: async () => false,
  },
};

const pi = {
  on(name: string, handler: Handler) {
    const list = handlers.get(name) ?? [];
    list.push(handler);
    handlers.set(name, list);
    return () => handlers.set(name, (handlers.get(name) ?? []).filter((h) => h !== handler));
  },
  sendMessage(message: { content: string }, options: { deliverAs?: string; triggerTurn?: boolean } = {}) {
    const text = String(message.content ?? "");
    if (options.deliverAs === "nextTurn") nextTurn.push(text);
    else if (running && options.triggerTurn !== false) {
      if (options.deliverAs === "followUp") followUps.push({ text, custom: true });
      else steers.push(text);
      if (!inTool) void flushSteers();
    } else if (options.triggerTurn) void run([text], "trigger");
    else appended.push(text);
  },
  sendUserMessage(text: string, options: { deliverAs?: string } = {}) {
    if (running && !options.deliverAs) {
      out({ ev: "extension_error", error: "Agent is already processing." });
      return;
    }
    if (running) followUps.push({ text, custom: false });
    else void prompt(text);
  },
  registerTool() {},
  registerCommand() {},
  registerProvider() {},
};

async function flushSteers(): Promise<void> {
  while (steers.length > 0) see(steers.shift()!, "steer");
}

/** One run: the first request carries `messages`; follow-ups queued meanwhile arrive after the work, in the same run. */
async function run(messages: string[], via: string, holdTool = false): Promise<void> {
  running = true;
  aborted = false;
  await emit("agent_start");
  for (const text of [...appended, ...messages]) see(text, via);
  appended = [];
  if (holdTool) {
    inTool = true;
    await emit("tool_execution_start", { toolName: "bash" });
    out({ ev: "busy" });
    await new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    inTool = false;
    if (aborted) return;
    await flushSteers();
  }
  while (followUps.length > 0 && !aborted) see(followUps.shift()!.text, "followUp");
  await settle();
}

async function settle(): Promise<void> {
  running = false;
  inTool = false;
  await emit("agent_settled");
  out({ ev: "settled" });
}

async function abortRun(): Promise<void> {
  if (!running) return;
  aborted = true;
  // M0 p14: queued custom messages are dropped; a queued user message moves to the composer.
  for (const f of followUps) if (!f.custom) editor = f.text;
  followUps = [];
  steers = [];
  releaseTool?.();
  releaseTool = null;
  await settle();
}

async function prompt(text: string, holdTool = false): Promise<void> {
  if (running) throw new Error("Agent is already processing");
  await emit("before_agent_start", { prompt: text });
  const messages = [text, ...nextTurn];
  nextTurn = [];
  if (holdTool) {
    void run(messages, "prompt", true);
    return;
  }
  await run(messages, "prompt");
}

async function typeText(text: string): Promise<void> {
  editor += text;
  for (const handler of inputHandlers) handler(text);
}

async function handle(command: { id: number; cmd: string; text?: string; willRetry?: boolean }): Promise<void> {
  switch (command.cmd) {
    case "start":
      await emit("session_start", { reason: "startup" });
      break;
    case "prompt":
      editor = "";
      await prompt(command.text ?? "hello");
      break;
    case "prompt_busy":
      editor = "";
      await prompt(command.text ?? "work", true);
      while (!inTool) await Bun.sleep(5);
      break;
    case "finish": {
      const release = releaseTool;
      releaseTool = null;
      release?.();
      while (running) await Bun.sleep(5);
      break;
    }
    case "type":
      await typeText(command.text ?? "x");
      break;
    case "clear":
      editor = "";
      for (const handler of inputHandlers) handler("\u0015");
      break;
    case "interrupt":
      await abortRun();
      break;
    case "compact":
      // An idle /compact is not a run: no agent_settled (M0 p04).
      await emit("session_compact", { reason: "manual", willRetry: command.willRetry === true, fromExtension: false });
      break;
    case "quit":
      await emit("session_shutdown", { reason: "quit" });
      out({ ev: "ack", id: command.id });
      process.exit(0);
      break;
    default:
      throw new Error(`unknown command ${command.cmd}`);
  }
}

const factory = (await import(extensionPath)).default as (api: typeof pi) => void;
factory(pi);
out({ ev: "ready" });

let buffer = "";
let chain: Promise<void> = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const command = JSON.parse(line) as { id: number; cmd: string; text?: string; willRetry?: boolean };
    // A command that holds (prompt_busy) must not block "finish" or "interrupt".
    const runNow = command.cmd === "finish" || command.cmd === "interrupt";
    const task = async () => {
      try {
        await handle(command);
        out({ ev: "ack", id: command.id });
      } catch (error) {
        out({ ev: "ack", id: command.id, error: (error as Error).message });
      }
    };
    if (runNow) void task();
    else chain = chain.then(task);
  }
});
process.stdin.on("end", () => process.exit(0));
