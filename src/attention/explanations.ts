import type { Db } from "../db/db.ts";
import { appendEvent, type EventSource } from "../db/events.ts";
import { sanitizeLine } from "../util/sanitize.ts";

/**
 * Wait explanations (docs/notes/2026-10-12-next-steps-md-wz.md): when a rule
 * holds a run on a dialog, refuses it capacity, or resumes it after a death
 * (or refuses to), the rule records why, with the facts it decided on and
 * who or what can end the wait. Only a changed explanation is written, so an
 * unchanged wait seen again on every pass adds nothing. `flowryn show` reads
 * these rows and recomputes nothing from the live state.
 */

export type ExplanationKind = "dialog" | "capacity" | "resume";
/** Who can end a wait: you (your terminal, the worker's pane), the leader, or an event Flowryn acts on by itself. */
export type Actor = "captain" | "leader" | "flowryn";

/** One observation a rule used, and when it was observed (null: its source carries no time). Never a duration. */
export interface Fact {
  name: string;
  value: string;
  at: number | null;
}

export interface Unblock {
  by: Actor;
  action: string;
}

export interface NewExplanation {
  run: { id: string; task_id: string; stage: string };
  kind: ExplanationKind;
  rule: string;
  reason: string;
  facts: Fact[];
  unblock: Unblock[];
  /** The item that carries the same wait: the row closes when it resolves. */
  itemId?: string | null;
  source: EventSource;
  now: number;
  /** A decision that waits for nothing (an automatic resume): recorded closed, with this as closed_by. */
  settled?: string;
}

export interface ExplanationRow {
  id: number;
  run_id: string;
  task_id: string;
  stage: string;
  kind: ExplanationKind;
  rule: string;
  reason: string;
  facts: string;
  unblock: string;
  signature: string;
  item_id: string | null;
  operation: string | null;
  event_seq: number;
  opened_at: number;
  closed_at: number | null;
  closed_by: string | null;
}

const MAX_REASON_CHARS = 160;
const MAX_VALUE_CHARS = 200;

function signatureOf(x: NewExplanation, reason: string, facts: Fact[], unblock: Unblock[]): string {
  // Observation times are left out: the same observation read again is the same explanation.
  return JSON.stringify([x.kind, x.rule, x.run.stage, reason, facts.map((f) => [f.name, f.value]), unblock.map((u) => [u.by, u.action])]);
}

/**
 * Record a decision about a run. Call inside the deciding transaction. When
 * the run already has an open explanation of this kind with the same rule,
 * reason, facts and unblock, no row is written (null), though a new item for
 * the same wait (one opened after a dismissal) takes over its link; a
 * different one is closed as superseded. Returns the new row's id.
 */
export function explain(db: Db, x: NewExplanation): number | null {
  const reason = sanitizeLine(x.reason, MAX_REASON_CHARS);
  const facts = x.facts.map((f) => ({ name: f.name, value: sanitizeLine(f.value, MAX_VALUE_CHARS), at: f.at }));
  const unblock = x.unblock.map((u) => ({ by: u.by, action: sanitizeLine(u.action, MAX_VALUE_CHARS) }));
  const signature = signatureOf(x, reason, facts, unblock);
  const open = db.query("SELECT id, signature, item_id FROM explanations WHERE run_id = ?1 AND kind = ?2 AND closed_at IS NULL ORDER BY id").all(x.run.id, x.kind) as {
    id: number;
    signature: string;
    item_id: string | null;
  }[];
  if (!x.settled && open.length === 1 && open[0]!.signature === signature) {
    if (x.itemId && open[0]!.item_id !== x.itemId) db.query("UPDATE explanations SET item_id = ?2 WHERE id = ?1").run(open[0]!.id, x.itemId);
    return null;
  }
  const event = appendEvent(db, { source: x.source, kind: "run.explained", runId: x.run.id, taskId: x.run.task_id, payload: { kind: x.kind, rule: x.rule }, ts: x.now });
  const result = db
    .query(
      `INSERT INTO explanations (run_id, task_id, stage, kind, rule, reason, facts, unblock, signature, item_id, event_seq, opened_at, closed_at, closed_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
    )
    .run(
      x.run.id,
      x.run.task_id,
      x.run.stage,
      x.kind,
      x.rule,
      reason,
      JSON.stringify(facts),
      JSON.stringify(unblock),
      signature,
      x.itemId ?? null,
      event.seq,
      x.now,
      x.settled ? x.now : null,
      x.settled ?? null,
    );
  const id = Number(result.lastInsertRowid);
  for (const row of open) db.query("UPDATE explanations SET closed_at = ?2, closed_by = ?3 WHERE id = ?1").run(row.id, x.now, `superseded by x${id}`);
  return id;
}

/** Close a run's open explanations of the given kinds (all kinds when null). Call inside the transaction that ends the wait. */
export function closeExplanations(db: Db, runId: string, kinds: readonly ExplanationKind[] | null, by: string, now: number): number {
  if (kinds && kinds.length === 0) return 0;
  const filter = kinds ? `AND kind IN (${kinds.map((_, i) => `?${i + 4}`).join(", ")})` : "";
  return db.query(`UPDATE explanations SET closed_at = ?3, closed_by = ?2 WHERE run_id = ?1 AND closed_at IS NULL ${filter}`).run(runId, by, now, ...(kinds ?? [])).changes;
}

/** Close the open explanations these items carried: they resolved, so the wait ended. Call inside the resolving transaction. */
export function closeItemExplanations(db: Db, itemIds: readonly string[], by: string, now: number): number {
  if (itemIds.length === 0) return 0;
  const list = itemIds.map((_, i) => `?${i + 3}`).join(", ");
  return db.query(`UPDATE explanations SET closed_at = ?2, closed_by = ?1 WHERE closed_at IS NULL AND item_id IN (${list})`).run(by, now, ...itemIds).changes;
}

/**
 * Close what no longer waits: every open explanation of a run that ended, one
 * whose item resolved by any path, one whose item was dismissed and whose
 * condition is gone (a dialog row off `blocked_dialog`, a resume row off
 * `dead`), and one with no item whose run the scheduler no longer considers
 * for a grant (its `candidates()` filter). One event when anything closed. Runs in its own
 * transaction (the scheduler, each pass).
 */
export function sweepExplanations(db: Db, now: number): number {
  const rows = db
    .query(
      `SELECT x.id, CASE
           WHEN r.id IS NULL OR r.state IN ('cleaned','failed','cancelled') THEN 'run ended'
           WHEN i.state = 'resolved' THEN COALESCE(i.resolved_by, 'item resolved')
           WHEN i.state = 'dismissed' THEN 'item dismissed; no longer waiting'
           ELSE 'no longer waiting' END AS why
       FROM explanations x LEFT JOIN runs r ON r.id = x.run_id LEFT JOIN items i ON i.id = x.item_id
       WHERE x.closed_at IS NULL AND (
         r.id IS NULL OR r.state IN ('cleaned','failed','cancelled')
         OR i.state = 'resolved'
         OR (i.state = 'dismissed' AND ((x.kind = 'dialog' AND r.liveness != 'blocked_dialog') OR (x.kind = 'resume' AND r.liveness != 'dead')))
         OR (x.item_id IS NULL AND x.kind IN ('capacity','resume')
             AND NOT ((r.stage_state = 'waiting' OR r.pending_launch IS NOT NULL) AND (r.pending_launch IS NOT NULL OR r.liveness != 'dead'))))`,
    )
    .all() as { id: number; why: string }[];
  for (const row of rows) db.query("UPDATE explanations SET closed_at = ?2, closed_by = ?3 WHERE id = ?1").run(row.id, now, row.why);
  if (rows.length > 0) appendEvent(db, { source: "daemon", kind: "run.explanations_closed", payload: { explanations: rows.map((r) => r.id) }, ts: now });
  return rows.length;
}

export function openExplanations(db: Db, runId: string): ExplanationRow[] {
  return db.query("SELECT * FROM explanations WHERE run_id = ?1 AND closed_at IS NULL ORDER BY id DESC").all(runId) as ExplanationRow[];
}

export function taskExplanations(db: Db, taskId: string): ExplanationRow[] {
  return db.query("SELECT * FROM explanations WHERE task_id = ?1 ORDER BY id").all(taskId) as ExplanationRow[];
}

// --- the views ------------------------------------------------------------------------------

function clock(t: number, seconds = false): string {
  return new Date(t).toTimeString().slice(0, seconds ? 8 : 5);
}

function age(now: number, since: number): string {
  const s = Math.max(0, Math.round((now - since) / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

function factsOf(row: ExplanationRow): Fact[] {
  return JSON.parse(row.facts) as Fact[];
}

function unblockOf(row: ExplanationRow): Unblock[] {
  return JSON.parse(row.unblock) as Unblock[];
}

/** One open explanation as the terse pointer: the reason, since when, and the first thing that ends it. */
export function waitingLine(row: ExplanationRow): string {
  const next = unblockOf(row)[0];
  return `${row.reason} (since ${clock(row.opened_at)})${next ? `; next: ${next.action} (${next.by})` : ""}`;
}

/** `show`'s default `waiting` field: every open explanation, newest first; null when the run waits on nothing recorded. */
export function waitingField(rows: readonly ExplanationRow[]): string | null {
  return rows.length > 0 ? rows.map(waitingLine).join(" | ") : null;
}

function factLine(f: Fact, now: number): string {
  return `${f.name}: ${f.value} (observed ${f.at === null ? "-" : `${clock(f.at, true)}, ${age(now, f.at)} ago`})`;
}

/** `show --why`: an open explanation whole, from its stored facts. */
export function explanationDetail(row: ExplanationRow, now: number): Record<string, unknown> {
  return {
    id: `x${row.id}`,
    kind: row.kind,
    rule: row.rule,
    stage: row.stage,
    reason: row.reason,
    since: `${clock(row.opened_at, true)} (${age(now, row.opened_at)} ago)`,
    facts: factsOf(row).map((f) => factLine(f, now)),
    unblock: unblockOf(row).map((u) => `${u.by}: ${u.action}`),
    operation: row.operation ?? "-",
  };
}

/** `show --timeline`: one line per explanation, in order; with --full each one's facts and unblock too. */
export function timelineEntry(row: ExplanationRow, now: number, full: boolean): string | Record<string, unknown> {
  const end = row.closed_at === null ? "open" : `${row.closed_by ?? "closed"} ${clock(row.closed_at)}`;
  const line = `x${row.id} ${clock(row.opened_at)} ${row.rule} [${row.stage}]: ${row.reason} → ${end}`;
  if (!full) return line;
  return { line, facts: factsOf(row).map((f) => factLine(f, now)), unblock: unblockOf(row).map((u) => `${u.by}: ${u.action}`) };
}
