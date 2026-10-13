import type { Db } from "../db/db.ts";
import { tx } from "../db/db.ts";
import { appendEvent, type EventSource } from "../db/events.ts";
import { getRun, isTerminal, setLiveness, type Liveness, type RunRow } from "./runs.ts";

/**
 * Guarded transitions for writes decided from an observation taken before an
 * await (docs/notes/2026-10-12-next-steps-md-s9.md). A hook, a cancellation or
 * a replacement worker can land while the observation is in flight; the
 * transition re-reads the run in its transaction and applies nothing when any
 * field the decision depends on changed since.
 */

/** The fields an observation's decision rests on: lifecycle state, the worker generation, and the hook watermark. */
export const OBSERVED_FIELDS = [
  "state",
  "stage_state",
  "pending_launch",
  "resume_count",
  "liveness",
  "proc_pid",
  "proc_start",
  "launched_at",
  "worker_started_at",
  "pane_id",
  "agent_session",
  "last_hook_at",
  "busy_until",
  "idle_since",
] as const satisfies readonly (keyof RunRow)[];

export type ObservedField = (typeof OBSERVED_FIELDS)[number];
export type StaleFields = Partial<Record<ObservedField | "run", { seen: unknown; current: unknown }>>;
export type Observed<T> = { applied: true; value: T } | { applied: false; changed: StaleFields };

/** What changed between the observed row and the current one; empty when the observation still holds. */
export function staleFields(seen: RunRow, current: RunRow | null): StaleFields {
  if (!current) return { run: { seen: seen.id, current: null } };
  const changed: StaleFields = {};
  for (const field of OBSERVED_FIELDS) {
    if (seen[field] !== current[field]) changed[field] = { seen: seen[field], current: current[field] };
  }
  if (isTerminal(current.state) && !changed.state) changed.state = { seen: seen.state, current: current.state };
  return changed;
}

/**
 * Apply `apply` only if the run still matches `seen` on OBSERVED_FIELDS and is
 * not terminal. On success `seen` is refreshed from the current row first, so
 * `apply` writes against current truth. On a stale observation nothing is
 * written but one `run.observation_stale` event naming the transition.
 */
export function observedTransition<T>(db: Db, seen: RunRow, transition: string, source: EventSource, now: number, apply: (run: RunRow) => T): Observed<T> {
  return tx(db, () => {
    const current = getRun(db, seen.id);
    const changed = staleFields(seen, current);
    if (Object.keys(changed).length > 0) {
      appendEvent(db, { source, kind: "run.observation_stale", runId: seen.id, taskId: seen.task_id, payload: { transition, changed }, ts: now });
      return { applied: false, changed };
    }
    Object.assign(seen, current);
    return { applied: true, value: apply(seen) };
  });
}

/** A liveness value read from an observation, written only if the run is still the one observed. */
export function observeLiveness(db: Db, seen: RunRow, liveness: Liveness, transition: string, source: EventSource, detail: Record<string, unknown>, now: number): Observed<boolean> {
  return observedTransition(db, seen, transition, source, now, (run) => setLiveness(db, run, liveness, source, detail, now));
}
