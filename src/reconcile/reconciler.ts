import { realpathSync } from "node:fs";
import type { Timing } from "../config/workers.ts";
import type { Db } from "../db/db.ts";
import { tx } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { openItem, resolveRunItems } from "../attention/items.ts";
import { identityOf } from "../lifecycle/control.ts";
import { getRun, isTerminal, openRunItemOnce, openRuns, recordEvidence, setLiveness, taskTitle, type Liveness, type RunRow } from "../lifecycle/runs.ts";
import { flagUnackedSteers, unackedSteers, type SteerBus } from "../lifecycle/steers.ts";
import { HerdrError } from "../runtime/herdr/client.ts";
import { RUN_TOKEN, type HerdrRuntime, type PaneProcesses } from "../runtime/herdr/runtime.ts";
import { isAlive, type PsRunner } from "../runtime/proc.ts";
import { openDivergence } from "./divergence.ts";
import { applyDocker, listLabelled } from "./docker.ts";
import { checkInvariant } from "./invariant.ts";
import { releaseLeases } from "../sched/pools.ts";
import type { HarnessId } from "../harness/types.ts";
import { contractsCommand, type HarnessCheck } from "../lifecycle/harness-gate.ts";

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
 * happen in the hooks, which see a steer due again); re-arm monitoring after a
 * restart. Everything else is a pointer for the leader.
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
    tx(db, () => recordEvidence(db, run.id, "process", 2, { pid: identity?.pid ?? null, alive, in_pane: inPane, pane: run.pane_id, pane_exists: panes !== null }, t));

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
      if (herdrStatus !== null) recordEvidence(db, run.id, "herdr", 5, { agent_status: herdrStatus }, t);
      if (!started) {
        if (t - launchedAt >= tm.trust_wedge_ms) {
          setLiveness(db, run, "blocked_dialog", "reconciler", { since: launchedAt }, t);
          const event = appendEvent(db, { source: "reconciler", kind: "run.blocked_dialog", runId: run.id, taskId: run.task_id, payload: { waited_ms: t - launchedAt } });
          openRunItemOnce(db, "trust_dialog", run, event.seq, `Worker for ${taskTitle(db, run.task_id)} has not started ${Math.round((t - launchedAt) / 1000)}s after launch; a dialog may be blocking pane ${run.pane_id}`, t);
        } else setLiveness(db, run, "starting", "reconciler", {}, t);
        return;
      }
      const busy = run.busy_until !== null && run.busy_until > t;
      setLiveness(db, run, busy ? "busy" : "idle", "reconciler", { lease: busy ? "held" : "expired or released" }, t);
      if (busy) resolveRunItems(db, run.id, ["worker_idle"], "busy again", t);
      if (!busy && run.state === "running" && run.idle_since !== null && t - run.idle_since >= tm.idle_alert_ms) {
        const event = appendEvent(db, { source: "reconciler", kind: "run.idle_alert", runId: run.id, taskId: run.task_id, payload: { idle_ms: t - run.idle_since } });
        openRunItemOnce(db, "worker_idle", run, event.seq, `Worker for ${taskTitle(db, run.task_id)} has been idle ${Math.round((t - run.idle_since) / 60_000)}m without an outcome`, t);
      }
      const lastHook = run.last_hook_at ?? launchedAt;
      if (herdrStatus === "working" && t - lastHook >= tm.stale_hook_ms) {
        const event = appendEvent(db, { source: "reconciler", kind: "run.stale_hooks", runId: run.id, taskId: run.task_id, payload: { since: lastHook } });
        openRunItemOnce(db, "worker_idle", run, event.seq, `Worker for ${taskTitle(db, run.task_id)} looks busy but sent no hook event for ${Math.round((t - lastHook) / 60_000)}m; possibly stuck`, t);
      }
    });
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
        resolveRunItems(db, run.id, ["worker_idle", "trust_dialog"], "run.auto_resumed", t);
        openItem(db, { kind: "auto_resumed", eventSeq: event.seq, taskId: run.task_id, runId: run.id, line: `Worker for ${taskTitle(db, run.task_id)} died and was resumed once from its session`, now: t });
        return true;
      });
      if (!claimed) return "dead";
      this.attached.delete(run.id);
      this.deps.launch(run.id, "resume");
      return "resumed";
    }
    const freed = tx(db, () => {
      const changed = setLiveness(db, run, "dead", "reconciler", { reason: run.resume_count > 0 ? "died again after its automatic resume" : "no session to resume", husk }, t);
      // Nothing holds a slot for a dead worker (design section 11); `flowryn resume` asks for them again.
      const released = releaseLeases(db, run.id, run.task_id, { keepWorker: false }, "the worker died", t);
      if (released.length > 0 && run.stage_state === "active") db.query("UPDATE runs SET stage_state = 'waiting', waiting_since = NULL, stage_note = NULL WHERE id = ?1").run(run.id);
      if (changed) {
        const event = appendEvent(db, { source: "reconciler", kind: "run.died", runId: run.id, taskId: run.task_id, payload: { resume_count: run.resume_count, husk } });
        openRunItemOnce(
          db,
          "failure_needs_you",
          run,
          event.seq,
          `Worker for ${taskTitle(db, run.task_id)} died${run.resume_count > 0 ? " again after its automatic resume" : ""}; flowryn resume ${run.task_id} or flowryn cancel ${run.task_id}`,
          t,
        );
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
      resolveRunItems(db, run.id, ["worker_idle", "trust_dialog"], "run.resume_deferred", t);
      const waits = gate.state === "missing" ? `waits: ${gate.detail}` : `waits until ${gate.harness} ${gate.version} passes its contract suite (${contractsCommand(gate.harness)})`;
      openItem(db, { kind: "auto_resumed", eventSeq: event.seq, taskId: run.task_id, runId: run.id, line: `Worker for ${taskTitle(db, run.task_id)} died; its one resume ${waits}`, now: t });
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
