import type { Db } from "./db.ts";
import { ulid } from "../util/ulid.ts";

/** Design section 13: where an event came from. */
export const EVENT_SOURCES = ["cli", "hook", "herdr", "github", "nomistakes", "backlog", "reconciler", "daemon"] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export interface NewEvent {
  source: EventSource;
  kind: string;
  runId?: string | null;
  taskId?: string | null;
  payload?: unknown;
  ts?: number;
}

export interface EventRow {
  seq: number;
  ulid: string;
  ts: number;
  source: string;
  run_id: string | null;
  task_id: string | null;
  kind: string;
  payload: string;
}

/**
 * Append one event. Call it inside the same transaction as the state change it
 * records; the table is append-only (triggers refuse UPDATE and DELETE).
 */
export function appendEvent(db: Db, event: NewEvent): { seq: number; ulid: string } {
  const id = ulid();
  const result = db
    .query("INSERT INTO events (ulid, ts, source, run_id, task_id, kind, payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
    .run(id, event.ts ?? Date.now(), event.source, event.runId ?? null, event.taskId ?? null, event.kind, JSON.stringify(event.payload ?? {}));
  return { seq: Number(result.lastInsertRowid), ulid: id };
}
