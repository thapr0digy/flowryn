import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { findOpenRunItem, openItem, resolveRunItems } from "../attention/items.ts";
import type { ValidationConfig } from "../config/validation.ts";
import { tx, type Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { closeCiWaits } from "../lifecycle/ci-wait.ts";
import type { ProjectRow } from "../lifecycle/projects.ts";
import { getRunWithPolicy, taskTitle, type RunWithPolicy } from "../lifecycle/runs.ts";
import { sendBack } from "../lifecycle/send-back.ts";
import { positionOf } from "../lifecycle/stages.ts";
import { createSteer } from "../lifecycle/steers.ts";
import type { GitRunner } from "../policy/landed.ts";
import { sanitizeLine } from "../util/sanitize.ts";

/**
 * Policy follow-through (task policy-follow-through-fy, phase 2 of
 * pipeline-watchdog-and-pt). A ship whose branch forked before the default
 * branch changed a policy file (`[validation] follow_paths`: its
 * `.no-mistakes.yaml` and CI workflows) validates under the old policy. Each
 * pass reads, per project, origin's default branch and the hash of its policy
 * files; a ship at its ship stage that lacks main's policy change is told to
 * merge it, once per (run, policy hash):
 *
 * - its last stage active (running or validating): one steer to merge
 *   origin/<default> with a new commit and push through no-mistakes again; an
 *   open CI-wait question on it is dismissed as superseded;
 * - delivered (`ready`): sent back as `decline` sends it (`sendBack`), with
 *   the same instruction and a `policy_sent_back` P1 info line;
 * - delivered again still behind the hash it was already told about: no
 *   second send-back; a `policy_behind` P1 info line says so.
 *
 * State-based, not merge events: a merge made on GitHub counts, and a restart
 * loses nothing (the hash is in the `run.policy_steered` event). An unrelated
 * merge leaves the hash as it was, so it steers nobody again. Plain git and
 * fixed text; no model.
 */

export const POLICY_EVENT = "run.policy_steered";

/** A pass after a landing waits this long, so the landing's own cleanup settles first. */
export const KICK_DELAY_MS = 1_000;

/** What the default branch's policy is, read at origin's tip. */
export interface PolicyTip {
  /** origin/<default>'s commit. */
  tip: string;
  /** sha256 of `git ls-tree -r <tip> -- <paths>`: the policy files' paths and blob ids. */
  hash: string;
}

/** The policy files' content hash at a commit; null when git cannot read it. */
export async function policyHash(git: GitRunner, cwd: string, rev: string, paths: readonly string[]): Promise<string | null> {
  const listed = await git(["ls-tree", "-r", rev, "--", ...paths], cwd).catch(() => null);
  if (!listed || listed.code !== 0) return null;
  return createHash("sha256").update(listed.stdout).digest("hex");
}

/**
 * The policy files the default branch changed since the worktree's branch
 * forked from it (merge-base of HEAD and `tip`, to `tip`): only main's
 * changes, never the branch's own. [] when it has them all; null when git
 * cannot tell.
 */
export async function policyChangesSince(git: GitRunner, worktree: string, tip: string, paths: readonly string[]): Promise<string[] | null> {
  const base = await git(["merge-base", "HEAD", tip], worktree).catch(() => null);
  if (!base || base.code !== 0 || !base.stdout.trim()) return null;
  const diff = await git(["diff", "--name-only", base.stdout.trim(), tip, "--", ...paths], worktree).catch(() => null);
  if (!diff || diff.code !== 0) return null;
  return diff.stdout.split("\n").filter((line) => line.length > 0);
}

/** Fetch origin's default branch from `cwd` (refs are shared by every worktree of the repository), then read its tip and policy hash. */
export async function readPolicyTip(git: GitRunner, cwd: string, branch: string, paths: readonly string[]): Promise<{ policy: PolicyTip | null; fetchError: string | null }> {
  const fetched = await git(["fetch", "--quiet", "origin", branch], cwd).catch((error: unknown) => ({ code: -1, stdout: "", stderr: String(error) }));
  // A failed fetch (a ref lock held by another fetch, no network) still reads the last fetched tip; the next pass catches up.
  const fetchError = fetched.code === 0 ? null : fetched.stderr.trim().split("\n")[0]?.slice(0, 160) || `exit ${fetched.code}`;
  const tip = await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}^{commit}`], cwd).catch(() => null);
  if (!tip || tip.code !== 0 || !tip.stdout.trim()) return { policy: null, fetchError };
  const hash = await policyHash(git, cwd, tip.stdout.trim(), paths);
  return { policy: hash ? { tip: tip.stdout.trim(), hash } : null, fetchError };
}

/** A ship at its ship stage: its last stage active (running or validating), or delivered. */
export function atShipStage(db: Db, run: RunWithPolicy): boolean {
  if (run.kind !== "ship" || run.delivery_mode !== "no-mistakes") return false;
  if (run.state === "ready") return true;
  if (run.state !== "running" && run.state !== "validating") return false;
  return run.stage_state === "active" && positionOf(db, run, run.kind).last;
}

/** The project's no-mistakes ships at their ship stage. */
export function followCandidates(db: Db, projectId: string): RunWithPolicy[] {
  const ids = db
    .query(
      `SELECT r.id FROM runs r JOIN task_policy p ON p.task_id = r.task_id
       WHERE p.project_id = ?1 AND p.kind = 'ship' AND p.delivery_mode = 'no-mistakes' AND r.state IN ('running', 'validating', 'ready')
       ORDER BY r.started_at`,
    )
    .all(projectId) as { id: string }[];
  return ids.map((r) => getRunWithPolicy(db, r.id)).filter((r): r is RunWithPolicy => r !== null && atShipStage(db, r));
}

/** Whether the run was already steered or sent back for this policy hash. */
export function actedOn(db: Db, runId: string, hash: string): boolean {
  return db.query("SELECT 1 FROM events WHERE run_id = ?1 AND kind = ?2 AND json_extract(payload, '$.hash') = ?3 LIMIT 1").get(runId, POLICY_EVENT, hash) !== null;
}

function fileList(files: readonly string[]): string {
  const shown = files.slice(0, 3).join(", ");
  return files.length > 3 ? `${shown} +${files.length - 3} more` : shown;
}

/** The instruction, live or delivered. Exposed for tests. */
export function policySteerText(files: readonly string[], tip: string, branch: string, delivered: boolean): string {
  const main = `origin/${branch}`;
  const changed = `${branch} changed its validation policy since your branch forked (${fileList(files)}; ${main} at ${tip.slice(0, 8)}).`;
  const merge = `Merge ${main} into your branch with a new commit (git fetch origin, then git merge ${main}; never rebase or force-push), run the tests`;
  if (delivered) return `Your delivered PR is behind: ${changed} ${merge}, then ship it again and deliver.`;
  return `${changed} ${merge}, then no-mistakes rerun if your pipeline is running for this branch (it validates the merged branch again), else start it as usual. Then deliver as usual.`;
}

export type FollowOutcome = "steered" | "sent_back" | "behind" | "none";

/**
 * Act on a run that lacks the default branch's policy change. Re-reads the
 * run, so a run that left its ship stage since the git reads is left alone.
 * Call inside a transaction.
 */
export function followPolicy(db: Db, runId: string, change: PolicyTip & { files: string[]; branch: string }, now: number): FollowOutcome {
  const run = getRunWithPolicy(db, runId);
  if (!run || !atShipStage(db, run)) return "none";
  const title = sanitizeLine(taskTitle(db, run.task_id), 60);
  const payload = { hash: change.hash, main: change.tip, files: change.files.slice(0, 20) };
  if (actedOn(db, run.id, change.hash)) {
    if (run.state !== "ready" || findOpenRunItem(db, "policy_behind", run.id)) return "none";
    const event = appendEvent(db, { source: "daemon", kind: "run.policy_behind", runId: run.id, taskId: run.task_id, payload, ts: now });
    openItem(db, {
      kind: "policy_behind",
      eventSeq: event.seq,
      taskId: run.task_id,
      runId: run.id,
      line: `Delivered behind ${change.branch}'s policy change (${fileList(change.files)}) it was told to merge: ${title} (${run.project_id}); merge as is, steer it, or flowryn decline ${run.task_id}`,
      now,
    });
    return "behind";
  }
  if (run.state === "ready") {
    const text = policySteerText(change.files, change.tip, change.branch, true);
    const { seq } = sendBack(
      db,
      run,
      { text, feedback: `behind ${change.branch}'s policy`, why: `${change.branch} changed its validation policy`, event: { source: "daemon", kind: POLICY_EVENT, payload: { ...payload, via: "send_back" } } },
      now,
    );
    resolveRunItems(db, run.id, ["policy_behind"], "sent back for a newer policy change", now);
    openItem(db, {
      kind: "policy_sent_back",
      eventSeq: seq,
      taskId: run.task_id,
      runId: run.id,
      line: `${change.branch} changed its validation policy (${fileList(change.files)}): ${title} (${run.project_id}) was delivered without it; sent back to merge origin/${change.branch} and deliver again`,
      now,
    });
    return "sent_back";
  }
  const steer = createSteer(db, run, policySteerText(change.files, change.tip, change.branch, false), now);
  appendEvent(db, { source: "daemon", kind: POLICY_EVENT, runId: run.id, taskId: run.task_id, payload: { ...payload, via: "steer", steer: steer.id }, ts: now });
  closeCiWaits(db, run, "superseded by the policy follow-through's steer to merge main", now, null, "policy");
  return "steered";
}

export interface FollowDeps {
  db: Db;
  config(): Pick<ValidationConfig, "follow_paths" | "follow_interval_ms">;
  now(): number;
  log(message: string): void;
  git: GitRunner;
  projects(): ProjectRow[];
  /** A ship was sent back: its last stage waits for the scheduler's grant. */
  kickScheduler(): void;
}

export interface FollowReport {
  steered: string[];
  sentBack: string[];
  behind: string[];
}

/**
 * The follow-through's loop: a pass every `[validation] follow_interval_ms`
 * (5 min), and one second after a landing (`kick`), never two at once.
 */
export class PolicyFollower {
  private readonly deps: FollowDeps;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private kickTimer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<FollowReport> | null = null;
  private rerun = false;
  private stopped = false;
  private lastFetchError = new Map<string, string>();

  constructor(deps: FollowDeps) {
    this.deps = deps;
  }

  start(): void {
    this.stopped = false;
    this.arm();
  }

  /** No new pass after this; resolves when the pass under way, if any, has ended (the daemon closes the database after). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.timer = null;
    this.kickTimer = null;
    await this.running;
  }

  /** A run landed: the default branch moved, so look soon rather than at the next tick. */
  kick(): void {
    if (this.stopped || this.kickTimer) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      void this.pass();
    }, KICK_DELAY_MS);
  }

  private arm(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pass().finally(() => this.arm());
    }, this.deps.config().follow_interval_ms);
  }

  /**
   * One pass; a pass already running is returned instead of starting another,
   * and one more pass follows it, since it may have read origin before the
   * change that asked for this one. Exposed for tests.
   */
  pass(): Promise<FollowReport> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = this.passOnce()
      .catch((error: unknown) => {
        this.deps.log(`policy follow-through: ${(error as Error).stack ?? String(error)}`);
        return { steered: [], sentBack: [], behind: [] } satisfies FollowReport;
      })
      .finally(() => {
        this.running = null;
        if (!this.rerun) return;
        this.rerun = false;
        if (!this.stopped) void this.pass();
      });
    return this.running;
  }

  private async passOnce(): Promise<FollowReport> {
    const report: FollowReport = { steered: [], sentBack: [], behind: [] };
    const paths = this.deps.config().follow_paths;
    if (paths.length === 0) return report;
    for (const project of this.deps.projects()) {
      if (this.stopped) break;
      await this.followProject(project, paths, report);
    }
    if (report.sentBack.length > 0) this.deps.kickScheduler();
    return report;
  }

  private async followProject(project: ProjectRow, paths: readonly string[], report: FollowReport): Promise<void> {
    const { db, git, now } = this.deps;
    const runs = followCandidates(db, project.id).filter((r) => existsSync(r.worktree_path));
    if (runs.length === 0) return;
    const branch = project.default_branch;
    const { policy, fetchError } = await readPolicyTip(git, runs[0]!.worktree_path, branch, paths);
    // A fetch failure is logged when it starts or changes, not every pass.
    if (fetchError !== (this.lastFetchError.get(project.id) ?? null)) {
      if (fetchError) this.deps.log(`policy follow-through: ${project.id}: git fetch origin ${branch} failed (${fetchError}); reading the last fetched tip`);
      if (fetchError) this.lastFetchError.set(project.id, fetchError);
      else this.lastFetchError.delete(project.id);
    }
    if (!policy) return;
    for (const run of runs) {
      if (this.stopped) return;
      const files = await policyChangesSince(git, run.worktree_path, policy.tip, paths);
      if (files === null) continue;
      if (files.length === 0) {
        tx(db, () => resolveRunItems(db, run.id, ["policy_behind"], "has main's policy", now()));
        continue;
      }
      const outcome = tx(db, () => followPolicy(db, run.id, { ...policy, files, branch }, now()));
      if (outcome === "none") continue;
      ({ steered: report.steered, sent_back: report.sentBack, behind: report.behind })[outcome].push(run.task_id);
      this.deps.log(`policy follow-through: ${run.task_id} lacks ${branch}'s policy change at ${policy.tip.slice(0, 8)} (${fileList(files)}): ${outcome.replace("_", " ")}`);
    }
  }
}
