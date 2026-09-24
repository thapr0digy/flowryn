import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { localDate } from "../lifecycle/dates.ts";
import { todoViews } from "../lifecycle/todos.ts";
import { dueLabel } from "./briefing.ts";
import { openItem } from "./items.ts";

/**
 * Overdue to-dos are P1 actionable items (design section 2): one per to-do,
 * opened the first time the daemon sees it past its due date, and resolved
 * when it is done, removed or no longer overdue. Call inside a transaction.
 */
export function syncOverdueTodos(db: Db, now: number): { opened: string[]; resolved: number } {
  const today = localDate(new Date(now));
  const overdue = todoViews(db).filter((t) => t.state !== "done" && t.due !== null && t.due < today);
  const wanted = new Map(overdue.map((t) => [t.id, t]));
  const open = db.query("SELECT id, task_id FROM items WHERE kind = 'overdue_todo' AND state IN ('open','presented')").all() as { id: string; task_id: string }[];
  let resolved = 0;
  const have = new Set<string>();
  for (const item of open) {
    if (wanted.has(item.task_id)) {
      have.add(item.task_id);
      continue;
    }
    db.query("UPDATE items SET state = 'resolved', resolved_by = 'todo no longer overdue', resolved_at = ?2 WHERE id = ?1").run(item.id, now);
    resolved++;
  }
  const opened: string[] = [];
  for (const todo of overdue) {
    if (have.has(todo.id)) continue;
    const event = appendEvent(db, { source: "daemon", kind: "todo.overdue", taskId: todo.id, payload: { due: todo.due }, ts: now });
    opened.push(
      openItem(db, { kind: "overdue_todo", eventSeq: event.seq, taskId: todo.id, due: todo.due, line: `Overdue to-do: ${todo.title} (${dueLabel(todo.due!)})`, now }),
    );
  }
  return { opened, resolved };
}
