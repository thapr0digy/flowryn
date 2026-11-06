import { contractsConfig } from "../config/contracts.ts";
import type { FlowrynConfig } from "../config/config.ts";
import type { Db } from "../db/db.ts";
import { gateHarness, harnessesInUse, type GateCheck, type VersionOf } from "../lifecycle/harness-gate.ts";

/**
 * The harness version poll (docs/notes/2026-11-06-a-claude-pi-y5.md): Claude
 * Code updates itself while the daemon runs, so without a poll the first
 * dispatch after an update is what finds the new version. Every
 * `[contracts] version_poll_ms` the daemon runs the harness gate for each
 * harness in use (a project's, an open run's or a queued phase's), exactly
 * as a dispatch would: an untested version is flagged (`harness.unverified`,
 * `where: "poll"`), and under relaxed policy the automatic contract check
 * (src/contracts/auto.ts) starts on its next tick, before anyone dispatches.
 * The version read is the gate's own (`harnessVersion`: runBounded, cached by
 * the binary's mtime, so an unchanged binary costs a stat). Plain code: a
 * timer and the gate; nothing is decided here.
 */

export interface VersionPollDeps {
  db: Db;
  config(): FlowrynConfig;
  harnessVersion: VersionOf;
  now(): number;
  log(message: string): void;
  /** A restart pending or under way: the poll waits for the next daemon. */
  restartBusy(): boolean;
  /** A poll flagged a new untested version: look now (the automatic checker's kick). */
  flagged(): void;
}

export class HarnessVersionPoller {
  private readonly deps: VersionPollDeps;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private polling: Promise<GateCheck[]> | null = null;
  private stopped = false;

  constructor(deps: VersionPollDeps) {
    this.deps = deps;
  }

  /** The interval now (a reload can change it); 0: off. An invalid [contracts] is reported and polls at the default. */
  private intervalMs(): number {
    try {
      return contractsConfig(this.deps.config()).version_poll_ms;
    } catch (error) {
      this.deps.log(`contracts: version poll: ${(error as Error).message}; polling at the default`);
      return 600_000;
    }
  }

  start(): void {
    this.stopped = false;
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    const every = this.intervalMs();
    // Off: look again in a minute whether a reload turned it on.
    this.timer = setTimeout(() => {
      this.timer = null;
      const run = every > 0 ? this.poll() : Promise.resolve([]);
      void run.finally(() => this.schedule());
    }, every > 0 ? every : 60_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.polling?.catch(() => []);
  }

  /** One poll: the gate for each harness in use. Never throws; a harness whose check fails is logged and the rest go on. */
  poll(): Promise<GateCheck[]> {
    this.polling ??= this.pollOnce().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private async pollOnce(): Promise<GateCheck[]> {
    const { db, log } = this.deps;
    if (this.deps.restartBusy()) return [];
    const checks: GateCheck[] = [];
    let flagged = false;
    for (const harness of harnessesInUse(db)) {
      if (this.stopped) break;
      try {
        const check = await gateHarness(db, this.deps.config(), harness, this.deps.harnessVersion, "daemon", "poll", this.deps.now);
        checks.push(check);
        if (check.flaggedNow && check.state === "unverified") {
          flagged = true;
          log(`contracts: version poll found ${harness} ${check.version} with no passing contract run`);
        }
      } catch (error) {
        log(`contracts: version poll of ${harness} failed: ${(error as Error).message}`);
      }
    }
    if (flagged) this.deps.flagged();
    return checks;
  }
}
