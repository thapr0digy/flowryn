import { join } from "node:path";
import { FlowrynError } from "../api/errors.ts";
import { openItem, resolveItem } from "../attention/items.ts";
import type { FlowrynConfig } from "../config/config.ts";
import { getMeta, setMeta, tx, type Db } from "../db/db.ts";
import { appendEvent, type EventSource } from "../db/events.ts";
import { deliveredOf, type Delivered } from "../lifecycle/delivery.ts";
import { requestCancel } from "../lifecycle/operations.ts";
import { applyDrop } from "../lifecycle/drop.ts";
import type { ProjectRow } from "../lifecycle/projects.ts";
import { getRunWithPolicy, isTerminal, type RunRow, type RunWithPolicy } from "../lifecycle/runs.ts";
import { ulid } from "../util/ulid.ts";
import { sendBack } from "../lifecycle/send-back.ts";
import type { GitRunner } from "../policy/landed.ts";
import { COUNTERSIGN, countersigned, countersignOf, dismissCountersigns } from "../policy/countersign.ts";
import type { HostVerdict } from "../sched/host.ts";
import { DAEMON_CALLER } from "../policy/merge.ts";
import { applyMerge, prepareDaemonMerge, settleMerge, type MergePrepared, type MergeServices } from "../policy/merge-path.ts";
import type { DeliveryServices } from "../policy/services.ts";
import { sanitizeLine } from "../util/sanitize.ts";
import { baseRef, batchLine, batchMembers, batchRef, batchRows, FIX_BRANCH_PREFIX, getBatch, liveBatch, newestEndedBatch, passedAtHead, projectBatches, verifyingStage, type BatchRow, type BatchState } from "./batch-store.ts";
import { envCause, halve, MAX_AUTO_RETRIES, nextBatchMembers, RETRY_BACKOFF_MS, splitStack, stackJson, type FailureCause, type SplitStack } from "./batch-retry.ts";
import { batchMax, landingBatched, lightVerifyConfig, MAX_INTEGRATIONS, verifyConfig, type VerifyConfig } from "./config.ts";
import { numberClashes } from "./culprit.ts";
import { batchFlake, FLAKE_FAILED_KIND, FLAKE_PASSES, FLAKE_REFUSED_KIND, FLAKE_RERUN_KIND, flakeCandidate, flakeView, recordFlake, rerunStep, type FlakeState } from "./flake.ts";
import type { LandingRow, LandingState } from "./landing-queue.ts";
import { mergeInStore } from "./object-merge.ts";
import { verifyPolicyId } from "./policy.ts";
import { autoVerifyPath, cancelRequest, findQueued, getRequest, insertRequest } from "./queue.ts";
import { cleanTail, queueAutoRerun, recordEscalation, routeVerifyOutcome, SENT_BACK_KIND, sendBackText, sentBackPayload, verifyVerdict } from "./route.ts";
import { finishedAtHead, getVerification, interruptedByStop, runningVerifications, type Verification, type VerifyStep } from "./store.ts";

/**
 * Landing batches (docs/notes/2026-11-21-landing-batches-one-27.md): on a local-only project with
 * `landing = "batch"`, every ready branch that passed its light check lands with the others in one
 * batch, verified once with the project's full verify steps. Plain code: git plumbing, the verify
 * queue and the merge verb's own path; no model.
 *
 * - Light check: each waiting, non-sensitive entry's delivered head is verified alone with
 *   `light_verify` (its own policy) in the verify runner's fresh worktree. A failing step sends the
 *   work back once per head, a timeout runs it once more, the rest holds the entry for the leader.
 * - Build: with no batch live, every eligible entry (delivery order, at most MAX_BATCH) is merged
 *   onto local main's tip in the object store, the batch so far as first parent and the branch as
 *   second, so main's first-parent history reads one merge commit per task. A member adding the
 *   same numbered migration as one already taken goes back to renumber. A member that conflicts with main
 *   goes back to its worker; one that conflicts only with an earlier member waits for the next batch.
 *   No worker branch or worktree is ever written.
 * - Verify: one request for the batch head (ref batch:<project>/<id>). A pass lands it.
 * - Land: every member passes the merge gate first (its verify evidence is the batch's, src/policy/merge.ts);
 *   then main fast-forwards to the batch head once and each member's merge is recorded through
 *   the merge verb's path, so each run lands, is cleaned up and moves in the backlog as today.
 * - Red (src/verify/batch-retry.ts): a failure that looks environmental is verified again after a
 *   backoff (MAX_AUTO_RETRIES); failing tests with a rerun_failed command rerun alone (flake.ts);
 *   then a batch of two or more splits: a new batch of its first half, the rest on its split stack,
 *   verified next. A lone member's red goes back to its worker (after one baseline verify of main
 *   when nothing proves main green since the split began; main red holds the batch); a lone
 *   member whose failure still looks environmental leaves the line held for the leader.
 * - A batch's head never moves: a member leaving before main takes it, main moving under it or
 *   the leader dropping a branch ends it `dissolved` and builds a new one from the members left.
 *
 * Sensitive entries never join: they land one at a time through the local line (landing-queue.ts).
 */

/** The landing queue's own moves, so an entry's state and its events stay in one place. */
export interface LineOps {
  move(row: LandingRow, to: LandingState, fields: { batch_id?: string | null; batch_pos?: number | null; detail?: string | null; reason?: string | null }, now: number, source?: EventSource): LandingRow;
  leave(row: LandingRow, reason: string, detail: string, now: number, hold?: { next: string }): LandingRow;
  /** The entry conflicts with main: it leaves and its worker is sent back naming the paths. */
  sendConflict(row: LandingRow, run: RunWithPolicy, delivered: Delivered, base: string, files: string[]): boolean;
  refreshLine(projectId: string): void;
}

export interface BatchDeps {
  db: Db;
  config(): FlowrynConfig;
  git: GitRunner;
  now(): number;
  log(message: string): void;
  kickScheduler(): void;
  /** The merge verb's services; without them (a test of the line alone) a green batch waits. */
  delivery?: DeliveryServices;
  /** The scheduler's host check, sampled as a red verify is judged; without it only the event log tells load. */
  host?(): Promise<HostVerdict>;
}

/** How much of a hold's reason its item line keeps, so the next commands after it stay on the line. */
const HELD_DETAIL_CHARS = 90;
/** Verifies of one batch head the queue may cancel before the batch is held: the loss keeps happening. */
const MAX_VERIFY_LOSSES = 3;
/** Gate refusals that are the project checkout's or the moment's, not a member's: the batch waits and tries again. */
const RETRY_CODES = new Set(["checks_pending", "forge_unavailable", "merge_in_flight", "not_ready"]);
/** Gate refusals about the verify evidence: the batch is verified again. */
const REVERIFY_CODES = new Set(["verify_failed", "verify_stale", "red_checks"]);
/** A held batch's reason while a member's gate loosening waits for the leader's countersign (src/policy/countersign.ts). */
const LOOSENED_GATE = "loosened_gate";

function todaysPolicies(config: FlowrynConfig, projectId: string): { full: string; light: string | null } | null {
  try {
    const verify = verifyConfig(config, projectId);
    if (!verify) return null;
    const light = lightVerifyConfig(verify);
    return { full: verifyPolicyId(verify), light: light ? verifyPolicyId(light) : null };
  } catch {
    return null;
  }
}

export function batchMergeMessage(branch: string, task: string, main: string): string {
  return `Merge ${branch} (${task}) into the landing batch on main ${main.slice(0, 8)} (Flowryn)`;
}

/**
 * Where an entry's light check stands, for the views: "light check passed", "light check running
 * (v9)", or null when none was queued for it (the project has none, or the pass has not reached it).
 * Read by the policy its landing.light_queued event recorded, so a view needs no config.
 */
export function lightCheckState(db: Db, row: LandingRow): string | null {
  const queued = db
    .query("SELECT json_extract(payload, '$.policy') AS policy FROM events WHERE run_id = ?1 AND kind = 'landing.light_queued' AND json_extract(payload, '$.landing') = ?2 AND json_extract(payload, '$.head') = ?3 ORDER BY seq DESC LIMIT 1")
    .get(row.run_id, row.id, row.head_sha) as { policy: string } | null;
  if (!queued) return null;
  if (findQueued(db, row.ref, row.head_sha, queued.policy)) return "light check queued";
  const running = runningVerifications(db).find((v) => v.pr_url === row.ref && v.head_sha === row.head_sha && v.policy_id === queued.policy);
  if (running) return `light check running (${running.id})`;
  const done = finishedAtHead(db, row.ref, row.head_sha, queued.policy);
  if (!done || interruptedByStop(done)) return "light check queued";
  return done.state === "passed" ? "light check passed" : `light check ${done.state} (${done.id})`;
}

/** Where a live batch stands, for a member's line: "verifying v41", "verify v41 failed (load); retry 1 of 2 in 5 min", "held: ...", "landing". */
function batchStage(db: Db, batch: BatchRow): string {
  if (batch.state === "verifying") return verifyingStage(db, batch);
  if (batch.state === "held") return `held: ${batch.detail ?? "-"}`;
  return batch.state;
}

/** What `show`, the pr_ready line and the fleet say of an entry on a batch project. */
export function batchProgress(db: Db, row: LandingRow): string {
  const batch = row.batch_id ? getBatch(db, row.batch_id) : null;
  if (row.state === "landing" && batch) {
    const members = batchMembers(db, batch.id);
    const at = members.findIndex((m) => m.id === row.id);
    return `landing batch ${batch.id}: ${at + 1} of ${members.length}, ${batchStage(db, batch)} (${row.id})`;
  }
  if (row.state === "waiting") {
    const light = lightCheckState(db, row);
    return `landing queue: waiting for the next batch${light ? `, ${light}` : ""} (${row.id})`;
  }
  return `landing queue ${row.state}${row.reason ? ` (${row.reason})` : ""}${row.detail ? `: ${row.detail}` : ""}`;
}

/** The fleet's needs cell: "batch lb3 2/4 verifying v41", "next batch, light check passed". */
export function batchCell(db: Db, row: LandingRow): string {
  const batch = row.batch_id ? getBatch(db, row.batch_id) : null;
  if (row.state === "landing" && batch) {
    const members = batchMembers(db, batch.id);
    return `batch ${batch.id} ${members.findIndex((m) => m.id === row.id) + 1}/${members.length} ${batch.state === "verifying" ? verifyingStage(db, batch) : batch.state}`;
  }
  const light = lightCheckState(db, row);
  return `next batch${light ? `, ${light}` : ""}`;
}

/** A member with the files it adds against main: for the clash check. */
interface MemberFiles {
  row: LandingRow;
  added: string[];
}

/** The paths git listed, one per line; none when it failed. */
function fileList(r: { code: number; stdout: string }): string[] {
  return r.code === 0 ? r.stdout.split("\n").map((f) => f.trim()).filter((f) => f.length > 0) : [];
}

export class LandingBatches {
  private readonly deps: BatchDeps;
  private readonly ops: LineOps;

  constructor(deps: BatchDeps, ops: LineOps) {
    this.deps = deps;
    this.ops = ops;
  }

  /**
   * Drive the project's live batch. Returns whether one is still live (nothing else lands on the
   * project meanwhile).
   */
  async drive(project: ProjectRow): Promise<boolean> {
    const { db } = this.deps;
    await this.pruneFixBranches(project);
    const batch = liveBatch(db, project.id);
    if (!batch) return false;
    if (!landingBatched(this.deps.config(), project.id, project.delivery_mode) || !todaysPolicies(this.deps.config(), project.id)) {
      tx(db, () => this.dissolve(batch, "batching_off", `project ${project.id} no longer lands in batches`, "waiting"));
      return false;
    }
    // A batch fixed forward before batches split on red: its fix ends and its branches form a new batch.
    if (batch.state === "fixing") {
      tx(db, () => this.dissolve(batch, "rebuilt", "it waited on a fix task, which landing batches no longer open; its branches form a new batch", "waiting"));
      return false;
    }
    const rows = batchRows(db, batch.id);
    const left = rows.filter((r) => r.state === "left");
    const live = rows.filter((r) => r.state === "landing");
    if (batch.state === "landing") {
      if (left.length > 0) {
        const main = await this.mainTip(project);
        if (!main) return true;
        if (!(await this.isAncestor(project.path, batch.head_sha, main))) {
          await this.rebuild(batch, project, `${left.map((r) => r.task_id).join(", ")} left it before it landed`, batch.integrations);
          return true;
        }
        tx(db, () => this.flagLeftOnMain(getBatch(db, batch.id)!, left));
      }
      await this.land(getBatch(db, batch.id)!, project);
      return liveBatch(db, project.id) !== null;
    }
    if (live.length === 0) {
      tx(db, () => this.dissolve(batch, "emptied", "every branch left it", "waiting"));
      return false;
    }
    if (left.length > 0) {
      await this.rebuild(batch, project, `${left.map((r) => r.task_id).join(", ")} left it`, batch.integrations);
      return true;
    }
    if (batch.state === "held") {
      if (batch.reason === LOOSENED_GATE && this.countersignGiven(batch)) {
        tx(db, () => this.moveBatch(getBatch(db, batch.id)!, "landing", { reason: null, detail: `${batch.culprit ?? "-"}'s gate loosening was countersigned` }, this.deps.now(), "daemon", "landing.batch_countersigned"));
        await this.land(getBatch(db, batch.id)!, project);
        return liveBatch(db, project.id) !== null;
      }
      return true;
    }
    const main = await this.mainTip(project);
    if (!main) return true;
    if (!(await this.isAncestor(project.path, main, batch.head_sha))) {
      if (batch.integrations + 1 > MAX_INTEGRATIONS) {
        tx(db, () => this.hold(getBatch(db, batch.id)!, "base_moving", `main moved under the batch ${batch.integrations + 1} times; it is at ${main.slice(0, 8)}`, null));
        return true;
      }
      await this.rebuild(batch, project, `main moved to ${main.slice(0, 8)}`, batch.integrations + 1);
      return true;
    }
    const outcome = this.verifyOutcome(batch);
    if (outcome === "pending") return true;
    const flake = this.judgeFlake(batch, project, outcome);
    if (outcome.state === "passed") {
      const flaky = flake === "passed" ? `, its failing tests having passed ${FLAKE_PASSES} of ${FLAKE_PASSES} alone (flaky)` : "";
      tx(db, () => this.moveBatch(getBatch(db, batch.id)!, "landing", { verification_id: outcome.id, detail: `verify ${outcome.id} passed${flaky}` }, this.deps.now()));
      await this.land(getBatch(db, batch.id)!, project);
      return liveBatch(db, project.id) !== null;
    }
    await this.failed(batch, project, outcome);
    return true;
  }

  /**
   * The batch's verify: still to come ("pending", queuing a request when none waits or runs),
   * or the finished verification that judges it. A run a daemon stop cut off is followed by the
   * runner's own re-run, or a new request.
   */
  private verifyOutcome(batch: BatchRow): "pending" | Verification {
    const { db } = this.deps;
    const policies = todaysPolicies(this.deps.config(), batch.project_id)!;
    const ref = batchRef(batch.project_id, batch.id);
    // An automatic retry waits out its backoff; then one request at the same head, started by the verify queue under the host check.
    if (batch.retry_at !== null) {
      if (this.deps.now() < batch.retry_at) return "pending";
      tx(db, () => {
        const now = this.deps.now();
        const next = findQueued(db, ref, batch.head_sha, policies.full) ?? this.queueVerify(batch, policies.full, now);
        db.query("UPDATE landing_batches SET request_id = ?2, retry_at = NULL, detail = ?3, updated_at = ?4 WHERE id = ?1").run(batch.id, next.id, `retry ${batch.auto_retries} of ${MAX_AUTO_RETRIES} (${next.id})`, now);
        this.ops.refreshLine(batch.project_id);
      });
      this.deps.kickScheduler();
      return "pending";
    }
    const request = batch.request_id ? getRequest(db, batch.request_id) : null;
    if (request && request.policy_id === policies.full) {
      if (request.state === "queued") return "pending";
      if (request.state === "started" && request.verification_id) {
        const v = getVerification(db, request.verification_id);
        if (v?.state === "running") return "pending";
        if (v && !interruptedByStop(v)) return v;
      }
    } else {
      const done = finishedAtHead(db, ref, batch.head_sha, policies.full);
      if (done && !interruptedByStop(done)) return done;
    }
    const running = runningVerifications(db).find((v) => v.pr_url === ref && v.head_sha === batch.head_sha && v.policy_id === policies.full);
    if (running) return "pending";
    const cancelled = (db.query("SELECT COUNT(*) AS n FROM verify_queue WHERE pr_url = ?1 AND head_sha = ?2 AND state = 'cancelled'").get(ref, batch.head_sha) as { n: number }).n;
    if (cancelled >= MAX_VERIFY_LOSSES && !findQueued(db, ref, batch.head_sha, policies.full)) {
      tx(db, () => this.hold(batch, "verify_cancelled", `its verify was cancelled ${cancelled} times; the last: ${request?.detail ?? "-"}`, null));
      return "pending";
    }
    tx(db, () => {
      const now = this.deps.now();
      const next = findQueued(db, ref, batch.head_sha, policies.full) ?? this.queueVerify(batch, policies.full, now);
      db.query("UPDATE landing_batches SET request_id = ?2, updated_at = ?3 WHERE id = ?1").run(batch.id, next.id, now);
    });
    this.deps.kickScheduler();
    return "pending";
  }

  private queueVerify(batch: BatchRow, policy: string, now: number) {
    const { db } = this.deps;
    return insertRequest(db, { project_id: batch.project_id, pr_url: batchRef(batch.project_id, batch.id), task_id: null, head_sha: batch.head_sha, policy_id: policy, pr_number: null, head_ref: null, worktree: null, source: "auto", path: autoVerifyPath(db, batch.project_id), now });
  }

  /**
   * A verify that did not pass (src/verify/batch-retry.ts): a failure that looks environmental is
   * retried after a backoff, MAX_AUTO_RETRIES times; failing tests with a rerun_failed command
   * rerun alone once; then a batch of two or more splits, and a lone member goes back to its worker
   * (a red) or leaves the line held (a failure that still looks environmental).
   */
  private async failed(batch: BatchRow, project: ProjectRow, v: Verification): Promise<void> {
    const verdict = verifyVerdict(v);
    const step = v.steps.find((s) => s.state === "failed") ?? null;
    // A lone red waiting on main's baseline was judged red already: a later host sample must not turn it into a retry.
    const lone = batchMembers(this.deps.db, batch.id);
    if (lone.length === 1 && this.baselineAsked(batch)) {
      if ("sendBack" in verdict) await this.loneRed(batch, project, lone[0]!, v, verdict.sendBack);
      return;
    }
    const tail = step ? cleanTail(join(v.dir, step.log)) : "";
    const cause = envCause(this.deps.db, v, await this.hostSample(), tail);
    if (cause !== "red" && batch.auto_retries < MAX_AUTO_RETRIES) {
      this.scheduleRetry(batch, v, cause);
      return;
    }
    // Unless its failing tests earn one rerun alone at this head first: a flake lands as it is.
    if ("sendBack" in verdict && this.startFlakeRerun(batch, v, verdict.sendBack)) return;
    const members = batchMembers(this.deps.db, batch.id);
    if (members.length >= 2) {
      await this.split(batch, project, members, v, cause);
      return;
    }
    const member = members[0];
    if (!member) return;
    if (cause === "red" && "sendBack" in verdict) await this.loneRed(batch, project, member, v, verdict.sendBack);
    else this.loneHeld(batch, member, v, cause === "red" ? "error" : cause, step);
  }

  /** The host check as the next grant reads it, or null when this process has none or it failed (logged). */
  private async hostSample(): Promise<HostVerdict | null> {
    if (!this.deps.host) return null;
    try {
      return await this.deps.host();
    } catch (error) {
      this.deps.log(`landing batch: the host check failed: ${(error as Error).message}`);
      return null;
    }
  }

  /** A failure that looks environmental: the batch stays verifying and verifies again after its backoff (verifyOutcome). */
  private scheduleRetry(batch: BatchRow, v: Verification, cause: FailureCause): void {
    const { db } = this.deps;
    tx(db, () => {
      const fresh = getBatch(db, batch.id);
      if (fresh?.state !== "verifying" || fresh.head_sha !== v.head_sha || fresh.auto_retries !== batch.auto_retries || fresh.retry_at !== null) return;
      const now = this.deps.now();
      const attempt = fresh.auto_retries + 1;
      const wait = RETRY_BACKOFF_MS[attempt - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]!;
      const at = now + wait;
      const detail = `verify ${v.id} failed (${cause}); retry ${attempt} of ${MAX_AUTO_RETRIES} in ${wait / 60_000} min`;
      db.query("UPDATE landing_batches SET auto_retries = ?2, retry_at = ?3, request_id = NULL, verification_id = ?4, detail = ?5, updated_at = ?6 WHERE id = ?1").run(fresh.id, attempt, at, v.id, detail, now);
      appendEvent(db, { source: "daemon", kind: "landing.batch_auto_retry", payload: { batch: fresh.id, project: fresh.project_id, head: fresh.head_sha, attempt, of: v.id, cause, at }, ts: now });
      this.ops.refreshLine(fresh.project_id);
    });
  }

  /**
   * Split a red batch of two or more: a new batch of its first half (in line order) on main as it
   * is, replacing it (`split`); the rest goes onto the front of the new batch's split stack.
   */
  private async split(batch: BatchRow, project: ProjectRow, members: LandingRow[], v: Verification, cause: FailureCause): Promise<void> {
    const { db } = this.deps;
    const { first, rest } = halve(members);
    const old = splitStack(batch);
    const stack: SplitStack = { since: old?.since ?? this.deps.now(), halves: [rest.map((r) => r.id), ...(old?.halves ?? [])] };
    const why = `verify ${v.id} failed (${cause}); split: ${first.map((r) => r.task_id).join(", ")} first, then ${rest.map((r) => r.task_id).join(", ")}`;
    tx(db, () => appendEvent(db, { source: "daemon", kind: "landing.batch_split", payload: { batch: batch.id, project: project.id, head: batch.head_sha, of: v.id, cause, first: first.map((r) => r.task_id), rest: rest.map((r) => r.task_id) }, ts: this.deps.now() }));
    await this.assemble(project, first, batch.integrations, { ...batch, detail: why }, { reason: "split", stack });
  }

  /** Whether this lone batch already asked for main's baseline verify (landing.batch_baseline): its red was judged. */
  private baselineAsked(batch: BatchRow): boolean {
    return this.deps.db.query("SELECT 1 FROM events WHERE kind = 'landing.batch_baseline' AND json_extract(payload, '$.batch') = ?1 LIMIT 1").get(batch.id) !== null;
  }

  /**
   * A lone member's red: it failed in its batch and again alone on main. It goes back to its worker,
   * once main is shown green since the split began (a passed full verify of main's tip; else one
   * baseline verify of it is queued first, and a red main holds the batch with nothing sent back).
   */
  private async loneRed(batch: BatchRow, project: ProjectRow, member: LandingRow, v: Verification, step: VerifyStep): Promise<void> {
    const { db } = this.deps;
    const policies = todaysPolicies(this.deps.config(), project.id);
    if (!policies) return;
    const since = splitStack(batch)?.since ?? 0;
    const main = batch.base_sha;
    if (!passedAtHead(db, main, policies.full, since)) {
      const ref = baseRef(project.id, batch.id);
      const done = finishedAtHead(db, ref, main, policies.full);
      if (done && !interruptedByStop(done) && (done.finished_at ?? 0) >= since) {
        const failedAt = done.steps.find((s) => s.state === "failed");
        tx(db, () => {
          const fresh = getBatch(db, batch.id);
          if (fresh?.state !== "verifying") return;
          this.hold(fresh, "main_red", `main ${main.slice(0, 8)} itself fails${failedAt ? ` at \`${failedAt.name}\`` : ""} (verify ${done.id} ${done.state}); ${member.task_id} was not sent back`, null, v.id, `flowryn verify show ${done.id} | flowryn batch retry ${batch.id}`);
        });
        return;
      }
      if (findQueued(db, ref, main, policies.full) || runningVerifications(db).some((r) => r.pr_url === ref && r.head_sha === main)) return;
      tx(db, () => {
        const fresh = getBatch(db, batch.id);
        if (fresh?.state !== "verifying") return;
        const now = this.deps.now();
        const request = insertRequest(db, { project_id: project.id, pr_url: ref, task_id: null, head_sha: main, policy_id: policies.full, pr_number: null, head_ref: null, worktree: null, source: "auto", path: autoVerifyPath(db, project.id), now });
        db.query("UPDATE landing_batches SET detail = ?2, updated_at = ?3 WHERE id = ?1").run(fresh.id, `verify ${v.id} failed; checking main ${main.slice(0, 8)} before sending ${member.task_id} back (${request.id})`, now);
        appendEvent(db, { source: "daemon", kind: "landing.batch_baseline", payload: { batch: fresh.id, project: project.id, head: main, of: v.id, request: request.id }, ts: now });
        this.ops.refreshLine(project.id);
      });
      this.deps.kickScheduler();
      return;
    }
    tx(db, () => {
      const fresh = getBatch(db, batch.id);
      const row = db.query("SELECT * FROM landing_queue WHERE id = ?1").get(member.id) as LandingRow | null;
      const run = getRunWithPolicy(db, member.run_id);
      if (fresh?.state !== "verifying" || row?.state !== "landing") return;
      if (!run || run.state !== "ready") {
        this.holdMember(fresh, row, v, "not_ready", `its run is ${run?.state ?? "gone"}, so it cannot be sent back`);
        return;
      }
      const now = this.deps.now();
      const detail = `verify ${v.id} failed at \`${step.name}\` with it alone on main ${main.slice(0, 8)}`;
      this.ops.leave(row, "culprit", `landing batch ${fresh.id}: ${detail}`, now);
      sendBack(
        db,
        run,
        {
          text: `${sendBackText(v, step, "Landing batch")}\nIt failed with other branches in a landing batch, then again with your branch alone merged onto main ${main.slice(0, 8)}, which is green. Merge main into your branch to reproduce it, fix it, commit, and deliver again.`,
          feedback: `landing batch ${fresh.id} failed with it alone`,
          why: `the landing batch ${fresh.id} failed with it alone`,
          event: { source: "daemon", kind: SENT_BACK_KIND, payload: sentBackPayload(v, step, "auto_merge", { landing: row.id, batch: fresh.id }) },
        },
        now,
      );
      appendEvent(db, { source: "daemon", kind: "landing.batch_sent_back", runId: row.run_id, taskId: row.task_id, payload: { batch: fresh.id, project: fresh.project_id, landing: row.id, verification: v.id, step: step.name }, ts: now });
      this.dissolve(fresh, "sent_back", `${row.task_id} went back to its worker: ${detail}`, null);
    });
    this.deps.kickScheduler();
  }

  /** A lone member whose failure still looks environmental after the automatic retries: it leaves the line held for the leader. */
  private loneHeld(batch: BatchRow, member: LandingRow, v: Verification, cause: Exclude<FailureCause, "red">, step: VerifyStep | null): void {
    const { db } = this.deps;
    tx(db, () => {
      const fresh = getBatch(db, batch.id);
      const row = db.query("SELECT * FROM landing_queue WHERE id = ?1").get(member.id) as LandingRow | null;
      if (fresh?.state !== "verifying" || row?.state !== "landing") return;
      this.holdMember(fresh, row, v, `verify_${cause}`, `verify ${v.id} failed (${cause}${step ? ` at \`${step.name}\`` : ""}) with it alone, after ${fresh.auto_retries} automatic retries`);
    });
  }

  /** The lone member leaves the line held (`held:<code>`, an auto_merge_held item naming it) and the batch ends; the rest go on. Call inside a transaction. */
  private holdMember(batch: BatchRow, row: LandingRow, v: Verification, code: string, why: string): void {
    const now = this.deps.now();
    this.ops.leave(row, `held:${code}`, `landing batch ${batch.id}: ${why}`, now, { next: `flowryn verify show ${v.id}` });
    appendEvent(this.deps.db, { source: "daemon", kind: "landing.batch_member_held", runId: row.run_id, taskId: row.task_id, payload: { batch: batch.id, project: batch.project_id, landing: row.id, verification: v.id, code }, ts: now });
    this.dissolve(batch, "held_member", `${row.task_id} is held for the leader: ${why}`, null);
  }

  /**
   * A red verify's failing tests earn one rerun alone at the same head (src/verify/flake.ts): the
   * batch stays verifying, its request the rerun's, and the `verify.flake_rerun` event names the
   * tests and the command. False when the step has no rerun_failed command, the batch already
   * reran at this head, or the weekly rule refuses it (`verify.flake_refused`): the batch is split.
   */
  private startFlakeRerun(batch: BatchRow, v: Verification, step: VerifyStep): boolean {
    const { db } = this.deps;
    if (batchFlake(batch)?.head === batch.head_sha) return false;
    let verify: VerifyConfig | null;
    try {
      verify = verifyConfig(this.deps.config(), batch.project_id);
    } catch {
      return false;
    }
    const policies = todaysPolicies(this.deps.config(), batch.project_id);
    if (!verify || !policies || v.policy_id !== policies.full) return false;
    const now = this.deps.now();
    const candidate = flakeCandidate(db, verify, v, step, now);
    if (!candidate) return false;
    const started = tx(db, () => {
      const fresh = getBatch(db, batch.id);
      if (fresh?.state !== "verifying" || fresh.head_sha !== v.head_sha || batchFlake(fresh)?.head === fresh.head_sha) return false;
      if ("refused" in candidate) {
        appendEvent(db, { source: "daemon", kind: FLAKE_REFUSED_KIND, payload: { batch: batch.id, project: batch.project_id, head: v.head_sha, of: v.id, step: step.name, why: candidate.refused, tests: candidate.tests }, ts: now });
        return false;
      }
      const { flake } = candidate;
      const request = findQueued(db, batchRef(fresh.project_id, fresh.id), fresh.head_sha, policies.full) ?? this.queueVerify(fresh, policies.full, now);
      const detail = `verify ${v.id} failed at \`${step.name}\`; rerunning its ${flake.tests.length} failing test${flake.tests.length === 1 ? "" : "s"} alone, ${FLAKE_PASSES} times (${request.id})`;
      db.query("UPDATE landing_batches SET flake = ?2, request_id = ?3, verification_id = ?4, detail = ?5, updated_at = ?6 WHERE id = ?1").run(fresh.id, JSON.stringify(flake), request.id, v.id, detail, now);
      appendEvent(db, { source: "daemon", kind: FLAKE_RERUN_KIND, payload: { batch: fresh.id, project: fresh.project_id, head: fresh.head_sha, of: v.id, step: step.name, command: flake.command, targets: flake.targets, tests: flake.tests, passes: FLAKE_PASSES, request: request.id }, ts: now });
      this.ops.refreshLine(fresh.project_id);
      return true;
    });
    if (started) this.deps.kickScheduler();
    return started;
  }

  /**
   * The batch's pending flake rerun, judged by the finished verify of its head: `passed` records
   * the flake (flaky_tests, a fix task, `verify.flake`), `failed` says so (`verify.flake_rerun_failed`)
   * and the red is split; a verify whose rerun step never ran ends it. Returns how it was judged, or null.
   */
  private judgeFlake(batch: BatchRow, project: ProjectRow, v: Verification): FlakeState | null {
    const { db } = this.deps;
    const pending = batchFlake(batch);
    if (pending?.state !== "pending" || pending.head !== v.head_sha) return null;
    const judged = tx(db, () => {
      const fresh = getBatch(db, batch.id);
      const flake = fresh ? batchFlake(fresh) : null;
      if (!fresh || flake?.state !== "pending" || flake.head !== v.head_sha) return null;
      const now = this.deps.now();
      const step = rerunStep(v);
      const ran = step !== null && (step.state === "passed" || step.state === "failed");
      const state: FlakeState = !ran ? "ended" : step.state === "passed" ? "passed" : "failed";
      db.query("UPDATE landing_batches SET flake = ?2, updated_at = ?3 WHERE id = ?1").run(fresh.id, JSON.stringify({ ...flake, state, verification: v.id }), now);
      if (state === "passed") return { state, task: recordFlake(db, { config: this.deps.config(), project, batch: fresh, flake, rerun: v, red: getVerification(db, flake.of), now }) };
      appendEvent(db, { source: "daemon", kind: FLAKE_FAILED_KIND, payload: { batch: fresh.id, project: fresh.project_id, head: flake.head, of: flake.of, rerun: v.id, state: v.state, step: step?.name ?? null, ran }, ts: now });
      return { state, task: null };
    });
    if (judged?.task) this.deps.kickScheduler();
    return judged?.state ?? null;
  }

  /**
   * End the fix of a batch fixed forward before batches split on red (a legacy row, dissolved on
   * sight): its entry leaves, a run of it is cancelled (the reconciler stops the worker; the task is
   * parked), a task that never started is dropped from the backlog. Call inside a transaction.
   */
  private endFix(batch: BatchRow, why: string): void {
    const { db } = this.deps;
    if (!batch.fix_task || batch.fix_state === "ended") return;
    const task = batch.fix_task;
    const now = this.deps.now();
    const reason = `landing batch ${batch.id}: ${why}`;
    for (const row of db.query("SELECT * FROM landing_queue WHERE task_id = ?1 AND state IN ('waiting','landing')").all(task) as LandingRow[]) this.ops.leave(row, "fix_ended", reason, now);
    const run = db.query("SELECT * FROM runs WHERE task_id = ?1 ORDER BY started_at DESC, rowid DESC LIMIT 1").get(task) as RunRow | null;
    if (run && !isTerminal(run.state)) requestCancel(db, run, { id: ulid(now), by: "daemon", reason, source: "daemon", now });
    else if (!run && !db.query("SELECT 1 FROM drops WHERE task_id = ?1").get(task)) {
      const phase = db.query("SELECT plan_id, title FROM plan_phases WHERE task_id = ?1").get(task) as { plan_id: string; title: string } | null;
      applyDrop(db, { plan: null, tasks: [{ id: task, title: phase?.title ?? task, plan: phase?.plan_id ?? null, inBacklog: true }], dependents: [] }, { reason, by: "daemon", now });
    }
    db.query("UPDATE landing_batches SET fix_state = 'ended' WHERE id = ?1").run(batch.id);
    dismissCountersigns(db, task, reason, now);
    appendEvent(db, { source: "daemon", kind: "landing.batch_fix_ended", taskId: task, runId: run?.id ?? null, payload: { batch: batch.id, task, why, run: run?.id ?? null, cancelled: run !== null && !isTerminal(run.state) }, ts: now });
  }

  /** Delete flowryn/batch/<id> branches left by batches fixed forward before batches split on red. */
  private async pruneFixBranches(project: ProjectRow): Promise<void> {
    const { db, git } = this.deps;
    const listed = await git(["for-each-ref", "--format=%(refname) %(objectname)", `refs/heads/${FIX_BRANCH_PREFIX}`], project.path);
    if (listed.code !== 0) return;
    for (const line of listed.stdout.split("\n").filter((l) => l.length > 0)) {
      const [ref = "", sha = ""] = line.split(" ");
      const id = ref.slice(`refs/heads/${FIX_BRANCH_PREFIX}`.length);
      const batch = getBatch(db, id);
      if (batch && batch.project_id !== project.id) continue;
      const deleted = await git(["update-ref", "-d", ref, sha], project.path);
      if (deleted.code !== 0) this.deps.log(`landing batch ${id}: cannot delete ${ref}: ${(deleted.stderr || deleted.stdout).trim()}`);
    }
  }

  /**
   * A green batch whose member `row` is a fix run that loosens a gate: held until the leader
   * countersigns it (its decision is open, src/policy/countersign.ts), then landed (drive); a
   * refusal leaves it held for a drop. Call inside a transaction.
   */
  private holdForCountersign(batch: BatchRow, row: LandingRow, why: string): void {
    if (batch.state !== "landing") return;
    const decision = countersignOf(this.deps.db, row.task_id, row.head_sha)?.id;
    // The item line keeps the next commands whole; the loosenings themselves are in the decision.
    const detail = decision ? `${row.task_id} loosens a gate; ${decision} asks the countersign` : why;
    this.hold(batch, LOOSENED_GATE, detail, row.task_id, batch.verification_id, `${decision ? `flowryn decide ${decision} ${COUNTERSIGN} | ` : ""}flowryn batch drop ${batch.id} ${row.task_id}`);
  }

  /** A batch held for a loosened gate whose fix was countersigned at the head it delivered (by the user, on sensitive work). */
  private countersignGiven(batch: BatchRow): boolean {
    const row = batchMembers(this.deps.db, batch.id).find((m) => m.task_id === batch.culprit);
    const run = row ? getRunWithPolicy(this.deps.db, row.run_id) : null;
    return row !== undefined && run !== null && countersigned(this.deps.db, run, row.head_sha);
  }

  /** Hold the batch for the leader, with one landing_batch_held item naming the next commands. Call inside a transaction. */
  private hold(batch: BatchRow, reason: string, detail: string, culprit: string | null, verification: string | null = null, nextCommands: string | null = null): void {
    const { db } = this.deps;
    const now = this.deps.now();
    const members = batchMembers(db, batch.id);
    const owner = members.find((m) => m.task_id === culprit) ?? members[0] ?? null;
    const next = nextCommands ?? `flowryn batch retry ${batch.id}`;
    const seq = this.moveBatch(batch, "held", { reason, detail, culprit, verification_id: verification ?? batch.verification_id }, now);
    if (batch.item_id) resolveItem(db, batch.item_id, "landing.batch_held", now);
    // The digest keeps the next commands whole: the reason is cut first (the batch keeps it whole, show lb<N> prints it).
    const line = `Landing batch ${batch.id} (${batch.project_id}, ${members.length}) held: ${sanitizeLine(detail, HELD_DETAIL_CHARS)}. Next: ${next}`;
    const item = openItem(db, { kind: "landing_batch_held", eventSeq: seq, line, taskId: owner?.task_id, runId: owner?.run_id, now });
    db.query("UPDATE landing_batches SET item_id = ?2 WHERE id = ?1").run(batch.id, item);
  }

  /**
   * Land a green batch: every member passes the merge gate, then local main fast-forwards to the
   * batch head once, then each member's merge is recorded through the merge verb's path (its own
   * fast-forward is then a no-op: its head is on main). A member the gate refuses leaves and the
   * batch is rebuilt without it, unless main already holds the batch, when it is held for the leader.
   */
  private async land(batch: BatchRow, project: ProjectRow): Promise<void> {
    const { db, git } = this.deps;
    const delivery = this.deps.delivery;
    if (!delivery) {
      this.deps.log(`landing batch ${batch.id}: no merge services in this process; it waits`);
      return;
    }
    const services: MergeServices = { db, config: this.deps.config, delivery, now: this.deps.now, log: this.deps.log };
    const main = await this.mainTip(project);
    if (!main) return;
    const onMain = await this.isAncestor(project.path, batch.head_sha, main);
    if (!onMain && !(await this.isAncestor(project.path, main, batch.head_sha))) {
      await this.rebuild(batch, project, `main moved to ${main.slice(0, 8)} before it landed`, batch.integrations + 1);
      return;
    }
    const prepared: { row: LandingRow; prepared: MergePrepared }[] = [];
    for (const row of batchMembers(db, batch.id)) {
      const run = getRunWithPolicy(db, row.run_id);
      if (!run || run.state === "landed" || run.state === "cleaned") continue;
      try {
        prepared.push({ row, prepared: await prepareDaemonMerge(services, row.task_id) });
      } catch (error) {
        if (!(error instanceof FlowrynError)) throw error;
        if (error.refusalEvent) {
          tx(db, () => appendEvent(db, error.refusalEvent!));
          return;
        }
        if (RETRY_CODES.has(error.code)) return;
        // A fix that loosens a gate waits for the leader's countersign; the batch lands once it is given (drive).
        if (error.code === "loosened_gate" && !onMain) {
          tx(db, () => this.holdForCountersign(getBatch(db, batch.id)!, row, error.message));
          return;
        }
        if (REVERIFY_CODES.has(error.code) && !onMain) {
          await this.rebuild(batch, project, `the gate refused its verify for ${row.task_id}: ${error.message}`, batch.integrations);
          return;
        }
        if (error.code === "primary_checkout_tangle" || onMain) {
          tx(db, () => this.landingStuck(getBatch(db, batch.id)!, `${row.task_id}: ${error.message}`));
          return;
        }
        tx(db, () => this.ops.leave(row, `gate:${error.code}`, `the merge gate refused it in landing batch ${batch.id}: ${error.message}`, this.deps.now(), { next: error.help ?? `flowryn show ${row.task_id}` }));
        await this.rebuild(getBatch(db, batch.id)!, project, `the merge gate refused ${row.task_id} (${error.code})`, batch.integrations);
        return;
      }
    }
    if (!onMain) {
      const forwarded = await git(["merge", "--ff-only", "--quiet", batch.head_sha], project.path);
      if (forwarded.code !== 0) {
        tx(db, () => this.landingStuck(getBatch(db, batch.id)!, `git could not fast-forward ${project.default_branch} to ${batch.head_sha.slice(0, 8)}: ${(forwarded.stderr || forwarded.stdout).trim()}`));
        return;
      }
      tx(db, () => appendEvent(db, { source: "daemon", kind: "landing.batch_forwarded", payload: { batch: batch.id, project: project.id, from: main, to: batch.head_sha }, ts: this.deps.now() }));
    }
    for (const { row, prepared: p } of prepared) {
      try {
        const applied = tx(db, () => applyMerge(services, p, DAEMON_CALLER));
        await settleMerge(services, applied, DAEMON_CALLER);
      } catch (error) {
        if (!(error instanceof FlowrynError)) throw error;
        this.deps.log(`landing batch ${batch.id}: ${row.task_id}: ${error.message}`);
      }
    }
    tx(db, () => this.settleLanded(batch.id));
  }

  /** Members whose runs landed are landed; once every member is, the batch is. Call inside a transaction. */
  private settleLanded(batchId: string): void {
    const { db } = this.deps;
    const batch = getBatch(db, batchId);
    if (batch?.state !== "landing") return;
    const now = this.deps.now();
    let open = 0;
    for (const row of batchMembers(db, batch.id)) {
      const run = getRunWithPolicy(db, row.run_id);
      if (run && (run.state === "landed" || run.state === "cleaned")) this.ops.move(row, "landed", {}, now);
      else open++;
    }
    if (open > 0) return;
    const landed = batchRows(db, batch.id).filter((r) => r.state === "landed");
    this.moveBatch(batch, "landed", { detail: `${landed.length} branch${landed.length === 1 ? "" : "es"} landed at ${batch.head_sha.slice(0, 8)}` }, now);
    if (batch.item_id) resolveItem(db, batch.item_id, "landing.batch_landed", now);
    this.ops.refreshLine(batch.project_id);
  }

  /** A green batch that cannot land now (the project checkout, or a member on main the gate refused): an item for the leader, retried each pass. Call inside a transaction. */
  private landingStuck(batch: BatchRow, why: string): void {
    const { db } = this.deps;
    if (batch.detail === why && batch.item_id) return;
    const now = this.deps.now();
    const seq = this.moveBatch(batch, "landing", { detail: why }, now);
    if (batch.item_id) resolveItem(db, batch.item_id, "landing.batch_stuck", now);
    const owner = batchMembers(db, batch.id)[0];
    const item = openItem(db, { kind: "landing_batch_held", eventSeq: seq, line: `Landing batch ${batch.id} (${batch.project_id}) passed but cannot land: ${sanitizeLine(why, HELD_DETAIL_CHARS)}; it tries again each pass. Next: flowryn show ${batch.id}`, taskId: owner?.task_id, runId: owner?.run_id, now });
    db.query("UPDATE landing_batches SET item_id = ?2 WHERE id = ?1").run(batch.id, item);
  }

  /**
   * Members that left a landing batch after main already took its head: their code is on main
   * without a merge record. One item per member for the leader, kept after the rest land. Call inside a transaction.
   */
  private flagLeftOnMain(batch: BatchRow, left: LandingRow[]): void {
    const { db } = this.deps;
    const now = this.deps.now();
    for (const row of left) {
      if (db.query("SELECT 1 FROM events WHERE kind = 'landing.batch_left_on_main' AND json_extract(payload, '$.landing') = ?1 AND json_extract(payload, '$.batch') = ?2").get(row.id, batch.id)) continue;
      const seq = appendEvent(db, { source: "daemon", kind: "landing.batch_left_on_main", runId: row.run_id, taskId: row.task_id, payload: { batch: batch.id, landing: row.id, head: batch.head_sha }, ts: now }).seq;
      openItem(db, { kind: "landing_batch_held", eventSeq: seq, line: `Landing batch ${batch.id} (${batch.project_id}): ${row.task_id} left it (${row.reason ?? "-"}) after ${batch.head_sha.slice(0, 8)} was on main, so its code is on main without a merge record. Next: flowryn show ${row.task_id}`, taskId: row.task_id, runId: row.run_id, now });
    }
  }

  /**
   * Start a batch of the entries this pass's light checks found eligible (lightChecks), in line
   * order: the next half of the project's split stack while it has one, else up to `batch_max`.
   */
  async build(project: ProjectRow, eligible: LandingRow[]): Promise<void> {
    if (eligible.length === 0) return;
    const newest = newestEndedBatch(this.deps.db, project.id);
    const next = nextBatchMembers(newest ? splitStack(newest) : null, eligible, batchMax(this.deps.config(), project.id));
    await this.assemble(project, next.members, 0, null, { stack: next.stack });
  }

  /**
   * Each waiting entry's light check: queue one where none waits, runs or finished at its head;
   * judge one that did not pass. Runs while a batch is in flight too, so the next batch is ready
   * when it lands. Returns the entries whose light check passed (all of them when
   * the project has none), in line order.
   */
  async lightChecks(project: ProjectRow, waiting: LandingRow[]): Promise<LandingRow[]> {
    const { db } = this.deps;
    const policies = todaysPolicies(this.deps.config(), project.id);
    if (!policies) return [];
    if (!policies.light) return waiting;
    const light = policies.light;
    const eligible: LandingRow[] = [];
    let queued = false;
    for (const row of waiting) {
      if (findQueued(db, row.ref, row.head_sha, light)) continue;
      if (runningVerifications(db).some((v) => v.pr_url === row.ref && v.head_sha === row.head_sha && v.policy_id === light)) continue;
      const done = finishedAtHead(db, row.ref, row.head_sha, light);
      if (done && !interruptedByStop(done)) {
        if (done.state === "passed") eligible.push(row);
        else tx(db, () => this.judgeLight(row, done, light));
        continue;
      }
      tx(db, () => {
        const now = this.deps.now();
        insertRequest(db, { project_id: row.project_id, pr_url: row.ref, task_id: row.task_id, head_sha: row.head_sha, policy_id: light, pr_number: null, head_ref: null, worktree: null, source: "auto", path: autoVerifyPath(db, row.project_id), now });
        appendEvent(db, { source: "daemon", kind: "landing.light_queued", runId: row.run_id, taskId: row.task_id, payload: { landing: row.id, head: row.head_sha, policy: light }, ts: now });
      });
      queued = true;
    }
    // Each entry's pr_ready line says where its light check stands; a write only where it changed.
    tx(db, () => this.ops.refreshLine(project.id));
    if (queued) this.deps.kickScheduler();
    return eligible;
  }

  /** A light check that did not pass: back to the worker (a failing step, once per head), once more (a timeout), or held. Call inside a transaction. */
  private judgeLight(row: LandingRow, v: Verification, policy: string): void {
    const { db } = this.deps;
    const fresh = db.query("SELECT * FROM landing_queue WHERE id = ?1").get(row.id) as LandingRow | null;
    const run = getRunWithPolicy(db, row.run_id);
    if (fresh?.state !== "waiting" || !run || run.state !== "ready") return;
    const now = this.deps.now();
    const route = routeVerifyOutcome(db, v, run);
    if (route.route === "rerun") {
      queueAutoRerun(db, this.deps.config(), v, route.step, run.id, now, policy);
      this.deps.kickScheduler();
      return;
    }
    if (route.route === "send_back") {
      this.ops.leave(fresh, "light_failed", `light check ${v.id} failed: \`${route.step.name}\` exited ${route.step.exit}`, now);
      sendBack(
        db,
        run,
        {
          text: `${sendBackText(v, route.step, "Light check")}\nIt ran on your branch as delivered, before it may join a landing batch.`,
          feedback: `light check ${v.id} failed`,
          why: `the light check ${v.id} failed`,
          event: { source: "daemon", kind: SENT_BACK_KIND, payload: sentBackPayload(v, route.step, "auto_merge", { landing: row.id, light: true }) },
        },
        now,
      );
      this.deps.kickScheduler();
      return;
    }
    if (route.route === "escalate") {
      recordEscalation(db, v, route, run.id, "auto_merge", now, { landing: row.id, light: true });
      this.ops.leave(fresh, `held:${route.code}`, `light check: ${route.detail}`, now, { next: `flowryn verify show ${v.id}` });
    }
  }

  /**
   * Merge `members` onto main's tip in the object store and start the batch: the clash check,
   * then one merge commit per member (the first taken as it is when it holds main). Members may
   * be waiting, or landing in the batch this one replaces.
   */
  private async assemble(project: ProjectRow, members: LandingRow[], integrations: number, replaces: BatchRow | null = null, opts: { reason?: string; stack?: SplitStack | null } = {}): Promise<void> {
    const { db, git } = this.deps;
    const policies = todaysPolicies(this.deps.config(), project.id);
    const main = await this.mainTip(project);
    if (!policies || !main) return;
    const files = await this.memberFiles(project, members, main);
    const added = (row: LandingRow) => ({ task: row.task_id, files: files.find((f) => f.row.id === row.id)?.added ?? [] });
    let tip = main;
    const taken: LandingRow[] = [];
    const skipped: { task: string; why: string }[] = [];
    for (const member of members) {
      const clash = numberClashes([...taken.map(added), added(member)]).find((c) => c.task === member.task_id);
      if (clash) {
        tx(db, () => this.sendClash(member, clash.path, clash.with, clash.withPath));
        continue;
      }
      const run = getRunWithPolicy(db, member.run_id);
      if (!run) continue;
      if (taken.length === 0 && (await this.isAncestor(project.path, main, member.head_sha))) {
        tip = member.head_sha;
        taken.push(member);
        continue;
      }
      const merged = await mergeInStore(git, project.path, tip, member.head_sha, batchMergeMessage(run.branch, member.task_id, main));
      if ("head" in merged) {
        tip = merged.head;
        taken.push(member);
        continue;
      }
      if ("error" in merged) {
        this.deps.log(`landing batch: ${member.task_id}: ${merged.error}`);
        skipped.push({ task: member.task_id, why: merged.error });
        continue;
      }
      // A conflict: with main itself it goes back to its worker; with an earlier member it waits for the next batch.
      const alone = taken.length === 0 ? merged : await mergeInStore(git, project.path, main, member.head_sha, "probe");
      const delivered = deliveredOf(db, member.task_id);
      if ("conflict" in alone && delivered) {
        if (member.state === "landing") tx(db, () => this.ops.move(member, "waiting", { batch_id: null, batch_pos: null }, this.deps.now()));
        const fresh = db.query("SELECT * FROM landing_queue WHERE id = ?1").get(member.id) as LandingRow;
        this.ops.sendConflict(fresh, run, delivered, project.default_branch, alone.conflict);
        continue;
      }
      const why = `merging it onto ${taken.map((t) => t.task_id).join(", ")} conflicts in ${merged.conflict.slice(0, 5).join(", ")}`;
      skipped.push({ task: member.task_id, why });
      tx(db, () => appendEvent(db, { source: "daemon", kind: "landing.batch_skipped", runId: member.run_id, taskId: member.task_id, payload: { landing: member.id, head: member.head_sha, main, with: taken.map((t) => t.task_id), files: merged.conflict.slice(0, 20), why }, ts: this.deps.now() }));
    }
    tx(db, () => {
      const now = this.deps.now();
      const old = replaces ? getBatch(db, replaces.id) : null;
      const stack = opts.stack ?? null;
      if (replaces && old && (old.state === "verifying" || old.state === "fixing" || old.state === "landing" || old.state === "held")) {
        const outside = batchMembers(db, old.id).filter((r) => !members.some((m) => m.id === r.id));
        this.dissolve(old, opts.reason ?? "rebuilt", replaces.detail ?? "rebuilt", null);
        // Should the new batch not form, the ended one tells the next build what goes first: these members, then the stack.
        if (stack) db.query("UPDATE landing_batches SET split_rest = ?2 WHERE id = ?1").run(old.id, stackJson({ since: stack.since, halves: [members.map((m) => m.id), ...stack.halves] }));
        for (const row of outside) this.ops.move(row, "waiting", { batch_id: null, batch_pos: null, detail: `landing batch ${old.id} ended: ${replaces.detail ?? "rebuilt"}` }, now);
      }
      // What stayed out of the new batch goes back to waiting for the next one.
      for (const member of members) {
        const fresh = db.query("SELECT * FROM landing_queue WHERE id = ?1").get(member.id) as LandingRow | null;
        if (fresh?.state === "landing" && !taken.some((t) => t.id === fresh.id)) this.ops.move(fresh, "waiting", { batch_id: null, batch_pos: null }, now);
      }
      const current = taken
        .map((t) => db.query("SELECT * FROM landing_queue WHERE id = ?1").get(t.id) as LandingRow | null)
        .filter((r): r is LandingRow => r !== null && r.head_sha === members.find((m) => m.id === r.id)?.head_sha && (r.state === "waiting" || r.state === "landing"));
      if (current.length !== taken.length || current.length === 0) {
        for (const r of current) if (r.state === "landing") this.ops.move(r, "waiting", { batch_id: null, batch_pos: null }, now);
        return;
      }
      if (liveBatch(db, project.id)) {
        for (const r of current) if (r.state === "landing") this.ops.move(r, "waiting", { batch_id: null, batch_pos: null }, now);
        return;
      }
      const next = Number(getMeta(db, "next_landing_batch_no") ?? "1");
      setMeta(db, "next_landing_batch_no", String(next + 1));
      const id = `lb${next}`;
      db.query(
        `INSERT INTO landing_batches (id, project_id, state, base_sha, head_sha, integrations, split_rest, created_at, state_since, updated_at)
         VALUES (?1, ?2, 'verifying', ?3, ?4, ?5, ?6, ?7, ?7, ?7)`,
      ).run(id, project.id, main, tip, integrations, stackJson(stack), now);
      const batch = getBatch(db, id)!;
      const request = findQueued(db, batchRef(project.id, id), tip, policies.full) ?? this.queueVerify(batch, policies.full, now);
      db.query("UPDATE landing_batches SET request_id = ?2 WHERE id = ?1").run(id, request.id);
      current.forEach((row, i) => this.ops.move(row, "landing", { batch_id: id, batch_pos: i + 1, detail: `in landing batch ${id}`, reason: null }, now));
      appendEvent(db, {
        source: "daemon",
        kind: "landing.batch_built",
        payload: { batch: id, project: project.id, base: main, head: tip, request: request.id, members: current.map((r, i) => ({ task: r.task_id, head: r.head_sha, pos: i + 1 })), left_out: skipped, replaces: replaces?.id ?? null, integrations, ...(stack && stack.halves.length > 0 ? { split_rest: stack.halves.length } : {}) },
        ts: now,
      });
      this.ops.refreshLine(project.id);
    });
    this.deps.kickScheduler();
  }

  /** A batch whose members changed or whose base moved: a new batch of the members left, built on main as it is now. */
  private async rebuild(batch: BatchRow, project: ProjectRow, why: string, integrations: number): Promise<void> {
    const { db } = this.deps;
    // A legacy fix is never rebuilt into a new batch: its branch holds every member, the one that left too.
    const members = batchMembers(db, batch.id).filter((m) => m.task_id !== batch.fix_task);
    tx(db, () => appendEvent(db, { source: "daemon", kind: "landing.batch_rebuilt", payload: { batch: batch.id, project: project.id, why, members: members.map((m) => m.task_id) }, ts: this.deps.now() }));
    if (members.length === 0) {
      tx(db, () => this.dissolve(getBatch(db, batch.id)!, "emptied", why, "waiting"));
      return;
    }
    await this.assemble(project, members, integrations, { ...batch, detail: why }, { stack: splitStack(batch) });
  }

  /**
   * End a live batch: its queued verify cancelled, its item resolved, and its members (when `members`
   * says so) back to waiting for the next batch, with nothing sent back. Call inside a transaction.
   */
  private dissolve(batch: BatchRow, reason: string, detail: string, members: "waiting" | null): void {
    const { db } = this.deps;
    const now = this.deps.now();
    const request = batch.request_id ? getRequest(db, batch.request_id) : null;
    if (request?.state === "queued") cancelRequest(db, request, `landing batch ${batch.id} ended: ${detail}`, now);
    if (batch.item_id) resolveItem(db, batch.item_id, `landing.batch_${reason}`, now);
    this.endFix(batch, `the batch ended (${reason}): ${detail}`);
    // Its split stack: cleared when batching stops; with its members back to waiting, they go first.
    const stack = splitStack(batch);
    const back = members === "waiting" ? batchMembers(db, batch.id) : [];
    if (reason === "batching_off") db.query("UPDATE landing_batches SET split_rest = NULL WHERE id = ?1").run(batch.id);
    else if (stack && back.length > 0) db.query("UPDATE landing_batches SET split_rest = ?2 WHERE id = ?1").run(batch.id, stackJson({ since: stack.since, halves: [back.map((r) => r.id), ...stack.halves] }));
    for (const row of back) this.ops.move(row, "waiting", { batch_id: null, batch_pos: null, detail: `landing batch ${batch.id} ended: ${detail}` }, now);
    this.moveBatch(batch, "dissolved", { reason, detail }, now);
    this.ops.refreshLine(batch.project_id);
  }

  /** The later of two members adding the same numbered migration goes back to renumber it. Call inside a transaction. */
  private sendClash(row: LandingRow, path: string, withTask: string, withPath: string): void {
    const { db } = this.deps;
    const fresh = db.query("SELECT * FROM landing_queue WHERE id = ?1").get(row.id) as LandingRow | null;
    const run = getRunWithPolicy(db, row.run_id);
    if (!fresh || (fresh.state !== "waiting" && fresh.state !== "landing") || !run || run.state !== "ready") return;
    const now = this.deps.now();
    const detail = `${path} takes the same migration number as ${withTask}'s ${withPath}`;
    this.ops.leave(fresh, "number_clash", detail, now);
    sendBack(
      db,
      run,
      {
        text: `Landing batch: your branch adds ${path}, and ${withTask}, ahead of you in the landing batch, adds ${withPath} with the same migration number. Renumber yours (the next free number after main and ${withTask}), commit, and deliver again.`,
        feedback: "migration number clash in a landing batch",
        why: `its migration number clashes with ${withTask}`,
        event: { source: "daemon", kind: "landing.batch_clash", payload: { landing: row.id, path, with: withTask, with_path: withPath } },
      },
      now,
    );
    this.deps.kickScheduler();
  }

  // --- the leader's verbs -------------------------------------------------------------------

  /**
   * `flowryn batch drop <batch> <task>`: on a verifying or held batch, the member leaves and goes
   * back to its worker (with the failing step's tail when the batch's verify failed); a new batch of
   * the rest is built and verified on the next pass. Call inside a transaction.
   */
  drop(batchId: string, taskId: string, source: EventSource = "cli"): { batch: BatchRow; dropped: LandingRow } {
    const { db } = this.deps;
    const batch = getBatch(db, batchId);
    if (!batch) throw new FlowrynError("not_found", `no landing batch ${batchId}`, "flowryn fleet");
    if (batch.state !== "held" && batch.state !== "verifying") throw new FlowrynError("not_ready", `landing batch ${batchId} is ${batch.state}; only a verifying or held batch drops a branch`, `flowryn show ${batchId}`);
    const row = batchMembers(db, batch.id).find((r) => r.task_id === taskId);
    if (!row) throw new FlowrynError("not_found", `${taskId} is not in landing batch ${batchId} (it has ${batchMembers(db, batch.id).map((r) => r.task_id).join(", ") || "no branches"})`, `flowryn show ${batchId}`);
    const now = this.deps.now();
    dismissCountersigns(db, taskId, `the leader dropped it from landing batch ${batch.id}`, now);
    const request = batch.request_id ? getRequest(db, batch.request_id) : null;
    if (request?.state === "queued") cancelRequest(db, request, `the leader dropped ${taskId} from landing batch ${batch.id}`, now);
    const v = batch.verification_id ? getVerification(db, batch.verification_id) : null;
    const step = v?.steps.find((s) => s.state === "failed") ?? null;
    const dropped = this.ops.leave(row, "dropped", `the leader dropped it from landing batch ${batch.id}${batch.detail ? `: ${batch.detail}` : ""}`, now);
    const run = getRunWithPolicy(db, row.run_id);
    if (run && run.state === "ready") {
      const why = batch.culprit === taskId && batch.detail ? ` It was named in the hold: ${batch.detail}.` : "";
      const text =
        v && step
          ? `${sendBackText(v, step, "Landing batch")}\nYour leader dropped your branch from landing batch ${batch.id}.${why} The batch's verify ran on main with every branch in it merged; merge main into your branch to reproduce it, fix it, commit, and deliver again.`
          : `Your leader dropped your branch from landing batch ${batch.id} (${batch.state}${batch.reason ? `, ${batch.reason}` : ""}): ${batch.detail ?? "-"}. No verify failed on it. Merge main into your branch, commit, and deliver again.`;
      sendBack(
        db,
        run,
        {
          text,
          feedback: `dropped from landing batch ${batch.id}`,
          why: `dropped from landing batch ${batch.id}`,
          event: { source, kind: "landing.batch_dropped", payload: { batch: batch.id, landing: row.id, verification: v?.id ?? null, step: step?.name ?? null } },
        },
        now,
      );
    } else {
      appendEvent(db, { source, kind: "landing.batch_dropped", runId: row.run_id, taskId: row.task_id, payload: { batch: batch.id, landing: row.id, verification: v?.id ?? null, step: step?.name ?? null }, ts: now });
    }
    this.deps.kickScheduler();
    return { batch: getBatch(db, batch.id)!, dropped };
  }

  /**
   * `flowryn batch retry <batch>`: a held batch ends (`dissolved`, `retried`) and its members, none
   * dropped, form a new batch on main as it is on the next pass, verified afresh with its own
   * automatic retries; as often as the leader asks. Call inside a transaction.
   */
  retry(batchId: string, source: EventSource = "cli"): BatchRow {
    const { db } = this.deps;
    const batch = getBatch(db, batchId);
    if (!batch) throw new FlowrynError("not_found", `no landing batch ${batchId}`, "flowryn fleet");
    if (batch.state !== "held") throw new FlowrynError("not_ready", `landing batch ${batchId} is ${batch.state}; only a held batch is retried`, `flowryn show ${batchId}`);
    appendEvent(db, { source, kind: "landing.batch_retried", payload: { batch: batch.id, project: batch.project_id, head: batch.head_sha, reason: batch.reason }, ts: this.deps.now() });
    this.dissolve(batch, "retried", `retried by the leader after it was held (${batch.reason ?? "-"}); its branches form a new batch on main`, "waiting");
    this.deps.kickScheduler();
    return getBatch(db, batch.id)!;
  }

  // --- helpers --------------------------------------------------------------------------------

  /**
   * Move a batch to `to` with its event (`landing.batch_<to>`, or `kind`); returns the event's seq.
   * Call inside a transaction.
   */
  private moveBatch(
    batch: BatchRow,
    to: BatchState,
    fields: { reason?: string | null; detail?: string | null; culprit?: string | null; verification_id?: string | null },
    now: number,
    source: EventSource = "daemon",
    kind = `landing.batch_${to}`,
  ): number {
    const { db } = this.deps;
    const next = { ...batch, ...fields };
    db.query("UPDATE landing_batches SET state = ?2, reason = ?3, detail = ?4, culprit = ?5, verification_id = ?6, state_since = ?7, updated_at = ?8, item_id = CASE WHEN ?2 IN ('landed','dissolved') THEN NULL ELSE item_id END WHERE id = ?1").run(
      batch.id,
      to,
      next.reason,
      next.detail,
      next.culprit,
      next.verification_id,
      to === batch.state ? batch.state_since : now,
      now,
    );
    return appendEvent(db, { source, kind, payload: { batch: batch.id, project: batch.project_id, from: batch.state, head: batch.head_sha, reason: next.reason, detail: next.detail, culprit: next.culprit, verification: next.verification_id, ...(batch.fix_task ? { fix: batch.fix_task } : {}) }, ts: now }).seq;
  }

  /** Each member's added files against main (merge-base diffs), for the clash check. */
  private async memberFiles(project: ProjectRow, members: LandingRow[], main: string): Promise<MemberFiles[]> {
    const out: MemberFiles[] = [];
    for (const row of members) {
      const added = await this.deps.git(["diff", "--name-only", "--no-renames", "--diff-filter=A", `${main}...${row.head_sha}`], project.path);
      if (added.code !== 0) this.deps.log(`landing batch: cannot list ${row.task_id}'s added files: git exited ${added.code}`);
      out.push({ row, added: fileList(added) });
    }
    return out;
  }

  private async mainTip(project: ProjectRow): Promise<string | null> {
    const read = await this.deps.git(["rev-parse", "--verify", "--quiet", `refs/heads/${project.default_branch}^{commit}`], project.path);
    const sha = read.stdout.trim();
    if (read.code === 0 && /^[0-9a-f]{40,64}$/.test(sha)) return sha;
    this.deps.log(`landing batch ${project.id}: cannot read local ${project.default_branch}: ${read.stderr.trim() || `git exited ${read.code}`}`);
    return null;
  }

  private async isAncestor(cwd: string, ancestor: string, of: string): Promise<boolean> {
    if (ancestor === of) return true;
    return (await this.deps.git(["merge-base", "--is-ancestor", ancestor, of], cwd)).code === 0;
  }
}

/**
 * The board's LANDING section (src/cli/commands/board.ts): per project that batches, its live
 * batch with its members, then the entries forming the next batch with their light checks.
 * Empty when no project batches.
 */
export function landingBoardLines(db: Db): string[] {
  const projects = db.query("SELECT DISTINCT project_id FROM landing_batches ORDER BY 1").all() as { project_id: string }[];
  const lines: string[] = [];
  for (const { project_id: project } of projects) {
    const batch = liveBatch(db, project);
    if (!batch && !projectBatches(db, project)) continue;
    const waiting = db.query("SELECT * FROM landing_queue WHERE project_id = ?1 AND state = 'waiting' ORDER BY enqueued_at, CAST(substr(id, 3) AS INTEGER)").all(project) as LandingRow[];
    if (!batch && waiting.length === 0) continue;
    if (batch) {
      lines.push(`  ${project}  ${batchLine(db, batch)}`);
      for (const row of batchMembers(db, batch.id)) lines.push(`    ${row.batch_pos ?? "-"} ${row.task_id}`);
    } else lines.push(`  ${project}  no batch in flight`);
    if (waiting.length > 0) lines.push(`    next batch: ${waiting.length} waiting · ${waiting.slice(0, 4).map((r) => `${r.task_id} ${lightCheckState(db, r) ?? "waiting"}`).join(" · ")}${waiting.length > 4 ? " · …" : ""}`);
  }
  return lines;
}

/** `show lb<N>`: the batch, its members and where its verify stands. */
export function batchView(db: Db, batch: BatchRow): Record<string, unknown> {
  const rows = batchRows(db, batch.id);
  return {
    batch: batch.id,
    project: batch.project_id,
    state: batch.state,
    line: batchLine(db, batch),
    base: batch.base_sha,
    head: batch.head_sha,
    verify: verifyingStage(db, batch),
    request: batch.request_id ?? "-",
    culprit: batch.culprit ?? "-",
    reason: batch.reason ?? "-",
    detail: batch.detail ?? "-",
    integrations: batch.integrations,
    auto_retries: batch.auto_retries,
    retry_at: batch.retry_at ?? "-",
    split_rest: splitStack(batch)?.halves.map((half) => half.map((id) => (db.query("SELECT task_id FROM landing_queue WHERE id = ?1").get(id) as { task_id: string } | null)?.task_id ?? id)) ?? [],
    ...(batch.fix_task ? { fix: { task: batch.fix_task, state: batch.fix_state, base: batch.fix_base?.slice(0, 8) ?? "-" } } : {}),
    flake: flakeView(batch),
    members: rows.map((r) => ({ task: r.task_id, pos: r.batch_pos, head: r.head_sha.slice(0, 8), state: r.state, ...(r.reason ? { reason: r.reason } : {}) })),
  };
}

