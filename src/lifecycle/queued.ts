import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { recordIntent } from "../journal/journal.ts";
import { readSnapshot } from "../journal/snapshot.ts";
import { MAX_BACKLOG_BODY } from "./ids.ts";
import type { ProjectRow } from "./projects.ts";
import { openRunForTask } from "./runs.ts";

/**
 * A task filed Queued that is not a plan phase (work the cutover imported):
 * its policy row, with auto off, and the backlog add. `dispatch --task`
 * starts it. Call inside a transaction.
 */
export function queueTask(
  db: Db,
  q: { taskId: string; title: string; body: string; kind: "ship" | "scout"; project: ProjectRow; priority: number | null; blockedBy: string[]; now: number },
): void {
  db.query(
    `INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, sensitive, workflow, auto, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, 0, ?7)`,
  ).run(q.taskId, q.project.id, q.kind, q.project.delivery_mode, q.project.yolo, q.kind === "scout" ? "scout" : q.project.workflow, q.now);
  const flags: Record<string, string | true | string[]> = { kind: q.kind, repo: q.project.id, body: q.body.slice(0, MAX_BACKLOG_BODY) };
  if (q.priority !== null) flags.priority = String(q.priority);
  if (q.blockedBy.length > 0) flags["blocked-by"] = q.blockedBy;
  recordIntent(db, { file: "backlog", verb: "add", taskId: q.taskId, positional: [q.taskId, q.title], flags, now: q.now });
  appendEvent(db, { source: "cli", kind: "task.queued", taskId: q.taskId, payload: { kind: q.kind, project: q.project.id }, ts: q.now });
}

/**
 * A Queued task Flowryn filed that is neither a plan phase nor already
 * running: a task whose earlier run failed or was cancelled is terminal, not
 * open, so it may be started again with `--task` (cutover C3 fix: a prior
 * version excluded a task with any run at all, which permanently stranded
 * one whose run had failed).
 */
export function queuedTaskOf(db: Db, taskId: string): { task_id: string; kind: "ship" | "scout"; project_id: string; title: string; body: string } | null {
  const policy = db
    .query(
      `SELECT tp.task_id, tp.kind, tp.project_id FROM task_policy tp
       WHERE tp.task_id = ?1 AND NOT EXISTS (SELECT 1 FROM plan_phases ph WHERE ph.task_id = tp.task_id)`,
    )
    .get(taskId) as { task_id: string; kind: "ship" | "scout"; project_id: string } | null;
  if (!policy) return null;
  if (openRunForTask(db, taskId)) return null;
  const task = (readSnapshot(db, "backlog")?.tasks ?? []).find((t) => t.id === taskId);
  if (!task || task.state !== "queued") return null;
  return { ...policy, title: task.title, body: task.body };
}
