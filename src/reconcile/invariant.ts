import type { Db } from "../db/db.ts";
import { pendingIntents } from "../journal/journal.ts";
import { readSnapshot } from "../journal/snapshot.ts";
import type { BacklogTask } from "../journal/tasks-axi.ts";
import { closeDivergence, openDivergence, openDivergences } from "./divergence.ts";

/**
 * The reconciler's invariant pass (design section 8): a task is In flight if
 * and only if it has a non-terminal run. Every violation is a backlog
 * divergence (P1), never silently fixed: the run is untouched and the
 * backlog is not rewritten until `flowryn divergence resolve` says which one
 * wins. The backlog watcher already flags a hand edit against a live run as it
 * happens; this pass catches drift the other way too (a task left In flight
 * with no run behind it) and any the watcher could not see.
 *
 * It reads the backlog snapshot, which the journal writes in the same
 * transaction that marks an intent applied, so a task whose intent is still
 * pending is skipped rather than judged on a state about to change. A
 * backlog divergence whose task agrees with the runs again is closed ("the
 * reconciler seeing the resolution happen elsewhere", section 9).
 */

export interface InvariantResult {
  opened: string[];
  resolved: string[];
}

interface LiveRun {
  id: string;
  task_id: string;
  state: string;
}

const STATE_LABEL: Record<BacklogTask["state"], string> = { queued: "Queued", in_flight: "In flight", done: "Done" };

/** The summary of a task left In flight with no live run; an accepted edit is recognized by it. */
function noRunSummary(db: Db, taskId: string): string {
  const latest = db.query("SELECT id, state FROM runs WHERE task_id = ?1 ORDER BY started_at DESC, rowid DESC LIMIT 1").get(taskId) as { id: string; state: string } | null;
  return `task ${taskId} is In flight in the backlog but has no live run (${latest ? `its last run ${latest.id} is ${latest.state}` : "Flowryn never ran it"})`;
}

/** Check the invariant against the backlog snapshot. Call inside a transaction; null when there is no snapshot yet. */
export function checkInvariant(db: Db, now: number): InvariantResult | null {
  const snapshot = readSnapshot(db, "backlog");
  if (!snapshot) return null;
  const tasks = new Map(snapshot.tasks.map((t) => [t.id, t]));
  const pending = new Set(pendingIntents(db, "backlog").map((i) => i.task_id));
  const live = db.query("SELECT id, task_id, state FROM runs WHERE state NOT IN ('cleaned','failed','cancelled') ORDER BY started_at").all() as LiveRun[];
  const liveByTask = new Map(live.map((r) => [r.task_id, r]));
  const holds = (taskId: string) => liveByTask.has(taskId) === (tasks.get(taskId)?.state === "in_flight");
  const result: InvariantResult = { opened: [], resolved: [] };

  const open = openDivergences(db, { backlogOnly: true });
  for (const d of open) {
    if (!d.task_id || pending.has(d.task_id) || !holds(d.task_id)) continue;
    closeDivergence(db, d, "agrees", "the backlog and the runs agree again", "reconciler", now);
    result.resolved.push(d.id);
  }
  const flagged = new Set(open.filter((d) => d.resolved_at === null).map((d) => d.task_id));

  for (const run of live) {
    if (pending.has(run.task_id) || flagged.has(run.task_id)) continue;
    const task = tasks.get(run.task_id);
    if (task?.state === "in_flight") continue;
    const summary = task
      ? `task ${run.task_id} is ${STATE_LABEL[task.state]} in the backlog, but its run ${run.id} is ${run.state}`
      : `task ${run.task_id} is missing from the backlog, but its run ${run.id} is ${run.state}`;
    const id = openDivergence(db, "reconciler", { runId: run.id, taskId: run.task_id, higher: "run", lower: "backlog", summary }, now);
    if (id) result.opened.push(id);
  }

  for (const task of snapshot.tasks) {
    if (task.state !== "in_flight" || liveByTask.has(task.id) || pending.has(task.id) || flagged.has(task.id)) continue;
    const summary = noRunSummary(db, task.id);
    // Your edit accepted once (accept-edit) stands for as long as the task reads the same.
    if (db.query("SELECT 1 FROM divergences WHERE task_id = ?1 AND summary = ?2 AND resolution = 'accept-edit'").get(task.id, summary)) continue;
    const latest = db.query("SELECT id FROM runs WHERE task_id = ?1 ORDER BY started_at DESC, rowid DESC LIMIT 1").get(task.id) as { id: string } | null;
    const id = openDivergence(db, "reconciler", { runId: latest?.id ?? null, taskId: task.id, higher: "run", lower: "backlog", summary }, now);
    if (id) result.opened.push(id);
  }
  return result;
}
