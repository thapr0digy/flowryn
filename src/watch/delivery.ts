import { existsSync } from "node:fs";
import type { Db } from "../db/db.ts";
import { tx } from "../db/db.ts";
import { parsePrUrl } from "../forge/github.ts";
import { ForgeError, type Forge } from "../forge/types.ts";
import { deliveredOf } from "../lifecycle/delivery.ts";
import { ciWaitDue, ciWaitMinutes, closeCiWaits, openCiWait, readBranchFacts, strandedCiWaits } from "../lifecycle/ci-wait.ts";
import { landScout } from "../lifecycle/landing.ts";
import { getProject } from "../lifecycle/projects.ts";
import { getRunWithPolicy, type RunWithPolicy } from "../lifecycle/runs.ts";
import { latestMerge, proveLocal, recordMergeResult } from "../policy/merge.ts";
import type { GitRunner } from "../policy/landed.ts";
import { parseNmStatus, readNmStatus, type NmRun } from "../policy/nomistakes.ts";
import { applyNmObservation, applyPrObservation, noteNmOutage } from "../reconcile/delivery.ts";
import { isForgeOutage, noteForgeDown, noteForgeUp, settleForgeAlert } from "../reconcile/forge-health.ts";

/**
 * The delivery watchers (design section 4, src/watch): GitHub PR state, head
 * and checks for every delivered ship (conditional requests with ETags, so a
 * quiet poll costs nothing), the proof of a merge still unproven, local-only
 * merges, the read-only no-mistakes status of validating runs, and landed
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
  noMistakes(): string | null;
  nmTimeoutMs(): number;
  pollMs(): number;
  inFlight: ReadonlySet<string>;
  /** `[validation] ci_wait_alert`: minutes a pipeline may wait on CI with no checks before the user is asked (0: off). */
  ciWaitAlertMin(): number;
  /** Clean up a run that landed (the daemon's own cleanup after a proven merge). */
  cleanup(runId: string): void;
  /** `[upkeep] nudge_conflicts`: a delivered PR that conflicts with its base sends its ship back. */
  nudgeConflicts(): boolean;
  /** A nudged ship's last stage waits for a grant: the scheduler looks now. */
  kickScheduler(): void;
  log(line: string): void;
  now(): number;
}

const MAX_BACKOFF_MS = 10 * 60_000;
/** Consecutive failed status reads before no-mistakes counts as down. */
const NM_DOWN_AFTER = 3;
/** A read for the restart guard is skipped when a status read finished this recently. */
export const VALIDATION_READ_MIN_GAP_MS = 15_000;
/** The pool the ship stage's no-mistakes pipeline runs under (src/config/workflows.ts). */
const VALIDATION_POOL = "validation";

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

  constructor(deps: DeliveryWatcherDeps) {
    this.deps = deps;
  }

  start(): void {
    this.started = true;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
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
      await this.watchLocalMerges();
      await this.watchNoMistakes();
      this.landDeliveredScouts();
      this.resumeCleanups();
    } catch (error) {
      this.deps.log(`delivery watcher: ${(error as Error).stack ?? String(error)}`);
    }
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
      const delivered = deliveredOf(db, run.task_id);
      if (!delivered || delivered.kind !== "pr") continue;
      const ref = parsePrUrl(delivered.ref, this.deps.webUrl());
      if (!ref) continue;
      try {
        const pr = await forge.pull(ref);
        const checks = pr.state === "open" ? await forge.checks(ref, pr.headSha) : null;
        const applied = tx(db, () => {
          noteForgeUp(db, "github", now());
          const current = getRunWithPolicy(db, run.id);
          return current ? applyPrObservation(db, current, delivered, { pr, checks }, this.deps.inFlight, now(), { nudgeConflicts: this.deps.nudgeConflicts() }) : { landed: false };
        });
        this.backoffMs = 0;
        if (applied.landed) this.deps.cleanup(run.id);
        if (applied.nudged) this.deps.kickScheduler();
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
      const proof = await proveLocal(this.deps.git, project, merge.head_sha);
      const landed = tx(db, () => {
        const current = getRunWithPolicy(db, run.id);
        if (!current) return false;
        recordMergeResult(db, current, merge.id, proof.state === "merged" ? proof : { state: "unproven", detail: `${proof.detail}; the daemon stopped before the merge's result was known` }, now());
        return proof.state === "merged";
      });
      if (landed) this.deps.cleanup(run.id);
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
      const status = await readNmStatus(noMistakes, run.worktree_path, this.deps.nmTimeoutMs());
      if (status.code !== 0) {
        this.nmFailures++;
        if (this.nmFailures >= NM_DOWN_AFTER) tx(db, () => noteNmOutage(db, true, status.text.trim().split("\n")[0]?.slice(0, 120) || `exit ${status.code}`, now()));
        continue;
      }
      if (this.nmFailures > 0) tx(db, () => noteNmOutage(db, false, "", now()));
      this.nmFailures = 0;
      const nm = parseNmStatus(status.text);
      const observed = tx(db, () => {
        const current = getRunWithPolicy(db, run.id);
        return current ? applyNmObservation(db, current, nm, now()) : null;
      });
      // The poll asks the watchdog; the restart guard's read only refreshes the status.
      if (observed && !leasedOnly) await this.watchCiWait(run, nm, observed.ciSince);
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
    const checks = await this.prCheckCount(nm.pr);
    if (checks === null || checks > 0) return;
    const project = getProject(db, run.project_id);
    if (!project) return;
    const facts = await readBranchFacts(this.deps.git, run.worktree_path, project.default_branch);
    const opened = tx(db, () => {
      const current = getRunWithPolicy(db, run.id);
      if (!current || (current.state !== "validating" && current.state !== "running")) return null;
      if (!ciWaitDue(db, run.id, nm.id, minutes, alert, now())) return null;
      return openCiWait(db, current, project.id, { nmRun: nm.id, minutes, pr: nm.pr, defaultBranch: project.default_branch }, facts, alert, now());
    });
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
