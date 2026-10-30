import { closeItemExplanations } from "../attention/explanations.ts";
import { openItem } from "../attention/items.ts";
import type { Db } from "../db/db.ts";
import { appendEvent, type EventSource } from "../db/events.ts";
import type { HarnessId } from "../harness/types.ts";
import { firstSentence } from "./harness.ts";

/**
 * Asks (docs/notes/2026-10-30-ask-a-lightweight-4v.md): one row each, its own id `a<N>`. Every
 * change appends an event in its transaction; the callers hold it.
 *
 *   queued → running → answered | promoted | failed
 *   queued | running → cancelled (drop)
 *   running → queued (a daemon restart, once)
 */

export const ASK_STATES = ["queued", "running", "answered", "promoted", "failed", "cancelled"] as const;
export type AskState = (typeof ASK_STATES)[number];
export const ASK_ID = /^a\d+$/;

/** A model call that a daemon stop cut short runs again this many times in all. */
export const MAX_ASK_ATTEMPTS = 2;

export interface AskRow {
  id: string;
  project_id: string;
  title: string;
  question: string;
  harness: HarnessId;
  account: string;
  model_pin: string | null;
  effort_pin: string | null;
  max_usd: number;
  no_promote: number;
  state: AskState;
  attempts: number;
  created_by: string;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  cost_usd: number | null;
  answer: string | null;
  answer_path: string | null;
  reason: string | null;
  promoted_task: string | null;
}

export function getAsk(db: Db, id: string): AskRow | null {
  return db.query("SELECT * FROM asks WHERE id = ?1").get(id) as AskRow | null;
}

export function isOpenAsk(ask: Pick<AskRow, "state">): boolean {
  return ask.state === "queued" || ask.state === "running";
}

/** Queued asks, oldest first. */
export function queuedAsks(db: Db): AskRow[] {
  return db.query("SELECT * FROM asks WHERE state = 'queued' ORDER BY created_at, id").all() as AskRow[];
}

export function runningAsks(db: Db): AskRow[] {
  return db.query("SELECT * FROM asks WHERE state = 'running' ORDER BY started_at, id").all() as AskRow[];
}

function nextAskId(db: Db): string {
  const row = db.query("SELECT MAX(CAST(substr(id, 2) AS INTEGER)) AS n FROM asks").get() as { n: number | null };
  return `a${(row.n ?? 0) + 1}`;
}

export interface NewAsk {
  projectId: string;
  title: string;
  question: string;
  harness: HarnessId;
  account: string;
  model: string | null;
  effort: string | null;
  maxUsd: number;
  noPromote: boolean;
  by: string;
  now: number;
}

/** Queue a new ask. Call inside a transaction. */
export function insertAsk(db: Db, a: NewAsk): AskRow {
  const id = nextAskId(db);
  db.query(
    `INSERT INTO asks (id, project_id, title, question, harness, account, model_pin, effort_pin, max_usd, no_promote, state, created_by, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'queued', ?11, ?12)`,
  ).run(id, a.projectId, a.title, a.question, a.harness, a.account, a.model, a.effort, a.maxUsd, a.noPromote ? 1 : 0, a.by, a.now);
  appendEvent(db, {
    source: "cli",
    kind: "ask.queued",
    taskId: id,
    payload: { project: a.projectId, title: a.title, harness: a.harness, account: a.account, model: a.model, effort: a.effort, max_usd: a.maxUsd, no_promote: a.noPromote, by: a.by },
    ts: a.now,
  });
  return getAsk(db, id)!;
}

/** Take a queued ask for a model call; false when it is no longer queued. Call inside a transaction. */
export function markStarted(db: Db, id: string, now: number): boolean {
  const changed = db.query("UPDATE asks SET state = 'running', attempts = attempts + 1, started_at = ?2 WHERE id = ?1 AND state = 'queued'").run(id, now).changes;
  if (changed === 0) return false;
  const ask = getAsk(db, id)!;
  appendEvent(db, { source: "daemon", kind: "ask.started", taskId: id, payload: { attempt: ask.attempts, harness: ask.harness, account: ask.account }, ts: now });
  return true;
}

export interface Answer {
  text: string;
  path: string | null;
  costUsd: number | null;
}

/** A running ask answered: the answer is stored and its digest item opens. Call inside a transaction. */
export function recordAnswer(db: Db, id: string, answer: Answer, now: number): boolean {
  const changed = db
    .query("UPDATE asks SET state = 'answered', ended_at = ?2, cost_usd = ?3, answer = ?4, answer_path = ?5 WHERE id = ?1 AND state = 'running'")
    .run(id, now, answer.costUsd, answer.text, answer.path).changes;
  if (changed === 0) return false;
  const ask = getAsk(db, id)!;
  const event = appendEvent(db, { source: "daemon", kind: "ask.answered", taskId: id, payload: { cost_usd: answer.costUsd, bytes: Buffer.byteLength(answer.text), cut: answer.path !== null }, ts: now });
  openItem(db, { kind: "answer_ready", eventSeq: event.seq, taskId: id, line: `Answer (${ask.project_id}): ${firstSentence(answer.text) || "(empty)"}; flowryn show ${id}`, now });
  return true;
}

/** A running (or answered, by hand) ask became a scout task. Call inside a transaction. */
export function recordPromoted(db: Db, id: string, update: { task: string; run: string; reason: string; costUsd?: number | null; by: string; source: EventSource }, now: number): void {
  db.query("UPDATE asks SET state = 'promoted', ended_at = COALESCE(ended_at, ?2), cost_usd = COALESCE(?3, cost_usd), reason = ?4, promoted_task = ?5 WHERE id = ?1").run(id, now, update.costUsd ?? null, update.reason, update.task);
  appendEvent(db, { source: update.source, kind: "ask.promoted", taskId: id, runId: update.run, payload: { task: update.task, reason: update.reason, by: update.by }, ts: now });
  resolveAskItems(db, id, "ask.promoted", now);
}

/** A running ask ended without an answer; its item says why and what to do. Call inside a transaction. */
export function recordFailed(db: Db, id: string, failure: { reason: string; costUsd: number | null; hint: string }, now: number): boolean {
  const changed = db.query("UPDATE asks SET state = 'failed', ended_at = ?2, cost_usd = ?3, reason = ?4 WHERE id = ?1 AND state = 'running'").run(id, now, failure.costUsd, failure.reason).changes;
  if (changed === 0) return false;
  const ask = getAsk(db, id)!;
  const event = appendEvent(db, { source: "daemon", kind: "ask.failed", taskId: id, payload: { reason: failure.reason, cost_usd: failure.costUsd }, ts: now });
  openItem(db, { kind: "ask_failed", eventSeq: event.seq, taskId: id, line: `Ask ${id} (${ask.project_id}) failed: ${failure.reason}; ${failure.hint}`, now });
  return true;
}

/** A queued or running ask cancelled (drop); false when it had already ended. Call inside a transaction. */
export function recordCancelled(db: Db, id: string, drop: { reason: string; by: string }, now: number): boolean {
  const before = getAsk(db, id);
  const changed = db.query("UPDATE asks SET state = 'cancelled', ended_at = ?2, reason = ?3 WHERE id = ?1 AND state IN ('queued','running')").run(id, now, `dropped: ${drop.reason}`).changes;
  if (changed === 0) return false;
  appendEvent(db, { source: "cli", kind: "ask.cancelled", taskId: id, payload: { was: before?.state ?? null, reason: drop.reason, by: drop.by }, ts: now });
  resolveAskItems(db, id, "ask.cancelled", now);
  return true;
}

/** A running ask that a daemon stop cut short: queued again once, else failed. Call inside a transaction. */
export function recoverInterrupted(db: Db, ask: AskRow, now: number): "requeued" | "failed" {
  if (ask.attempts < MAX_ASK_ATTEMPTS) {
    db.query("UPDATE asks SET state = 'queued', started_at = NULL WHERE id = ?1 AND state = 'running'").run(ask.id);
    appendEvent(db, { source: "daemon", kind: "ask.requeued", taskId: ask.id, payload: { attempt: ask.attempts, reason: "the daemon stopped mid-call" }, ts: now });
    return "requeued";
  }
  recordFailed(db, ask.id, { reason: `the daemon stopped mid-call ${ask.attempts} times`, costUsd: null, hint: `dispatch it again, or flowryn promote ${ask.id}` }, now);
  return "failed";
}

/** Close an ask's open items. */
export function resolveAskItems(db: Db, id: string, by: string, now: number): number {
  const resolved = db
    .query("UPDATE items SET state = 'resolved', resolved_by = ?2, resolved_at = ?3 WHERE task_id = ?1 AND kind IN ('answer_ready','ask_failed') AND state IN ('open','presented') RETURNING id")
    .all(id, by, now) as { id: string }[];
  closeItemExplanations(db, resolved.map((r) => r.id), by, now);
  return resolved.length;
}
