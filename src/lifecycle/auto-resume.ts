import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { openItem, resolveRunItems } from "../attention/items.ts";
import { explain, type Fact } from "../attention/explanations.ts";
import { releaseLeases } from "../sched/pools.ts";
import { contractsCommand, harnessFacts, harnessUnblock, harnessWaitReason, type HarnessCheck } from "./harness-gate.ts";
import { observedTransition } from "./observed.ts";
import { openOperation, requestOperation } from "./operations.ts";
import { setLiveness, taskTitle, type RunRow } from "./runs.ts";

/**
 * The dead run's one automatic resume (design section 6), as guarded
 * transitions: the death was observed before awaits, so the claim commits only
 * if the run is still that dead worker's (docs/notes/2026-10-12-next-steps-md-s9.md).
 * The caller launches only after a claim that applied.
 */

/** Claim the one resume for a launch now, as a resume operation. Its id when claimed; the caller then launches it. */
export function claimAutoResume(db: Db, seen: RunRow, husk: boolean, now: number): string | null {
  const result = observedTransition(db, seen, "auto_resume", "reconciler", now, (run): string | null => {
    // A launch, resume or cancel already open owns the run: no automatic resume beside it.
    if (openOperation(db, run.id)) return null;
    const updated = db.query("UPDATE runs SET resume_count = resume_count + 1, updated_at = ?2 WHERE id = ?1 AND resume_count = ?3").run(run.id, now, run.resume_count);
    if (updated.changes === 0) return null;
    const facts = deathFacts(run, husk, now);
    const op = requestOperation(db, { run, kind: "resume", mode: "resume", requestedBy: "reconciler", source: "reconciler", now });
    setLiveness(db, run, "starting", "reconciler", { reason: "resuming once after the worker died", husk }, now);
    run.resume_count += 1;
    const event = appendEvent(db, { source: "reconciler", kind: "run.auto_resumed", runId: run.id, taskId: run.task_id, payload: { session: run.agent_session, husk, pane: run.pane_id }, ts: now });
    resolveRunItems(db, run.id, ["worker_idle", "trust_dialog", "blocked_prompt"], "run.auto_resumed", now);
    openItem(db, { kind: "auto_resumed", eventSeq: event.seq, taskId: run.task_id, runId: run.id, line: `Worker for ${taskTitle(db, run.task_id)} died and was resumed once from its session`, now });
    explain(db, { run, kind: "resume", rule: "resume.auto", reason: "the worker died; resumed once from its stored session", facts, unblock: [], operation: op.id, source: "reconciler", now, settled: "resumed" });
    return op.id;
  });
  return result.applied ? result.value : null;
}

/**
 * Claim the one resume and hand it to the scheduler (pending_launch resume),
 * which launches it once the harness version passes its contract suite. A
 * dead worker holds no slot meanwhile. Returns the reason it waits, or null
 * when the claim did not apply.
 */
export function deferAutoResume(db: Db, seen: RunRow, gate: Exclude<HarnessCheck, { state: "verified" }>, husk: boolean, now: number): string | null {
  const why = harnessWaitReason(gate);
  const result = observedTransition(db, seen, "auto_resume_deferred", "reconciler", now, (run) => {
    if (openOperation(db, run.id)) return false;
    const updated = db.query("UPDATE runs SET resume_count = resume_count + 1, pending_launch = 'resume', waiting_since = ?2, updated_at = ?2 WHERE id = ?1 AND resume_count = ?3").run(run.id, now, run.resume_count);
    if (updated.changes === 0) return false;
    const facts = [...harnessFacts(gate, now), ...deathFacts(run, husk, now)];
    // The resume is asked for now; the scheduler's grant launches this same operation once the harness passes.
    const op = requestOperation(db, { run, kind: "resume", mode: "resume", requestedBy: "reconciler", source: "reconciler", now });
    run.resume_count += 1;
    run.pending_launch = "resume";
    setLiveness(db, run, "dead", "reconciler", { reason: `its resume waits: ${why}`, husk }, now);
    const released = releaseLeases(db, run.id, run.task_id, { keepWorker: false }, "the worker died", now);
    if (released.length > 0 && run.stage_state === "active") db.query("UPDATE runs SET stage_state = 'waiting', stage_note = NULL WHERE id = ?1").run(run.id);
    const event = appendEvent(db, { source: "reconciler", kind: "run.resume_deferred", runId: run.id, taskId: run.task_id, payload: { session: run.agent_session, husk, why }, ts: now });
    resolveRunItems(db, run.id, ["worker_idle", "trust_dialog", "blocked_prompt"], "run.resume_deferred", now);
    const waits = gate.state === "missing" ? `waits: ${gate.detail}` : `waits until ${gate.harness} ${gate.version} passes its contract suite (${contractsCommand(gate.harness)})`;
    openItem(db, { kind: "auto_resumed", eventSeq: event.seq, taskId: run.task_id, runId: run.id, line: `Worker for ${taskTitle(db, run.task_id)} died; its one resume ${waits}`, now });
    explain(db, { run, kind: "resume", rule: "resume.deferred", reason: `the worker died; its one automatic resume waits: ${why}`, facts, unblock: harnessUnblock(gate, "launches the resume"), operation: op.id, source: "reconciler", now });
    return true;
  });
  return result.applied && result.value ? why : null;
}

/** What the reconciler saw of a dead worker. */
export function deathFacts(run: RunRow, husk: boolean, t: number): Fact[] {
  return [
    { name: "process", value: `pid ${run.proc_pid ?? "?"} gone${husk ? "; the pane holds only its shell" : ""}`, at: t },
    { name: "session", value: run.agent_session ?? "none", at: null },
    { name: "automatic resumes so far", value: String(run.resume_count), at: null },
  ];
}
