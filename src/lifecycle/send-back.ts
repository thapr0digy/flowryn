import { resolveRunItems } from "../attention/items.ts";
import { WORKER_POOL } from "../config/workflows.ts";
import type { Db } from "../db/db.ts";
import { appendEvent, type EventSource } from "../db/events.ts";
import { voidApprovals } from "../policy/approvals.ts";
import { holdsLease, workerFreedAtDelivery } from "../sched/pools.ts";
import { deliveredOf } from "./delivery.ts";
import type { RunWithPolicy } from "./runs.ts";
import { closeMergeGate, positionOf, requestStage } from "./stages.ts";

/**
 * The launch a run sent back to work needs, or null while its worker holds its slot and carries on.
 * A worker whose slot was freed at a batch delivery is replaced by a fresh session, whose task file
 * carries the brief and the stage note (docs/notes/2026-11-22-phase-free-the-rn.md); any other gone
 * worker resumes from its stored session.
 */
export function workerReturnLaunch(db: Db, run: RunWithPolicy): "stage" | "resume" | null {
  if (run.liveness !== "dead" && holdsLease(db, run.id, WORKER_POOL)) return null;
  return workerFreedAtDelivery(db, run.id) ? "stage" : "resume";
}

/**
 * Send a delivered ship back to work (`flowryn decline`, and the conflict
 * nudge in src/reconcile/delivery.ts): the run is running again, standing
 * approvals and the delivery's items go, the merge gate closes unpassed, and
 * its last stage starts again through the scheduler with `text` as the stage
 * start's steer. Its pools are granted again, and a worker that is gone
 * meanwhile comes back as workerReturnLaunch says. The caller kicks the scheduler after
 * the commit. Call inside a transaction, on a run in state `ready`.
 */
export function sendBack(
  db: Db,
  run: RunWithPolicy,
  send: { text: string; feedback: string; why: string; event: { source: EventSource; kind: string; payload: Record<string, unknown> } },
  now: number,
): { stage: string; seq: number } {
  db.query("UPDATE runs SET state = 'running', updated_at = ?2 WHERE id = ?1").run(run.id, now);
  voidApprovals(db, run.task_id, now, send.why);
  resolveRunItems(db, run.id, ["pr_ready", "sensitive_action_waiting", "checks_red", "pr_closed", "auto_merge_held", "verify_failed"], send.event.kind, now);
  const delivered = deliveredOf(db, run.task_id);
  const { seq } = appendEvent(db, { source: send.event.source, kind: send.event.kind, runId: run.id, taskId: run.task_id, payload: { ref: delivered?.ref ?? null, head: delivered?.head ?? null, ...send.event.payload }, ts: now });
  closeMergeGate(db, run, { passed: false, feedback: send.feedback }, now);
  const pos = positionOf(db, run, run.kind);
  run.pending_launch = workerReturnLaunch(db, run) ?? run.pending_launch;
  requestStage(db, run, pos.def, pos.index, send.text, now);
  run.state = "running";
  return { stage: pos.stage.id, seq };
}
