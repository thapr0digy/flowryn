import { findOpenItem, findOpenRunItem, openItem, resolveItems, resolveRunItems } from "../attention/items.ts";
import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import type { ChecksSummary, PullRequest } from "../forge/types.ts";
import { prEvidenceFrom, recordPrEvidence, type Delivered } from "../lifecycle/delivery.ts";
import { landRun } from "../lifecycle/landing.ts";
import { recordEvidence, taskTitle, type RunWithPolicy } from "../lifecycle/runs.ts";
import { pipelineNeedsLastStage, positionOf } from "../lifecycle/stages.ts";
import { holdsLease } from "../sched/pools.ts";
import { latestMerge, recordMergeResult } from "../policy/merge.ts";
import { isActive, type NmRun } from "../policy/nomistakes.ts";
import { openDivergence } from "./divergence.ts";
import { sendBack } from "../lifecycle/send-back.ts";

/**
 * What the delivery watchers saw, applied to the runs (design section 6: the
 * systems of record are rank 1). The watchers only observe; the state changes
 * here are the lifecycle's own transitions: a PR that reads merged lands the
 * run (a merge Flowryn asked for, or one you made on GitHub), a closed PR is a
 * P1, a head that moved after delivery or a PR turned draft is a divergence,
 * red checks are a P1 until they turn green, and an active no-mistakes run
 * makes the run `validating`.
 */

export interface PrObservation {
  pr: PullRequest;
  checks: ChecksSummary | null;
}

export interface Applied {
  /** The run landed in this observation: its cleanup should follow. */
  landed: boolean;
  /** The run was sent back to merge its base (the conflict nudge): the scheduler should look. */
  nudged?: boolean;
}

export interface ObservationOptions {
  /** `[upkeep] nudge_conflicts`: a delivered PR that conflicts with its base sends its ship back. */
  nudgeConflicts: boolean;
}

/** Nudges per run before a conflict stops sending the ship back and asks you instead. */
export const MAX_CONFLICT_NUDGES = 3;

/** Nudge again, or ask you: a head already nudged, or a run past the limit, is yours. */
export function conflictAction(nudgedHeads: readonly (string | null)[], head: string): "nudge" | "ask" {
  return nudgedHeads.length >= MAX_CONFLICT_NUDGES || nudgedHeads.includes(head) ? "ask" : "nudge";
}

/**
 * A delivered PR GitHub reads as not mergeable (spec 3, phase 3: nudge a ship
 * whose PR conflicts). Once per delivered head, and at most
 * MAX_CONFLICT_NUDGES times per run, the ship goes back to work as `decline`
 * sends it, told to merge its base and deliver again; a P1 info line says so.
 * A head already nudged (the worker delivered it again unchanged), or a run
 * past the limit, opens one `pr_conflict` P1 instead. Call inside a
 * transaction.
 */
function nudgeConflict(db: Db, run: RunWithPolicy, delivered: Delivered, pr: PullRequest, title: string, now: number): boolean {
  const nudges = (db.query("SELECT payload FROM events WHERE run_id = ?1 AND kind = 'run.conflict_nudged' ORDER BY seq").all(run.id) as { payload: string }[]).map(
    (e) => (JSON.parse(e.payload) as { head?: string | null }).head ?? null,
  );
  if (conflictAction(nudges, delivered.head) === "ask") {
    if (!findOpenRunItem(db, "pr_conflict", run.id)) {
      const event = appendEvent(db, { source: "github", kind: "pr.conflict", runId: run.id, taskId: run.task_id, payload: { pr: pr.url, head: pr.headSha, nudges: nudges.length }, ts: now });
      openItem(db, {
        kind: "pr_conflict",
        eventSeq: event.seq,
        taskId: run.task_id,
        runId: run.id,
        line: `PR still conflicts with ${pr.baseRef} after ${nudges.length} nudge${nudges.length === 1 ? "" : "s"}: ${title} (${run.project_id}) at ${pr.headSha.slice(0, 8)}; steer it or flowryn decline ${run.task_id}`,
        now,
      });
    }
    return false;
  }
  const base = pr.baseRef || "main";
  const text = `Your PR ${pr.url} conflicts with ${base}: GitHub reads it as not mergeable at ${pr.headSha.slice(0, 8)}. Merge origin/${base} into your branch with a new commit (git fetch origin, then git merge origin/${base}), resolve the conflicts, run the tests, then ship it again and deliver. Never rebase or force-push.`;
  const { seq } = sendBack(db, run, { text, feedback: `conflicts with ${base}`, why: "the PR conflicts with its base", event: { source: "github", kind: "run.conflict_nudged", payload: { pr: pr.url, base, nudge: nudges.length + 1 } } }, now);
  openItem(db, {
    kind: "conflict_nudged",
    eventSeq: seq,
    taskId: run.task_id,
    runId: run.id,
    line: `PR conflicts with ${base}: ${title} (${run.project_id}); sent back to merge origin/${base} and deliver again (nudge ${nudges.length + 1} of ${MAX_CONFLICT_NUDGES})`,
    now,
  });
  return true;
}

/** Apply one observation of a run's PR. Call inside a transaction. */
export function applyPrObservation(
  db: Db,
  run: RunWithPolicy,
  delivered: Delivered,
  obs: PrObservation,
  inFlight: ReadonlySet<string>,
  now: number,
  opts: ObservationOptions = { nudgeConflicts: false },
): Applied {
  const { pr, checks } = obs;
  recordPrEvidence(db, run.id, prEvidenceFrom(pr, checks, now), now);
  const title = taskTitle(db, run.task_id);

  if (run.state === "merging") {
    const merge = latestMerge(db, run.task_id);
    if (merge && (merge.state === "requested" || merge.state === "unproven") && !inFlight.has(merge.id)) {
      if (pr.state === "merged" && pr.mergeSha) {
        recordMergeResult(db, run, merge.id, { state: "merged", sha: pr.mergeSha, detail: `the watcher read the PR merged at ${pr.mergeSha.slice(0, 8)}` }, now);
        return { landed: true };
      }
      if (pr.state === "closed") {
        recordMergeResult(db, run, merge.id, { state: "refused", detail: "the PR was closed without a merge" }, now);
      } else if (merge.state === "requested") {
        recordMergeResult(db, run, merge.id, { state: "unproven", detail: "the daemon stopped before the merge's result was known, and the PR is still open" }, now);
      } else db.query("UPDATE merges SET checked_at = ?2 WHERE id = ?1").run(merge.id, now);
    }
    return { landed: false };
  }
  if (run.state !== "ready") return { landed: false };

  if (pr.state === "merged" && pr.mergeSha) {
    landRun(db, run, { mergeSha: pr.mergeSha, how: "merged_elsewhere" }, now);
    return { landed: true };
  }
  if (pr.state === "closed") {
    if (!findOpenRunItem(db, "pr_closed", run.id)) {
      const event = appendEvent(db, { source: "github", kind: "pr.closed", runId: run.id, taskId: run.task_id, payload: { pr: pr.url }, ts: now });
      openItem(db, { kind: "pr_closed", eventSeq: event.seq, taskId: run.task_id, runId: run.id, line: `PR closed without merging: ${title} (${run.project_id}); flowryn cancel ${run.task_id} or steer it`, now });
    }
    return { landed: false };
  }
  if (pr.headSha !== delivered.head) {
    openDivergence(db, "github", { runId: run.id, taskId: run.task_id, higher: "github", lower: "worker", summary: `the PR head moved from ${delivered.head.slice(0, 8)} (delivered) to ${pr.headSha.slice(0, 8)}; merges wait for a new delivery` }, now);
  }
  if (pr.draft) {
    openDivergence(db, "github", { runId: run.id, taskId: run.task_id, higher: "github", lower: "worker", summary: `the delivered PR ${pr.url} was turned into a draft` }, now);
  }
  if (pr.mergeable === true) resolveRunItems(db, run.id, ["pr_conflict"], "mergeable", now);
  if (opts.nudgeConflicts && pr.mergeable === false && pr.headSha === delivered.head && !pr.draft && nudgeConflict(db, run, delivered, pr, title, now)) {
    return { landed: false, nudged: true };
  }
  if (checks?.state === "red") {
    const red = checks.checks.filter((c) => c.state === "red").map((c) => c.name);
    const line = `PR checks failed at ${pr.headSha.slice(0, 8)}: ${title} (${run.project_id}): ${red.join(", ")}`;
    const open = findOpenRunItem(db, "checks_red", run.id);
    if (!open || !open.line.includes(pr.headSha.slice(0, 8))) {
      if (open) resolveRunItems(db, run.id, ["checks_red"], "new head", now);
      const event = appendEvent(db, { source: "github", kind: "pr.checks_red", runId: run.id, taskId: run.task_id, payload: { pr: pr.url, head: pr.headSha, red }, ts: now });
      openItem(db, { kind: "checks_red", eventSeq: event.seq, taskId: run.task_id, runId: run.id, line, now });
    }
  } else if (checks?.state === "green" || checks?.state === "none") {
    resolveRunItems(db, run.id, ["checks_red"], "checks green", now);
  }
  return { landed: false };
}

/**
 * The pipeline's start is the worker's contract (stage begin first); it is
 * observed here and flagged, never blocked: a pipeline gone active while the
 * run's last stage is not active and it holds no validation slot is a P1.
 * Runs open before M5 (legacy_m4) deliver under M4's contract and are exempt.
 */
function flagOutsideCap(db: Db, run: RunWithPolicy, nm: NmRun, now: number): void {
  if (!pipelineNeedsLastStage(db, run)) return;
  const pos = positionOf(db, run, run.kind);
  if ((pos.last && run.stage_state === "active") || holdsLease(db, run.id, "validation")) return;
  if (findOpenRunItem(db, "validation_outside_cap", run.id)) return;
  const last = pos.def.stages[pos.def.stages.length - 1]!;
  const event = appendEvent(db, { source: "nomistakes", kind: "run.validation_outside_cap", runId: run.id, taskId: run.task_id, payload: { nm_run: nm.id, stage: run.stage, stage_state: run.stage_state }, ts: now });
  openItem(db, {
    kind: "validation_outside_cap",
    eventSeq: event.seq,
    taskId: run.task_id,
    runId: run.id,
    line: `Validation started outside the cap: ${taskTitle(db, run.task_id)} (${run.project_id}) runs no-mistakes in stage ${run.stage} (${run.stage_state}), before stage ${last.id} holds its slot; flowryn show ${run.task_id}`,
    now,
  });
}

/** Apply one no-mistakes status read for a run's worktree (read-only: flowrynd never drives the pipeline). Call inside a transaction. */
export function applyNmObservation(db: Db, run: RunWithPolicy, nm: NmRun | null, now: number): void {
  recordEvidence(db, run.id, "nomistakes", 1, nm ? { id: nm.id, branch: nm.branch, status: nm.status, outcome: nm.outcome, head: nm.head, pr: nm.pr } : { run: null }, now);
  const active = nm !== null && nm.branch === run.branch && isActive(nm);
  if (active && run.state === "running") {
    db.query("UPDATE runs SET state = 'validating', updated_at = ?2 WHERE id = ?1").run(run.id, now);
    appendEvent(db, { source: "nomistakes", kind: "run.validating", runId: run.id, taskId: run.task_id, payload: { nm_run: nm.id, status: nm.status }, ts: now });
    flagOutsideCap(db, run, nm, now);
  } else if (!active && run.state === "validating") {
    db.query("UPDATE runs SET state = 'running', updated_at = ?2 WHERE id = ?1").run(run.id, now);
    appendEvent(db, { source: "nomistakes", kind: "run.validated", runId: run.id, taskId: run.task_id, payload: { nm_run: nm?.id ?? null, outcome: nm?.outcome ?? null, pr: nm?.pr ?? null }, ts: now });
  }
}

/** no-mistakes cannot be read (its daemon is down): one P1 until it answers again; flowrynd never restarts it. Call inside a transaction. */
export function noteNmOutage(db: Db, down: boolean, detail: string, now: number): void {
  if (!down) {
    resolveItems(db, "nomistakes_down", null, "no-mistakes answered", now);
    return;
  }
  if (findOpenItem(db, "nomistakes_down", null)) return;
  const event = appendEvent(db, { source: "nomistakes", kind: "nomistakes.unreachable", payload: { detail }, ts: now });
  openItem(db, { kind: "nomistakes_down", eventSeq: event.seq, line: `no-mistakes does not answer status reads (${detail}); validating runs are not watched. Flowryn never restarts it`, now });
}
