import { getMeta, setMeta, type Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import type { LandingRow } from "./landing-queue.ts";
import { getRequest, positionOf } from "./queue.ts";
import { getVerification } from "./store.ts";

/**
 * Landing batches' rows (migration 64, docs/notes/2026-11-21-landing-batches-one-27.md), read by
 * the batch controller (src/verify/landing-batch.ts), the merge gate (src/policy/merge.ts) and the
 * views. A rebuild is a new batch, and the old one ends `dissolved`.
 *
 *   verifying → landing → landed
 *       ↘ verifying (a failure that looks environmental: retried after a backoff, src/verify/batch-retry.ts)
 *       ↘ dissolved: split (a red batch of two or more: a new batch of its first half), sent_back or
 *         held_member (a lone member's red goes back to its worker; a lone machine failure holds that entry)
 *       ↘ held (main_red: main itself fails; base_moving; verify_cancelled: the leader retries or drops a branch)
 *   landing ↘ held (loosened_gate: a fix loosens a gate) → landing once the leader countersigns it (src/policy/countersign.ts)
 *   any live state ↘ dissolved (rebuilt, emptied, or batch mode off)
 *   fixing: a batch fixed forward before migration 70 (legacy rows; dissolved on sight)
 *
 * A batch's head never moves: a change of members is a new batch.
 */

export const BATCH_STATES = ["verifying", "fixing", "landing", "held", "landed", "dissolved"] as const;
export type BatchState = (typeof BATCH_STATES)[number];
export const LIVE_BATCH_SQL = "state IN ('verifying','fixing','landing','held')";

/** A batch's fix task: `open` until it is delivered onto the batch (`delivered`) or ended (`ended`). */
export type FixState = "open" | "delivered" | "ended";

/** The local branch a fix task starts from: the batch head, kept reachable until the fix's own branch holds it. */
export const FIX_BRANCH_PREFIX = "flowryn/batch/";
export function fixBranch(batchId: string): string {
  return `${FIX_BRANCH_PREFIX}${batchId}`;
}

const batchingKey = (projectId: string) => `landing_batched:${projectId}`;

/** Whether the project lands in batches, as its last landing pass found it: the pass reads the config, the views read this. */
export function projectBatches(db: Db, projectId: string): boolean {
  return getMeta(db, batchingKey(projectId)) === "1";
}

/** Record whether the project lands in batches, with an event when that changes. Call inside a transaction. */
export function markBatching(db: Db, projectId: string, on: boolean, now: number): void {
  if (projectBatches(db, projectId) === on) return;
  setMeta(db, batchingKey(projectId), on ? "1" : "0");
  appendEvent(db, { source: "daemon", kind: "landing.batching", payload: { project: projectId, on }, ts: now });
}

export interface BatchRow {
  id: string;
  project_id: string;
  state: BatchState;
  /** Local main's tip the batch was built on. */
  base_sha: string;
  /** The batch head: main and every member, one merge commit each (or the first member itself when it holds main). */
  head_sha: string;
  /** Its full verify's request. */
  request_id: string | null;
  /** The verification that held it. */
  verification_id: string | null;
  /** Rebuilds because main moved under it, carried across rebuilds. */
  integrations: number;
  /** The head a leader's retry already re-verified once. */
  retried_head: string | null;
  /** Its open landing_batch_held item. */
  item_id: string | null;
  /** held: the member the hold names (a gate loosening's fix), or null. */
  culprit: string | null;
  /** A legacy batch's fix-forward task (before migration 70), the head it started on, where it stood and since when. */
  fix_task: string | null;
  fix_base: string | null;
  fix_state: FixState | null;
  fix_since: number | null;
  /** Its one flake rerun, JSON (src/verify/flake.ts BatchFlake), or null. */
  flake: string | null;
  /** Automatic retries of its head so far (src/verify/batch-retry.ts), and when the next may start. */
  auto_retries: number;
  retry_at: number | null;
  /** Its split stack, JSON (src/verify/batch-retry.ts SplitStack): the halves of a red batch still to verify. */
  split_rest: string | null;
  reason: string | null;
  detail: string | null;
  created_at: number;
  state_since: number;
  updated_at: number;
}

/** What a batch's verifications and requests are recorded under: never a PR URL or a local:<branch>. */
export const BATCH_REF_PREFIX = "batch:";
export function batchRef(projectId: string, batchId: string): string {
  return `${BATCH_REF_PREFIX}${projectId}/${batchId}`;
}

export function getBatch(db: Db, id: string): BatchRow | null {
  return db.query("SELECT * FROM landing_batches WHERE id = ?1").get(id) as BatchRow | null;
}

/** The project's live batch (at most one). */
export function liveBatch(db: Db, projectId: string): BatchRow | null {
  return db.query(`SELECT * FROM landing_batches WHERE project_id = ?1 AND ${LIVE_BATCH_SQL}`).get(projectId) as BatchRow | null;
}

/** A live batch by its verify ref and head: what keeps its verify request wanted. */
export function liveBatchAt(db: Db, ref: string, head: string): BatchRow | null {
  if (!ref.startsWith(BATCH_REF_PREFIX)) return null;
  const id = ref.slice(ref.lastIndexOf("/") + 1);
  const batch = getBatch(db, id);
  return batch && batchRef(batch.project_id, batch.id) === ref && batch.head_sha === head && (batch.state === "verifying" || batch.state === "landing") ? batch : null;
}

/**
 * What a lone batch's baseline verify of main is recorded under (src/verify/landing-batch.ts): main's
 * tip, before a red lone member is sent back, when nothing proves main green since the split began.
 */
export const BASE_REF_PREFIX = "base:";
export function baseRef(projectId: string, batchId: string): string {
  return `${BASE_REF_PREFIX}${projectId}/${batchId}`;
}

/** A live lone batch by its baseline ref and main's tip: what keeps its baseline request wanted. */
export function liveBaselineAt(db: Db, ref: string, head: string): BatchRow | null {
  if (!ref.startsWith(BASE_REF_PREFIX)) return null;
  const batch = getBatch(db, ref.slice(ref.lastIndexOf("/") + 1));
  return batch && baseRef(batch.project_id, batch.id) === ref && batch.base_sha === head && batch.state === "verifying" && batchMembers(db, batch.id).length === 1 ? batch : null;
}

/** The project's newest batch that ended (landed or dissolved): its split stack says what verifies next. */
export function newestEndedBatch(db: Db, projectId: string): BatchRow | null {
  return db.query("SELECT * FROM landing_batches WHERE project_id = ?1 AND state IN ('landed','dissolved') ORDER BY CAST(substr(id, 3) AS INTEGER) DESC LIMIT 1").get(projectId) as BatchRow | null;
}

/** A passed verify of `head` under `policy` that finished at or after `since`, under any ref: evidence the head is green. */
export function passedAtHead(db: Db, head: string, policy: string, since: number): boolean {
  return db.query("SELECT 1 FROM verifications WHERE head_sha = ?1 AND policy_id = ?2 AND state = 'passed' AND finished_at >= ?3 LIMIT 1").get(head, policy, since) !== null;
}

/** Every entry that was ever in the batch, in batch order. */
export function batchRows(db: Db, batchId: string): LandingRow[] {
  return db.query("SELECT * FROM landing_queue WHERE batch_id = ?1 ORDER BY batch_pos, enqueued_at").all(batchId) as LandingRow[];
}

/** The batch's members still in it (landing). */
export function batchMembers(db: Db, batchId: string): LandingRow[] {
  return batchRows(db, batchId).filter((r) => r.state === "landing");
}

/**
 * The batch a run's live entry is landing in, while that batch lands: what the merge gate reads
 * the run's verify evidence and fast-forward from instead of its own head (src/policy/merge.ts).
 */
export function landingBatchOfRun(db: Db, runId: string): BatchRow | null {
  return db
    .query(`SELECT b.* FROM landing_queue l JOIN landing_batches b ON b.id = l.batch_id WHERE l.run_id = ?1 AND l.state = 'landing' AND b.state = 'landing'`)
    .get(runId) as BatchRow | null;
}

/** Where a batch's verify stands: "verifying v41", "verify v41 passed", "verify queued (vq12, 2 of 3)", or null. */
export function batchVerify(db: Db, batch: BatchRow): string | null {
  const request = batch.request_id ? getRequest(db, batch.request_id) : null;
  const v = request?.verification_id ? getVerification(db, request.verification_id) : batch.verification_id ? getVerification(db, batch.verification_id) : null;
  if (v) return v.state === "running" ? `verifying ${v.id}` : `verify ${v.id} ${v.state}`;
  if (request?.state === "queued") {
    const place = positionOf(db, request.id);
    return `verify queued, waiting for a slot (${request.id}${place ? `, ${place.position} of ${place.of}` : ""})`;
  }
  return null;
}

/** Where a verifying batch stands: its retry's wait (its detail, while `retry_at` is set), else its verify. */
export function verifyingStage(db: Db, batch: BatchRow): string {
  if (batch.retry_at !== null) return batch.detail ?? "waiting to retry its verify";
  return batchVerify(db, batch) ?? "verifying";
}

/** A batch in a line: "lb3 verifying v41, 3 branches on main 1a2b3c4d", "lb3 held: ...". */
export function batchLine(db: Db, batch: BatchRow): string {
  const members = batchMembers(db, batch.id);
  const what = `${members.length} branch${members.length === 1 ? "" : "es"} on main ${batch.base_sha.slice(0, 8)}`;
  if (batch.state === "held") return `${batch.id} held, ${what}: ${batch.detail ?? batch.reason ?? "-"}`;
  if (batch.state === "landing") return `${batch.id} landing, ${what}${batch.detail ? `: ${batch.detail}` : ""}`;
  if (batch.state === "verifying") return `${batch.id} ${verifyingStage(db, batch)}, ${what}`;
  return `${batch.id} ${batch.state}${batch.reason ? ` (${batch.reason})` : ""}${batch.detail ? `: ${batch.detail}` : ""}`;
}
