import { randomUUID } from "node:crypto";
import { FlowrynError } from "../api/errors.ts";
import { findOpenItem, findOpenRunItem, openItem, resolveItems, resolveRunItems } from "../attention/items.ts";
import { existsSync } from "node:fs";
import { resolveTool, type FlowrynConfig } from "../config/config.ts";
import { capacityConfig, schedTiming, workflowFor, type HostCheckConfig, type WorkflowDef } from "../config/workflows.ts";
import { tx, type Db } from "../db/db.ts";
import { getMeta, setMeta } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { HARNESS_IDS, type HarnessId } from "../harness/types.ts";
import { readSnapshot } from "../journal/snapshot.ts";
import { checkStart, createRun, type StartDeps } from "../lifecycle/dispatch.ts";
import { gateHarness, unverifiedVersion } from "../lifecycle/harness-gate.ts";
import type { LaunchMode } from "../lifecycle/launcher.ts";
import { waitingOn, type PhaseRow } from "../lifecycle/plans.ts";
import { getProject, type ProjectRow } from "../lifecycle/projects.ts";
import { getRunWithPolicy, isTerminal, taskTitle, type RunWithPolicy } from "../lifecycle/runs.ts";
import { activateStage, neededPools, positionOf, type StagePos } from "../lifecycle/stages.ts";
import { checkHost, type HostVerdict } from "./host.ts";
import { fullPools, OverCapacity } from "./pools.ts";
import { probeQuota, quotaHolds, quotaLine, quotaState, recordQuota, type QuotaReading } from "./quota.ts";
import { claimProbe, usageGate, usageLimitSince } from "./usage.ts";

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
  /** Stop the run's worker process by its recorded identity (a fresh stage worker, a relaunch); whether it is gone. */
  exitWorker(runId: string): Promise<{ ok: boolean; detail?: string }>;
  /** A steer is waiting for this run's worker. */
  notify(runId: string): void;
  startDeps: StartDeps;
  kickJournal(): void;
  host?(cfg: HostCheckConfig): Promise<HostVerdict>;
  /** One quota-axi reading (tests); by default the configured quota-axi runs. */
  quota?(): Promise<QuotaReading>;
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

/** Consecutive refused exits of a fresh stage's old worker before one P1 asks you to look. */
export const EXIT_REFUSALS_FOR_ITEM = 3;
/** The longest a refused fresh-stage replacement waits before its next exit attempt. */
export const EXIT_BACKOFF_MAX_MS = 5 * 60_000;

export function hostState(db: Db): HostState | null {
  const raw = getMeta(db, HOST_KEY);
  return raw ? (JSON.parse(raw) as HostState) : null;
}

export class Scheduler {
  private readonly deps: SchedulerDeps;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private steady: ReturnType<typeof setInterval> | null = null;
  /** Passes and single-run grants run one at a time, in order. */
  private chain: Promise<unknown> = Promise.resolve();
  /** A pass requested but not started yet: callers meanwhile share it. */
  private queued: Promise<void> | null = null;
  private stopped = false;
  private hostCache: { at: number; verdict: HostVerdict } | null = null;
  private quotaCache: { at: number; reading: QuotaReading } | null = null;
  private readonly relaunching = new Set<string>();
  /**
   * Refused fresh-stage exits per run since its last verified exit, and when the
   * next attempt may run: one pass after the first refusal, doubling up to
   * EXIT_BACKOFF_MAX_MS. In memory: a restart starts the count again.
   */
  private readonly exitRefusals = new Map<string, { attempts: number; nextAt: number }>();

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

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** A pass now, serialized with every other pass and grant; a request during a pass runs one more after it. */
  async passNow(): Promise<void> {
    if (this.stopped) return;
    this.queued ??= this.exclusive(async () => {
      this.queued = null;
      await this.pass();
    });
    await this.queued;
  }

  /**
   * Grant this one run now, if its turn and the pools allow, and nothing else:
   * no auto-dispatch, no other run's launch. Its worker is waiting on the
   * reply, so the stage start carries no steer. Work nearer shipping or older
   * that needs one of the same pools keeps its turn: then this run waits for
   * a regular pass. Resolves whether the run's stage is now active.
   */
  async grantNow(runId: string): Promise<boolean> {
    if (this.stopped) return false;
    return this.exclusive(async () => {
      if (this.stopped) return false;
      const candidates = this.candidates();
      const at = candidates.findIndex((c) => c.run.id === runId);
      if (at < 0) return false;
      const mine = candidates[at]!;
      if (candidates.slice(0, at).some((c) => c.needs.some((pool) => mine.needs.includes(pool)))) return false;
      const config = this.deps.config();
      return this.tryGrant(mine, config, { verdict: null }, false);
    });
  }

  /** Auto-dispatch, grants and alerts, each on its own: one that throws never stops the others. */
  private async pass(): Promise<void> {
    await this.step("auto-dispatch", async () => {
      if ((await this.autoDispatch()) > 0) this.deps.kickJournal();
    });
    await this.step("grant", () => this.grant());
    await this.step("alerts", async () => this.alerts());
  }

  private async step(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.deps.log(`sched: ${name} failed: ${(error as Error).stack ?? String(error)}`);
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

  private async readQuota(): Promise<QuotaReading> {
    if (this.deps.quota) return this.deps.quota();
    const config = this.deps.config();
    const tool = resolveTool(config, "quota_axi");
    return probeQuota(tool && existsSync(tool) ? tool : null, resolveTool(config, "node"));
  }

  /**
   * Whether new Claude runs wait on the quota floor now: quota-axi is read at
   * most every quota_cache_ms, and only when a new Claude run could start.
   * A floor of 0 reads nothing and lifts a low state recorded under an older floor.
   */
  private async quotaHeld(): Promise<boolean> {
    const { db, now } = this.deps;
    const config = this.deps.config();
    const { floor } = capacityConfig(config).quota;
    const previous = quotaState(db);
    let reading: QuotaReading;
    if (floor <= 0) {
      if (!previous || previous.state !== "low") return false;
      reading = { state: "known", percent: previous.percent ?? 0, window: previous.window, resets_at: previous.resets_at };
    } else {
      const ttl = schedTiming(config).quota_cache_ms;
      if (!this.quotaCache || now() - this.quotaCache.at >= ttl) this.quotaCache = { at: now(), reading: await this.readQuota() };
      reading = this.quotaCache.reading;
    }
    const state = tx(db, () => recordQuota(db, reading, floor, now()));
    if (state.state !== previous?.state) this.deps.log(`sched: Claude quota ${quotaLine(state)}`);
    return quotaHolds(db);
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
    // A run that no longer waits for its replacement (cancelled, failed) drops its refusal count.
    for (const runId of this.exitRefusals.keys()) if (!rows.some((run) => run.id === runId)) this.exitRefusals.delete(runId);
    return rows
      .filter((run) => !this.relaunching.has(run.id) && !this.deps.isLaunching(run.id) && !this.backingOff(run.id, t))
      .map((run) => {
        const pos = positionOf(db, run, run.kind);
        return { run, pos, needs: neededPools(db, run, pos), remaining: pos.def.stages.length - 1 - pos.index, priority: run.priority, since: run.waiting_since ?? t };
      })
      .toSorted((a, b) => a.remaining - b.remaining || a.priority - b.priority || a.since - b.since || a.run.started_at - b.run.started_at);
  }

  private async grant(): Promise<void> {
    const config = this.deps.config();
    const host = { verdict: null as HostVerdict | null };
    if (quotaState(this.deps.db)?.state === "low") await this.quotaHeld();
    for (const c of this.candidates()) {
      if (this.stopped) return;
      await this.tryGrant(c, config, host, true);
    }
  }

  /** One grant: the usage pause (or its one probe), the host check (once per pass) and the pools, then the stage start. Whether it started. */
  private async tryGrant(c: Candidate, config: FlowrynConfig, host: { verdict: HostVerdict | null }, steer: boolean): Promise<boolean> {
    const { db, now } = this.deps;
    const capacity = capacityConfig(config);
    const usage = c.run.harness === "claude" ? usageGate(db, now(), c.run.id) : "open";
    if (usage === "paused") return false;
    // Under the quota floor a new Claude run waits; a live run's next stage, a resume or a relaunch drains.
    if (c.run.harness === "claude" && c.run.pending_launch === "fresh" && (await this.quotaHeld())) return false;
    // A grant that launches a worker checks the installed harness version first (design section 5).
    if (c.run.pending_launch && !(await this.harnessVerified(c.run.harness, config))) return false;
    if (c.needs.length > 0) {
      host.verdict ??= await this.hostVerdict(capacity.host);
      if (!host.verdict.ok) return false;
      if (fullPools(db, capacity.pools, c.needs).length > 0) return false;
    }
    let activated;
    try {
      activated = tx(db, () => {
        const fresh = getRunWithPolicy(db, c.run.id);
        if (!fresh || isTerminal(fresh.state) || (fresh.stage_state !== "waiting" && !fresh.pending_launch)) return null;
        const started = activateStage(db, config, fresh, now(), { steer });
        if (started && usage === "probe") claimProbe(db, c.run.id, now());
        return started;
      });
    } catch (error) {
      if (error instanceof OverCapacity) return false;
      throw error;
    }
    if (!activated) return false;
    if (activated.steer) this.deps.notify(c.run.id);
    if (activated.launch === "stage") await this.freshWorker(c.run.id);
    else if (activated.launch === "relaunch") await this.relaunchWorker(c.run.id);
    else if (activated.launch) this.deps.launch(c.run.id, activated.launch);
    return true;
  }

  /**
   * A relaunch (a scout promoted in place): the live worker exits by its
   * identity, and its own session resumes in the same worktree, so its context
   * survives while its contract, task file and sandbox settings change.
   */
  private async relaunchWorker(runId: string): Promise<void> {
    const { db, now } = this.deps;
    this.relaunching.add(runId);
    try {
      const exited = await this.deps.exitWorker(runId);
      // Never a second process in the same session: a worker that did not stop is tried again on the next pass.
      if (!exited.ok) {
        this.deps.log(`sched: relaunch of ${runId} waits: the worker did not exit (${exited.detail ?? "unverified"})`);
        return;
      }
      tx(db, () => {
        db.query("UPDATE runs SET proc_pid = NULL, proc_start = NULL, proc_exe = NULL, busy_until = NULL, idle_since = NULL, liveness = 'starting', updated_at = ?2 WHERE id = ?1").run(runId, now());
        const run = getRunWithPolicy(db, runId);
        appendEvent(db, { source: "daemon", kind: "run.relaunch", runId, taskId: run?.task_id ?? null, payload: { stage: run?.stage ?? null, session: run?.agent_session ?? null }, ts: now() });
      });
      this.deps.launch(runId, "relaunch");
    } finally {
      this.relaunching.delete(runId);
    }
  }

  /** The harness gate before a launch: an untested version waits, with its P1; a check that fails counts as unverified. */
  private async harnessVerified(harness: HarnessId, config: FlowrynConfig): Promise<boolean> {
    try {
      const check = await gateHarness(this.deps.db, config, harness, this.deps.startDeps.harnessVersion, "daemon", "launch", this.deps.now);
      return check.state === "verified";
    } catch (error) {
      this.deps.log(`sched: checking ${harness} failed: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * A stage with fresh = true: the old worker exits, and a new session starts in
   * the same worktree. Only a verified exit clears the old identity: a worker
   * that did not stop keeps it, its slots and its pending replacement, and the
   * next pass tries again (docs/notes/2026-10-12-next-steps-md-we.md).
   */
  private async freshWorker(runId: string): Promise<void> {
    const { db, now } = this.deps;
    this.relaunching.add(runId);
    try {
      const exited = await this.verifiedExit(runId);
      if (!exited.ok) {
        this.freshWorkerRefused(runId, exited.detail ?? "unverified");
        return;
      }
      this.exitRefusals.delete(runId);
      tx(db, () => {
        db.query(
          `UPDATE runs SET agent_session = ?2, proc_pid = NULL, proc_start = NULL, proc_exe = NULL, worker_started_at = NULL,
             busy_until = NULL, idle_since = NULL, transcript_path = NULL, liveness = 'starting', updated_at = ?3 WHERE id = ?1`,
        ).run(runId, randomUUID(), now());
        const run = getRunWithPolicy(db, runId);
        appendEvent(db, { source: "daemon", kind: "run.fresh_worker", runId, taskId: run?.task_id ?? null, payload: { stage: run?.stage ?? null }, ts: now() });
        resolveRunItems(db, runId, ["worker_not_exited"], "run.fresh_worker", now());
      });
      this.deps.launch(runId, "stage");
    } finally {
      this.relaunching.delete(runId);
    }
  }

  /** A refused fresh-stage replacement waits out its backoff: no exit attempt holds the pass meanwhile. */
  private backingOff(runId: string, t: number): boolean {
    const refusals = this.exitRefusals.get(runId);
    return refusals !== undefined && t < refusals.nextAt;
  }

  /** The worker's exit result; an attempt that throws is an unverified exit, so one run's failure never ends the pass. */
  private async verifiedExit(runId: string): Promise<{ ok: boolean; detail?: string }> {
    try {
      return await this.deps.exitWorker(runId);
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }

  /** One refused fresh-stage replacement: an event when the episode starts, one P1 once it has lasted EXIT_REFUSALS_FOR_ITEM attempts. */
  private freshWorkerRefused(runId: string, detail: string): void {
    const { db, now } = this.deps;
    const attempts = (this.exitRefusals.get(runId)?.attempts ?? 0) + 1;
    const backoff = Math.min(schedTiming(this.deps.config()).pass_ms * 2 ** (attempts - 1), EXIT_BACKOFF_MAX_MS);
    this.exitRefusals.set(runId, { attempts, nextAt: now() + backoff });
    this.deps.log(`sched: fresh worker for ${runId} waits: the old worker did not exit (${detail}; attempt ${attempts})`);
    if (attempts !== 1 && attempts < EXIT_REFUSALS_FOR_ITEM) return;
    tx(db, () => {
      const run = getRunWithPolicy(db, runId);
      if (attempts === 1) appendEvent(db, { source: "daemon", kind: "run.fresh_worker_refused", runId, taskId: run?.task_id ?? null, payload: { stage: run?.stage ?? null, detail, attempts }, ts: now() });
      if (attempts < EXIT_REFUSALS_FOR_ITEM || findOpenRunItem(db, "worker_not_exited", runId)) return;
      const event = appendEvent(db, { source: "daemon", kind: "run.worker_not_exited", runId, taskId: run?.task_id ?? null, payload: { stage: run?.stage ?? null, detail, attempts }, ts: now() });
      const title = run ? taskTitle(db, run.task_id) : runId;
      openItem(db, {
        kind: "worker_not_exited",
        eventSeq: event.seq,
        taskId: run?.task_id ?? null,
        runId,
        line: `${title}: stage ${run?.stage ?? "?"} waits for a fresh worker; the old worker (pid ${run?.proc_pid ?? "?"}) did not exit after ${attempts} tries (${detail})`,
        now: now(),
      });
    });
  }

  /**
   * Autonomy (design section 11): every Queued phase of an approved plan whose
   * blockers have all landed starts, in code and with no leader turn, when its
   * project's autonomy is plan. A phase you hold or park in the backlog waits.
   */
  private async autoDispatch(): Promise<number> {
    const { db, now } = this.deps;
    const config = this.deps.config();
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
      const usage = harness === "claude" ? usageGate(db, now(), null) : "open";
      if (usage === "paused") continue;
      if (harness === "claude" && (await this.quotaHeld())) continue;
      let made: string | null;
      try {
        const workflow = workflowFor(config, phase.workflow, "ship");
        const start = await checkStart(this.deps.startDeps, project, harness);
        made = this.startPhase(phase, project, harness, start, workflow, usage === "probe", now());
      } catch (error) {
        if (error instanceof FlowrynError) this.phaseBlocked(phase, error.message);
        else this.deps.log(`sched: phase ${phase.phase_no} of ${phase.plan_id} failed to start: ${(error as Error).stack ?? String(error)}`);
        continue;
      }
      if (made) {
        started++;
        this.deps.log(`sched: phase ${phase.phase_no} of ${phase.plan_id} started as ${made}`);
      }
    }
    return started;
  }

  /** One phase's run, its backlog start and its P3, in one transaction; null when a run appeared meanwhile. */
  private startPhase(
    phase: PhaseRow & { plan_title: string; source_task: string | null; phases: number },
    project: ProjectRow,
    harness: HarnessId,
    start: { version: string; base: string },
    workflow: WorkflowDef,
    probe: boolean,
    t: number,
  ): string | null {
    const { db } = this.deps;
    const config = this.deps.config();
    return tx(db, () => {
      if (db.query("SELECT 1 FROM runs WHERE task_id = ?1").get(phase.task_id)) return null;
      const runId = createRun(db, config, { taskId: phase.task_id, title: phase.title, body: phase.body, project, kind: "ship", harness, version: start.version, base: start.base, workflow, sensitive: false, existing: true, by: "scheduler", override: null, now: t });
      if (probe) claimProbe(db, runId, t);
      resolveItems(db, "phase_blocked", phase.task_id, "phase.started", t);
      // A plan a design handed in holds the phases after the design's own task, which is phase 1.
      const offset = phase.source_task ? 1 : 0;
      const [n, of] = [phase.phase_no + offset, phase.phases + offset];
      const event = appendEvent(db, { source: "daemon", kind: "phase.started", runId, taskId: phase.task_id, payload: { plan: phase.plan_id, phase: n, of }, ts: t });
      const where = of > 1 ? `Phase ${n} of ${of} in "${phase.plan_title}"` : `Queued task "${phase.title}"`;
      openItem(db, { kind: "phase_started", eventSeq: event.seq, taskId: phase.task_id, runId, line: `${where} started by itself: ${phase.title} (${project.id}); its blockers landed`, now: t });
      return runId;
    });
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
      const untested = HARNESS_IDS.map((h) => [h, unverifiedVersion(db, h)] as const).find(([, v]) => v !== null);
      const why =
        host && !host.ok
          ? `host check: ${host.reason}`
          : usageLimitSince(db) !== null
            ? "the Claude usage limit"
            : quotaHolds(db)
              ? "the Claude quota floor"
              : untested
              ? `${untested[0]} ${untested[1]} has no passing contract, or full capacity pools`
              : "full capacity pools";
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
