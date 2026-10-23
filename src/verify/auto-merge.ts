import { homedir } from "node:os";
import { join } from "node:path";
import { FlowrynError } from "../api/errors.ts";
import type { HandlerResult } from "../api/verbs.ts";
import { findOpenRunItem, itemLines, openItem } from "../attention/items.ts";
import type { FlowrynConfig } from "../config/config.ts";
import { getMeta, setMeta, tx, type Db } from "../db/db.ts";
import { appendEvent, type EventSource } from "../db/events.ts";
import { deliveredOf, prEvidence } from "../lifecycle/delivery.ts";
import { getRunWithPolicy, isTerminal, taskTitle, type RunWithPolicy } from "../lifecycle/runs.ts";
import { sendBack } from "../lifecycle/send-back.ts";
import { DAEMON_CALLER, latestMerge, type MergeRow } from "../policy/merge.ts";
import { applyMerge, prepareDaemonMerge, settleMerge, type MergeServices } from "../policy/merge-path.ts";
import { sanitizeBlock } from "../util/sanitize.ts";
import { autoMergeEnabled, verifyConfig } from "./config.ts";
import { verifyPolicyId } from "./policy.ts";
import { findQueued, getRequest, insertRequest, positionOf, requeuedFrom } from "./queue.ts";
import { readTail } from "./runner.ts";
import { finishedAtHead, getVerification, runningVerifications, type Verification, type VerifyStep } from "./store.ts";

/**
 * Yolo auto-merge (docs/notes/2026-10-22-daemon-run-verify-y3.md, phase 2):
 * a project with `[projects.<id>] auto_merge = true` has the daemon verify and
 * merge its yolo, non-sensitive deliveries with no leader turn. One row per
 * delivery (`auto_merges`), started in the deliver transaction and driven by
 * plain code:
 *
 *   queued → verifying → waiting_checks → merging → merged
 *
 * A verify step that exits non-zero sends the ship back to its worker once
 * per head with the step and its tail (sent_back); a timeout, an error, a
 * second failure at the head, checks pending over 6 h, or a merge-gate refusal
 * holds it (auto_merge_held, a P1 that wakes the leader). A run that is sent
 * back, cancelled or redelivered, or a project that turns it off, supersedes
 * the row. The merge is the `merge` verb's own path (src/policy/merge-path.ts)
 * with the daemon as caller, so it takes the yolo channel and the gate is
 * unchanged. No model is involved.
 */

export const AUTO_MERGE_STATES = ["queued", "verifying", "waiting_checks", "merging", "merged", "held", "superseded", "sent_back"] as const;
export type AutoMergeState = (typeof AUTO_MERGE_STATES)[number];
export const LIVE_AUTO_MERGE_STATES: readonly AutoMergeState[] = ["queued", "verifying", "waiting_checks", "merging"];

/** How long a passed verify waits on GitHub's checks before the auto-merge is held. */
export const CHECKS_WAIT_MS = 6 * 60 * 60_000;
/** The controller's fallback pass; a finished verify, a watcher pass and a delivery kick it sooner. */
export const AUTO_MERGE_TICK_MS = 60_000;
/** Lines of a failed step's output a send-back carries. */
const SEND_BACK_TAIL_LINES = 40;
/** What joins the pr_ready line and the auto-merge's progress. */
const READY_SEPARATOR = "; auto-merge: ";

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
    default:
      return null;
  }
}

/** Keep the run's open pr_ready line ending in the auto-merge's progress. Call inside a transaction. */
function refreshReadyLine(db: Db, row: AutoMergeRow): void {
  const item = findOpenRunItem(db, "pr_ready", row.run_id);
  if (!item) return;
  const base = (item.full_line ?? item.line).split(READY_SEPARATOR)[0]!;
  const progress = progressOf(db, row);
  const lines = itemLines(progress ? `${base}${READY_SEPARATOR}${progress}` : base);
  if (lines.line === item.line && lines.full_line === item.full_line) return;
  db.query("UPDATE items SET line = ?2, full_line = ?3 WHERE id = ?1").run(item.id, lines.line, lines.full_line);
}

interface MoveFields {
  request_id?: string | null;
  verification_id?: string | null;
  merge_id?: string | null;
  reason?: string | null;
  detail?: string | null;
}

/** Move a row to `to` with its `auto_merge.<to>` event. Call inside a transaction. */
function move(db: Db, row: AutoMergeRow, to: AutoMergeState, fields: MoveFields, now: number, source: EventSource = "daemon"): { row: AutoMergeRow; seq: number } {
  const next: AutoMergeRow = { ...row, ...fields, state: to, state_since: to === row.state ? row.state_since : now, updated_at: now };
  db.query(
    `UPDATE auto_merges SET state = ?2, request_id = ?3, verification_id = ?4, merge_id = ?5, reason = ?6, detail = ?7, state_since = ?8, updated_at = ?9 WHERE id = ?1`,
  ).run(row.id, to, next.request_id, next.verification_id, next.merge_id, next.reason, next.detail, next.state_since, now);
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

/** The PATH a daemon-made verify runs its steps with: the project's latest `flowryn verify` caller's, else the daemon's plus ~/.bun/bin. */
export function autoVerifyPath(db: Db, projectId: string, env: NodeJS.ProcessEnv = process.env): string {
  const kept = getMeta(db, `verify_path:${projectId}`);
  if (kept) return kept;
  return [env.PATH, join(homedir(), ".bun", "bin")].filter((dir): dir is string => Boolean(dir)).join(":");
}

/** Remember a CLI verify's PATH for the project's daemon-made verifies. Call inside a transaction. */
export function rememberVerifyPath(db: Db, projectId: string, path: string): void {
  if (path.length > 0) setMeta(db, `verify_path:${projectId}`, path);
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
}

function isYolo(db: Db, taskId: string): boolean {
  return (db.query("SELECT yolo FROM task_policy WHERE task_id = ?1").get(taskId) as { yolo: number } | null)?.yolo === 1;
}

function optedIn(config: FlowrynConfig, projectId: string): boolean {
  try {
    return autoMergeEnabled(config, projectId);
  } catch {
    // An invalid [projects.<id>] table: the daemon refused that config, and nothing merges by itself on it.
    return false;
  }
}

/**
 * The delivery's auto-merge, in the deliver transaction: a live row of the
 * run is superseded (a redelivery), and an opted-in, yolo, non-sensitive ship
 * gets a new one, following a verify of this head that passed, is running or
 * is queued, or else queuing one (source auto). Returns the new row, if any.
 */
export function startAutoMerge(db: Db, config: FlowrynConfig, run: RunWithPolicy, d: AutoMergeDelivery, now: number): AutoMergeRow | null {
  const live = liveAutoMerge(db, run.id);
  if (live) move(db, live, "superseded", { reason: "redelivered", detail: `delivered again at ${d.head.slice(0, 8)}` }, now, "cli");
  if (run.kind !== "ship" || run.sensitive || !isYolo(db, run.task_id) || !optedIn(config, run.project_id)) return null;
  const policy = verifyPolicyId(verifyConfig(config, run.project_id)!);
  const next = Number(getMeta(db, "next_auto_merge_no") ?? "1");
  setMeta(db, "next_auto_merge_no", String(next + 1));
  const id = `am${next}`;
  let state: AutoMergeState = "queued";
  let requestId: string | null = null;
  let verificationId: string | null = null;
  const passed = finishedAtHead(db, d.ref, d.head, policy);
  const running = runningVerifications(db).find((v) => v.pr_url === d.ref && v.head_sha === d.head && v.policy_id === policy);
  if (passed?.state === "passed") {
    state = "waiting_checks";
    verificationId = passed.id;
  } else if (running) {
    state = "verifying";
    verificationId = running.id;
  } else {
    const request =
      findQueued(db, d.ref, d.head, policy) ??
      insertRequest(db, {
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
    requestId = request.id;
  }
  db.query(
    `INSERT INTO auto_merges (id, run_id, task_id, project_id, ref, head_sha, state, request_id, verification_id, created_at, state_since, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?10)`,
  ).run(id, run.id, run.task_id, run.project_id, d.ref, d.head, state, requestId, verificationId, now);
  appendEvent(db, { source: "cli", kind: "auto_merge.started", runId: run.id, taskId: run.task_id, payload: { auto_merge: id, ref: d.ref, head: d.head, state, request: requestId, verification: verificationId, policy }, ts: now });
  const row = getAutoMerge(db, id)!;
  refreshReadyLine(db, row);
  return row;
}

// --- the controller -------------------------------------------------------------------------

/** How a finished verify that did not pass ends the auto-merge. */
export type VerifyVerdict = { sendBack: VerifyStep } | { hold: "verify_failed" | "verify_timeout" | "verify_error"; detail: string };

/**
 * A step that exited non-zero is the worker's to fix (sent back, once per
 * head); a timeout, an error, or a failure with no failing step is held for
 * the leader (the user's answer q78 in the design review).
 */
export function verifyVerdict(v: Verification): VerifyVerdict {
  if (v.state === "error") return { hold: "verify_error", detail: `verify ${v.id} ended in an error: ${v.detail ?? "no detail"}` };
  const step = v.steps.find((s) => s.state === "failed");
  if (step?.detail?.startsWith("timed out")) return { hold: "verify_timeout", detail: `verify ${v.id} timed out in \`${step.name}\`` };
  if (!step || step.exit === null || step.exit === 0) return { hold: "verify_failed", detail: `verify ${v.id} failed: ${v.detail ?? step?.detail ?? "no failing step recorded"}` };
  return { sendBack: step };
}

/** The steer a sent-back ship gets: the failing step, its exit and its last lines. */
export function sendBackText(v: Verification, step: VerifyStep): string {
  const tail = sanitizeBlock(readTail(join(v.dir, step.log), 16 * 1024)).split("\n").slice(-SEND_BACK_TAIL_LINES).join("\n").trimEnd();
  return [
    `Auto-merge: the daemon's flowryn verify ${v.id} of your delivery at ${v.head_sha.slice(0, 8)} failed: step \`${step.name}\` exited ${step.exit}.`,
    tail ? `Its last lines:\n\n${tail}\n` : "It printed nothing.",
    "Fix it, commit, and deliver again. A second failure at the same head goes to your leader instead.",
  ].join("\n");
}

/** Codes the merge gate refuses with that only mean "not yet": the next pass tries again. */
const RETRY_CODES = new Set(["checks_pending", "forge_unavailable", "merge_in_flight", "not_ready"]);

export interface AutoMergerDeps extends MergeServices {
  /** A sent-back ship's last stage waits for a grant: the scheduler looks now. */
  kickScheduler(): void;
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

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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

  /** One pass over the live rows. Exposed for tests. */
  async pass(): Promise<void> {
    for (const row of liveAutoMerges(this.deps.db)) {
      if (this.stopped) return;
      try {
        await this.advance(row);
      } catch (error) {
        this.deps.log(`auto-merge ${row.id}: ${(error as Error).stack ?? String(error)}`);
      }
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
    let enabled: boolean;
    try {
      enabled = autoMergeEnabled(this.deps.config(), row.project_id);
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
    const held = move(db, row, "held", { reason, detail }, now);
    if (!findOpenRunItem(db, "auto_merge_held", row.run_id)) {
      openItem(db, { kind: "auto_merge_held", eventSeq: held.seq, taskId: row.task_id, runId: row.run_id, line: `Auto-merge held: ${taskTitle(db, row.task_id)} (${row.task_id}): ${detail}; ${next}`, now });
    }
    return held.row;
  }

  private fromQueued(row: AutoMergeRow, now: number): AutoMergeRow {
    const request = row.request_id ? getRequest(this.deps.db, row.request_id) : null;
    if (!request) return this.hold(row, "verify_cancelled", `its verify request ${row.request_id ?? "-"} is gone`, `flowryn verify ${row.task_id}, then flowryn merge ${row.task_id}`, now);
    if (request.state === "cancelled") return this.hold(row, "verify_cancelled", `its verify request ${request.id} was cancelled: ${request.detail ?? "no reason"}`, `flowryn show ${row.task_id}`, now);
    if (request.state === "started" && request.verification_id) return move(this.deps.db, row, "verifying", { verification_id: request.verification_id }, now).row;
    // Still queued: its place in line may have moved.
    refreshReadyLine(this.deps.db, row);
    return row;
  }

  private fromVerifying(row: AutoMergeRow, now: number): AutoMergeRow {
    const { db } = this.deps;
    const v = row.verification_id ? getVerification(db, row.verification_id) : null;
    if (!v) return this.hold(row, "verify_error", `its verification ${row.verification_id ?? "-"} is gone`, `flowryn verify ${row.task_id}, then flowryn merge ${row.task_id}`, now);
    if (v.state === "running") return row;
    if (v.state === "passed") return move(db, row, "waiting_checks", {}, now).row;
    // Interrupted by a daemon stop: startup recovery queued it again once (phase 1); follow that request.
    const requeued = v.state === "error" ? requeuedFrom(db, v.id) : null;
    if (requeued) return move(db, row, "queued", { request_id: requeued.id, verification_id: null }, now).row;
    const verdict = verifyVerdict(v);
    const next = `flowryn verify show ${v.id}; once fixed: flowryn verify ${row.task_id}, then flowryn merge ${row.task_id}`;
    if ("hold" in verdict) return this.hold(row, verdict.hold, verdict.detail, next, now);
    const sentBefore = (db.query("SELECT COUNT(*) AS n FROM auto_merges WHERE run_id = ?1 AND head_sha = ?2 AND state = 'sent_back'").get(row.run_id, row.head_sha) as { n: number }).n;
    if (sentBefore > 0) return this.hold(row, "verify_failed", `verify ${v.id} failed again at ${row.head_sha.slice(0, 8)} (\`${verdict.sendBack.name}\` exited ${verdict.sendBack.exit}) after a send-back`, next, now);
    const run = getRunWithPolicy(db, row.run_id)!;
    sendBack(
      db,
      run,
      {
        text: sendBackText(v, verdict.sendBack),
        feedback: `auto-merge verify ${v.id} failed`,
        why: `the auto-merge's verify ${v.id} failed`,
        event: { source: "daemon", kind: "auto_merge.verify_failed", payload: { auto_merge: row.id, verification: v.id, step: verdict.sendBack.name, exit: verdict.sendBack.exit } },
      },
      now,
    );
    const sent = move(db, row, "sent_back", { reason: "verify_failed", detail: `verify ${v.id} failed: \`${verdict.sendBack.name}\` exited ${verdict.sendBack.exit}` }, now).row;
    this.deps.kickScheduler();
    return sent;
  }

  private async fromWaitingChecks(row: AutoMergeRow, now: number): Promise<AutoMergeRow> {
    const { db } = this.deps;
    const delivered = deliveredOf(db, row.task_id);
    if (delivered?.kind === "pr") {
      const pr = prEvidence(db, row.run_id);
      const pending = pr && pr.head === row.head_sha && pr.checks && (pr.checks.state === "pending" || pr.checks.pending.length > 0);
      if (pending) {
        if (now - row.state_since <= CHECKS_WAIT_MS) return row;
        return tx(db, () => this.hold(row, "checks_timeout", `GitHub's checks have been pending for over ${CHECKS_WAIT_MS / 3_600_000} h (${pr.checks!.pending.join(", ") || pr.checks!.line})`, `flowryn show ${row.task_id}; once they finish: flowryn merge ${row.task_id}`, now));
      }
    }
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
      if (RETRY_CODES.has(error.code)) return row;
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
