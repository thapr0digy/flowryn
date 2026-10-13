import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { openItem, resolveRunItems } from "../attention/items.ts";
import { releaseLeases } from "../sched/pools.ts";
import { contractsCommand, type HarnessCheck } from "./harness-gate.ts";
import { observedTransition } from "./observed.ts";
import { setLiveness, taskTitle, type RunRow } from "./runs.ts";

/**
 * The dead run's one automatic resume (design section 6), as guarded
 * transitions: the death was observed before awaits, so the claim commits only
 * if the run is still that dead worker's (docs/notes/2026-10-12-next-steps-md-s9.md).
 * The caller launches only after a claim that applied.
 */

/** Claim the one resume for a launch now. True when claimed; the caller then launches it. */
export function claimAutoResume(db: Db, seen: RunRow, husk: boolean, now: number): boolean {
  const result = observedTransition(db, seen, "auto_resume", "reconciler", now, (run) => {
    const updated = db.query("UPDATE runs SET resume_count = resume_count + 1, updated_at = ?2 WHERE id = ?1 AND resume_count = ?3").run(run.id, now, run.resume_count);
    if (updated.changes === 0) return false;
    setLiveness(db, run, "starting", "reconciler", { reason: "resuming once after the worker died", husk }, now);
    run.resume_count += 1;
    const event = appendEvent(db, { source: "reconciler", kind: "run.auto_resumed", runId: run.id, taskId: run.task_id, payload: { session: run.agent_session, husk, pane: run.pane_id }, ts: now });
    resolveRunItems(db, run.id, ["worker_idle", "trust_dialog", "blocked_prompt"], "run.auto_resumed", now);
    openItem(db, { kind: "auto_resumed", eventSeq: event.seq, taskId: run.task_id, runId: run.id, line: `Worker for ${taskTitle(db, run.task_id)} died and was resumed once from its session`, now });
    return true;
  });
  return result.applied && result.value;
}

/**
 * Claim the one resume and hand it to the scheduler (pending_launch resume),
 * which launches it once the harness version passes its contract suite. A
 * dead worker holds no slot meanwhile. Returns the reason it waits, or null
 * when the claim did not apply.
 */
export function deferAutoResume(db: Db, seen: RunRow, gate: Exclude<HarnessCheck, { state: "verified" }>, husk: boolean, now: number): string | null {
  const why = gate.state === "missing" ? gate.detail : `${gate.harness} ${gate.version} has no passing contract run`;
  const result = observedTransition(db, seen, "auto_resume_deferred", "reconciler", now, (run) => {
    const updated = db.query("UPDATE runs SET resume_count = resume_count + 1, pending_launch = 'resume', waiting_since = ?2, updated_at = ?2 WHERE id = ?1 AND resume_count = ?3").run(run.id, now, run.resume_count);
    if (updated.changes === 0) return false;
    run.resume_count += 1;
    run.pending_launch = "resume";
    setLiveness(db, run, "dead", "reconciler", { reason: `its resume waits: ${why}`, husk }, now);
    const released = releaseLeases(db, run.id, run.task_id, { keepWorker: false }, "the worker died", now);
    if (released.length > 0 && run.stage_state === "active") db.query("UPDATE runs SET stage_state = 'waiting', stage_note = NULL WHERE id = ?1").run(run.id);
    const event = appendEvent(db, { source: "reconciler", kind: "run.resume_deferred", runId: run.id, taskId: run.task_id, payload: { session: run.agent_session, husk, why }, ts: now });
    resolveRunItems(db, run.id, ["worker_idle", "trust_dialog", "blocked_prompt"], "run.resume_deferred", now);
    const waits = gate.state === "missing" ? `waits: ${gate.detail}` : `waits until ${gate.harness} ${gate.version} passes its contract suite (${contractsCommand(gate.harness)})`;
    openItem(db, { kind: "auto_resumed", eventSeq: event.seq, taskId: run.task_id, runId: run.id, line: `Worker for ${taskTitle(db, run.task_id)} died; its one resume ${waits}`, now });
    return true;
  });
  return result.applied && result.value ? why : null;
}
