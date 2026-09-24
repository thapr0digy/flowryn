import type { Db } from "../db/db.ts";
import { getMeta, setMeta } from "../db/db.ts";
import { sanitizeLine } from "../util/sanitize.ts";

export type Lane = "P0" | "P1" | "P2";
export type ItemClass = "actionable" | "info";

/**
 * The lane table (design section 9): an event kind decides lane and class.
 * Nothing scores items; project priority and due date only order within a lane.
 * M1 opened the backlog kinds, M2 the worker and run kinds, M3 the overdue
 * to-dos, M4 the delivery kinds (PR checks red, PR closed, cleanup refused,
 * no-mistakes unreachable), M5 the workflow kinds (a review gate ready, work
 * waiting over 30 min for capacity, Docker containers left without a lease, a
 * ready phase that cannot start, the Claude usage limit, a phase started by
 * itself, a no-mistakes pipeline started outside its validation slot), and the
 * v1 completion pass the section 16 failure P1s (a harness version with no
 * passing contract, Herdr unreachable, GitHub unavailable while a merge waits).
 * steer_unacked is the section 6 "re-ring up to 3 times, then a P1".
 */
export const LANE_TABLE = {
  worker_question_blocking: { lane: "P0", class: "actionable" },
  failure_needs_you: { lane: "P0", class: "actionable" },
  sensitive_action_waiting: { lane: "P0", class: "actionable" },
  pr_ready: { lane: "P1", class: "actionable" },
  gate_ready: { lane: "P1", class: "actionable" },
  report_ready: { lane: "P1", class: "actionable" },
  worker_question: { lane: "P1", class: "actionable" },
  divergence: { lane: "P1", class: "actionable" },
  worker_idle: { lane: "P1", class: "actionable" },
  unproven_merge: { lane: "P1", class: "actionable" },
  backlog_out_of_sync: { lane: "P1", class: "actionable" },
  trust_dialog: { lane: "P1", class: "actionable" },
  overdue_todo: { lane: "P1", class: "actionable" },
  steer_unacked: { lane: "P1", class: "actionable" },
  checkout_tangle: { lane: "P1", class: "actionable" },
  checks_red: { lane: "P1", class: "actionable" },
  pr_closed: { lane: "P1", class: "actionable" },
  cleanup_refused: { lane: "P1", class: "actionable" },
  nomistakes_down: { lane: "P1", class: "actionable" },
  capacity_wait: { lane: "P1", class: "actionable" },
  docker_leftover: { lane: "P1", class: "actionable" },
  phase_blocked: { lane: "P1", class: "actionable" },
  usage_limit: { lane: "P1", class: "actionable" },
  validation_outside_cap: { lane: "P1", class: "actionable" },
  harness_unverified: { lane: "P1", class: "actionable" },
  herdr_unreachable: { lane: "P1", class: "actionable" },
  forge_unavailable: { lane: "P1", class: "actionable" },
  yolo_merged: { lane: "P1", class: "info" },
  phase_started: { lane: "P1", class: "info" },
  auto_resumed: { lane: "P1", class: "info" },
  steer_acked: { lane: "P1", class: "info" },
  progress: { lane: "P2", class: "info" },
} as const satisfies Record<string, { lane: Lane; class: ItemClass }>;

export type ItemKind = keyof typeof LANE_TABLE;

export interface ItemRow {
  id: string;
  event_seq: number;
  class: ItemClass;
  lane: Lane;
  kind: string;
  task_id: string | null;
  run_id: string | null;
  decision_id: string | null;
  line: string;
  state: string;
  resolved_by: string | null;
  opened_at: number;
  resolved_at: number | null;
}

function nextItemId(db: Db): string {
  const next = Number(getMeta(db, "next_item_no") ?? "1");
  setMeta(db, "next_item_no", String(next + 1));
  return `i${next}`;
}

export interface OpenItem {
  kind: ItemKind;
  eventSeq: number;
  line: string;
  taskId?: string | null;
  runId?: string | null;
  /** A due date (YYYY-MM-DD) that orders the item within its lane: overdue to-dos. */
  due?: string | null;
  now?: number;
}

/** Open an item for an event. Call inside the event's transaction. */
export function openItem(db: Db, item: OpenItem): string {
  const { lane, class: klass } = LANE_TABLE[item.kind];
  const id = nextItemId(db);
  db.query(
    `INSERT INTO items (id, event_seq, class, lane, kind, task_id, run_id, line, due, opened_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  ).run(id, item.eventSeq, klass, lane, item.kind, item.taskId ?? null, item.runId ?? null, sanitizeLine(item.line), item.due ?? null, item.now ?? Date.now());
  return id;
}

/** The newest item number handed out, so the attention pump can tell that something opened. */
export function lastItemNo(db: Db): number {
  return Number(getMeta(db, "next_item_no") ?? "1") - 1;
}

export function findOpenItem(db: Db, kind: ItemKind, taskId: string | null): ItemRow | null {
  return db
    .query("SELECT * FROM items WHERE kind = ?1 AND task_id IS ?2 AND state IN ('open','presented') ORDER BY opened_at LIMIT 1")
    .get(kind, taskId) as ItemRow | null;
}

/** Resolve open items of a kind for a task; an item closes only by its resolution, never by delivery. */
export function resolveItems(db: Db, kind: ItemKind, taskId: string | null, resolvedBy: string, now = Date.now()): number {
  const result = db
    .query(
      `UPDATE items SET state = 'resolved', resolved_by = ?3, resolved_at = ?4
       WHERE kind = ?1 AND task_id IS ?2 AND state IN ('open','presented')`,
    )
    .run(kind, taskId, resolvedBy, now);
  return result.changes;
}

/** Open items of a kind for one run. */
export function findOpenRunItem(db: Db, kind: ItemKind, runId: string): ItemRow | null {
  return db
    .query("SELECT * FROM items WHERE kind = ?1 AND run_id = ?2 AND state IN ('open','presented') ORDER BY opened_at LIMIT 1")
    .get(kind, runId) as ItemRow | null;
}

/** Resolve a run's open items of the given kinds (all kinds when none are named). */
export function resolveRunItems(db: Db, runId: string, kinds: readonly ItemKind[] | null, resolvedBy: string, now = Date.now()): number {
  if (kinds && kinds.length === 0) return 0;
  const filter = kinds ? `AND kind IN (${kinds.map((_, i) => `?${i + 4}`).join(", ")})` : "";
  return db
    .query(`UPDATE items SET state = 'resolved', resolved_by = ?2, resolved_at = ?3 WHERE run_id = ?1 AND state IN ('open','presented') ${filter}`)
    .run(runId, resolvedBy, now, ...(kinds ?? [])).changes;
}

export function openItems(db: Db): ItemRow[] {
  return db.query("SELECT * FROM items WHERE state IN ('open','presented') ORDER BY lane, opened_at").all() as ItemRow[];
}
