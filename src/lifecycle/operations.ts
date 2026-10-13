import type { Db } from "../db/db.ts";
import { appendEvent, type EventSource } from "../db/events.ts";
import { openItem } from "../attention/items.ts";
import { sanitizeLine } from "../util/sanitize.ts";
import { ulid } from "../util/ulid.ts";
import type { PendingLaunch } from "./runs.ts";

/**
 * Lifecycle operations (docs/notes/2026-10-13-next-steps-md-rz.md): the launch,
 * resume or cancel Flowryn was asked for, and the phase it reached. An effect
 * (Herdr's agent.start, a signal to the worker) is issued only by the
 * compare-and-set requested → effect_issued, committed with its candidate
 * before the effect; recovery works from that record, not from the last
 * observed worker. Every function here runs inside the caller's transaction.
 */

export type OperationKind = "launch" | "resume" | "cancel";
export type OperationPhase = "requested" | "effect_issued" | "confirmed" | "failed" | "escalated";
export type OperationMode = PendingLaunch;

export interface OperationRow {
  id: string;
  run_id: string;
  task_id: string;
  kind: OperationKind;
  mode: OperationMode | null;
  generation: number;
  desired: "worker_running" | "run_cancelled";
  phase: OperationPhase;
  requested_by: string;
  reason: string | null;
  pane_id: string | null;
  agent_name: string | null;
  issued_at: number | null;
  attempts: number;
  proc_pid: number | null;
  proc_start: number | null;
  detail: string | null;
  item_id: string | null;
  created_at: number;
  updated_at: number;
  settled_at: number | null;
}

/** How many times a launch whose agent never appeared is issued again before it escalates. */
export const MAX_LAUNCH_ISSUES = 3;

const OPEN = "phase IN ('requested','effect_issued')";

interface RunRef {
  id: string;
  task_id: string;
}

export function getOperation(db: Db, id: string): OperationRow | null {
  return db.query("SELECT * FROM operations WHERE id = ?1").get(id) as OperationRow | null;
}

/** The run's open operation (requested or effect_issued): there is at most one. */
export function openOperation(db: Db, runId: string): OperationRow | null {
  return db.query(`SELECT * FROM operations WHERE run_id = ?1 AND ${OPEN}`).get(runId) as OperationRow | null;
}

/** The run's newest operation of any phase. */
export function latestOperation(db: Db, runId: string): OperationRow | null {
  return db.query("SELECT * FROM operations WHERE run_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1").get(runId) as OperationRow | null;
}

export function launchKind(mode: OperationMode): "launch" | "resume" {
  return mode === "resume" ? "resume" : "launch";
}

function nextGeneration(db: Db, runId: string): number {
  const row = db.query("SELECT MAX(generation) AS g FROM operations WHERE run_id = ?1 AND kind IN ('launch','resume')").get(runId) as { g: number | null };
  return (row.g ?? 0) + 1;
}

function confirmedGeneration(db: Db, runId: string): number {
  const row = db.query("SELECT MAX(generation) AS g FROM operations WHERE run_id = ?1 AND kind IN ('launch','resume') AND phase = 'confirmed'").get(runId) as { g: number | null };
  return row.g ?? 0;
}

function event(db: Db, op: Pick<OperationRow, "id" | "run_id" | "task_id" | "kind">, phase: string, source: EventSource, now: number, extra: Record<string, unknown> = {}): void {
  appendEvent(db, { source, kind: `operation.${phase}`, runId: op.run_id, taskId: op.task_id, payload: { operation: op.id, kind: op.kind, ...extra }, ts: now });
}

export interface NewOperation {
  /** The request's own ULID (a CLI call's idempotency key); minted when absent. */
  id?: string;
  run: RunRef;
  kind: OperationKind;
  mode?: OperationMode | null;
  requestedBy: string;
  reason?: string | null;
  source: EventSource;
  now: number;
  /** Open it already issued, with this candidate (a launch interrupted before operations were recorded). */
  issued?: { paneId: string | null; issuedAt: number; detail: string };
}

/** Open an operation in `requested` (or `effect_issued` for a recovered one). The caller has checked the run has no open one. */
export function requestOperation(db: Db, x: NewOperation): OperationRow {
  const id = x.id ?? ulid();
  const generation = x.kind === "cancel" ? confirmedGeneration(db, x.run.id) : nextGeneration(db, x.run.id);
  const phase: OperationPhase = x.issued ? "effect_issued" : "requested";
  db.query(
    `INSERT INTO operations (id, run_id, task_id, kind, mode, generation, desired, phase, requested_by, reason, pane_id, issued_at, attempts, detail, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)`,
  ).run(
    id,
    x.run.id,
    x.run.task_id,
    x.kind,
    x.mode ?? null,
    generation,
    x.kind === "cancel" ? "run_cancelled" : "worker_running",
    phase,
    x.requestedBy,
    x.reason ? sanitizeLine(x.reason, 150) : null,
    x.issued?.paneId ?? null,
    x.issued?.issuedAt ?? null,
    x.issued ? 1 : 0,
    x.issued ? sanitizeLine(x.issued.detail, 200) : null,
    x.now,
  );
  const op = getOperation(db, id)!;
  event(db, op, phase === "requested" ? "requested" : "effect_issued", x.source, x.now, { mode: op.mode, generation, by: x.requestedBy, ...(x.issued ? { recovered: true } : {}) });
  return op;
}

/**
 * The open requested launch or resume a grant or a launcher call goes on with,
 * opening one when the run has none. Null when the run's open operation is a
 * cancel or an issued launch: recovery owns those, so nothing starts.
 */
export function ensureLaunchOperation(db: Db, run: RunRef, mode: OperationMode, requestedBy: string, source: EventSource, now: number): OperationRow | null {
  const open = openOperation(db, run.id);
  if (open) return open.kind !== "cancel" && open.phase === "requested" ? open : null;
  return requestOperation(db, { run, kind: launchKind(mode), mode, requestedBy, source, now });
}

/** requested → effect_issued, with the candidate the effect is about to target. False when someone else issued it or it ended. */
export function claimOperation(db: Db, id: string, candidate: { paneId: string | null; agentName: string | null }, source: EventSource, now: number): OperationRow | null {
  const updated = db
    .query(`UPDATE operations SET phase = 'effect_issued', pane_id = ?2, agent_name = ?3, issued_at = ?4, attempts = attempts + 1, updated_at = ?4 WHERE id = ?1 AND phase = 'requested'`)
    .run(id, candidate.paneId, candidate.agentName, now);
  if (updated.changes === 0) return null;
  const op = getOperation(db, id)!;
  event(db, op, "effect_issued", source, now, { pane: candidate.paneId, agent: candidate.agentName, attempt: op.attempts });
  return op;
}

/** An issued operation's effect is confirmed. Only from `effect_issued` at the attempt the confirmer issued (or saw), so a stale confirmation commits nothing. */
export function confirmOperation(
  db: Db,
  op: Pick<OperationRow, "id" | "attempts">,
  outcome: { identity?: { pid: number; start: number } | null; detail: string },
  source: EventSource,
  now: number,
): boolean {
  const updated = db
    .query(
      `UPDATE operations SET phase = 'confirmed', proc_pid = ?3, proc_start = ?4, detail = ?5, settled_at = ?6, updated_at = ?6 WHERE id = ?1 AND phase = 'effect_issued' AND attempts = ?2`,
    )
    .run(op.id, op.attempts, outcome.identity?.pid ?? null, outcome.identity?.start ?? null, sanitizeLine(outcome.detail, 200), now);
  if (updated.changes === 0) return false;
  const row = getOperation(db, op.id)!;
  event(db, row, "confirmed", source, now, { detail: row.detail, ...(outcome.identity ? { pid: outcome.identity.pid } : {}) });
  return true;
}

/** End an open operation `failed`. False when it was no longer open. */
export function failOperation(db: Db, id: string, detail: string, source: EventSource, now: number): boolean {
  const updated = db.query(`UPDATE operations SET phase = 'failed', detail = ?2, settled_at = ?3, updated_at = ?3 WHERE id = ?1 AND ${OPEN}`).run(id, sanitizeLine(detail, 200), now);
  if (updated.changes === 0) return false;
  event(db, getOperation(db, id)!, "failed", source, now, { detail: sanitizeLine(detail, 200) });
  return true;
}

/**
 * The run ended (failed or cancelled): its open operation ends with it. An open
 * cancel is confirmed when the run was cancelled (the outcome it asked for);
 * anything else fails.
 */
export function endRunOperations(db: Db, runId: string, ended: "failed" | "cancelled", source: EventSource, now: number): void {
  const open = openOperation(db, runId);
  if (!open) return;
  if (open.kind === "cancel" && ended === "cancelled") {
    db.query("UPDATE operations SET phase = 'confirmed', detail = 'run cancelled', settled_at = ?2, updated_at = ?2 WHERE id = ?1").run(open.id, now);
    event(db, open, "confirmed", source, now, { detail: "run cancelled" });
    return;
  }
  failOperation(db, open.id, `run ${ended}`, source, now);
}

/** An issued launch whose agent never appeared goes back to `requested`, to be issued again under the same id. */
export function reissueOperation(db: Db, op: Pick<OperationRow, "id" | "attempts">, why: string, source: EventSource, now: number): boolean {
  const updated = db.query("UPDATE operations SET phase = 'requested', detail = ?3, updated_at = ?4 WHERE id = ?1 AND phase = 'effect_issued' AND attempts = ?2").run(op.id, op.attempts, sanitizeLine(why, 200), now);
  if (updated.changes === 0) return false;
  event(db, getOperation(db, op.id)!, "reissued", source, now, { detail: sanitizeLine(why, 200), attempts: op.attempts });
  return true;
}

/** Recovery cannot decide: the operation escalates with one P1, and nothing more happens to the run by itself. Returns the item id, or null when it was no longer open. */
export function escalateOperation(db: Db, op: Pick<OperationRow, "id" | "attempts">, line: string, source: EventSource, now: number): string | null {
  const detail = sanitizeLine(line, 200);
  const updated = db.query(`UPDATE operations SET phase = 'escalated', detail = ?3, settled_at = ?4, updated_at = ?4 WHERE id = ?1 AND ${OPEN} AND attempts = ?2`).run(op.id, op.attempts, detail, now);
  if (updated.changes === 0) return null;
  const row = getOperation(db, op.id)!;
  const seq = appendEvent(db, { source, kind: "operation.escalated", runId: row.run_id, taskId: row.task_id, payload: { operation: row.id, kind: row.kind, detail }, ts: now }).seq;
  const item = openItem(db, {
    kind: "operation_escalated",
    eventSeq: seq,
    taskId: row.task_id,
    runId: row.run_id,
    line: `${row.task_id}: the ${row.kind} ${row.id} needs you: ${detail}; flowryn show ${row.task_id}, then flowryn cancel ${row.task_id} or dismiss`,
    now,
  });
  db.query("UPDATE operations SET item_id = ?2 WHERE id = ?1").run(row.id, item);
  return item;
}

/** One line for `show`: `<id> <kind> <phase>`, with the mode and attempt where they say something. */
export function operationLine(op: OperationRow): string {
  const mode = op.mode && op.mode !== op.kind ? ` (${op.mode})` : "";
  const attempts = op.attempts > 1 ? `, ${op.attempts} issues` : "";
  const detail = op.phase === "escalated" || op.phase === "failed" ? `: ${op.detail ?? ""}` : "";
  return `${op.id} ${op.kind}${mode} ${op.phase}, generation ${op.generation}${attempts}${detail}`;
}

/**
 * `flowryn cancel`'s intent, committed before the worker is stopped: the run's
 * open cancel when it has one (the same request again, or another for the same
 * end), else a new one, which ends a launch or resume still open (`superseded`).
 */
export function requestCancel(db: Db, run: RunRef, x: { id: string; by: string; reason: string; source: EventSource; now: number }): OperationRow {
  const open = openOperation(db, run.id);
  if (open?.kind === "cancel") return open;
  if (open) failOperation(db, open.id, `superseded by cancel ${x.id}`, x.source, x.now);
  return requestOperation(db, { id: x.id, run, kind: "cancel", requestedBy: x.by, reason: x.reason, source: x.source, now: x.now });
}
