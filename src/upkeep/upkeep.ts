import type { UpkeepConfig } from "../config/upkeep.ts";
import { pruneExplanations, type PruneReport } from "../attention/explanations.ts";
import { closeSeenInfoItems, INFO_KEEP_MS } from "../attention/items.ts";
import { tx, type Db } from "../db/db.ts";
import { classPass, correctionsDueAt, correctionsPass, CORRECTIONS_WINDOW_MS, type ClassPass, type CorrectionsPass } from "../leader/corrections.ts";
import type { ProjectRow } from "../lifecycle/projects.ts";
import type { GitRunner } from "../policy/landed.ts";
import { lastReproved, recordReproof, reproveDue, reproveDueAt, type ProjectReproof } from "../verify/reprove.ts";
import type { BuildPass, MergeBuilder } from "./build.ts";
import { sweepCandidates } from "./sweep.ts";
import { recordSync, syncPrimary } from "./sync.ts";

/**
 * The upkeep loop (spec 3, phase 3): the routine work the leader did by hand,
 * as plain code on a timer. Each pass, in order: sync every project's primary
 * checkout (`[upkeep] sync_primary`), build the Flowryn checkout's new merge
 * (`build_after_merge`), then clean ended worktrees past their wait
 * (`clean_ended_hours`). Before all three, and even when the pass otherwise
 * waits, it prunes closed wait explanations past their retention
 * (`explanations_keep_days`, `explanations_keep_per_run`) and closes
 * informational items presented over a day ago (closeSeenInfoItems), once a
 * week files the corrections scouts and learnings sweeps, and at most hourly
 * between weeks a scout for a repeated class (src/leader/corrections.ts): each
 * one SQLite transaction, no checkout. Last, once a week and not while busy, it
 * starts the re-prove of every project's laws in a throwaway checkout
 * (src/verify/reprove.ts), which runs on past the pass so later passes are not held up.
 * Each project's result is recorded as it finishes, so a build's restart loses at most the
 * project under way, and the next start re-proves only the projects not yet done this week.
 * The fourth hook, the conflict nudge, rides the delivery watcher's PR reads
 * (src/reconcile/delivery.ts).
 *
 * A pass runs every `interval_ms` and soon after a run lands (`kick`), never
 * two at once, and not while a restart is asked for or under way, or while a
 * cleanup runs (sync and cleanup both work in the primary checkout); it waits
 * for the next kick or tick instead.
 */

/** A kick's pass starts after this pause, so a landing's own cleanup settles first. */
export const KICK_DELAY_MS = 1_000;
/** Between weekly corrections passes, a repeated class is looked for at most this often. */
export const CLASS_CHECK_MS = 60 * 60_000;

export interface UpkeepDeps {
  db: Db;
  config(): UpkeepConfig;
  now(): number;
  log(message: string): void;
  git: GitRunner;
  projects(): ProjectRow[];
  builder: Pick<MergeBuilder, "pass">;
  /** Why a pass must wait now (a restart asked for or under way, a cleanup running), or null. */
  busy(): string | null;
  /** The cleanup guard's path (`flowryn cleanup` with no discard), recorded as the sweep's. */
  sweep(runId: string): Promise<{ outcome: string; reason: string; task: string }>;
  /** Re-prove one project's laws (src/verify/reprove.ts); the signal ends it when the loop stops. */
  reprove(project: ProjectRow, signal: AbortSignal): Promise<ProjectReproof>;
}

export interface PassReport {
  waited?: string;
  pruned: PruneReport | null;
  /** Informational items closed by their retention this pass. */
  infoClosed: string[];
  /** The weekly corrections pass (src/leader/corrections.ts), or null when it was not due. */
  corrections: CorrectionsPass | null;
  /** Scouts filed between weeks for a repeated class, or null when not looked for this pass. */
  repeats?: ClassPass | null;
  synced: string[];
  build: BuildPass | null;
  swept: { run: string; outcome: string; reason: string }[];
  /** The weekly re-prove of every project's laws, when this pass started it: its results, or undefined when stopped or failed. */
  reproving?: Promise<ProjectReproof[] | undefined>;
}

export class Upkeep {
  private readonly deps: UpkeepDeps;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private kickTimer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<PassReport> | null = null;
  private stopped = false;
  private lastSkip: string | null = null;
  /** When the weekly corrections pass is next due, as last read (0: read it on the next pass). */
  private correctionsDue = 0;
  /** When a repeated class is next looked for. */
  private classDue = 0;
  /** When a project's weekly re-prove is next due, as last read (0: read it on the next pass). */
  private reproveDue = 0;
  /** Ends a re-prove under way when the loop stops. */
  private reproving: AbortController | null = null;
  /** The re-prove under way, which outlives the pass that started it. */
  private reproveRun: Promise<ProjectReproof[] | undefined> | null = null;

  constructor(deps: UpkeepDeps) {
    this.deps = deps;
  }

  start(): void {
    this.stopped = false;
    this.arm();
  }

  /** No new pass after this; resolves when the pass under way, if any, has ended (the daemon closes the database after). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.timer = null;
    this.kickTimer = null;
    this.reproving?.abort();
    await this.running;
    await this.reproveRun;
  }

  /** A run landed: look soon rather than at the next tick. */
  kick(): void {
    if (this.stopped || this.kickTimer) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      void this.pass();
    }, KICK_DELAY_MS);
  }

  private arm(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pass().finally(() => this.arm());
    }, this.deps.config().interval_ms);
  }

  /** One pass; a pass already running is returned instead of starting another. Exposed for tests. */
  pass(): Promise<PassReport> {
    if (this.running) return this.running;
    this.running = this.passOnce()
      .catch((error: unknown) => {
        this.deps.log(`upkeep: ${(error as Error).stack ?? String(error)}`);
        return { pruned: null, infoClosed: [], corrections: null, synced: [], build: null, swept: [] } satisfies PassReport;
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private prune(config: UpkeepConfig): PruneReport | null {
    try {
      const pruned = pruneExplanations(this.deps.db, { keepDays: config.explanations_keep_days, keepPerRun: config.explanations_keep_per_run }, this.deps.now());
      if (pruned.deleted > 0) this.deps.log(`upkeep: pruned ${pruned.deleted} closed wait explanations (${pruned.byAge} by age, ${pruned.byCount} over the per-run cap)`);
      return pruned;
    } catch (error) {
      // A failed prune must not stop the sync, build and sweep behind it.
      this.deps.log(`upkeep: pruning wait explanations failed: ${(error as Error).message}`);
      return null;
    }
  }

  private closeInfo(): string[] {
    try {
      const closed = closeSeenInfoItems(this.deps.db, this.deps.now());
      if (closed.length > 0) this.deps.log(`upkeep: closed ${closed.length} informational items presented over ${INFO_KEEP_MS / 3_600_000} h ago`);
      return closed;
    } catch (error) {
      // Like a failed prune, it must not stop the sync, build and sweep behind it.
      this.deps.log(`upkeep: closing informational items failed: ${(error as Error).message}`);
      return [];
    }
  }

  private corrections(): CorrectionsPass | null {
    const now = this.deps.now();
    if (now < this.correctionsDue) return null;
    try {
      const pass = correctionsPass(this.deps.db, this.deps.projects(), now);
      this.correctionsDue = pass ? now + CORRECTIONS_WINDOW_MS : correctionsDueAt(this.deps.db);
      if (pass && pass.filed.length > 0) this.deps.log(`upkeep: filed ${pass.filed.length} corrections scouts (${pass.filed.map((f) => `${f.project} ${f.task}`).join(", ")})`);
      if (pass && pass.swept.length > 0) this.deps.log(`upkeep: filed ${pass.swept.length} learnings sweeps (${pass.swept.map((f) => `${f.project} ${f.task}`).join(", ")})`);
      return pass;
    } catch (error) {
      // Like a failed prune, it must not stop the sync, build and sweep behind it; the next pass tries again.
      this.deps.log(`upkeep: the weekly corrections pass failed: ${(error as Error).message}`);
      return null;
    }
  }

  /** Between weekly passes, at most hourly: a scout for a project whose corrections repeat. */
  private repeats(weekly: CorrectionsPass | null): ClassPass | null {
    const now = this.deps.now();
    if (weekly || now < this.classDue) return null;
    this.classDue = now + CLASS_CHECK_MS;
    try {
      const pass = classPass(this.deps.db, this.deps.projects(), now);
      if (pass.filed.length > 0) this.deps.log(`upkeep: filed ${pass.filed.length} corrections scouts for a repeat (${pass.filed.map((f) => `${f.project} ${f.task}: ${f.repeat.join(", ")}`).join("; ")})`);
      return pass;
    } catch (error) {
      this.deps.log(`upkeep: looking for repeated corrections failed: ${(error as Error).message}`);
      return null;
    }
  }

  /** The projects whose laws are re-proved: those not removed. */
  private reprovable(): ProjectRow[] {
    return this.deps.projects().filter((p) => p.removed_at == null);
  }

  /** Start the weekly re-prove when a project's is due and none is under way; it runs on past the pass. */
  private startReprove(): Promise<ProjectReproof[] | undefined> | undefined {
    if (this.reproveRun) return undefined;
    if (this.reproveDue === 0) this.reproveDue = reproveDueAt(this.deps.db, this.reprovable().map((p) => p.id), this.deps.now());
    if (this.deps.now() < this.reproveDue) return undefined;
    const run = this.reprove().finally(() => {
      this.reproveRun = null;
    });
    this.reproveRun = run;
    return run;
  }

  /**
   * Re-prove the laws of each project not re-proved this week, recording each as it finishes, so a
   * stop loses only the project under way; the next start re-proves the rest.
   */
  private async reprove(): Promise<ProjectReproof[] | undefined> {
    const controller = new AbortController();
    this.reproving = controller;
    try {
      const projects = this.reprovable();
      const last = lastReproved(this.deps.db);
      const results: ProjectReproof[] = [];
      for (const project of projects) {
        if (!reproveDue(last, project.id, this.deps.now())) continue;
        if (this.stopped || controller.signal.aborted) return undefined;
        const result = await this.deps.reprove(project, controller.signal);
        // Cut off by the stop: its laws were not all re-proved, so it runs again at the next start.
        if (controller.signal.aborted) return undefined;
        const item = recordReproof(this.deps.db, result, this.deps.now());
        results.push(result);
        if (result.skipped !== null) this.deps.log(`upkeep: re-proving laws in ${project.id} skipped (${result.skipped})`);
        else {
          const unproven = result.laws.filter((l) => l.state === "unproven").length;
          const unrun = result.laws.filter((l) => l.state === "unrun").length;
          this.deps.log(`upkeep: re-proved ${result.laws.length} laws in ${project.id}; ${unproven} no longer proven${unrun > 0 ? `; ${unrun} could not run` : ""}${item ? ` (${item})` : ""}`);
        }
      }
      this.reproveDue = reproveDueAt(this.deps.db, projects.map((p) => p.id), this.deps.now());
      return results;
    } catch (error) {
      // Tried again at the next pass, for the projects not yet recorded; the sync, build and sweep already ran.
      this.deps.log(`upkeep: re-proving laws failed: ${(error as Error).message}`);
      return undefined;
    } finally {
      this.reproving = null;
    }
  }

  private async passOnce(): Promise<PassReport> {
    const config = this.deps.config();
    const corrections = this.corrections();
    const report: PassReport = { pruned: this.prune(config), infoClosed: this.closeInfo(), corrections, repeats: this.repeats(corrections), synced: [], build: null, swept: [] };
    const waiting = this.deps.busy();
    if (waiting) {
      report.waited = waiting;
      return report;
    }
    if (config.sync_primary) {
      for (const project of this.deps.projects()) {
        const outcome = await syncPrimary(this.deps.git, project);
        const line = tx(this.deps.db, () => recordSync(this.deps.db, project, outcome, this.deps.now()));
        if (line) this.deps.log(`upkeep: ${line}`);
        if (outcome.outcome === "synced") report.synced.push(project.id);
      }
    }
    if (config.build_after_merge && !this.deps.busy()) {
      report.build = await this.deps.builder.pass();
      // A skip is logged when its reason changes, not every pass.
      const skip = report.build.outcome === "skipped" ? report.build.reason : null;
      if (skip && skip !== this.lastSkip) this.deps.log(`upkeep build: skipped (${skip})`);
      this.lastSkip = skip;
    }
    for (const runId of sweepCandidates(this.deps.db, this.deps.now(), config.clean_ended_hours)) {
      if (this.stopped || this.deps.busy()) break;
      const result = await this.deps.sweep(runId);
      report.swept.push({ run: runId, outcome: result.outcome, reason: result.reason });
      this.deps.log(`upkeep: swept ${result.task}: ${result.outcome} (${result.reason})`);
    }
    if (!this.stopped && !this.deps.busy()) {
      const reproving = this.startReprove();
      if (reproving) report.reproving = reproving;
    }
    return report;
  }
}
