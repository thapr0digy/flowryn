import { FlowrynError } from "../api/errors.ts";
import type { Db } from "../db/db.ts";
import { tx } from "../db/db.ts";
import { appendEvent, type EventSource } from "../db/events.ts";
import { latestMerge } from "../policy/merge.ts";
import { deliveredOf } from "./delivery.ts";
import { latestOperation } from "./operations.ts";
import { getRun, getRunWithPolicy, isTerminal, setLiveness, type Liveness, type RunRow, type RunWithPolicy } from "./runs.ts";

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
      const watermarkOnly = onlyHookWatermark(changed);
      if (!watermarkOnly || !recentWatermarkEvent(db, seen.id, now)) {
        appendEvent(db, { source, kind: "run.observation_stale", runId: seen.id, taskId: seen.task_id, payload: { transition, changed, ...(watermarkOnly ? { watermark_only: true } : {}) }, ts: now });
      }
      return { applied: false, changed };
    }
    Object.assign(seen, current);
    return { applied: true, value: apply(seen) };
  });
}

/** The fields every hook writes: a newer hook during a pass changes only these. */
const HOOK_WATERMARK: readonly ObservedField[] = ["last_hook_at", "busy_until", "idle_since"];

/**
 * A busy worker's hooks overtake almost every reconciler pass. A stale
 * observation whose only change is that watermark on a live run is still
 * dropped, but records at most one event per run per this window; a change
 * of state, generation or liveness always records one.
 */
export const WATERMARK_EVENT_WINDOW_MS = 10 * 60_000;

function onlyHookWatermark(changed: StaleFields): boolean {
  const fields = Object.keys(changed);
  return fields.length > 0 && fields.every((f) => (HOOK_WATERMARK as readonly string[]).includes(f));
}

function recentWatermarkEvent(db: Db, runId: string, now: number): boolean {
  return (
    db
      .query("SELECT 1 FROM events WHERE run_id = ?1 AND kind = 'run.observation_stale' AND ts > ?2 AND json_extract(payload, '$.watermark_only') = 1 LIMIT 1")
      .get(runId, now - WATERMARK_EVENT_WINDOW_MS) !== null
  );
}

/** A liveness value read from an observation, written only if the run is still the one observed. */
export function observeLiveness(db: Db, seen: RunRow, liveness: Liveness, transition: string, source: EventSource, detail: Record<string, unknown>, now: number): Observed<boolean> {
  return observedTransition(db, seen, transition, source, now, (run) => setLiveness(db, run, liveness, source, detail, now));
}

/**
 * The facts a delivery or stage-progression observation rests on
 * (docs/notes/2026-10-13-next-steps-md-av.md): the run's lifecycle state and
 * stage, the delivery it compares against, the latest merge request, package
 * 1's newest operation (the execution generation, or a cancel in flight) and
 * the live validation slot. Unlike OBSERVED_FIELDS it leaves out the worker's
 * liveness and hooks: a delivered run's worker may still fire them.
 */
export interface DeliveryBasis {
  run: string;
  /** null once the run is gone. */
  state: RunRow["state"] | null;
  stage: string | null;
  stage_state: RunRow["stage_state"] | null;
  /** The latest `pr`/`local` delivery: `<kind> <ref> <head>`. */
  delivered: string | null;
  /** The latest merge request: `<id> <state>`. */
  merge: string | null;
  /** The newest operation: `<id> <phase>`. */
  operation: string | null;
  /** The live validation slot: `<lease id> <granted_at>`. */
  validation: string | null;
}

export const BASIS_PARTS = ["state", "stage", "stage_state", "delivered", "merge", "operation", "validation"] as const;
export type BasisPart = (typeof BASIS_PARTS)[number];
export type StaleParts = Partial<Record<BasisPart | "run", { seen: unknown; current: unknown }>>;
export type DeliveryObserved<T> = { applied: true; value: T } | { applied: false; changed: StaleParts };

/** Read a run's delivery basis now. */
export function deliveryBasis(db: Db, runId: string): DeliveryBasis {
  const run = getRun(db, runId);
  if (!run) return { run: runId, state: null, stage: null, stage_state: null, delivered: null, merge: null, operation: null, validation: null };
  const delivered = deliveredOf(db, run.task_id);
  const merge = latestMerge(db, run.task_id);
  const operation = latestOperation(db, run.id);
  const lease = db.query("SELECT id, granted_at FROM pool_leases WHERE run_id = ?1 AND pool = 'validation' AND released_at IS NULL").get(run.id) as { id: number; granted_at: number } | null;
  return {
    run: run.id,
    state: run.state,
    stage: run.stage,
    stage_state: run.stage_state,
    delivered: delivered ? `${delivered.kind} ${delivered.ref} ${delivered.head}` : null,
    merge: merge ? `${merge.id} ${merge.state}` : null,
    operation: operation ? `${operation.id} ${operation.phase}` : null,
    validation: lease ? `${lease.id} ${lease.granted_at}` : null,
  };
}

/** Which of `parts` changed between two bases; a gone or terminal run is always stale. Empty when the observation still holds. */
export function staleBasis(seen: DeliveryBasis, current: DeliveryBasis, parts: readonly BasisPart[]): StaleParts {
  if (current.state === null) return { run: { seen: seen.run, current: null } };
  const changed: StaleParts = {};
  for (const part of parts) {
    if (seen[part] !== current[part]) changed[part] = { seen: seen[part], current: current[part] };
  }
  if (isTerminal(current.state) && !changed.state) changed.state = { seen: seen.state, current: current.state };
  return changed;
}

function staleEvent(seen: DeliveryBasis, taskId: string | null, transition: string, changed: StaleParts, source: EventSource, now: number) {
  return { source, kind: "run.observation_stale", runId: seen.run, taskId, payload: { transition, changed }, ts: now };
}

/**
 * Apply `apply` to the current run only if the parts of its delivery basis
 * the transition depends on still match `seen` and the run is not terminal.
 * On a stale observation nothing is written but one `run.observation_stale`
 * event naming the transition and each changed part.
 */
export function deliveryTransition<T>(
  db: Db,
  seen: DeliveryBasis,
  parts: readonly BasisPart[],
  transition: string,
  source: EventSource,
  now: number,
  apply: (run: RunWithPolicy) => T,
): DeliveryObserved<T> {
  return tx(db, () => {
    const changed = staleBasis(seen, deliveryBasis(db, seen.run), parts);
    const run = getRunWithPolicy(db, seen.run);
    if (!run || Object.keys(changed).length > 0) {
      appendEvent(db, staleEvent(seen, run?.task_id ?? null, transition, changed, source, now));
      return { applied: false, changed };
    }
    return { applied: true, value: apply(run) };
  });
}

/** What a verb tells its caller when its reads were overtaken: each changed part, seen and now. */
function staleMessage(transition: string, changed: StaleParts): string {
  const parts = Object.entries(changed).map(([part, v]) => `${part} ${String(v?.seen ?? "none")} → ${String(v?.current ?? "none")}`);
  return `the run changed while ${transition} was reading GitHub and git (${parts.join("; ")}); nothing was recorded`;
}

/**
 * For a verb's `apply` (inside the gateway's transaction): throw
 * `observation_stale` when the basis its `prepare` read has changed. The
 * gateway rolls the apply back and records the error's event on its own.
 */
export function requireDeliveryBasis(db: Db, seen: DeliveryBasis, parts: readonly BasisPart[], transition: string, source: EventSource, now: number, help: string): void {
  const changed = staleBasis(seen, deliveryBasis(db, seen.run), parts);
  if (Object.keys(changed).length === 0) return;
  const taskId = getRun(db, seen.run)?.task_id ?? null;
  throw new FlowrynError("observation_stale", staleMessage(transition, changed), help, staleEvent(seen, taskId, transition, changed, source, now));
}
