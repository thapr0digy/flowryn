import { realpathSync } from "node:fs";
import type { Timing } from "../config/workers.ts";
import type { Db } from "../db/db.ts";
import { tx } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { findOpenRunItem, openItem, resolveRunItems } from "../attention/items.ts";
import { identityOf } from "../lifecycle/control.ts";
import { getRun, isTerminal, openRunItemOnce, openRuns, recordEvidence, setLiveness, taskTitle, type Liveness, type RunRow } from "../lifecycle/runs.ts";
import { flagUnackedSteers, unackedSteers, type SteerBus } from "../lifecycle/steers.ts";
import { HerdrError } from "../runtime/herdr/client.ts";
import { RUN_TOKEN, type HerdrRuntime, type PaneProcesses } from "../runtime/herdr/runtime.ts";
import { isAlive, type PsRunner } from "../runtime/proc.ts";
import { openDivergence } from "./divergence.ts";
import { clearPrompt, idleByDesign, openBlockedPrompt } from "../lifecycle/prompt-wedge.ts";
import { idleAlertDue, idleEpisodeStart, waitingOnOthers } from "../lifecycle/idle-alert.ts";
import { reminderIgnored } from "../lifecycle/turn-end-guard.ts";
import { staleHooksDue } from "../lifecycle/stale-hooks.ts";
import { describeJobs, runningBackgroundJobs } from "../lifecycle/background-jobs.ts";
import { carryIdleSteer, idleCarryBlocker } from "../lifecycle/idle-carry.ts";
import { noteHerdrUp } from "./herdr-health.ts";
import { applyDocker, listLabelled } from "./docker.ts";
import { checkInvariant } from "./invariant.ts";
import { releaseLeases } from "../sched/pools.ts";
import type { HarnessId } from "../harness/types.ts";
import { contractsCommand, harnessFacts, harnessUnblock, type HarnessCheck } from "../lifecycle/harness-gate.ts";
import { explain, type Fact } from "../attention/explanations.ts";

/**
 * The reconciler (design section 6): the one owner of current-state truth for
 * each run. It ranks its sources: the process table (rank 2) over harness
 * events (rank 3) over the worker's own claims (rank 4) over Herdr's agent
 * status (rank 5, a hint that only triggers a look). It writes liveness and
 * evidence; any change to runs.state it makes is one of the lifecycle
 * transitions (resume, fail) with its journal intent.
 *
 * The only automatic actions (design section 6): resume a dead run once from
 * its stored session; re-ring an unacknowledged steer (the rings themselves
 * happen in the hooks, which see a steer due again); type a due steer's
 * pointer into an idle Claude worker whose waiter is gone (idleCarry); re-arm
 * monitoring after a restart. Everything else is a pointer for the leader.
 */

export interface ReconcilerDeps {
  db: Db;
  runtime(): HerdrRuntime | null;
  launch(runId: string, mode: "fresh" | "resume"): void;
  isLaunching(runId: string): boolean;
  bus: SteerBus;
  timing(): Timing;
  log(message: string): void;
  now(): number;
  ps?: PsRunner;
  /** The docker binary for the label evidence, or null (none installed: nothing to count). */
  docker?(): string | null;
  /** Leases were released: the scheduler may grant them to waiting work. */
  released?(): void;
  /**
   * Check the installed harness version before a launch or resume (design
   * section 5), recording the P1 for an untested one; absent, every harness
   * counts as verified.
   */
  harnessGate?(harness: HarnessId): Promise<HarnessCheck>;
  /**
   * Bring the backlog snapshot up to date with the file (the watcher's check),
   * and say whether it now matches it; absent, the invariant pass is skipped.
   */
  backlogFresh?(): Promise<boolean>;
}

export type PassReason = "startup" | "reconnect" | "steady" | "event" | "kick";

/** Runs in a finished-work state do not need a live worker; their death is not a failure. */
const WORK_DONE: readonly string[] = ["ready", "validating", "merging", "landed"];

/** Several husks at once at startup mean the Herdr server restarted (design section 6). */
const HUSK_RESTART_THRESHOLD = 2;

/** "idle" or "done": a run not actively mid-tool, for the dialog-gone two-pass check. */
function isSettledHerdrStatus(status: string | null): boolean {
  return status === "idle" || status === "done";
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

interface PassStats {
  checked: number;
  dead: number;
  resumed: number;
  reattached: number;
}

export class Reconciler {
  private readonly deps: ReconcilerDeps;
  /** Runs whose live process was matched since this daemon started: reattached once, then just watched. */
  private readonly attached = new Set<string>();
  /** Idle Claude runs seen with a due steer and no waiter: since when, over how many passes (idleCarry). */
  private readonly waiterless = new Map<string, { since: number; passes: number }>();
  private readonly queued = new Set<string>();
  private queuedAll: PassReason | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(deps: ReconcilerDeps) {
    this.deps = deps;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Ask for a look at one run (or all) soon; calls within the debounce window coalesce. */
  schedule(runId?: string, reason: PassReason = "kick"): void {
    if (this.stopped) return;
    if (runId) this.queued.add(runId);
    else this.queuedAll = this.queuedAll ?? reason;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 50);
  }

  /** A Herdr event names a pane; events carry no revision (M0 h01), so the run behind it is re-read. */
  onPane(paneId: string): void {
    const row = this.deps.db.query(`SELECT id FROM runs WHERE pane_id = ?1 AND state NOT IN ('cleaned','failed','cancelled')`).get(paneId) as { id: string } | null;
    if (row) this.schedule(row.id, "event");
  }

  private async flush(): Promise<void> {
    if (this.running) {
      await this.running;
      if (this.queued.size > 0 || this.queuedAll) this.schedule();
      return;
    }
    const all = this.queuedAll;
    const ids = [...this.queued];
    this.queuedAll = null;
    this.queued.clear();
    this.running = (all ? this.pass(all) : this.passRuns(ids, "event").then(() => undefined)).finally(() => {
      this.running = null;
    });
    await this.running;
  }

  /** A full pass now, serialized with scheduled passes so no two passes ever overlap. */
  async passNow(reason: PassReason): Promise<void> {
    if (this.stopped) return;
    this.queuedAll = this.queuedAll ?? reason;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.running) await this.running;
    if (this.queuedAll || this.queued.size > 0) await this.flush();
  }

  /** Every open run, plus the orphan scan and the steer checks. */
  async pass(reason: PassReason): Promise<void> {
    const { db, now, timing, log } = this.deps;
    const runs = openRuns(db);
    const stats = await this.passRuns(runs.map((r) => r.id), reason);
    await this.scanOrphans();
    await this.scanDocker();
    await this.checkBacklog();
    tx(db, () => flagUnackedSteers(db, now(), timing()));
    for (const run of runs) if (unackedSteers(db, run.id).length > 0) this.deps.bus.notify(run.id);
    if (reason === "startup" && stats.dead >= HUSK_RESTART_THRESHOLD) {
      log(`reconcile: ${stats.dead} husks at startup; the Herdr server probably restarted`);
      tx(db, () => appendEvent(db, { source: "reconciler", kind: "herdr.restart_suspected", payload: { husks: stats.dead } }));
    }
    if (reason !== "steady" || stats.dead + stats.resumed + stats.reattached > 0) {
      log(`reconcile ${reason}: ${stats.checked} run(s), ${stats.reattached} reattached, ${stats.dead} dead, ${stats.resumed} resumed`);
    }
  }

  private async passRuns(ids: string[], reason: PassReason): Promise<PassStats> {
    const stats: PassStats = { checked: 0, dead: 0, resumed: 0, reattached: 0 };
    for (const id of ids) {
      if (this.stopped) break;
      const run = getRun(this.deps.db, id);
      if (!run || isTerminal(run.state)) continue;
      stats.checked++;
      try {
        const outcome = await this.reconcileRun(run, reason);
        if (outcome === "dead") stats.dead++;
        if (outcome === "resumed") {
          stats.dead++;
          stats.resumed++;
        }
        if (outcome === "reattached") stats.reattached++;
      } catch (error) {
        this.deps.log(`reconcile ${id}: ${(error as Error).stack ?? String(error)}`);
      }
    }
    return stats;
  }

  private setLive(run: RunRow, liveness: Liveness, detail: Record<string, unknown>): void {
    const { db, now } = this.deps;
    tx(db, () => setLiveness(db, run, liveness, "reconciler", detail, now()));
  }

  async reconcileRun(run: RunRow, reason: PassReason): Promise<"alive" | "reattached" | "dead" | "resumed" | "orphaned" | "launching" | "unknown"> {
    const { db, now } = this.deps;
    if (this.deps.isLaunching(run.id)) return "launching";
    // A launch the scheduler owns: waiting for its grant, or a fresh stage worker being started.
    if (run.pending_launch) return "launching";
    const runtime = this.deps.runtime();
    if (!runtime) {
      this.setLive(run, "unknown", { reason: "Herdr is not configured or not reachable" });
      return "unknown";
    }
    const identity = identityOf(run);
    if (run.state === "launching" && !identity) {
      // A launch that never finished: the daemon died mid-launch, or Herdr was down. It waits for a verified harness.
      if (await this.harnessVerified(run.harness)) this.deps.launch(run.id, "fresh");
      return "launching";
    }

    let panes: PaneProcesses | null = null;
    try {
      panes = run.pane_id ? await runtime.processes(run.pane_id) : null;
    } catch (error) {
      if (error instanceof HerdrError) {
        this.setLive(run, "unknown", { reason: `Herdr: ${error.code}` });
        return "unknown";
      }
      throw error;
    }
    const alive = identity ? await isAlive(identity, this.deps.ps) : false;
    const leader = identity && panes ? panes.processes.find((p) => p.pid === identity.pid) : undefined;
    const inPane = Boolean(panes && identity && (leader || panes.foregroundGroup === identity.pid));
    const cwdMatches = !leader || leader.cwd === "" || realOrSelf(leader.cwd) === realOrSelf(run.worktree_path);
    const t = now();
    tx(db, () => {
      if (run.pane_id) noteHerdrUp(db, "reconciler", t);
      recordEvidence(db, run.id, "process", 2, { pid: identity?.pid ?? null, alive, in_pane: inPane, pane: run.pane_id, pane_exists: panes !== null }, t);
    });

    if (alive && inPane && cwdMatches) {
      let outcome: "alive" | "reattached" = "alive";
      if (!this.attached.has(run.id)) {
        this.attached.add(run.id);
        if (reason === "startup" || reason === "reconnect") {
          outcome = "reattached";
          tx(db, () =>
            appendEvent(db, { source: "reconciler", kind: "run.reattached", runId: run.id, taskId: run.task_id, payload: { pane: run.pane_id, pid: identity!.pid, reason } }),
          );
        }
      }
      await this.liveChecks(run, runtime);
      return outcome;
    }

    if (alive && panes && !inPane && panes.foregroundGroup === null) {
      // Herdr's shell-to-job handoff reply (M0 h02) names no job: not evidence the process left the pane. Read again next pass.
      this.setLive(run, "unknown", { reason: "Herdr: the pane has no foreground group yet" });
      return "unknown";
    }

    if (alive) {
      // The recorded process lives but not where the run says: never adopt it (design section 6).
      const summary = `run ${run.id}'s process ${identity!.pid} is alive but ${!panes ? `its pane ${run.pane_id ?? "(none)"} is gone` : !inPane ? `not in pane ${run.pane_id}` : `not in worktree ${run.worktree_path}`}`;
      tx(db, () => {
        setLiveness(db, run, "orphaned", "reconciler", { summary }, t);
        openDivergence(db, "reconciler", { runId: run.id, taskId: run.task_id, higher: "process", lower: "run", summary }, t);
      });
      return "orphaned";
    }

    return this.handleDeath(run, panes);
  }

  /** The harness gate before a launch this reconciler starts; a check that throws counts as unverified. */
  private async harnessVerified(harness: HarnessId): Promise<boolean> {
    return (await this.harnessCheck(harness)).state === "verified";
  }

  private async harnessCheck(harness: HarnessId): Promise<HarnessCheck> {
    if (!this.deps.harnessGate) return { harness, state: "verified", version: "unchecked" };
    try {
      return await this.deps.harnessGate(harness);
    } catch (error) {
      return { harness, state: "missing", detail: (error as Error).message };
    }
  }

  /** Liveness of a run whose process is ours and alive, and the judgment pointers (design section 6). */
  private async liveChecks(run: RunRow, runtime: HerdrRuntime): Promise<void> {
    const { db, now, timing } = this.deps;
    const t = now();
    const tm = timing();
    const launchedAt = run.launched_at ?? run.started_at;
    const started = run.worker_started_at !== null && run.worker_started_at >= launchedAt;
    let herdrStatus: string | null = null;
    try {
      herdrStatus = run.pane_id ? await runtime.agentStatus(run.pane_id) : null;
    } catch {
      herdrStatus = null;
    }
    tx(db, () => {
      // Read before recordEvidence overwrites run_evidence's one row per (run_id, source) below.
      const previousHerdr = db.query("SELECT value FROM run_evidence WHERE run_id = ?1 AND source = 'herdr'").get(run.id) as { value: string } | null;
      const previousHerdrStatus = previousHerdr ? ((JSON.parse(previousHerdr.value) as { agent_status?: string }).agent_status ?? null) : null;
      if (herdrStatus !== null) recordEvidence(db, run.id, "herdr", 5, { agent_status: herdrStatus }, t);
      if (!started) {
        if (t - launchedAt >= tm.trust_wedge_ms) {
          setLiveness(db, run, "blocked_dialog", "reconciler", { since: launchedAt }, t);
          const event = appendEvent(db, { source: "reconciler", kind: "run.blocked_dialog", runId: run.id, taskId: run.task_id, payload: { waited_ms: t - launchedAt } });
          openRunItemOnce(db, "trust_dialog", run, event.seq, `Worker for ${taskTitle(db, run.task_id)} has not started ${Math.round((t - launchedAt) / 1000)}s after launch; a dialog may be blocking pane ${run.pane_id}`, t);
          explainTrust(db, run, launchedAt, tm.trust_wedge_ms, t);
        } else setLiveness(db, run, "starting", "reconciler", {}, t);
        return;
      }
      const busy = run.busy_until !== null && run.busy_until > t;
      const lastHook = run.last_hook_at ?? launchedAt;
      const prompted = findOpenRunItem(db, "blocked_prompt", run.id) !== null;
      if (prompted) {
        /**
         * Spike c12: Herdr reads "blocked" for exactly the duration of a
         * Claude dialog. An Esc decline interrupts the turn and fires no
         * hook afterwards, so hook activity alone would hold the item open
         * forever; agent_status leaving "blocked" means the dialog is gone,
         * so clear it and fall through to the ordinary liveness/pointer
         * logic below. "unknown" (Herdr briefly losing the pane) and null
         * (Herdr unreachable) keep holding, as does a still-open Pi prompt
         * (released by hook activity only, since Pi has no equivalent status
         * signal). "working" clears it at once (a dialog and a running tool
         * never overlap); "idle"/"done" only clear it once the previous
         * pass's recorded status was also idle/done, so a single status read
         * mid-flicker right after the Esc can't release a dialog that is
         * still actually up.
         */
        if (run.harness === "claude") {
          const dialogGone = herdrStatus === "working" || (isSettledHerdrStatus(herdrStatus) && isSettledHerdrStatus(previousHerdrStatus));
          if (dialogGone) {
            clearPrompt(db, run, herdrStatus, "reconciler", t);
          } else return;
        } else return;
      }
      const leaseLapsedWithoutStop = !busy && run.idle_since === null;
      /**
       * The backstop (spike c12, Task 11): Herdr's agent_status reads
       * "blocked" throughout a Claude permission dialog and "working"
       * throughout a long tool call; they never overlap, so "blocked" alone
       * disambiguates a dialog with no screen-marker fallback needed. Pi has
       * no equivalent spike, so it keeps the more conservative "not working"
       * rule (requiring a real, non-null status so Herdr being unreachable
       * never opens a stall item), worded as a possible stall rather than a
       * confirmation.
       */
      const suspectedPrompt = run.harness === "claude" ? herdrStatus === "blocked" : herdrStatus !== null && herdrStatus !== "working" && herdrStatus !== "unknown";
      if ((busy || leaseLapsedWithoutStop) && run.state === "running" && t - lastHook >= tm.prompt_suspect_ms && !idleByDesign(db, run) && suspectedPrompt) {
        openBlockedPrompt(db, run, { suspected: true, screen: null, harness: run.harness as "claude" | "pi", lastHook, herdrStatus }, t);
        return;
      }
      setLiveness(db, run, busy ? "busy" : "idle", "reconciler", { lease: busy ? "held" : "expired or released" }, t);
      const waiting = !busy && waitingOnOthers(db, run);
      if (busy || waiting) resolveRunItems(db, run.id, ["worker_idle"], busy ? "busy again" : "waiting on you", t);
      const idleFrom = !busy && !waiting && run.state === "running" && run.idle_since !== null ? idleEpisodeStart(db, run) : null;
      if (idleFrom !== null && t - idleFrom >= tm.idle_alert_ms && idleAlertDue(db, run.id, idleFrom, t, tm.idle_realert_ms)) {
        const ignored = reminderIgnored(db, run);
        const jobs = runningBackgroundJobs(db, run, t, "reconciler");
        const payload = { idle_ms: t - idleFrom, ignored_reminder: ignored, ...(jobs.length > 0 ? { background_jobs: jobs.map((j) => j.job ?? j.toolUseId) } : {}) };
        const event = appendEvent(db, { source: "reconciler", kind: "run.idle_alert", runId: run.id, taskId: run.task_id, payload });
        const idleFor = `has been idle ${Math.round((t - idleFrom) / 60_000)}m`;
        const why = jobs.length > 0 ? `${idleFor} waiting on ${describeJobs(jobs, t)}` : ignored ? `got the turn-end reminder, ended its turn again, and ${idleFor} without an outcome` : `${idleFor} without an outcome`;
        openRunItemOnce(db, "worker_idle", run, event.seq, `Worker for ${taskTitle(db, run.task_id)} ${why}`, t);
      }
      const stale = staleHooksDue(db, run, herdrStatus, t, tm);
      if (stale.due) {
        const event = appendEvent(db, { source: "reconciler", kind: "run.stale_hooks", runId: run.id, taskId: run.task_id, payload: { since: lastHook, quiet_from: stale.quietFrom } });
        openRunItemOnce(db, "worker_idle", run, event.seq, `Worker for ${taskTitle(db, run.task_id)} looks busy but sent no hook event for ${Math.round((t - stale.quietFrom) / 60_000)}m; possibly stuck`, t);
      }
    });
    await this.idleCarry(run, runtime, herdrStatus, t);
  }

  /**
   * A due steer for an idle Claude worker with no waiter: once that held for
   * waiter_grace_ms over at least two passes, type its pointer into the pane
   * (src/lifecycle/idle-carry.ts). A live waiter reconnecting to a restarted
   * daemon registers well within the grace and takes it instead.
   */
  private async idleCarry(run: RunRow, runtime: HerdrRuntime, herdrStatus: string | null, t: number): Promise<void> {
    const tm = this.deps.timing();
    if (idleCarryBlocker(this.deps.db, this.deps.bus, run, herdrStatus, t, tm) !== null) {
      this.waiterless.delete(run.id);
      return;
    }
    const seen = this.waiterless.get(run.id);
    if (!seen) {
      this.waiterless.set(run.id, { since: t, passes: 1 });
      // Look again once the grace is over, not only at the next steady pass.
      setTimeout(() => this.schedule(run.id), tm.waiter_grace_ms + 50).unref?.();
      return;
    }
    seen.passes += 1;
    if (seen.passes < 2 || t - seen.since < tm.waiter_grace_ms) return;
    this.waiterless.delete(run.id);
    try {
      const steer = await carryIdleSteer(this.deps, run.id, runtime);
      if (steer) this.deps.log(`reconciler: no waiter for idle run ${run.id}; typed steer ${steer}'s pointer into pane ${run.pane_id}`);
    } catch (error) {
      const detail = (error as Error).message;
      this.deps.log(`reconciler: idle carry to ${run.id} failed: ${detail}`);
      tx(this.deps.db, () => appendEvent(this.deps.db, { source: "reconciler", kind: "steer.idle_carry_failed", runId: run.id, taskId: run.task_id, payload: { detail }, ts: this.deps.now() }));
    }
  }

  /**
   * A pane with no live harness process is dead (a husk). Resume once from the
   * stored session; a second death needs you. The one resume is claimed at
   * once, but it launches only on a harness version with a passing contract
   * (design section 5): otherwise the scheduler holds it until one passes.
   */
  private async handleDeath(run: RunRow, panes: PaneProcesses | null): Promise<"dead" | "resumed"> {
    const { db, now } = this.deps;
    const husk = panes !== null && panes.foregroundGroup === panes.shellPid;
    const resumeDue = !WORK_DONE.includes(run.state) && run.resume_count === 0 && run.agent_session !== null;
    const gate = resumeDue ? await this.harnessCheck(run.harness) : null;
    if (gate && gate.state !== "verified") return this.deferResume(run, gate, husk);
    const t = now();
    if (WORK_DONE.includes(run.state)) {
      const released = tx(db, () => {
        setLiveness(db, run, "dead", "reconciler", { reason: "the worker exited after delivering", husk }, t);
        resolveRunItems(db, run.id, ["blocked_prompt"], "run.died", t);
        // Its pane holds no live worker any more; a declined delivery resumes it through the scheduler.
        return releaseLeases(db, run.id, run.task_id, { keepWorker: false }, "the worker exited", t);
      });
      if (released.length > 0) this.deps.released?.();
      return "dead";
    }
    if (run.resume_count === 0 && run.agent_session) {
      const claimed = tx(db, () => {
        const updated = db.query("UPDATE runs SET resume_count = resume_count + 1, updated_at = ?2 WHERE id = ?1 AND resume_count = ?3").run(run.id, t, run.resume_count);
        if (updated.changes === 0) return false;
        setLiveness(db, run, "starting", "reconciler", { reason: "resuming once after the worker died", husk }, t);
        const event = appendEvent(db, { source: "reconciler", kind: "run.auto_resumed", runId: run.id, taskId: run.task_id, payload: { session: run.agent_session, husk, pane: run.pane_id } });
        resolveRunItems(db, run.id, ["worker_idle", "trust_dialog", "blocked_prompt"], "run.auto_resumed", t);
        openItem(db, { kind: "auto_resumed", eventSeq: event.seq, taskId: run.task_id, runId: run.id, line: `Worker for ${taskTitle(db, run.task_id)} died and was resumed once from its session`, now: t });
        explain(db, {
          run,
          kind: "resume",
          rule: "resume.auto",
          reason: "the worker died; resumed once from its stored session",
          facts: deathFacts(run, husk, t),
          unblock: [],
          source: "reconciler",
          now: t,
          settled: "resumed",
        });
        return true;
      });
      if (!claimed) return "dead";
      this.attached.delete(run.id);
      this.deps.launch(run.id, "resume");
      return "resumed";
    }
    const freed = tx(db, () => {
      const changed = setLiveness(db, run, "dead", "reconciler", { reason: run.resume_count > 0 ? "died again after its automatic resume" : "no session to resume", husk }, t);
      resolveRunItems(db, run.id, ["blocked_prompt"], "run.died", t);
      // Nothing holds a slot for a dead worker (design section 11); `flowryn resume` asks for them again.
      const released = releaseLeases(db, run.id, run.task_id, { keepWorker: false }, "the worker died", t);
      if (released.length > 0 && run.stage_state === "active") db.query("UPDATE runs SET stage_state = 'waiting', waiting_since = NULL, stage_note = NULL WHERE id = ?1").run(run.id);
      if (changed) {
        const event = appendEvent(db, { source: "reconciler", kind: "run.died", runId: run.id, taskId: run.task_id, payload: { resume_count: run.resume_count, husk } });
        const item = openRunItemOnce(
          db,
          "failure_needs_you",
          run,
          event.seq,
          `Worker for ${taskTitle(db, run.task_id)} died${run.resume_count > 0 ? " again after its automatic resume" : ""}; flowryn resume ${run.task_id} or flowryn cancel ${run.task_id}`,
          t,
        );
        explain(db, {
          run,
          kind: "resume",
          rule: "resume.refused",
          reason: run.resume_count > 0 ? "the worker died again after its one automatic resume; no second one" : "the worker died with no session to resume",
          facts: deathFacts(run, husk, t),
          unblock: [
            { by: "leader", action: `flowryn resume ${run.task_id}` },
            { by: "leader", action: `flowryn cancel ${run.task_id}` },
          ],
          itemId: item ?? findOpenRunItem(db, "failure_needs_you", run.id)?.id ?? null,
          source: "reconciler",
          now: t,
        });
      }
      return released.length > 0;
    });
    if (freed) this.deps.released?.();
    return "dead";
  }

  /**
   * The dead run's one automatic resume, claimed now and handed to the
   * scheduler (pending_launch resume), which launches it once the harness
   * version passes its contract suite. A dead worker holds no slot meanwhile.
   */
  private deferResume(run: RunRow, gate: Exclude<HarnessCheck, { state: "verified" }>, husk: boolean): "dead" {
    const { db, now } = this.deps;
    const t = now();
    const why = gate.state === "missing" ? gate.detail : `${gate.harness} ${gate.version} has no passing contract run`;
    const deferred = tx(db, () => {
      const updated = db.query("UPDATE runs SET resume_count = resume_count + 1, pending_launch = 'resume', waiting_since = ?2, updated_at = ?2 WHERE id = ?1 AND resume_count = ?3").run(run.id, t, run.resume_count);
      if (updated.changes === 0) return false;
      setLiveness(db, run, "dead", "reconciler", { reason: `its resume waits: ${why}`, husk }, t);
      const released = releaseLeases(db, run.id, run.task_id, { keepWorker: false }, "the worker died", t);
      if (released.length > 0 && run.stage_state === "active") db.query("UPDATE runs SET stage_state = 'waiting', stage_note = NULL WHERE id = ?1").run(run.id);
      const event = appendEvent(db, { source: "reconciler", kind: "run.resume_deferred", runId: run.id, taskId: run.task_id, payload: { session: run.agent_session, husk, why } });
      resolveRunItems(db, run.id, ["worker_idle", "trust_dialog", "blocked_prompt"], "run.resume_deferred", t);
      const waits = gate.state === "missing" ? `waits: ${gate.detail}` : `waits until ${gate.harness} ${gate.version} passes its contract suite (${contractsCommand(gate.harness)})`;
      openItem(db, { kind: "auto_resumed", eventSeq: event.seq, taskId: run.task_id, runId: run.id, line: `Worker for ${taskTitle(db, run.task_id)} died; its one resume ${waits}`, now: t });
      explain(db, {
        run,
        kind: "resume",
        rule: "resume.deferred",
        reason: `the worker died; its one automatic resume waits: ${why}`,
        facts: [...harnessFacts(gate, t), ...deathFacts(run, husk, t)],
        unblock: harnessUnblock(gate, "launches the resume"),
        source: "reconciler",
        now: t,
      });
      return true;
    });
    if (deferred) {
      this.attached.delete(run.id);
      this.deps.log(`reconcile ${run.id}: the worker died; its resume waits: ${why}`);
      this.deps.released?.();
    }
    return "dead";
  }

  /** The invariant pass (design section 8), on a backlog snapshot known to match the file. */
  private async checkBacklog(): Promise<void> {
    const { db, now, log } = this.deps;
    if (!this.deps.backlogFresh) return;
    try {
      if (!(await this.deps.backlogFresh())) return;
    } catch (error) {
      log(`reconcile: the backlog could not be read for the invariant pass: ${(error as Error).message}`);
      return;
    }
    const result = tx(db, () => checkInvariant(db, now()));
    if (result && result.opened.length + result.resolved.length > 0) {
      log(`reconcile: invariant: ${result.opened.length} divergence(s) opened (${result.opened.join(",") || "-"}), ${result.resolved.length} settled (${result.resolved.join(",") || "-"})`);
    }
  }

  /** Docker label evidence (design section 11): environments beyond a run's lease, and containers left without one. */
  private async scanDocker(): Promise<void> {
    const docker = this.deps.docker?.();
    if (!docker) return;
    const containers = await listLabelled(docker);
    if (containers === null || containers.length === 0) return;
    const findings = applyDocker(this.deps.db, containers, this.deps.now());
    if (findings.over.length + findings.leftover.length > 0) this.deps.log(`reconcile: docker: over the lease ${findings.over.join(",") || "-"}; left without one ${findings.leftover.join(",") || "-"}`);
  }

  /**
   * Pane metadata only finds candidates (design section 6): a pane labelled for
   * a run that lives elsewhere, or has no pane of record, is a divergence and
   * is left alone. A run is never adopted by label.
   */
  private async scanOrphans(): Promise<void> {
    const runtime = this.deps.runtime();
    if (!runtime) return;
    let panes;
    try {
      panes = await runtime.snapshotPanes();
    } catch {
      return;
    }
    const { db, now } = this.deps;
    for (const pane of panes) {
      const runId = pane.tokens[RUN_TOKEN];
      if (!runId) continue;
      const run = getRun(db, runId);
      if (!run || isTerminal(run.state) || run.pane_id === pane.paneId) continue;
      tx(db, () =>
        openDivergence(
          db,
          "reconciler",
          { runId: run.id, taskId: run.task_id, higher: "run", lower: "herdr", summary: `pane ${pane.paneId} is labelled for run ${run.id}, whose pane of record is ${run.pane_id ?? "none"}; left alone` },
          now(),
        ),
      );
    }
  }
}

// --- wait explanations (docs/notes/2026-10-12-next-steps-md-wz.md) ---------------------------

/** No worker-start hook after the launch: a dialog (trust, login) may hold the pane. */
function explainTrust(db: Db, run: RunRow, launchedAt: number, wedgeMs: number, t: number): void {
  const pane = run.pane_id ?? "(none)";
  explain(db, {
    run,
    kind: "dialog",
    rule: "dialog.trust",
    reason: `the worker has not started ${Math.round(wedgeMs / 1000)}s after its launch; a dialog may hold pane ${pane}`,
    facts: [
      { name: "launched", value: new Date(launchedAt).toISOString(), at: launchedAt },
      { name: "worker-start hook", value: "none since the launch", at: t },
    ],
    unblock: [
      { by: "captain", action: `accept or answer the dialog in pane ${pane}` },
      { by: "flowryn", action: "clears it when the worker-start hook arrives" },
    ],
    itemId: findOpenRunItem(db, "trust_dialog", run.id)?.id ?? null,
    source: "reconciler",
    now: t,
  });
}

/** What the reconciler saw of a dead worker. */
function deathFacts(run: RunRow, husk: boolean, t: number): Fact[] {
  return [
    { name: "process", value: `pid ${run.proc_pid ?? "?"} gone${husk ? "; the pane holds only its shell" : ""}`, at: t },
    { name: "session", value: run.agent_session ?? "none", at: null },
    { name: "automatic resumes so far", value: String(run.resume_count), at: null },
  ];
}
