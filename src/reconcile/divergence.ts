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
  /** Extra facts for the `divergence.opened` event (a moved PR head's `history`). */
  detail?: Record<string, unknown>;
}

export interface DivergenceRow {
  id: string;
  run_id: string | null;
  task_id: string | null;
  higher: string;
  lower: string;
  summary: string;
  opened_at: number;
  resolved_at: number | null;
  resolution: string | null;
}

/** keep-run: the run's state wins; accept-edit: your backlog edit wins (design section 8). */
export const RESOLUTIONS = ["keep-run", "accept-edit"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

/**
 * A backlog divergence: a hand edit, or any other drift of the backlog, that
 * contradicts the runs (design section 8). Only these have an edit to accept;
 * the others (GitHub against the worker, a process against its run) are
 * between evidence sources and settle when the higher one changes.
 */
export function isBacklogDivergence(d: Pick<DivergenceRow, "lower">): boolean {
  return d.lower === "backlog";
}

/** The command that settles a divergence, for its item line and `show`. */
export function resolveCommand(d: Pick<DivergenceRow, "id" | "lower">): string {
  return isBacklogDivergence(d) ? `flowryn divergence resolve ${d.id} keep-run|accept-edit` : `flowryn divergence resolve ${d.id} keep-run`;
}

function itemLine(id: string, input: DivergenceInput): string {
  if (!isBacklogDivergence(input)) return `Divergence ${id}: ${input.summary}`;
  return `Divergence ${id}: ${input.summary}; nothing changes until ${resolveCommand({ id, lower: input.lower })}`;
}

/**
 * Record a conflict between evidence sources (design section 6: a conflict is
 * recorded, never silently resolved) with a P1 pointer. Skips a duplicate of
 * one still open. Call inside a transaction. Returns the id, or null when an
 * identical one is already open.
 */
export function openDivergence(db: Db, source: EventSource, input: DivergenceInput, now: number): string | null {
  const open = db
    .query("SELECT id FROM divergences WHERE run_id IS ?1 AND task_id IS ?2 AND summary = ?3 AND resolved_at IS NULL")
    .get(input.runId, input.taskId, input.summary) as { id: string } | null;
  if (open) return null;
  // You kept the run as it is for exactly this conflict (keep-run): the same observation does not reopen it.
  if (!isBacklogDivergence(input) && db.query("SELECT 1 FROM divergences WHERE run_id IS ?1 AND summary = ?2 AND resolution = 'keep-run'").get(input.runId, input.summary)) return null;
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
    payload: { divergence: id, higher: input.higher, lower: input.lower, summary: input.summary, ...input.detail },
    ts: now,
  });
  openItem(db, { kind: "divergence", eventSeq: event.seq, taskId: input.taskId, runId: input.runId, line: itemLine(id, input), now });
  return id;
}

export function getDivergence(db: Db, id: string): DivergenceRow | null {
  return db.query("SELECT * FROM divergences WHERE id = ?1").get(id) as DivergenceRow | null;
}

/** Open divergences, oldest first; only the backlog ones when asked. */
export function openDivergences(db: Db, opts: { backlogOnly?: boolean } = {}): DivergenceRow[] {
  const filter = opts.backlogOnly ? "AND lower = 'backlog'" : "";
  return db.query(`SELECT * FROM divergences WHERE resolved_at IS NULL ${filter} ORDER BY opened_at, id`).all() as DivergenceRow[];
}

/** `flowryn show d<N>`: one divergence in full. */
export function divergenceView(d: DivergenceRow): Record<string, unknown> {
  return {
    divergence: d.id,
    task: d.task_id ?? "-",
    run: d.run_id ?? "-",
    between: `${d.higher} (wins) and ${d.lower}`,
    summary: d.summary,
    state: d.resolved_at === null ? "open" : `resolved: ${d.resolution ?? "?"}`,
    opened: new Date(d.opened_at).toISOString(),
    resolve: d.resolved_at === null ? resolveCommand(d) : "-",
  };
}

/**
 * Close a divergence: the row gets its resolution, its P1 item is resolved,
 * and an event says who settled it and how. Call inside a transaction.
 */
export function closeDivergence(db: Db, d: DivergenceRow, resolution: string, by: string, source: EventSource, now: number): void {
  if (d.resolved_at !== null) return;
  db.query("UPDATE divergences SET resolved_at = ?2, resolution = ?3 WHERE id = ?1").run(d.id, now, resolution);
  db.query("UPDATE items SET state = 'resolved', resolved_by = ?1, resolved_at = ?2 WHERE kind = 'divergence' AND line LIKE ?3 AND state IN ('open','presented')").run(
    `divergence.resolved ${d.id} ${resolution}`,
    now,
    `Divergence ${d.id}:%`,
  );
  appendEvent(db, { source, kind: "divergence.resolved", runId: d.run_id, taskId: d.task_id, payload: { divergence: d.id, resolution, by }, ts: now });
  d.resolved_at = now;
  d.resolution = resolution;
}
