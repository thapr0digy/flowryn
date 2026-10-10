import { FlowrynError } from "../api/errors.ts";
import { stringArg, type VerbSpec } from "../api/verbs.ts";
import type { Db } from "../db/db.ts";
import { recordIntent } from "../journal/journal.ts";
import { readSnapshot } from "../journal/snapshot.ts";
import { grantActor, prepareCaptainGrant, takeGrant } from "../policy/grants.ts";
import { closeDivergence, getDivergence, isBacklogDivergence, RESOLUTIONS, resolveCommand, type DivergenceRow, type Resolution } from "../reconcile/divergence.ts";
import { MAX_BACKLOG_BODY } from "./dispatch.ts";
import { doneFlags } from "./landing.ts";
import { dispatchedTask } from "./launcher.ts";
import { getProject } from "./projects.ts";
import { cancelRun, getRunWithPolicy, openRunForTask, parkTask, type RunRow } from "./runs.ts";

/**
 * `flowryn divergence resolve <id> keep-run|accept-edit` (design section 8).
 * A backlog divergence (a hand edit, or any other drift of the backlog, that
 * contradicts the runs) leaves the run untouched until you say which side
 * wins:
 *
 * - keep-run: the runs win. The journal writes their state back into the
 *   backlog: a live run's task goes back In flight (added again if it was
 *   deleted); a task with no live run gets what its last run left, Done with
 *   its link, parked in Queued, or plain Queued when Flowryn never ran it.
 * - accept-edit: your edit wins. A live run is cancelled, its worker stopped
 *   and verified gone, its worktree kept for the cleanup guard, and the
 *   backlog left as you edited it; with no live run the edit just stands, and
 *   the invariant pass does not raise it again while the task reads the same.
 *
 * Any other divergence is between two evidence sources (GitHub against the
 * worker, a process against its run, Docker against a lease). There is no
 * edit to accept: keep-run closes it with the run as it is, and the same
 * observation does not reopen it.
 */

type Action = "reapply" | "cancel" | "accept" | "acknowledge";

interface Planned {
  divergence: DivergenceRow;
  resolution: Resolution;
  action: Action;
  run: RunRow | null;
  /** A chat answer that settles it; resolving needs no word from you, so it is the record that the answer was yours. */
  grant: string | null;
}

function resolutionArg(value: string | undefined): Resolution {
  if (!value || !(RESOLUTIONS as readonly string[]).includes(value)) throw new FlowrynError("bad_args", "the resolution is keep-run or accept-edit");
  return value as Resolution;
}

function plan(db: Db, id: string, resolution: Resolution): Planned {
  const divergence = getDivergence(db, id);
  if (!divergence) throw new FlowrynError("not_found", `no divergence ${id}`, "flowryn fleet");
  if (divergence.resolved_at !== null) throw new FlowrynError("bad_args", `divergence ${id} is already resolved (${divergence.resolution ?? "?"})`, `flowryn show ${id}`);
  const run = divergence.task_id ? openRunForTask(db, divergence.task_id) : null;
  if (!isBacklogDivergence(divergence)) {
    if (resolution === "accept-edit") {
      throw new FlowrynError("bad_args", `divergence ${id} is between ${divergence.higher} and ${divergence.lower}, not a backlog edit: there is no edit to accept`, resolveCommand(divergence));
    }
    return { divergence, resolution, action: "acknowledge", run, grant: null };
  }
  if (resolution === "keep-run") return { divergence, resolution, action: "reapply", run, grant: null };
  return { divergence, resolution, action: run ? "cancel" : "accept", run, grant: null };
}

/**
 * keep-run on a backlog divergence: record the intents that bring the task
 * back to what the runs say. Call inside a transaction; returns the verbs.
 */
function reapplyRunState(db: Db, d: DivergenceRow, now: number): string[] {
  const taskId = d.task_id;
  if (!taskId) return [];
  const task = readSnapshot(db, "backlog")?.tasks.find((t) => t.id === taskId) ?? null;
  const live = openRunForTask(db, taskId);
  const intent = (verb: "add" | "start" | "reopen" | "done", positional: string[], flags: Record<string, string | true> = {}) => {
    recordIntent(db, { file: "backlog", verb, taskId, positional, flags, now });
    return verb;
  };
  if (live) {
    if (task) return task.state === "in_flight" ? [] : [intent("start", [taskId])];
    // Deleted by hand: the task comes back as dispatched, In flight.
    const dispatched = dispatchedTask(db, live.id);
    const policy = db.query("SELECT kind, project_id FROM task_policy WHERE task_id = ?1").get(taskId) as { kind: string; project_id: string } | null;
    const flags: Record<string, string | true> = { kind: policy?.kind ?? dispatched?.kind ?? "ship", repo: policy?.project_id ?? dispatched?.project ?? "", start: true };
    if (dispatched?.body) flags.body = dispatched.body.slice(0, MAX_BACKLOG_BODY);
    return [intent("add", [taskId, dispatched?.title || taskId], flags)];
  }
  if (!task || task.state !== "in_flight") return [];
  const latest = db.query("SELECT id FROM runs WHERE task_id = ?1 ORDER BY started_at DESC, rowid DESC LIMIT 1").get(taskId) as { id: string } | null;
  const last = latest ? getRunWithPolicy(db, latest.id) : null;
  if (!last) return [intent("reopen", [taskId])];
  if (last.state === "cleaned") return [intent("done", [taskId], doneFlags(db, last, getProject(db, last.project_id)))];
  parkTask(db, taskId, `${last.state}: kept by divergence ${d.id}`, now);
  return ["reopen", "hold"];
}

const resolve: VerbSpec = {
  name: "divergence resolve",
  summary: "Settle a divergence: keep-run (the run's state wins) or accept-edit (your backlog edit wins)",
  positionals: [
    { name: "id", required: true, help: "divergence id, such as d3" },
    { name: "resolution", required: true, help: "keep-run or accept-edit" },
  ],
  flags: {},
  kind: "mutation",
  roles: ["leader", "human"],
  async prepare(ctx, args) {
    // Judge against the backlog as it is now: a hand edit not yet seen is diffed first.
    await ctx.watcher.refreshIfIdle("backlog");
    const planned = plan(ctx.db, stringArg(args, "id")!, resolutionArg(stringArg(args, "resolution")));
    planned.grant = prepareCaptainGrant(ctx, args, { item: planned.divergence.id, choice: planned.resolution }, null);
    if (planned.action === "cancel" && planned.run) {
      const exited = await ctx.fleet.exitRun(planned.run.id);
      if (!exited.ok) throw new FlowrynError("internal", `the worker for ${planned.run.task_id} did not exit (${exited.detail ?? exited.evidence}); nothing was resolved`);
    }
    return planned;
  },
  apply(ctx, args, prepared) {
    const planned = prepared as Planned;
    const now = ctx.now();
    const d = getDivergence(ctx.db, planned.divergence.id)!;
    if (d.resolved_at !== null) {
      if (d.resolution === planned.resolution) return { data: { divergence: d.id, resolution: d.resolution, already: true } };
      throw new FlowrynError("bad_args", `divergence ${d.id} was resolved meanwhile (${d.resolution ?? "?"})`, `flowryn show ${d.id}`);
    }
    let changed: string[] = [];
    let cancelled: string | null = null;
    if (planned.action === "reapply") changed = reapplyRunState(ctx.db, d, now);
    if (planned.action === "cancel") {
      const run = d.task_id ? openRunForTask(ctx.db, d.task_id) : null;
      if (run) {
        cancelRun(ctx.db, run, `your backlog edit won (divergence ${d.id})`, "cli", now, { park: false });
        cancelled = run.id;
      }
    }
    const used = planned.grant ? takeGrant(ctx.db, planned.grant, `divergence resolve ${d.id}`, now) : null;
    closeDivergence(ctx.db, d, planned.resolution, used ? grantActor(used) : ctx.caller.role, "cli", now);
    return {
      data: { divergence: d.id, resolution: planned.resolution, task: d.task_id ?? "-", backlog: changed.join(" ") || "unchanged", cancelled: cancelled ?? "-", ...(used ? { grant: used.id } : {}) },
      hints: cancelled ? [`flowryn cleanup ${d.task_id} (the worktree is kept)`] : [`flowryn show ${d.task_id ?? d.id}`],
    };
  },
  async settle(ctx, result) {
    ctx.journal.kick();
    const cancelled = result.data.cancelled;
    if (typeof cancelled === "string" && cancelled !== "-") {
      ctx.fleet.bus.forget(cancelled);
      ctx.sched.kick();
      const run = getRunWithPolicy(ctx.db, cancelled);
      const runtime = ctx.fleet.runtime();
      if (run?.workspace_id && runtime) await runtime.closeWorkspace(run.workspace_id).catch(() => undefined);
    }
    return result;
  },
};

export const DIVERGENCE_VERBS: VerbSpec[] = [resolve];
