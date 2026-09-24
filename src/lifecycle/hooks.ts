import { realpathSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { FlowrynError } from "../api/errors.ts";
import { stringArg, type Args, type HandlerCtx, type HandlerResult, type VerbSpec } from "../api/verbs.ts";
import { resolveRunItems } from "../attention/items.ts";
import { appendEvent } from "../db/events.ts";
import { steerLine, steerPointer } from "../harness/contract-text.ts";
import { HOOK_SIGNALS, type HookName } from "../harness/types.ts";
import { getProject } from "./projects.ts";
import { failRun, getRunWithPolicy, isTerminal, recordEvidence, setLiveness, type RunWithPolicy } from "./runs.ts";
import { dueSteers, getMessage, markRung, type RingPath } from "./steers.ts";

/**
 * The hook verbs (design section 12, role "hook"): the worker's Claude hooks
 * and Pi extension call them through `flowryn hook <name>`, carrying the run
 * token of the pane they run in. They are rank-3 evidence (design section 6):
 * busy, idle, turn ended, session id and working directory. Each is a short
 * transaction; none is kept for idempotency or spooled.
 */

export interface HookInput {
  session_id?: string | null;
  session_file?: string | null;
  transcript_path?: string | null;
  cwd?: string | null;
  source?: string | null;
  stop_hook_active?: boolean;
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
  };
}

/** Busy is a lease the hooks refresh; nothing fires after an interrupt, so it expires instead (design section 5). */
function markBusy(ctx: HandlerCtx, run: RunWithPolicy, signal: string): void {
  const now = ctx.now();
  const until = now + ctx.fleet.timing().busy_lease_ms;
  ctx.db.query("UPDATE runs SET busy_until = ?2, idle_since = NULL, last_hook_at = ?3, updated_at = ?3 WHERE id = ?1").run(run.id, until, now);
  recordEvidence(ctx.db, run.id, "hook", 3, { signal, at: now }, now);
  if (run.liveness !== "dead" && run.liveness !== "orphaned") setLiveness(ctx.db, run, "busy", "hook", { signal }, now);
}

function markIdle(ctx: HandlerCtx, run: RunWithPolicy, signal: string): void {
  const now = ctx.now();
  ctx.db.query("UPDATE runs SET busy_until = NULL, idle_since = ?2, last_hook_at = ?2, updated_at = ?2 WHERE id = ?1").run(run.id, now);
  recordEvidence(ctx.db, run.id, "hook", 3, { signal, at: now }, now);
  if (run.liveness !== "dead" && run.liveness !== "orphaned") setLiveness(ctx.db, run, "idle", "hook", { signal }, now);
}

/** Take the first due steer and mark it rung. Call inside the transaction. */
function takeSteer(ctx: HandlerCtx, run: RunWithPolicy, path: RingPath) {
  const due = dueSteers(ctx.db, run.id, ctx.now(), ctx.fleet.timing())[0];
  if (!due) return null;
  markRung(ctx.db, due, run, path, ctx.now());
  return due;
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

function signalVerb(hook: HookName, summary: string, body: (ctx: HandlerCtx, run: RunWithPolicy, args: Args) => HandlerResult): VerbSpec {
  return {
    name: `hook.${hook}`,
    summary,
    positionals: [],
    flags: hookFlags(),
    kind: "mutation",
    roles: ["worker"],
    ephemeral: true,
    apply(ctx, args) {
      const run = hookRun(ctx);
      if (isTerminal(run.state)) return { data: { run: run.id, state: run.state } };
      return body(ctx, run, args);
    },
    async settle(ctx, result) {
      if (ctx.caller.runId) ctx.fleet.bus.notify(ctx.caller.runId);
      return result;
    },
  };
}

const prompt = signalVerb("prompt", "Worker hook: a turn started (busy)", (ctx, run) => {
  ctx.fleet.continuations.delete(run.id);
  markBusy(ctx, run, HOOK_SIGNALS.prompt);
  return { data: { run: run.id } };
});

const preTool = signalVerb("pre-tool", "Worker hook: a tool is about to run (busy lease)", (ctx, run) => {
  markBusy(ctx, run, HOOK_SIGNALS["pre-tool"]);
  return { data: { run: run.id } };
});

/** PostToolUse carries a pending steer beside the next tool result, the documented mid-turn channel (M0 c07). */
const postTool = signalVerb("post-tool", "Worker hook: a tool finished; returns a pending steer as context", (ctx, run, args) => {
  markBusy(ctx, run, HOOK_SIGNALS["post-tool"]);
  if (harnessOf(args) !== "claude") return { data: { run: run.id } };
  const steer = takeSteer(ctx, run, "post-tool");
  return { data: steer ? { run: run.id, steer: steer.id, context: steerLine(steer.id, steer.body) } : { run: run.id } };
});

/** Stop: a turn ended, unless a pending steer continues it (M0 c06), at most twice in a row. */
const stop = signalVerb("stop", "Worker hook: a turn ended; may continue it with a pending steer", (ctx, run, args) => {
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
  return { data: { run: run.id } };
});

const stopFailure = signalVerb("stop-failure", "Worker hook: a turn ended in an API error", (ctx, run) => {
  ctx.fleet.continuations.delete(run.id);
  markIdle(ctx, run, HOOK_SIGNALS["stop-failure"]);
  appendEvent(ctx.db, { source: "hook", kind: "run.turn_failed", runId: run.id, taskId: run.task_id, payload: {} });
  return { data: { run: run.id } };
});

const sessionEnd = signalVerb("session-end", "Worker hook: the harness session ended", (ctx, run) => {
  const now = ctx.now();
  ctx.db.query("UPDATE runs SET busy_until = NULL, last_hook_at = ?2, updated_at = ?2 WHERE id = ?1").run(run.id, now);
  recordEvidence(ctx.db, run.id, "hook", 3, { signal: HOOK_SIGNALS["session-end"], at: now }, now);
  appendEvent(ctx.db, { source: "hook", kind: "run.session_ended", runId: run.id, taskId: run.task_id, payload: {} });
  ctx.fleet.reconcile(run.id);
  return { data: { run: run.id } };
});

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
      const due = dueSteers(ctx.db, runId, now, ctx.fleet.timing())[0];
      if (due && (harness === "pi" || idleNow(run, now))) return { steer: due.id };
      const remaining = deadline - now;
      if (remaining <= 0) return { wait: true };
      const outcome = await bus.wait(runId, waiter, remaining);
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
    markRung(ctx.db, due, run, harness === "pi" ? "extension" : "waiter", now);
    const message = getMessage(ctx.db, due.id)!;
    return { data: { fire: { id: message.id, line: harness === "pi" ? steerLine(message.id, message.body) : steerPointer(message.id) } } };
  },
};

export const HOOK_VERBS: VerbSpec[] = [workerStart, prompt, preTool, postTool, stop, stopFailure, sessionEnd, waitSteer];
