import { FlowrynError } from "../api/errors.ts";
import type { HandlerResult } from "../api/verbs.ts";
import { findOpenRunItem, itemLines, openItem, resolveRunItems } from "../attention/items.ts";
import type { FlowrynConfig } from "../config/config.ts";
import { getMeta, setMeta, tx, type Db } from "../db/db.ts";
import { appendEvent, type EventSource } from "../db/events.ts";
import { deliveredOf, prEvidence, type PrEvidence } from "../lifecycle/delivery.ts";
import { autonomyForRun } from "../policy/autonomy.ts";
import { getRunWithPolicy, isTerminal, taskTitle, type RunWithPolicy } from "../lifecycle/runs.ts";
import { sendBack } from "../lifecycle/send-back.ts";
import { DAEMON_CALLER, latestMerge, type MergeRow } from "../policy/merge.ts";
import { applyMerge, prepareDaemonMerge, settleMerge, type MergeServices } from "../policy/merge-path.ts";
import { sanitizeLine } from "../util/sanitize.ts";
import { autoMergeEnabled, autoVerifyEnabled, verifyConfig } from "./config.ts";
import { verifyPolicyId } from "./policy.ts";
import { autoVerifyPath, findQueued, getRequest, insertRequest, positionOf, requeuedFrom, type VerifyRequest } from "./queue.ts";
import { queueAutoRerun, recordEscalation, routeManualVerifies, routeVerifyOutcome, SENT_BACK_KIND, sendBackText, sentBackPayload } from "./route.ts";
import { cancelIsFinal, headMovedTo, staleRead } from "./start.ts";
import { finishedAtHead, getVerification, interruptedByStop, runningVerifications, type Verification } from "./store.ts";

/**
 * Yolo auto-merge (docs/notes/2026-10-22-daemon-run-verify-y3.md, phase 2):
 * a project with `[projects.<id>] auto_merge = true` has the daemon verify and
 * merge its yolo, non-sensitive deliveries with no leader turn. One row per
 * delivery (`auto_merges`), started in the deliver transaction and driven by
 * plain code:
 *
 *   queued → verifying → waiting_checks → merging → merged
 *
 * A verify that did not pass is judged by src/verify/route.ts: a step that
 * exits non-zero sends the ship back to its worker with the step and its tail
 * (sent_back), a timeout runs the verify once more (back to queued); a second
 * timeout, an error, a second failure at the head or of the same step, a
 * fourth send-back, checks pending over 6 h (1 h under no_ci), a moved head
 * not redelivered 30 min after it was first seen, or a merge-gate refusal
 * holds it (auto_merge_held, a P1 that wakes the leader). A verify hold ends
 * when a later verify of the same head passes, whoever ran it (releaseHolds,
 * docs/notes/2026-11-07-fix-a-held-ss.md). A run that is sent
 * back, cancelled or redelivered, or a project that turns it off, supersedes
 * the row. The merge is the `merge` verb's own path (src/policy/merge-path.ts)
 * with the daemon as caller, so it takes the yolo channel and the gate is
 * unchanged. No model is involved here (a review step is the verify's own, src/verify/review.ts).
 *
 * Auto-verify (docs/notes/2026-11-06-auto-verify-every-t8.md): every other
 * delivery on a project with verify steps gets a row with `merge = 0`, so its
 * verify starts with no leader turn whatever the project's landing mode. It
 * runs the same states up to the verify: a pass ends it `verified` (the merge
 * then waits as it did, on an approval or the landing queue), and a failure
 * goes back to the worker or is held exactly as an auto-merge's. Unset,
 * `auto_merge` follows the project's yolo posture.
 */

export const AUTO_MERGE_STATES = ["queued", "verifying", "waiting_checks", "merging", "merged", "held", "superseded", "sent_back", "verified"] as const;
export type AutoMergeState = (typeof AUTO_MERGE_STATES)[number];
export const LIVE_AUTO_MERGE_STATES: readonly AutoMergeState[] = ["queued", "verifying", "waiting_checks", "merging"];

/** Verifies one auto-merge queues again for lost ones (cancelled, gone, cut off by a stop) before it holds: the loss keeps happening. */
export const MAX_VERIFY_REQUEUES = 3;

/** How many verifies the row queued again for lost ones. */
export function requeueCount(db: Db, autoMergeId: string): number {
  return (db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'auto_merge.verify_requeued' AND json_extract(payload, '$.auto_merge') = ?1").get(autoMergeId) as { n: number }).n;
}

export { interruptedByStop } from "./store.ts";

/** How long a passed verify waits on GitHub's checks before the auto-merge is held. */
export const CHECKS_WAIT_MS = 6 * 60 * 60_000;
/** A project whose default branch's .no-mistakes.yaml says `no_ci: true` gets this long for GitHub's checks instead. */
export const NO_CI_CHECKS_WAIT_MS = 60 * 60_000;
/** How long a passed verify waits for the redelivery of a PR head that moved past it before the auto-merge is held. */
export const HEAD_MOVED_WAIT_MS = 30 * 60_000;
/** When the row first saw its PR head move past the delivered one (its one auto_merge.head_moved_seen event), or null. */
export function headMovedSeenAt(db: Db, autoMergeId: string): number | null {
  return (db.query("SELECT MIN(ts) AS t FROM events WHERE kind = 'auto_merge.head_moved_seen' AND json_extract(payload, '$.auto_merge') = ?1").get(autoMergeId) as { t: number | null }).t;
}

/** When the row first saw its PR head move, recorded now (one auto_merge.head_moved_seen event) if it had not been. Call inside a transaction. */
function headMovedSince(db: Db, row: AutoMergeRow, head: string | null, now: number): number {
  const seen = headMovedSeenAt(db, row.id);
  if (seen !== null) return seen;
  appendEvent(db, { source: "daemon", kind: "auto_merge.head_moved_seen", runId: row.run_id, taskId: row.task_id, payload: { auto_merge: row.id, head }, ts: now });
  return now;
}

/** What the watcher's PR evidence shows against the row's head: it, an earlier delivered head of the task GitHub has not caught up from, or a move past it. */
export function evidenceHead(db: Db, row: Pick<AutoMergeRow, "task_id" | "head_sha">, pr: Pick<PrEvidence, "head">): "delivered" | "stale" | "moved" {
  if (pr.head === row.head_sha) return "delivered";
  return staleRead(db, row, pr.head) ? "stale" : "moved";
}

/** Whether the PR's checks are still running on GitHub. */
export function checksPending(pr: Pick<PrEvidence, "checks"> | null): boolean {
  return !!pr?.checks && (pr.checks.state === "pending" || pr.checks.pending.length > 0);
}

/** The controller's fallback pass; a finished verify, a watcher pass and a delivery kick it sooner. */
export const AUTO_MERGE_TICK_MS = 60_000;
/** How much of a hold's reason its item line keeps, so the next command after it stays on the line (the row keeps it whole). */
const HELD_DETAIL_CHARS = 120;
/** What joins the pr_ready line and the auto-merge's progress (an auto-verify's says so). */
const READY_SEPARATOR = "; auto-merge: ";
const VERIFY_SEPARATOR = "; auto-verify: ";
const SEPARATORS = /; auto-(?:merge|verify): /;

export interface AutoMergeRow {
  id: string;
  run_id: string;
  task_id: string;
  project_id: string;
  /** The canonical PR URL, or local:<branch>: what verifications and approvals bind to. */
  ref: string;
  head_sha: string;
  state: AutoMergeState;
  request_id: string | null;
  verification_id: string | null;
  merge_id: string | null;
  /** held: a code (verify_failed, verify_timeout, verify_error, verify_cancelled, checks_timeout, or the gate's); superseded: why. */
  reason: string | null;
  detail: string | null;
  /** held: the command its auto_merge_held item names (NULL on a row held before migration 43). */
  next?: string | null;
  /** 1: verify, then merge; 0: verify only (auto-verify, migration 55). */
  merge: number;
  created_at: number;
  state_since: number;
  updated_at: number;
}

const LIVE_SQL = `state IN (${LIVE_AUTO_MERGE_STATES.map((s) => `'${s}'`).join(", ")})`;

export function getAutoMerge(db: Db, id: string): AutoMergeRow | null {
  return db.query("SELECT * FROM auto_merges WHERE id = ?1").get(id) as AutoMergeRow | null;
}

/** The run's live auto-merge, if any (at most one). */
export function liveAutoMerge(db: Db, runId: string): AutoMergeRow | null {
  return db.query(`SELECT * FROM auto_merges WHERE run_id = ?1 AND ${LIVE_SQL}`).get(runId) as AutoMergeRow | null;
}

/** The run's newest auto-merge, any state, for `show`. */
export function latestAutoMerge(db: Db, runId: string): AutoMergeRow | null {
  return db.query("SELECT * FROM auto_merges WHERE run_id = ?1 ORDER BY created_at DESC, CAST(substr(id, 3) AS INTEGER) DESC LIMIT 1").get(runId) as AutoMergeRow | null;
}

export function liveAutoMerges(db: Db): AutoMergeRow[] {
  return db.query(`SELECT * FROM auto_merges WHERE ${LIVE_SQL} ORDER BY created_at, CAST(substr(id, 3) AS INTEGER)`).all() as AutoMergeRow[];
}

/** `show`'s line: "am3 verifying (v41)", "am3 held (verify_failed): ...". */
export function autoMergeLine(db: Db, row: AutoMergeRow): string {
  const progress = progressOf(db, row);
  return `${row.id} ${progress ?? row.state}${row.detail && (row.state === "held" || row.state === "superseded") ? `: ${row.detail}` : ""}`;
}

/** What the pr_ready line says of a row, or null once it ended. */
export function autoMergeProgress(db: Db, row: AutoMergeRow): string | null {
  return progressOf(db, row);
}

function progressOf(db: Db, row: AutoMergeRow): string | null {
  switch (row.state) {
    case "queued": {
      const place = row.request_id ? positionOf(db, row.request_id) : null;
      return `verify queued (${row.request_id ?? "-"}${place ? `, ${place.position} of ${place.of}` : ""})`;
    }
    case "verifying":
      return `verifying (${row.verification_id ?? "-"})`;
    case "waiting_checks":
      return `verify ${row.verification_id ?? "-"} passed, waiting on checks`;
    case "merging":
      return `merging (${row.merge_id ?? "-"})`;
    case "held":
      return `held (${row.reason ?? "-"})`;
    case "verified":
      return `verify ${row.verification_id ?? "-"} passed`;
    default:
      return null;
  }
}

/** Keep the run's open pr_ready line ending in the auto-merge's progress; true when it changed. Call inside a transaction. */
function refreshReadyLine(db: Db, row: AutoMergeRow): boolean {
  return setReadyProgress(db, row.run_id, progressOf(db, row), row.merge === 0 ? VERIFY_SEPARATOR : READY_SEPARATOR);
}

/** End the run's open pr_ready line in `progress` (the auto-merge's, or the landing queue's place), or nothing; true when it changed. Call inside a transaction. */
export function setReadyProgress(db: Db, runId: string, progress: string | null, separator = READY_SEPARATOR): boolean {
  const item = findOpenRunItem(db, "pr_ready", runId);
  if (!item) return false;
  const base = (item.full_line ?? item.line).split(SEPARATORS)[0]!;
  const lines = itemLines(progress ? `${base}${separator}${progress}` : base);
  if (lines.line === item.line && lines.full_line === item.full_line) return false;
  db.query("UPDATE items SET line = ?2, full_line = ?3 WHERE id = ?1").run(item.id, lines.line, lines.full_line);
  return true;
}

interface MoveFields {
  request_id?: string | null;
  verification_id?: string | null;
  merge_id?: string | null;
  reason?: string | null;
  detail?: string | null;
  next?: string | null;
}

/** Move a row to `to` with its `auto_merge.<to>` event. Call inside a transaction. */
function move(db: Db, row: AutoMergeRow, to: AutoMergeState, fields: MoveFields, now: number, source: EventSource = "daemon"): { row: AutoMergeRow; seq: number } {
  const next: AutoMergeRow = { ...row, ...fields, state: to, state_since: to === row.state ? row.state_since : now, updated_at: now };
  db.query(
    `UPDATE auto_merges SET state = ?2, request_id = ?3, verification_id = ?4, merge_id = ?5, reason = ?6, detail = ?7, state_since = ?8, updated_at = ?9, next = ?10 WHERE id = ?1`,
  ).run(row.id, to, next.request_id, next.verification_id, next.merge_id, next.reason, next.detail, next.state_since, now, to === "held" ? (next.next ?? null) : null);
  const event = appendEvent(db, {
    source,
    kind: `auto_merge.${to}`,
    runId: row.run_id,
    taskId: row.task_id,
    payload: { auto_merge: row.id, from: row.state, head: row.head_sha, request: next.request_id, verification: next.verification_id, merge: next.merge_id, reason: next.reason, detail: next.detail },
    ts: now,
  });
  refreshReadyLine(db, next);
  return { row: next, seq: event.seq };
}

/** What a ship delivered, as the auto-merge needs it. */
export interface AutoMergeDelivery {
  /** The canonical PR URL, or local:<branch>. */
  ref: string;
  head: string;
  prNumber: number | null;
  headRef: string | null;
  /** Local-only work: the worktree whose HEAD is verified. */
  worktree: string | null;
  /** Who started the row: the deliver verb (cli, the default) or the landing queue (daemon). */
  source?: EventSource;
}

function isYolo(db: Db, taskId: string): boolean {
  return (db.query("SELECT yolo FROM task_policy WHERE task_id = ?1").get(taskId) as { yolo: number } | null)?.yolo === 1;
}

function projectYolo(db: Db, projectId: string): boolean {
  return (db.query("SELECT yolo FROM projects WHERE id = ?1").get(projectId) as { yolo: number } | null)?.yolo === 1;
}

/** Whether the project auto-merges: `auto_merge`, else its yolo posture (src/verify/config.ts). */
export function autoMergeOn(db: Db, config: FlowrynConfig, projectId: string): boolean {
  return autoMergeEnabled(config, projectId, projectYolo(db, projectId));
}

function optedIn(db: Db, config: FlowrynConfig, projectId: string): boolean {
  try {
    return autoMergeOn(db, config, projectId);
  } catch {
    // An invalid [projects.<id>] table: the daemon refused that config, and nothing merges by itself on it.
    return false;
  }
}

function autoVerifies(config: FlowrynConfig, projectId: string): boolean {
  try {
    return autoVerifyEnabled(config, projectId);
  } catch {
    return false;
  }
}

/**
 * The delivery's auto-merge, in the deliver transaction: a live row of the
 * run is superseded (a redelivery), and an opted-in, yolo, non-sensitive ship
 * gets a new one, following a verify of this head that passed, is running or
 * is queued, or else queuing one (source auto). Any other ship on a project
 * with verify steps gets an auto-verify (startAutoVerify). Returns the new row, if any.
 */
export function startAutoMerge(db: Db, config: FlowrynConfig, run: RunWithPolicy, d: AutoMergeDelivery, now: number): AutoMergeRow | null {
  supersedeAutoMerge(db, run.id, "redelivered", `delivered again at ${d.head.slice(0, 8)}`, now, "cli");
  // A stacked run cannot merge until the task beneath it lands; its delivery after the retarget starts one.
  if (run.kind !== "ship" || run.stacked_on) return null;
  if (!run.sensitive && isYolo(db, run.task_id) && optedIn(db, config, run.project_id)) return createAutoMerge(db, config, run, d, now);
  return startAutoVerify(db, config, run, d, now);
}

/**
 * A delivery that does not auto-merge (approval work, sensitive work, a project
 * that opted out, or one the landing queue lands) still has its verify queued
 * by itself, when the project has verify steps and does not set
 * `auto_verify = false`: a `merge = 0` row. The caller
 * has superseded any live row. Call inside the deliver transaction.
 */
export function startAutoVerify(db: Db, config: FlowrynConfig, run: RunWithPolicy, d: AutoMergeDelivery, now: number): AutoMergeRow | null {
  if (run.kind !== "ship" || run.stacked_on || !autoVerifies(config, run.project_id)) return null;
  return createAutoMerge(db, config, run, d, now, { merge: false });
}

/** Supersede the run's live row, if any. Call inside a transaction. */
export function supersedeAutoMerge(db: Db, runId: string, reason: string, detail: string, now: number, source: EventSource = "daemon"): void {
  const live = liveAutoMerge(db, runId);
  if (live) move(db, live, "superseded", { reason, detail }, now, source);
}

/**
 * A new row for the delivered head, whoever asked (a delivery on an opted-in
 * project, or the landing queue's head of line, approved or routine): it
 * follows a verify of this head that passed, is running or is queued, or else
 * queues one (source auto). The caller has superseded any live row. Call
 * inside a transaction.
 */
export function createAutoMerge(db: Db, config: FlowrynConfig, run: RunWithPolicy, d: AutoMergeDelivery, now: number, opts: { merge?: boolean } = {}): AutoMergeRow {
  const merge = opts.merge ?? true;
  const policy = verifyPolicyId(verifyConfig(config, run.project_id)!);
  const next = Number(getMeta(db, "next_auto_merge_no") ?? "1");
  setMeta(db, "next_auto_merge_no", String(next + 1));
  const id = `am${next}`;
  const { state, requestId, verificationId } = verifyOfHead(db, run, policy, d, merge, now);
  db.query(
    `INSERT INTO auto_merges (id, run_id, task_id, project_id, ref, head_sha, state, request_id, verification_id, created_at, state_since, updated_at, merge)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?10, ?11)`,
  ).run(id, run.id, run.task_id, run.project_id, d.ref, d.head, state, requestId, verificationId, now, merge ? 1 : 0);
  appendEvent(db, { source: d.source ?? "cli", kind: "auto_merge.started", runId: run.id, taskId: run.task_id, payload: { auto_merge: id, ref: d.ref, head: d.head, state, request: requestId, verification: verificationId, policy, merge }, ts: now });
  const row = getAutoMerge(db, id)!;
  refreshReadyLine(db, row);
  return row;
}

/** Where a verify of `d.head` under `policy` stands: a pass to wait on checks after (or, for a row that only verifies, `verified`), a run to follow, or a queued request (joined, else made with source auto). Call inside a transaction. */
function verifyOfHead(
  db: Db,
  run: Pick<RunWithPolicy, "project_id" | "task_id">,
  policy: string,
  d: Pick<AutoMergeDelivery, "ref" | "head" | "prNumber" | "headRef" | "worktree">,
  merge: boolean,
  now: number,
): { state: "queued" | "verifying" | "waiting_checks" | "verified"; requestId: string | null; verificationId: string | null; made: boolean } {
  const passed = finishedAtHead(db, d.ref, d.head, policy);
  if (passed?.state === "passed") return { state: merge ? "waiting_checks" : "verified", requestId: null, verificationId: passed.id, made: false };
  const running = runningVerifications(db).find((v) => v.pr_url === d.ref && v.head_sha === d.head && v.policy_id === policy);
  if (running) return { state: "verifying", requestId: null, verificationId: running.id, made: false };
  const queued = findQueued(db, d.ref, d.head, policy);
  if (queued) return { state: "queued", requestId: queued.id, verificationId: null, made: false };
  const request = insertRequest(db, {
    project_id: run.project_id,
    pr_url: d.ref,
    task_id: run.task_id,
    head_sha: d.head,
    policy_id: policy,
    pr_number: d.prNumber,
    head_ref: d.headRef,
    worktree: d.worktree,
    source: "auto",
    path: autoVerifyPath(db, run.project_id),
    now,
  });
  return { state: "queued", requestId: request.id, verificationId: null, made: true };
}

// --- releasing a hold -----------------------------------------------------------------------

/** Holds a later passing verify at the row's head ends: the verify itself was what stopped it. */
export const VERIFY_HOLDS: readonly string[] = ["verify_failed", "verify_timeout", "verify_error", "verify_cancelled"];

/** The reason a released row that belonged to a landing-queue entry is superseded with: the queue takes the head again. */
export const HOLD_RELEASED = "hold_released";

/**
 * The passing verify that releases a held row, or null: the row is its run's
 * newest, held for its verify, the run is still ready with this head
 * delivered, and a verify of exactly this head under the project's current
 * policy passed (any source: the leader's `flowryn verify`, a recovery, the
 * queue) after the hold. The merge gates are unchanged: the row goes back to
 * waiting on checks and merges through the merge verb's path as before.
 */
export function releasingVerify(db: Db, config: FlowrynConfig, row: AutoMergeRow): Verification | null {
  if (row.state !== "held" || !VERIFY_HOLDS.includes(row.reason ?? "")) return null;
  if (latestAutoMerge(db, row.run_id)?.id !== row.id) return null;
  const run = getRunWithPolicy(db, row.run_id);
  if (!run || run.state !== "ready" || deliveredOf(db, row.task_id)?.head !== row.head_sha) return null;
  let policy: string;
  try {
    const verify = verifyConfig(config, row.project_id);
    if (!verify) return null;
    policy = verifyPolicyId(verify);
  } catch {
    // An invalid [projects.<id>] table: nothing resumes on it.
    return null;
  }
  const passed = finishedAtHead(db, row.ref, row.head_sha, policy);
  if (passed?.state !== "passed" || (passed.finished_at ?? 0) < row.state_since) return null;
  return passed;
}

function heldRows(db: Db): AutoMergeRow[] {
  return db.query("SELECT * FROM auto_merges WHERE state = 'held' ORDER BY created_at, CAST(substr(id, 3) AS INTEGER)").all() as AutoMergeRow[];
}

/**
 * Release every held row a later passing verify at its head ends, with one
 * auto_merge.hold_released event each, and resolve its auto_merge_held item.
 * A row that merges goes back to waiting_checks (one that only verifies ends
 * verified), unless it was a landing-queue entry's: that entry left the line
 * when it held, so the row is superseded and the queue takes the head again on
 * its pass (enqueueReady). Call inside a transaction. Returns the rows released.
 */
export function releaseHolds(db: Db, config: FlowrynConfig, now: number): string[] {
  const released: string[] = [];
  for (const row of heldRows(db)) {
    const passed = releasingVerify(db, config, row);
    if (!passed) continue;
    const landing = db.query("SELECT id FROM landing_queue WHERE auto_merge_id = ?1 ORDER BY enqueued_at DESC LIMIT 1").get(row.id) as { id: string } | null;
    const to: AutoMergeState = landing ? "superseded" : row.merge === 0 ? "verified" : "waiting_checks";
    appendEvent(db, {
      source: "daemon",
      kind: "auto_merge.hold_released",
      runId: row.run_id,
      taskId: row.task_id,
      payload: { auto_merge: row.id, head: row.head_sha, held: row.reason, verification: passed.id, to, landing: landing?.id ?? null },
      ts: now,
    });
    if (landing) move(db, row, "superseded", { reason: HOLD_RELEASED, detail: `verify ${passed.id} passed at ${row.head_sha.slice(0, 8)} after the hold; the landing queue takes it again` }, now);
    else move(db, row, to, { verification_id: passed.id, reason: null, detail: null }, now);
    resolveRunItems(db, row.run_id, ["auto_merge_held", "verify_failed"], "auto_merge.hold_released", now);
    released.push(row.id);
  }
  return released;
}

// --- the controller -------------------------------------------------------------------------

/** What a held row's next command adds after the verify: the merge, for a row that merges. */
function thenMerge(row: AutoMergeRow): string {
  return row.merge === 0 ? "" : `, then flowryn merge ${row.task_id}`;
}

export { sendBackText, verifyVerdict, type VerifyVerdict } from "./route.ts";

/**
 * Codes the merge gate refuses with that only mean "not yet": the next pass
 * tries again. A head that moved is a worker mid-redelivery; the watcher's
 * next read of the PR makes fromWaitingChecks wait on it, bounded by HEAD_MOVED_WAIT_MS
 * from when the row first saw the move.
 */
const RETRY_CODES = new Set(["checks_pending", "forge_unavailable", "merge_in_flight", "not_ready", "head_moved"]);

/** The landing queue as the controller drives it (src/verify/landing-queue.ts). */
export interface LandingHooks {
  /** Advance every project's line: before the rows (a new head of line), and after (the next one, once a row merged). */
  pass(): Promise<void>;
  /** Whether a row may merge now; false when its base moved past it and the queue sent it back to integrate. */
  beforeMerge(row: AutoMergeRow): Promise<boolean>;
}

export interface AutoMergerDeps extends MergeServices {
  /** A sent-back ship's last stage waits for a grant: the scheduler looks now. */
  kickScheduler(): void;
  landing?: LandingHooks;
  /** Whether the project's default branch declares `no_ci: true` (.no-mistakes.yaml); absent or unreadable: no. */
  noCi?(projectId: string): Promise<boolean>;
  /** A steer was made for this run (a leader's failed verify sent to a working ship): carry it now. */
  notify?(runId: string): void;
  /** The fallback pass interval (AUTO_MERGE_TICK_MS). */
  tickMs?: number;
}

export class AutoMerger {
  private readonly deps: AutoMergerDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(deps: AutoMergerDeps) {
    this.deps = deps;
  }

  start(): void {
    this.timer = setInterval(() => this.kick(), this.deps.tickMs ?? AUTO_MERGE_TICK_MS);
    this.kick();
  }

  /** Stop the timer and kicks; resolves once a pass under way has ended (the daemon closes the database after). */
  stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this.running ?? Promise.resolve();
  }

  /** Advance every live row now; a pass in progress is followed by another. */
  kick(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.pass().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        this.kick();
      }
    });
  }

  private async noCi(projectId: string): Promise<boolean> {
    if (!this.deps.noCi) return false;
    try {
      return await this.deps.noCi(projectId);
    } catch (error) {
      this.deps.log(`auto-merge: reading project ${projectId}'s no_ci failed: ${(error as Error).message}`);
      return false;
    }
  }

  /** One pass over the live rows. Exposed for tests. */
  async pass(): Promise<void> {
    if (this.stopped) return;
    try {
      tx(this.deps.db, () => releaseHolds(this.deps.db, this.deps.config(), this.deps.now()));
    } catch (error) {
      this.deps.log(`auto-merge: releasing holds: ${(error as Error).stack ?? String(error)}`);
    }
    await this.landingPass();
    for (const row of liveAutoMerges(this.deps.db)) {
      if (this.stopped) return;
      try {
        await this.advance(row);
      } catch (error) {
        this.deps.log(`auto-merge ${row.id}: ${(error as Error).stack ?? String(error)}`);
      }
    }
    // A leader's own `flowryn verify` that failed is routed the same way (src/verify/route.ts).
    try {
      routeManualVerifies({ db: this.deps.db, config: this.deps.config, now: this.deps.now, log: this.deps.log, kickScheduler: this.deps.kickScheduler, notify: this.deps.notify });
    } catch (error) {
      this.deps.log(`verify route: ${(error as Error).stack ?? String(error)}`);
    }
    await this.landingPass();
  }

  private async landingPass(): Promise<void> {
    if (!this.deps.landing || this.stopped) return;
    try {
      await this.deps.landing.pass();
    } catch (error) {
      this.deps.log(`landing queue: ${(error as Error).stack ?? String(error)}`);
    }
  }

  /** Move one row as far as it goes now. */
  async advance(start: AutoMergeRow): Promise<void> {
    let row: AutoMergeRow | null = start;
    // Each step either waits (returns the row unchanged) or moves it; a few moves can happen in one pass.
    for (let i = 0; i < 6 && row && LIVE_AUTO_MERGE_STATES.includes(row.state); i++) {
      const before: AutoMergeRow = row;
      row = await this.step(before);
      if (row && row.state === before.state && row.updated_at === before.updated_at) return;
    }
  }

  private async step(row: AutoMergeRow): Promise<AutoMergeRow | null> {
    const { db } = this.deps;
    const now = this.deps.now();
    const fresh = getAutoMerge(db, row.id);
    if (!fresh || !LIVE_AUTO_MERGE_STATES.includes(fresh.state)) return null;
    const ended = this.supersededBy(fresh);
    if (ended) return tx(db, () => this.end(fresh, ended, now));
    switch (fresh.state) {
      case "queued":
        return tx(db, () => this.fromQueued(fresh, now));
      case "verifying":
        return tx(db, () => this.fromVerifying(fresh, now));
      case "waiting_checks":
        return this.fromWaitingChecks(fresh, now);
      case "merging":
        return tx(db, () => this.fromMerging(fresh, now));
      default:
        return null;
    }
  }

  /** Why a live row no longer applies, or null. A landed run is ended by end() as merged or superseded. */
  private supersededBy(row: AutoMergeRow): string | null {
    const { db } = this.deps;
    const run = getRunWithPolicy(db, row.run_id);
    if (!run) return "the run is gone";
    if (run.state === "landed" || run.state === "cleaned") return "landed";
    if (isTerminal(run.state)) return `the run is ${run.state}`;
    if (row.state !== "merging" && run.state === "merging") return `merge ${latestMerge(db, run.task_id)?.id ?? "-"} was asked for by hand`;
    if (row.state !== "merging" && run.state !== "ready") return `the run is ${run.state} (sent back)`;
    const delivered = deliveredOf(db, run.task_id);
    if (!delivered || delivered.head !== row.head_sha) return "redelivered";
    // An auto-verify lasts while the project has verify steps (an invalid config keeps the last good one).
    if (row.merge === 0) {
      try {
        return verifyConfig(this.deps.config(), row.project_id) ? null : `project ${row.project_id} has no verify steps now`;
      } catch {
        return null;
      }
    }
    // The landing queue's head of line: the queue ends it when the project leaves the queue.
    if (db.query("SELECT 1 FROM landing_queue WHERE auto_merge_id = ?1 AND state = 'landing'").get(row.id)) return null;
    // Unattended mode started it (src/attention/autonomy-pass.ts): it lasts while the standing approval covers the project.
    if (autonomyForRun(db, run, this.deps.now())) return null;
    let enabled: boolean;
    try {
      enabled = autoMergeOn(db, this.deps.config(), row.project_id);
    } catch {
      // The daemon refuses an invalid config and keeps the last good one; this one is what it runs.
      return null;
    }
    return enabled ? null : `auto_merge is off for project ${row.project_id}`;
  }

  private end(row: AutoMergeRow, why: string, now: number): AutoMergeRow {
    if (why === "landed") {
      const merge = row.merge_id ? (this.deps.db.query("SELECT * FROM merges WHERE id = ?1").get(row.merge_id) as MergeRow | null) : null;
      if (merge?.state === "merged") return move(this.deps.db, row, "merged", {}, now).row;
      const by = latestMerge(this.deps.db, row.task_id);
      return move(this.deps.db, row, "superseded", { reason: "landed", detail: by && by.id !== row.merge_id ? `landed through merge ${by.id}` : "landed outside the auto-merge" }, now).row;
    }
    return move(this.deps.db, row, "superseded", { reason: why === "redelivered" ? "redelivered" : "superseded", detail: why }, now).row;
  }

  /** Hold the row and open auto_merge_held for the leader. Call inside a transaction. */
  private hold(row: AutoMergeRow, reason: string, detail: string, next: string, now: number): AutoMergeRow {
    const { db } = this.deps;
    const held = move(db, row, "held", { reason, detail, next }, now);
    if (!findOpenRunItem(db, "auto_merge_held", row.run_id)) {
      openItem(db, { kind: "auto_merge_held", eventSeq: held.seq, taskId: row.task_id, runId: row.run_id, line: `${row.merge === 0 ? "Auto-verify" : "Auto-merge"} held: ${taskTitle(db, row.task_id)} (${row.task_id}): ${sanitizeLine(detail, HELD_DETAIL_CHARS)}; ${next}`, now });
    }
    return held.row;
  }

  private fromQueued(row: AutoMergeRow, now: number): AutoMergeRow {
    const request = row.request_id ? getRequest(this.deps.db, row.request_id) : null;
    if (!request) return this.requeueLost(row, "verify_cancelled", `its verify request ${row.request_id ?? "-"} is gone`, null, now);
    if (request.state === "cancelled") {
      // A closed PR, a project gone or without verify steps: no new request gets further.
      if (cancelIsFinal(request.detail)) return this.hold(row, "verify_cancelled", `its verify request ${request.id} was cancelled: ${request.detail ?? "no reason"}`, `flowryn show ${row.task_id}`, now);
      return this.requeueLost(row, "verify_cancelled", `its verify request ${request.id} was cancelled: ${request.detail ?? "no reason"}`, request, now);
    }
    if (request.state === "started" && request.verification_id) return move(this.deps.db, row, "verifying", { verification_id: request.verification_id }, now).row;
    // Still queued: its place in line may have moved.
    if (refreshReadyLine(this.deps.db, row)) {
      const place = positionOf(this.deps.db, request.id);
      appendEvent(this.deps.db, {
        source: "daemon",
        kind: "auto_merge.queue_moved",
        runId: row.run_id,
        taskId: row.task_id,
        payload: { auto_merge: row.id, request: request.id, position: place?.position ?? null, of: place?.of ?? null },
        ts: now,
      });
    }
    return row;
  }

  /**
   * The verify the row waited on ended without a verdict (cancelled, gone, cut off by a stop): queue one
   * of the current head now, with one auto_merge.verify_requeued event saying why, rather than wait on a
   * request nothing will run. GitHub reading an older delivered head (a carry it has not caught up with)
   * verifies the same head again; a head that really moved has its verify queued and supersedes the row
   * (its delivery starts a new one, the watcher's head-moved item tells the leader if none comes).
   * MAX_VERIFY_REQUEUES at most per row, then it holds. Call inside a transaction.
   */
  private requeueLost(row: AutoMergeRow, reason: "verify_cancelled" | "verify_error", lost: string, from: VerifyRequest | null, now: number): AutoMergeRow {
    const { db } = this.deps;
    const next = `flowryn verify ${row.task_id}${thenMerge(row)}`;
    const requeues = requeueCount(db, row.id);
    if (requeues >= MAX_VERIFY_REQUEUES) return this.hold(row, reason, `${lost}, after ${requeues} verifies queued again for it`, next, now);
    let verify: ReturnType<typeof verifyConfig>;
    try {
      verify = verifyConfig(this.deps.config(), row.project_id);
    } catch (error) {
      return this.hold(row, reason, `${lost}, and the [projects.${row.project_id}] config is invalid: ${(error as Error).message}`, `flowryn config`, now);
    }
    if (!verify) return this.hold(row, reason, `${lost}, and project ${row.project_id} has no verify steps now`, `flowryn show ${row.task_id}`, now);
    const policy = verifyPolicyId(verify);
    const run = getRunWithPolicy(db, row.run_id)!;
    const evidence = prEvidence(db, row.run_id);
    const where = {
      ref: row.ref,
      prNumber: from?.pr_number ?? evidence?.number ?? null,
      headRef: from?.head_ref ?? evidence?.head_ref ?? null,
      worktree: from?.worktree ?? (row.ref.startsWith("local:") ? run.worktree_path : null),
    };
    const to = headMovedTo(from?.detail ?? null);
    const stale = to !== null && staleRead(db, { task_id: row.task_id, head_sha: row.head_sha }, to);
    if (to !== null && !stale && evidence?.head === row.head_sha) return row;
    const moved = to !== null && !stale && evidence && !staleRead(db, { task_id: row.task_id, head_sha: row.head_sha }, evidence.head) ? evidence.head : null;
    const head = moved ?? row.head_sha;
    const verified = verifyOfHead(db, run, policy, { ...where, head }, row.merge !== 0, now);
    appendEvent(db, {
      source: "daemon",
      kind: "auto_merge.verify_requeued",
      runId: row.run_id,
      taskId: row.task_id,
      payload: { auto_merge: row.id, lost: from?.id ?? (reason === "verify_error" ? row.verification_id : row.request_id), why: lost, head, state: verified.state, request: verified.requestId, verification: verified.verificationId, made: verified.made, attempt: requeues + 1 },
      ts: now,
    });
    if (verified.made) this.deps.kickScheduler();
    if (moved) {
      const at = verified.state === "queued" ? `queued (${verified.requestId})` : `${verified.state === "verifying" ? "running" : "passed"} (${verified.verificationId})`;
      return move(db, row, "superseded", { reason: "head_moved", detail: `the PR head moved to ${moved.slice(0, 8)} after ${lost}; its verify is ${at}, and a delivery of it starts a new auto-merge` }, now).row;
    }
    return move(db, row, verified.state, { request_id: verified.requestId, verification_id: verified.verificationId }, now).row;
  }

  private fromVerifying(row: AutoMergeRow, now: number): AutoMergeRow {
    const { db } = this.deps;
    const v = row.verification_id ? getVerification(db, row.verification_id) : null;
    if (!v) return this.requeueLost(row, "verify_error", `its verification ${row.verification_id ?? "-"} is gone`, null, now);
    if (v.state === "running") return row;
    if (v.state === "passed") return move(db, row, row.merge === 0 ? "verified" : "waiting_checks", {}, now).row;
    // Interrupted by a daemon stop: startup recovery queued it again once (phase 1); follow that request.
    const requeued = v.state === "error" ? requeuedFrom(db, v.id) : null;
    if (requeued) return move(db, row, "queued", { request_id: requeued.id, verification_id: null }, now).row;
    // Interrupted again (the rerun was itself stopped): the work was never judged, so it is queued once more.
    if (v.state === "error" && interruptedByStop(v)) return this.requeueLost(row, "verify_error", `its verification ${v.id} was cut off by a daemon stop (${v.detail ?? "no detail"})`, null, now);
    const run = getRunWithPolicy(db, row.run_id)!;
    const label = row.merge === 0 ? "auto-verify" : "auto-merge";
    const next = `flowryn verify show ${v.id}; once fixed: flowryn verify ${row.task_id}${thenMerge(row)}`;
    let route = routeVerifyOutcome(db, v, run);
    if (route.route === "none") return row;
    if (route.route === "rerun") {
      try {
        const request = queueAutoRerun(db, this.deps.config(), v, route.step, row.run_id, now);
        this.deps.kickScheduler();
        return move(db, row, "queued", { request_id: request.id, verification_id: null }, now).row;
      } catch (error) {
        route = { route: "escalate", code: "verify_timeout", detail: `verify ${v.id} timed out in \`${route.step.name}\`, and no re-run could be queued: ${(error as Error).message}`, step: route.step };
      }
    }
    if (route.route === "escalate") {
      recordEscalation(db, v, route, row.run_id, "auto_merge", now, { auto_merge: row.id });
      return this.hold(row, route.code, route.detail, next, now);
    }
    const step = route.step;
    sendBack(
      db,
      run,
      {
        text: sendBackText(v, step, row.merge === 0 ? "Auto-verify" : "Auto-merge"),
        feedback: `${label} verify ${v.id} failed`,
        why: `the ${label}'s verify ${v.id} failed`,
        event: { source: "daemon", kind: SENT_BACK_KIND, payload: sentBackPayload(v, step, "auto_merge", { auto_merge: row.id }) },
      },
      now,
    );
    const sent = move(db, row, "sent_back", { reason: "verify_failed", detail: `verify ${v.id} failed: \`${step.name}\` exited ${step.exit}` }, now).row;
    this.deps.kickScheduler();
    return sent;
  }

  private async fromWaitingChecks(row: AutoMergeRow, now: number): Promise<AutoMergeRow> {
    const { db } = this.deps;
    const delivered = deliveredOf(db, row.task_id);
    if (delivered?.kind === "pr") {
      const pr = prEvidence(db, row.run_id);
      const seen = pr ? evidenceHead(db, row, pr) : "delivered";
      if (seen === "stale") return row;
      // The worker pushed past the delivered head: its redelivery supersedes this row.
      if (pr && seen === "moved") {
        const since = tx(db, () => headMovedSince(db, row, pr.head, now));
        if (now - since <= HEAD_MOVED_WAIT_MS) return row;
        return tx(db, () => this.hold(row, "head_moved", `the PR head moved from ${row.head_sha.slice(0, 8)} (delivered) to ${pr.head.slice(0, 8)} over ${HEAD_MOVED_WAIT_MS / 60_000} min ago, and nothing was delivered since`, `flowryn steer ${row.task_id} --body-file -`, now));
      }
      if (pr && checksPending(pr)) {
        const limit = (await this.noCi(row.project_id)) ? NO_CI_CHECKS_WAIT_MS : CHECKS_WAIT_MS;
        if (now - row.state_since <= limit) return row;
        return tx(db, () => this.hold(row, "checks_timeout", `GitHub's checks have been pending for over ${limit / 3_600_000} h (${pr.checks!.pending.join(", ") || pr.checks!.line})`, `flowryn show ${row.task_id}; once they finish: flowryn merge ${row.task_id}`, now));
      }
    }
    if (this.deps.landing && !(await this.deps.landing.beforeMerge(row))) return getAutoMerge(db, row.id) ?? row;
    return this.merge(row);
  }

  /** The merge, through the merge verb's own path with the daemon as caller (channel yolo). */
  private async merge(row: AutoMergeRow): Promise<AutoMergeRow> {
    const { db } = this.deps;
    let applied: HandlerResult | null;
    try {
      const prepared = await prepareDaemonMerge(this.deps, row.task_id);
      applied = tx(db, () => {
        const fresh = getAutoMerge(db, row.id);
        if (fresh?.state !== "waiting_checks") return null;
        const result = applyMerge(this.deps, prepared, DAEMON_CALLER);
        if (result.data.merge) move(db, fresh, "merging", { merge_id: String(result.data.merge) }, this.deps.now());
        return result;
      });
    } catch (error) {
      if (!(error instanceof FlowrynError)) throw error;
      // A stale read is put on record as the verb's refusal is; the next pass reads again.
      const event = error.refusalEvent;
      if (event) {
        tx(db, () => appendEvent(db, event));
        return row;
      }
      if (RETRY_CODES.has(error.code)) {
        if (error.code !== "head_moved") return row;
        const now = this.deps.now();
        const since = tx(db, () => headMovedSince(db, row, prEvidence(db, row.run_id)?.head ?? null, now));
        if (now - since <= HEAD_MOVED_WAIT_MS) return row;
      }
      return tx(db, () => {
        const fresh = getAutoMerge(db, row.id);
        if (fresh?.state !== "waiting_checks") return fresh ?? row;
        return this.hold(fresh, error.code, error.message, error.help ?? `flowryn show ${row.task_id}`, this.deps.now());
      });
    }
    if (!applied) return getAutoMerge(db, row.id) ?? row;
    try {
      await settleMerge(this.deps, applied, DAEMON_CALLER);
    } catch (error) {
      // merge_refused and not_landed are read back from the merges row below.
      if (!(error instanceof FlowrynError)) throw error;
    }
    const after = getAutoMerge(db, row.id) ?? row;
    // GitHub already read it merged: the run landed outside this merge.
    if (applied.data.merged !== undefined) return after;
    return after.state === "merging" ? tx(db, () => this.fromMerging(after, this.deps.now())) : after;
  }

  private fromMerging(row: AutoMergeRow, now: number): AutoMergeRow {
    const { db } = this.deps;
    const merge = row.merge_id ? (db.query("SELECT * FROM merges WHERE id = ?1").get(row.merge_id) as MergeRow | null) : null;
    if (!merge) return this.hold(row, "merge_refused", `its merge ${row.merge_id ?? "-"} is gone`, `flowryn show ${row.task_id}`, now);
    if (merge.state === "merged") return move(db, row, "merged", {}, now).row;
    if (merge.state === "refused") return this.hold(row, "merge_refused", `merge ${merge.id} was refused: ${merge.detail ?? "no detail"}`, `flowryn show ${row.task_id}`, now);
    // requested or unproven: the watcher keeps proving it, and unproven_merge says so.
    return row;
  }
}
