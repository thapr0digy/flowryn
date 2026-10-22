import type { Db } from "../db/db.ts";
import { getMeta, setMeta } from "../db/db.ts";
import { appendEvent, type EventSource } from "../db/events.ts";

/**
 * The verify queue (migration 28, docs/notes/2026-10-22-daemon-run-verify-y3.md).
 * Every `flowryn verify` is a request: it starts at once when a validation slot
 * is free and nothing waits ahead of it, or waits here, FIFO within its rank
 * (a verification the last daemon was running when it stopped is requeued at
 * rank -1, ahead of the rest). The scheduler's pass starts queued requests
 * (src/verify/start.ts). Every write goes with its event, inside the caller's
 * transaction.
 */

export type RequestSource = "cli" | "auto" | "recovered";
export type RequestState = "queued" | "started" | "cancelled";

export interface VerifyRequest {
  id: string;
  project_id: string;
  /** The canonical PR URL, or local:<branch>. */
  pr_url: string;
  task_id: string | null;
  head_sha: string;
  /** The verify policy the request was made under; a start runs today's. */
  policy_id: string;
  /** The PR's number and head branch (fetched by them); null for local-only work. */
  pr_number: number | null;
  head_ref: string | null;
  /** Local-only work: the worktree whose HEAD is the head verified. */
  worktree: string | null;
  source: RequestSource;
  /** The PATH the steps run with (the caller's); null: the daemon's. */
  path: string | null;
  rank: number;
  state: RequestState;
  verification_id: string | null;
  /** The interrupted verification a recovered request runs again. */
  recovered_from: string | null;
  /** Why a request was cancelled. */
  detail: string | null;
  requested_at: number;
  ended_at: number | null;
}

export interface NewRequest {
  project_id: string;
  pr_url: string;
  task_id: string | null;
  head_sha: string;
  policy_id: string;
  pr_number: number | null;
  head_ref: string | null;
  worktree: string | null;
  source: RequestSource;
  path: string | null;
  rank?: number;
  recovered_from?: string | null;
  now: number;
}

/** Recovered requests go ahead of everything queued (src/verify/runner.ts recoverVerifications). */
export const RECOVERED_RANK = -1;

const ORDER = "rank, requested_at, CAST(substr(id, 3) AS INTEGER)";

function eventSource(source: RequestSource): EventSource {
  return source === "cli" ? "cli" : "daemon";
}

export function getRequest(db: Db, id: string): VerifyRequest | null {
  return db.query("SELECT * FROM verify_queue WHERE id = ?1").get(id) as VerifyRequest | null;
}

/** The queued requests, in the order they start. */
export function queuedRequests(db: Db): VerifyRequest[] {
  return db.query(`SELECT * FROM verify_queue WHERE state = 'queued' ORDER BY ${ORDER}`).all() as VerifyRequest[];
}

/** A queued request for exactly this PR, head and policy, which a new one joins instead of queueing twice. */
export function findQueued(db: Db, prUrl: string, head: string, policy: string): VerifyRequest | null {
  return db.query(`SELECT * FROM verify_queue WHERE state = 'queued' AND pr_url = ?1 AND head_sha = ?2 AND policy_id = ?3 ORDER BY ${ORDER} LIMIT 1`).get(prUrl, head, policy) as VerifyRequest | null;
}

/** The request a verification was started from, not one that followed it later, if any (verifications from before migration 28 have none). */
export function requestOf(db: Db, verificationId: string): VerifyRequest | null {
  return db.query(`SELECT * FROM verify_queue WHERE verification_id = ?1 AND state = 'started' ORDER BY ended_at, ${ORDER} LIMIT 1`).get(verificationId) as VerifyRequest | null;
}

/** The request that runs an interrupted verification again, if one was made. */
export function requeuedFrom(db: Db, verificationId: string): VerifyRequest | null {
  return db.query("SELECT * FROM verify_queue WHERE recovered_from = ?1 LIMIT 1").get(verificationId) as VerifyRequest | null;
}

/** 1-based place in the queue, and the requests ahead of it; null once it is not queued. */
export function positionOf(db: Db, id: string): { position: number; of: number; ahead: string[] } | null {
  const queued = queuedRequests(db);
  const at = queued.findIndex((r) => r.id === id);
  if (at < 0) return null;
  return { position: at + 1, of: queued.length, ahead: queued.slice(0, at).map((r) => r.id) };
}

/** Insert a queued request with its `verify.queued` event. Call inside a transaction. */
export function insertRequest(db: Db, r: NewRequest): VerifyRequest {
  const next = Number(getMeta(db, "next_verify_request_no") ?? "1");
  setMeta(db, "next_verify_request_no", String(next + 1));
  const id = `vq${next}`;
  db.query(
    `INSERT INTO verify_queue (id, project_id, pr_url, task_id, head_sha, policy_id, pr_number, head_ref, worktree, source, path, rank, state, recovered_from, requested_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'queued', ?13, ?14)`,
  ).run(id, r.project_id, r.pr_url, r.task_id, r.head_sha, r.policy_id, r.pr_number, r.head_ref, r.worktree, r.source, r.path, r.rank ?? 0, r.recovered_from ?? null, r.now);
  appendEvent(db, {
    source: eventSource(r.source),
    kind: "verify.queued",
    taskId: r.task_id,
    payload: { request: id, project: r.project_id, pr: r.pr_url, head: r.head_sha, policy: r.policy_id, source: r.source, rank: r.rank ?? 0, recovered_from: r.recovered_from ?? null },
    ts: r.now,
  });
  return getRequest(db, id)!;
}

/** The request started as this verification. Call inside a transaction; false when it was no longer queued. */
export function markStarted(db: Db, request: VerifyRequest, verificationId: string, now: number): boolean {
  const changed = db.query("UPDATE verify_queue SET state = 'started', verification_id = ?2, ended_at = ?3 WHERE id = ?1 AND state = 'queued'").run(request.id, verificationId, now).changes;
  if (changed === 0) return false;
  appendEvent(db, { source: "daemon", kind: "verify.dequeued", taskId: request.task_id, payload: { request: request.id, verification: verificationId, waited_ms: now - request.requested_at }, ts: now });
  return true;
}

/** Cancel a queued request, saying why. Call inside a transaction; false when it was no longer queued. */
export function cancelRequest(db: Db, request: VerifyRequest, reason: string, now: number): boolean {
  const changed = db.query("UPDATE verify_queue SET state = 'cancelled', detail = ?2, ended_at = ?3 WHERE id = ?1 AND state = 'queued'").run(request.id, reason, now).changes;
  if (changed === 0) return false;
  appendEvent(db, { source: "daemon", kind: "verify.cancelled", taskId: request.task_id, payload: { request: request.id, pr: request.pr_url, head: request.head_sha, reason }, ts: now });
  return true;
}
