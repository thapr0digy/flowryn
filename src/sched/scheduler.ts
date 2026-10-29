import { randomUUID } from "node:crypto";
import { FlowrynError } from "../api/errors.ts";
import { findOpenItem, findOpenRunItem, openItem, resolveItems, resolveRunItems } from "../attention/items.ts";
import { existsSync } from "node:fs";
import { accountsConfig, capacityAccount, resolveAccount, runAccount, type Account } from "../config/accounts.ts";
import { resolveTool, type FlowrynConfig } from "../config/config.ts";
import { capacityConfig, currentWorkflow, schedTiming, workflowFor, type HostCheckConfig, type WorkflowDef } from "../config/workflows.ts";
import { checkPins, modelFits, resolveModelChoice } from "../config/model-choice.ts";
import { tx, type Db } from "../db/db.ts";
import { getMeta, setMeta } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { HARNESS_IDS, type HarnessId } from "../harness/types.ts";
import { readSnapshot } from "../journal/snapshot.ts";
import { checkStart, createRun, signInOf, type StartDeps } from "../lifecycle/dispatch.ts";
import { reviveReview, revivalBlocked, revivalsDue } from "../lifecycle/review-revival.ts";
import { activeAutoAttempt, gateHarness, unverifiedVersion, type HarnessCheck } from "../lifecycle/harness-gate.ts";
import type { LaunchMode } from "../lifecycle/launcher.ts";
import { waitingOn, type PhaseRow } from "../lifecycle/plans.ts";
import { getProject, type ProjectRow } from "../lifecycle/projects.ts";
import { getRunWithPolicy, isTerminal, taskTitle, type RunWithPolicy } from "../lifecycle/runs.ts";
import { activateStage, neededPools, positionOf, type StagePos } from "../lifecycle/stages.ts";
import { explainHumanWaits } from "../attention/human-waits.ts";
import { checkHost, type HostVerdict } from "./host.ts";
import { fullPools, OverCapacity } from "./pools.ts";
import { forgetQuota, heldQuotaAccounts, probeQuota, quotaTarget, quotaHolds, quotaLine, quotaState, quotaStates, recordQuota, type QuotaReading } from "./quota.ts";
import { claimProbe, clearUsageLimit, pausedAccounts, usageGate, usagePauses } from "./usage.ts";
import { moveLegacyCapacity } from "./legacy.ts";
import { forgetSignedOut, noteSignedIn, noteSignedOut, signedOutAccounts } from "./signed-out.ts";
import { loginCommand } from "../harness/sign-in.ts";
import { closeExplanations, explain, sweepExplanations } from "../attention/explanations.ts";
import { ensureLaunchOperation, getOperation, heldByEscalation, openOperation } from "../lifecycle/operations.ts";
import { harnessRefusalOf, hostRefusal, operationModeRefusal, poolsRefusal, quotaRefusal, signedOutRefusal, usageRefusal, type Refusal } from "./wait-reasons.ts";

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
  /** Start or resume a worker in the background (the launcher), for the named requested operation. */
  launch(runId: string, mode: LaunchMode, operation?: string): void;
  isLaunching(runId: string): boolean;
  /** Stop the run's worker process by its recorded identity (a fresh stage worker, a relaunch); whether it is gone. */
  exitWorker(runId: string): Promise<{ ok: boolean; detail?: string }>;
  /** A steer is waiting for this run's worker. */
  notify(runId: string): void;
  startDeps: StartDeps;
  kickJournal(): void;
  host?(cfg: HostCheckConfig): Promise<HostVerdict>;
  /** One quota-axi reading for an account (tests); by default the configured quota-axi runs for its login. */
  quota?(account: Account): Promise<QuotaReading>;
  /** Start queued verifies while slots are free (src/verify/start.ts): first in each grant, since a verify is the step closest to shipping. */
  drainVerifies?(stopped: () => boolean): Promise<number>;
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
  private waitsTimer: ReturnType<typeof setTimeout> | null = null;
  private steady: ReturnType<typeof setInterval> | null = null;
  /** Passes and single-run grants run one at a time, in order. */
  private chain: Promise<unknown> = Promise.resolve();
  /** A pass requested but not started yet: callers meanwhile share it. */
  private queued: Promise<void> | null = null;
  private stopped = false;
  private hostCache: { at: number; verdict: HostVerdict } | null = null;
  /** The last quota-axi reading per account. */
  private readonly quotaCache = new Map<string, { at: number; reading: QuotaReading }>();
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
    const { db, now } = this.deps;
    try {
      const moved = tx(db, () => moveLegacyCapacity(db, this.deps.config(), now()));
      if (moved) this.deps.log(`sched: the Claude quota and usage pause moved to account ${moved}`);
    } catch (error) {
      this.deps.log(`sched: moving the Claude capacity state failed: ${(error as Error).message}`);
    }
    this.steady = setInterval(() => this.kick(), schedTiming(this.deps.config()).pass_ms);
    this.kick();
  }

  /** No new pass after this; resolves when the pass or grant under way, if any, has ended (the daemon closes the database after). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.waitsTimer) clearTimeout(this.waitsTimer);
    if (this.steady) clearInterval(this.steady);
    this.timer = null;
    this.waitsTimer = null;
    this.steady = null;
    await this.chain;
  }

  /** Look again soon; calls within the debounce window coalesce. */
  kick(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.passNow();
    }, 25);
  }

  /**
   * Record the waits on you or the leader soon (debounced), without a whole
   * pass: a mutation that opens or answers a question or closes a review is
   * explained in moments, not at the next steady pass.
   */
  kickWaits(): void {
    if (this.stopped || this.waitsTimer) return;
    this.waitsTimer = setTimeout(() => {
      this.waitsTimer = null;
      if (!this.stopped) void this.exclusive(() => this.explainWaits());
    }, 25);
  }

  /** The waits on you or the leader, then the sweep that closes what ended; its own step, so a throw never stops a pass. */
  private async explainWaits(): Promise<void> {
    await this.step("human-waits", async () => void tx(this.deps.db, () => explainHumanWaits(this.deps.db, this.deps.config(), this.deps.now())));
    tx(this.deps.db, () => sweepExplanations(this.deps.db, this.deps.now()));
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
      return this.tryGrant(mine, config, newPass(), false);
    });
  }

  /** Auto-dispatch, grants and alerts, each on its own: one that throws never stops the others. */
  private async pass(): Promise<void> {
    await this.step("auto-dispatch", async () => {
      if ((await this.autoDispatch()) > 0) this.deps.kickJournal();
    });
    await this.step("review revivals", async () => {
      if ((await this.reviveReviews()) > 0) this.deps.kickJournal();
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

  /** The host check as the next grant would read it: heavy work outside a run (a verify) is admitted on the same verdict. */
  async hostCheck(): Promise<HostVerdict> {
    return this.hostVerdict(capacityConfig(this.deps.config()).host);
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

  private async readQuota(account: Account): Promise<QuotaReading> {
    if (this.deps.quota) return this.deps.quota(account);
    const config = this.deps.config();
    const tool = resolveTool(config, "quota_axi");
    return probeQuota(tool && existsSync(tool) ? tool : null, resolveTool(config, "node"), account);
  }

  /**
   * Whether new runs on this account wait on the quota floor now: quota-axi
   * is read for the account at most every quota_cache_ms, and only when a new
   * run on it could start. A floor of 0 reads nothing and lifts a low state
   * recorded under an older floor.
   */
  private async quotaHeld(account: Account): Promise<boolean> {
    const { db, now } = this.deps;
    const config = this.deps.config();
    const { floor } = capacityConfig(config).quota;
    const previous = quotaState(db, account.id);
    // A login quota-axi cannot read is never probed nor recorded: its quota is unknown and holds nothing.
    if ("none" in quotaTarget(account) && previous?.state !== "low") return false;
    let reading: QuotaReading;
    if (floor <= 0) {
      if (!previous || previous.state !== "low") return false;
      reading = { state: "known", percent: previous.percent ?? 0, window: previous.window, resets_at: previous.resets_at };
    } else {
      const ttl = schedTiming(config).quota_cache_ms;
      const cached = this.quotaCache.get(account.id);
      if (!cached || now() - cached.at >= ttl) this.quotaCache.set(account.id, { at: now(), reading: await this.readQuota(account) });
      reading = this.quotaCache.get(account.id)!.reading;
    }
    const state = tx(db, () => recordQuota(db, account.id, reading, floor, now()));
    if (state.state !== previous?.state) this.deps.log(`sched: quota of account ${account.id}: ${quotaLine(state)}`);
    return quotaHolds(db, account.id);
  }

  /**
   * Is the account signed in? Asked once per pass (a pass is remembered
   * longer by the check itself); a failure opens the account's P1 and a pass
   * closes it. Null when it may launch, else the refusal.
   */
  private async signedOut(account: Account, pass: GrantPass): Promise<Refusal | null> {
    if (!account.declared) return null;
    const { db, now } = this.deps;
    let check = pass.signIns.get(account.id);
    if (!check) {
      check = this.deps.startDeps.signIn ? this.deps.startDeps.signIn(account) : signInOf(this.deps.config(), account);
      pass.signIns.set(account.id, check);
    }
    let detail: string | null;
    try {
      detail = await check;
    } catch (error) {
      detail = `account ${account.id}: the sign-in check failed (${(error as Error).message})`;
    }
    if (detail === null) {
      if (tx(db, () => noteSignedIn(db, account.id, now()))) this.deps.log(`sched: account ${account.id} is signed in again`);
      return null;
    }
    const since = tx(db, () => noteSignedOut(db, account.id, detail, loginCommand(account), now()));
    return signedOutRefusal(account.id, detail, loginCommand(account), since);
  }

  /** Why new runs on the account wait (its usage pause, its quota floor), or null when it may take one now. */
  private async accountHold(account: Account, runId: string | null, fresh: boolean): Promise<{ usage: "open" | "probe"; refusal: null } | { usage: null; refusal: (overflow: string | null) => Refusal }> {
    const { db, now } = this.deps;
    const usage = usageGate(db, now(), account.id, runId);
    if (usage === "paused") return { usage: null, refusal: (overflow) => usageRefusal(db, account.id, now(), overflow) };
    // Under the quota floor a new run waits; a live run's next stage, a resume or a relaunch drains.
    if (fresh && (await this.quotaHeld(account))) return { usage: null, refusal: (overflow) => quotaRefusal(db, account.id, overflow) };
    return { usage, refusal: null };
  }

  /**
   * The account a held fresh launch overflows to: the first of the account's
   * `overflow` list that is not paused at all, whose quota is not low and
   * that is signed in. One level: a target's own list is not followed.
   */
  private async overflowTarget(account: Account, config: FlowrynConfig, pass: GrantPass, model: string | null): Promise<Account | null> {
    for (const id of account.overflow) {
      const target = capacityAccount(config, id, account.harness);
      if (!target) continue;
      // A task's own Pi model goes with it, so a target that spends another provider cannot take the run.
      if (model !== null && !modelFits(model, target)) continue;
      if (usageGate(this.deps.db, this.deps.now(), target.id, null) !== "open") continue;
      if (await this.quotaHeld(target)) continue;
      if (await this.signedOut(target, pass)) continue;
      return target;
    }
    return null;
  }

  private candidates(): Candidate[] {
    const { db, now } = this.deps;
    const rows = db
      .query(
        `SELECT r.*, tp.project_id, tp.kind, tp.delivery_mode, tp.sensitive, COALESCE(p.priority, 2) AS priority
         FROM runs r JOIN task_policy tp ON tp.task_id = r.task_id LEFT JOIN projects p ON p.id = tp.project_id
         WHERE r.state NOT IN ('cleaned','failed','cancelled') AND (r.stage_state = 'waiting' OR r.pending_launch IS NOT NULL)
           AND (r.pending_launch IS NOT NULL OR r.liveness != 'dead')
           AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.run_id = r.id AND (o.phase = 'effect_issued' OR (o.kind = 'cancel' AND o.phase = 'requested')))`,
      )
      .all() as (RunWithPolicy & { priority: number })[];
    const t = now();
    // A run that no longer waits for its replacement (cancelled, failed) drops its refusal count.
    for (const runId of this.exitRefusals.keys()) if (!rows.some((run) => run.id === runId)) this.exitRefusals.delete(runId);
    return rows
      .filter((run) => !this.relaunching.has(run.id) && !this.deps.isLaunching(run.id) && !this.backingOff(run.id, t) && !heldByEscalation(db, run.id))
      .map((run) => {
        const pos = positionOf(db, run, run.kind);
        return { run, pos, needs: neededPools(db, run, pos), remaining: pos.def.stages.length - 1 - pos.index, priority: run.priority, since: run.waiting_since ?? t };
      })
      .toSorted((a, b) => a.remaining - b.remaining || a.priority - b.priority || a.since - b.since || a.run.started_at - b.run.started_at);
  }

  private async grant(): Promise<void> {
    // Drain before fill: a queued verify is nearer shipping than any stage, so it takes a free validation slot first.
    if (this.deps.drainVerifies && !this.stopped) await this.step("verify-queue", async () => void (await this.deps.drainVerifies!(() => this.stopped)));
    const config = this.deps.config();
    // Reviews, decisions and merges waiting on you or the leader (docs/notes/2026-10-29-why-waiting-covers-fy.md), then the sweep.
    await this.explainWaits();
    const pass = newPass();
    this.forgetDroppedAccounts(config);
    // A low reading or a signed-out login is checked again while nothing waits on it, so a reset or a sign-in lifts it.
    for (const [id, state] of quotaStates(this.deps.db)) {
      const account = state.state === "low" ? capacityAccount(config, id, "claude") ?? capacityAccount(config, id, "pi") : null;
      if (account) await this.quotaHeld(account);
    }
    for (const id of signedOutAccounts(this.deps.db)) {
      const account = capacityAccount(config, id, "claude") ?? capacityAccount(config, id, "pi");
      if (account) await this.signedOut(account, pass);
    }
    for (const c of this.candidates()) {
      if (this.stopped) return;
      await this.tryGrant(c, config, pass, true);
    }
  }

  /**
   * An account config no longer has holds nothing once no live run records it:
   * its usage pause, quota state and signed-out episode end, each with an event.
   */
  private forgetDroppedAccounts(config: FlowrynConfig): void {
    const { db, now } = this.deps;
    const recorded = new Set([...usagePauses(db).keys(), ...quotaStates(db).keys(), ...signedOutAccounts(db)]);
    const why = "the account is no longer in config";
    const configured = accountsConfig(config).accounts;
    const inUse = db.query(
      `SELECT 1 FROM runs WHERE state NOT IN ('cleaned','failed','cancelled') AND (account = ?1 OR (account IS NULL AND harness = ?1)) LIMIT 1`,
    );
    for (const id of recorded) {
      if (configured[id] || inUse.get(id)) continue;
      tx(db, () => {
        clearUsageLimit(db, id, why, now(), "daemon");
        forgetQuota(db, id, why, now());
        forgetSignedOut(db, id, why, now());
      });
      this.deps.log(`sched: account ${id} is no longer in config; its capacity state is released`);
    }
  }

  /**
   * One grant: the account's sign-in, its usage pause (or its one probe) and
   * quota floor, with overflow for a held fresh launch, the host check (once
   * per pass) and the pools, then the stage start. Whether it started.
   */
  private async tryGrant(c: Candidate, config: FlowrynConfig, pass: GrantPass, steer: boolean): Promise<boolean> {
    const { db, now } = this.deps;
    const capacity = capacityConfig(config);
    const firstLaunch = c.run.pending_launch === "fresh";
    let account = capacityAccount(config, c.run.account, c.run.harness);
    // An account config no longer has: the launch refuses it with why, so nothing is held here.
    let usage: "open" | "probe" = "open";
    let moved: { from: string; why: string } | null = null;
    if (account) {
      if (c.run.pending_launch) {
        const out = await this.signedOut(account, pass);
        if (out) return this.refuse(c, out);
      }
      const hold = await this.accountHold(account, c.run.id, firstLaunch);
      if (hold.refusal) {
        // Overflow moves only a run's first launch: a resume, a relaunch or a fresh stage keeps its account's session store.
        const target = firstLaunch && account.overflow.length > 0 ? await this.overflowTarget(account, config, pass, c.run.model_pin) : null;
        if (!target) return this.refuse(c, hold.refusal(firstLaunch && account.overflow.length > 0 ? `no overflow account is free (${account.overflow.join(", ")})` : null));
        moved = { from: account.id, why: hold.refusal(null).rule };
        account = target;
      } else usage = hold.usage;
    }
    // A grant that launches a worker checks the installed harness version first (design section 5).
    if (c.run.pending_launch) {
      const check = await this.harnessCheck(c.run.harness, config);
      if (check.state !== "verified") return this.refuse(c, harnessRefusalOf(check, activeAutoAttempt(db, config, c.run.harness), now()));
    }
    if (c.needs.length > 0) {
      pass.host ??= await this.hostVerdict(capacity.host);
      if (!pass.host.ok) return this.refuse(c, hostRefusal(hostState(db), capacity.host, pass.host.reason, now()));
      const full = fullPools(db, capacity.pools, c.needs);
      if (full.length > 0) return this.refuse(c, poolsRefusal(db, capacity.pools, full, now()));
    }
    let activated;
    try {
      activated = tx(db, () => {
        const fresh = getRunWithPolicy(db, c.run.id);
        if (!fresh || isTerminal(fresh.state) || (fresh.stage_state !== "waiting" && !fresh.pending_launch)) return null;
        // A cancel or an issued launch owns the run (src/lifecycle/operations.ts): nothing is granted over it.
        const open = openOperation(db, fresh.id);
        if (open && (open.kind === "cancel" || open.phase !== "requested")) return null;
        if (heldByEscalation(db, fresh.id)) return null;
        if (open && fresh.pending_launch && open.mode !== fresh.pending_launch) return { refusal: operationModeRefusal(open, fresh.pending_launch) };
        if (moved && account) {
          // Re-read in the transaction: the run must still be on its first launch, on the account that was held.
          if (fresh.pending_launch !== "fresh" || (fresh.account ?? fresh.harness) !== moved.from) return null;
          overflowRun(db, config, fresh, moved.from, account, moved.why, now());
        }
        const row = moved ? getRunWithPolicy(db, fresh.id)! : fresh;
        const started = activateStage(db, config, row, now(), { steer });
        if (started && usage === "probe" && account) claimProbe(db, account.id, c.run.id, now());
        if (started) closeExplanations(db, c.run.id, ["capacity", "resume"], "granted", now());
        // The grant's launch is an operation from here: a daemon that stops before the launcher claims it recovers it.
        const operation = started?.launch ? (ensureLaunchOperation(db, fresh, started.launch, "scheduler", "daemon", now())?.id ?? null) : null;
        return started ? { ...started, operation } : null;
      });
    } catch (error) {
      if (error instanceof OverCapacity) return this.refuse(c, poolsRefusal(db, capacity.pools, fullPools(db, capacity.pools, c.needs), now()));
      throw error;
    }
    if (!activated) return false;
    if (activated.refusal) return this.refuse(c, activated.refusal);
    if (activated.steer) this.deps.notify(c.run.id);
    const operation = activated.operation ?? undefined;
    if (activated.launch === "stage") await this.freshWorker(c.run.id, operation);
    else if (activated.launch === "relaunch") await this.relaunchWorker(c.run.id, operation);
    else if (activated.launch) this.deps.launch(c.run.id, activated.launch, operation);
    return true;
  }

  /**
   * A relaunch (a scout promoted in place): the live worker exits by its
   * identity, and its own session resumes in the same worktree, so its context
   * survives while its contract, task file and sandbox settings change.
   */
  private async relaunchWorker(runId: string, operation: string | undefined): Promise<void> {
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
      this.deps.launch(runId, "relaunch", operation);
    } finally {
      this.relaunching.delete(runId);
    }
  }

  /** The harness gate before a launch: an untested version waits, with its P1; a check that fails counts as missing. */
  private async harnessCheck(harness: HarnessId, config: FlowrynConfig): Promise<HarnessCheck> {
    try {
      return await gateHarness(this.deps.db, config, harness, this.deps.startDeps.harnessVersion, "daemon", "launch", this.deps.now);
    } catch (error) {
      const message = (error as Error).message;
      this.deps.log(`sched: checking ${harness} failed: ${message}`);
      // The message can differ on every pass (pids, timings): the detail names only the error's kind, so an unchanged failure explains the same way.
      const kind = (error as { code?: unknown }).code ?? (error as Error).name ?? "Error";
      return { harness, state: "missing", detail: `checking ${harness} failed (${String(kind)})`, error: message };
    }
  }

  /**
   * A refused grant: record why, unless the run already waits for the same
   * reason (docs/notes/2026-10-12-next-steps-md-wz.md). Returns false, the grant's result.
   */
  private refuse(c: Candidate, why: Refusal): false {
    const { db, now } = this.deps;
    tx(db, () => {
      const run = getRunWithPolicy(db, c.run.id);
      if (!run || isTerminal(run.state)) return;
      // A grant that would launch a requested operation (a resume waiting for capacity) names it.
      const operation = openOperation(db, run.id)?.id ?? null;
      explain(db, { run: { id: run.id, task_id: run.task_id, stage: c.pos.stage.id }, kind: "capacity", ...why, operation, source: "daemon", now: now() });
    });
    return false;
  }

  /**
   * A stage with fresh = true: the old worker exits, and a new session starts in
   * the same worktree. Only a verified exit clears the old identity: a worker
   * that did not stop keeps it, its slots and its pending replacement, and the
   * next pass tries again (docs/notes/2026-10-12-next-steps-md-we.md).
   */
  private async freshWorker(runId: string, operation: string | undefined): Promise<void> {
    const { db, now } = this.deps;
    this.relaunching.add(runId);
    try {
      const exited = await this.verifiedExit(runId);
      if (!exited.ok) {
        this.freshWorkerRefused(runId, exited.detail ?? "unverified");
        return;
      }
      this.exitRefusals.delete(runId);
      // A cancel that superseded the replacement while the old worker exited: no new session for it.
      if (operation && getOperation(db, operation)?.phase !== "requested") return;
      tx(db, () => {
        db.query(
          `UPDATE runs SET agent_session = ?2, proc_pid = NULL, proc_start = NULL, proc_exe = NULL, worker_started_at = NULL,
             busy_until = NULL, idle_since = NULL, transcript_path = NULL, liveness = 'starting', updated_at = ?3 WHERE id = ?1`,
        ).run(runId, randomUUID(), now());
        const run = getRunWithPolicy(db, runId);
        appendEvent(db, { source: "daemon", kind: "run.fresh_worker", runId, taskId: run?.task_id ?? null, payload: { stage: run?.stage ?? null }, ts: now() });
        resolveRunItems(db, runId, ["worker_not_exited"], "run.fresh_worker", now());
      });
      this.deps.launch(runId, "stage", operation);
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
        `SELECT ph.*, pl.title AS plan_title, pl.project_id, pl.source_task, (SELECT MAX(x.phase_no) FROM plan_phases x WHERE x.plan_id = ph.plan_id) AS phases
         FROM plan_phases ph JOIN plans pl ON pl.id = ph.plan_id JOIN task_policy tp ON tp.task_id = ph.task_id
         WHERE pl.state = 'approved' AND tp.auto = 1 AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id = ph.task_id)
         ORDER BY pl.created_at, ph.phase_no`,
      )
      .all() as (PhaseRow & { plan_title: string; project_id: string; source_task: string | null; phases: number })[];
    if (phases.length === 0) return 0;
    const pass = newPass();
    const backlog = readSnapshot(db, "backlog")?.tasks ?? null;
    let started = 0;
    for (const phase of phases) {
      const project = getProject(db, phase.project_id);
      if (!project || project.autonomy !== "plan") continue;
      const task = backlog?.find((t) => t.id === phase.task_id);
      // Not in the backlog yet (its add is still pending), held, parked or already started by hand: wait.
      if (!task || task.state !== "queued" || task.hold) continue;
      if (waitingOn(db, phase.task_id, backlog, JSON.parse(phase.blocked_by) as string[]).length > 0) continue;
      let account: Account;
      const pins = { model: phase.model, effort: phase.effort };
      try {
        account = resolveAccount(config, project, { account: phase.account, harness: phase.harness as HarnessId | null });
        checkPins(pins, account, `plan phase "${phase.title}"`);
      } catch (error) {
        if (error instanceof FlowrynError) this.phaseBlocked(phase, error.message);
        else throw error;
        continue;
      }
      // A phase's run is a fresh launch: a held account overflows if it can, else the phase waits unstarted.
      const hold = await this.accountHold(account, null, true);
      let usage: "open" | "probe" = "open";
      let moved: { from: string; why: string } | null = null;
      if (hold.refusal) {
        const target = account.overflow.length > 0 ? await this.overflowTarget(account, config, pass, pins.model) : null;
        if (!target) continue;
        moved = { from: account.id, why: hold.refusal(null).rule };
        account = target;
      } else usage = hold.usage;
      let made: string | null;
      try {
        const workflow = workflowFor(config, phase.workflow, "ship");
        const start = await checkStart(this.deps.startDeps, project, account);
        made = this.startPhase(phase, project, account, start, workflow, usage === "probe", moved, now());
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

  /**
   * A message on the review page of a run gone for good (failed, worktree
   * cleaned) asked for a new run (src/lifecycle/review-revival.ts): start it
   * on the old run's account once a start checks, as a dispatch would. One
   * that cannot start yet tells the leader once and is tried again next pass.
   */
  private async reviveReviews(): Promise<number> {
    const { db, now } = this.deps;
    let started = 0;
    for (const due of revivalsDue(db)) {
      const config = this.deps.config();
      try {
        const run = getRunWithPolicy(db, due.run);
        const project = run ? getProject(db, run.project_id) : null;
        if (!run || !project) continue;
        const account = runAccount(config, project, run.account, run.harness);
        const start = await checkStart(this.deps.startDeps, project, account);
        const revived = tx(db, () => (revivalsDue(db).some((d) => d.gate === due.gate) ? reviveReview(db, config, { gateId: due.gate, by: "review page", words: null, account, start, now: now(), log: this.deps.log }) : null));
        if (!revived) continue;
        started++;
        this.deps.log(`sched: gate ${due.gate}'s review page started ${revived.run} for ${revived.task} at stage ${revived.stage} (${revived.oldRun} had ended for good)`);
      } catch (error) {
        if (error instanceof FlowrynError) tx(db, () => revivalBlocked(db, due.gate, error.message, now()));
        else this.deps.log(`sched: gate ${due.gate}'s new run failed to start: ${(error as Error).stack ?? String(error)}`);
      }
    }
    return started;
  }

  /** One phase's run, its backlog start and its P3, in one transaction; null when a run appeared meanwhile. */
  private startPhase(
    phase: PhaseRow & { plan_title: string; source_task: string | null; phases: number },
    project: ProjectRow,
    account: Account,
    start: { version: string; base: string },
    workflow: WorkflowDef,
    probe: boolean,
    moved: { from: string; why: string } | null,
    t: number,
  ): string | null {
    const { db } = this.deps;
    const config = this.deps.config();
    return tx(db, () => {
      if (db.query("SELECT 1 FROM runs WHERE task_id = ?1").get(phase.task_id)) return null;
      const runId = createRun(db, config, { taskId: phase.task_id, title: phase.title, body: phase.body, project, kind: "ship", account, pins: { model: phase.model, effort: phase.effort }, version: start.version, base: start.base, workflow, sensitive: false, existing: true, by: "scheduler", override: null, now: t });
      if (probe) claimProbe(db, account.id, runId, t);
      if (moved) appendEvent(db, { source: "daemon", kind: "sched.overflow", runId, taskId: phase.task_id, payload: { from: moved.from, to: account.id, why: moved.why, at: "phase start" }, ts: t });
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
      const paused = pausedAccounts(db, t);
      const low = heldQuotaAccounts(db);
      const signedOut = signedOutAccounts(db);
      const why =
        host && !host.ok
          ? `host check: ${host.reason}`
          : paused.length > 0
            ? `the usage limit on ${paused.join(", ")}`
            : low.length > 0
              ? `the quota floor on ${low.join(", ")}`
              : signedOut.length > 0
                ? `${signedOut.join(", ")} signed out`
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

/** What one grant pass reads once: the host check and each account's sign-in. */
interface GrantPass {
  host: HostVerdict | null;
  signIns: Map<string, Promise<string | null>>;
}

function newPass(): GrantPass {
  return { host: null, signIns: new Map() };
}

/**
 * A held fresh launch moves to an overflow account: the run's account, and
 * the model and effort looked up again on it (the task's own choice goes
 * with the run). Call inside the grant's transaction.
 */
function overflowRun(db: Db, config: FlowrynConfig, run: RunWithPolicy, from: string, to: Account, why: string, now: number): void {
  const choice = resolveModelChoice(config, { pins: { model: run.model_pin, effort: run.effort_pin }, workflow: currentWorkflow(config, run.workflow), account: to });
  db.query("UPDATE runs SET account = ?2, model = ?3, effort = ?4, updated_at = ?5 WHERE id = ?1").run(run.id, to.id, choice.model, choice.effort, now);
  appendEvent(db, { source: "daemon", kind: "sched.overflow", runId: run.id, taskId: run.task_id, payload: { from, to: to.id, why, at: "grant", ...choice }, ts: now });
}
