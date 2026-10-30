import { existsSync } from "node:fs";
import type { Db } from "../db/db.ts";
import { tx } from "../db/db.ts";
import { parsePrUrl } from "../forge/github.ts";
import { ForgeError, type ChecksSummary, type Forge, type PrRef, type PullRequest } from "../forge/types.ts";
import { deliveredOf, projectRepo, type Delivered } from "../lifecycle/delivery.ts";
import { applyVerdict, backlogTasks, closeWatch, openWatches, orphanReason, ownPrVerdict, pendingTaskIds, prUrlOf, prVerdict, reportVerdict, watchOfTask, type WatchVerdict } from "../lifecycle/watches.ts";
import { ciWaitDue, ciWaitMinutes, closeCiWaits, openCiWait, readBranchFacts, strandedCiWaits } from "../lifecycle/ci-wait.ts";
import { landScout } from "../lifecycle/landing.ts";
import { retargetStacks } from "../lifecycle/stacks.ts";
import { getProject } from "../lifecycle/projects.ts";
import { deliveryBasis, deliveryTransition, type BasisPart } from "../lifecycle/observed.ts";
import { getRun, getRunWithPolicy, runBase, type RunWithPolicy } from "../lifecycle/runs.ts";
import { latestMerge, notStartedChecks, proveLocal, recordMergeResult } from "../policy/merge.ts";
import type { GitRunner } from "../policy/landed.ts";
import { parseNmStatus, readNmStatus, type NmRun } from "../policy/nomistakes.ts";
import { cleanMainMerge, type CleanMerge } from "../policy/clean-merge.ts";
import { headHistory, type HeadHistory } from "../policy/head-history.ts";
import { applyNmObservation, applyPrObservation, headMoveRecorded, noteMergedAfterEnd, noteNmOutage, yieldToCiWait } from "../reconcile/delivery.ts";
import { isForgeOutage, noteForgeDown, noteForgeUp, settleForgeAlert } from "../reconcile/forge-health.ts";
import { applyFeedback, openInlineThreads } from "../reconcile/reviews.ts";
import { feedbackItems } from "../forge/feedback.ts";
import type { AutoMergeDelivery } from "../verify/auto-merge.ts";

/**
 * The delivery watchers (design section 4, src/watch): GitHub PR state, head
 * and checks for every delivered ship (conditional requests with ETags, so a
 * quiet poll costs nothing), the proof of a merge still unproven, local-only
 * merges, the reviews and comments on delivered PRs (src/reconcile/reviews.ts),
 * the read-only no-mistakes status of validating runs, and landed
 * runs whose cleanup never ran (the daemon stopped in between), and the
 * CI-wait watchdog's question (src/lifecycle/ci-wait.ts). They observe;
 * src/reconcile/delivery.ts applies. A failing forge backs off, it is never
 * retried in a tight loop.
 */

export interface DeliveryWatcherDeps {
  db: Db;
  forge(): Forge;
  webUrl(): string;
  git: GitRunner;
  /** The ancestry check's PR-head fetch, with a short deadline (HEAD_FETCH_TIMEOUT_MS); `git` when absent. */
  headFetchGit?: GitRunner;
  noMistakes(): string | null;
  /** The status read itself (readNmStatus); tests pause it on a barrier. */
  readNmStatus?: typeof readNmStatus;
  nmTimeoutMs(): number;
  /** A validation slot held this long with no progress opens a validation_stuck P1 ([sched] validation_stuck_ms). */
  validationStuckMs(): number;
  pollMs(): number;
  inFlight: ReadonlySet<string>;
  /** `[validation] ci_wait_alert`: minutes a pipeline may wait on CI with no checks before the user is asked (0: off). */
  ciWaitAlertMin(): number;
  /** Clean up a run that landed (the daemon's own cleanup after a proven merge). */
  cleanup(runId: string): void;
  /** `[upkeep] nudge_conflicts`: a delivered PR that conflicts with its base sends its ship back. */
  nudgeConflicts(): boolean;
  /** A nudged ship's last stage waits for a grant, or a carried head's verify was queued: the scheduler looks now. */
  kickScheduler(): void;
  /** The project's verify policy identity under today's config, or null when it has no verify steps (src/verify/policy.ts); absent: none. */
  verifyPolicy?(projectId: string): string | null;
  /** A pass finished: what it read may move a yolo auto-merge on (src/verify/auto-merge.ts). */
  passed?(): void;
  /** A delivery was carried to a new head: start its yolo auto-merge as a deliver does (startAutoMerge); absent: none. */
  autoMerge?(run: RunWithPolicy, delivery: AutoMergeDelivery, now: number): void;
  /** `[upkeep] steer_reviews`: a delivered PR's reviews and comments steer its worker; off when absent. */
  steerReviews?(): boolean;
  /** `[upkeep] review_reraise_hours` in ms: an unanswered review thread is sent again after this long (0: never). */
  reviewReraiseMs?(): number;
  /** A steer was recorded for a live run: ring it now. */
  notifySteer?(runId: string): void;
  log(line: string): void;
  now(): number;
}

const MAX_BACKOFF_MS = 10 * 60_000;
/** Consecutive failed status reads before no-mistakes counts as down. */
const NM_DOWN_AFTER = 3;
/** A read for the restart guard is skipped when a status read finished this recently. */
export const VALIDATION_READ_MIN_GAP_MS = 15_000;
/** A PR's review threads (a GraphQL read, which no ETag makes free) are read at most this often while one waits on an answer. */
export const REVIEW_THREADS_MIN_GAP_MS = 5 * 60_000;
/** The pool the ship stage's no-mistakes pipeline runs under (src/config/workflows.ts). */
const VALIDATION_POOL = "validation";

/**
 * What each watcher's write depends on (docs/notes/2026-10-13-next-steps-md-av.md):
 * a read is applied only if these parts of the run's delivery basis are what
 * they were before the read's awaits, else it is dropped with an event.
 */
const PR_PARTS: readonly BasisPart[] = ["state", "stage", "stage_state", "delivered", "merge", "operation"];
const NM_PARTS: readonly BasisPart[] = ["state", "stage", "stage_state", "operation", "validation"];
const CI_WAIT_PARTS: readonly BasisPart[] = ["state", "stage", "stage_state", "delivered", "operation", "validation"];
const LOCAL_MERGE_PARTS: readonly BasisPart[] = ["state", "merge", "operation"];
/**
 * A proven merge of the delivered work cannot be undone, so it wins over a
 * newer cancel, operation or merge-row change: it depends on the delivery
 * alone. A run that ended meanwhile is not revived (noteMergedAfterEnd).
 */
const MERGED_PARTS: readonly BasisPart[] = ["delivered"];
/** A review read applies only to the run and delivery it was read for. */
const REVIEW_PARTS: readonly BasisPart[] = ["state", "stage", "stage_state", "delivered", "merge", "operation"];

export class DeliveryWatcher {
  private readonly deps: DeliveryWatcherDeps;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private started = false;
  private again = false;
  private backoffMs = 0;
  private forgeQuietUntil = 0;
  private nmFailures = 0;
  private nmRead: Promise<void> | null = null;
  private nmReadAt = Number.NEGATIVE_INFINITY;
  /** When each PR's review threads were last read. */
  private readonly threadsReadAt = new Map<string, number>();

  constructor(deps: DeliveryWatcherDeps) {
    this.deps = deps;
  }

  start(): void {
    this.started = true;
    this.schedule(0);
  }

  /** No new pass after this; resolves when the pass under way, if any, has ended (the daemon closes the database after). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }

  /**
   * Look now (debounced); a pass in progress is followed by another. Before
   * start() nothing runs: at startup the reconciler reattaches first (design
   * section 6), and a delivery ingested from the spool must not clean up the
   * worker under it.
   */
  kick(): void {
    if (!this.started) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.schedule(50);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.pass().finally(() => {
        this.running = null;
        if (this.again) {
          this.again = false;
          this.schedule(50);
        } else this.schedule(this.deps.pollMs());
      });
    }, ms);
  }

  /** One pass over everything the watchers follow. Exposed for tests. */
  async pass(): Promise<void> {
    try {
      await this.watchPrs();
      // After the PR reads, so a landing they proved retargets the runs stacked on it in the same pass.
      await this.retargetStacks().catch((error: unknown) => this.deps.log(`delivery watcher: stacks: ${(error as Error).stack ?? String(error)}`));
      // Its own failure never holds up the watchers after it.
      await this.watchReviews().catch((error: unknown) => this.deps.log(`delivery watcher: reviews: ${(error as Error).stack ?? String(error)}`));
      await this.watchLocalMerges();
      await this.watchNoMistakes();
      this.landDeliveredScouts();
      this.resumeCleanups();
      await this.settleWatches();
    } catch (error) {
      this.deps.log(`delivery watcher: ${(error as Error).stack ?? String(error)}`);
    }
    this.deps.passed?.();
  }

  /** Stacked runs whose base landed are retargeted; a base that cannot land is flagged (src/lifecycle/stacks.ts). */
  private async retargetStacks(): Promise<void> {
    if (this.deps.now() < this.forgeQuietUntil) return;
    await retargetStacks({
      db: this.deps.db,
      forge: this.deps.forge,
      webUrl: this.deps.webUrl,
      now: this.deps.now,
      log: this.deps.log,
      kickScheduler: this.deps.kickScheduler,
      notifySteer: this.deps.notifySteer,
    });
  }

  private runs(sql: string, ...params: (string | number)[]): RunWithPolicy[] {
    const ids = this.deps.db.query(sql).all(...params) as { id: string }[];
    return ids.map((r) => getRunWithPolicy(this.deps.db, r.id)).filter((r): r is RunWithPolicy => r !== null);
  }

  private async watchPrs(): Promise<void> {
    const { db, now } = this.deps;
    // A P1 about GitHub being away has nothing left to say once no merge waits (design section 16).
    tx(db, () => settleForgeAlert(db, now()));
    if (now() < this.forgeQuietUntil) return;
    const runs = this.runs(
      `SELECT r.id FROM runs r JOIN task_policy p ON p.task_id = r.task_id
       WHERE p.kind = 'ship' AND p.delivery_mode != 'local-only' AND r.state IN ('ready','merging') ORDER BY r.updated_at`,
    );
    const forge = this.deps.forge();
    for (const run of runs) {
      if (this.stopped) return;
      // The delivery the PR is compared with is the one the basis holds: a redelivery during the read makes it stale.
      const seen = deliveryBasis(db, run.id);
      const delivered = deliveredOf(db, run.task_id);
      if (!delivered || delivered.kind !== "pr") continue;
      const ref = parsePrUrl(delivered.ref, this.deps.webUrl());
      if (!ref) continue;
      try {
        const pr = await forge.pull(ref);
        const checks = pr.state === "open" ? await forge.checks(ref, pr.headSha) : null;
        const notStarted = checks?.state === "red" ? await this.notStartedOf(forge, ref, checks, run.project_id, delivered.ref) : [];
        const history = await this.headHistoryOf(run, delivered.head, pr.headSha, pr.state === "open", ref.number);
        const autoMerge = this.deps.autoMerge;
        const carry =
          history === "descends"
            ? {
                proof: await this.cleanMergeOf(run, delivered.head, pr.headSha, pr.baseRef),
                verifyPolicy: this.deps.verifyPolicy?.(run.project_id) ?? null,
                ...(autoMerge ? { autoMerge: (r: RunWithPolicy, moved: PullRequest, at: number) => autoMerge(r, { ref: delivered.ref, head: moved.headSha, prNumber: moved.number, headRef: moved.headRef, worktree: null }, at) } : {}),
              }
            : undefined;
        tx(db, () => noteForgeUp(db, "github", now()));
        const mergeSha = pr.state === "merged" ? pr.mergeSha : null;
        const observed = deliveryTransition(db, seen, mergeSha ? MERGED_PARTS : PR_PARTS, "pr_observation", "github", now(), (current) =>
          applyPrObservation(db, current, delivered, { pr, checks, notStarted }, this.deps.inFlight, now(), { nudgeConflicts: this.deps.nudgeConflicts(), history, ...(carry ? { carry } : {}) }),
        );
        if (!observed.applied && mergeSha && !observed.changed.delivered) this.keepLateMerge(run.id, delivered, mergeSha, "github");
        const applied = observed.applied ? observed.value : { landed: false, nudged: false };
        this.backoffMs = 0;
        if (applied.landed) this.deps.cleanup(run.id);
        if (applied.nudged || applied.carried) this.deps.kickScheduler();
      } catch (error) {
        if (error instanceof ForgeError && error.kind === "not_found") {
          this.deps.log(`delivery watcher: ${delivered.ref} is not found on GitHub`);
          continue;
        }
        this.forgeFailed(error);
        return;
      }
    }
  }

  /** The red checks GitHub never started, for the merge explanation only (it reads them only with verify steps); an unreadable answer names none. */
  private async notStartedOf(forge: Forge, ref: PrRef, checks: ChecksSummary, projectId: string, url: string): Promise<number[]> {
    try {
      if (!this.deps.verifyPolicy?.(projectId)) return [];
      return await notStartedChecks(forge, ref, checks);
    } catch (error) {
      this.deps.log(`delivery watcher: cannot tell which red checks of ${url} GitHub never started (${(error as Error).message})`);
      return [];
    }
  }

  /**
   * Reviews and comments on every open delivered PR whose ship is delivered
   * or back at work on it (src/reconcile/reviews.ts): each new one steers the
   * worker, an unanswered thread is raised again. Review threads' resolution
   * (GraphQL) is read only while an inline thread waits, at most every
   * REVIEW_THREADS_MIN_GAP_MS per PR. Shares the PR watcher's GitHub backoff.
   */
  private async watchReviews(): Promise<void> {
    const { db, now } = this.deps;
    if (!this.deps.steerReviews?.() || now() < this.forgeQuietUntil) return;
    const runs = this.runs(
      `SELECT r.id FROM runs r JOIN task_policy p ON p.task_id = r.task_id
       WHERE p.kind = 'ship' AND p.delivery_mode != 'local-only' AND r.state IN ('ready','running','validating') ORDER BY r.updated_at`,
    );
    const forge = this.deps.forge();
    for (const run of runs) {
      if (this.stopped) return;
      const seen = deliveryBasis(db, run.id);
      const delivered = deliveredOf(db, run.task_id);
      if (!delivered || delivered.kind !== "pr") continue;
      const ref = parsePrUrl(delivered.ref, this.deps.webUrl());
      if (!ref) continue;
      try {
        const pr = await forge.pull(ref);
        if (pr.state !== "open") continue;
        const feedback = await forge.feedback(ref);
        const lastThreads = this.threadsReadAt.get(delivered.ref) ?? Number.NEGATIVE_INFINITY;
        const readThreads = openInlineThreads(db, run.task_id) > 0 && now() - lastThreads >= REVIEW_THREADS_MIN_GAP_MS;
        const threads = readThreads ? await forge.reviewThreads(ref) : null;
        if (readThreads) this.threadsReadAt.set(delivered.ref, now());
        tx(db, () => noteForgeUp(db, "github", now()));
        const items = feedbackItems(feedback, pr.author ?? null, threads);
        const observed = deliveryTransition(db, seen, REVIEW_PARTS, "review_observation", "github", now(), (current) => {
          if (current.state !== "ready" && current.state !== "running" && current.state !== "validating") return null;
          return applyFeedback(db, current, delivered, items, { reraiseMs: this.deps.reviewReraiseMs?.() ?? 0 }, now());
        });
        const outcome = observed.applied ? observed.value : null;
        this.backoffMs = 0;
        if (outcome?.via === "send_back") this.deps.kickScheduler();
        if (outcome?.via === "steer") this.deps.notifySteer?.(run.id);
        if (outcome && outcome.sent.length + outcome.reraised.length > 0) {
          this.deps.log(`delivery watcher: ${run.task_id}: review feedback ${outcome.via === "send_back" ? "sent back" : "steered"} (${[...outcome.sent, ...outcome.reraised].join(", ")})`);
        }
      } catch (error) {
        if (error instanceof ForgeError && error.kind === "not_found") {
          this.deps.log(`delivery watcher: reviews of ${delivered.ref}: not found on GitHub`);
          continue;
        }
        this.forgeFailed(error);
        return;
      }
    }
  }

  /**
   * How a delivered run's open PR head moved, asked of git once per head move
   * (a divergence already recorded for it skips the call): in the run's
   * worktree, or the project checkout once it is gone. Undefined when the
   * head did not move or nothing is asked.
   */
  private async headHistoryOf(run: RunWithPolicy, delivered: string, head: string, open: boolean, prNumber: number): Promise<HeadHistory | undefined> {
    if (!open || run.state !== "ready" || head === delivered || headMoveRecorded(this.deps.db, run.id, delivered, head)) return undefined;
    const cwd = existsSync(run.worktree_path) ? run.worktree_path : getProject(this.deps.db, run.project_id)?.path;
    if (!cwd) return "unknown";
    return headHistory(this.deps.git, cwd, delivered, head, prNumber, this.deps.headFetchGit ?? this.deps.git).catch(() => "unknown" as const);
  }

  /**
   * Whether a delivered head that moved by commits on top moved only by clean
   * merges of the run's base (docs/notes/2026-10-23-a-clean-merge-fm.md),
   * asked of git where headHistoryOf asked; never a yes when git cannot say.
   */
  private async cleanMergeOf(run: RunWithPolicy, delivered: string, head: string, prBase: string): Promise<CleanMerge> {
    const project = getProject(this.deps.db, run.project_id);
    if (!project) return { ok: false, why: `project ${run.project_id} is not registered` };
    const base = runBase(run, project);
    if (prBase !== base) return { ok: false, why: `the PR's base is ${prBase}, not ${base}` };
    const cwd = existsSync(run.worktree_path) ? run.worktree_path : project.path;
    return cleanMainMerge(this.deps.git, cwd, { from: delivered, to: head, base, fetchGit: this.deps.headFetchGit ?? this.deps.git }).catch(
      (error: unknown) => ({ ok: false, why: `git could not say: ${(error as Error).message}` }) as const,
    );
  }

  /** A merge proven after its run ended: kept as a fact, the run not revived (noteMergedAfterEnd). */
  private keepLateMerge(runId: string, delivered: Delivered, mergeSha: string, source: "github" | "daemon"): void {
    const { db, now } = this.deps;
    const kept = tx(db, () => {
      const run = getRun(db, runId);
      return run ? noteMergedAfterEnd(db, run, delivered, { mergeSha, source }, now()) : false;
    });
    if (kept) this.deps.log(`delivery watcher: ${delivered.ref} merged at ${mergeSha.slice(0, 8)} after its run ended; a divergence asks you`);
  }

  /**
   * The event waits of `dispatch --after` (src/lifecycle/watches.ts): close a
   * watch nothing waits for, fire one whose event happened (a scout's report,
   * a PR Flowryn delivered that landed, else GitHub's word on the PR), and
   * kick the scheduler when one fired. GitHub is skipped while it is quiet
   * after a failure; Flowryn's own records still decide.
   */
  private async settleWatches(): Promise<void> {
    const { db, now } = this.deps;
    let fired = false;
    for (const watch of openWatches(db)) {
      if (this.stopped) return;
      const pending = pendingTaskIds(db);
      const orphan = orphanReason(db, watch, backlogTasks(db), pending);
      if (orphan) {
        tx(db, () => closeWatch(db, watch, orphan.why, orphan.removeTask, now()));
        continue;
      }
      // Fire only once the backlog holds the waiting task and its edge, so the scheduler kicked below can start it at once.
      if (pending.has(watch.task_id) || pending.has(watch.waiter_task)) continue;
      let verdict: WatchVerdict | null = null;
      if (watch.kind === "report") verdict = reportVerdict(db, watch.target);
      else {
        const project = getProject(db, watch.project_id);
        const repo = project ? projectRepo(project, this.deps.webUrl()) : null;
        if (!repo) verdict = { stuck: project ? `project ${watch.project_id} has no GitHub remote` : `project ${watch.project_id} is gone` };
        else {
          const ref = { ...repo, number: Number(watch.target) };
          verdict = ownPrVerdict(db, prUrlOf(repo, ref.number, this.deps.webUrl()));
          if (!verdict) {
            if (now() < this.forgeQuietUntil) continue;
            try {
              verdict = prVerdict((await this.deps.forge().pull(ref)).state);
              tx(db, () => noteForgeUp(db, "github", now()));
            } catch (error) {
              if (error instanceof ForgeError && error.kind === "not_found") verdict = { stuck: "GitHub does not find it" };
              else {
                this.forgeFailed(error);
                continue;
              }
            }
          }
        }
      }
      const current = verdict;
      // The watch may have closed or fired while GitHub was read.
      if (tx(db, () => (watchOfTask(db, watch.task_id)?.state === "open" ? applyVerdict(db, watch, current, now()) : false))) fired = true;
    }
    if (fired) this.deps.kickScheduler();
  }

  /** GitHub failed: back off (to a rate limit's own end when it names one), never retrying in a tight loop. */
  private forgeFailed(error: unknown): void {
    const { db, now } = this.deps;
    // Unavailable or rate-limited while a merge waits: one P1 for the outage (design section 16).
    if (isForgeOutage(error)) tx(db, () => noteForgeDown(db, error, "github", now()));
    this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs === 0 ? this.deps.pollMs() : this.backoffMs * 2);
    const retryAt = error instanceof ForgeError && error.retryAt ? error.retryAt : now() + this.backoffMs;
    this.forgeQuietUntil = retryAt;
    this.deps.log(`delivery watcher: GitHub failed (${(error as Error).message}); quiet until ${new Date(retryAt).toISOString()}`);
  }

  /** A local-only merge whose proof was not seen (the daemon stopped mid-merge): look at the local default branch. */
  private async watchLocalMerges(): Promise<void> {
    const { db, now } = this.deps;
    const runs = this.runs(
      `SELECT r.id FROM runs r JOIN task_policy p ON p.task_id = r.task_id WHERE p.kind = 'ship' AND p.delivery_mode = 'local-only' AND r.state = 'merging'`,
    );
    for (const run of runs) {
      const merge = latestMerge(db, run.task_id);
      const project = getProject(db, run.project_id);
      if (!merge || !project || (merge.state !== "requested" && merge.state !== "unproven") || this.deps.inFlight.has(merge.id)) continue;
      const seen = deliveryBasis(db, run.id);
      const proof = await proveLocal(this.deps.git, project, merge.head_sha);
      const parts = proof.state === "merged" ? MERGED_PARTS : LOCAL_MERGE_PARTS;
      const observed = deliveryTransition(db, seen, parts, "local_merge_proof", "daemon", now(), (current) => {
        recordMergeResult(db, current, merge.id, proof.state === "merged" ? proof : { state: "unproven", detail: `${proof.detail}; the daemon stopped before the merge's result was known` }, now());
        return proof.state === "merged";
      });
      const delivered = deliveredOf(db, run.task_id);
      if (!observed.applied && proof.state === "merged" && delivered && !observed.changed.delivered) this.keepLateMerge(run.id, delivered, proof.sha, "daemon");
      if (observed.applied && observed.value) this.deps.cleanup(run.id);
    }
  }

  /**
   * Read the no-mistakes status of every run holding a validation slot now,
   * outside the poll: the restart guard asks for it so its decision rests on
   * a read seconds old (src/daemon/restart.ts). A read in progress is shared,
   * and one that finished under VALIDATION_READ_MIN_GAP_MS ago is enough.
   * Never throws.
   */
  async readValidations(): Promise<void> {
    try {
      if (this.nmRead) await this.nmRead;
      else if (this.deps.now() - this.nmReadAt >= VALIDATION_READ_MIN_GAP_MS) await this.readNoMistakes(true);
    } catch (error) {
      this.deps.log(`delivery watcher: no-mistakes read for the restart guard: ${(error as Error).message}`);
    }
  }

  private async watchNoMistakes(): Promise<void> {
    while (this.nmRead) await this.nmRead.catch(() => undefined);
    await this.readNoMistakes(false);
  }

  /** One status read at a time: the poll's (every watched run) or the restart guard's (validation slots only). */
  private readNoMistakes(leasedOnly: boolean): Promise<void> {
    const read: Promise<void> = this.readNmRuns(leasedOnly).finally(() => {
      if (this.nmRead === read) this.nmRead = null;
      this.nmReadAt = this.deps.now();
    });
    this.nmRead = read;
    return read;
  }

  private async readNmRuns(leasedOnly: boolean): Promise<void> {
    const { db, now } = this.deps;
    const noMistakes = this.deps.noMistakes();
    if (!noMistakes) return;
    if (!leasedOnly) {
      for (const run of strandedCiWaits(db)) tx(db, () => closeCiWaits(db, run, `the run is ${run.state}`, now()));
    }
    const runs = this.runs(
      `SELECT r.id FROM runs r JOIN task_policy p ON p.task_id = r.task_id
       WHERE p.kind = 'ship' AND p.delivery_mode = 'no-mistakes' AND r.state IN ('running','validating')
         AND (?1 = 0 OR EXISTS (SELECT 1 FROM pool_leases l WHERE l.run_id = r.id AND l.pool = ?2 AND l.released_at IS NULL))`,
      leasedOnly ? 1 : 0,
      VALIDATION_POOL,
    );
    for (const run of runs) {
      if (this.stopped || !existsSync(run.worktree_path)) continue;
      const seen = deliveryBasis(db, run.id);
      const status = await (this.deps.readNmStatus ?? readNmStatus)(noMistakes, run.worktree_path, this.deps.nmTimeoutMs());
      if (status.code !== 0) {
        this.nmFailures++;
        if (this.nmFailures >= NM_DOWN_AFTER) tx(db, () => noteNmOutage(db, true, status.text.trim().split("\n")[0]?.slice(0, 120) || `exit ${status.code}`, now()));
        continue;
      }
      if (this.nmFailures > 0) tx(db, () => noteNmOutage(db, false, "", now()));
      this.nmFailures = 0;
      const nm = parseNmStatus(status.text);
      const observed = deliveryTransition(db, seen, NM_PARTS, "nm_observation", "nomistakes", now(), (current) => applyNmObservation(db, current, nm, this.deps.validationStuckMs(), now()));
      // The poll asks the watchdog; the restart guard's read only refreshes the status.
      if (observed.applied && !leasedOnly) await this.watchCiWait(run, nm, observed.value.ciSince);
    }
  }

  /**
   * The CI-wait watchdog (src/lifecycle/ci-wait.ts): a pipeline that has
   * waited only on CI for `[validation] ci_wait_alert` minutes with no checks
   * on its PR opens one decision for the user. A question whose wait ended
   * (CI started, another pipeline run, no run) is closed unanswered.
   */
  private async watchCiWait(run: RunWithPolicy, nm: NmRun | null, ciSince: number | null): Promise<void> {
    const { db, now } = this.deps;
    const minutes = nm && nm.branch === run.branch ? ciWaitMinutes(nm, ciSince, now()) : null;
    if (nm === null || minutes === null) {
      tx(db, () => closeCiWaits(db, run, nm ? "the pipeline is no longer waiting only on CI" : "no-mistakes names no run", now()));
      return;
    }
    tx(db, () => closeCiWaits(db, run, "a new pipeline run", now(), nm.id));
    const alert = this.deps.ciWaitAlertMin();
    if (!ciWaitDue(db, run.id, nm.id, minutes, alert, now())) return;
    const seen = deliveryBasis(db, run.id);
    const checks = await this.prCheckCount(nm.pr);
    if (checks === null || checks > 0) return;
    const project = getProject(db, run.project_id);
    if (!project) return;
    const facts = await readBranchFacts(this.deps.git, run.worktree_path, runBase(run, project));
    const observed = deliveryTransition(db, seen, CI_WAIT_PARTS, "ci_wait", "nomistakes", now(), (current) => {
      if (current.state !== "validating" && current.state !== "running") return null;
      if (!ciWaitDue(db, run.id, nm.id, minutes, alert, now())) return null;
      const id = openCiWait(db, current, project.id, { nmRun: nm.id, minutes, pr: nm.pr, defaultBranch: runBase(run, project) }, facts, alert, now());
      yieldToCiWait(db, current, nm, now());
      return id;
    });
    const opened = observed.applied ? observed.value : null;
    if (opened) this.deps.log(`delivery watcher: ${run.task_id} waited ${minutes} min on CI with no checks; asked the user (${opened})`);
  }

  /** How many checks the PR's head has; 0 with no PR named; null when unknown (GitHub failed or backing off, not a PR here, or no longer open). */
  private async prCheckCount(prUrl: string): Promise<number | null> {
    if (!prUrl) return 0;
    const ref = parsePrUrl(prUrl, this.deps.webUrl());
    if (!ref || this.deps.now() < this.forgeQuietUntil) return null;
    try {
      const forge = this.deps.forge();
      const pr = await forge.pull(ref);
      const count = pr.state === "open" ? (await forge.checks(ref, pr.headSha)).checks.length : null;
      tx(this.deps.db, () => noteForgeUp(this.deps.db, "github", this.deps.now()));
      this.backoffMs = 0;
      return count;
    } catch (error) {
      if (error instanceof ForgeError && error.kind === "not_found") {
        this.deps.log(`delivery watcher: CI-wait check of ${prUrl} skipped: it is not found on GitHub`);
        return null;
      }
      this.forgeFailed(error);
      return null;
    }
  }

  /**
   * A scout that delivered its report before scouts landed with it (an
   * earlier version kept it ready): land it now, and the cleanup follows.
   */
  private landDeliveredScouts(): void {
    const { db, now } = this.deps;
    const rows = db.query("SELECT r.id FROM runs r JOIN task_policy p ON p.task_id = r.task_id WHERE p.kind = 'scout' AND r.state = 'ready'").all() as { id: string }[];
    for (const row of rows) {
      tx(db, () => {
        const run = getRunWithPolicy(db, row.id);
        const report = db.query("SELECT ref FROM artifacts WHERE task_id = ?1 AND kind = 'report' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(run?.task_id ?? "") as { ref: string } | null;
        if (run && run.state === "ready" && report) landScout(db, run, report.ref, now());
      });
    }
  }

  /** A landed run whose cleanup never ran: run it now (restart is a non-event). */
  private resumeCleanups(): void {
    const rows = this.deps.db.query("SELECT id FROM runs WHERE state = 'landed' AND cleanup IS NULL").all() as { id: string }[];
    for (const row of rows) this.deps.cleanup(row.id);
  }
}
