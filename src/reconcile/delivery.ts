import { findOpenItem, findOpenRunItem, openItem, resolveItems, resolveRunItems } from "../attention/items.ts";
import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import type { ChecksSummary, PullRequest } from "../forge/types.ts";
import { carryDelivery, deliveredOf, prEvidenceFrom, recordPrEvidence, type Delivered } from "../lifecycle/delivery.ts";
import { landRun } from "../lifecycle/landing.ts";
import { askedCiWait } from "../lifecycle/ci-wait.ts";
import { isTerminal, recordEvidence, runBase, taskTitle, type RunRow, type RunWithPolicy } from "../lifecycle/runs.ts";
import { getProject } from "../lifecycle/projects.ts";
import { pipelineNeedsLastStage, positionOf } from "../lifecycle/stages.ts";
import { holdsLease } from "../sched/pools.ts";
import { latestMerge, recordMergeResult } from "../policy/merge.ts";
import { isActive, isConflictGate, oldestStep, quietSeconds, waitsOnlyOnCi, type NmRun } from "../policy/nomistakes.ts";
import type { CleanMerge } from "../policy/clean-merge.ts";
import type { HeadHistory } from "../policy/head-history.ts";
import { openDivergence } from "./divergence.ts";
import { sendBack } from "../lifecycle/send-back.ts";

/**
 * What the delivery watchers saw, applied to the runs (design section 6: the
 * systems of record are rank 1). The watchers only observe; the state changes
 * here are the lifecycle's own transitions: a PR that reads merged lands the
 * run (a merge Flowryn asked for, or one you made on GitHub), a closed PR is a
 * P1, a head that moved after delivery or a PR turned draft is a divergence,
 * red checks are a P1 until they turn green, an active no-mistakes run
 * makes the run `validating`, and a validation slot held with no progress
 * is a P1.
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
  /** The head moved by a clean merge of main and the delivery carried over, with a verify queued: the scheduler should look. */
  carried?: boolean;
}

export interface ObservationOptions {
  /** `[upkeep] nudge_conflicts`: a delivered PR that conflicts with its base sends its ship back. */
  nudgeConflicts: boolean;
  /** How the PR head moved from the delivered head (headHistory), when the watcher asked git; absent reads as unknown. */
  history?: HeadHistory;
  /** Whether the moved head is the delivered one plus only clean merges of main (cleanMainMerge), asked when it descends. */
  carry?: { proof: CleanMerge; verifyPolicy: string | null; autoMerge?(run: RunWithPolicy, pr: PullRequest, now: number): void };
}

/** The start every summary of one head move shares, whatever its history tag. */
function headMoveSummary(delivered: string, head: string): string {
  return `the PR head moved from ${delivered.slice(0, 8)} (delivered) to ${head.slice(0, 8)}`;
}

/**
 * A divergence for this exact head move is open, or you kept the run as it
 * is for it (keep-run): another would repeat it, so none opens, and the
 * watcher does not ask git again.
 */
export function headMoveRecorded(db: Db, runId: string, delivered: string, head: string): boolean {
  const prefix = headMoveSummary(delivered, head);
  return (
    db
      .query("SELECT 1 FROM divergences WHERE run_id = ?1 AND substr(summary, 1, ?3) = ?2 AND (resolved_at IS NULL OR resolution = 'keep-run') LIMIT 1")
      .get(runId, prefix, prefix.length) !== null
  );
}

/** The divergence for a moved head, tagged when its history was rewritten or git could not say. */
function headMoved(db: Db, run: RunWithPolicy, delivered: Delivered, pr: PullRequest, history: HeadHistory, notCarried: string | null, now: number): void {
  if (headMoveRecorded(db, run.id, delivered.head, pr.headSha)) return;
  const from = delivered.head.slice(0, 8);
  const to = pr.headSha.slice(0, 8);
  const tag =
    history === "rewritten" ? `, history rewritten: ${to} does not descend from ${from}` : history === "unknown" ? ", ancestry unknown" : notCarried ? `, not carried: ${notCarried}` : "";
  openDivergence(
    db,
    "github",
    { runId: run.id, taskId: run.task_id, higher: "github", lower: "worker", summary: `${headMoveSummary(delivered.head, pr.headSha)}${tag}; merges wait for a new delivery`, detail: { history } },
    now,
  );
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

/**
 * A PR merged on GitHub into a branch other than the run's base (retargeted
 * by hand, then merged): a divergence, not a landing, since the work is not
 * where the run said it would go. Keeping the run (keep-run) lands it as merged.
 */
function mergedOffBase(db: Db, run: RunWithPolicy, pr: PullRequest, now: number): boolean {
  const project = getProject(db, run.project_id);
  if (!project || !pr.baseRef) return false;
  const base = runBase(run, project);
  if (pr.baseRef === base) return false;
  const summary = `the delivered PR ${pr.url} was merged into ${pr.baseRef}, not its base ${base}`;
  if (db.query("SELECT 1 FROM divergences WHERE run_id = ?1 AND summary = ?2 AND resolution = 'keep-run'").get(run.id, summary)) return false;
  openDivergence(db, "github", { runId: run.id, taskId: run.task_id, higher: "github", lower: "worker", summary }, now);
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
        if (mergedOffBase(db, run, pr, now)) {
          recordMergeResult(db, run, merge.id, { state: "refused", detail: `the PR was merged into ${pr.baseRef}, not the run's base` }, now);
          return { landed: false };
        }
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
    if (mergedOffBase(db, run, pr, now)) return { landed: false };
    landRun(db, run, { mergeSha: pr.mergeSha, how: "merged_elsewhere", by: "other" }, now);
    return { landed: true };
  }
  if (pr.state === "closed") {
    if (!findOpenRunItem(db, "pr_closed", run.id)) {
      const event = appendEvent(db, { source: "github", kind: "pr.closed", runId: run.id, taskId: run.task_id, payload: { pr: pr.url }, ts: now });
      openItem(db, { kind: "pr_closed", eventSeq: event.seq, taskId: run.task_id, runId: run.id, line: `PR closed without merging: ${title} (${run.project_id}); flowryn cancel ${run.task_id} or steer it`, now });
    }
    return { landed: false };
  }
  let carried = false;
  let current = delivered;
  if (pr.headSha !== delivered.head) {
    const carry = opts.carry;
    if (carry?.proof.ok && carryDelivery(db, run, delivered, pr, checks, { from: delivered.head, steps: carry.proof.steps, verifyPolicy: carry.verifyPolicy }, now)) {
      current = deliveredOf(db, run.task_id) ?? delivered;
      carried = true;
      // The carried head is a delivery: an opted-in yolo project's auto-merge follows it as it follows a deliver.
      carry.autoMerge?.(run, pr, now);
    } else {
      const why = !carry ? null : carry.proof.ok ? "only routine work (yolo, not sensitive) carries a clean merge of main" : `not only a clean merge of main (${carry.proof.why})`;
      headMoved(db, run, delivered, pr, opts.history ?? "unknown", why, now);
    }
  }
  if (pr.draft) {
    openDivergence(db, "github", { runId: run.id, taskId: run.task_id, higher: "github", lower: "worker", summary: `the delivered PR ${pr.url} was turned into a draft` }, now);
  }
  if (pr.mergeable === true) resolveRunItems(db, run.id, ["pr_conflict"], "mergeable", now);
  if (opts.nudgeConflicts && pr.mergeable === false && pr.headSha === current.head && !pr.draft && nudgeConflict(db, run, current, pr, title, now)) {
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
  return carried ? { landed: false, carried: true } : { landed: false };
}

/**
 * A merge proven after the run ended (cancelled or failed while the proof was
 * read): the run is not revived, but the fact is kept. An open merge request
 * is recorded merged, and a divergence (P1) says the work landed under an
 * ended run, so you decide what the task is now. Returns whether it applied.
 * Call inside a transaction.
 */
export function noteMergedAfterEnd(db: Db, run: RunRow, delivered: Delivered, proof: { mergeSha: string; source: "github" | "daemon" }, now: number): boolean {
  if (!isTerminal(run.state)) return false;
  const merge = latestMerge(db, run.task_id);
  if (merge && (merge.state === "requested" || merge.state === "unproven")) {
    db.query("UPDATE merges SET state = 'merged', merge_sha = ?2, proven_at = ?3, checked_at = ?3, detail = COALESCE(detail || '; ', '') || ?4 WHERE id = ?1").run(
      merge.id,
      proof.mergeSha,
      now,
      `proven after the run was ${run.state}`,
    );
  }
  appendEvent(db, { source: proof.source, kind: "run.merged_after_end", runId: run.id, taskId: run.task_id, payload: { ref: delivered.ref, head: delivered.head, merge_sha: proof.mergeSha, state: run.state, merge: merge?.id ?? null }, ts: now });
  openDivergence(
    db,
    proof.source,
    { runId: run.id, taskId: run.task_id, higher: proof.source === "github" ? "github" : "git", lower: "run", summary: `${delivered.ref} merged at ${proof.mergeSha.slice(0, 8)} after the run was ${run.state}; the merge stands, the run is not revived` },
    now,
  );
  return true;
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

/**
 * When flowrynd first saw this pipeline run waiting only on CI: kept across
 * reads of the same run (the CI-wait watchdog's clock when no-mistakes'
 * own `active_for` is unreadable), null once it is not a CI wait.
 */
function ciSinceOf(db: Db, runId: string, nm: NmRun | null, now: number): number | null {
  if (!nm || !waitsOnlyOnCi(nm)) return null;
  const row = db.query("SELECT value FROM run_evidence WHERE run_id = ?1 AND source = 'nomistakes'").get(runId) as { value: string } | null;
  const before = row ? (JSON.parse(row.value) as { id?: unknown; ci_since?: unknown }) : null;
  return before && before.id === nm.id && typeof before.ci_since === "number" ? before.ci_since : now;
}

/** What covers a parked conflict gate: the nudge that sent the ship back, or the pr_conflict item once the nudges are spent. */
export type ConflictCover = "conflict_nudged" | "pr_conflict";

/**
 * The run's no-mistakes run is parked at its `ci` gate on a merge conflict
 * alone (isConflictGate), on the run's branch, and the conflict nudge has
 * already acted on that head: a `run.conflict_nudged` (the ship was sent back
 * to merge its base) or a `pr.conflict` (the nudges were spent, pr_conflict
 * is open) for it. The parked run is then no work in progress: the worker's
 * next push supersedes it. Null when nothing covers it (with
 * `nudge_conflicts` off no such event exists, and today's handling stands).
 */
export function conflictCovered(db: Db, run: Pick<RunRow, "id" | "branch">, nm: NmRun | null): ConflictCover | null {
  if (!nm || nm.branch !== run.branch || !isConflictGate(nm)) return null;
  const head = nm.headSha || nm.head;
  if (!head) return null;
  const events = db.query("SELECT kind, payload FROM events WHERE run_id = ?1 AND kind IN ('run.conflict_nudged', 'pr.conflict') ORDER BY seq DESC").all(run.id) as { kind: string; payload: string }[];
  for (const e of events) {
    const at = (JSON.parse(e.payload) as { head?: unknown }).head;
    if (typeof at === "string" && at !== "" && (at.startsWith(head) || head.startsWith(at))) return e.kind === "pr.conflict" ? "pr_conflict" : "conflict_nudged";
  }
  return null;
}

/** Apply one no-mistakes status read for a run's worktree (read-only: flowrynd never drives the pipeline). Call inside a transaction. Returns the CI wait's start as flowrynd saw it. */
export function applyNmObservation(db: Db, run: RunWithPolicy, nm: NmRun | null, stuckAfterMs: number, now: number): { ciSince: number | null } {
  // The active steps let the restart guard tell a CI wait from local work (src/daemon/restart.ts); a covered conflict gate, from a validation.
  const ciSince = ciSinceOf(db, run.id, nm, now);
  const covered = conflictCovered(db, run, nm);
  const evidence = nm
    ? { id: nm.id, branch: nm.branch, status: nm.status, outcome: nm.outcome, head: nm.head, pr: nm.pr, active_steps: nm.activeSteps, ci_since: ciSince, conflict_gate: covered }
    : { run: null };
  recordEvidence(db, run.id, "nomistakes", 1, evidence, now);
  if (covered) {
    leaveCoveredGate(db, run, nm!, covered, now);
    return { ciSince };
  }
  const active = nm !== null && nm.branch === run.branch && isActive(nm);
  if (active && run.state === "running") {
    db.query("UPDATE runs SET state = 'validating', updated_at = ?2 WHERE id = ?1").run(run.id, now);
    appendEvent(db, { source: "nomistakes", kind: "run.validating", runId: run.id, taskId: run.task_id, payload: { nm_run: nm.id, status: nm.status }, ts: now });
    flagOutsideCap(db, run, nm, now);
  } else if (!active && run.state === "validating") {
    db.query("UPDATE runs SET state = 'running', updated_at = ?2 WHERE id = ?1").run(run.id, now);
    appendEvent(db, { source: "nomistakes", kind: "run.validated", runId: run.id, taskId: run.task_id, payload: { nm_run: nm?.id ?? null, outcome: nm?.outcome ?? null, pr: nm?.pr ?? null }, ts: now });
  }
  noteValidationProgress(db, run, active ? nm : null, nm, stuckAfterMs, now);
  return { ciSince };
}

/**
 * A parked conflict gate the nudge covers is not a validation: a run it made
 * `validating` goes back to `running` (an event says what covered it), it
 * opens no validation_outside_cap or validation_stuck, and no other item.
 * Call inside a transaction.
 */
function leaveCoveredGate(db: Db, run: RunWithPolicy, nm: NmRun, covered: ConflictCover, now: number): void {
  if (run.state !== "validating") return;
  db.query("UPDATE runs SET state = 'running', updated_at = ?2 WHERE id = ?1").run(run.id, now);
  appendEvent(db, { source: "nomistakes", kind: "run.validated", runId: run.id, taskId: run.task_id, payload: { nm_run: nm.id, outcome: null, pr: nm.pr || null, conflict_gate: covered }, ts: now });
}

/** What one status read says about a held validation slot: stuck (with the line's detail and evidence), moving, or nothing this read can tell. */
type Progress = { stuck: true; detail: string; quietMs: number; step: string | null } | { stuck: false } | null;

function shortDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 > 0 ? `${m % 60}m` : ""}`;
}

/**
 * Judge the slot: an active run is stuck when its oldest step shows no
 * activity for over the threshold (no-mistakes' own clock, read from the
 * status); a run gone or ended is stuck once the slot has gone that long
 * since it was granted or the run last stopped validating (rows, so a
 * restart keeps the clock). A status without the steps table, a run parked
 * with no step, or an activity this copy cannot read tells nothing.
 */
function judgeProgress(db: Db, run: RunWithPolicy, active: NmRun | null, nm: NmRun | null, grantedAt: number, stuckAfterMs: number, now: number): Progress {
  if (active) {
    const step = oldestStep(active.activeSteps ?? []);
    const quiet = step ? quietSeconds(step) : null;
    if (!step || quiet === null) return null;
    const quietMs = quiet * 1000;
    return quietMs > stuckAfterMs ? { stuck: true, quietMs, step: step.step, detail: `no-mistakes step ${step.step} quiet for ${shortDuration(quietMs)}` } : { stuck: false };
  }
  const stopped = db.query("SELECT MAX(ts) AS ts FROM events WHERE run_id = ?1 AND kind = 'run.validated'").get(run.id) as { ts: number | null };
  const quietMs = now - Math.max(grantedAt, stopped.ts ?? 0);
  if (quietMs <= stuckAfterMs) return { stuck: false };
  const ended = nm !== null && nm.branch === run.branch && nm.outcome !== "";
  const what = ended ? `no-mistakes run ${nm.id} ended (${nm.outcome})` : `no no-mistakes run on ${run.branch}`;
  return { stuck: true, quietMs, step: null, detail: `${what}, quiet for ${shortDuration(quietMs)} with the slot held and nothing delivered` };
}

/**
 * A ship holding its validation slot with no progress: one validation_stuck
 * P1 per run per episode. An episode opens with run.validation_stuck and
 * ends with run.validation_moving (a read that says the run moves), counted
 * from the slot's grant, so a dismissed item does not come back until the run
 * moved and stalled again. A CI wait its CI-wait question covers is left to
 * that question (yieldToCiWait). Releasing the slot resolves the item
 * (releaseLeases, src/sched/pools.ts). Call inside a transaction.
 */
export function noteValidationProgress(db: Db, run: RunWithPolicy, active: NmRun | null, nm: NmRun | null, stuckAfterMs: number, now: number): void {
  const lease = validationLease(db, run.id);
  if (!lease) return;
  if (yieldToCiWait(db, run, active, now)) return;
  const progress = judgeProgress(db, run, active, nm, lease.granted_at, stuckAfterMs, now);
  if (progress === null) return;
  const inEpisode = inStuckEpisode(db, run.id, lease.granted_at);
  if (progress.stuck && !inEpisode) {
    const event = appendEvent(db, { source: "nomistakes", kind: "run.validation_stuck", runId: run.id, taskId: run.task_id, payload: { nm_run: nm?.id ?? null, step: progress.step, quiet_ms: progress.quietMs }, ts: now });
    openItem(db, {
      kind: "validation_stuck",
      eventSeq: event.seq,
      taskId: run.task_id,
      runId: run.id,
      line: `Validation stuck: ${taskTitle(db, run.task_id)} (${run.project_id}): ${progress.detail}; flowryn show ${run.task_id}`,
      now,
    });
  } else if (!progress.stuck && inEpisode) {
    appendEvent(db, { source: "nomistakes", kind: "run.validation_moving", runId: run.id, taskId: run.task_id, payload: { nm_run: nm?.id ?? null }, ts: now });
    resolveRunItems(db, run.id, ["validation_stuck"], "step moved", now);
  }
}

function validationLease(db: Db, runId: string): { granted_at: number } | null {
  return db.query("SELECT granted_at FROM pool_leases WHERE run_id = ?1 AND pool = 'validation' AND released_at IS NULL").get(runId) as { granted_at: number } | null;
}

/** Whether the run's latest validation episode since the slot's grant is a stall (run.validation_moving or run.validation_covered end one). */
function inStuckEpisode(db: Db, runId: string, grantedAt: number): boolean {
  const last = db
    .query("SELECT kind FROM events WHERE run_id = ?1 AND kind IN ('run.validation_stuck','run.validation_moving','run.validation_covered') AND ts >= ?2 ORDER BY seq DESC LIMIT 1")
    .get(runId, grantedAt) as { kind: string } | null;
  return last?.kind === "run.validation_stuck";
}

/**
 * One alert per cause: a pipeline waiting only on CI, on the run's branch,
 * whose CI-wait question (src/lifecycle/ci-wait.ts) is open or answered for
 * this pipeline run, is that question's to report, not validation_stuck's.
 * Returns whether the stall is covered. A stall episode already open ends
 * with run.validation_covered and its item resolves naming the question; a
 * covered stall opens none. Every other no-progress case is left to
 * noteValidationProgress. Called on each status read and in the
 * transaction that opens the question. Call inside a transaction.
 */
export function yieldToCiWait(db: Db, run: Pick<RunRow, "id" | "task_id" | "branch">, nm: NmRun | null, now: number): boolean {
  if (!nm || nm.branch !== run.branch || !waitsOnlyOnCi(nm)) return false;
  const question = askedCiWait(db, run.id, nm.id);
  if (!question) return false;
  const lease = validationLease(db, run.id);
  if (lease && inStuckEpisode(db, run.id, lease.granted_at)) {
    appendEvent(db, { source: "nomistakes", kind: "run.validation_covered", runId: run.id, taskId: run.task_id, payload: { nm_run: nm.id, decision: question.id }, ts: now });
    resolveRunItems(db, run.id, ["validation_stuck"], `covered by the CI-wait question ${question.id}`, now);
  }
  return true;
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
