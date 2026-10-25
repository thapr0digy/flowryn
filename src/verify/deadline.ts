import type { Db } from "../db/db.ts";
import { normalizeStep } from "./policy.ts";
import type { VerifyStep } from "./store.ts";

/**
 * Each verify step's own deadline (docs/notes/2026-10-22-verify-reliability-per-xe.md):
 * `verify_step_timeout_min` when the project sets it; otherwise from the step's
 * history in this project: STEP_DEADLINE_FACTOR × the slowest of its last
 * HISTORY_PASSES clean passes (one attempt, no hang), and never under
 * STEP_DEADLINE_FLOOR_MS. A step with no clean pass yet has none: only the
 * whole run's deadline bounds it, as before. The runner caps every step's
 * deadline by the run's remaining time.
 */

export const STEP_DEADLINE_FACTOR = 3;
export const STEP_DEADLINE_FLOOR_MS = 2 * 60_000;
export const HISTORY_PASSES = 5;
/** How many finished verifications of the project are read for history. */
const HISTORY_ROWS = 50;

export interface StepDeadline {
  ms: number;
  source: "config" | "history";
  /** The slowest recent clean pass the deadline came from; null for a configured one. */
  usual_ms: number | null;
}

/** The slowest of each step's last clean passes in the project, by normalized step. */
export function recentPasses(db: Db, projectId: string): Map<string, number[]> {
  const rows = db
    .query("SELECT steps FROM verifications WHERE project_id = ?1 AND state <> 'running' ORDER BY started_at DESC, rowid DESC LIMIT ?2")
    .all(projectId, HISTORY_ROWS) as { steps: string }[];
  const passes = new Map<string, number[]>();
  for (const row of rows) {
    let steps: VerifyStep[];
    try {
      steps = JSON.parse(row.steps) as VerifyStep[];
    } catch {
      continue;
    }
    for (const step of steps) {
      if (step.state !== "passed" || typeof step.ms !== "number" || (step.attempts ?? 1) > 1 || (step.hangs ?? 0) > 0) continue;
      const key = normalizeStep(step.name);
      const seen = passes.get(key) ?? [];
      if (seen.length < HISTORY_PASSES) passes.set(key, [...seen, step.ms]);
    }
  }
  return passes;
}

/** Each step's own deadline, in order; null where it has none. */
export function stepDeadlines(db: Db, projectId: string, steps: readonly string[], configuredMs: number | null): (StepDeadline | null)[] {
  if (configuredMs !== null) return steps.map(() => ({ ms: configuredMs, source: "config", usual_ms: null }));
  const passes = recentPasses(db, projectId);
  return steps.map((step) => {
    const seen = passes.get(normalizeStep(step));
    if (!seen || seen.length === 0) return null;
    const usual = Math.max(...seen);
    return { ms: Math.max(STEP_DEADLINE_FLOOR_MS, STEP_DEADLINE_FACTOR * usual), source: "history", usual_ms: usual };
  });
}

/** "0.9 s", "2 min", "2.5 min". */
export function duration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")} s`;
  const min = ms / 60_000;
  return `${Number.isInteger(min) ? min : min.toFixed(1)} min`;
}

/** "its 2 min deadline (it usually takes 1.3 s)", "its 5 min deadline (verify_step_timeout_min)". */
export function deadlineLine(deadline: StepDeadline): string {
  const why = deadline.source === "config" ? "verify_step_timeout_min" : `it usually takes ${duration(deadline.usual_ms ?? 0)}`;
  return `its ${duration(deadline.ms)} deadline (${why})`;
}
