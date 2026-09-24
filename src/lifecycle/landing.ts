import { FlowrynError } from "../api/errors.ts";
import { findOpenRunItem, openItem, resolveRunItems } from "../attention/items.ts";
import type { CleanupConfig, GitHubConfig } from "../config/delivery.ts";
import type { Db } from "../db/db.ts";
import { tx } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import type { Forge } from "../forge/types.ts";
import { recordIntent } from "../journal/journal.ts";
import { runCleanup, type CleanupOutcome } from "../policy/cleanup.ts";
import type { GitRunner } from "../policy/landed.ts";
import { psRunner, type PsRunner } from "../runtime/proc.ts";
import { deliveredOf, projectRepo } from "./delivery.ts";
import { getProject } from "./projects.ts";
import { getRunWithPolicy, isTerminal, taskTitle, type RunWithPolicy } from "./runs.ts";

/**
 * Landing and cleanup (design sections 8 and 14). A task is landed only when
 * the merge is proven: the PR reads merged with a merge commit, or local-only
 * work is on the local default branch ("unproved merge is not landed"). A
 * landed run is cleaned up by the daemon, because the daemon proved the merge
 * itself (one of section 6's automatic actions); the cleanup guard still
 * decides. When the worktree is gone the task is done in the backlog.
 */

/** The items a landing settles. */
const SETTLED_BY_LANDING = ["pr_ready", "sensitive_action_waiting", "checks_red", "pr_closed", "unproven_merge", "worker_idle", "steer_unacked"] as const;

/** The run landed: the merge is proven. Call inside a transaction. */
export function landRun(db: Db, run: RunWithPolicy, proof: { mergeSha: string; how: "merge" | "merged_elsewhere"; mergeId?: string }, now: number): void {
  if (run.state === "landed" || isTerminal(run.state)) return;
  db.query("UPDATE runs SET state = 'landed', updated_at = ?2 WHERE id = ?1").run(run.id, now);
  resolveRunItems(db, run.id, [...SETTLED_BY_LANDING], `run.landed ${proof.mergeSha.slice(0, 8)}`, now);
  appendEvent(db, { source: proof.how === "merge" ? "daemon" : "github", kind: "run.landed", runId: run.id, taskId: run.task_id, payload: { merge_sha: proof.mergeSha, how: proof.how, merge: proof.mergeId ?? null }, ts: now });
  run.state = "landed";
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
  /** Apply the backlog intents just recorded (the task done) without waiting for the journal's next pass. */
  kickJournal(): void;
  log(line: string): void;
  now(): number;
}

export interface CleanupRequestOptions {
  /** The discard approval allowing unlanded work to go (human channel, action discard). */
  discardApproval: string | null;
  /** The daemon's own cleanup after a proven merge: a refusal is a P1 rather than an error. */
  auto: boolean;
}

export interface CleanupReport extends CleanupOutcome {
  run: string;
  task: string;
  state: string;
}

function cleanupLine(db: Db, run: RunWithPolicy, outcome: CleanupOutcome): string {
  return `Merged, but cleanup refused for ${taskTitle(db, run.task_id)} (${outcome.reason}): ${outcome.detail}; flowryn cleanup ${run.task_id}`;
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
        discardApproved: opts.discardApproval !== null,
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
    const payload = { outcome: outcome.outcome, reason: outcome.reason, detail: outcome.detail, lock: outcome.lock, aborted: outcome.aborted, reaped: outcome.reaped, branch_deleted: outcome.branchDeleted, discarded_head: outcome.discardedHead, steps: outcome.steps, auto: opts.auto };
    if (outcome.outcome === "refused") {
      db.query("UPDATE runs SET cleanup = 'refused', cleanup_detail = ?2, updated_at = ?3 WHERE id = ?1").run(run.id, `${outcome.reason}: ${outcome.detail}`, now);
      const event = appendEvent(db, { source: "daemon", kind: "cleanup.refused", runId: run.id, taskId: run.task_id, payload, ts: now });
      if (opts.auto && !findOpenRunItem(db, "cleanup_refused", run.id)) {
        openItem(db, { kind: "cleanup_refused", eventSeq: event.seq, taskId: run.task_id, runId: run.id, line: cleanupLine(db, current, outcome), now });
      }
      return;
    }
    if (opts.discardApproval) db.query("UPDATE approvals SET consumed_at = ?2 WHERE id = ?1 AND consumed_at IS NULL").run(opts.discardApproval, now);
    db.query("UPDATE runs SET cleanup = 'done', cleanup_detail = ?2, liveness = 'dead', busy_until = NULL, updated_at = ?3 WHERE id = ?1").run(run.id, outcome.reason, now);
    appendEvent(db, { source: "daemon", kind: "cleanup.done", runId: run.id, taskId: run.task_id, payload, ts: now });
    resolveRunItems(db, run.id, ["cleanup_refused"], "cleanup.done", now);
    if (current.state === "landed") {
      db.query("UPDATE runs SET state = 'cleaned', ended_at = ?2, updated_at = ?2 WHERE id = ?1").run(run.id, now);
      const merge = db.query("SELECT merge_sha FROM merges WHERE task_id = ?1 AND state = 'merged' ORDER BY proven_at DESC LIMIT 1").get(run.task_id) as { merge_sha: string | null } | null;
      const flags: Record<string, string> = delivered?.kind === "pr" ? { pr: delivered.ref } : { note: `merged into local ${project.default_branch}${merge?.merge_sha ? ` at ${merge.merge_sha.slice(0, 8)}` : ""}` };
      recordIntent(db, { file: "backlog", verb: "done", taskId: run.task_id, positional: [run.task_id], flags, now });
      resolveRunItems(db, run.id, null, "run.cleaned", now);
      const event = appendEvent(db, { source: "daemon", kind: "run.cleaned", runId: run.id, taskId: run.task_id, payload: { merge_sha: merge?.merge_sha ?? null }, ts: now });
      openItem(db, { kind: "progress", eventSeq: event.seq, taskId: run.task_id, runId: run.id, line: `Landed and cleaned: ${taskTitle(db, run.task_id)} (${run.project_id})`, now });
    }
  });
  deps.kickJournal();
  if (outcome.outcome === "removed") await deps.closeWorkspace(run.id).catch(() => undefined);
  const after = getRunWithPolicy(db, run.id);
  return { ...outcome, run: run.id, task: run.task_id, state: after?.state ?? run.state };
}
