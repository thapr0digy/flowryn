import type { Db } from "../db/db.ts";
import { itemLines } from "../attention/items.ts";
import { idleByDesign } from "./prompt-wedge.ts";
import { taskTitle, type RunRow } from "./runs.ts";

/**
 * The worker_idle pointer (design section 6, "idle 15 min without an
 * outcome"): one item per idle episode, never while the worker waits on you,
 * and again only after a long backoff. Without this, an item you dismissed
 * reopened on the reconciler's next pass, or its next kick.
 */

/**
 * Is the worker idle because it waits on you or on Flowryn: a review gate or
 * its own blocking question (idleByDesign), any open question of its own (the
 * answer arrives as a steer), or a stage that waits for capacity?
 */
export function waitingOnOthers(db: Db, run: RunRow): boolean {
  if (idleByDesign(db, run) || run.stage_state === "waiting") return true;
  return db.query("SELECT 1 FROM decisions WHERE run_id = ?1 AND state = 'open'").get(run.id) !== null;
}

/**
 * When the idle stretch the alert measures began: the Stop, or the later
 * moment the worker was handed its next move (a stage started, a question
 * answered). A worker that idled for hours behind a review gate is not
 * overdue the moment the gate passes.
 */
export function idleEpisodeStart(db: Db, run: RunRow): number {
  const answered = db.query("SELECT MAX(answered_at) AS at FROM decisions WHERE run_id = ?1").get(run.id) as { at: number | null };
  return Math.max(run.idle_since ?? 0, run.stage_started_at ?? 0, answered.at ?? 0);
}

/**
 * May a worker_idle item open now? Not while one is open; once per episode
 * (an item opened at or after `episodeStart`, even one you dismissed, counts);
 * and after that only `realertMs` after the latest one opened.
 */
export function idleAlertDue(db: Db, runId: string, episodeStart: number, now: number, realertMs: number): boolean {
  const last = db.query("SELECT state, opened_at FROM items WHERE kind = 'worker_idle' AND run_id = ?1 ORDER BY opened_at DESC LIMIT 1").get(runId) as {
    state: string;
    opened_at: number;
  } | null;
  if (!last) return true;
  if (last.state === "open" || last.state === "presented") return false;
  if (last.opened_at < episodeStart) return true;
  return now - last.opened_at >= realertMs;
}

/** Why an idle worker's pointer says it is idle: waiting on its own background jobs, it ignored the turn-end reminder, or neither. */
export type IdleWhy = { jobs: string } | { ignoredReminder: boolean };

/** The worker_idle pointer's line for an idle stretch of `idleMs`. */
export function idleAlertLine(title: string, idleMs: number, why: IdleWhy): string {
  const idleFor = `has been idle ${Math.round(idleMs / 60_000)}m`;
  if ("jobs" in why) return `Worker for ${title} ${idleFor} waiting on ${why.jobs}`;
  return `Worker for ${title} ${why.ignoredReminder ? `got the turn-end reminder, ended its turn again, and ${idleFor}` : idleFor} without an outcome`;
}

/**
 * The turn-end reminder was just settled ignored: an open worker_idle pointer
 * opened before that result landed (the reconciler saw the stretch between the
 * reminder and the worker's next turn end) gets the reminder clause now, so its
 * line never depends on which came first. Only a plain idle pointer is touched:
 * not one waiting on background jobs, a stale-hooks one, or one already saying
 * so. Call inside the result's transaction; returns the refreshed item's id.
 */
export function noteIgnoredReminder(db: Db, run: RunRow, now: number): string | null {
  const item = db
    .query(
      `SELECT i.id, i.opened_at, e.payload FROM items i JOIN events e ON e.seq = i.event_seq
       WHERE i.kind = 'worker_idle' AND i.run_id = ?1 AND i.state IN ('open','presented') AND e.kind = 'run.idle_alert'
       ORDER BY i.opened_at DESC LIMIT 1`,
    )
    .get(run.id) as { id: string; opened_at: number; payload: string } | null;
  if (!item) return null;
  const alert = JSON.parse(item.payload) as { idle_ms: number; ignored_reminder?: boolean; background_jobs?: unknown[] };
  if (alert.ignored_reminder === true || alert.background_jobs !== undefined) return null;
  // opened_at and idle_ms both come from the reconciler's clock for that pass.
  const idleFrom = item.opened_at - alert.idle_ms;
  const lines = itemLines(idleAlertLine(taskTitle(db, run.task_id), Math.max(0, now - idleFrom), { ignoredReminder: true }));
  db.query("UPDATE items SET line = ?2, full_line = ?3 WHERE id = ?1").run(item.id, lines.line, lines.full_line);
  return item.id;
}
