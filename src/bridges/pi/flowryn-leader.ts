// Flowryn Pi leader extension (design section 5, Pi leader column).
//
// `flowryn lead --pi` writes this file into the Flowryn home and loads it with
// `pi -e <file>`, which scopes it to that one process (M0 p12); your own Pi
// settings are never edited. Pi 0.87.1 resolves extensions without
// node_modules (M0 finding 10), and this file imports nothing from Pi's
// packages, so it also typechecks inside the Flowryn repo.
//
// It decides nothing itself: everything goes through `$FLOWRYN_BIN hook ...`
// with the leader session's token, the same verbs the Claude leader's hooks
// call, and the daemon answers. It:
//   - reports session_start and compaction (the daemon claims a vacant lease
//     and answers with the briefing, sent with deliverAs "nextTurn"; after an
//     overflow compaction that retries, with "steer", M0 p06);
//   - reports your prompt from before_agent_start and queues the P1 digest
//     with "nextTurn", which Pi injects into that same prompt;
//   - reports agent_start (busy; idempotent, since it repeats on retries,
//     M0 p04), tool activity (busy lease), agent_settled (turn end) and
//     session_shutdown;
//   - watches the composer and your keystrokes (M0 p09) and reports when you
//     go inactive (idle, empty composer, no input for inactive_ms) or come back;
//   - holds one `hook wait-p0` long poll: a P0 while busy is sent as a
//     followUp, while idle and you inactive as a followUp with triggerTurn
//     (a half-typed draft stays untouched, M0 p03); it re-checks what it sees
//     first and declines otherwise, and always passes deliverAs (M0 finding 14);
//   - blocks shell calls to flowryn merge, approve and hook (M0 p08).
// The hook calls that report state go through one queue, so the daemon sees
// them in the order Pi emitted them.
import { spawn } from "node:child_process";

type Json = Record<string, any>;

const BIN = process.env.FLOWRYN_BIN ?? "";
const INACTIVE_MS = Number(process.env.FLOWRYN_LEADER_INACTIVE_MS ?? "60000") || 60_000;
const TOOL_PING_MS = 60_000;
const EXIT_BACKOFF_MS = 10_000;
const SHELL_GATE = /\bflowryn\s+(merge|approve|hook)\b/;

function runHook(name: string, input: Json): Promise<Json | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(BIN, ["hook", name, "--harness", "pi", "--json"], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", () => resolve(null));
    child.on("close", () => {
      try {
        const line = stdout.trim().split("\n").pop() ?? "";
        resolve(line ? (JSON.parse(line) as Json) : null);
      } catch {
        resolve(null);
      }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(input));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function flowrynLeader(pi: any): void {
  if (BIN === "") return;
  let ctx: any;
  let stopped = false;
  let looping = false;
  let lastToolPing = 0;
  let lastInput = Date.now();
  let reportedInactive = false;
  let activityTimer: ReturnType<typeof setInterval> | undefined;
  let removeInput: (() => void) | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const remember = (c: any) => {
    if (c) ctx = c;
  };

  /** State hooks run one at a time, in the order Pi emitted them. */
  function enqueue(name: string, input: Json): Promise<Json | null> {
    const next = queue.then(() => runHook(name, input));
    queue = next.catch(() => null);
    return next;
  }

  function send(customType: string, content: string, options: Json): void {
    try {
      pi.sendMessage({ customType, content, display: true }, options);
    } catch {
      // Not delivered: an actionable item stays open and is listed again; an informational one is carried again.
    }
  }

  function hasTui(): boolean {
    return Boolean(ctx?.hasUI) && ctx?.mode === "tui";
  }

  function composerEmpty(): boolean {
    try {
      return String(ctx?.ui?.getEditorText?.() ?? "").trim() === "";
    } catch {
      return false;
    }
  }

  function idle(): boolean {
    try {
      return ctx?.isIdle?.() !== false;
    } catch {
      return false;
    }
  }

  /** You are inactive: idle, an empty composer, and no keystroke for INACTIVE_MS (design section 5). */
  function inactiveNow(): boolean {
    return hasTui() && idle() && composerEmpty() && Date.now() - lastInput >= INACTIVE_MS;
  }

  function checkActivity(): void {
    if (stopped) return;
    const inactive = inactiveNow();
    if (inactive !== reportedInactive) {
      reportedInactive = inactive;
      void enqueue("notify", { inactive });
    }
  }

  function startSessionResources(c: any): void {
    removeInput?.();
    removeInput = undefined;
    if (hasTui() && typeof c?.ui?.onTerminalInput === "function") {
      try {
        removeInput = c.ui.onTerminalInput(() => {
          lastInput = Date.now();
          if (reportedInactive) checkActivity();
          return undefined;
        });
      } catch {
        removeInput = undefined;
      }
    }
    if (!activityTimer) {
      activityTimer = setInterval(checkActivity, Math.max(250, Math.min(5_000, Math.floor(INACTIVE_MS / 4))));
      (activityTimer as any).unref?.();
    }
  }

  function stopSessionResources(): void {
    if (activityTimer) clearInterval(activityTimer);
    activityTimer = undefined;
    removeInput?.();
    removeInput = undefined;
  }

  pi.on("session_start", async (event: any, c: any) => {
    remember(c);
    stopped = false;
    lastInput = Date.now();
    reportedInactive = false;
    startSessionResources(c);
    const reply = await enqueue("session-start", {
      session_id: c?.sessionManager?.getSessionId?.() ?? null,
      cwd: c?.cwd ?? process.cwd(),
      source: event?.reason ?? "startup",
      has_ui: hasTui(),
    });
    const context = reply?.context;
    if (typeof context === "string" && context.length > 0) send("flowryn-briefing", context, { deliverAs: "nextTurn" });
    void p0Loop();
  });

  pi.on("session_compact", async (event: any, c: any) => {
    remember(c);
    const retry = event?.willRetry === true;
    const reply = await enqueue("session-start", { source: "compact", will_retry: retry, has_ui: hasTui() });
    const context = reply?.context;
    // Overflow recovery retries as a fresh run that a nextTurn message misses (M0 p06).
    if (typeof context === "string" && context.length > 0) send("flowryn-briefing", context, { deliverAs: retry ? "steer" : "nextTurn" });
  });

  pi.on("before_agent_start", async (event: any, c: any) => {
    remember(c);
    lastInput = Date.now();
    reportedInactive = false;
    const reply = await enqueue("prompt", { source: "user", prompt: String(event?.prompt ?? "") });
    const context = reply?.context;
    // Pi injects pending nextTurn messages right after this handler, into this prompt.
    if (typeof context === "string" && context.length > 0) send("flowryn-digest", context, { deliverAs: "nextTurn" });
  });

  pi.on("agent_start", async (_event: any, c: any) => {
    remember(c);
    void enqueue("prompt", { source: "run" });
  });

  pi.on("tool_execution_start", async (_event: any, c: any) => {
    remember(c);
    const now = Date.now();
    if (now - lastToolPing < TOOL_PING_MS) return;
    lastToolPing = now;
    void enqueue("pre-tool", {});
  });

  pi.on("agent_settled", async (_event: any, c: any) => {
    remember(c);
    void enqueue("stop", {});
  });

  pi.on("session_shutdown", async (event: any) => {
    const reason = String(event?.reason ?? "quit");
    if (reason === "quit") stopped = true;
    stopSessionResources();
    await enqueue("session-end", { reason });
  });

  pi.on("tool_call", async (event: any) => {
    const name = String(event?.toolName ?? "");
    const command = name === "bash" ? String(event?.input?.command ?? "") : "";
    if (command !== "" && SHELL_GATE.test(command)) {
      return { block: true, reason: "flowryn: merge and approve need the user, and hook verbs belong to the harness; this session cannot run them from the shell" };
    }
    return undefined;
  });

  /** Deliver one pushed P0, or decline it, after checking what Pi shows right now. */
  async function deliver(push: Json): Promise<void> {
    const item = String(push.id ?? "");
    const line = String(push.line ?? "");
    if (!item || !line) return;
    const mode = !idle() ? "continuation" : inactiveNow() ? "trigger" : null;
    await enqueue("delivered", { item, mode: mode ?? "declined", ok: mode !== null });
    if (mode === "trigger") send("flowryn-p0", line, { deliverAs: "followUp", triggerTurn: true });
    else if (mode === "continuation") {
      // The run may have ended while the report was on its way: then it rides with your next prompt instead.
      send("flowryn-p0", line, idle() ? { deliverAs: "nextTurn" } : { deliverAs: "followUp" });
    }
  }

  async function p0Loop(): Promise<void> {
    if (looping) return;
    looping = true;
    try {
      for (;;) {
        if (stopped) break;
        const reply = await runHook("wait-p0", {});
        if (stopped) break;
        if (!reply) {
          await sleep(2_000);
          continue;
        }
        if (reply.exit) {
          // Not the lease holder (or superseded): look again later, in case this session claims.
          await sleep(EXIT_BACKOFF_MS);
          continue;
        }
        if (reply.deliver) await deliver(reply.deliver as Json);
      }
    } finally {
      looping = false;
    }
  }
}
