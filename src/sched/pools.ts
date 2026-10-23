import { resolveRunItems } from "../attention/items.ts";
import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { WORKER_POOL } from "../config/workflows.ts";
import type { ProcIdentity } from "../runtime/proc.ts";

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

/** Live leases per pool: runs' and jobs' alike, since both count against the same caps. */
export function liveCounts(db: Db): Record<string, number> {
  const rows = db
    .query(
      `SELECT pool, SUM(n) AS n FROM (
         SELECT pool, COUNT(*) AS n FROM pool_leases WHERE released_at IS NULL GROUP BY pool
         UNION ALL SELECT pool, COUNT(*) AS n FROM job_leases WHERE released_at IS NULL GROUP BY pool)
       GROUP BY pool`,
    )
    .all() as { pool: string; n: number }[];
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

/**
 * Job leases (docs/notes/2026-10-12-next-steps-md-64.md): heavy work that is
 * not a run, a `flowryn verify`, holds a slot of a pool in job_leases. It is
 * counted by liveCounts with the runs' leases, so the scheduler and a job
 * never overfill a pool between them: each re-counts inside its own immediate
 * transaction. A job lease is released once, after the job's processes and
 * its worktree are gone.
 */

export type JobKind = "verify";

export interface JobRef {
  kind: JobKind;
  id: string;
  taskId: string | null;
}

export interface JobLeaseRow {
  id: number;
  pool: string;
  kind: JobKind;
  job_id: string;
  task_id: string | null;
  granted_at: number;
  released_at: number | null;
  released_by: string | null;
  proc_pid: number | null;
  proc_start: number | null;
  proc_exe: string | null;
}

export function liveJobLeases(db: Db, kind?: JobKind): JobLeaseRow[] {
  return (kind
    ? db.query("SELECT * FROM job_leases WHERE released_at IS NULL AND kind = ?1 ORDER BY id").all(kind)
    : db.query("SELECT * FROM job_leases WHERE released_at IS NULL ORDER BY id").all()) as JobLeaseRow[];
}

/** Who holds the pool's live slots, for a refusal: "t3 (ship), v2 (verify)". */
export function poolHolders(db: Db, pool: string): string {
  const runs = db.query("SELECT r.task_id, l.stage FROM pool_leases l JOIN runs r ON r.id = l.run_id WHERE l.pool = ?1 AND l.released_at IS NULL ORDER BY l.granted_at, l.id").all(pool) as { task_id: string; stage: string }[];
  const jobs = db.query("SELECT kind, job_id FROM job_leases WHERE pool = ?1 AND released_at IS NULL ORDER BY granted_at, id").all(pool) as { kind: string; job_id: string }[];
  return [...runs.map((r) => `${r.task_id} (${r.stage})`), ...jobs.map((j) => `${j.job_id} (${j.kind})`)].join(", ");
}

/** Take one slot of `pool` for the job. Call inside a transaction; throws OverCapacity (and takes nothing) when the pool is full. */
export function grantJobLease(db: Db, job: JobRef, pool: string, caps: Record<string, number>, now: number): void {
  if (fullPools(db, caps, [pool]).length > 0) throw new OverCapacity(`no free slot in ${pool}`);
  db.query("INSERT INTO job_leases (pool, kind, job_id, task_id, granted_at) VALUES (?1, ?2, ?3, ?4, ?5)").run(pool, job.kind, job.id, job.taskId, now);
  appendEvent(db, { source: "daemon", kind: "pool.granted", taskId: job.taskId, payload: { job: job.id, kind: job.kind, pools: [pool] }, ts: now });
}

/**
 * Record a step process of the job (its process group leader) on its live leases: one row per
 * process, as a parallel group runs several at once. Call inside a transaction; whether a live lease took it.
 */
export function recordJobProcess(db: Db, job: JobRef, proc: ProcIdentity, now: number): boolean {
  const leases = db.query("SELECT id FROM job_leases WHERE kind = ?1 AND job_id = ?2 AND released_at IS NULL").all(job.kind, job.id) as { id: number }[];
  if (leases.length === 0) return false;
  for (const lease of leases) {
    db.query("INSERT INTO job_procs (lease_id, proc_pid, proc_start, proc_exe, recorded_at) VALUES (?1, ?2, ?3, ?4, ?5)").run(lease.id, proc.pid, proc.start, proc.exe, now);
  }
  appendEvent(db, { source: "daemon", kind: "pool.job_process", taskId: job.taskId, payload: { job: job.id, kind: job.kind, pid: proc.pid }, ts: now });
  return true;
}

/** Every step process recorded on the lease, oldest first: its job_procs rows, and the one a lease from before migration 30 holds. */
export function leaseProcesses(db: Db, lease: JobLeaseRow): ProcIdentity[] {
  const rows = db.query("SELECT proc_pid, proc_start, proc_exe FROM job_procs WHERE lease_id = ?1 ORDER BY id").all(lease.id) as { proc_pid: number; proc_start: number; proc_exe: string }[];
  const procs = rows.map((r) => ({ pid: r.proc_pid, start: r.proc_start, exe: r.proc_exe }));
  if (lease.proc_pid !== null && lease.proc_start !== null && lease.proc_exe !== null) procs.unshift({ pid: lease.proc_pid, start: lease.proc_start, exe: lease.proc_exe });
  return procs;
}

/** Release the job's live leases, once: a second call finds none and records nothing. Call inside a transaction. Returns the pools released. */
export function releaseJobLeases(db: Db, job: JobRef, reason: string, now: number): string[] {
  const live = db.query("SELECT * FROM job_leases WHERE kind = ?1 AND job_id = ?2 AND released_at IS NULL ORDER BY id").all(job.kind, job.id) as JobLeaseRow[];
  if (live.length === 0) return [];
  for (const lease of live) db.query("UPDATE job_leases SET released_at = ?2, released_by = ?3 WHERE id = ?1 AND released_at IS NULL").run(lease.id, now, reason);
  const pools = live.map((l) => l.pool);
  appendEvent(db, { source: "daemon", kind: "pool.released", taskId: job.taskId, payload: { job: job.id, kind: job.kind, pools, reason }, ts: now });
  return pools;
}
