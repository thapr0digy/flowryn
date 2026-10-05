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
//   - blocks shell calls to flowryn merge, gate pass, approve, decide --by
//     captain and hook (M0 p08);
//   - registers the flowryn_merge tool, the Pi leader's human-confirmation
//     channel (design section 7): it shows the PR, head and checks with
//     ctx.ui.confirm() (M0 p07) and, on yes, merges with the approval key the
//     daemon handed this extension at lease claim (or a fresh one from
//     `hook approval-key`), passed on stdin, never in an environment;
//   - registers the flowryn_gate_pass tool the same way, for review gates (M5);
//   - registers the flowryn_decide tool the same way, for the user's own
//     answer to a decision (cutover C1).
// The hook calls that report state go through one queue, so the daemon sees
// them in the order Pi emitted them.
import { spawn } from "node:child_process";

type Json = Record<string, any>;

const BIN = process.env.FLOWRYN_BIN ?? "";
const INACTIVE_MS = Number(process.env.FLOWRYN_LEADER_INACTIVE_MS ?? "60000") || 60_000;
const TOOL_PING_MS = 60_000;
const EXIT_BACKOFF_MS = 10_000;
// Over-matches by design (the controller's ruling): a precise `decide ... --by captain` anchor
// misses `--by=captain`, quoted `captain`, reordered flags and a backslash-newline continuation.
// Not exported: importing this module from a unit test breaks files.ts's `with { type: "file" }`
// asset import of the same path elsewhere in the same test process (test/helpers/fake-pi-leader.ts
// drives it through the real extension instead).
const SHELL_GATE = /\bflowryn\s+(merge|approve|hook|gate\s+pass)\b|flowryn\b[\s\S]*\bdecide\b[\s\S]*captain/;

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

/** Run a flowryn command with text on stdin; the last JSON line of its stdout, if any. */
function runFlowryn(args: string[], stdin: string): Promise<Json | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(BIN, args, { stdio: ["pipe", "pipe", "ignore"] });
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
    child.stdin?.end(stdin);
  });
}

function text(value: string): Json {
  return { content: [{ type: "text", text: value }], details: {} };
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
  /** The approval key from the daemon (design section 7): in this process's memory only. */
  let approvalKey: string | null = null;

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
    if (typeof reply?.approval_key === "string") approvalKey = reply.approval_key;
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
    // Every shutdown ends this runtime's long poll: a /reload starts a new runtime with its own, and a
    // session switch in this one starts it again at the session_start that follows.
    stopped = true;
    stopSessionResources();
    await enqueue("session-end", { reason: String(event?.reason ?? "quit") });
  });

  pi.on("tool_call", async (event: any) => {
    const name = String(event?.toolName ?? "");
    const command = name === "bash" ? String(event?.input?.command ?? "") : "";
    if (command !== "" && SHELL_GATE.test(command)) {
      return { block: true, reason: "flowryn: merge, gate pass, approve and a captain decision need the user (use the flowryn_merge, flowryn_gate_pass and flowryn_decide tools), and hook verbs belong to the harness; this session cannot run them from the shell" };
    }
    return undefined;
  });

  /**
   * flowryn_merge: the one way this leader merges (the shell is blocked). You
   * see what would land and say yes or no; the daemon still applies the whole
   * merge gate, and binds the merge to the head you saw.
   */
  pi.registerTool({
    name: "flowryn_merge",
    label: "Flowryn merge",
    description:
      "Merge a Flowryn task's delivered pull request (or local-only branch). The user confirms it here first; flowrynd then checks the merge gate (approval, checks, head) and proves the merge. Never run `flowryn merge` in the shell.",
    promptSnippet: "flowryn_merge: merge a delivered Flowryn ship after the user confirms it.",
    parameters: { type: "object", properties: { task: { type: "string", description: "the Flowryn task id, for example web-login-loop-q4" } }, required: ["task"] },
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, c: any) {
      remember(c);
      const task = String(params?.task ?? "").trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(task)) return text("flowryn_merge needs a task id.");
      const summary = await runHook("merge-summary", { task });
      if (!summary) return text("Flowryn is not reachable; nothing was merged.");
      if (typeof summary.error === "string") return text(`Cannot merge ${task}: ${summary.error}`);
      const head = String(summary.head ?? "");
      const lines = [
        `${summary.title ?? task} (${summary.project ?? "?"})`,
        `${summary.kind === "local" ? "branch" : "PR"}: ${summary.target ?? "?"}`,
        `head: ${head.slice(0, 12)}  checks: ${summary.checks ?? "unknown"}${summary.sensitive ? "  SENSITIVE" : ""}`,
      ];
      let yes = false;
      try {
        yes = Boolean(await ctx?.ui?.confirm?.(`Merge ${task}?`, lines.join("\n")));
      } catch {
        yes = false;
      }
      if (!yes) return text(`The user declined; ${task} was not merged.`);
      let key = approvalKey;
      if (!key) {
        const fresh = await runHook("approval-key", {});
        key = typeof fresh?.key === "string" ? fresh.key : null;
        approvalKey = key;
      }
      if (!key) return text("This session does not hold the leader lease, so it cannot merge.");
      let reply = await runFlowryn(["merge", task, "--head", head, "--key-file", "-", "--json"], key);
      if (reply?.ok === false && reply.error?.code === "approval_required" && String(reply.error?.message ?? "").includes("key")) {
        // The lease moved and back, or the key rotated: one fresh key, once.
        const fresh = await runHook("approval-key", {});
        if (typeof fresh?.key === "string") {
          approvalKey = fresh.key;
          reply = await runFlowryn(["merge", task, "--head", head, "--key-file", "-", "--json"], fresh.key);
        }
      }
      if (!reply) return text(`Flowryn did not answer; ${task} may not be merged. Check: flowryn show ${task}`);
      if (reply.ok) return text(`Merged ${task}: ${reply.data?.state ?? "merged"} at ${String(reply.data?.sha ?? "?").slice(0, 12)} (approved in this confirm; cleanup follows).`);
      return text(`Merge of ${task} refused (${reply.error?.code ?? "error"}): ${reply.error?.message ?? ""}${reply.error?.help ? ` Help: ${reply.error.help}` : ""}`);
    },
  });

  /**
   * flowryn_gate_pass: the one way this leader passes a review gate (design
   * section 11). You see the stage and its review page and say yes or no; on
   * yes the gate passes with this confirm as your word, bound to the gate.
   */
  pi.registerTool({
    name: "flowryn_gate_pass",
    label: "Flowryn gate pass",
    description:
      "Pass a Flowryn task's open review gate (a design or visual QA review) after the user reviewed it. The user confirms it here first; the next stage then starts. Never run `flowryn gate pass` in the shell.",
    promptSnippet: "flowryn_gate_pass: pass a Flowryn review gate after the user confirms it.",
    parameters: { type: "object", properties: { task: { type: "string", description: "the Flowryn task id" } }, required: ["task"] },
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, c: any) {
      remember(c);
      const task = String(params?.task ?? "").trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(task)) return text("flowryn_gate_pass needs a task id.");
      const summary = await runHook("gate-summary", { task });
      if (!summary) return text("Flowryn is not reachable; nothing was passed.");
      if (typeof summary.error === "string") return text(`Cannot pass a gate of ${task}: ${summary.error}`);
      const lines = [`${summary.title ?? task} (${summary.project ?? "?"})`, `review: ${summary.review ?? "-"}`];
      if (typeof summary.plan === "string" && summary.plan !== "-") lines.push(`also approves ${summary.plan}`);
      if (typeof summary.questions === "string" && summary.questions !== "-") lines.push(`its questions: ${summary.questions}`);
      lines.push(`gate ${summary.gate ?? "?"}; the next stage starts at once`);
      let yes = false;
      try {
        yes = Boolean(await ctx?.ui?.confirm?.(`Pass the ${summary.stage ?? "?"} review of ${task}?`, lines.join("\n")));
      } catch {
        yes = false;
      }
      if (!yes) return text(`The user declined; the ${summary.stage ?? ""} review of ${task} stays open.`);
      let key = approvalKey;
      if (!key) {
        const fresh = await runHook("approval-key", {});
        key = typeof fresh?.key === "string" ? fresh.key : null;
        approvalKey = key;
      }
      if (!key) return text("This session does not hold the leader lease, so it cannot pass a gate.");
      const passArgs = ["gate", "pass", task, "--stage", String(summary.stage ?? ""), "--gate-id", String(summary.gate ?? ""), "--key-file", "-", "--json"];
      let reply = await runFlowryn(passArgs, key);
      if (reply?.ok === false && reply.error?.code === "approval_required" && String(reply.error?.message ?? "").includes("key")) {
        const fresh = await runHook("approval-key", {});
        if (typeof fresh?.key === "string") {
          approvalKey = fresh.key;
          reply = await runFlowryn(passArgs, fresh.key);
        }
      }
      if (!reply) return text(`Flowryn did not answer; the gate of ${task} may still be open. Check: flowryn show ${task}`);
      if (reply.ok) return text(`Passed the ${reply.data?.stage ?? ""} review of ${task}; stage ${reply.data?.next ?? "?"} starts.`);
      return text(`Gate pass of ${task} refused (${reply.error?.code ?? "error"}): ${reply.error?.message ?? ""}${reply.error?.help ? ` Help: ${reply.error.help}` : ""}`);
    },
  });

  /**
   * flowryn_decide: the one way this leader records the user's own answer to
   * a decision. You see the question and the answer in your words and say yes
   * or no; on yes it is recorded as yours, bound to this lease's key.
   */
  pi.registerTool({
    name: "flowryn_decide",
    label: "Flowryn decide",
    description: "Record the user's own answer to a Flowryn decision (k<N> or q<N>), in their words. The user confirms it here first. Never run `flowryn decide … --by captain` in the shell.",
    promptSnippet: "flowryn_decide: record the user's answer to a Flowryn decision after they confirm it.",
    parameters: {
      type: "object",
      properties: {
        decision: { type: "string", description: "the decision id, for example k3" },
        choice: { type: "string", description: "one of its options, or a short answer" },
        words: { type: "string", description: "the user's words, verbatim" },
      },
      required: ["decision", "choice", "words"],
    },
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, c: any) {
      remember(c);
      const decision = String(params?.decision ?? "").trim();
      const choice = String(params?.choice ?? "").trim();
      const words = String(params?.words ?? "").trim();
      if (!/^[kq]\d+$/.test(decision)) return text("flowryn_decide needs a decision id such as k3.");
      const shown = await runFlowryn(["show", decision, "--json"], "");
      if (!shown?.ok) return text(`Cannot find ${decision}: ${shown?.error?.message ?? "Flowryn is not reachable"}`);
      let yes = false;
      try {
        yes = Boolean(await ctx?.ui?.confirm?.(`Record your answer to ${decision}?`, [String(shown.data?.question ?? ""), `answer: ${choice}`, `your words: ${words}`].join("\n")));
      } catch {
        yes = false;
      }
      if (!yes) return text(`The user declined; ${decision} stays open.`);
      let key = approvalKey;
      if (!key) {
        const fresh = await runHook("approval-key", {});
        key = typeof fresh?.key === "string" ? fresh.key : null;
        approvalKey = key;
      }
      if (!key) return text("This session does not hold the leader lease, so it cannot record an answer.");
      const decideArgs = ["decide", decision, choice, "--by", "captain", "--words", words, "--key-file", "-", "--json"];
      let reply = await runFlowryn(decideArgs, key);
      if (reply?.ok === false && reply.error?.code === "approval_required" && String(reply.error?.message ?? "").includes("key")) {
        // The lease moved and back, or the key rotated: one fresh key, once.
        const fresh = await runHook("approval-key", {});
        if (typeof fresh?.key === "string") {
          approvalKey = fresh.key;
          reply = await runFlowryn(decideArgs, fresh.key);
        }
      }
      if (!reply) return text(`Flowryn did not answer; ${decision} may still be open. Check: flowryn show ${decision}`);
      if (reply.ok) return text(`Recorded your answer to ${decision}: ${choice}.`);
      return text(`Answer to ${decision} refused (${reply.error?.code ?? "error"}): ${reply.error?.message ?? ""}`);
    },
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
