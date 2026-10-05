import type { Db } from "../db/db.ts";
import { idleByDesign } from "./prompt-wedge.ts";
import type { RunRow } from "./runs.ts";

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
