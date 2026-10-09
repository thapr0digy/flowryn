import type { UpkeepConfig } from "../config/upkeep.ts";
import { tx, type Db } from "../db/db.ts";
import type { ProjectRow } from "../lifecycle/projects.ts";
import type { GitRunner } from "../policy/landed.ts";
import type { BuildPass, MergeBuilder } from "./build.ts";
import { sweepCandidates } from "./sweep.ts";
import { recordSync, syncPrimary } from "./sync.ts";

/**
 * The upkeep loop (spec 3, phase 3): the routine work the leader did by hand,
 * as plain code on a timer. Each pass, in order: sync every project's primary
 * checkout (`[upkeep] sync_primary`), build the Flowryn checkout's new merge
 * (`build_after_merge`), then clean ended worktrees past their wait
 * (`clean_ended_hours`). The fourth hook, the conflict nudge, rides the
 * delivery watcher's PR reads (src/reconcile/delivery.ts).
 *
 * A pass runs every `interval_ms` and soon after a run lands (`kick`), never
 * two at once, and not while a restart is asked for or under way, or while a
 * cleanup runs (sync and cleanup both work in the primary checkout); it waits
 * for the next kick or tick instead.
 */

/** A kick's pass starts after this pause, so a landing's own cleanup settles first. */
export const KICK_DELAY_MS = 1_000;

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
}

export interface PassReport {
  waited?: string;
  synced: string[];
  build: BuildPass | null;
  swept: { run: string; outcome: string; reason: string }[];
}

export class Upkeep {
  private readonly deps: UpkeepDeps;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private kickTimer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<PassReport> | null = null;
  private stopped = false;
  private lastSkip: string | null = null;

  constructor(deps: UpkeepDeps) {
    this.deps = deps;
  }

  start(): void {
    this.stopped = false;
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.timer = null;
    this.kickTimer = null;
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
        return { synced: [], build: null, swept: [] } satisfies PassReport;
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async passOnce(): Promise<PassReport> {
    const report: PassReport = { synced: [], build: null, swept: [] };
    const config = this.deps.config();
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
    return report;
  }
}
