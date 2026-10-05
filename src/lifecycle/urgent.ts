import type { Timing } from "../config/workers.ts";
import type { Db } from "../db/db.ts";
import { tx } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { findOpenRunItem } from "../attention/items.ts";
import type { Verified } from "../harness/types.ts";
import type { HerdrRuntime } from "../runtime/herdr/runtime.ts";
import { knownDialogRefusal } from "./control.ts";
import { clearPrompt } from "./prompt-wedge.ts";
import { getRun, isTerminal, setLiveness, type RunRow } from "./runs.ts";
import { getMessage, markPreempted, preemptCandidate } from "./steers.ts";

/**
 * Urgent steers (steer latency Tier 2). The carriers are the ordinary ones;
 * urgency moves the boundary earlier:
 *   - block: a Claude PreToolUse denies the next main-agent tool call with
 *     the steer (src/lifecycle/hooks.ts); the Pi extension blocks its next
 *     tool_call while the queued steer is unseen;
 *   - cancel: a tool that has run steer_preempt_after_ms is cut. Claude: this
 *     file's UrgentPreempter times it from the tool hooks and calls the
 *     verified interrupt (the interrupt key, behind interruptKeyRefusal),
 *     after which the waiter fires the steer into the idle session. Pi: the
 *     extension times it and asks `hook preempt` (piPreempt) before its
 *     abort; the stop that follows loses the dropped copy, which then rings
 *     again to the idle agent.
 * Nothing is cancelled while a dialog may be open: the attempt is deferred,
 * recorded once per reason, and tried again every recheck_ms.
 */

/** How often a deferred preemption looks again. */
export const RECHECK_MS = 1_000;

/**
 * The tools a worker's main agent is running, from its hooks: tool id →
 * start time. In memory only, like the Stop continuations: a daemon restart
 * forgets it, and nothing is cancelled until the next tool start.
 */
export class ToolTracker {
  private readonly runs = new Map<string, Map<string, number>>();

  start(runId: string, toolId: string, at: number): void {
    const tools = this.runs.get(runId) ?? new Map<string, number>();
    if (!tools.has(toolId)) tools.set(toolId, at);
    this.runs.set(runId, tools);
  }

  end(runId: string, toolId: string): void {
    this.runs.get(runId)?.delete(toolId);
  }

  clear(runId: string): void {
    this.runs.delete(runId);
  }

  /** When the oldest running tool started (or its clock last restarted), or null when none runs. */
  oldest(runId: string): number | null {
    let oldest: number | null = null;
    for (const at of this.runs.get(runId)?.values() ?? []) if (oldest === null || at < oldest) oldest = at;
    return oldest;
  }

  /** A dialog was just seen gone: the tools it held get their own full threshold from now. */
  restart(runId: string, at: number): void {
    const tools = this.runs.get(runId);
    if (tools) for (const id of tools.keys()) tools.set(id, at);
  }
}

/** Remembers the last deferral reason per steer, so a deferral is an event once per reason, not once a second. */
export class DeferralLog {
  private readonly last = new Map<string, string>();

  /** Call inside a transaction: appends steer.preempt_deferred when the reason is new for this steer. */
  note(db: Db, run: RunRow, steerId: string, reason: string, now: number): void {
    if (this.last.get(steerId) === reason) return;
    this.last.set(steerId, reason);
    appendEvent(db, { source: "daemon", kind: "steer.preempt_deferred", runId: run.id, taskId: run.task_id, payload: { steer: steerId, reason }, ts: now });
  }

  forget(steerId: string): void {
    this.last.delete(steerId);
  }
}

/** What the fleet's handlers see of the urgent machinery. */
export interface UrgentServices {
  tools: ToolTracker;
  deferrals: DeferralLog;
  /** Something changed for the run (a steer, a tool start or end, a turn end): re-plan its cancel. */
  kick(runId: string): void;
  close(): void;
}

/** No cancelling at all (tests without a daemon); the tracker and the log still work. */
export function inertUrgent(): UrgentServices {
  return { tools: new ToolTracker(), deferrals: new DeferralLog(), kick: () => {}, close: () => {} };
}

export interface PreempterDeps {
  db: Db;
  timing(): Timing;
  now(): number;
  runtime(): HerdrRuntime | null;
  /** The verified interrupt (src/lifecycle/control.ts interruptRun), gated on no dialog. */
  interrupt(runId: string): Promise<Verified>;
  log(message: string): void;
  recheckMs?: number;
}

/**
 * Times the cancel of a Claude worker's long tool for an urgent steer. Kicked
 * by the steer's creation and by every tool hook; one timer per run, at the
 * moment the oldest running tool reaches the threshold.
 */
export class UrgentPreempter implements UrgentServices {
  readonly tools = new ToolTracker();
  readonly deferrals = new DeferralLog();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly busy = new Set<string>();
  private closed = false;

  constructor(private readonly deps: PreempterDeps) {}

  kick(runId: string): void {
    if (this.closed) return;
    this.cancelTimer(runId);
    const at = this.plan(runId);
    if (at !== null) this.schedule(runId, Math.max(0, at - this.deps.now()));
  }

  close(): void {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** When to try the cancel, or null when there is nothing to cancel for. */
  private plan(runId: string): number | null {
    const run = getRun(this.deps.db, runId);
    if (!run || isTerminal(run.state) || run.harness !== "claude") return null;
    if (!preemptCandidate(this.deps.db, runId)) return null;
    const started = this.tools.oldest(runId);
    return started === null ? null : started + this.deps.timing().steer_preempt_after_ms;
  }

  private schedule(runId: string, delayMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(runId);
      void this.attempt(runId).catch((error: unknown) => this.deps.log(`urgent: preempting ${runId} failed: ${(error as Error).message}`));
    }, delayMs);
    timer.unref?.();
    this.timers.set(runId, timer);
  }

  private cancelTimer(runId: string): void {
    const timer = this.timers.get(runId);
    if (timer) clearTimeout(timer);
    this.timers.delete(runId);
  }

  private async attempt(runId: string): Promise<void> {
    if (this.closed || this.busy.has(runId)) return;
    const { db, now } = this.deps;
    const at = this.plan(runId);
    if (at === null) return;
    if (at > now()) return this.schedule(runId, at - now());
    const run = getRun(db, runId)!;
    const steer = preemptCandidate(db, runId)!;
    const recheck = () => this.schedule(runId, this.deps.recheckMs ?? RECHECK_MS);
    if (await this.releasedPrompt(run)) return this.kick(runId);
    const known = knownDialogRefusal(db, run);
    if (known) {
      tx(db, () => this.deferrals.note(db, run, steer.id, known, now()));
      return recheck();
    }
    const toolMs = now() - this.tools.oldest(runId)!;
    this.busy.add(runId);
    let result: Verified;
    try {
      result = await this.deps.interrupt(runId);
    } finally {
      this.busy.delete(runId);
    }
    // Refused (a dialog may be open), or nothing was sent (Herdr unreachable, the worker gone): try again.
    if (!result.ok && (result.evidence === "refused" || result.detail !== undefined)) {
      tx(db, () => this.deferrals.note(db, run, steer.id, result.detail ?? result.evidence, now()));
      return recheck();
    }
    // The key went (verified or not): the steer has had its one cancel.
    tx(db, () => markPreempted(db, run, getMessage(db, steer.id)!, "escape", toolMs, now(), result.ok));
    this.deferrals.forget(steer.id);
    if (result.ok) this.tools.clear(runId);
  }

  /**
   * An open blocked_prompt holds every cancel. Herdr reading "working" means
   * the dialog is gone (spike c12: a dialog and a running tool never overlap;
   * the reconciler applies the same rule each pass): clear it here rather
   * than wait for the next pass, and restart the tool clock, so a tool you
   * just approved gets its own threshold.
   */
  private async releasedPrompt(run: RunRow): Promise<boolean> {
    const { db, now } = this.deps;
    const runtime = this.deps.runtime();
    if (!runtime || !run.pane_id || !findOpenRunItem(db, "blocked_prompt", run.id)) return false;
    let status: string | null;
    try {
      status = await runtime.agentStatus(run.pane_id);
    } catch {
      return false;
    }
    if (status !== "working") return false;
    tx(db, () => {
      const current = getRun(db, run.id);
      if (!current || !findOpenRunItem(db, "blocked_prompt", run.id)) return;
      clearPrompt(db, current, status, "daemon", now());
      setLiveness(db, current, "busy", "daemon", { signal: "dialog gone" }, now());
    });
    this.tools.restart(run.id, now());
    return true;
  }
}

export type PiPreemptReply = { go: true } | { go: false; reason: string } | { defer: string };

/**
 * `hook preempt` from the Pi extension: may it abort the run for this urgent
 * steer, whose oldest tool has run `toolMs`? Go marks the steer preempted;
 * the stop that follows the abort loses its dropped copy (loseUnseenUrgent).
 * Call inside a transaction.
 */
export function piPreempt(db: Db, run: RunRow, steerId: string, toolMs: number, timing: Timing, deferrals: DeferralLog, now: number): PiPreemptReply {
  const steer = getMessage(db, steerId);
  if (!steer || steer.run_id !== run.id || steer.urgent !== 1) return { go: false, reason: "not an urgent steer of this run" };
  if (steer.acked_at !== null || steer.ring_state === "seen") return { go: false, reason: "already seen" };
  if (steer.preempted_at !== null) return { go: false, reason: "already cut a tool" };
  if (toolMs < timing.steer_preempt_after_ms) return { go: false, reason: `the tool has run ${toolMs}ms, under ${timing.steer_preempt_after_ms}ms` };
  const known = knownDialogRefusal(db, run);
  if (known) {
    deferrals.note(db, run, steer.id, known, now);
    return { defer: known };
  }
  markPreempted(db, run, steer, "abort", toolMs, now, true);
  deferrals.forget(steer.id);
  return { go: true };
}
