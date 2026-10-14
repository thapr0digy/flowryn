import type { Caller } from "../api/verbs.ts";
import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { closeItemExplanations } from "./explanations.ts";

/**
 * Closing a report item once the leader has read it whole
 * (docs/notes/2026-10-14-auto-close-a-xn.md). `show` lists the items whose
 * whole report it printed; the daemon closes them here, after the read and in
 * its own transaction, and only for the leader. A reader's, a human's and
 * the read-only fallback's show stay pure reads.
 */

/**
 * The worker_report statuses a read closes: the worker tells the leader
 * something and carries on. Every other status that opens an item
 * (REPORT_EFFECT in src/lifecycle/worker.ts: blocked, stuck, failed, failing,
 * error, broken, or a word outside the table) stays open after reading, since
 * the worker may need the leader to act.
 */
export const READ_CLOSES_STATUSES: readonly string[] = ["finding", "risk", "regression"];

/** Which show form printed the report: the item's own view, the same with --full, or a task or run with --full. */
export type ReadForm = "item" | "item-full" | "run-full";

export interface ReportRead {
  item: string;
  form: ReadForm;
}

export const READ_RESOLVED_BY = "read by leader";

/** Whether reading closes an item of this kind whose report has this status (null for a report_ready). */
export function closesOnRead(kind: string, status: string | null): boolean {
  if (kind === "report_ready") return true;
  return kind === "worker_report" && status !== null && READ_CLOSES_STATUSES.includes(status);
}

interface ReadItemRow {
  id: string;
  kind: string;
  state: string;
  task_id: string | null;
  run_id: string | null;
  payload: string | null;
}

function reportStatus(payload: string | null): string | null {
  if (payload === null) return null;
  try {
    const status = (JSON.parse(payload) as { status?: unknown }).status;
    return typeof status === "string" ? status : null;
  } catch {
    return null;
  }
}

/**
 * Close the open report items the leader read whole: each becomes resolved
 * `read by leader`, its wait explanations close, and one `item.read` event is
 * appended. An item already closed, of another kind, or whose status needs an
 * action is left alone with no event, so reading twice changes nothing.
 * Call inside a transaction. Returns the ids it closed.
 */
export function closeReadItems(db: Db, caller: Caller, reads: readonly ReportRead[], now: number): string[] {
  if (caller.role !== "leader") return [];
  const select = db.query(
    `SELECT i.id, i.kind, i.state, i.task_id, i.run_id, e.payload FROM items i LEFT JOIN events e ON e.seq = i.event_seq WHERE i.id = ?1`,
  );
  const closed: string[] = [];
  for (const read of reads) {
    if (closed.includes(read.item)) continue;
    const item = select.get(read.item) as ReadItemRow | null;
    if (!item || (item.state !== "open" && item.state !== "presented")) continue;
    const status = item.kind === "worker_report" ? reportStatus(item.payload) : null;
    if (!closesOnRead(item.kind, status)) continue;
    db.query("UPDATE items SET state = 'resolved', resolved_by = ?2, resolved_at = ?3 WHERE id = ?1").run(item.id, READ_RESOLVED_BY, now);
    closeItemExplanations(db, [item.id], "item read", now);
    appendEvent(db, {
      source: "cli",
      kind: "item.read",
      runId: item.run_id,
      taskId: item.task_id,
      payload: { item: item.id, kind: item.kind, status, by: "leader", session: caller.session ?? null, form: read.form },
      ts: now,
    });
    closed.push(item.id);
  }
  return closed;
}
