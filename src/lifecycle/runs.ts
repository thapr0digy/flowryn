import type { Db } from "../db/db.ts";
import { appendEvent, type EventSource } from "../db/events.ts";
import { findOpenRunItem, openItem, resolveRunItems, type ItemKind } from "../attention/items.ts";
import { recordIntent } from "../journal/journal.ts";
import { readSnapshot } from "../journal/snapshot.ts";
import { normalizedTitle } from "../journal/diff.ts";
import { sanitizeLine } from "../util/sanitize.ts";

/** Design section 13: runs.state, owned by the lifecycle engine. */
export const RUN_STATES = ["launching", "running", "validating", "ready", "merging", "landed", "cleaned", "failed", "cancelled"] as const;
export type RunState = (typeof RUN_STATES)[number];
export const TERMINAL_STATES: readonly RunState[] = ["cleaned", "failed", "cancelled"];

/** Design section 6: runs.liveness, owned by the reconciler. */
export const LIVENESS = ["starting", "busy", "idle", "blocked_dialog", "dead", "orphaned", "unknown"] as const;
export type Liveness = (typeof LIVENESS)[number];

export interface RunRow {
  id: string;
  task_id: string;
  harness: "claude" | "pi";
  harness_version: string;
  model: string | null;
  effort: string | null;
  state: RunState;
  liveness: Liveness;
  workflow: string;
  stage: string;
  herdr_session: string | null;
  pane_id: string | null;
  agent_session: string | null;
  worktree_path: string;
  branch: string;
  base_sha: string;
  proc_pid: number | null;
  proc_start: number | null;
  proc_exe: string | null;
  token_hash: string;
  resume_count: number;
  started_at: number;
  ended_at: number | null;
  updated_at: number;
  workspace_id: string | null;
  busy_until: number | null;
  last_hook_at: number | null;
  idle_since: number | null;
  worker_started_at: number | null;
  launched_at: number | null;
  transcript_path: string | null;
}

export interface RunWithPolicy extends RunRow {
  project_id: string;
  kind: "ship" | "scout";
  delivery_mode: string;
  sensitive: number;
}

const OPEN_FILTER = "state NOT IN ('cleaned','failed','cancelled')";

export function isTerminal(state: RunState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function getRun(db: Db, id: string): RunRow | null {
  return db.query("SELECT * FROM runs WHERE id = ?1").get(id) as RunRow | null;
}

export function getRunWithPolicy(db: Db, id: string): RunWithPolicy | null {
  return db
    .query("SELECT r.*, p.project_id, p.kind, p.delivery_mode, p.sensitive FROM runs r JOIN task_policy p ON p.task_id = r.task_id WHERE r.id = ?1")
    .get(id) as RunWithPolicy | null;
}

export function openRuns(db: Db): RunRow[] {
  return db.query(`SELECT * FROM runs WHERE ${OPEN_FILTER} ORDER BY started_at`).all() as RunRow[];
}

export function openRunForTask(db: Db, taskId: string): RunRow | null {
  return db.query(`SELECT * FROM runs WHERE task_id = ?1 AND ${OPEN_FILTER}`).get(taskId) as RunRow | null;
}

/** A run named by its id, or the open (else latest) run of a task id. */
export function findRun(db: Db, ref: string): RunRow | null {
  const byId = getRun(db, ref);
  if (byId) return byId;
  return (
    openRunForTask(db, ref) ?? (db.query("SELECT * FROM runs WHERE task_id = ?1 ORDER BY started_at DESC LIMIT 1").get(ref) as RunRow | null)
  );
}

/** The task's title as the backlog snapshot has it, else the id. */
export function taskTitle(db: Db, taskId: string): string {
  const task = readSnapshot(db, "backlog")?.tasks.find((t) => t.id === taskId);
  return task ? normalizedTitle(task) : taskId;
}

/** Latest observation per source (design section 13, run_evidence). */
export function recordEvidence(db: Db, runId: string, source: string, rank: number, value: unknown, now: number): void {
  db.query(
    `INSERT INTO run_evidence (run_id, source, rank, value, observed_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(run_id, source) DO UPDATE SET rank = excluded.rank, value = excluded.value, observed_at = excluded.observed_at`,
  ).run(runId, source, rank, JSON.stringify(value), now);
}

/** The reconciler's write: liveness, with an event only when it changes. Call inside a transaction. */
export function setLiveness(db: Db, run: RunRow, liveness: Liveness, source: EventSource, detail: Record<string, unknown>, now: number): boolean {
  if (run.liveness === liveness) return false;
  db.query("UPDATE runs SET liveness = ?2, updated_at = ?3 WHERE id = ?1").run(run.id, liveness, now);
  appendEvent(db, { source, kind: "run.liveness", runId: run.id, taskId: run.task_id, payload: { from: run.liveness, to: liveness, ...detail }, ts: now });
  run.liveness = liveness;
  return true;
}

/** tasks-axi hold reasons are one line with no parentheses. */
export function holdReason(text: string): string {
  const cleaned = sanitizeLine(text, 150).replace(/[()]/g, "").trim();
  return cleaned.length > 0 ? cleaned : "flowryn";
}

/** Put the task back in Queued with a parked hold (design section 8; M0 t02: reopen, then hold). */
function parkTask(db: Db, taskId: string, reason: string, now: number): void {
  recordIntent(db, { file: "backlog", verb: "reopen", taskId, positional: [taskId], now });
  recordIntent(db, { file: "backlog", verb: "hold", taskId, positional: [taskId], flags: { reason: holdReason(reason), kind: "parked" }, now });
}

/** Open an item unless the run already has an open one of that kind. Returns the item id. */
export function openRunItemOnce(db: Db, kind: ItemKind, run: RunRow, eventSeq: number, line: string, now: number): string | null {
  if (findOpenRunItem(db, kind, run.id)) return null;
  return openItem(db, { kind, eventSeq, line, taskId: run.task_id, runId: run.id, now });
}

/**
 * A run that needs you: failed with the process gone or refused (isolation,
 * launch, second death). The task goes back to Queued, parked. Call inside a
 * transaction.
 */
export function failRun(db: Db, run: RunRow, reason: string, source: EventSource, now: number): void {
  if (isTerminal(run.state)) return;
  db.query("UPDATE runs SET state = 'failed', liveness = 'dead', ended_at = ?2, updated_at = ?2, busy_until = NULL WHERE id = ?1").run(run.id, now);
  parkTask(db, run.task_id, `failed: ${reason}`, now);
  const event = appendEvent(db, { source, kind: "run.failed", runId: run.id, taskId: run.task_id, payload: { reason, from: run.state }, ts: now });
  resolveRunItems(db, run.id, ["worker_idle", "trust_dialog", "steer_unacked"], "run.failed", now);
  openRunItemOnce(db, "failure_needs_you", run, event.seq, `Run failed for ${taskTitle(db, run.task_id)}: ${reason}`, now);
  run.state = "failed";
  run.liveness = "dead";
}

/** Cancelled with your consent (design section 8). Call inside a transaction. */
export function cancelRun(db: Db, run: RunRow, reason: string, source: EventSource, now: number): void {
  if (isTerminal(run.state)) return;
  db.query("UPDATE runs SET state = 'cancelled', liveness = 'dead', ended_at = ?2, updated_at = ?2, busy_until = NULL WHERE id = ?1").run(run.id, now);
  parkTask(db, run.task_id, `cancelled: ${reason}`, now);
  appendEvent(db, { source, kind: "run.cancelled", runId: run.id, taskId: run.task_id, payload: { reason, from: run.state }, ts: now });
  resolveRunItems(db, run.id, null, "run.cancelled", now);
  run.state = "cancelled";
  run.liveness = "dead";
}
