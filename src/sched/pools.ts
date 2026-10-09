import { resolveRunItems } from "../attention/items.ts";
import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { WORKER_POOL } from "../config/workflows.ts";

/** The pool the ship stage's no-mistakes pipeline runs under (src/config/workflows.ts). */
const VALIDATION_POOL = "validation";

/**
 * Capacity pool leases (design section 11): a slot is a pool_leases row tied
 * to a run and a stage, never a process, so a leak is impossible: a row is
 * released at stage end, at run end, or by the reconciler when the run dies.
 * Live leases never exceed a pool's cap (design section 14, capacity caps):
 * a grant re-counts inside its own immediate transaction and refuses rather
 * than overfill.
 */

export interface LeaseRow {
  id: number;
  pool: string;
  run_id: string;
  stage: string;
  granted_at: number;
  released_at: number | null;
  released_by: string | null;
}

export class OverCapacity extends Error {}

/** Live leases per pool. */
export function liveCounts(db: Db): Record<string, number> {
  const rows = db.query("SELECT pool, COUNT(*) AS n FROM pool_leases WHERE released_at IS NULL GROUP BY pool").all() as { pool: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.pool, r.n]));
}

export function runLeases(db: Db, runId: string): LeaseRow[] {
  return db.query("SELECT * FROM pool_leases WHERE run_id = ?1 AND released_at IS NULL ORDER BY id").all(runId) as LeaseRow[];
}

export function holdsLease(db: Db, runId: string, pool: string): boolean {
  return db.query("SELECT 1 FROM pool_leases WHERE run_id = ?1 AND pool = ?2 AND released_at IS NULL").get(runId, pool) !== null;
}

/** The pools among `wanted` that cannot take one more lease now. */
export function fullPools(db: Db, caps: Record<string, number>, wanted: readonly string[]): string[] {
  const counts = liveCounts(db);
  return wanted.filter((pool) => (counts[pool] ?? 0) >= (caps[pool] ?? 0));
}

/**
 * Take one slot of each pool for the run's stage. Call inside a transaction;
 * throws OverCapacity (and takes nothing) when any pool is full.
 */
export function grantLeases(db: Db, runId: string, taskId: string, stage: string, pools: readonly string[], caps: Record<string, number>, now: number): void {
  const wanted = pools.filter((pool) => !holdsLease(db, runId, pool));
  if (wanted.length === 0) return;
  const full = fullPools(db, caps, wanted);
  if (full.length > 0) throw new OverCapacity(`no free slot in ${full.join(", ")}`);
  for (const pool of wanted) {
    db.query("INSERT INTO pool_leases (pool, run_id, stage, granted_at) VALUES (?1, ?2, ?3, ?4)").run(pool, runId, stage, now);
  }
  appendEvent(db, { source: "daemon", kind: "pool.granted", runId, taskId, payload: { stage, pools: wanted }, ts: now });
}

/**
 * Release a run's live leases: its stage pools (keepWorker) or every one.
 * A released validation slot resolves the run's validation_stuck item: the
 * delivery, a failure, a cancel or a dead worker ends that episode.
 * Call inside a transaction. Returns the pools released.
 */
export function releaseLeases(db: Db, runId: string, taskId: string | null, opts: { keepWorker: boolean }, reason: string, now: number): string[] {
  const live = runLeases(db, runId).filter((l) => !(opts.keepWorker && l.pool === WORKER_POOL));
  if (live.length === 0) return [];
  for (const lease of live) db.query("UPDATE pool_leases SET released_at = ?2, released_by = ?3 WHERE id = ?1").run(lease.id, now, reason);
  const pools = live.map((l) => l.pool);
  appendEvent(db, { source: "daemon", kind: "pool.released", runId, taskId, payload: { pools, reason }, ts: now });
  if (pools.includes(VALIDATION_POOL)) resolveRunItems(db, runId, ["validation_stuck"], `slot released: ${reason}`, now);
  return pools;
}
