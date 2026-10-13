import type { Timing } from "../config/workers.ts";
import type { Db } from "../db/db.ts";
import { tx } from "../db/db.ts";
import { appendEvent, type EventSource } from "../db/events.ts";
import type { HarnessId, Verified } from "../harness/types.ts";
import { HerdrError } from "../runtime/herdr/client.ts";
import type { HerdrRuntime, PaneProcess } from "../runtime/herdr/runtime.ts";
import { readIdentity, type ProcIdentity, type PsRunner } from "../runtime/proc.ts";
import { cancelRun, getRun, isTerminal, type RunRow } from "./runs.ts";
import {
  confirmOperation,
  escalateOperation,
  failOperation,
  getOperation,
  MAX_LAUNCH_ISSUES,
  reissueOperation,
  type OperationPhase,
  type OperationRow,
} from "./operations.ts";

/**
 * Driving and recovering lifecycle operations (docs/notes/2026-10-13-next-steps-md-rz.md):
 * a cancel's stop and commit, shared by its request, a replay of it and the
 * reconciler; and an issued launch or resume whose launcher is gone, judged
 * against the candidate it recorded before agent.start, never a pane label.
 */

export interface CancelOutcome {
  ok: boolean;
  phase: OperationPhase;
  evidence: string;
  detail?: string;
}

export interface OperationDeps {
  db: Db;
  runtime(): HerdrRuntime | null;
  timing(): Timing;
  now(): number;
  log(message: string): void;
  /** Stop the run's worker by its recorded identity, verified gone (src/lifecycle/control.ts). */
  exitRun(runId: string): Promise<Verified>;
  /** After a confirmed cancel: forget the run's waiters, kick the scheduler, close its workspace. */
  cancelled?(runId: string): Promise<void>;
  /** The configured harness binary's process match, or null when the harness cannot be resolved. */
  matchesHarness(harness: HarnessId): ((p: PaneProcess) => boolean) | null;
  /** Whether this daemon's launcher is starting the run now: its operation is in flight, not ambiguous. */
  isLaunching(runId: string): boolean;
  ps?: PsRunner;
}

/** ps reports start times to the second; a candidate that started in the second before issued_at is still ours. */
export const START_SLACK_MS = 1_000;

export type CandidateVerdict = "unknown" | "waiting" | "adopted" | "reissued" | "escalated" | "busy" | "stale";

export class Operations {
  private readonly deps: OperationDeps;
  private readonly cancels = new Map<string, Promise<CancelOutcome>>();
  private readonly checking = new Set<string>();

  constructor(deps: OperationDeps) {
    this.deps = deps;
  }

  /** Whether a cancel or a candidate check for this operation is in flight in this daemon. */
  inFlight(id: string): boolean {
    return this.cancels.has(id) || this.checking.has(id);
  }

  /**
   * Drive a cancel to its end. One attempt per operation at a time: a second
   * caller (the same request again, a replay, the reconciler) shares it. A
   * recovering caller has no one to tell of a worker that will not exit, so
   * that escalates instead of failing.
   */
  driveCancel(id: string, opts: { recovering?: boolean } = {}): Promise<CancelOutcome> {
    const running = this.cancels.get(id);
    if (running) return running;
    const attempt = this.cancelOnce(id, opts.recovering === true).finally(() => this.cancels.delete(id));
    this.cancels.set(id, attempt);
    return attempt;
  }

  private async cancelOnce(id: string, recovering: boolean): Promise<CancelOutcome> {
    const { db, now } = this.deps;
    const source: EventSource = recovering ? "reconciler" : "cli";
    const issued = tx(db, (): { done: CancelOutcome } | { op: OperationRow } => {
      const op = getOperation(db, id);
      if (!op || op.kind !== "cancel") return { done: { ok: false, phase: "failed", evidence: "process", detail: `no cancel ${id}` } };
      if (op.phase !== "requested" && op.phase !== "effect_issued") return { done: outcomeOf(op) };
      // Stopping by identity is idempotent (a gone process is a verified exit), so an interrupted stop is issued again.
      db.query("UPDATE operations SET phase = 'effect_issued', attempts = attempts + 1, issued_at = ?2, updated_at = ?2 WHERE id = ?1").run(id, now());
      const row = getOperation(db, id)!;
      appendEvent(db, { source, kind: "operation.effect_issued", runId: row.run_id, taskId: row.task_id, payload: { operation: id, kind: "cancel", attempt: row.attempts, recovering }, ts: now() });
      return { op: row };
    });
    if ("done" in issued) return issued.done;
    const op = issued.op;
    let exited: Verified;
    try {
      exited = await this.deps.exitRun(op.run_id);
    } catch (error) {
      exited = { ok: false, evidence: "process", detail: (error as Error).message };
    }
    const outcome = tx(db, (): CancelOutcome => {
      const current = getOperation(db, id);
      // Someone else settled it meanwhile (the run ended another way): theirs stands.
      if (!current || current.phase !== "effect_issued" || current.attempts !== op.attempts) return current ? outcomeOf(current) : { ok: false, phase: "failed", evidence: "process", detail: `no cancel ${id}` };
      if (exited.ok) {
        const run = getRun(db, op.run_id);
        confirmOperation(db, current, { detail: run && !isTerminal(run.state) ? `worker stopped (${exited.evidence})` : `run already ${run?.state ?? "gone"}` }, source, now());
        if (run && !isTerminal(run.state)) cancelRun(db, run, op.reason ?? "cancelled", source, now());
        return { ok: true, phase: "confirmed", evidence: exited.evidence };
      }
      const why = `the worker did not exit (${exited.detail ?? exited.evidence})`;
      if (recovering) {
        escalateOperation(db, current, `cancel could not stop the worker: ${why}`, source, now());
        return { ok: false, phase: "escalated", evidence: exited.evidence, detail: why };
      }
      // The detail is the exit's own (a replay's error reads as the live one did).
      failOperation(db, id, exited.detail ?? exited.evidence, source, now());
      return { ok: false, phase: "failed", evidence: exited.evidence, detail: exited.detail ?? exited.evidence };
    });
    if (outcome.ok && this.deps.cancelled) {
      await this.deps.cancelled(op.run_id).catch((error: unknown) => this.deps.log(`cancel ${op.run_id}: after the cancel: ${(error as Error).message}`));
    }
    return outcome;
  }

  /**
   * An open operation the reconciler found with no launcher on it: a cancel is
   * driven (in the background: its stop can take the exit grace); an issued
   * launch or resume is judged against its recorded candidate. A requested
   * one is the reconciler's to launch.
   */
  async recover(run: RunRow, op: OperationRow): Promise<CandidateVerdict | "cancelling" | "requested"> {
    if (op.kind === "cancel") {
      void this.driveCancel(op.id, { recovering: true }).catch((error: unknown) => this.deps.log(`cancel ${op.id}: ${(error as Error).message}`));
      return "cancelling";
    }
    if (op.phase === "requested") return "requested";
    if (this.deps.isLaunching(run.id) || this.checking.has(op.id)) return "busy";
    this.checking.add(op.id);
    try {
      return await this.checkCandidate(run, op);
    } finally {
      this.checking.delete(op.id);
    }
  }

  /**
   * An issued launch or resume with no launcher: what is in its recorded pane
   * now. The run's harness started at or after the launch was issued is the
   * candidate, adopted; nothing there past the launch timeout means the start
   * did not take, so it is issued again (at most MAX_LAUNCH_ISSUES times);
   * anything else escalates. Herdr unsure or away decides nothing.
   */
  private async checkCandidate(run: RunRow, op: OperationRow): Promise<CandidateVerdict> {
    const { db, now } = this.deps;
    const runtime = this.deps.runtime();
    if (!runtime) return "unknown";
    let info: Awaited<ReturnType<HerdrRuntime["processes"]>> = null;
    if (op.pane_id) {
      try {
        info = await runtime.processes(op.pane_id);
      } catch (error) {
        if (error instanceof HerdrError) return "unknown";
        throw error;
      }
    }
    if (info && (info.foregroundGroup === null || info.foregroundGroup === 0)) return "unknown";
    if (info && info.foregroundGroup !== info.shellPid) {
      const leader = info.processes.find((p) => p.pid === info.foregroundGroup);
      const matches = this.deps.matchesHarness(run.harness);
      if (leader && matches?.(leader)) {
        const identity = await readIdentity(leader.pid, this.deps.ps);
        if (!identity) return "unknown";
        if (run.pane_id === op.pane_id && identity.start >= (op.issued_at ?? 0) - START_SLACK_MS) return this.adopt(op, identity);
        return this.escalate(op, `a ${run.harness} process (pid ${leader.pid}) in pane ${op.pane_id} started before the ${op.kind} was issued, or the run moved to another pane; it is not adopted`);
      }
      return this.escalate(op, `pane ${op.pane_id} runs another foreground process (pid ${info.foregroundGroup}${leader ? `, ${leader.name}` : ""}), not the ${run.harness} the ${op.kind} started`);
    }
    // The recorded pane is gone or shows only its shell: within the launch timeout the agent may still be coming up.
    if (now() - (op.issued_at ?? 0) < this.deps.timing().launch_timeout_ms) return "waiting";
    if (op.attempts >= MAX_LAUNCH_ISSUES) return this.escalate(op, `its ${run.harness} never appeared in pane ${op.pane_id ?? "(none)"} after ${op.attempts} issues`);
    const why = `no ${run.harness} in pane ${op.pane_id ?? "(none)"} ${Math.round((now() - (op.issued_at ?? 0)) / 1000)}s after it was issued`;
    return tx(db, () => (reissueOperation(db, op, why, "reconciler", now()) ? "reissued" : stale(db, op, "reissue", now())));
  }

  /** The candidate becomes the run's worker, as the launcher's own identity write would have made it, if the operation is still the one checked. */
  private adopt(op: OperationRow, identity: ProcIdentity): CandidateVerdict {
    const { db, now } = this.deps;
    return tx(db, () => {
      const current = getOperation(db, op.id);
      const run = getRun(db, op.run_id);
      if (!current || current.phase !== "effect_issued" || current.attempts !== op.attempts || !run || isTerminal(run.state)) return stale(db, op, "adopt", now());
      const mode = op.mode ?? "fresh";
      db.query(
        `UPDATE runs SET proc_pid = ?2, proc_start = ?3, proc_exe = ?4, state = CASE WHEN state = 'launching' THEN 'running' ELSE state END,
           pending_launch = CASE WHEN pending_launch = ?7 THEN NULL ELSE pending_launch END,
           stage_note = CASE WHEN ?6 = 1 AND (pending_launch IS NULL OR pending_launch = ?7) THEN NULL ELSE stage_note END, updated_at = ?5 WHERE id = ?1`,
      ).run(run.id, identity.pid, identity.start, identity.exe, now(), mode === "resume" ? 0 : 1, mode);
      confirmOperation(db, current, { identity, detail: `recovered candidate in pane ${op.pane_id}` }, "reconciler", now());
      appendEvent(db, {
        source: "reconciler",
        kind: "run.launched",
        runId: run.id,
        taskId: run.task_id,
        payload: { mode, pane: op.pane_id, pid: identity.pid, exe: identity.exe, operation: op.id, recovered: true },
        ts: now(),
      });
      return "adopted";
    });
  }

  private escalate(op: OperationRow, line: string): CandidateVerdict {
    const { db, now, log } = this.deps;
    return tx(db, () => {
      if (!escalateOperation(db, op, line, "reconciler", now())) return stale(db, op, "escalate", now());
      log(`operation ${op.id} for ${op.run_id} escalated: ${line}`);
      return "escalated";
    });
  }
}

/** A recovery step that found its operation changed under it writes nothing but this event. */
function stale(db: Db, op: OperationRow, step: string, now: number): "stale" {
  const current = getOperation(db, op.id);
  appendEvent(db, {
    source: "reconciler",
    kind: "run.operation_stale",
    runId: op.run_id,
    taskId: op.task_id,
    payload: { operation: op.id, step, seen: { phase: op.phase, attempts: op.attempts }, current: current ? { phase: current.phase, attempts: current.attempts } : null },
    ts: now,
  });
  return "stale";
}

function outcomeOf(op: OperationRow): CancelOutcome {
  if (op.phase === "confirmed") return { ok: true, phase: "confirmed", evidence: "process", detail: op.detail ?? undefined };
  return { ok: false, phase: op.phase, evidence: "process", detail: op.detail ?? op.phase };
}
