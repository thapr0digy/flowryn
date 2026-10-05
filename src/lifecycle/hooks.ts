import { realpathSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { FlowrynError } from "../api/errors.ts";
import { intArg, stringArg, type Args, type HandlerCtx, type HandlerResult, type VerbSpec } from "../api/verbs.ts";
import * as leader from "../leader/hooks.ts";
import { resolveRunItems } from "../attention/items.ts";
import { appendEvent } from "../db/events.ts";
import { steerLine, steerPointer } from "../harness/contract-text.ts";
import { HOOK_SIGNALS, type HookName } from "../harness/types.ts";
import { getProject } from "./projects.ts";
import { gatherFacts } from "../policy/merge.ts";
import { mergeContext, mergeSummary, runAndProject } from "../policy/verbs.ts";
import { failRun, getRunWithPolicy, isTerminal, recordEvidence, setLiveness, taskTitle, type RunWithPolicy } from "./runs.ts";
import { openBlockedPrompt, SCREEN_LINES } from "./prompt-wedge.ts";
import { openReviewGate } from "../policy/gates.ts";
import { pendingPlanLine } from "./plans.ts";
import { confirmPromptSeen, dueSteers, getMessage, markLost, markRung, markSeen, nextDueAt, noteDeliveryMode, type RingPath } from "./steers.ts";
import { clearUsageLimit, noteUsageLimit } from "../sched/usage.ts";
import { schedTiming } from "../config/workflows.ts";

/**
 * The hook verbs (design section 12, role "hook"). A worker's Claude hooks
 * and Pi extension call them through `flowryn hook <name>` with the run token
 * of their pane; for a worker they are rank-3 evidence (design section 6):
 * busy, idle, turn ended, session id and working directory. A leader's hooks
 * and extension call the same verbs with the leader session's token, and
 * src/leader/hooks.ts handles those. Each is a short transaction; none is
 * kept for idempotency or spooled.
 */

export interface HookInput {
  session_id?: string | null;
  session_file?: string | null;
  transcript_path?: string | null;
  cwd?: string | null;
  source?: string | null;
  stop_hook_active?: boolean;
  /** Claude StopFailure: the error type (rate_limit for a claude.ai usage limit) and its details. */
  error?: string | null;
  error_details?: string | null;
  /** Claude Notification: its type (quota_auto_resume_fired after a usage limit reset). */
  notification_type?: string | null;
}

/** At most two consecutive Stop continuations, far below Claude's cap of 8 (design section 5). */
export const MAX_CONTINUATIONS = 2;

function parseInput(args: Args): HookInput {
  const raw = stringArg(args, "input");
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as HookInput) : {};
  } catch {
    return {};
  }
}

function harnessOf(args: Args): "claude" | "pi" {
  return stringArg(args, "harness") === "pi" ? "pi" : "claude";
}

function hookRun(ctx: HandlerCtx): RunWithPolicy {
  const run = ctx.caller.runId ? getRunWithPolicy(ctx.db, ctx.caller.runId) : null;
  if (!run) throw new FlowrynError("not_found", "this worker's run is gone");
  return run;
}

function hookFlags() {
  return {
    harness: { type: "string" as const, help: "claude or pi" },
    input: { type: "string" as const, help: "the hook's JSON input" },
    waiter: { type: "string" as const, help: "a waiter's id (a ULID minted when it was armed)" },
    "started-at": { type: "int" as const, help: "when the hook process started (ms); a digest it cannot hand over in time is not carried" },
  };
}

function isLeaderCall(ctx: HandlerCtx): boolean {
  return Boolean(ctx.caller.session) && !ctx.caller.runId;
}

function workerOnly(ctx: HandlerCtx, name: string): void {
  if (isLeaderCall(ctx)) throw new FlowrynError("role_refused", `hook ${name} is a worker hook`);
}

function leaderOnly(ctx: HandlerCtx, name: string): void {
  if (!isLeaderCall(ctx)) throw new FlowrynError("role_refused", `hook ${name} is a leader hook`);
}

/** Busy is a lease the hooks refresh; nothing fires after an interrupt, so it expires instead (design section 5). */
function markBusy(ctx: HandlerCtx, run: RunWithPolicy, signal: string, hook?: HookName): void {
  const now = ctx.now();
  const until = now + ctx.fleet.timing().busy_lease_ms;
  ctx.db.query("UPDATE runs SET busy_until = ?2, idle_since = NULL, last_hook_at = ?3, updated_at = ?3 WHERE id = ?1").run(run.id, until, now);
  // The hook name tells a tool starting (pre-tool) from one ending (post-tool), which share the signal.
  recordEvidence(ctx.db, run.id, "hook", 3, { signal, at: now, ...(hook ? { hook } : {}) }, now);
  if (run.liveness !== "dead" && run.liveness !== "orphaned") setLiveness(ctx.db, run, "busy", "hook", { signal }, now);
  resolveRunItems(ctx.db, run.id, ["blocked_prompt"], `hook ${signal}`, now);
}

function markIdle(ctx: HandlerCtx, run: RunWithPolicy, signal: string): void {
  const now = ctx.now();
  ctx.db.query("UPDATE runs SET busy_until = NULL, idle_since = ?2, last_hook_at = ?2, updated_at = ?2 WHERE id = ?1").run(run.id, now);
  recordEvidence(ctx.db, run.id, "hook", 3, { signal, at: now }, now);
  if (run.liveness !== "dead" && run.liveness !== "orphaned") setLiveness(ctx.db, run, "idle", "hook", { signal }, now);
  resolveRunItems(ctx.db, run.id, ["blocked_prompt"], `hook ${signal}`, now);
}

/** Take the first due steer and mark it rung, carried into a busy turn. Call inside the transaction. */
function takeSteer(ctx: HandlerCtx, run: RunWithPolicy, path: RingPath) {
  const due = dueSteers(ctx.db, run.id, ctx.now(), ctx.fleet.timing())[0];
  if (!due) return null;
  markRung(ctx.db, due, run, path, ctx.now(), false, ctx.fleet.timing());
  return due;
}

/**
 * A Claude worker hook after a carry proves the steer reached a model request:
 * a woken turn's UserPromptSubmit, or the next PreToolUse, PostToolUse or Stop
 * after a PostToolUse or Stop carry (the model read the attachment at its
 * inference in between). A parallel sibling tool's hook can mark it a moment
 * early. Pi proves it with its context event instead (hook steer-seen). What
 * only UserPromptSubmit saw stays losable until a later hook in the turn.
 */
function claudeSaw(ctx: HandlerCtx, run: RunWithPolicy, args: Args, hook: string): void {
  if (harnessOf(args) !== "claude") return;
  if (hook !== "prompt") confirmPromptSeen(ctx.db, run, hook);
  markSeen(ctx.db, run, null, hook, ctx.now());
}

// --- worker-start and the isolation assertion ---------------------------------------------

interface IsolationFacts {
  cwd: string | null;
  top: string | null;
  common: string | null;
  projectCommon: string | null;
  branch: string | null;
  worktree: string | null;
  primary: string | null;
  violations: string[];
}

function realOrNull(path: string | null | undefined): string | null {
  if (!path) return null;
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

async function gitOut(ctx: HandlerCtx, cwd: string, args: string[]): Promise<string | null> {
  const result = await ctx.runTool("git", ["-C", cwd, ...args]);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function commonDir(ctx: HandlerCtx, cwd: string): Promise<string | null> {
  const out = await gitOut(ctx, cwd, ["rev-parse", "--git-common-dir"]);
  if (!out) return null;
  return realOrNull(isAbsolute(out) ? out : join(cwd, out));
}

/**
 * Design section 14, isolation assertion: the worker-start report must show a
 * cwd inside the run's worktree, the project's git common dir, a top level that
 * is not the primary checkout, and the run's branch. The daemon reads git
 * itself, from the cwd the harness reported.
 */
export async function isolationFacts(ctx: HandlerCtx, run: RunWithPolicy, reportedCwd: string | null | undefined): Promise<IsolationFacts> {
  const project = getProject(ctx.db, run.project_id);
  const facts: IsolationFacts = {
    cwd: realOrNull(reportedCwd),
    top: null,
    common: null,
    projectCommon: project ? await commonDir(ctx, project.path) : null,
    branch: null,
    worktree: realOrNull(run.worktree_path),
    primary: realOrNull(project?.path),
    violations: [],
  };
  if (!facts.cwd) facts.violations.push(`the reported cwd ${reportedCwd ?? "(none)"} does not exist`);
  else {
    facts.top = realOrNull(await gitOut(ctx, facts.cwd, ["rev-parse", "--show-toplevel"]));
    facts.common = await commonDir(ctx, facts.cwd);
    facts.branch = await gitOut(ctx, facts.cwd, ["branch", "--show-current"]);
    if (!facts.worktree || !inside(facts.cwd, facts.worktree)) facts.violations.push(`cwd ${facts.cwd} is not inside the run's worktree ${run.worktree_path}`);
    if (!facts.top || facts.top !== facts.worktree) facts.violations.push(`git top level ${facts.top ?? "(none)"} is not the run's worktree`);
    if (facts.top && facts.primary && facts.top === facts.primary) facts.violations.push("the worker is in the project's primary checkout");
    if (!facts.common || facts.common !== facts.projectCommon) facts.violations.push(`git common dir ${facts.common ?? "(none)"} is not the project's ${facts.projectCommon ?? "(unknown)"}`);
    if (facts.branch !== run.branch) facts.violations.push(`branch ${facts.branch || "(detached)"} is not ${run.branch}`);
  }
  return facts;
}

const workerStart: VerbSpec = {
  name: "hook.worker-start",
  summary: "Worker hook: session start (session id, cwd) and the isolation assertion",
  positionals: [],
  flags: hookFlags(),
  kind: "mutation",
  roles: ["worker"],
  ephemeral: true,
  async prepare(ctx, args) {
    workerOnly(ctx, "worker-start");
    const run = hookRun(ctx);
    const input = parseInput(args);
    return { input, facts: await isolationFacts(ctx, run, input.cwd) };
  },
  apply(ctx, args, prepared) {
    const { input, facts } = prepared as { input: HookInput; facts: IsolationFacts };
    const run = hookRun(ctx);
    const now = ctx.now();
    if (isTerminal(run.state)) return { data: { run: run.id, state: run.state } };
    if (facts.violations.length > 0) {
      appendEvent(ctx.db, { source: "hook", kind: "run.isolation_failed", runId: run.id, taskId: run.task_id, payload: { ...facts }, ts: now });
      failRun(ctx.db, run, `isolation assertion failed: ${facts.violations[0]}`, "hook", now);
      return { data: { run: run.id, isolation: "failed", violations: facts.violations } };
    }
    const session = typeof input.session_id === "string" && input.session_id.length > 0 ? input.session_id : null;
    ctx.db
      .query(
        `UPDATE runs SET worker_started_at = ?2, last_hook_at = ?2, updated_at = ?2,
           agent_session = COALESCE(?3, agent_session), transcript_path = COALESCE(?4, transcript_path) WHERE id = ?1`,
      )
      .run(run.id, now, session, typeof input.transcript_path === "string" ? input.transcript_path : null);
    recordEvidence(ctx.db, run.id, "hook", 3, { signal: "started", at: now, session }, now);
    appendEvent(ctx.db, {
      source: "hook",
      kind: "run.worker_started",
      runId: run.id,
      taskId: run.task_id,
      payload: { harness: harnessOf(args), session, expected_session: run.agent_session, source: input.source ?? null, cwd: facts.cwd, branch: facts.branch, isolation: "ok" },
      ts: now,
    });
    resolveRunItems(ctx.db, run.id, ["trust_dialog"], "run.worker_started", now);
    if (run.liveness === "starting" || run.liveness === "blocked_dialog" || run.liveness === "unknown") setLiveness(ctx.db, run, "idle", "hook", { signal: "started" }, now);
    return { data: { run: run.id, isolation: "ok" } };
  },
  async settle(ctx, result) {
    const runId = String(result.data.run ?? "");
    if (result.data.isolation === "failed" && runId) {
      // Design section 14: otherwise interrupt, exit, fail. The run is already failed; the process goes now.
      void (async () => {
        await ctx.fleet.interruptRun(runId, 2_000).catch(() => null);
        await ctx.fleet.exitRun(runId).catch(() => null);
      })();
    }
    if (runId) ctx.fleet.reconcile(runId);
    return result;
  },
};

// --- busy, idle and the mid-turn steer channel ----------------------------------------------

type LeaderBody = (ctx: HandlerCtx, input: leader.LeaderHookInput, args: Args, prepared: unknown) => HandlerResult;

/**
 * A hook verb both a worker and a leader call: the worker body gets the run,
 * the leader body the parsed input. After commit it wakes whoever waits on
 * this worker or leader session.
 */
function signalVerb(
  hook: HookName | "notify",
  summary: string,
  body: (ctx: HandlerCtx, run: RunWithPolicy, args: Args, prepared: unknown) => HandlerResult,
  leaderBody: LeaderBody,
  leaderPrepare?: (ctx: HandlerCtx, args: Args) => Promise<unknown>,
  workerPrepare?: (ctx: HandlerCtx, args: Args) => Promise<unknown>,
): VerbSpec {
  return {
    name: `hook.${hook}`,
    summary,
    positionals: [],
    flags: hookFlags(),
    kind: "mutation",
    roles: ["worker", "hook"],
    ephemeral: true,
    async prepare(ctx, args) {
      if (isLeaderCall(ctx)) return leaderPrepare ? leaderPrepare(ctx, args) : undefined;
      return workerPrepare ? workerPrepare(ctx, args) : undefined;
    },
    apply(ctx, args, prepared) {
      if (isLeaderCall(ctx)) return leaderBody(ctx, parseInput(args) as leader.LeaderHookInput, args, prepared);
      const run = hookRun(ctx);
      if (isTerminal(run.state)) return { data: { run: run.id, state: run.state } };
      return body(ctx, run, args, prepared);
    },
    async settle(ctx, result) {
      if (ctx.caller.runId) ctx.fleet.bus.notify(ctx.caller.runId);
      if (isLeaderCall(ctx)) ctx.attention.bus.notify(ctx.caller.session!);
      if (result.data.usage === "paused" || result.data.usage === "resumed") ctx.sched.kick();
      return result;
    },
  };
}

/**
 * The Claude usage limit (design section 16), seen by any Claude session,
 * worker or leader: a turn that ends in StopFailure with error rate_limit
 * pauses Claude work (or re-arms an expired pause); a turn that ends normally, or Claude's own
 * quota_auto_resume_fired notification, lifts the pause. Call inside the
 * hook's transaction; returns what changed, for the reply.
 */
export function usageSignal(ctx: HandlerCtx, harness: "claude" | "pi", who: string, signal: { stop?: boolean; error?: string | null; details?: string | null; notification?: string | null }): "paused" | "resumed" | null {
  if (harness !== "claude") return null;
  const now = ctx.now();
  if (signal.error === "rate_limit") return noteUsageLimit(ctx.db, who, sanitizeUsage(signal.details), now, schedTiming(ctx.config())) ? "paused" : null;
  if (signal.stop || signal.notification === "quota_auto_resume_fired") return clearUsageLimit(ctx.db, signal.stop ? `a turn of ${who} ended normally` : `Claude resumed ${who} after the reset`, now) ? "resumed" : null;
  if (signal.notification?.startsWith("quota_auto_resume_")) appendEvent(ctx.db, { source: "hook", kind: "sched.usage_notice", payload: { who, notification: signal.notification }, ts: now });
  return null;
}

function sanitizeUsage(details: string | null | undefined): string {
  return typeof details === "string" ? details.replace(/[^\x20-\x7e]/g, " ").slice(0, 120) : "";
}

function withUsage(result: HandlerResult, usage: "paused" | "resumed" | null): HandlerResult {
  return usage ? { ...result, data: { ...result.data, usage } } : result;
}

/** A hook only a leader session calls. */
function leaderVerb(name: string, summary: string, body: LeaderBody, prepare?: (ctx: HandlerCtx, args: Args) => Promise<unknown>, settle?: VerbSpec["settle"]): VerbSpec {
  return {
    name: `hook.${name}`,
    summary,
    positionals: [],
    flags: hookFlags(),
    kind: "mutation",
    roles: ["hook"],
    ephemeral: true,
    async prepare(ctx, args) {
      leaderOnly(ctx, name);
      return prepare ? prepare(ctx, args) : undefined;
    },
    apply(ctx, args, prepared) {
      return body(ctx, parseInput(args) as leader.LeaderHookInput, args, prepared);
    },
    async settle(ctx, result) {
      if (settle) result = await settle(ctx, result);
      ctx.attention.bus.notify(ctx.caller.session!);
      return result;
    },
  };
}

const prompt = signalVerb(
  "prompt",
  "Hook: a turn started (busy); a leader gets its P1 digest",
  (ctx, run, args) => {
    ctx.fleet.continuations.delete(run.id);
    claudeSaw(ctx, run, args, "prompt");
    markBusy(ctx, run, HOOK_SIGNALS.prompt);
    return { data: { run: run.id } };
  },
  (ctx, input, _args, prepared) => leader.prompt(ctx, input, (prepared as number | null | undefined) ?? null),
  async (ctx, args) => leader.digestDeadline(ctx, intArg(args, "started-at")),
);

const preTool = signalVerb(
  "pre-tool",
  "Hook: a tool is about to run (busy lease); a leader's merge or discard asks you first",
  (ctx, run, args) => {
    claudeSaw(ctx, run, args, "pre-tool");
    markBusy(ctx, run, HOOK_SIGNALS["pre-tool"], "pre-tool");
    return { data: { run: run.id } };
  },
  (ctx, input) => leader.preToolUse(ctx, input),
);

/** PostToolUse carries a pending steer beside the next tool result, the documented mid-turn channel (M0 c07). */
const postTool = signalVerb(
  "post-tool",
  "Hook: a tool finished; a worker gets a pending steer as context",
  (ctx, run, args) => {
    claudeSaw(ctx, run, args, "post-tool");
    markBusy(ctx, run, HOOK_SIGNALS["post-tool"], "post-tool");
    if (harnessOf(args) !== "claude") return { data: { run: run.id } };
    const steer = takeSteer(ctx, run, "post-tool");
    return { data: steer ? { run: run.id, steer: steer.id, context: steerLine(steer.id, steer.body) } : { run: run.id } };
  },
  (ctx) => leader.toolActivity(ctx),
);

/** Stop: a turn ended, unless a pending steer continues it (M0 c06), at most twice in a row. */
const stop = signalVerb("stop", "Hook: a turn ended; may continue it with a pending steer (worker) or a P0 (leader)", (ctx, run, args) => {
  claudeSaw(ctx, run, args, "stop");
  if (harnessOf(args) === "claude") {
    const used = ctx.fleet.continuations.get(run.id) ?? 0;
    if (used < MAX_CONTINUATIONS) {
      const steer = takeSteer(ctx, run, "stop");
      if (steer) {
        ctx.fleet.continuations.set(run.id, used + 1);
        markBusy(ctx, run, "continued");
        return { data: { run: run.id, steer: steer.id, context: steerLine(steer.id, steer.body) } };
      }
    }
  }
  ctx.fleet.continuations.delete(run.id);
  markIdle(ctx, run, HOOK_SIGNALS.stop);
  return withUsage({ data: { run: run.id } }, usageSignal(ctx, harnessOf(args), `worker ${run.task_id}`, { stop: true }));
}, (ctx, _input, args) => withUsage(leader.stop(ctx), usageSignal(ctx, harnessOf(args), "the leader", { stop: true })));

const stopFailure = signalVerb(
  "stop-failure",
  "Hook: a turn ended in an API error",
  (ctx, run, args) => {
    ctx.fleet.continuations.delete(run.id);
    // The turn ended in an API error before any further inference: what it carried was never read.
    markLost(ctx.db, run, "turn failed", ctx.now());
    markIdle(ctx, run, HOOK_SIGNALS["stop-failure"]);
    const input = parseInput(args);
    appendEvent(ctx.db, { source: "hook", kind: "run.turn_failed", runId: run.id, taskId: run.task_id, payload: { error: typeof input.error === "string" ? input.error : null } });
    return withUsage({ data: { run: run.id } }, usageSignal(ctx, harnessOf(args), `worker ${run.task_id}`, { error: input.error, details: input.error_details }));
  },
  (ctx, input, args) => withUsage(leader.stopFailure(ctx), usageSignal(ctx, harnessOf(args), "the leader", { error: input.error ?? null, details: input.error_details ?? null })),
);

const sessionEnd = signalVerb(
  "session-end",
  "Hook: the harness session ended",
  (ctx, run) => {
    const now = ctx.now();
    ctx.db.query("UPDATE runs SET busy_until = NULL, last_hook_at = ?2, updated_at = ?2 WHERE id = ?1").run(run.id, now);
    recordEvidence(ctx.db, run.id, "hook", 3, { signal: HOOK_SIGNALS["session-end"], at: now }, now);
    appendEvent(ctx.db, { source: "hook", kind: "run.session_ended", runId: run.id, taskId: run.task_id, payload: {} });
    ctx.fleet.reconcile(run.id);
    return { data: { run: run.id } };
  },
  (ctx, input) => leader.sessionEnd(ctx, input),
);

// --- leader-only hooks ------------------------------------------------------------------------

const sessionStart = leaderVerb(
  "session-start",
  "Leader hook: session start, resume, clear or compaction; claims a vacant or stale lease and returns the briefing",
  (ctx, input, _args, prepared) => leader.sessionStart(ctx, input, prepared as { state: string; epoch: number }),
  (ctx) => leader.prepareSessionStart(ctx),
  async (ctx, result) => {
    // The old holder's waiter exits silently (design section 10).
    if (typeof result.data.previous === "string") ctx.attention.bus.forget(result.data.previous);
    ctx.attention.kick();
    return result;
  },
);

/**
 * `hook notify`: a leader's activity (Claude idle_prompt, the Pi extension's
 * check), from any Claude session its usage-limit notifications, and from a
 * worker a permission_prompt (cutover C2, spike c12): a confirmation dialog
 * is waiting mid-run.
 */
const notify = signalVerb(
  "notify",
  "Hook: you went inactive or came back (leader); Claude's usage-limit and permission-prompt notifications",
  (ctx, run, args, prepared) => {
    const input = parseInput(args);
    if (input.notification_type === "permission_prompt") {
      const busy = run.busy_until !== null && run.busy_until > ctx.now();
      // A confirmed dialog (this notification) opens the item regardless of idleByDesign: a dialog that is
      // actually up is never idle by design, review gate or blocking question notwithstanding.
      if (busy) {
        const lastHook = run.last_hook_at ?? run.launched_at ?? run.started_at;
        openBlockedPrompt(ctx.db, run, { suspected: false, screen: (prepared as { screen?: string | null } | undefined)?.screen ?? null, harness: "claude", lastHook }, ctx.now());
      }
      return { data: { run: run.id } };
    }
    return withUsage({ data: { run: run.id } }, usageSignal(ctx, harnessOf(args), `worker ${run.task_id}`, { notification: input.notification_type ?? null }));
  },
  (ctx, input, args) => withUsage(leader.notify(ctx, input), usageSignal(ctx, harnessOf(args), "the leader", { notification: input.notification_type ?? null })),
  undefined,
  async (ctx, args) => {
    // The screen, read before the transaction; a hook must answer fast, so give up after 1.5 s.
    if (parseInput(args).notification_type !== "permission_prompt") return undefined;
    const run = ctx.caller.runId ? getRunWithPolicy(ctx.db, ctx.caller.runId) : null;
    const runtime = ctx.fleet.runtime();
    if (!run?.pane_id || !runtime) return { screen: null };
    const screen = await Promise.race([
      runtime.readPane(run.pane_id, SCREEN_LINES).catch((error: unknown) => {
        ctx.log(`hook notify: reading pane ${run.pane_id} failed: ${(error as Error).message}`);
        return null;
      }),
      Bun.sleep(1_500).then(() => null),
    ]);
    return { screen };
  },
);

/**
 * `hook wait-p0`: the leader's P0 waiter (design section 5). Claude runs it as
 * an asyncRewake hook at SessionStart and every Stop; the Pi extension holds
 * it as a long poll. It answers with a push, "wait" (ask again) or "exit".
 */
const waitP0 = leaderVerb(
  "wait-p0",
  "Leader hook: wait for a P0 to push (Claude asyncRewake waiter, Pi long poll)",
  (ctx, _input, _args, prepared) => leader.takeP0(ctx, prepared as leader.WaitOutcome),
  (ctx, args) => leader.waitForP0(ctx, stringArg(args, "waiter") ?? ""),
);

/** Pi's flowryn_merge tool: what the merge would land, read fresh, for its confirm. */
const mergeSummaryHook = leaderVerb(
  "merge-summary",
  "Leader hook (Pi): what a merge of a task would land (PR, head, checks), for the confirm",
  (_ctx, _input, _args, prepared) => ({ data: prepared as Record<string, unknown> }),
  async (ctx, args) => {
    const input = parseInput(args) as leader.LeaderHookInput;
    try {
      const { run, project } = runAndProject(ctx.db, String(input.task ?? ""));
      return mergeSummary(await gatherFacts(mergeContext(ctx), run, project));
    } catch (error) {
      return { error: (error as Error).message };
    }
  },
);

/** Pi's flowryn_gate_pass tool: the open review gate of a task, for its confirm. */
const gateSummaryHook = leaderVerb(
  "gate-summary",
  "Leader hook (Pi): a task's open review gate (stage, review page), for the confirm",
  (_ctx, _input, _args, prepared) => ({ data: prepared as Record<string, unknown> }),
  async (ctx, args) => {
    const input = parseInput(args) as leader.LeaderHookInput;
    try {
      const { run, gate } = openReviewGate(ctx.db, String(input.task ?? ""));
      return { task: run.task_id, title: taskTitle(ctx.db, run.task_id), project: run.project_id, stage: gate.stage, gate: gate.id, review: gate.review_url ?? "-", plan: pendingPlanLine(ctx.db, gate.id) ?? "-" };
    } catch (error) {
      return { error: (error as Error).message };
    }
  },
);

const approvalKeyHook = leaderVerb("approval-key", "Leader hook (Pi): a fresh approval key for the lease holder's extension", (ctx) => leader.approvalKey(ctx));

const delivered = leaderVerb("delivered", "Leader hook (Pi): the extension delivered a pushed P0, or declined it", (ctx, input) => leader.delivered(ctx, input));

// --- the waiter -------------------------------------------------------------------------------

interface WaitResult {
  exit?: boolean;
  wait?: boolean;
  command?: string;
  steer?: string;
}

function idleNow(run: RunWithPolicy, now: number): boolean {
  return run.busy_until === null || run.busy_until <= now;
}

/**
 * `hook wait-steer`: the idle-delivery channel. Claude runs it as an
 * asyncRewake Stop hook; it fires only while the worker is idle (a busy worker
 * gets steers through PostToolUse and Stop). The Pi extension holds it as a
 * long poll and takes every due steer and control command. The call holds for
 * at most wait_poll_ms and the CLI asks again; a newer waiter for the same run
 * supersedes this one, which then exits 0 silently.
 */
const waitSteer: VerbSpec = {
  name: "hook.wait-steer",
  summary: "Worker hook: wait for a steer (Claude asyncRewake waiter, Pi long poll)",
  positionals: [],
  flags: hookFlags(),
  kind: "mutation",
  roles: ["worker"],
  ephemeral: true,
  async prepare(ctx, args): Promise<WaitResult> {
    workerOnly(ctx, "wait-steer");
    const harness = harnessOf(args);
    const waiter = stringArg(args, "waiter") ?? "";
    const runId = ctx.caller.runId ?? "";
    const bus = ctx.fleet.bus;
    if (!waiter || !bus.register(runId, waiter)) return { exit: true };
    const deadline = ctx.now() + ctx.fleet.timing().wait_poll_ms;
    for (;;) {
      if (bus.closed) return { wait: true };
      const run = getRunWithPolicy(ctx.db, runId);
      if (!run || isTerminal(run.state) || !bus.isCurrent(runId, waiter)) return { exit: true };
      if (harness === "pi") {
        const command = bus.takeCommand(runId);
        if (command) return { command };
      }
      const now = ctx.now();
      const timing = ctx.fleet.timing();
      const due = dueSteers(ctx.db, runId, now, timing)[0];
      if (due && (harness === "pi" || idleNow(run, now))) return { steer: due.id };
      const remaining = deadline - now;
      if (remaining <= 0) return { wait: true };
      // Wake for the next re-ring too (an idle carry nobody saw), not only for the bus.
      const ringAt = nextDueAt(ctx.db, runId, timing);
      const outcome = await bus.wait(runId, waiter, ringAt !== null && ringAt > now ? Math.min(remaining, ringAt - now) : remaining);
      if (outcome === "superseded") return { exit: true };
    }
  },
  apply(ctx, args, prepared) {
    const result = prepared as WaitResult;
    if (!result.steer) return { data: { ...result } };
    const run = hookRun(ctx);
    const now = ctx.now();
    const due = dueSteers(ctx.db, run.id, now, ctx.fleet.timing()).find((m) => m.id === result.steer);
    // Another path carried it between the wait and this transaction.
    if (!due) return { data: { wait: true } };
    const harness = harnessOf(args);
    // The Claude waiter fires only while idle; the extension says how it delivered (hook steer-carried).
    markRung(ctx.db, due, run, harness === "pi" ? "extension" : "waiter", now, harness === "claude" || idleNow(run, now), ctx.fleet.timing());
    const message = getMessage(ctx.db, due.id)!;
    return { data: { fire: { id: message.id, line: harness === "pi" ? steerLine(message.id, message.body) : steerPointer(message.id) } } };
  },
};

/** A Pi worker verb's input: steer ids, as the extension reports them. */
function steerIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && /^m\d+$/.test(v)).slice(0, 50) : [];
}

function piWorkerVerb(name: string, summary: string, body: (ctx: HandlerCtx, run: RunWithPolicy, input: Record<string, unknown>) => HandlerResult): VerbSpec {
  return {
    name: `hook.${name}`,
    summary,
    positionals: [],
    flags: hookFlags(),
    kind: "mutation",
    roles: ["worker"],
    ephemeral: true,
    apply(ctx, args) {
      workerOnly(ctx, name);
      const run = hookRun(ctx);
      if (isTerminal(run.state)) return { data: { run: run.id, state: run.state } };
      return body(ctx, run, parseInput(args) as Record<string, unknown>);
    },
    async settle(ctx, result) {
      // A changed ring state can make a steer due now or later: the waiter re-checks.
      if (ctx.caller.runId) ctx.fleet.bus.notify(ctx.caller.runId);
      return result;
    },
  };
}

/** `hook steer-carried`: how the Pi extension delivered a steer, followUp (idle) or steer (busy). */
const steerCarried = piWorkerVerb("steer-carried", "Worker hook (Pi): how the extension delivered a steer", (ctx, run, input) => {
  const id = steerIds([input.steer])[0];
  const mode = input.mode === "followUp" ? "followUp" : input.mode === "steer" ? "steer" : null;
  if (!id || !mode) throw new FlowrynError("bad_args", "steer-carried needs a steer id and a mode of steer or followUp");
  return { data: { run: run.id, steer: id, noted: noteDeliveryMode(ctx.db, run, id, mode, ctx.now()) } };
});

/** `hook steer-seen`: the Pi extension's context event showed these steers in a model request. */
const steerSeen = piWorkerVerb("steer-seen", "Worker hook (Pi): steers that reached a model request", (ctx, run, input) => {
  const ids = steerIds(input.steers);
  return { data: { run: run.id, seen: ids.length > 0 ? markSeen(ctx.db, run, ids, "context", ctx.now()) : [] } };
});

export const HOOK_VERBS: VerbSpec[] = [workerStart, prompt, preTool, postTool, stop, stopFailure, sessionEnd, waitSteer, steerCarried, steerSeen, sessionStart, notify, waitP0, delivered, mergeSummaryHook, gateSummaryHook, approvalKeyHook];
