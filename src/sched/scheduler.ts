import { randomUUID } from "node:crypto";
import { FlowrynError } from "../api/errors.ts";
import { findOpenItem, openItem, resolveItems } from "../attention/items.ts";
import type { FlowrynConfig } from "../config/config.ts";
import { capacityConfig, schedTiming, workflowFor, type HostCheckConfig } from "../config/workflows.ts";
import { tx, type Db } from "../db/db.ts";
import { getMeta, setMeta } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import type { HarnessId } from "../harness/types.ts";
import { readSnapshot } from "../journal/snapshot.ts";
import { checkStart, createRun, type StartDeps } from "../lifecycle/dispatch.ts";
import type { LaunchMode } from "../lifecycle/launcher.ts";
import { waitingOn, type PhaseRow } from "../lifecycle/plans.ts";
import { getProject } from "../lifecycle/projects.ts";
import { getRunWithPolicy, isTerminal, taskTitle, type RunWithPolicy } from "../lifecycle/runs.ts";
import { activateStage, neededPools, positionOf, type StagePos } from "../lifecycle/stages.ts";
import { checkHost, type HostVerdict } from "./host.ts";
import { fullPools, OverCapacity } from "./pools.ts";
import { usageLimitSince } from "./usage.ts";

/**
 * The scheduler (design sections 4 and 11): it grants stage starts against the
 * capacity pools and the host check, and starts the phases of approved plans
 * whose blockers have landed. It never holds a worker in a blocking call: a
 * run waiting for a grant is a row, and its worker hears of the grant as a
 * steer (or, not yet launched, is launched by it).
 *
 * Grant order is "drain before fill": stages closer to shipping first (fewest
 * stages left), then project priority, then age. A run that cannot be granted
 * is skipped, so a run that needs a free pool is never held up by one that
 * waits for a full pool. The host check runs before any grant that takes a
 * new slot; while it fails, nothing new is granted and running work carries on.
 */

export interface SchedulerDeps {
  db: Db;
  config(): FlowrynConfig;
  now(): number;
  log(message: string): void;
  /** Start or resume a worker in the background (the launcher). */
  launch(runId: string, mode: LaunchMode): void;
  isLaunching(runId: string): boolean;
  /** Stop the run's worker process by its recorded identity (a stage that starts a fresh worker). */
  exitWorker(runId: string): Promise<void>;
  /** A steer is waiting for this run's worker. */
  notify(runId: string): void;
  startDeps: StartDeps;
  kickJournal(): void;
  host?(cfg: HostCheckConfig): Promise<HostVerdict>;
}

interface Candidate {
  run: RunWithPolicy;
  pos: StagePos;
  needs: string[];
  remaining: number;
  priority: number;
  since: number;
}

export interface HostState {
  ok: boolean;
  reason: string;
  since: number;
  free_mem_gb: number | null;
  load_per_core: number | null;
}

const HOST_KEY = "sched_host";

export function hostState(db: Db): HostState | null {
  const raw = getMeta(db, HOST_KEY);
  return raw ? (JSON.parse(raw) as HostState) : null;
}

export class Scheduler {
  private readonly deps: SchedulerDeps;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private steady: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private hostCache: { at: number; verdict: HostVerdict } | null = null;
  private readonly relaunching = new Set<string>();

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  start(): void {
    this.steady = setInterval(() => this.kick(), schedTiming(this.deps.config()).pass_ms);
    this.kick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.steady) clearInterval(this.steady);
    this.timer = null;
    this.steady = null;
  }

  /** Look again soon; calls within the debounce window coalesce. */
  kick(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.passNow();
    }, 25);
  }

  /** A pass now, serialized with every other pass; a request during a pass runs one more after it. */
  async passNow(): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      await this.running;
      if (!this.again) return;
    }
    this.again = false;
    this.running = this.pass().finally(() => {
      this.running = null;
    });
    await this.running;
    if (this.again) await this.passNow();
  }

  private async pass(): Promise<void> {
    try {
      const started = await this.autoDispatch();
      if (started > 0) this.deps.kickJournal();
      await this.grant();
      this.alerts();
    } catch (error) {
      this.deps.log(`sched: pass failed: ${(error as Error).stack ?? String(error)}`);
    }
  }

  private async hostVerdict(cfg: HostCheckConfig): Promise<HostVerdict> {
    const now = this.deps.now();
    const ttl = schedTiming(this.deps.config()).host_cache_ms;
    if (this.hostCache && now - this.hostCache.at < ttl) return this.hostCache.verdict;
    const verdict = await (this.deps.host ?? checkHost)(cfg);
    this.hostCache = { at: now, verdict };
    this.recordHost(verdict, now);
    return verdict;
  }

  /** Record the host check when it flips, with an event (it decides whether anything new starts). */
  private recordHost(verdict: HostVerdict, now: number): void {
    const { db } = this.deps;
    const previous = hostState(db);
    if (previous && previous.ok === verdict.ok) return;
    const state: HostState = { ok: verdict.ok, reason: verdict.reason, since: now, free_mem_gb: verdict.sample?.free_mem_gb ?? null, load_per_core: verdict.sample?.load_per_core ?? null };
    tx(db, () => {
      setMeta(db, HOST_KEY, JSON.stringify(state));
      appendEvent(db, { source: "daemon", kind: verdict.ok ? "sched.host_ok" : "sched.host_blocked", payload: state, ts: now });
    });
    this.deps.log(`sched: host check ${verdict.ok ? "passes" : `fails: ${verdict.reason}`}`);
  }

  private candidates(): Candidate[] {
    const { db, now } = this.deps;
    const rows = db
      .query(
        `SELECT r.*, tp.project_id, tp.kind, tp.delivery_mode, tp.sensitive, COALESCE(p.priority, 2) AS priority
         FROM runs r JOIN task_policy tp ON tp.task_id = r.task_id LEFT JOIN projects p ON p.id = tp.project_id
         WHERE r.state NOT IN ('cleaned','failed','cancelled') AND (r.stage_state = 'waiting' OR r.pending_launch IS NOT NULL)
           AND (r.pending_launch IS NOT NULL OR r.liveness != 'dead')`,
      )
      .all() as (RunWithPolicy & { priority: number })[];
    const t = now();
    return rows
      .filter((run) => !this.relaunching.has(run.id) && !this.deps.isLaunching(run.id))
      .map((run) => {
        const pos = positionOf(db, run, run.kind);
        return { run, pos, needs: neededPools(db, run, pos), remaining: pos.def.stages.length - 1 - pos.index, priority: run.priority, since: run.waiting_since ?? t };
      })
      .toSorted((a, b) => a.remaining - b.remaining || a.priority - b.priority || a.since - b.since || a.run.started_at - b.run.started_at);
  }

  private async grant(): Promise<void> {
    const { db, config: configOf, now } = this.deps;
    const config = configOf();
    const capacity = capacityConfig(config);
    const paused = usageLimitSince(db) !== null;
    let verdict: HostVerdict | null = null;
    for (const c of this.candidates()) {
      if (this.stopped) return;
      if (paused && c.run.harness === "claude") continue;
      if (c.needs.length > 0) {
        verdict ??= await this.hostVerdict(capacity.host);
        if (!verdict.ok) continue;
        if (fullPools(db, capacity.pools, c.needs).length > 0) continue;
      }
      let activated;
      try {
        activated = tx(db, () => {
          const fresh = getRunWithPolicy(db, c.run.id);
          if (!fresh || isTerminal(fresh.state) || (fresh.stage_state !== "waiting" && !fresh.pending_launch)) return null;
          return activateStage(db, config, fresh, now());
        });
      } catch (error) {
        if (error instanceof OverCapacity) continue;
        throw error;
      }
      if (!activated) continue;
      if (activated.steer) this.deps.notify(c.run.id);
      if (activated.launch === "stage") await this.freshWorker(c.run.id);
      else if (activated.launch) this.deps.launch(c.run.id, activated.launch);
    }
  }

  /** A stage with fresh = true: the old worker exits, and a new session starts in the same worktree. */
  private async freshWorker(runId: string): Promise<void> {
    const { db, now } = this.deps;
    this.relaunching.add(runId);
    try {
      await this.deps.exitWorker(runId);
      tx(db, () => {
        db.query(
          `UPDATE runs SET agent_session = ?2, proc_pid = NULL, proc_start = NULL, proc_exe = NULL, worker_started_at = NULL,
             busy_until = NULL, idle_since = NULL, transcript_path = NULL, liveness = 'starting', updated_at = ?3 WHERE id = ?1`,
        ).run(runId, randomUUID(), now());
        const run = getRunWithPolicy(db, runId);
        appendEvent(db, { source: "daemon", kind: "run.fresh_worker", runId, taskId: run?.task_id ?? null, payload: { stage: run?.stage ?? null }, ts: now() });
      });
      this.deps.launch(runId, "stage");
    } finally {
      this.relaunching.delete(runId);
    }
  }

  /**
   * Autonomy (design section 11): every Queued phase of an approved plan whose
   * blockers have all landed starts, in code and with no leader turn, when its
   * project's autonomy is plan. A phase you hold or park in the backlog waits.
   */
  private async autoDispatch(): Promise<number> {
    const { db, now } = this.deps;
    const config = this.deps.config();
    const paused = usageLimitSince(db) !== null;
    const phases = db
      .query(
        `SELECT ph.*, pl.title AS plan_title, pl.project_id, pl.source_task, (SELECT COUNT(*) FROM plan_phases x WHERE x.plan_id = ph.plan_id) AS phases
         FROM plan_phases ph JOIN plans pl ON pl.id = ph.plan_id JOIN task_policy tp ON tp.task_id = ph.task_id
         WHERE pl.state = 'approved' AND tp.auto = 1 AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id = ph.task_id)
         ORDER BY pl.created_at, ph.phase_no`,
      )
      .all() as (PhaseRow & { plan_title: string; project_id: string; source_task: string | null; phases: number })[];
    if (phases.length === 0) return 0;
    const backlog = readSnapshot(db, "backlog")?.tasks ?? null;
    let started = 0;
    for (const phase of phases) {
      const project = getProject(db, phase.project_id);
      if (!project || project.autonomy !== "plan") continue;
      const task = backlog?.find((t) => t.id === phase.task_id);
      // Not in the backlog yet (its add is still pending), held, parked or already started by hand: wait.
      if (!task || task.state !== "queued" || task.hold) continue;
      if (waitingOn(db, phase.task_id, backlog, JSON.parse(phase.blocked_by) as string[]).length > 0) continue;
      const harness = (phase.harness as HarnessId | null) ?? project.harness;
      if (paused && harness === "claude") continue;
      let start: { version: string; base: string };
      let workflow;
      try {
        workflow = workflowFor(config, phase.workflow, "ship");
        start = await checkStart(this.deps.startDeps, project, harness);
      } catch (error) {
        if (!(error instanceof FlowrynError)) throw error;
        this.phaseBlocked(phase, error.message);
        continue;
      }
      const t = now();
      const made = tx(db, () => {
        if (db.query("SELECT 1 FROM runs WHERE task_id = ?1").get(phase.task_id)) return null;
        const runId = createRun(db, config, { taskId: phase.task_id, title: phase.title, body: phase.body, project, kind: "ship", harness, version: start.version, base: start.base, workflow, sensitive: false, existing: true, by: "scheduler", now: t });
        resolveItems(db, "phase_blocked", phase.task_id, "phase.started", t);
        // A plan a design handed in holds the phases after the design's own task, which is phase 1.
        const offset = phase.source_task ? 1 : 0;
        const [n, of] = [phase.phase_no + offset, phase.phases + offset];
        const event = appendEvent(db, { source: "daemon", kind: "phase.started", runId, taskId: phase.task_id, payload: { plan: phase.plan_id, phase: n, of }, ts: t });
        const where = of > 1 ? `Phase ${n} of ${of} in "${phase.plan_title}"` : `Queued task "${phase.title}"`;
        openItem(db, { kind: "phase_started", eventSeq: event.seq, taskId: phase.task_id, runId, line: `${where} started by itself: ${phase.title} (${project.id}); its blockers landed`, now: t });
        return runId;
      });
      if (made) {
        started++;
        this.deps.log(`sched: phase ${phase.phase_no} of ${phase.plan_id} started as ${made}`);
      }
    }
    return started;
  }

  /** A phase is ready but cannot start (no contract, Herdr down, a tangled checkout): one P1, until it starts. */
  private phaseBlocked(phase: PhaseRow & { plan_title: string }, why: string): void {
    const { db, now } = this.deps;
    if (findOpenItem(db, "phase_blocked", phase.task_id)) return;
    tx(db, () => {
      const event = appendEvent(db, { source: "daemon", kind: "phase.blocked", taskId: phase.task_id, payload: { plan: phase.plan_id, phase: phase.phase_no, why }, ts: now() });
      openItem(db, { kind: "phase_blocked", eventSeq: event.seq, taskId: phase.task_id, line: `Phase ${phase.phase_no} of "${phase.plan_title}" is ready but cannot start: ${why}`, now: now() });
    });
  }

  /** Work that waits for a grant longer than wait_alert_ms: one P1 (design section 16), closed once nothing waits that long. */
  private alerts(): void {
    const { db, now } = this.deps;
    const t = now();
    const threshold = schedTiming(this.deps.config()).wait_alert_ms;
    const oldest = db
      .query(
        `SELECT task_id, waiting_since FROM runs WHERE state NOT IN ('cleaned','failed','cancelled')
           AND (stage_state = 'waiting' OR pending_launch IS NOT NULL) AND (pending_launch IS NOT NULL OR liveness != 'dead')
           AND waiting_since IS NOT NULL ORDER BY waiting_since LIMIT 1`,
      )
      .get() as { task_id: string; waiting_since: number } | null;
    const open = findOpenItem(db, "capacity_wait", null);
    if (oldest && t - oldest.waiting_since >= threshold) {
      if (open) return;
      const count = (db.query("SELECT COUNT(*) AS n FROM runs WHERE state NOT IN ('cleaned','failed','cancelled') AND (stage_state = 'waiting' OR pending_launch IS NOT NULL) AND (pending_launch IS NOT NULL OR liveness != 'dead') AND waiting_since <= ?1").get(t - threshold) as { n: number }).n;
      const host = hostState(db);
      const why = host && !host.ok ? `host check: ${host.reason}` : usageLimitSince(db) !== null ? "the Claude usage limit" : "full capacity pools";
      tx(db, () => {
        const event = appendEvent(db, { source: "daemon", kind: "sched.waiting", taskId: oldest.task_id, payload: { runs: count, oldest_ms: t - oldest.waiting_since, why }, ts: t });
        openItem(db, { kind: "capacity_wait", eventSeq: event.seq, line: `${count} run(s) waiting over ${Math.round(threshold / 60_000)}m for capacity (${why}); oldest ${taskTitle(db, oldest.task_id)}; flowryn capacity`, now: t });
      });
    } else if (open) {
      tx(db, () => {
        appendEvent(db, { source: "daemon", kind: "sched.waiting_cleared", payload: { item: open.id }, ts: t });
        resolveItems(db, "capacity_wait", null, "nothing waits that long", t);
      });
    }
  }
}
