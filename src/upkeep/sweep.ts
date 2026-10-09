import { existsSync } from "node:fs";
import type { Db } from "../db/db.ts";

/**
 * Clean ended worktrees (spec 3, phase 3): a failed or cancelled run keeps
 * its worktree, and the leader ran `flowryn cleanup` on each by hand. Once a
 * run has been idle `[upkeep] clean_ended_hours`, the daemon asks the same
 * cleanup, through the cleanup guard and with no discard approval, so it
 * removes only a worktree with nothing to lose. A refusal (unlanded work, a
 * lock, a process still in it) is recorded on the run and opens no item:
 * a cancelled task with unlanded work is one you parked on purpose, and only
 * `flowryn cleanup --discard` removes it. A refusal updates the run, so it is
 * asked again only after another full wait.
 */

const HOUR_MS = 3_600_000;

/** Runs whose worktree the sweep asks to clean now, oldest first. */
export function sweepCandidates(db: Db, now: number, hours: number): string[] {
  if (hours <= 0) return [];
  const rows = db
    .query(
      `SELECT r.id, r.worktree_path FROM runs r
       WHERE r.state IN ('failed','cancelled') AND (r.cleanup IS NULL OR r.cleanup = 'refused') AND r.updated_at <= ?1
         AND NOT EXISTS (SELECT 1 FROM runs o WHERE o.worktree_path = r.worktree_path AND o.id != r.id AND o.state NOT IN ('cleaned','failed','cancelled'))
       ORDER BY r.updated_at`,
    )
    .all(now - hours * HOUR_MS) as { id: string; worktree_path: string }[];
  return rows.filter((r) => existsSync(r.worktree_path)).map((r) => r.id);
}
