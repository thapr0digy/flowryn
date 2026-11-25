import { existsSync } from "node:fs";
import { findOpenRunItem, openItem } from "../attention/items.ts";
import type { FlowrynConfig } from "../config/config.ts";
import { getMeta, setMeta, tx, type Db } from "../db/db.ts";
import { appendEvent, type EventSource } from "../db/events.ts";
import { approvalRef, carryLanding, deliveredOf, prEvidence, type Delivered } from "../lifecycle/delivery.ts";
import { getProject, type ProjectRow } from "../lifecycle/projects.ts";
import { getRunWithPolicy, isTerminal, runBase, taskTitle, type RunWithPolicy } from "../lifecycle/runs.ts";
import { sendBack } from "../lifecycle/send-back.ts";
import { findHumanApproval, insertApproval, isRoutineMerge, type ApprovalRow } from "../policy/approvals.ts";
import { autonomyForRun, mintAutonomyApproval } from "../policy/autonomy.ts";
import { findAwayApproval } from "../attention/away-merge.ts";
import { cleanMainMerge, type CleanMergeStep } from "../policy/clean-merge.ts";
import type { GitRunner } from "../policy/landed.ts";
import { sendConflictBack, settleHeadMove } from "../reconcile/delivery.ts";
import { sanitizeLine } from "../util/sanitize.ts";
import { createAutoMerge, getAutoMerge, HOLD_RELEASED, setReadyProgress, supersedeAutoMerge, type AutoMergeRow, type LandingHooks } from "./auto-merge.ts";
import { landingBatched, landingQueued, landingTrainDepth, LOCAL_TURN_WAIT_MS, MAX_INTEGRATIONS, MAX_SKIPPED_TURNS, verifyConfig } from "./config.ts";
import { mergeInStore } from "./object-merge.ts";
import { verifyPolicyId } from "./policy.ts";
import { LIVE_BATCH_SQL, liveBatch as liveBatchOf, markBatching, projectBatches } from "./batch-store.ts";
import { batchCell, batchProgress, LandingBatches, type LineOps } from "./landing-batch.ts";
import type { DeliveryServices } from "../policy/services.ts";
import type { HostVerdict } from "../sched/host.ts";
import { autoVerifyPath, cancelRequest, findQueued, getRequest, insertRequest, rerankRequest } from "./queue.ts";
import { routeVerifyOutcome, SENT_BACK_KIND, sendBackText, sentBackPayload } from "./route.ts";
import { finishedAtHead, getVerification, interruptedByStop, verifyStatus, type Verification } from "./store.ts";

/**
 * The landing queue (docs/notes/2026-10-30-landing-queue-the-65.md): on a
 * project with `[projects.<id>] landing = "queue"`, the daemon lands approved
 * and routine PRs one at a time. Plain code: git, the verify queue and the
 * auto-merge state machine (src/verify/auto-merge.ts), no model.
 *
 *   waiting → landing (an auto_merges row at the integrated head) → landed
 *                                                          ↘ left (with a reason)
 *
 * A ready PR joins its project's line when its work is routine (yolo, not
 * sensitive) or a human approved its merge (the merge verb on a queue
 * project, or `flowryn approve`). The first entry that can go is brought up
 * to date: the run's base is merged into its worktree with a plain merge
 * commit and pushed (never a rebase, never forced), the delivery is carried
 * to the new head and its verify queued; then an auto-merge row verifies,
 * waits on checks and merges, as on an auto_merge project. A merge that
 * conflicts is undone and the ship sent back as the watcher's conflict nudge
 * sends it. A base that moves again before the merge sends the entry back to
 * integrate (MAX_INTEGRATIONS times at most). One entry per project lands at a
 * time.
 *
 * The train (docs/notes/2026-11-07-faster-landing-test-q7.md): while the head
 * of line verifies, up to `landing_train_depth - 1` entries behind it verify
 * ahead of their turn, each on a candidate built with git plumbing (never in
 * the worktree, never pushed): the entry's delivered head merged with the head
 * of the entry ahead (train_base). Its verify request waits behind every other
 * one (TRAIN_RANK), so it takes only a free validation slot. When the entry
 * ahead lands, the candidate is promoted, pushed as a fast-forward and landed
 * on its pass, only if git proves main holds exactly its base and merging it
 * into main writes exactly the tree that was verified (trainBaseHolds). A base
 * that changed (the entry ahead left, was sent back, merged again) drops the
 * candidate; the entry is built again on its new base, or integrated as before.
 *
 * A local-only project (docs/notes/2026-11-15-local-only-auto-x9.md) queues by
 * default when it has verify steps, and every entry lands at a candidate: the
 * head of line's is built on local main's tip, each car's on the candidate
 * ahead, all in the object store and verified in the verify runner's own
 * worktree (no fetch, no push). A candidate that already holds its base is the
 * delivered head itself. The entry whose candidate is on main's tip starts
 * landing: its worktree is fast-forwarded to the candidate (only when the
 * worker is idle and the checkout clean and at the delivered head) and the
 * delivery carried; its auto-merge follows the candidate's verify and fast-
 * forwards main to it. A conflict with main goes back to the worker naming the
 * paths; a car whose candidate failed goes back with that log once main is its
 * base. An entry whose worker is not ready is waited on LOCAL_TURN_WAIT_MS,
 * then the entries behind it go ahead (it keeps its place); at its
 * MAX_SKIPPED_TURNS-th skipped turn it is held.
 */

export const LANDING_STATES = ["waiting", "landing", "landed", "left"] as const;
export type LandingState = (typeof LANDING_STATES)[number];
const LIVE_SQL = "state IN ('waiting','landing')";

/** Times one entry (or a landing batch) is brought up to date with its base before it is held: the base keeps moving under it. */
export { MAX_INTEGRATIONS };
/** A landing fetch or push: the network, not a local read, so longer than the merge proof's git calls. */
export const LANDING_NET_TIMEOUT_MS = 120_000;
/** How long the head of line may wait on a busy worker or a changed worktree before it is held. */
export const BLOCKED_HOLD_MS = 30 * 60_000;
/** The landing merge's message, so `git log` says who made it. */
export function landingMergeMessage(base: string, branch: string): string {
  return `Merge origin/${base} into ${branch} (Flowryn landing queue)`;
}
/** A train candidate's message: the head it builds on, which lands before it. */
export function trainMergeMessage(base: string, branch: string): string {
  return `Merge ${base.slice(0, 8)}, the PR ahead in the landing train, into ${branch}`;
}
/** A local-only candidate's message: the commit of the base it merges in, and whether that is main's tip or the entry ahead's candidate. */
export function localMergeMessage(base: string, branch: string, onto: { main: string } | null): string {
  return onto ? `Merge ${onto.main} at ${base.slice(0, 8)} into ${branch} (Flowryn merge queue)` : `Merge ${base.slice(0, 8)}, the branch ahead in the merge queue, into ${branch}`;
}
/** A candidate's verify waits behind every other request (rank 0, recovered -1): it runs only on a free slot. */
export const TRAIN_RANK = 1;
/** Rounds of one local-only line per pass: an entry that leaves (a conflict, a send-back) lets the next go at once. */
const MAX_LOCAL_ROUNDS = 4;

export interface LandingRow {
  id: string;
  project_id: string;
  run_id: string;
  task_id: string;
  ref: string;
  entered_head: string;
  head_sha: string;
  approval_id: string | null;
  state: LandingState;
  auto_merge_id: string | null;
  integrations: number;
  reason: string | null;
  detail: string | null;
  blocked_since: number | null;
  enqueued_at: number;
  state_since: number;
  updated_at: number;
  /** A waiting entry's speculative candidate (migration 57); a landing entry promoted from one keeps it. */
  train_head: string | null;
  /** The head the candidate builds on: the entry ahead's, which must land first. */
  train_base: string | null;
  /** The candidate's verify request. */
  train_request: string | null;
  /** A batch project's entry: the landing batch it is in (migration 64; kept once it left or landed), and its place there. */
  batch_id: string | null;
  batch_pos: number | null;
}

export function getLanding(db: Db, id: string): LandingRow | null {
  return db.query("SELECT * FROM landing_queue WHERE id = ?1").get(id) as LandingRow | null;
}

/** The run's live entry, if any (at most one). */
export function liveLanding(db: Db, runId: string): LandingRow | null {
  return db.query(`SELECT * FROM landing_queue WHERE run_id = ?1 AND ${LIVE_SQL}`).get(runId) as LandingRow | null;
}

/** The run's newest entry, any state, for `show`. */
export function latestLanding(db: Db, runId: string): LandingRow | null {
  return db.query("SELECT * FROM landing_queue WHERE run_id = ?1 ORDER BY enqueued_at DESC, CAST(substr(id, 3) AS INTEGER) DESC LIMIT 1").get(runId) as LandingRow | null;
}

/** A project's line in order: the entry landing first, then the waiting ones by arrival. */
export function projectLine(db: Db, projectId: string): LandingRow[] {
  return db
    .query(`SELECT * FROM landing_queue WHERE project_id = ?1 AND ${LIVE_SQL} ORDER BY state = 'waiting', enqueued_at, CAST(substr(id, 3) AS INTEGER)`)
    .all(projectId) as LandingRow[];
}

function liveLandings(db: Db): LandingRow[] {
  return db.query(`SELECT * FROM landing_queue WHERE ${LIVE_SQL} ORDER BY enqueued_at, CAST(substr(id, 3) AS INTEGER)`).all() as LandingRow[];
}

/** An entry's place in its project's line: "2 of 3", and the task ahead of it. */
export function placeOf(db: Db, row: LandingRow): { position: number; of: number; ahead: string | null } | null {
  const line = projectLine(db, row.project_id);
  const index = line.findIndex((r) => r.id === row.id);
  if (index < 0) return null;
  return { position: index + 1, of: line.length, ahead: index > 0 ? line[index - 1]!.task_id : null };
}

function isLocal(row: Pick<LandingRow, "ref">): boolean {
  return row.ref.startsWith("local:");
}

/** Where a candidate's verify stands: "verifying v41", "verify v41 passed", "verify queued (vr12)", or null without one. */
function candidateVerify(db: Db, row: LandingRow): string | null {
  const request = row.train_request ? getRequest(db, row.train_request) : null;
  if (!request) return null;
  const v = request.verification_id ? getVerification(db, request.verification_id) : null;
  if (v) return verifyStatus(v);
  return request.state === "queued" ? `verify queued (${request.id})` : null;
}

/** Turns a local-only entry was passed over while its worker was not ready. */
function skippedTurns(db: Db, row: LandingRow): number {
  return (db.query("SELECT COUNT(*) AS n FROM events WHERE run_id = ?2 AND kind = 'landing.turn_skipped' AND json_extract(payload, '$.landing') = ?1").get(row.id, row.run_id) as { n: number }).n;
}

/**
 * A local-only entry that waited on its worker loses its turn to `by`, which
 * starts landing ahead of it, with one landing.turn_skipped event; at its
 * MAX_SKIPPED_TURNS-th it leaves the line, held for the leader. Call inside a transaction.
 */
function skipTurn(db: Db, row: LandingRow, by: LandingRow, now: number): void {
  const skipped = skippedTurns(db, row) + 1;
  const why = row.detail ?? "its worker was not ready";
  appendEvent(db, { source: "daemon", kind: "landing.turn_skipped", runId: row.run_id, taskId: row.task_id, payload: { landing: row.id, by: by.id, by_task: by.task_id, skipped, of: MAX_SKIPPED_TURNS, why }, ts: now });
  if (skipped >= MAX_SKIPPED_TURNS) leave(db, row, "turns_skipped", `passed over ${skipped} times while its worker was not ready (${why})`, now, { next: `flowryn show ${row.task_id}` });
}

/**
 * Whether an entry is a batch project's (docs/notes/2026-11-21-landing-batches-one-27.md): in a
 * batch, or its project lands in batches now (as its last pass found it), so the views need no config.
 */
function batchEntry(db: Db, row: LandingRow): boolean {
  return row.batch_id !== null || projectBatches(db, row.project_id);
}

/** What `show`, `fleet` and the pr_ready line say of an entry. */
export function landingProgress(db: Db, row: LandingRow): string {
  if (row.state !== "landed" && row.state !== "left" && batchEntry(db, row) && !(row.state === "landing" && row.batch_id === null)) return batchProgress(db, row);
  const verify = isLocal(row) ? candidateVerify(db, row) : null;
  if (row.state === "landing") return `landing queue: first in line${isLocal(row) && row.detail ? `, ${row.detail}` : ""}${verify ? `, ${verify}` : ""} (${row.id})`;
  if (row.state === "waiting") {
    const place = placeOf(db, row);
    const where = place ? `${place.position} of ${place.of}${place.ahead ? `, behind ${place.ahead}` : ""}` : "waiting";
    if (!isLocal(row)) return `landing queue: ${where}${row.train_head ? `, verifying ahead at ${row.train_head.slice(0, 8)}` : ""} (${row.id})`;
    const candidate = row.train_head && row.train_base ? `, candidate ${row.train_head.slice(0, 8)} on ${row.train_base.slice(0, 8)}${verify ? `, ${verify}` : ""}` : "";
    const skipped = skippedTurns(db, row);
    const blocked = row.blocked_since !== null ? `, waiting on its worker (${row.detail ?? "not ready"})` : "";
    return `landing queue: ${where}${candidate}${blocked}${skipped > 0 ? `, passed over ${skipped} of ${MAX_SKIPPED_TURNS}` : ""} (${row.id})`;
  }
  return `landing queue ${row.state}${row.reason ? ` (${row.reason})` : ""}${row.detail ? `: ${row.detail}` : ""}`;
}

/** The fleet's needs cell for a run in a line: its place, and for a local-only entry its candidate's verify. */
export function landingCell(db: Db, row: LandingRow): string {
  if (batchEntry(db, row) && !(row.state === "landing" && row.batch_id === null)) return batchCell(db, row);
  if (row.state === "landing") return `landing${isLocal(row) ? ` ${candidateVerify(db, row) ?? ""}`.trimEnd() : ""}`;
  const place = placeOf(db, row);
  const verify = isLocal(row) && row.train_base ? candidateVerify(db, row) : null;
  const on = verify && row.train_base ? ` ${verify} on ${row.train_base.slice(0, 8)}` : "";
  return `queue ${place ? `${place.position}/${place.of}` : "-"}${on}${row.blocked_since !== null ? " worker not ready" : ""}`;
}

interface MoveFields {
  head_sha?: string;
  approval_id?: string | null;
  auto_merge_id?: string | null;
  integrations?: number;
  reason?: string | null;
  detail?: string | null;
  blocked_since?: number | null;
  train_head?: string | null;
  train_base?: string | null;
  train_request?: string | null;
  batch_id?: string | null;
  batch_pos?: number | null;
}

/** Move an entry to `to` with its `landing.<to>` event. Call inside a transaction. */
function move(db: Db, row: LandingRow, to: LandingState, fields: MoveFields, now: number, source: EventSource = "daemon"): { row: LandingRow; seq: number } {
  const next: LandingRow = { ...row, ...fields, state: to, state_since: to === row.state ? row.state_since : now, updated_at: now };
  db.query(
    `UPDATE landing_queue SET state = ?2, head_sha = ?3, approval_id = ?4, auto_merge_id = ?5, integrations = ?6, reason = ?7, detail = ?8, blocked_since = ?9, state_since = ?10, updated_at = ?11,
       train_head = ?12, train_base = ?13, train_request = ?14, batch_id = ?15, batch_pos = ?16 WHERE id = ?1`,
  ).run(row.id, to, next.head_sha, next.approval_id, next.auto_merge_id, next.integrations, next.reason, next.detail, next.blocked_since, next.state_since, now, next.train_head, next.train_base, next.train_request, next.batch_id, next.batch_pos);
  const event = appendEvent(db, {
    source,
    kind: `landing.${to}`,
    runId: row.run_id,
    taskId: row.task_id,
    payload: {
      landing: row.id,
      from: row.state,
      head: next.head_sha,
      approval: next.approval_id,
      auto_merge: next.auto_merge_id,
      integrations: next.integrations,
      reason: next.reason,
      detail: next.detail,
      train_head: next.train_head,
      train_base: next.train_base,
      ...(next.batch_id || row.batch_id ? { batch: next.batch_id, batch_pos: next.batch_pos } : {}),
    },
    ts: now,
  });
  return { row: next, seq: event.seq };
}

/** Rewrite the pr_ready line of every waiting entry of a project: their places moved. Call inside a transaction. */
function refreshLine(db: Db, projectId: string): void {
  for (const row of projectLine(db, projectId)) if (row.state === "waiting") setReadyProgress(db, row.run_id, landingProgress(db, row));
}

/**
 * Let go of an entry's train candidate: its queued verify is cancelled (one
 * already running ends on its own; nothing follows it), with one
 * landing.train_dropped event. Call inside a transaction; returns the row as it is now.
 */
function dropCandidate(db: Db, row: LandingRow, why: string, now: number): LandingRow {
  if (!row.train_head) return row;
  const request = row.train_request ? getRequest(db, row.train_request) : null;
  if (request) cancelRequest(db, request, `the landing train dropped ${row.train_head.slice(0, 8)}: ${why}`, now);
  db.query("UPDATE landing_queue SET train_head = NULL, train_base = NULL, train_request = NULL, updated_at = ?2 WHERE id = ?1").run(row.id, now);
  appendEvent(db, { source: "daemon", kind: "landing.train_dropped", runId: row.run_id, taskId: row.task_id, payload: { landing: row.id, head: row.train_head, base: row.train_base, request: row.train_request, why }, ts: now });
  return { ...row, train_head: null, train_base: null, train_request: null, updated_at: now };
}

/**
 * Put a delivered PR in its project's line, at the back. A live entry of the
 * run that is at another head leaves first (redelivered); one at this head
 * stays, taking `approvalId` if it had none. Call inside a transaction.
 */
export function enqueueLanding(db: Db, run: RunWithPolicy, delivered: Delivered, approvalId: string | null, now: number, source: EventSource = "daemon"): LandingRow {
  const live = liveLanding(db, run.id);
  if (live && live.head_sha === delivered.head) {
    if (approvalId && live.approval_id !== approvalId) return move(db, live, live.state, { approval_id: approvalId }, now, source).row;
    return live;
  }
  if (live) leave(db, live, "redelivered", `delivered again at ${delivered.head.slice(0, 8)}`, now);
  const next = Number(getMeta(db, "next_landing_no") ?? "1");
  setMeta(db, "next_landing_no", String(next + 1));
  const id = `lq${next}`;
  // What verifications and approvals bind to: the PR URL, or local:<branch>.
  const ref = approvalRef(delivered);
  db.query(
    `INSERT INTO landing_queue (id, project_id, run_id, task_id, ref, entered_head, head_sha, approval_id, state, enqueued_at, state_since, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, 'waiting', ?8, ?8, ?8)`,
  ).run(id, run.project_id, run.id, run.task_id, ref, delivered.head, approvalId, now);
  const row = getLanding(db, id)!;
  const place = placeOf(db, row);
  appendEvent(db, { source, kind: "landing.queued", runId: run.id, taskId: run.task_id, payload: { landing: id, ref, head: delivered.head, approval: approvalId, position: place?.position ?? null, of: place?.of ?? null }, ts: now });
  refreshLine(db, run.project_id);
  return row;
}

/**
 * The entry leaves the line. A hold (the queue cannot go on without you)
 * opens auto_merge_held, as a held auto-merge does. Call inside a transaction.
 */
function leave(db: Db, row: LandingRow, reason: string, detail: string, now: number, hold?: { next: string }): LandingRow {
  const left = move(db, row.state === "waiting" ? dropCandidate(db, row, `it left the line (${reason})`, now) : row, "left", { reason, detail, blocked_since: null }, now);
  if (row.auto_merge_id) supersedeAutoMerge(db, row.run_id, "landing_left", `the landing queue let it go: ${reason}`, now);
  if (hold && !findOpenRunItem(db, "auto_merge_held", row.run_id)) {
    openItem(db, { kind: "auto_merge_held", eventSeq: left.seq, taskId: row.task_id, runId: row.run_id, line: `Landing held: ${taskTitle(db, row.task_id)} (${row.task_id}): ${sanitizeLine(detail, 120)}; ${hold.next}`, now });
  }
  setReadyProgress(db, row.run_id, null);
  refreshLine(db, row.project_id);
  return left.row;
}

/**
 * A sensitive PR whose entry left at this head for want of an approval (the queue's merge of main
 * moved its head, or you came back) is taken again once a newer away-validator approval binds the
 * head: that approval is exactly what it lacked.
 */
function retakeForAwayApproval(db: Db, run: RunWithPolicy, delivered: Delivered, now: number): boolean {
  if (!run.sensitive) return false;
  const approval = findAwayApproval(db, { task: run.task_id, ref: approvalRef(delivered), head: delivered.head, now });
  if (!approval) return false;
  const other = db
    .query("SELECT 1 FROM landing_queue WHERE run_id = ?1 AND (head_sha = ?2 OR entered_head = ?2) AND NOT (state = 'left' AND reason IN ('approval_needed','user_back') AND state_since <= ?3)")
    .get(run.id, delivered.head, approval.created_at);
  return other === null;
}

/** An entry leaves the line (src/attention/away-merge.ts: the user came back, or the validator sent it back). Call inside a transaction. */
export const leaveLanding = leave;

/**
 * Whether a delivery of this run belongs to the landing queue rather than to
 * a direct auto-merge: its project queues, it is a PR on the project's
 * default branch, and it is not stacked. On a queue project a delivery never
 * starts an auto-merge of its own (it would land out of turn); the queue's
 * pass picks it up. A live entry at another head leaves (redelivered), and so
 * does a live row. Call inside the delivery's transaction.
 */
export function deliveredToQueue(db: Db, config: FlowrynConfig, run: RunWithPolicy, head: string, now: number): boolean {
  if (!landingQueued(config, run.project_id, run.delivery_mode)) return false;
  supersedeAutoMerge(db, run.id, "redelivered", `delivered again at ${head.slice(0, 8)}`, now, "cli");
  const live = liveLanding(db, run.id);
  // The watcher carried the delivery across the queue's own push, between it and the queue's carry: the entry is landing it.
  const carriedFromEntry = live?.state === "waiting" && deliveredOf(db, run.task_id)?.carriedFrom === live.head_sha;
  if (live && live.head_sha !== head && !carriedFromEntry) leave(db, live, "redelivered", `delivered again at ${head.slice(0, 8)}`, now);
  return true;
}

/** The entry leaves the line for a conflict with `base`, and its ship is sent back as the conflict nudge sends it. Returns whether it left. */
function sendConflict(deps: Pick<LandingQueueDeps, "db" | "now" | "kickScheduler">, row: LandingRow, run: RunWithPolicy, delivered: Delivered, base: string, files: string[]): boolean {
  const { db } = deps;
  const where = delivered.kind === "pr" ? `origin/${base}` : base;
  const outcome = tx(db, () => {
    const fresh = getLanding(db, row.id);
    const current = getRunWithPolicy(db, run.id);
    if (!fresh || fresh.state !== "waiting" || !current || current.state !== "ready") return null;
    const now = deps.now();
    leave(db, fresh, "conflict", `merging ${where} conflicts in ${files.length} file(s): ${files.slice(0, 5).join(", ")}`, now);
    return sendConflictBack(db, current, delivered, { url: delivered.kind === "pr" ? delivered.ref : approvalRef(delivered), base, head: delivered.head, files, source: "daemon" }, taskTitle(db, current.task_id), now);
  });
  if (outcome) deps.kickScheduler();
  return outcome !== null;
}

/** The line's own moves, for landing batches (src/verify/landing-batch.ts): an entry's state and events stay here. */
export function lineOps(deps: Pick<LandingQueueDeps, "db" | "now" | "kickScheduler">): LineOps {
  const { db } = deps;
  return {
    move: (row, to, fields, now, source) => move(db, row, to, fields, now, source).row,
    leave: (row, reason, detail, now, hold) => leave(db, row, reason, detail, now, hold),
    sendConflict: (row, run, delivered, base, files) => sendConflict(deps, row, run, delivered, base, files),
    refreshLine: (projectId) => refreshLine(db, projectId),
  };
}

/** Whether the run can join a line: a ready ship's PR (local-only: its branch) on its project's default branch, not stacked. */
function canQueue(db: Db, run: RunWithPolicy, delivered: Delivered | null): delivered is Delivered {
  if (run.kind !== "ship" || run.state !== "ready" || run.stacked_on || !delivered) return false;
  const project = getProject(db, run.project_id);
  if (!project || runBase(run, project) !== project.default_branch) return false;
  return delivered.kind === (project.delivery_mode === "local-only" ? "local" : "pr");
}

/** Whether the queue may take the run's delivered PR at all (for the merge verb's refusal). */
export function queueable(db: Db, run: RunWithPolicy): boolean {
  return canQueue(db, run, deliveredOf(db, run.task_id));
}

export interface LandingQueueDeps {
  db: Db;
  config(): FlowrynConfig;
  git: GitRunner;
  /** A fetch and a push, with a deadline long enough for the network. */
  netGit: GitRunner;
  now(): number;
  log(message: string): void;
  /** A ship sent back for a conflict waits for a grant, and a train candidate's verify for a slot: the scheduler looks now. */
  kickScheduler(): void;
  /** The merge verb's services, with which a green landing batch lands (src/verify/landing-batch.ts). */
  delivery?: DeliveryServices;
  /** The scheduler's host check: a red landing batch judged while the host is over its load limit is retried. */
  host?(): Promise<HostVerdict>;
}

type HeadOutcome = "started" | "blocked" | "left";
/** A local-only entry's turn: as HeadOutcome, or `passed` when its worker kept it waiting LOCAL_TURN_WAIT_MS and the ones behind may go. */
type TurnOutcome = HeadOutcome | "passed";
/** A candidate built (its head), a merge that conflicts (the paths git named), or nothing (git failed, or the entry moved on). */
type Built = { head: string } | { conflict: string[] } | null;

/**
 * The queue's controller: the AutoMerger calls pass() around its own pass and
 * beforeMerge() before each merge, so every kick that moves an auto-merge
 * (a verify drain, a watcher pass, the 60 s tick) moves the line too.
 */
export class LandingQueue implements LandingHooks {
  private readonly deps: LandingQueueDeps;
  readonly batches: LandingBatches;

  constructor(deps: LandingQueueDeps) {
    this.deps = deps;
    this.batches = new LandingBatches({ db: deps.db, config: deps.config, git: deps.git, now: deps.now, log: deps.log, kickScheduler: deps.kickScheduler, delivery: deps.delivery, host: deps.host }, lineOps(deps));
  }

  async pass(): Promise<void> {
    const { db } = this.deps;
    tx(db, () => {
      const now = this.deps.now();
      for (const row of liveLandings(db)) this.settle(row, now);
      this.enqueueReady(now);
    });
    const projects = new Set([...liveLandings(db).map((r) => r.project_id), ...(db.query(`SELECT project_id FROM landing_batches WHERE ${LIVE_BATCH_SQL}`).all() as { project_id: string }[]).map((r) => r.project_id)]);
    for (const projectId of projects) {
      try {
        await this.advanceProject(projectId);
      } catch (error) {
        this.deps.log(`landing queue ${projectId}: ${(error as Error).stack ?? String(error)}`);
      }
    }
  }

  /** End an entry its run, its auto-merge or its project no longer keeps in line. Call inside a transaction. */
  private settle(row: LandingRow, now: number): void {
    const { db } = this.deps;
    const run = getRunWithPolicy(db, row.run_id);
    if (!run) return void leave(db, row, "gone", "the run is gone", now);
    if (run.state === "landed" || run.state === "cleaned") {
      move(db, row, "landed", { blocked_since: null }, now);
      return refreshLine(db, row.project_id);
    }
    if (isTerminal(run.state)) return void leave(db, row, run.state, `the run is ${run.state}`, now);
    if (!landingQueued(this.deps.config(), row.project_id, run.delivery_mode)) return void leave(db, row, "landing_off", `project ${row.project_id} no longer queues its landings`, now);
    // A merge asked for by hand, or the queue's own merge in flight: wait for its proof.
    if (run.state === "merging") return;
    if (run.state !== "ready") return void leave(db, row, "sent_back", `the run is ${run.state}`, now);
    const delivered = deliveredOf(db, run.task_id);
    if (delivered && delivered.head !== row.head_sha && row.state === "waiting" && delivered.carriedFrom === row.head_sha) {
      move(db, dropCandidate(db, row, `its head was carried to ${delivered.head.slice(0, 8)}`, now), "waiting", { head_sha: delivered.head, detail: `carried to ${delivered.head.slice(0, 8)}` }, now);
      return;
    }
    if (!delivered || delivered.head !== row.head_sha) return void leave(db, row, "redelivered", `delivered again at ${delivered?.head.slice(0, 8) ?? "-"}`, now);
    if (row.state !== "landing") return;
    // A landing batch's member: its batch lands it (src/verify/landing-batch.ts), with no auto-merge of its own.
    if (row.batch_id !== null) return;
    const auto = row.auto_merge_id ? getAutoMerge(db, row.auto_merge_id) : null;
    if (!auto) return void leave(db, row, "auto_merge_gone", `its auto-merge ${row.auto_merge_id ?? "-"} is gone`, now);
    if (auto.state === "merged") {
      move(db, row, "landed", {}, now);
      return refreshLine(db, row.project_id);
    }
    // A hold already opened auto_merge_held; a send-back steered the worker.
    if (auto.state === "held" || auto.state === "sent_back" || auto.state === "superseded") leave(db, row, auto.state === "held" ? `held:${auto.reason ?? "-"}` : auto.state, auto.detail ?? auto.state, now);
  }

  /** A ready PR on a queue project that is routine, or that you approved in your shell, joins the line once per head. Call inside a transaction. */
  private enqueueReady(now: number): void {
    const { db } = this.deps;
    const ready = db.query("SELECT r.id FROM runs r WHERE r.state = 'ready' AND NOT EXISTS (SELECT 1 FROM landing_queue l WHERE l.run_id = r.id AND l.state IN ('waiting','landing'))").all() as { id: string }[];
    for (const { id } of ready) {
      const run = getRunWithPolicy(db, id);
      if (!run || !landingQueued(this.deps.config(), run.project_id, run.delivery_mode)) continue;
      const delivered = deliveredOf(db, run.task_id);
      if (!canQueue(db, run, delivered)) continue;
      const ref = approvalRef(delivered);
      // Once per head: an entry that left at this head (held, conflicted) is not taken again until something changes,
      // such as a verify of the head passing after its hold (releaseHolds superseded its auto-merge as hold_released).
      const taken = db
        .query(
          `SELECT 1 FROM landing_queue l WHERE l.run_id = ?1 AND (l.head_sha = ?2 OR l.entered_head = ?2)
             AND NOT (l.state = 'left' AND EXISTS (SELECT 1 FROM auto_merges a WHERE a.id = l.auto_merge_id AND a.state = 'superseded' AND a.reason = ?3))`,
        )
        .get(run.id, delivered.head, HOLD_RELEASED);
      if (taken && !retakeForAwayApproval(db, run, delivered, now)) continue;
      // A merge already asked for, or a direct auto-merge from before the project queued: leave it be.
      // An auto-verify (merge = 0) is not one: the landing supersedes it and follows its verify.
      if (db.query("SELECT 1 FROM auto_merges WHERE run_id = ?1 AND merge = 1 AND state IN ('queued','verifying','waiting_checks','merging')").get(run.id)) continue;
      const routine = isRoutineMerge(db, run.task_id);
      let approval = routine ? null : findHumanApproval(db, { task: run.task_id, action: "merge", ref, head: delivered.head, now });
      // Sensitive work during an away you started: the validator's pass at exactly this head (src/attention/away-merge.ts).
      if (!routine && !approval && run.sensitive) approval = findAwayApproval(db, { task: run.task_id, ref, head: delivered.head, now });
      // Unattended mode: your standing approval for the project stands in for your word at this head.
      const standing = routine || approval ? null : autonomyForRun(db, run, now);
      if (standing) approval = mintAutonomyApproval(db, standing, { task: run.task_id, ref, head: delivered.head, action: "merge", runId: run.id }, now);
      if (!routine && !approval) continue;
      enqueueLanding(db, run, delivered, approval?.id ?? null, now);
    }
  }

  /** Bring the first entry that can go up to date and start its landing; the rest wait their turn. */
  private async advanceProject(projectId: string): Promise<void> {
    const project = getProject(this.deps.db, projectId);
    if (project?.delivery_mode === "local-only") {
      const batched = landingBatched(this.deps.config(), project.id, project.delivery_mode);
      tx(this.deps.db, () => markBatching(this.deps.db, project.id, batched, this.deps.now()));
      // Light checks run while a batch is in flight, so the next batch forms as soon as this one ends.
      const eligible = batched ? await this.batches.lightChecks(project, this.batchable(project.id)) : [];
      // A live batch is driven (or, once the project stops batching, dissolved) before anything else lands.
      if (await this.batches.drive(project)) return;
      if (batched) return this.advanceBatchProject(project, eligible);
      return this.advanceLocal(project);
    }
    const line = projectLine(this.deps.db, projectId);
    if (!line.some((r) => r.state === "landing")) {
      for (const row of line) {
        const outcome = row.train_head ? await this.promote(row) : await this.integrate(row);
        if (outcome === "started") break;
      }
    }
    await this.speculate(projectId);
  }

  /**
   * Build the train behind the head of line: each waiting entry within the
   * depth gets a candidate on the head ahead of it (the head of line's, then
   * the candidate ahead's), and its verify queued at TRAIN_RANK. A candidate
   * on the right base stays; one on another base is dropped and built again.
   * A merge that conflicts, or a candidate ahead whose verify failed, ends
   * the train there: what is behind waits its turn as before.
   */
  private async speculate(projectId: string): Promise<void> {
    const { db } = this.deps;
    const depth = landingTrainDepth(this.deps.config(), projectId, getProject(db, projectId)?.delivery_mode ?? null);
    const line = projectLine(db, projectId);
    const head = line.find((r) => r.state === "landing");
    if (!head) return;
    let base: string | null = head.head_sha;
    let built = 0;
    for (const [i, row] of line.filter((r) => r.state === "waiting").entries()) {
      if (base === null || i >= depth - 1) {
        const why = base === null ? "the train ends ahead of it" : `it is beyond the train's depth of ${depth}`;
        if (row.train_head) tx(db, () => dropCandidate(db, getLanding(db, row.id) ?? row, why, this.deps.now()));
        continue;
      }
      if (row.train_head && row.train_base === base) {
        base = this.candidateFailed(row) ? null : row.train_head;
        continue;
      }
      if (row.train_head) tx(db, () => dropCandidate(db, getLanding(db, row.id) ?? row, `its base moved from ${row.train_base?.slice(0, 8) ?? "-"} to ${base!.slice(0, 8)}`, this.deps.now()));
      const candidate = await this.buildCandidate(row, base, i + 2);
      base = candidate && "head" in candidate ? candidate.head : null;
      if (base) built++;
    }
    if (built > 0) this.deps.kickScheduler();
  }

  /** Whether the candidate's newest finished verify failed: the train goes no further behind it. */
  private candidateFailed(row: LandingRow): boolean {
    if (!todaysPolicy(this.deps.config(), row.project_id) || !row.train_head) return true;
    return this.failedCandidate(row) !== null;
  }

  /** The candidate's newest finished verify when it did not pass (a cut-off one aside), else null. */
  private failedCandidate(row: LandingRow): Verification | null {
    const policy = todaysPolicy(this.deps.config(), row.project_id);
    if (!policy || !row.train_head) return null;
    const finished = finishedAtHead(this.deps.db, row.ref, row.train_head, policy);
    return finished !== null && finished.state !== "passed" && !interruptedByStop(finished) ? finished : null;
  }

  /**
   * One candidate: git's own merge of the entry's delivered head and `base`
   * (merge-tree, then commit-tree with the delivered head as first parent),
   * in the project's object store, so its verify finds it; recorded on the
   * entry with its request and a landing.train_built event. A conflict
   * (recorded once per pair, with the paths git names) or a git failure
   * (logged, tried again on a later pass) builds none; the entry waits its
   * turn as before. `local`: a local-only line, whose head of line builds on
   * main's tip (`main`, its verify at rank 0) and whose entry that already
   * holds its base is its own candidate.
   */
  private async buildCandidate(row: LandingRow, base: string, position: number, local: { main: string } | null = null): Promise<Built> {
    const { db, git } = this.deps;
    const run = getRunWithPolicy(db, row.run_id);
    const project = run ? getProject(db, run.project_id) : null;
    const delivered = run ? deliveredOf(db, run.task_id) : null;
    if (!run || !project || run.state !== "ready" || delivered?.head !== row.head_sha) return null;
    const policy = todaysPolicy(this.deps.config(), row.project_id);
    if (!policy) return null;
    const onMain = local !== null && base === local.main;
    // A pair that would not merge is tried once, not on every pass; on main (a car's base that landed), a conflict sends the work back, so it is tried again.
    const skipped =
      !onMain &&
      db
        .query("SELECT 1 FROM events WHERE run_id = ?4 AND kind = 'landing.train_skipped' AND json_extract(payload, '$.landing') = ?1 AND json_extract(payload, '$.head') = ?2 AND json_extract(payload, '$.base') = ?3 LIMIT 1")
        .get(row.id, row.head_sha, base, row.run_id);
    if (skipped) return null;
    let sha: string;
    const holds = local ? await git(["merge-base", "--is-ancestor", base, row.head_sha], project.path) : null;
    if (holds && holds.code !== 0 && holds.code !== 1) {
      this.deps.log(`landing queue ${row.id}: git merge-base exited ${holds.code}: ${holds.stderr.trim()}`);
      return null;
    }
    if (holds?.code === 0) {
      sha = row.head_sha;
    } else {
      const message = local ? localMergeMessage(base, run.branch, onMain ? { main: project.default_branch } : null) : trainMergeMessage(base, run.branch);
      const merged = await mergeInStore(git, project.path, row.head_sha, base, message);
      if ("conflict" in merged) {
        const files = merged.conflict;
        const why = `merging ${base.slice(0, 8)} into ${row.head_sha.slice(0, 8)} conflicts${files.length > 0 ? ` in ${files.slice(0, 5).join(", ")}` : ""}`;
        tx(db, () => appendEvent(db, { source: "daemon", kind: "landing.train_skipped", runId: row.run_id, taskId: row.task_id, payload: { landing: row.id, head: row.head_sha, base, why, files: files.slice(0, 20) }, ts: this.deps.now() }));
        return { conflict: files };
      }
      if ("error" in merged) {
        this.deps.log(`landing queue ${row.id}: ${merged.error}`);
        return null;
      }
      sha = merged.head;
    }
    const rank = onMain ? 0 : TRAIN_RANK;
    return tx(db, () => {
      const fresh = getLanding(db, row.id);
      if (!fresh || fresh.state !== "waiting" || fresh.head_sha !== row.head_sha || fresh.train_head) return null;
      const now = this.deps.now();
      const request =
        findQueued(db, fresh.ref, sha, policy) ??
        insertRequest(db, { project_id: fresh.project_id, pr_url: fresh.ref, task_id: fresh.task_id, head_sha: sha, policy_id: policy, pr_number: null, head_ref: null, worktree: null, source: "auto", path: autoVerifyPath(db, fresh.project_id), rank, now });
      db.query("UPDATE landing_queue SET train_head = ?2, train_base = ?3, train_request = ?4, updated_at = ?5 WHERE id = ?1").run(fresh.id, sha, base, request.id, now);
      appendEvent(db, { source: "daemon", kind: "landing.train_built", runId: fresh.run_id, taskId: fresh.task_id, payload: { landing: fresh.id, head: sha, from: fresh.head_sha, base, request: request.id, position, rank, ...(local ? { main: onMain } : {}) }, ts: now });
      refreshLine(db, fresh.project_id);
      return { head: sha };
    });
  }

  /**
   * The entry ahead landed: land this one at its candidate when git proves
   * the candidate's base is what landed (trainBaseHolds) and its verify has
   * not failed. The worktree fast-forwards to it and it is pushed (a plain
   * push: it descends from the delivered head). Anything else drops the
   * candidate and the entry is integrated as before.
   */
  private async promote(row: LandingRow): Promise<HeadOutcome> {
    const { db, git, netGit } = this.deps;
    const run = getRunWithPolicy(db, row.run_id);
    const project = run ? getProject(db, run.project_id) : null;
    const delivered = run ? deliveredOf(db, run.task_id) : null;
    if (!run || !project || !delivered || run.state !== "ready" || delivered.head !== row.head_sha || !row.train_head || !row.train_base) return "left";
    const notReady = await this.workable(row, run);
    if (notReady) return notReady;
    const wt = run.worktree_path;
    const base = runBase(run, project);
    const fetched = await netGit(["fetch", "--quiet", "--no-tags", "origin", base], wt);
    if (fetched.code !== 0) {
      this.deps.log(`landing queue ${row.id}: fetch origin ${base} failed: ${fetched.stderr.trim()}`);
      return "blocked";
    }
    const why = await this.unpromotable(row, wt, base);
    if (why !== null) {
      const dropped = tx(db, () => {
        const fresh = getLanding(db, row.id);
        return fresh && fresh.state === "waiting" ? dropCandidate(db, fresh, why, this.deps.now()) : null;
      });
      return dropped ? this.integrate(dropped) : "left";
    }
    const forwarded = await git(["merge", "--ff-only", "--quiet", row.train_head], wt);
    if (forwarded.code !== 0) return this.blocked(row, `git could not fast-forward the worktree to the candidate ${row.train_head.slice(0, 8)}: ${forwarded.stderr.trim()}`);
    const headRef = prEvidence(db, run.id)?.head_ref || run.branch;
    const pushed = await netGit(["push", "origin", `HEAD:refs/heads/${headRef}`], wt);
    if (pushed.code !== 0) return this.held(row, "push_refused", `git push refused the landing train's candidate: ${pushed.stderr.trim().split("\n").at(-1) ?? ""}`, `flowryn show ${run.task_id}`);
    const tree = (await git(["rev-parse", `${row.train_head}^{tree}`], wt)).stdout.trim();
    return this.startLanding(row, run, { head: row.train_head, steps: [{ commit: row.train_head, main: row.train_base, tree }], base, train: row.train_base });
  }

  /** Why a candidate may not land now, or null when it may: the entry ahead landed at its base, git proves the base holds, its verify did not fail. */
  private async unpromotable(row: LandingRow, wt: string, base: string): Promise<string | null> {
    const { db, git } = this.deps;
    const landed = db.query("SELECT * FROM landing_queue WHERE project_id = ?1 AND state = 'landed' ORDER BY state_since DESC, CAST(substr(id, 3) AS INTEGER) DESC LIMIT 1").get(row.project_id) as LandingRow | null;
    if (!landed || landed.head_sha !== row.train_base) return `the entry it was built on (${row.train_base!.slice(0, 8)}) is not the last that landed`;
    if (this.candidateFailed(row)) return `its verify at ${row.train_head!.slice(0, 8)} failed`;
    const head = (await git(["rev-parse", "HEAD"], wt)).stdout.trim();
    if (head !== row.head_sha) return `the worktree is at ${head.slice(0, 8)}, not the delivered ${row.head_sha.slice(0, 8)}`;
    const parents = (await git(["rev-list", "--parents", "-n", "1", row.train_head!], wt)).stdout.trim().split(/\s+/).slice(1);
    if (parents.length !== 2 || parents[0] !== row.head_sha || parents[1] !== row.train_base) return `the candidate ${row.train_head!.slice(0, 8)} is not the delivered head merged with its base`;
    const proof = await trainBaseHolds(git, wt, { head: row.train_head!, base: row.train_base!, main: `refs/remotes/origin/${base}` });
    return proof.ok ? null : proof.why;
  }

  /** Hold the head of line on a busy worker or a changed worktree, up to BLOCKED_HOLD_MS. */
  private blocked(row: LandingRow, why: string): HeadOutcome {
    const { db } = this.deps;
    const now = this.deps.now();
    return tx(db, () => {
      const fresh = getLanding(db, row.id);
      if (!fresh || fresh.state !== "waiting") return "left";
      const since = fresh.blocked_since ?? now;
      if (now - since > BLOCKED_HOLD_MS) {
        leave(db, fresh, "landing_blocked", `${why} for over ${BLOCKED_HOLD_MS / 60_000} min`, now, { next: `flowryn show ${fresh.task_id}` });
        return "left";
      }
      if (fresh.blocked_since === null) {
        move(db, fresh, "waiting", { blocked_since: now, detail: why }, now);
        appendEvent(db, { source: "daemon", kind: "landing.blocked", runId: fresh.run_id, taskId: fresh.task_id, payload: { landing: fresh.id, why }, ts: now });
      }
      return "blocked";
    });
  }

  private held(row: LandingRow, reason: string, detail: string, next: string): HeadOutcome {
    const { db } = this.deps;
    return tx(db, () => {
      const fresh = getLanding(db, row.id);
      if (fresh && fresh.state === "waiting") leave(db, fresh, reason, detail, this.deps.now(), { next });
      return "left";
    });
  }

  /** Whether the daemon may work in the run's worktree now: null when it may, else what the entry does meanwhile. */
  private async workable(row: LandingRow, run: RunWithPolicy): Promise<HeadOutcome | null> {
    const wt = run.worktree_path;
    if (!existsSync(wt)) return this.held(row, "no_worktree", `the run's worktree ${wt} is gone`, `flowryn merge ${run.task_id}`);
    const why = await this.notReady(run);
    return why === null ? null : this.blocked(row, why);
  }

  /** Why the worker's checkout may not be moved now (busy, a dialog, uncommitted changes), or null. */
  private async notReady(run: RunWithPolicy): Promise<string | null> {
    if (run.liveness === "busy" || run.liveness === "blocked_dialog") return `the worker is ${run.liveness === "busy" ? "busy" : "showing a dialog"}`;
    const status = await this.deps.git(["status", "--porcelain"], run.worktree_path);
    if (status.code !== 0) return `git status failed: ${status.stderr.trim()}`;
    const dirty = status.stdout.split("\n").filter((l) => l.length > 0 && !l.startsWith("?? .claude/"));
    return dirty.length > 0 ? `the worktree has ${dirty.length} uncommitted change(s)` : null;
  }

  /**
   * A local-only line (docs/notes/2026-11-15-local-only-auto-x9.md): build the
   * candidates, then start the first entry whose candidate is on main's tip.
   * An entry that leaves on its turn (a conflict, a send-back) lets the next
   * go in the same pass; one whose worker kept it waiting LOCAL_TURN_WAIT_MS
   * lets the ones behind it go (it keeps its place).
   */
  private async advanceLocal(project: ProjectRow): Promise<void> {
    for (let round = 0; round < MAX_LOCAL_ROUNDS; round++) {
      const main = await this.mainTip(project);
      if (!main) return;
      const changed = await this.speculateLocal(project, main);
      const line = this.localLine(project);
      if (line.some((r) => r.state === "landing")) return;
      let left = changed;
      for (const row of line) {
        // A candidate not built yet (git failed, or the merge onto the entry ahead conflicted): it is tried on main next pass.
        if (!row.train_head || row.train_base !== main) break;
        const outcome = await this.startLocal(row, project, main);
        if (outcome === "left") left = true;
        if (outcome !== "passed") break;
      }
      if (!left) return;
    }
  }

  /**
   * A batch project with no live batch (docs/notes/2026-11-21-landing-batches-one-27.md): a
   * sensitive entry first in line lands alone through the local line, with your record at the
   * head that lands; otherwise (or once it cannot start) the other entries form a batch.
   */
  private async advanceBatchProject(project: ProjectRow, eligible: LandingRow[]): Promise<void> {
    const { db } = this.deps;
    const landingAlone = () => projectLine(db, project.id).some((r) => r.state === "landing");
    if (landingAlone()) return;
    const oldest = projectLine(db, project.id).find((r) => r.state === "waiting");
    if (!oldest) return;
    if (this.sensitive(oldest)) {
      await this.advanceLocal(project);
      if (landingAlone() || liveBatchOf(db, project.id)) return;
    }
    await this.batches.build(project, eligible);
  }

  /** A batch project's waiting entries a batch may take: every one that is not sensitive, in line order. */
  private batchable(projectId: string): LandingRow[] {
    return projectLine(this.deps.db, projectId).filter((r) => r.state === "waiting" && !this.sensitive(r));
  }

  private sensitive(row: LandingRow): boolean {
    return getRunWithPolicy(this.deps.db, row.run_id)?.sensitive === 1;
  }

  /** The entries the local line lands one at a time: all of them, or a batch project's sensitive ones. */
  private localLine(project: ProjectRow): LandingRow[] {
    const line = projectLine(this.deps.db, project.id);
    return landingBatched(this.deps.config(), project.id, project.delivery_mode) ? line.filter((r) => r.batch_id === null && this.sensitive(r)) : line;
  }

  /** Local main's tip, or null (logged) when git cannot read it. */
  private async mainTip(project: ProjectRow): Promise<string | null> {
    const read = await this.deps.git(["rev-parse", "--verify", "--quiet", `refs/heads/${project.default_branch}^{commit}`], project.path);
    const sha = read.stdout.trim();
    if (read.code === 0 && /^[0-9a-f]{40,64}$/.test(sha)) return sha;
    this.deps.log(`landing queue ${project.id}: cannot read local ${project.default_branch}: ${read.stderr.trim() || `git exited ${read.code}`}`);
    return null;
  }

  /**
   * A local-only line's candidates. The chain starts at the landing entry's
   * head, or at main's tip when none lands; each waiting entry within the
   * depth gets a candidate on the head ahead of it, as speculate() does. An
   * entry whose worker has kept it waiting LOCAL_TURN_WAIT_MS stays out of the
   * chain, so the ones behind it build on what is ahead of it, and keeps a
   * candidate on main for its turn. Within the wait it stays in the chain, so
   * a worker that turns ready in time costs the ones behind no rebuild.
   * A head of line whose merge onto main conflicts goes back to its worker.
   * Returns whether an entry left the line.
   */
  private async speculateLocal(project: ProjectRow, main: string): Promise<boolean> {
    const { db } = this.deps;
    const depth = landingTrainDepth(this.deps.config(), project.id, project.delivery_mode);
    const line = this.localLine(project);
    const head = line.find((r) => r.state === "landing");
    const drop = (row: LandingRow, why: string) => tx(db, () => dropCandidate(db, getLanding(db, row.id) ?? row, why, this.deps.now()));
    let base: string | null = head ? head.head_sha : main;
    let room = head ? depth - 1 : depth;
    let built = 0;
    let left = false;
    for (const [i, row] of line.filter((r) => r.state === "waiting").entries()) {
      const waitingOnWorker = !head && this.passedOver(row);
      const on = waitingOnWorker ? main : base;
      if (!waitingOnWorker) {
        if (base === null || room <= 0) {
          if (row.train_head) drop(row, base === null ? "the train ends ahead of it" : `it is beyond the train's depth of ${depth}`);
          continue;
        }
        room--;
      }
      if (row.train_head && row.train_base === on) {
        if (!waitingOnWorker) base = this.candidateFailed(row) ? null : row.train_head;
        continue;
      }
      if (row.train_head) drop(row, `its base moved from ${row.train_base?.slice(0, 8) ?? "-"} to ${on!.slice(0, 8)}`);
      const candidate = await this.buildCandidate(row, on!, i + (head ? 2 : 1), { main });
      if (candidate && "conflict" in candidate && on === main) {
        left = (await this.localConflict(row, project, candidate.conflict)) || left;
      }
      if (candidate && "head" in candidate) built++;
      if (!waitingOnWorker) base = candidate && "head" in candidate ? candidate.head : null;
    }
    if (built > 0) this.deps.kickScheduler();
    return left;
  }

  /** The head of line's merge onto main conflicts: it leaves, and its worker is sent back naming the paths. */
  private async localConflict(row: LandingRow, project: ProjectRow, files: string[]): Promise<boolean> {
    const { db } = this.deps;
    const run = getRunWithPolicy(db, row.run_id);
    const delivered = run ? deliveredOf(db, run.task_id) : null;
    if (!run || !delivered) return false;
    if (files.length === 0) return this.held(row, "merge_failed", `git could not merge ${project.default_branch} into ${row.head_sha.slice(0, 8)} and named no conflicted path`, `flowryn show ${run.task_id}`) === "left";
    return this.sendConflict(row, run, delivered, project.default_branch, files);
  }

  /**
   * The entry whose candidate is on main's tip takes its turn. A candidate
   * whose verify failed sends the work back with that log (it is exactly main
   * plus the work). A merge candidate needs the worker idle and its checkout
   * clean at the delivered head, which then fast-forwards to it; a candidate
   * that is the delivered head itself needs nothing of the checkout.
   */
  private async startLocal(row: LandingRow, project: ProjectRow, main: string): Promise<TurnOutcome> {
    const { db, git } = this.deps;
    const run = getRunWithPolicy(db, row.run_id);
    const delivered = run ? deliveredOf(db, run.task_id) : null;
    if (!run || !delivered || run.state !== "ready" || delivered.head !== row.head_sha || !row.train_head) return "left";
    const failed = this.failedCandidate(row);
    if (failed && this.sendCarBack(row, run, failed, project, main)) return "left";
    const merge = row.train_head !== row.head_sha;
    const steps: CleanMergeStep[] = [];
    if (merge) {
      const wt = run.worktree_path;
      if (!existsSync(wt)) return this.held(row, "no_worktree", `the run's worktree ${wt} is gone`, `flowryn merge ${run.task_id}`);
      const head = await git(["rev-parse", "HEAD"], wt);
      const why = head.code !== 0 ? `git cannot read the worktree's HEAD: ${head.stderr.trim()}` : head.stdout.trim() !== row.head_sha ? `the worktree is at ${head.stdout.trim().slice(0, 8)}, not the delivered ${row.head_sha.slice(0, 8)}` : await this.notReady(run);
      if (why !== null) return this.turnBlocked(row, why);
      const parents = (await git(["rev-list", "--parents", "-n", "1", row.train_head], project.path)).stdout.trim().split(/\s+/).slice(1);
      const proof = parents.length === 2 && parents[0] === row.head_sha && parents[1] === main ? await trainBaseHolds(git, project.path, { head: row.train_head, base: main, main: `refs/heads/${project.default_branch}` }) : null;
      if (!proof?.ok) {
        if (proof?.unknown) {
          this.deps.log(`landing queue ${row.id}: ${proof.why}`);
          return "blocked";
        }
        tx(db, () => dropCandidate(db, getLanding(db, row.id) ?? row, proof?.why ?? `the candidate ${row.train_head!.slice(0, 8)} is not the delivered head merged with ${project.default_branch}`, this.deps.now()));
        return "blocked";
      }
      const forwarded = await git(["merge", "--ff-only", "--quiet", row.train_head], wt);
      if (forwarded.code !== 0) return this.turnBlocked(row, `git could not fast-forward the worktree to ${row.train_head.slice(0, 8)}: ${forwarded.stderr.trim()}`);
      steps.push({ commit: row.train_head, main, tree: proof.tree });
    }
    return this.startLanding(row, run, { head: row.train_head, steps, base: project.default_branch, train: main });
  }

  /** blocked(), and `passed` once the entry has kept its turn waiting LOCAL_TURN_WAIT_MS: the ones behind it may go. */
  private turnBlocked(row: LandingRow, why: string): TurnOutcome {
    const outcome = this.blocked(row, why);
    if (outcome !== "blocked") return outcome;
    const fresh = getLanding(this.deps.db, row.id);
    return fresh && this.passedOver(fresh) ? "passed" : "blocked";
  }

  /** Whether the entry's worker has kept its turn waiting LOCAL_TURN_WAIT_MS. */
  private passedOver(row: LandingRow): boolean {
    return row.blocked_since !== null && this.deps.now() - row.blocked_since >= LOCAL_TURN_WAIT_MS;
  }

  /**
   * A car whose candidate on main failed its verify: that is a failure of
   * exactly main plus the work, so it goes back with that verify's log, with
   * no verify again. Only a step that failed is sent back this way; anything
   * else (a timeout, an error) starts the landing, whose auto-merge verifies
   * again under its own rules. Returns whether it was sent back.
   */
  private sendCarBack(row: LandingRow, run: RunWithPolicy, v: Verification, project: ProjectRow, main: string): boolean {
    const { db } = this.deps;
    const sent = tx(db, () => {
      const fresh = getLanding(db, row.id);
      const current = getRunWithPolicy(db, run.id);
      if (!fresh || fresh.state !== "waiting" || !current || current.state !== "ready") return false;
      const route = routeVerifyOutcome(db, v, current);
      if (route.route !== "send_back") return false;
      const now = this.deps.now();
      const step = route.step;
      const merged = fresh.train_head !== fresh.head_sha;
      const where = merged
        ? `It ran on your branch merged with ${project.default_branch} at ${main.slice(0, 8)} (the merge queue's commit, not in your branch): merge ${project.default_branch} into your branch to reproduce it.`
        : `It ran on your branch as delivered, on ${project.default_branch} at ${main.slice(0, 8)}.`;
      appendEvent(db, { source: "daemon", kind: "landing.car_failed", runId: fresh.run_id, taskId: fresh.task_id, payload: { landing: fresh.id, head: fresh.train_head, base: fresh.train_base, verification: v.id, step: step.name }, ts: now });
      leave(db, fresh, "verify_failed", `verify ${v.id} of its merge onto ${project.default_branch} at ${main.slice(0, 8)} failed: \`${step.name}\` exited ${step.exit}`, now);
      sendBack(
        db,
        current,
        {
          text: `${sendBackText(v, step, "Merge queue")}\n${where}`,
          feedback: `merge queue verify ${v.id} failed`,
          why: `the merge queue's verify ${v.id} failed`,
          event: { source: "daemon", kind: SENT_BACK_KIND, payload: sentBackPayload(v, step, "auto_merge", { landing: fresh.id }) },
        },
        now,
      );
      return true;
    });
    if (sent) this.deps.kickScheduler();
    return sent;
  }

  /**
   * Bring one waiting entry up to date with its base, in the run's worktree:
   * no merge when it already has the base's tip, else a plain merge commit,
   * pushed; then its landing starts.
   */
  private async integrate(row: LandingRow): Promise<HeadOutcome> {
    const { db, git, netGit } = this.deps;
    const run = getRunWithPolicy(db, row.run_id);
    const project = run ? getProject(db, run.project_id) : null;
    const delivered = run ? deliveredOf(db, run.task_id) : null;
    if (!run || !project || !delivered || run.state !== "ready" || delivered.head !== row.head_sha) return "left";
    const notReady = await this.workable(row, run);
    if (notReady) return notReady;
    const wt = run.worktree_path;
    const base = runBase(run, project);
    const fetched = await netGit(["fetch", "--quiet", "--no-tags", "origin", base], wt);
    if (fetched.code !== 0) {
      this.deps.log(`landing queue ${row.id}: fetch origin ${base} failed: ${fetched.stderr.trim()}`);
      return "blocked";
    }
    const headRef = prEvidence(db, run.id)?.head_ref || run.branch;
    let head = (await git(["rev-parse", "HEAD"], wt)).stdout.trim();
    let merged = false;
    if (head !== row.head_sha) {
      // A delivery carried on GitHub (a merge of main made there) leaves a clean worktree behind it: catch up first.
      const fetchedHead = await netGit(["fetch", "--quiet", "--no-tags", "origin", headRef], wt);
      const behind = fetchedHead.code === 0 ? await git(["merge-base", "--is-ancestor", "HEAD", row.head_sha], wt) : fetchedHead;
      if (behind.code === 0) {
        const forwarded = await git(["merge", "--ff-only", "--quiet", row.head_sha], wt);
        if (forwarded.code !== 0) return this.blocked(row, `git could not fast-forward the worktree to ${row.head_sha.slice(0, 8)}: ${forwarded.stderr.trim()}`);
        head = row.head_sha;
      }
    }
    if (head !== row.head_sha) {
      // A merge of ours that a stop cut off before its push is pushed now, if it still proves clean; anything else is someone's work.
      const proof = await cleanMainMerge(git, wt, { from: row.head_sha, to: head, base });
      if (!proof.ok) return this.blocked(row, `the worktree is at ${head.slice(0, 8)}, not the delivered ${row.head_sha.slice(0, 8)}`);
      merged = true;
    } else {
      const upToDate = await git(["merge-base", "--is-ancestor", `refs/remotes/origin/${base}`, "HEAD"], wt);
      if (upToDate.code !== 0 && upToDate.code !== 1) return this.blocked(row, `git could not say whether it has origin/${base}: ${upToDate.stderr.trim()}`);
      if (upToDate.code === 1) {
        const result = await git(["merge", "--no-ff", "--no-edit", "-m", landingMergeMessage(base, run.branch), `refs/remotes/origin/${base}`], wt);
        if (result.code !== 0) return this.conflicted(row, run, delivered, base, result.stderr || result.stdout);
        head = (await git(["rev-parse", "HEAD"], wt)).stdout.trim();
        merged = true;
      }
    }
    if (merged) {
      const pushed = await netGit(["push", "origin", `HEAD:refs/heads/${headRef}`], wt);
      if (pushed.code !== 0) return this.held(row, "push_refused", `git push refused the merge of origin/${base}: ${pushed.stderr.trim().split("\n").at(-1) ?? ""}`, `flowryn show ${run.task_id}`);
      const proof = await cleanMainMerge(git, wt, { from: row.head_sha, to: head, base });
      if (!proof.ok) return this.held(row, "not_clean", `the pushed merge did not prove clean: ${proof.why}`, `flowryn show ${run.task_id}`);
      return this.startLanding(row, run, { head, steps: proof.steps, base });
    }
    return this.startLanding(row, run, null);
  }

  /** The merge stopped on conflicts: undo it, then send the ship back as the conflict nudge does. */
  private async conflicted(row: LandingRow, run: RunWithPolicy, delivered: Delivered, base: string, output: string): Promise<HeadOutcome> {
    const { git } = this.deps;
    const wt = run.worktree_path;
    const unmerged = await git(["diff", "--name-only", "--diff-filter=U"], wt);
    const files = unmerged.stdout.split("\n").map((f) => f.trim()).filter((f) => f.length > 0);
    const aborted = await git(["merge", "--abort"], wt);
    if (aborted.code !== 0) this.deps.log(`landing queue ${row.id}: merge --abort in ${wt} failed: ${aborted.stderr.trim()}`);
    if (files.length === 0) return this.held(row, "merge_failed", `git merge origin/${base} failed: ${output.trim().split("\n").at(-1) ?? ""}`, `flowryn show ${run.task_id}`);
    this.sendConflict(row, run, delivered, base, files);
    return "left";
  }

  /** The entry leaves the line for a conflict with `base`, and its ship is sent back as the conflict nudge sends it. Returns whether it left. */
  private sendConflict(row: LandingRow, run: RunWithPolicy, delivered: Delivered, base: string, files: string[]): boolean {
    return sendConflict(this.deps, row, run, delivered, base, files);
  }

  /**
   * The entry is first in line: carry the delivery to the integrated head
   * (when there was a merge), keep or void its approval, and start the
   * auto-merge row that verifies and merges it.
   */
  private startLanding(row: LandingRow, run: RunWithPolicy, integrated: { head: string; steps: CleanMergeStep[]; base: string; train?: string } | null): HeadOutcome {
    const { db } = this.deps;
    const now = this.deps.now();
    const config = this.deps.config();
    return tx(db, () => {
      const fresh = getLanding(db, row.id);
      const current = getRunWithPolicy(db, run.id);
      const delivered = current ? deliveredOf(db, current.task_id) : null;
      if (!fresh || fresh.state !== "waiting" || !current || current.state !== "ready" || !delivered) return "left";
      // The watcher may have carried a routine delivery to the pushed merge already.
      const carriedByWatcher = integrated !== null && delivered.head === integrated.head && delivered.carriedFrom === fresh.head_sha;
      if (delivered.head !== fresh.head_sha && !carriedByWatcher) return "left";
      const steps = verifyConfig(config, current.project_id);
      const local = delivered.kind === "local";
      const ref = approvalRef(delivered);
      let head = delivered.head;
      let approval = fresh.approval_id;
      // A local-only candidate that is the delivered head itself moves nothing.
      const moved = integrated !== null && integrated.head !== fresh.head_sha;
      if (integrated && moved) {
        const evidence = prEvidence(db, current.id);
        const before = approval ? (db.query("SELECT * FROM approvals WHERE id = ?1").get(approval) as ApprovalRow | null) : null;
        const merged = local ? integrated.base : `origin/${integrated.base}`;
        if (!carriedByWatcher) {
          // A local candidate's verify was queued when it was built: the carry queues none.
          const verifyPolicy = steps && !local ? verifyPolicyId(steps) : null;
          carryLanding(db, current, delivered, { headSha: integrated.head, number: evidence?.number ?? 0, headRef: evidence?.head_ref ?? current.branch }, { from: delivered.head, steps: integrated.steps, verifyPolicy }, now);
          settleHeadMove(db, current, delivered.head, integrated.head, now);
          if (local) appendEvent(db, { source: "daemon", kind: "landing.caught_up", runId: current.id, taskId: current.task_id, payload: { landing: fresh.id, from: delivered.head, to: integrated.head, main: integrated.train ?? null, request: fresh.train_request }, ts: now });
        }
        head = integrated.head;
        approval = null;
        // Unattended mode: the standing approval covers the new head as it covered the old one, sensitive work included.
        const standing = isRoutineMerge(db, current.task_id) ? null : autonomyForRun(db, current, now);
        if (standing) {
          approval = mintAutonomyApproval(db, standing, { task: current.task_id, ref: before?.pr_url ?? ref, head, action: "merge", runId: current.id }, now).id;
        } else if (before && before.consumed_at === null && before.expires_at > now) {
          // Your answer in the design review (q130): an approval carries across the queue's clean merge of the base, unless the work is sensitive.
          if (current.sensitive) {
            // The validator's pass while you are away binds its head too; it judges the new head by itself, so nothing is held for you.
            if (before.channel === "away-validator") {
              leave(db, { ...fresh, head_sha: head }, "approval_needed", `sensitive work: the merge of ${merged} moved the head to ${head.slice(0, 8)}; the validator judges the new head before it merges`, now);
              return "left";
            }
            leave(db, { ...fresh, head_sha: head }, "approval_needed", `sensitive work: the merge of ${merged} moved the head to ${head.slice(0, 8)}, so your approval of ${fresh.head_sha.slice(0, 8)} does not carry`, now, {
              next: `flowryn merge ${current.task_id}`,
            });
            return "left";
          }
          const carried = insertApproval(db, { task: current.task_id, ref: before.pr_url, head, channel: before.channel, actor: `${before.actor}, carried across a clean merge of ${integrated.base}`, action: "merge", allowRed: before.allow_red_check, now });
          db.query("UPDATE approvals SET expires_at = ?2 WHERE id = ?1").run(carried.id, before.expires_at);
          approval = carried.id;
        }
        if (!approval && !isRoutineMerge(db, current.task_id)) {
          leave(db, { ...fresh, head_sha: head }, "approval_needed", `its approval of ${fresh.head_sha.slice(0, 8)} expired or was used`, now, { next: `flowryn merge ${current.task_id}` });
          return "left";
        }
      }
      const evidence = prEvidence(db, current.id);
      // A promoted candidate's verify is the head of line's now: it goes ahead of the queue's other requests.
      const trainRequest = integrated?.train && fresh.train_request ? getRequest(db, fresh.train_request) : null;
      if (trainRequest?.state === "queued") rerankRequest(db, trainRequest, 0, now);
      const kept = integrated?.train ? fresh : dropCandidate(db, fresh, "it lands at its own merge of the base", now);
      supersedeAutoMerge(db, current.id, "landing", `the landing queue lands it at ${head.slice(0, 8)}`, now);
      const auto = createAutoMerge(db, config, current, { ref, head, prNumber: evidence?.number ?? null, headRef: local ? null : (evidence?.head_ref ?? current.branch), worktree: null, source: "daemon" }, now);
      const detail = !integrated
        ? null
        : local
          ? `${moved ? "caught up with" : "on"} ${integrated.base} at ${(integrated.train ?? head).slice(0, 8)}`
          : integrated.train
            ? `the landing train's candidate on ${integrated.train.slice(0, 8)}, at ${head.slice(0, 8)}`
            : `merged origin/${integrated.base} at ${head.slice(0, 8)}`;
      const line = projectLine(db, current.project_id);
      // A local-only line: every entry ahead of this one that waited on its worker loses this turn.
      if (local) for (const other of line.slice(0, line.findIndex((r) => r.id === fresh.id))) if (other.state === "waiting" && other.blocked_since !== null) skipTurn(db, other, fresh, now);
      move(db, kept, "landing", { head_sha: head, approval_id: approval, auto_merge_id: auto.id, integrations: fresh.integrations + (moved ? 1 : 0), blocked_since: null, detail }, now);
      // Time blocked counts only while an entry is tried: the others wait out this landing.
      for (const other of projectLine(db, current.project_id)) if (other.state === "waiting" && other.blocked_since !== null) move(db, other, "waiting", { blocked_since: null }, now);
      refreshLine(db, current.project_id);
      return "started";
    });
  }

  /**
   * Before the head of line merges: its base must still be in it, so what
   * merges is what was verified on top of the base. A base that moved sends
   * the entry back to integrate (its row superseded), MAX_INTEGRATIONS times.
   * A row that is not the queue's merges as it would.
   */
  async beforeMerge(auto: AutoMergeRow): Promise<boolean> {
    const { db, git, netGit } = this.deps;
    const row = db.query("SELECT * FROM landing_queue WHERE auto_merge_id = ?1 AND state = 'landing'").get(auto.id) as LandingRow | null;
    if (!row) return true;
    const run = getRunWithPolicy(db, row.run_id);
    const project = run ? getProject(db, run.project_id) : null;
    if (!run || !project) return true;
    const base = runBase(run, project);
    const local = project.delivery_mode === "local-only";
    const where = local ? base : `origin/${base}`;
    if (local) {
      // Local-only: the merge fast-forwards main to the head, which holds exactly what was verified while main is in it.
      const has = await git(["merge-base", "--is-ancestor", `refs/heads/${base}`, auto.head_sha], project.path);
      if (has.code === 0) return true;
      if (has.code !== 1) return false;
      return this.baseMoved(row, auto, base, where);
    }
    const cwd = existsSync(run.worktree_path) ? run.worktree_path : project.path;
    const fetched = await netGit(["fetch", "--quiet", "--no-tags", "origin", base], cwd);
    if (fetched.code !== 0) {
      this.deps.log(`landing queue ${row.id}: fetch origin ${base} before the merge failed: ${fetched.stderr.trim()}`);
      return false;
    }
    if (row.train_base) {
      // A promoted candidate never has main's own landing commit: main must hold exactly its base, and merging it must write its tree.
      const proof = await trainBaseHolds(git, cwd, { head: auto.head_sha, base: row.train_base, main: `refs/remotes/origin/${base}` });
      if (proof.ok) return true;
      if (proof.unknown) return false;
    } else {
      const has = await git(["merge-base", "--is-ancestor", `refs/remotes/origin/${base}`, auto.head_sha], cwd);
      if (has.code === 0) return true;
      if (has.code !== 1) return false;
    }
    return this.baseMoved(row, auto, base, where);
  }

  /** The head of line's base moved before its merge: back to waiting, to integrate again (MAX_INTEGRATIONS times, then held). Returns false: no merge now. */
  private baseMoved(row: LandingRow, auto: AutoMergeRow, branch: string, base: string): false {
    const { db } = this.deps;
    tx(db, () => {
      const fresh = getLanding(db, row.id);
      if (!fresh || fresh.state !== "landing") return;
      const now = this.deps.now();
      if (fresh.integrations >= MAX_INTEGRATIONS) {
        leave(db, fresh, "base_moving", `${base} moved under it ${fresh.integrations} times before it could merge`, now, { next: `flowryn merge ${fresh.task_id}` });
        return;
      }
      supersedeAutoMerge(db, fresh.run_id, "base_moved", `${base} moved past ${auto.head_sha.slice(0, 8)} before the merge`, now);
      move(db, fresh, "waiting", { auto_merge_id: null, detail: `${base} moved; merging it in again`, train_head: null, train_base: null, train_request: null }, now);
      appendEvent(db, { source: "daemon", kind: "landing.base_moved", runId: fresh.run_id, taskId: fresh.task_id, payload: { landing: fresh.id, head: auto.head_sha, base: branch }, ts: now });
    });
    return false;
  }
}

export type TrainProof = { ok: true; tree: string } | { ok: false; why: string; unknown?: boolean };

/**
 * Whether a candidate built on `base` may land on `main` as verified, proven
 * with git: main's tree is exactly the base's (what landed is the base, by
 * any merge method, nothing else with it), and git's own merge of the
 * candidate into main finishes without a conflict and writes exactly the
 * candidate's tree, so what lands is what was verified. A git call that
 * fails is `unknown` (the caller retries), never a pass.
 */
export async function trainBaseHolds(git: GitRunner, cwd: string, q: { head: string; base: string; main: string }): Promise<TrainProof> {
  const trees = await git(["rev-parse", `${q.main}^{tree}`, `${q.base}^{tree}`, `${q.head}^{tree}`], cwd);
  if (trees.code !== 0) return { ok: false, unknown: true, why: `git rev-parse exited ${trees.code}: ${trees.stderr.trim()}` };
  const [main, base, head] = trees.stdout.trim().split("\n").map((t) => t.trim());
  if (!main || !base || !head) return { ok: false, unknown: true, why: "git rev-parse did not print three trees" };
  if (main !== base) return { ok: false, why: `${q.main.replace("refs/remotes/", "")} does not hold exactly the base ${q.base.slice(0, 8)} it was verified on` };
  const merged = await git(["merge-tree", "--write-tree", "--no-messages", q.main, q.head], cwd);
  if (merged.code === 1) return { ok: false, why: `merging ${q.head.slice(0, 8)} into ${q.main.replace("refs/remotes/", "")} conflicts` };
  if (merged.code !== 0) return { ok: false, unknown: true, why: `git merge-tree exited ${merged.code}: ${merged.stderr.trim()}` };
  const tree = merged.stdout.split("\n")[0]?.trim() ?? "";
  if (tree !== head) return { ok: false, why: `merging ${q.head.slice(0, 8)} into ${q.main.replace("refs/remotes/", "")} writes another tree than the one verified` };
  return { ok: true, tree };
}

/** Today's verify policy for a project, or null when it has none or its config is invalid. */
function todaysPolicy(config: FlowrynConfig, projectId: string): string | null {
  try {
    const verify = verifyConfig(config, projectId);
    return verify ? verifyPolicyId(verify) : null;
  } catch {
    return null;
  }
}
