import { findOpenItem } from "../attention/items.ts";
import type { Db } from "../db/db.ts";
import { normalizedTitle } from "../journal/diff.ts";
import { readSnapshot } from "../journal/snapshot.ts";
import type { BacklogTask } from "../journal/tasks-axi.ts";
import { blockersOf, hasLanded, phaseOfTask } from "./plans.ts";
import { getProject } from "./projects.ts";
import { openRunForTask } from "./runs.ts";

/**
 * Queued work: what fleet, show, the board and the briefing all mean by
 * "Queued", so their lists and counts agree. A task is queued when the
 * backlog snapshot has it Queued, it is not a standalone decision's task
 * (those belong to `flowryn decision list`), and it has no open run (a run
 * that started before the snapshot caught up is in flight, not queued).
 * Hand-added backlog tasks with no Flowryn policy count too.
 */

export type QueuedStatus = "ready" | "waiting" | "held";

export interface QueuedTask {
  id: string;
  title: string;
  kind: string;
  project: string;
  priority: number | null;
  /** When it was filed (its policy row, else the backlog's created date); null when neither says. */
  createdAt: number | null;
  status: QueuedStatus;
  /** on | off | "on (autonomy off)" | - (hand-added: Flowryn did not file it). */
  auto: string;
  blockedBy: string[];
  /** The blockers that have not landed yet. */
  waits: string[];
  hold: BacklogTask["hold"];
  /** What starts it: a command, "starts by itself", "unhold", or "-". */
  next: string;
  /** flowryn | imported | backlog (hand-added). */
  filed: "flowryn" | "imported" | "backlog";
  importSource: string | null;
  /** The plan phase it is, when it is one. */
  plan: { id: string; phase: number; of: number; title: string } | null;
  body: string;
  /** The task's policy, when Flowryn filed it. */
  policy: QueuedPolicy | null;
}

export interface QueuedPolicy {
  project_id: string;
  kind: string;
  delivery_mode: string;
  mode_reason: string | null;
  workflow: string;
  auto: number;
  created_at: number;
  import_source: string | null;
}

const STATUS_RANK: Record<QueuedStatus, number> = { ready: 0, waiting: 1, held: 2 };

function policyOf(db: Db, taskId: string): QueuedPolicy | null {
  return db
    .query("SELECT project_id, kind, delivery_mode, mode_reason, workflow, auto, created_at, import_source FROM task_policy WHERE task_id = ?1")
    .get(taskId) as QueuedPolicy | null;
}

function createdOf(policy: QueuedPolicy | null, task: BacklogTask): number | null {
  if (policy) return policy.created_at;
  const parsed = task.created ? Date.parse(task.created) : Number.NaN;
  return Number.isNaN(parsed) ? null : parsed;
}

function isQueued(db: Db, task: BacklogTask): boolean {
  return task.state === "queued" && task.kind !== "decision" && openRunForTask(db, task.id) === null;
}

/** One queued backlog task, described. */
function describe(db: Db, task: BacklogTask, backlog: BacklogTask[]): QueuedTask {
  const policy = policyOf(db, task.id);
  const phase = phaseOfTask(db, task.id);
  const project = policy ? policy.project_id : (task.repo ?? "-");
  const blockedBy = blockersOf(task);
  const waits = blockedBy.filter((dep) => !hasLanded(db, dep, backlog));
  const status: QueuedStatus = task.hold ? "held" : waits.length > 0 ? "waiting" : "ready";
  // The scheduler's own rule (autoDispatch): an approved plan's phase with auto on, in a project whose autonomy is plan.
  const autonomous = policy !== null && policy.auto === 1 && getProject(db, project)?.autonomy === "plan";
  const startsByItself = autonomous && phase !== null && phase.plan_state === "approved";
  const auto = policy === null ? "-" : policy.auto === 0 ? "off" : autonomous ? "on" : "on (autonomy off)";
  return {
    id: task.id,
    title: normalizedTitle(task),
    kind: policy?.kind ?? task.kind ?? "-",
    project,
    priority: task.priority,
    createdAt: createdOf(policy, task),
    status,
    auto,
    blockedBy,
    waits,
    hold: task.hold,
    next: nextStep(db, task.id, policy, status, startsByItself, project),
    filed: policy === null ? "backlog" : policy.import_source ? "imported" : "flowryn",
    importSource: policy?.import_source ?? null,
    plan: phase ? { id: phase.plan_id, phase: phase.phase_no, of: phase.phases, title: phase.plan_title } : null,
    body: task.body,
    policy,
  };
}

function nextStep(db: Db, taskId: string, policy: QueuedPolicy | null, status: QueuedStatus, startsByItself: boolean, project: string): string {
  if (status === "held") return "unhold";
  // A hand-added task has no Flowryn policy, so dispatch --task cannot start it.
  if (policy === null) return "-";
  if (status === "waiting") return startsByItself ? "starts when unblocked" : "dispatch when unblocked";
  if (!startsByItself) return `flowryn dispatch ${project} --task ${taskId}`;
  const blocked = findOpenItem(db, "phase_blocked", taskId);
  return blocked ? `cannot start (${blocked.id})` : "starts by itself";
}

function byStatusPriorityAge(a: QueuedTask, b: QueuedTask): number {
  return (
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    (a.priority ?? 99) - (b.priority ?? 99) ||
    (a.createdAt ?? Number.MAX_SAFE_INTEGER) - (b.createdAt ?? Number.MAX_SAFE_INTEGER) ||
    a.id.localeCompare(b.id)
  );
}

/** Every queued task: ready first, then waiting, then held; within each, by priority then age. */
export function queuedWork(db: Db): QueuedTask[] {
  const backlog = readSnapshot(db, "backlog")?.tasks ?? [];
  return backlog.filter((t) => isQueued(db, t)).map((t) => describe(db, t, backlog)).toSorted(byStatusPriorityAge);
}

/** One task, when it is queued; null otherwise. */
export function queuedTask(db: Db, taskId: string): QueuedTask | null {
  const backlog = readSnapshot(db, "backlog")?.tasks ?? [];
  const task = backlog.find((t) => t.id === taskId);
  return task && isQueued(db, task) ? describe(db, task, backlog) : null;
}

/** "3 (1 ready, 1 waiting, 1 held)", leaving out zero parts; "0" for none. */
export function queuedSummary(queued: QueuedTask[]): string {
  if (queued.length === 0) return "0";
  const parts = (["ready", "waiting", "held"] as const).map((s) => [s, queued.filter((q) => q.status === s).length] as const).filter(([, n]) => n > 0);
  return `${queued.length} (${parts.map(([s, n]) => `${n} ${s}`).join(", ")})`;
}

/** The fleet's and board's `waits` cell: the unlanded blockers, the hold, or "-". */
export function waitsCell(q: QueuedTask): string {
  if (q.status === "held") return [q.hold?.kind, q.hold?.reason].filter((s) => s).join(": ") || "held";
  return q.waits.length > 0 ? q.waits.join(" ") : "-";
}
