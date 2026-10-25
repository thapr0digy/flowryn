import { FlowrynError } from "../api/errors.ts";
import { findOpenRunItem, openItem, resolveRunItems } from "../attention/items.ts";
import type { CleanupConfig, GitHubConfig } from "../config/delivery.ts";
import type { Db } from "../db/db.ts";
import { tx } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import type { Forge } from "../forge/types.ts";
import { recordIntent } from "../journal/journal.ts";
import { consumeApproval, discardRef, insertApproval, matchAttempt } from "../policy/approvals.ts";
import { runCleanup, type CleanupOutcome } from "../policy/cleanup.ts";
import type { GitRunner } from "../policy/landed.ts";
import { psRunner, type PsRunner } from "../runtime/proc.ts";
import { deliveredOf, projectRepo } from "./delivery.ts";
import { reportLink } from "./launcher.ts";
import { getProject, type ProjectRow } from "./projects.ts";
import { failOperation, openOperation } from "./operations.ts";
import { getRunWithPolicy, isTerminal, taskTitle, type RunWithPolicy } from "./runs.ts";
import { releaseLeases } from "../sched/pools.ts";
import { closeMergeGate } from "./stages.ts";
import { dismissRunQuestions } from "./gate-questions.ts";

/**
 * Landing and cleanup (design sections 8 and 14). A task is landed only when
 * the merge is proven: the PR reads merged with a merge commit, or local-only
 * work is on the local default branch ("unproved merge is not landed"). A
 * landed run is cleaned up by the daemon, because the daemon proved the merge
 * itself (one of section 6's automatic actions); the cleanup guard still
 * decides. When the worktree is gone the task is done in the backlog.
 */

/** How a cancel that a landing overtook ends: the run is landed, nothing was cancelled. */
export const LANDED_BEFORE_CANCEL = "the run landed before the cancel took effect; the merge stands";

/** The items a landing settles. */
const SETTLED_BY_LANDING = ["user_acted", "pr_ready", "sensitive_action_waiting", "checks_red", "pr_closed", "unproven_merge", "worker_idle", "steer_unacked", "worker_report", "pr_conflict", "conflict_nudged", "policy_sent_back", "policy_behind", "review_steered", "review_unanswered"] as const;

/**
 * Who proved a landing: the leader's own merge call (its reply says it
 * landed), or anything else (your merge, the delivery watcher's later proof,
 * a merge on GitHub), which opens a landed item so the leader reports it.
 */
export type LandedBy = "leader" | "other";

export interface LandingProof {
  mergeSha: string;
  how: "merge" | "merged_elsewhere";
  mergeId?: string;
  by: LandedBy;
}

/**
 * The run landed: the merge is proven. A merge cannot be undone, so it wins
 * over a cancel still in flight: that cancel ends `failed` here, as a no-op
 * (docs/notes/2026-10-13-next-steps-md-av.md). Call inside a transaction.
 */
export function landRun(db: Db, run: RunWithPolicy, proof: LandingProof, now: number): void {
  if (run.state === "landed" || isTerminal(run.state)) return;
  db.query("UPDATE runs SET state = 'landed', updated_at = ?2 WHERE id = ?1").run(run.id, now);
  const cancel = openOperation(db, run.id);
  if (cancel?.kind === "cancel") failOperation(db, cancel.id, `${LANDED_BEFORE_CANCEL} (merge ${proof.mergeSha.slice(0, 8)})`, proof.how === "merge" ? "daemon" : "github", now);
  resolveRunItems(db, run.id, [...SETTLED_BY_LANDING], `run.landed ${proof.mergeSha.slice(0, 8)}`, now);
  const merge = proof.mergeId ? (db.query("SELECT approval_id FROM merges WHERE id = ?1").get(proof.mergeId) as { approval_id: string } | null) : null;
  closeMergeGate(db, run, { passed: true, approvalId: merge?.approval_id ?? null }, now);
  releaseLeases(db, run.id, run.task_id, { keepWorker: true }, "run.landed", now);
  const event = appendEvent(db, { source: proof.how === "merge" ? "daemon" : "github", kind: "run.landed", runId: run.id, taskId: run.task_id, payload: { merge_sha: proof.mergeSha, how: proof.how, merge: proof.mergeId ?? null, by: proof.by }, ts: now });
  if (proof.by !== "leader") openItem(db, { kind: "landed", eventSeq: event.seq, taskId: run.task_id, runId: run.id, line: landedLine(db, run, proof.mergeSha), now });
  run.state = "landed";
}

/** What a landed item tells the leader to report: the task, where it landed, and the merge commit. */
function landedLine(db: Db, run: RunWithPolicy, mergeSha: string): string {
  const delivered = deliveredOf(db, run.task_id);
  const where = delivered?.kind === "pr" ? delivered.ref : `local ${run.project_id}`;
  return `Landed: ${taskTitle(db, run.task_id)} (${run.task_id}) at ${mergeSha.slice(0, 8)}, ${where}; report it to the user`;
}

export interface LandingDeps {
  db: Db;
  forge(): Forge;
  github(): GitHubConfig;
  cleanupConfig(): CleanupConfig;
  git: GitRunner;
  lsof(): string | null;
  noMistakes(): string | null;
  ps?: PsRunner;
  /** Stop the worker's harness by its recorded identity (a no-op when none was recorded or it is gone). */
  exitWorker(runId: string): Promise<{ ok: boolean; detail: string }>;
  /** Close the run's Herdr workspace, best effort. */
  closeWorkspace(runId: string): Promise<void>;
  /** Remove the run's temp directory (src/lifecycle/run-tmp.ts); throws when it cannot. */
  removeRunTmp?(runId: string): "removed" | "absent" | "not_ours";
  /** Apply the backlog intents just recorded (the task done) without waiting for the journal's next pass. */
  kickJournal(): void;
  log(line: string): void;
  now(): number;
}

/** A Claude prompt you answered for `cleanup --discard`: the attempt its PreToolUse hook recorded. */
export interface DiscardAttempt {
  attempt: string;
  session: string;
  head: string;
}

export interface CleanupRequestOptions {
  /** The discard approval allowing unlanded work to go (human channel, action discard); used up only by a removal. */
  discardApproval: string | null;
  /** Or a matched Claude prompt, recorded as a claude-ask approval only by a removal, so a refusal leaves it usable. */
  discardAttempt?: DiscardAttempt | null;
  /** The daemon's own cleanup after a proven merge: a refusal is a P1 rather than an error. */
  auto: boolean;
  /** The upkeep sweep of an ended run's worktree (src/upkeep/sweep.ts): recorded as such; a refusal opens no item. */
  sweep?: boolean;
}

export interface CleanupReport extends CleanupOutcome {
  run: string;
  task: string;
  state: string;
}

function cleanupLine(db: Db, run: RunWithPolicy, outcome: CleanupOutcome): string {
  const what = run.kind === "scout" ? "Report delivered" : "Merged";
  return `${what}, but cleanup refused for ${taskTitle(db, run.task_id)} (${outcome.reason}): ${outcome.detail}; flowryn cleanup ${run.task_id}`;
}

/** What `done` records for a landed task (design section 8): its PR, its report (a scout), or a note naming the local merge. */
export function doneFlags(db: Db, run: Pick<RunWithPolicy, "task_id" | "kind">, project: ProjectRow | null): Record<string, string> {
  if (run.kind === "scout") return { report: reportLink(run.task_id) };
  const delivered = deliveredOf(db, run.task_id);
  if (delivered?.kind === "pr") return { pr: delivered.ref };
  const merge = db.query("SELECT merge_sha FROM merges WHERE task_id = ?1 AND state = 'merged' ORDER BY proven_at DESC LIMIT 1").get(run.task_id) as { merge_sha: string | null } | null;
  return { note: `merged into local ${project?.default_branch ?? "its default branch"}${merge?.merge_sha ? ` at ${merge.merge_sha.slice(0, 8)}` : ""}` };
}

/**
 * A scout lands with its report (design section 8): its workflow ends in no
 * gate, so the verified report is the proof, as a proven merge is a ship's.
 * The report_ready P1 stays open until the leader has read it; the daemon
 * then cleans the worktree up through the cleanup guard. Call inside a
 * transaction.
 */
export function landScout(db: Db, run: RunWithPolicy, report: string, now: number): void {
  if (run.state === "landed" || isTerminal(run.state)) return;
  db.query("UPDATE runs SET state = 'landed', updated_at = ?2 WHERE id = ?1").run(run.id, now);
  resolveRunItems(db, run.id, ["worker_idle", "steer_unacked", "worker_report"], "run.landed report", now);
  releaseLeases(db, run.id, run.task_id, { keepWorker: true }, "run.landed", now);
  appendEvent(db, { source: "daemon", kind: "run.landed", runId: run.id, taskId: run.task_id, payload: { how: "report", report }, ts: now });
  run.state = "landed";
}

/** The worker has stopped and its processes were reaped: its temp directory goes too. A failure is logged and recorded, never fails the cleanup. */
function removeTmp(deps: LandingDeps, run: RunWithPolicy): void {
  if (!deps.removeRunTmp) return;
  try {
    const removed = deps.removeRunTmp(run.id);
    if (removed === "not_ours") deps.log(`cleanup ${run.task_id}: the run's temp directory belongs to another run or home; left in place`);
  } catch (error) {
    const message = (error as Error).message;
    deps.log(`cleanup ${run.task_id}: the run's temp directory was not removed: ${message}`);
    tx(deps.db, () => appendEvent(deps.db, { source: "daemon", kind: "run.tmp_remove_failed", runId: run.id, taskId: run.task_id, payload: { error: message }, ts: deps.now() }));
  }
}

/**
 * Clean up one run's worktree with the cleanup procedure, then record the
 * result: a landed run becomes cleaned and its task done; a cancelled or
 * failed run keeps its state and only loses its worktree. A refusal changes
 * nothing but the record of it.
 */
export async function cleanupRun(deps: LandingDeps, runId: string, opts: CleanupRequestOptions): Promise<CleanupReport> {
  const { db } = deps;
  const run = getRunWithPolicy(db, runId);
  if (!run) throw new FlowrynError("not_found", `no run ${runId}`);
  const project = getProject(db, run.project_id);
  if (!project) throw new FlowrynError("not_found", `project ${run.project_id} is gone`);
  const github = deps.github();
  const delivered = deliveredOf(db, run.task_id);
  const outcome = await runCleanup(
    {
      guard: {
        mode: run.delivery_mode as "no-mistakes" | "direct-PR" | "local-only",
        kind: run.kind,
        worktree: run.worktree_path,
        branch: run.branch,
        defaultBranch: project.default_branch,
        repo: projectRepo(project, github.web_url),
        recordedPrUrl: delivered?.kind === "pr" ? delivered.ref : null,
        discardApproved: opts.discardApproval !== null || Boolean(opts.discardAttempt),
      },
      primary: project.path,
    },
    {
      git: deps.git,
      forge: run.delivery_mode === "local-only" ? null : deps.forge(),
      webUrl: github.web_url,
      lsof: deps.lsof(),
      noMistakes: deps.noMistakes(),
      ps: deps.ps ?? psRunner,
      config: deps.cleanupConfig(),
      log: (line) => deps.log(`cleanup ${run.task_id}: ${line}`),
      exitWorker: () => deps.exitWorker(run.id),
    },
  );
  const now = deps.now();
  tx(db, () => {
    const current = getRunWithPolicy(db, run.id) ?? run;
    const payload = { outcome: outcome.outcome, reason: outcome.reason, detail: outcome.detail, lock: outcome.lock, aborted: outcome.aborted, reaped: outcome.reaped, branch_deleted: outcome.branchDeleted, discarded_head: outcome.discardedHead, steps: outcome.steps, auto: opts.auto, ...(opts.sweep ? { sweep: true } : {}) };
    if (outcome.outcome === "refused") {
      db.query("UPDATE runs SET cleanup = 'refused', cleanup_detail = ?2, updated_at = ?3 WHERE id = ?1").run(run.id, `${outcome.reason}: ${outcome.detail}`, now);
      const event = appendEvent(db, { source: "daemon", kind: "cleanup.refused", runId: run.id, taskId: run.task_id, payload, ts: now });
      if (opts.auto && !findOpenRunItem(db, "cleanup_refused", run.id)) {
        openItem(db, { kind: "cleanup_refused", eventSeq: event.seq, taskId: run.task_id, runId: run.id, line: cleanupLine(db, current, outcome), now });
      }
      return;
    }
    if (opts.discardApproval) consumeApproval(db, opts.discardApproval, now, `discard ${run.task_id}`);
    if (opts.discardAttempt) {
      const { attempt, session, head } = opts.discardAttempt;
      matchAttempt(db, attempt, now);
      const made = insertApproval(db, { task: run.task_id, ref: discardRef(run), head, channel: "claude-ask", actor: `${process.env.USER ?? "you"} (Claude prompt, leader ${session})`, action: "discard", now });
      consumeApproval(db, made.id, now, `discard ${run.task_id}`);
    }
    db.query("UPDATE runs SET cleanup = 'done', cleanup_detail = ?2, liveness = 'dead', busy_until = NULL, updated_at = ?3 WHERE id = ?1").run(run.id, outcome.reason, now);
    appendEvent(db, { source: "daemon", kind: "cleanup.done", runId: run.id, taskId: run.task_id, payload, ts: now });
    dismissRunQuestions(db, current, now, "run ended", "daemon");
    resolveRunItems(db, run.id, ["cleanup_refused"], "cleanup.done", now);
    if (current.state === "landed") {
      db.query("UPDATE runs SET state = 'cleaned', ended_at = ?2, updated_at = ?2, pending_launch = NULL WHERE id = ?1").run(run.id, now);
      releaseLeases(db, run.id, run.task_id, { keepWorker: false }, "run.cleaned", now);
      const flags = doneFlags(db, run, project);
      recordIntent(db, { file: "backlog", verb: "done", taskId: run.task_id, positional: [run.task_id], flags, now });
      // A scout's report stays to be read: its report_ready P1 closes only once the leader has read it (design section 9).
      // A landed item stays too: the leader reports the landing, then dismisses it.
      db.query("UPDATE items SET state = 'resolved', resolved_by = 'run.cleaned', resolved_at = ?2 WHERE run_id = ?1 AND state IN ('open','presented') AND kind NOT IN (?3, 'landed')").run(
        run.id,
        now,
        run.kind === "scout" ? "report_ready" : "",
      );
      const merge = db.query("SELECT merge_sha FROM merges WHERE task_id = ?1 AND state = 'merged' ORDER BY proven_at DESC LIMIT 1").get(run.task_id) as { merge_sha: string | null } | null;
      const event = appendEvent(db, { source: "daemon", kind: "run.cleaned", runId: run.id, taskId: run.task_id, payload: { merge_sha: merge?.merge_sha ?? null, ...flags }, ts: now });
      openItem(db, { kind: "progress", eventSeq: event.seq, taskId: run.task_id, runId: run.id, line: `${run.kind === "scout" ? "Report landed" : "Landed"} and cleaned: ${taskTitle(db, run.task_id)} (${run.project_id})`, now });
    }
  });
  deps.kickJournal();
  if (outcome.outcome === "removed") {
    removeTmp(deps, run);
    await deps.closeWorkspace(run.id).catch(() => undefined);
  }
  const after = getRunWithPolicy(db, run.id);
  return { ...outcome, run: run.id, task: run.task_id, state: after?.state ?? run.state };
}
