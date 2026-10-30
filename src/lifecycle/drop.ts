import { FlowrynError } from "../api/errors.ts";
import { boolArg, stringArg, type HandlerResult, type VerbSpec } from "../api/verbs.ts";
import { abortAsk } from "../ask/runner.ts";
import { ASK_ID, getAsk, recordCancelled } from "../ask/store.ts";
import { closeItemExplanations } from "../attention/explanations.ts";
import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { normalizedTitle } from "../journal/diff.ts";
import { pendingIntents, recordIntent } from "../journal/journal.ts";
import { readSnapshot } from "../journal/snapshot.ts";
import type { BacklogTask } from "../journal/tasks-axi.ts";
import { sanitizeBlock } from "../util/sanitize.ts";
import { blockersOf, getPlan, phaseOfTask, phasesOf, type PlanRow } from "./plans.ts";

/**
 * `flowryn drop <task|plan> [--unblock] --body-file -`: remove work that never
 * started (docs/notes/2026-10-15-add-flowryn-drop-mv.md). A Queued task with
 * no run, or one whose cancelled or failed run's worktree the cleanup guard
 * has already removed, is deleted from the backlog (tasks-axi rm) and kept in
 * `drops` with the reason. A plan drops with all its phases, only while none
 * has started. Work that started, landed, keeps a worktree, or still blocks
 * other open tasks (unless --unblock clears those edges) is refused, each with
 * its own code. The checks, the backlog intents and the drops rows commit in
 * one transaction.
 */

const REASON_MAX = 2_000;

export interface Dependent {
  task: string;
  blockedBy: string[];
  /** In the backlog (an unblock intent clears the edge) or only a phase of a plan not yet approved. */
  inBacklog: boolean;
}

export interface PlannedDrop {
  plan: PlanRow | null;
  /** Every task dropped, with its title and whether the backlog holds it (so an rm goes out). */
  tasks: { id: string; title: string; plan: string | null; inBacklog: boolean }[];
  dependents: Dependent[];
}

interface RunRef {
  id: string;
  state: string;
  cleanup: string | null;
}

const LIVE_STATES = new Set(["launching", "running", "validating", "ready", "merging"]);

function runsOf(db: Db, taskId: string): RunRef[] {
  return db.query("SELECT id, state, cleanup FROM runs WHERE task_id = ?1 ORDER BY started_at DESC, rowid DESC").all(taskId) as RunRef[];
}

/** Refuse a task whose runs say it started: live or delivered, landed, or a worktree the cleanup guard has not removed. */
function refuseStartedRuns(taskId: string, runs: RunRef[]): void {
  const live = runs.find((r) => LIVE_STATES.has(r.state));
  if (live) throw new FlowrynError("task_started", `${taskId} has a ${live.state} run ${live.id}; drop takes only work that never started`, `flowryn cancel ${taskId}`);
  const landed = runs.find((r) => r.state === "landed" || r.state === "cleaned");
  if (landed) throw new FlowrynError("task_landed", `${taskId} landed (run ${landed.id} is ${landed.state}); there is nothing to drop`, `flowryn show ${taskId}`);
  const kept = runs.find((r) => r.cleanup !== "done");
  if (kept) throw new FlowrynError("worktree_kept", `${taskId}'s ${kept.state} run ${kept.id} still has its worktree; remove it through the cleanup guard first`, `flowryn cleanup ${taskId}`);
}

function isDecisionTask(db: Db, taskId: string, task: BacklogTask | undefined): boolean {
  if (task?.kind === "decision") return true;
  return db.query("SELECT 1 FROM decisions WHERE task_id = ?1 AND run_id IS NULL").get(taskId) !== null;
}

/** The backlog side of one task: Queued, or not there at all for a phase of a plan not yet approved. */
function checkBacklog(taskId: string, task: BacklogTask | undefined, pending: Set<string>, allowAbsent: boolean): boolean {
  if (pending.has(taskId)) throw new FlowrynError("not_ready", `${taskId} has a backlog write still pending; try again once it applies`, `flowryn show ${taskId}`);
  if (!task) {
    if (allowAbsent) return false;
    throw new FlowrynError("not_found", `${taskId} is not in the backlog`, "flowryn fleet");
  }
  if (task.state === "done") throw new FlowrynError("task_landed", `${taskId} is Done in the backlog; there is nothing to drop`, `flowryn show ${taskId}`);
  if (task.state === "in_flight") throw new FlowrynError("not_ready", `${taskId} is In flight in the backlog with no live run; resolve that divergence first`, "flowryn fleet");
  return true;
}

export function isDropped(db: Db, taskId: string): boolean {
  return db.query("SELECT 1 FROM drops WHERE task_id = ?1").get(taskId) !== null;
}

/** The open tasks, outside the dropped set, that wait for one of it: in the backlog, or as a phase of a plan not yet in it. */
function dependentsOf(db: Db, dropped: Set<string>, backlog: BacklogTask[]): Dependent[] {
  const found = new Map<string, Dependent>();
  for (const task of backlog) {
    // A task dropped earlier waits for nothing, though its rm may not have reached the snapshot yet.
    if (dropped.has(task.id) || task.state === "done" || isDropped(db, task.id)) continue;
    const on = blockersOf(task).filter((b) => dropped.has(b));
    if (on.length > 0) found.set(task.id, { task: task.id, blockedBy: on, inBacklog: true });
  }
  const inBacklog = new Set(backlog.map((t) => t.id));
  const phases = db
    .query("SELECT ph.task_id, ph.blocked_by FROM plan_phases ph JOIN plans pl ON pl.id = ph.plan_id WHERE pl.state IN ('pending','approved')")
    .all() as { task_id: string; blocked_by: string }[];
  for (const phase of phases) {
    if (dropped.has(phase.task_id) || found.has(phase.task_id) || inBacklog.has(phase.task_id) || isDropped(db, phase.task_id)) continue;
    if (runsOf(db, phase.task_id).length > 0) continue;
    const on = (JSON.parse(phase.blocked_by) as string[]).filter((b) => dropped.has(b));
    if (on.length > 0) found.set(phase.task_id, { task: phase.task_id, blockedBy: on, inBacklog: false });
  }
  return [...found.values()].toSorted((a, b) => a.task.localeCompare(b.task));
}

function planTarget(db: Db, plan: PlanRow, backlog: BacklogTask[], pending: Set<string>): PlannedDrop["tasks"] {
  if (plan.state === "discarded" || plan.state === "dropped") throw new FlowrynError("bad_args", `plan ${plan.id} is already ${plan.state}`, `flowryn show ${plan.id}`);
  const phases = phasesOf(db, plan.id).filter((ph) => !isDropped(db, ph.task_id));
  for (const phase of phases) {
    const latest = runsOf(db, phase.task_id)[0];
    if (latest) throw new FlowrynError("phase_started", `plan ${plan.id} phase ${phase.phase_no} (${phase.task_id}) has run ${latest.id} (${latest.state}); a plan drops only while no phase has started`, `flowryn show ${phase.task_id}`);
  }
  return phases.map((phase) => {
    const task = backlog.find((t) => t.id === phase.task_id);
    // A plan not yet approved never reached the backlog; an approved one's phase may be missing only by your hand.
    const inBacklog = checkBacklog(phase.task_id, task, pending, true);
    return { id: phase.task_id, title: task ? normalizedTitle(task) : phase.title, plan: plan.id, inBacklog };
  });
}

function taskTarget(db: Db, taskId: string, backlog: BacklogTask[], pending: Set<string>): PlannedDrop["tasks"] {
  if (isDropped(db, taskId)) throw new FlowrynError("bad_args", `${taskId} is already dropped`, `flowryn show ${taskId}`);
  const task = backlog.find((t) => t.id === taskId);
  if (isDecisionTask(db, taskId, task)) throw new FlowrynError("bad_args", `${taskId} is a decision's task; settle the decision instead`, "flowryn decision list");
  const runs = runsOf(db, taskId);
  refuseStartedRuns(taskId, runs);
  const phase = phaseOfTask(db, taskId);
  if (phase && phase.plan_state === "pending" && !task) {
    throw new FlowrynError("bad_args", `${taskId} is a phase of plan ${phase.plan_id}, which is not yet approved; drop the plan`, `flowryn drop ${phase.plan_id} --body-file -`);
  }
  if (!task && !pending.has(taskId) && runs.length === 0 && !phase && db.query("SELECT 1 FROM task_policy WHERE task_id = ?1").get(taskId) === null) {
    throw new FlowrynError("not_found", `no task or plan ${taskId}`, "flowryn fleet");
  }
  checkBacklog(taskId, task, pending, false);
  return [{ id: taskId, title: normalizedTitle(task!), plan: phase?.plan_id ?? null, inBacklog: true }];
}

/**
 * The dropped tasks with each one ahead of any it waits for: tasks-axi rm
 * refuses an id an open task still blocks on, so a plan's later phase goes
 * before the phase it waits for.
 */
function rmOrder(tasks: PlannedDrop["tasks"], backlog: BacklogTask[]): PlannedDrop["tasks"] {
  const left = [...tasks];
  const ordered: PlannedDrop["tasks"] = [];
  const blockers = new Map(
    tasks.map((t) => {
      const task = backlog.find((b) => b.id === t.id);
      return [t.id, new Set(task ? blockersOf(task) : [])];
    }),
  );
  while (left.length > 0) {
    // Nothing still left waits for it; a cycle (only a hand edit makes one) falls back to the plan's order.
    const index = Math.max(0, left.findIndex((t) => !left.some((o) => o !== t && blockers.get(o.id)!.has(t.id))));
    ordered.push(...left.splice(index, 1));
  }
  return ordered;
}

/** What dropping the target would do, or the refusal. Reads only; call inside the transaction that applies it. */
export function planDrop(db: Db, target: string, opts: { unblock: boolean }): PlannedDrop {
  const backlog = readSnapshot(db, "backlog")?.tasks ?? [];
  const pending = new Set(pendingIntents(db, "backlog").map((i) => i.task_id).filter((id): id is string => id !== null));
  const plan = /^p\d+$/.test(target) ? getPlan(db, target) : null;
  const tasks = rmOrder(plan ? planTarget(db, plan, backlog, pending) : taskTarget(db, target, backlog, pending), backlog);
  const dependents = dependentsOf(db, new Set(tasks.map((t) => t.id)), backlog);
  if (dependents.length > 0 && !opts.unblock) {
    const list = dependents.map((d) => `${d.task} (blocked by ${d.blockedBy.join(", ")})`).join("; ");
    throw new FlowrynError("has_dependents", `${target} still blocks open work: ${list}`, `drop those first, or clear the edges: flowryn drop ${target} --unblock --body-file -`);
  }
  return { plan, tasks, dependents };
}

/**
 * Apply a planned drop: the drops rows, auto off, the unblock intents before
 * the rm intents (tasks-axi rm refuses while an open task still blocks on
 * the id), the plan's state, the tasks' open items, and an event per task and
 * plan. Call inside the transaction that planned it.
 */
export function applyDrop(db: Db, planned: PlannedDrop, x: { reason: string; by: string; now: number }): void {
  const dropped = new Set(planned.tasks.map((t) => t.id));
  const unblockedBy = new Map<string, string[]>();
  for (const dep of planned.dependents) {
    for (const blocker of dep.blockedBy) {
      if (dep.inBacklog) recordIntent(db, { file: "backlog", verb: "unblock", taskId: dep.task, positional: [dep.task], flags: { by: blocker }, now: x.now });
      unblockedBy.set(blocker, [...(unblockedBy.get(blocker) ?? []), dep.task]);
    }
    // The plan's own record of what the phase waits for follows too: it decides once the backlog does not hold the phase.
    const row = db.query("SELECT plan_id, phase_no, blocked_by FROM plan_phases WHERE task_id = ?1").get(dep.task) as { plan_id: string; phase_no: number; blocked_by: string } | null;
    if (row) {
      const kept = (JSON.parse(row.blocked_by) as string[]).filter((b) => !dropped.has(b));
      db.query("UPDATE plan_phases SET blocked_by = ?3 WHERE plan_id = ?1 AND phase_no = ?2").run(row.plan_id, row.phase_no, JSON.stringify(kept));
    }
  }
  for (const task of planned.tasks) {
    const unblocked = unblockedBy.get(task.id) ?? [];
    db.query("INSERT INTO drops (task_id, plan_id, title, reason, dropped_by, unblocked, dropped_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").run(
      task.id,
      task.plan,
      task.title,
      x.reason,
      x.by,
      JSON.stringify(unblocked),
      x.now,
    );
    db.query("UPDATE task_policy SET auto = 0 WHERE task_id = ?1").run(task.id);
    if (task.inBacklog) recordIntent(db, { file: "backlog", verb: "rm", taskId: task.id, positional: [task.id], now: x.now });
    const items = db.query("UPDATE items SET state = 'resolved', resolved_by = 'task.dropped', resolved_at = ?2 WHERE task_id = ?1 AND state IN ('open','presented') RETURNING id").all(task.id, x.now) as { id: string }[];
    closeItemExplanations(db, items.map((i) => i.id), "task.dropped", x.now);
    appendEvent(db, { source: "cli", kind: "task.dropped", taskId: task.id, payload: { title: task.title, plan: task.plan, reason: x.reason, by: x.by, unblocked, backlog: task.inBacklog ? "rm" : "none" }, ts: x.now });
  }
  // A plan goes when you drop it, or once its last phase is dropped one task at a time.
  const plans = planned.plan ? [planned.plan.id] : [...new Set(planned.tasks.map((t) => t.plan).filter((p): p is string => p !== null))];
  for (const planId of plans) {
    const left = phasesOf(db, planId).filter((ph) => !isDropped(db, ph.task_id));
    if (left.length > 0) continue;
    db.query("UPDATE plans SET state = 'dropped' WHERE id = ?1").run(planId);
    appendEvent(db, { source: "cli", kind: "plan.dropped", payload: { plan: planId, phases: phasesOf(db, planId).map((ph) => ph.task_id), reason: x.reason, by: x.by }, ts: x.now });
  }
}

/** The drop record of a task, for `show`. */
export function dropRecord(db: Db, taskId: string): { task_id: string; plan_id: string | null; title: string; reason: string; dropped_by: string; unblocked: string; dropped_at: number } | null {
  return db.query("SELECT * FROM drops WHERE task_id = ?1").get(taskId) as ReturnType<typeof dropRecord>;
}

const drop: VerbSpec = {
  name: "drop",
  summary: "Remove work that never started: a Queued task, or a plan none of whose phases has started (deleted from the backlog; the reason is kept); or cancel an open ask",
  positionals: [{ name: "target", required: true, help: "task id, plan id (p<N>), or ask id (a<N>)", complete: "task" }],
  flags: {
    "body-file": { type: "string", help: "why it is dropped, from a file or - for stdin (required)", fileFor: "body" },
    unblock: { type: "boolean", help: "also clear the blocked-by edges of open tasks that wait for it, rather than refuse" },
  },
  kind: "mutation",
  roles: ["leader", "human"],
  scope: { kind: "ref", arg: "target" },
  apply(ctx, args) {
    const target = stringArg(args, "target")!;
    const reason = sanitizeBlock(stringArg(args, "body") ?? "").trim();
    if (reason.length === 0) throw new FlowrynError("bad_args", "say why it is dropped: --body-file -", `flowryn drop ${target} --body-file -`);
    if (reason.length > REASON_MAX) throw new FlowrynError("bad_args", `the reason is over ${REASON_MAX} characters`);
    if (ASK_ID.test(target)) return dropAsk(ctx.db, target, { reason, by: ctx.caller.role }, ctx.now());
    const planned = planDrop(ctx.db, target, { unblock: boolArg(args, "unblock") });
    applyDrop(ctx.db, planned, { reason, by: ctx.caller.role, now: ctx.now() });
    return {
      data: {
        ...(planned.plan ? { plan: planned.plan.id } : { task: target }),
        dropped: planned.tasks.map((t) => t.id),
        unblocked: planned.dependents.map((d) => d.task),
        backlog: planned.tasks.some((t) => t.inBacklog) ? "rm" : "none",
      },
      hints: ["flowryn fleet"],
    };
  },
  async settle(_ctx, result) {
    // After the commit: end a dropped ask's model call, which its runner then leaves cancelled.
    if (typeof result.data.ask === "string") abortAsk(result.data.ask);
    return result;
  },
};

/** An ask is cancelled, not dropped: it has no backlog entry, and its row keeps the reason. */
function dropAsk(db: Db, id: string, cancel: { reason: string; by: string }, now: number): HandlerResult {
  const ask = getAsk(db, id);
  if (!ask) throw new FlowrynError("not_found", `no ask ${id}`, "flowryn fleet");
  if (!recordCancelled(db, id, cancel, now)) throw new FlowrynError("bad_args", `ask ${id} is ${ask.state} already`, `flowryn show ${id}`);
  return { data: { ask: id, was: ask.state, state: "cancelled" }, hints: ["flowryn fleet"] };
}

export const DROP_VERBS: readonly VerbSpec[] = [drop];
