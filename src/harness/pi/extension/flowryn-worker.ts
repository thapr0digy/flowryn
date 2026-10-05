// Flowryn Pi worker extension (design section 5, Pi worker column).
//
// flowrynd writes this file next to each run and loads it with `pi -e <file>`,
// which scopes it to that one process (M0 p12). Pi 0.87.1 resolves extensions
// without node_modules (M0 finding 10), and this file imports nothing from
// Pi's packages, so it also typechecks inside the Flowryn repo.
//
// Everything it reports goes through the flowryn CLI ($FLOWRYN_BIN hook ...),
// the same verbs Claude's hooks call, so any decision here can be reproduced
// by hand. It:
//   - answers project_trust for the run's own worktree, for this process only,
//     never remembering it (equivalent to --approve; M0 p11);
//   - reports session_start (worker-start), agent_start (busy, idempotent,
//     since it repeats on retries: M0 p04), tool activity (busy lease, at most
//     once a minute), agent_settled (turn ended) and session_shutdown;
//   - holds one `hook wait-steer` long poll and delivers each steer it returns:
//     deliverAs "steer" while busy, right after the current tool batch
//     (M0 p13), or followUp + triggerTurn while idle (M0 p03); always with an
//     explicit deliverAs (M0 finding 14); then says which (hook steer-carried),
//     because only a followUp to an idle agent must be seen within seconds;
//   - reports each delivered steer as seen (hook steer-seen) once a context
//     event, which fires before every model request, shows it in the request;
//   - aborts the current run when the daemon asks for an interrupt (ctx.abort,
//     M0 p14). A steer queued before an abort is dropped by Pi, so the daemon
//     counts delivery only by the worker's ack and re-rings otherwise;
//   - for an urgent steer (Tier 2) delivered into a busy turn: blocks every
//     tool call until the steer is seen (tool_call {block}, M0 p08), so the
//     batch ends and the queued steer goes into the next request; and once the
//     oldest running tool has run preempt_after_ms, asks the daemon (hook
//     preempt, which refuses while a dialog may be open) and on go aborts. The
//     stop after the abort tells the daemon the queued copy was dropped, and it
//     rings again to the idle agent.
import { spawn } from "node:child_process";

type Json = Record<string, any>;

const BIN = process.env.FLOWRYN_BIN ?? "";
const WORKTREE = process.env.FLOWRYN_WORKTREE ?? "";
const TOOL_PING_MS = 60_000;
/** A pause before re-polling after an empty reply, so a misbehaving daemon cannot spin the loop. */
const REPOLL_MS = 50;
const STEER_CUSTOM_TYPE = "flowryn-steer";
/** A deferred preemption (a dialog may be open) asks again this often. */
const PREEMPT_RECHECK_MS = 1_000;

function runHook(name: string, input: Json, extra: string[] = []): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(BIN, ["hook", name, "--harness", "pi", ...extra], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      resolve({ code: 1, stdout: "" });
      return;
    }
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", () => resolve({ code: 1, stdout: "" }));
    child.on("close", (code: number | null) => resolve({ code: code ?? 1, stdout }));
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(input));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function inside(cwd: string): boolean {
  return WORKTREE !== "" && (cwd === WORKTREE || cwd.startsWith(`${WORKTREE}/`));
}

export default function flowrynWorker(pi: any): void {
  if (BIN === "") return;
  let ctx: any;
  let looping = false;
  let stopped = false;
  let lastToolPing = 0;
  /** Steers delivered and not yet seen in a model request. */
  const unseen = new Set<string>();
  /** The main agent's running tools: tool call id → start time. */
  const running = new Map<string, number>();
  /** The urgent steer delivered into the busy turn and not yet seen, or null. */
  let urgent: { id: string; afterMs: number; asked: boolean } | null = null;
  let preemptTimer: ReturnType<typeof setTimeout> | null = null;

  function oldestTool(): number | null {
    let oldest: number | null = null;
    for (const at of running.values()) if (oldest === null || at < oldest) oldest = at;
    return oldest;
  }

  function clearPreemptTimer(): void {
    if (preemptTimer) clearTimeout(preemptTimer);
    preemptTimer = null;
  }

  /** Time the cut: when the oldest running tool reaches the threshold, ask the daemon. */
  function planPreempt(delayMs?: number): void {
    clearPreemptTimer();
    const started = oldestTool();
    if (!urgent || urgent.asked || started === null) return;
    const wait = delayMs ?? Math.max(0, started + urgent.afterMs - Date.now());
    preemptTimer = setTimeout(() => void askPreempt(), wait);
  }

  async function askPreempt(): Promise<void> {
    preemptTimer = null;
    const started = oldestTool();
    if (!urgent || urgent.asked || started === null) return;
    const toolMs = Date.now() - started;
    if (toolMs < urgent.afterMs) return planPreempt();
    const id = urgent.id;
    const reply = await runHook("preempt", { steer: id, tool_ms: toolMs }, ["--json"]);
    if (!urgent || urgent.id !== id) return;
    let answer: Json = {};
    try {
      answer = JSON.parse(reply.stdout.trim().split("\n").pop() ?? "{}");
    } catch {
      // No answer (the daemon is down): never cut without one; try again.
    }
    if (answer.go === true) {
      urgent.asked = true;
      try {
        ctx?.abort?.();
      } catch {
        // no run to abort
      }
      return;
    }
    if (answer.go === false) {
      urgent.asked = true;
      return;
    }
    planPreempt(PREEMPT_RECHECK_MS);
  }

  const remember = (c: any) => {
    if (c) ctx = c;
  };

  pi.on("project_trust", (event: any) => ({ trusted: inside(String(event?.cwd ?? "")) ? "yes" : "undecided" }));

  pi.on("session_start", async (event: any, c: any) => {
    remember(c);
    const sm = c?.sessionManager;
    await runHook("worker-start", {
      session_id: sm?.getSessionId?.() ?? null,
      session_file: sm?.getSessionFile?.() ?? null,
      cwd: c?.cwd ?? process.cwd(),
      source: event?.reason ?? null,
    });
    void steerLoop();
  });

  pi.on("agent_start", async (_event: any, c: any) => {
    remember(c);
    void runHook("prompt", {});
  });

  // While an urgent steer is unseen, no tool starts: the batch ends and the queued steer goes next (M0 p08, p13).
  pi.on("tool_call", async (_event: any, c: any) => {
    remember(c);
    if (!urgent) return undefined;
    return { block: true, reason: `Blocked by Flowryn: urgent steer [${urgent.id}] is waiting; read it, then redo this call if it still applies.` };
  });

  pi.on("tool_execution_end", async (event: any, c: any) => {
    remember(c);
    running.delete(String(event?.toolCallId ?? ""));
    planPreempt();
  });

  pi.on("tool_execution_start", async (event: any, c: any) => {
    remember(c);
    running.set(String(event?.toolCallId ?? ""), Date.now());
    planPreempt();
    const now = Date.now();
    if (now - lastToolPing < TOOL_PING_MS) return;
    lastToolPing = now;
    void runHook("pre-tool", {});
  });

  // context fires before each model request with the messages it carries (M0 p13).
  pi.on("context", async (event: any, c: any) => {
    remember(c);
    if (unseen.size === 0) return undefined;
    const messages: any[] = Array.isArray(event?.messages) ? event.messages : [];
    const seen: string[] = [];
    for (const message of messages) {
      if (message?.customType !== STEER_CUSTOM_TYPE) continue;
      const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
      for (const id of unseen) if (text.includes(`[${id}]`)) seen.push(id);
    }
    if (seen.length > 0) {
      for (const id of seen) unseen.delete(id);
      if (urgent && seen.includes(urgent.id)) {
        urgent = null;
        clearPreemptTimer();
      }
      void runHook("steer-seen", { steers: seen });
    }
    return undefined;
  });

  pi.on("agent_settled", async (_event: any, c: any) => {
    remember(c);
    // The turn is over: nothing runs, and an unseen urgent steer goes again to the idle agent (the daemon re-rings it).
    running.clear();
    if (urgent) unseen.delete(urgent.id);
    urgent = null;
    clearPreemptTimer();
    void runHook("stop", {});
  });

  pi.on("session_shutdown", async () => {
    stopped = true;
    clearPreemptTimer();
    await runHook("session-end", {});
  });

  function deliver(id: string, line: string, urgentAfterMs: number | null): void {
    const idle = ctx?.isIdle?.() !== false;
    const message = { customType: STEER_CUSTOM_TYPE, content: line, display: true };
    try {
      pi.sendMessage(message, idle ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "steer" });
    } catch {
      // Not delivered; the daemon re-rings an unacknowledged steer.
      return;
    }
    if (id === "") return;
    unseen.add(id);
    void runHook("steer-carried", { steer: id, mode: idle ? "followUp" : "steer" });
    // An idle agent reads it at once; a busy one is cut short for it.
    if (!idle && urgentAfterMs !== null && !urgent) {
      urgent = { id, afterMs: urgentAfterMs, asked: false };
      planPreempt();
    }
  }

  async function steerLoop(): Promise<void> {
    if (looping) return;
    looping = true;
    try {
      for (;;) {
        if (stopped) break;
        const reply = await runHook("wait-steer", {}, ["--json"]);
        if (stopped) break;
        let message: Json;
        try {
          message = JSON.parse(reply.stdout.trim().split("\n").pop() ?? "");
        } catch {
          await sleep(2_000);
          continue;
        }
        if (message.exit) break;
        if (message.command === "interrupt") {
          try {
            ctx?.abort?.();
          } catch {
            // no run to abort
          }
          continue;
        }
        if (message.steer?.line) {
          const after = message.steer.urgent === true && typeof message.steer.preempt_after_ms === "number" ? message.steer.preempt_after_ms : null;
          deliver(String(message.steer.id ?? ""), String(message.steer.line), after);
        }
        else await sleep(REPOLL_MS);
      }
    } finally {
      looping = false;
    }
  }
}
