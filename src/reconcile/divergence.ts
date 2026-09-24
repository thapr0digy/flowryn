import type { Db } from "../db/db.ts";
import { getMeta, setMeta } from "../db/db.ts";
import { appendEvent, type EventSource } from "../db/events.ts";
import { openItem } from "../attention/items.ts";

export interface DivergenceInput {
  runId: string | null;
  taskId: string | null;
  /** The source that wins (higher rank) and the one it contradicts. */
  higher: string;
  lower: string;
  summary: string;
}

/**
 * Record a conflict between evidence sources (design section 6: a conflict is
 * recorded, never silently resolved) with a P1 pointer. Skips a duplicate of
 * one still open. Call inside a transaction. Returns the id, or null when an
 * identical one is already open.
 */
export function openDivergence(db: Db, source: EventSource, input: DivergenceInput, now: number): string | null {
  const open = db
    .query("SELECT id FROM divergences WHERE run_id IS ?1 AND summary = ?2 AND resolved_at IS NULL")
    .get(input.runId, input.summary) as { id: string } | null;
  if (open) return null;
  const next = Number(getMeta(db, "next_divergence_no") ?? "1");
  setMeta(db, "next_divergence_no", String(next + 1));
  const id = `d${next}`;
  db.query("INSERT INTO divergences (id, run_id, task_id, higher, lower, summary, opened_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").run(
    id,
    input.runId,
    input.taskId,
    input.higher,
    input.lower,
    input.summary,
    now,
  );
  const event = appendEvent(db, {
    source,
    kind: "divergence.opened",
    runId: input.runId,
    taskId: input.taskId,
    payload: { divergence: id, higher: input.higher, lower: input.lower, summary: input.summary },
    ts: now,
  });
  openItem(db, { kind: "divergence", eventSeq: event.seq, taskId: input.taskId, runId: input.runId, line: `Divergence ${id}: ${input.summary}`, now });
  return id;
}
