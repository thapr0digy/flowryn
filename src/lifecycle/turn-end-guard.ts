import type { Db } from "../db/db.ts";
import { appendEvent, type EventSource } from "../db/events.ts";
import { findOpenRunItem } from "../attention/items.ts";
import { TURN_END_REMINDER } from "../harness/contract-text.ts";
import { runningBackgroundJobs } from "./background-jobs.ts";
import { waitingOnOthers } from "./idle-alert.ts";
import type { RunRow } from "./runs.ts";

/**
 * The turn-end guard (autonomy spec 2, ship A). A worker whose turn ends with
 * no outcome since its last instruction, and nothing it waits on, gets one
 * fixed reminder per episode: a Claude Stop continuation, a Pi follow-up. A
 * second outcome-less turn end in the same episode gets none; the worker_idle
 * pointer then says it ignored the reminder. Deterministic: database reads and
 * a fixed string. Each reminder and its result are events, so how often one
 * is obeyed can be counted (docs/m5-notes.md, "Turn-end guard"). A worker that
 * ends its turn to wait on its own background job, or because the leader's
 * steer said to (steer --end-turn), is waiting, not stuck: no reminder.
 */

/** What a worker records when it finishes or hands a turn over: stage done or begin, deliver, ask, report (any status), fail. */
export const OUTCOME_KINDS = ["stage.done", "stage.requested", "stage.delivered", "run.delivered", "decision.opened", "worker.report", "worker.failed"] as const;

export const WAIT_BACKGROUND = "its own background job";
export const WAIT_END_TURN = "the leader said end the turn";

export const REMINDER_KIND = "run.turn_end_reminder";
export const RESULT_KIND = "run.turn_end_reminder_result";

const OUTCOME_SQL = OUTCOME_KINDS.map((k) => `'${k}'`).join(",");

/**
 * When the worker was last told what to do: it started or resumed, its stage
 * started, or a steer was carried to it. An episode runs from there to the next.
 */
export function instructionAt(db: Db, run: RunRow): number {
  const carried = db.query("SELECT MAX(carried_at) AS at FROM messages WHERE run_id = ?1").get(run.id) as { at: number | null };
  return Math.max(run.started_at, run.worker_started_at ?? 0, run.stage_started_at ?? 0, carried.at ?? 0);
}

/** The latest outcome event of the run after `afterSeq`, or at or after `since` (ms), or null. */
function outcomeSince(db: Db, runId: string, since: { seq?: number; ts?: number }): string | null {
  const row = db
    .query(`SELECT kind FROM events WHERE run_id = ?1 AND kind IN (${OUTCOME_SQL}) AND seq > ?2 AND ts >= ?3 ORDER BY seq DESC LIMIT 1`)
    .get(runId, since.seq ?? 0, since.ts ?? 0) as { kind: string } | null;
  return row?.kind ?? null;
}

/** The episode's instruction is a steer the leader sent with --end-turn: it told the worker to end its turn. */
function toldToEndTurn(db: Db, run: RunRow): boolean {
  const latest = db
    .query("SELECT carried_at, end_turn FROM messages WHERE run_id = ?1 AND carried_at IS NOT NULL ORDER BY carried_at DESC, created_at DESC LIMIT 1")
    .get(run.id) as { carried_at: number; end_turn: number } | null;
  return latest !== null && latest.end_turn === 1 && latest.carried_at >= instructionAt(db, run);
}

/**
 * Why the worker may rightly sit idle: the run is past running (validating,
 * ready, merging), or it waits on a grant, a gate, a question, a launch, a
 * permission dialog or its own background job, or the leader told it to end
 * its turn. Null when nothing holds it. Call inside the transaction: it
 * records background jobs the transcript shows ended, as `source` (the
 * turn-end guard's hook, or the reconciler's stale-hook pointer).
 */
export function pendingWait(db: Db, run: RunRow, now: number, source: EventSource): string | null {
  if (run.state !== "running") return `run ${run.state}`;
  if (run.stage_state !== "active") return `stage ${run.stage_state}`;
  if (run.pending_launch !== null) return `pending launch ${run.pending_launch}`;
  if (waitingOnOthers(db, run)) return "an open question";
  if (findOpenRunItem(db, "blocked_prompt", run.id)) return "a permission dialog";
  if (toldToEndTurn(db, run)) return WAIT_END_TURN;
  if (runningBackgroundJobs(db, run, now, source).length > 0) return WAIT_BACKGROUND;
  return null;
}

interface ReminderEvent {
  seq: number;
  ts: number;
  kind: string;
}

/** The run's latest reminder or result event. */
function latestReminderEvent(db: Db, runId: string): ReminderEvent | null {
  return db
    .query("SELECT seq, ts, kind FROM events WHERE run_id = ?1 AND kind IN (?2, ?3) ORDER BY seq DESC LIMIT 1")
    .get(runId, REMINDER_KIND, RESULT_KIND) as ReminderEvent | null;
}

function remindedThisEpisode(db: Db, runId: string, episodeFrom: number): boolean {
  return db.query("SELECT 1 FROM events WHERE run_id = ?1 AND kind = ?2 AND ts >= ?3").get(runId, REMINDER_KIND, episodeFrom) !== null;
}

/**
 * Settle the run's last reminder at the next turn end: obeyed when an outcome
 * or a wait followed it, ignored otherwise. Call inside the transaction.
 */
function settleReminder(db: Db, run: RunRow, now: number): void {
  const last = latestReminderEvent(db, run.id);
  if (!last || last.kind !== REMINDER_KIND) return;
  const outcome = outcomeSince(db, run.id, { seq: last.seq });
  const wait = outcome ? null : pendingWait(db, run, now, "hook");
  appendEvent(db, {
    source: "hook",
    kind: RESULT_KIND,
    runId: run.id,
    taskId: run.task_id,
    payload: { reminder_seq: last.seq, obeyed: outcome !== null || wait !== null, outcome: outcome ?? wait },
    ts: now,
  });
}

export interface TurnEnd {
  harness: "claude" | "pi";
  /**
   * Claude's stop_hook_active, recorded only: a turn the asyncRewake waiter
   * woke reads true (spike c14), so it cannot gate the guard. The episode
   * record and the continuation cap are what keep it from looping.
   */
  stopHookActive: boolean;
  /** Stop continuations Flowryn already gave this turn (steers or a reminder). */
  continuationsUsed: number;
  maxContinuations: number;
  /** A steer is due: it wins over the guard. */
  steerDue: boolean;
}

/**
 * A worker's turn ended with no steer taken: settle the last reminder, then
 * return the reminder text when this turn end earns one, or null. Call inside
 * the transaction.
 */
export function guardTurnEnd(db: Db, run: RunRow, turn: TurnEnd, now: number): string | null {
  settleReminder(db, run, now);
  if (turn.steerDue) return null;
  if (turn.continuationsUsed >= turn.maxContinuations) return null;
  if (pendingWait(db, run, now, "hook") !== null) return null;
  const episodeFrom = instructionAt(db, run);
  if (outcomeSince(db, run.id, { ts: episodeFrom }) !== null) return null;
  if (remindedThisEpisode(db, run.id, episodeFrom)) return null;
  appendEvent(db, {
    source: "hook",
    kind: REMINDER_KIND,
    runId: run.id,
    taskId: run.task_id,
    payload: { episode_from: episodeFrom, harness: turn.harness, stop_hook_active: turn.stopHookActive },
    ts: now,
  });
  return TURN_END_REMINDER;
}

/** Did the worker ignore this episode's reminder (the worker_idle pointer says so)? */
export function reminderIgnored(db: Db, run: RunRow): boolean {
  const last = db
    .query("SELECT ts, payload FROM events WHERE run_id = ?1 AND kind = ?2 ORDER BY seq DESC LIMIT 1")
    .get(run.id, RESULT_KIND) as { ts: number; payload: string } | null;
  if (!last || last.ts < instructionAt(db, run)) return false;
  return (JSON.parse(last.payload) as { obeyed?: boolean }).obeyed === false;
}
