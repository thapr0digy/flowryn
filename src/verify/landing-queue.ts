import { existsSync } from "node:fs";
import { findOpenRunItem, openItem } from "../attention/items.ts";
import type { FlowrynConfig } from "../config/config.ts";
import { getMeta, setMeta, tx, type Db } from "../db/db.ts";
import { appendEvent, type EventSource } from "../db/events.ts";
import { carryLanding, deliveredOf, prEvidence, type Delivered } from "../lifecycle/delivery.ts";
import { getProject } from "../lifecycle/projects.ts";
import { getRunWithPolicy, isTerminal, runBase, taskTitle, type RunWithPolicy } from "../lifecycle/runs.ts";
import { findHumanApproval, insertApproval, isRoutineMerge, type ApprovalRow } from "../policy/approvals.ts";
import { cleanMainMerge, type CleanMergeStep } from "../policy/clean-merge.ts";
import type { GitRunner } from "../policy/landed.ts";
import { sendConflictBack, settleHeadMove } from "../reconcile/delivery.ts";
import { sanitizeLine } from "../util/sanitize.ts";
import { createAutoMerge, getAutoMerge, setReadyProgress, supersedeAutoMerge, type AutoMergeRow, type LandingHooks } from "./auto-merge.ts";
import { landingQueued, verifyConfig } from "./config.ts";
import { verifyPolicyId } from "./policy.ts";

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
 */

export const LANDING_STATES = ["waiting", "landing", "landed", "left"] as const;
export type LandingState = (typeof LANDING_STATES)[number];
const LIVE_SQL = "state IN ('waiting','landing')";

/** Times one entry is brought up to date with its base before it is held: the base keeps moving under it. */
export const MAX_INTEGRATIONS = 3;
/** A landing fetch or push: the network, not a local read, so longer than the merge proof's git calls. */
export const LANDING_NET_TIMEOUT_MS = 120_000;
/** How long the head of line may wait on a busy worker or a changed worktree before it is held. */
export const BLOCKED_HOLD_MS = 30 * 60_000;
/** The landing merge's message, so `git log` says who made it. */
export function landingMergeMessage(base: string, branch: string): string {
  return `Merge origin/${base} into ${branch} (Flowryn landing queue)`;
}

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

/** What `show` and the pr_ready line say of an entry. */
export function landingProgress(db: Db, row: LandingRow): string {
  if (row.state === "landing") return `landing queue: first in line (${row.id})`;
  if (row.state === "waiting") {
    const place = placeOf(db, row);
    return `landing queue: ${place ? `${place.position} of ${place.of}${place.ahead ? `, behind ${place.ahead}` : ""}` : "waiting"} (${row.id})`;
  }
  return `landing queue ${row.state}${row.reason ? ` (${row.reason})` : ""}${row.detail ? `: ${row.detail}` : ""}`;
}

interface MoveFields {
  head_sha?: string;
  approval_id?: string | null;
  auto_merge_id?: string | null;
  integrations?: number;
  reason?: string | null;
  detail?: string | null;
  blocked_since?: number | null;
}

/** Move an entry to `to` with its `landing.<to>` event. Call inside a transaction. */
function move(db: Db, row: LandingRow, to: LandingState, fields: MoveFields, now: number, source: EventSource = "daemon"): { row: LandingRow; seq: number } {
  const next: LandingRow = { ...row, ...fields, state: to, state_since: to === row.state ? row.state_since : now, updated_at: now };
  db.query(
    `UPDATE landing_queue SET state = ?2, head_sha = ?3, approval_id = ?4, auto_merge_id = ?5, integrations = ?6, reason = ?7, detail = ?8, blocked_since = ?9, state_since = ?10, updated_at = ?11 WHERE id = ?1`,
  ).run(row.id, to, next.head_sha, next.approval_id, next.auto_merge_id, next.integrations, next.reason, next.detail, next.blocked_since, next.state_since, now);
  const event = appendEvent(db, {
    source,
    kind: `landing.${to}`,
    runId: row.run_id,
    taskId: row.task_id,
    payload: { landing: row.id, from: row.state, head: next.head_sha, approval: next.approval_id, auto_merge: next.auto_merge_id, integrations: next.integrations, reason: next.reason, detail: next.detail },
    ts: now,
  });
  return { row: next, seq: event.seq };
}

/** Rewrite the pr_ready line of every waiting entry of a project: their places moved. Call inside a transaction. */
function refreshLine(db: Db, projectId: string): void {
  for (const row of projectLine(db, projectId)) if (row.state === "waiting") setReadyProgress(db, row.run_id, landingProgress(db, row));
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
  db.query(
    `INSERT INTO landing_queue (id, project_id, run_id, task_id, ref, entered_head, head_sha, approval_id, state, enqueued_at, state_since, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, 'waiting', ?8, ?8, ?8)`,
  ).run(id, run.project_id, run.id, run.task_id, delivered.ref, delivered.head, approvalId, now);
  const row = getLanding(db, id)!;
  const place = placeOf(db, row);
  appendEvent(db, { source, kind: "landing.queued", runId: run.id, taskId: run.task_id, payload: { landing: id, ref: delivered.ref, head: delivered.head, approval: approvalId, position: place?.position ?? null, of: place?.of ?? null }, ts: now });
  refreshLine(db, run.project_id);
  return row;
}

/**
 * The entry leaves the line. A hold (the queue cannot go on without you)
 * opens auto_merge_held, as a held auto-merge does. Call inside a transaction.
 */
function leave(db: Db, row: LandingRow, reason: string, detail: string, now: number, hold?: { next: string }): LandingRow {
  const left = move(db, row, "left", { reason, detail, blocked_since: null }, now);
  if (row.auto_merge_id) supersedeAutoMerge(db, row.run_id, "landing_left", `the landing queue let it go: ${reason}`, now);
  if (hold && !findOpenRunItem(db, "auto_merge_held", row.run_id)) {
    openItem(db, { kind: "auto_merge_held", eventSeq: left.seq, taskId: row.task_id, runId: row.run_id, line: `Landing held: ${taskTitle(db, row.task_id)} (${row.task_id}): ${sanitizeLine(detail, 120)}; ${hold.next}`, now });
  }
  setReadyProgress(db, row.run_id, null);
  refreshLine(db, row.project_id);
  return left.row;
}

/**
 * Whether a delivery of this run belongs to the landing queue rather than to
 * a direct auto-merge: its project queues, it is a PR on the project's
 * default branch, and it is not stacked. On a queue project a delivery never
 * starts an auto-merge of its own (it would land out of turn); the queue's
 * pass picks it up. A live entry at another head leaves (redelivered), and so
 * does a live row. Call inside the delivery's transaction.
 */
export function deliveredToQueue(db: Db, config: FlowrynConfig, run: RunWithPolicy, head: string, now: number): boolean {
  if (!landingQueued(config, run.project_id)) return false;
  supersedeAutoMerge(db, run.id, "redelivered", `delivered again at ${head.slice(0, 8)}`, now, "cli");
  const live = liveLanding(db, run.id);
  // The watcher carried the delivery across the queue's own push, between it and the queue's carry: the entry is landing it.
  const carriedFromEntry = live?.state === "waiting" && deliveredOf(db, run.task_id)?.carriedFrom === live.head_sha;
  if (live && live.head_sha !== head && !carriedFromEntry) leave(db, live, "redelivered", `delivered again at ${head.slice(0, 8)}`, now);
  return true;
}

/** Whether the run can join a line: a ready ship's PR on its project's default branch, not stacked. */
function canQueue(db: Db, run: RunWithPolicy, delivered: Delivered | null): delivered is Delivered {
  if (run.kind !== "ship" || run.state !== "ready" || run.stacked_on || !delivered || delivered.kind !== "pr") return false;
  const project = getProject(db, run.project_id);
  return project !== null && runBase(run, project) === project.default_branch;
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
  /** A ship sent back for a conflict waits for a grant: the scheduler looks now. */
  kickScheduler(): void;
}

type HeadOutcome = "started" | "blocked" | "left";

/**
 * The queue's controller: the AutoMerger calls pass() around its own pass and
 * beforeMerge() before each merge, so every kick that moves an auto-merge
 * (a verify drain, a watcher pass, the 60 s tick) moves the line too.
 */
export class LandingQueue implements LandingHooks {
  private readonly deps: LandingQueueDeps;

  constructor(deps: LandingQueueDeps) {
    this.deps = deps;
  }

  async pass(): Promise<void> {
    const { db } = this.deps;
    tx(db, () => {
      const now = this.deps.now();
      for (const row of liveLandings(db)) this.settle(row, now);
      this.enqueueReady(now);
    });
    const projects = new Set(liveLandings(db).map((r) => r.project_id));
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
    if (!landingQueued(this.deps.config(), row.project_id)) return void leave(db, row, "landing_off", `project ${row.project_id} no longer queues its landings`, now);
    // A merge asked for by hand, or the queue's own merge in flight: wait for its proof.
    if (run.state === "merging") return;
    if (run.state !== "ready") return void leave(db, row, "sent_back", `the run is ${run.state}`, now);
    const delivered = deliveredOf(db, run.task_id);
    if (!delivered || delivered.head !== row.head_sha) return void leave(db, row, "redelivered", `delivered again at ${delivered?.head.slice(0, 8) ?? "-"}`, now);
    if (row.state !== "landing") return;
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
      if (!run || !landingQueued(this.deps.config(), run.project_id)) continue;
      const delivered = deliveredOf(db, run.task_id);
      if (!canQueue(db, run, delivered)) continue;
      // Once per head: an entry that left at this head (held, conflicted) is not taken again until something changes.
      if (db.query("SELECT 1 FROM landing_queue WHERE run_id = ?1 AND (head_sha = ?2 OR entered_head = ?2)").get(run.id, delivered.head)) continue;
      // A merge already asked for, or a direct auto-merge from before the project queued: leave it be.
      if (db.query("SELECT 1 FROM auto_merges WHERE run_id = ?1 AND state IN ('queued','verifying','waiting_checks','merging')").get(run.id)) continue;
      const routine = isRoutineMerge(db, run.task_id);
      const approval = routine ? null : findHumanApproval(db, { task: run.task_id, action: "merge", ref: delivered.ref, head: delivered.head, now });
      if (!routine && !approval) continue;
      enqueueLanding(db, run, delivered, approval?.id ?? null, now);
    }
  }

  /** Bring the first entry that can go up to date and start its landing; the rest wait their turn. */
  private async advanceProject(projectId: string): Promise<void> {
    const line = projectLine(this.deps.db, projectId);
    if (line.some((r) => r.state === "landing")) return;
    for (const row of line) {
      const outcome = await this.integrate(row);
      if (outcome === "started") return;
    }
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
    const wt = run.worktree_path;
    if (!existsSync(wt)) return this.held(row, "no_worktree", `the run's worktree ${wt} is gone`, `flowryn merge ${run.task_id}`);
    if (run.liveness === "busy" || run.liveness === "blocked_dialog") return this.blocked(row, `the worker is ${run.liveness === "busy" ? "busy" : "showing a dialog"}`);
    const status = await git(["status", "--porcelain"], wt);
    if (status.code !== 0) return this.blocked(row, `git status failed: ${status.stderr.trim()}`);
    const dirty = status.stdout.split("\n").filter((l) => l.length > 0 && !l.startsWith("?? .claude/"));
    if (dirty.length > 0) return this.blocked(row, `the worktree has ${dirty.length} uncommitted change(s)`);
    const base = runBase(run, project);
    const fetched = await netGit(["fetch", "--quiet", "--no-tags", "origin", base], wt);
    if (fetched.code !== 0) {
      this.deps.log(`landing queue ${row.id}: fetch origin ${base} failed: ${fetched.stderr.trim()}`);
      return "blocked";
    }
    let head = (await git(["rev-parse", "HEAD"], wt)).stdout.trim();
    let merged = false;
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
      const pushed = await netGit(["push", "origin", `HEAD:refs/heads/${prEvidence(db, run.id)?.head_ref || run.branch}`], wt);
      if (pushed.code !== 0) return this.held(row, "push_refused", `git push refused the merge of origin/${base}: ${pushed.stderr.trim().split("\n").at(-1) ?? ""}`, `flowryn show ${run.task_id}`);
      const proof = await cleanMainMerge(git, wt, { from: row.head_sha, to: head, base });
      if (!proof.ok) return this.held(row, "not_clean", `the pushed merge did not prove clean: ${proof.why}`, `flowryn show ${run.task_id}`);
      return this.startLanding(row, run, { head, steps: proof.steps, base });
    }
    return this.startLanding(row, run, null);
  }

  /** The merge stopped on conflicts: undo it, then send the ship back as the conflict nudge does. */
  private async conflicted(row: LandingRow, run: RunWithPolicy, delivered: Delivered, base: string, output: string): Promise<HeadOutcome> {
    const { db, git } = this.deps;
    const wt = run.worktree_path;
    const unmerged = await git(["diff", "--name-only", "--diff-filter=U"], wt);
    const files = unmerged.stdout.split("\n").map((f) => f.trim()).filter((f) => f.length > 0);
    const aborted = await git(["merge", "--abort"], wt);
    if (aborted.code !== 0) this.deps.log(`landing queue ${row.id}: merge --abort in ${wt} failed: ${aborted.stderr.trim()}`);
    if (files.length === 0) return this.held(row, "merge_failed", `git merge origin/${base} failed: ${output.trim().split("\n").at(-1) ?? ""}`, `flowryn show ${run.task_id}`);
    const sent = tx(db, () => {
      const fresh = getLanding(db, row.id);
      const current = getRunWithPolicy(db, run.id);
      if (!fresh || fresh.state !== "waiting" || !current || current.state !== "ready") return false;
      const now = this.deps.now();
      leave(db, fresh, "conflict", `merging origin/${base} conflicts in ${files.length} file(s): ${files.slice(0, 5).join(", ")}`, now);
      return sendConflictBack(db, current, delivered, { url: delivered.ref, base, head: delivered.head, files, source: "daemon" }, taskTitle(db, current.task_id), now);
    });
    if (sent) this.deps.kickScheduler();
    return "left";
  }

  /**
   * The entry is first in line: carry the delivery to the integrated head
   * (when there was a merge), keep or void its approval, and start the
   * auto-merge row that verifies and merges it.
   */
  private startLanding(row: LandingRow, run: RunWithPolicy, integrated: { head: string; steps: CleanMergeStep[]; base: string } | null): HeadOutcome {
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
      let head = delivered.head;
      let approval = fresh.approval_id;
      if (integrated) {
        const evidence = prEvidence(db, current.id);
        const before = approval ? (db.query("SELECT * FROM approvals WHERE id = ?1").get(approval) as ApprovalRow | null) : null;
        if (!carriedByWatcher) {
          carryLanding(db, current, delivered, { headSha: integrated.head, number: evidence?.number ?? 0, headRef: evidence?.head_ref ?? current.branch }, { from: delivered.head, steps: integrated.steps, verifyPolicy: steps ? verifyPolicyId(steps) : null }, now);
          settleHeadMove(db, current, delivered.head, integrated.head, now);
        }
        head = integrated.head;
        approval = null;
        if (before && before.consumed_at === null && before.expires_at > now) {
          // Your answer in the design review (q130): an approval carries across the queue's clean merge of the base, unless the work is sensitive.
          if (current.sensitive) {
            leave(db, { ...fresh, head_sha: head }, "approval_needed", `sensitive work: the merge of origin/${integrated.base} moved the head to ${head.slice(0, 8)}, so your approval of ${fresh.head_sha.slice(0, 8)} does not carry`, now, {
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
      supersedeAutoMerge(db, current.id, "landing", `the landing queue lands it at ${head.slice(0, 8)}`, now);
      const auto = createAutoMerge(db, config, current, { ref: delivered.ref, head, prNumber: evidence?.number ?? null, headRef: evidence?.head_ref ?? current.branch, worktree: null, source: "daemon" }, now);
      move(db, fresh, "landing", { head_sha: head, approval_id: approval, auto_merge_id: auto.id, integrations: fresh.integrations + (integrated ? 1 : 0), blocked_since: null, detail: integrated ? `merged origin/${integrated.base} at ${head.slice(0, 8)}` : null }, now);
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
    const cwd = existsSync(run.worktree_path) ? run.worktree_path : project.path;
    const fetched = await netGit(["fetch", "--quiet", "--no-tags", "origin", base], cwd);
    if (fetched.code !== 0) {
      this.deps.log(`landing queue ${row.id}: fetch origin ${base} before the merge failed: ${fetched.stderr.trim()}`);
      return false;
    }
    const has = await git(["merge-base", "--is-ancestor", `refs/remotes/origin/${base}`, auto.head_sha], cwd);
    if (has.code === 0) return true;
    if (has.code !== 1) return false;
    tx(db, () => {
      const fresh = getLanding(db, row.id);
      if (!fresh || fresh.state !== "landing") return;
      const now = this.deps.now();
      if (fresh.integrations >= MAX_INTEGRATIONS) {
        leave(db, fresh, "base_moving", `origin/${base} moved under it ${fresh.integrations} times before it could merge`, now, { next: `flowryn merge ${fresh.task_id}` });
        return;
      }
      supersedeAutoMerge(db, fresh.run_id, "base_moved", `origin/${base} moved past ${auto.head_sha.slice(0, 8)} before the merge`, now);
      move(db, fresh, "waiting", { auto_merge_id: null, detail: `origin/${base} moved; merging it in again` }, now);
      appendEvent(db, { source: "daemon", kind: "landing.base_moved", runId: fresh.run_id, taskId: fresh.task_id, payload: { landing: fresh.id, head: auto.head_sha, base }, ts: now });
    });
    return false;
  }
}
