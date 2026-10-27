import { FlowrynError } from "../api/errors.ts";
import type { Db } from "../db/db.ts";
import { tx } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { findOpenRunItem, itemLines, openItem, resolveRunItems } from "../attention/items.ts";
import { canonicalPrUrl, parsePrUrl, repoOf } from "../forge/github.ts";
import { checksLine, ForgeError, type ChecksSummary, type Forge, type PullRequest, type RepoRef } from "../forge/types.ts";
import { recordIntent } from "../journal/journal.ts";
import type { GitRunner } from "../policy/landed.ts";
import { isRoutineMerge, voidApprovals } from "../policy/approvals.ts";
import type { CleanMergeStep } from "../policy/clean-merge.ts";
import { closeDivergence, openDivergence, type DivergenceRow } from "../reconcile/divergence.ts";
import type { ProjectRow } from "./projects.ts";
import { recordEvidence, runBase, taskTitle, type RunWithPolicy } from "./runs.ts";
import { queueCarriedVerify } from "../verify/queue.ts";

/**
 * Delivery (design sections 8, 9 and 14, lifecycle/deliver). A ship ends in a
 * pull request (no-mistakes and direct-PR) or, local-only, in a branch head on
 * its own run branch. Either is verified before the run is ready:
 *
 * The named-head gate: `deliver --pr <url>` is accepted only if the PR exists
 * in the project's repository, is not a draft, is the run's branch into the
 * default branch, and its head SHA is on the remote and equals the worker's
 * HEAD, read by the daemon from the worktree, never taken from the worker. A
 * draft PR or a head that is not on the remote is also a divergence (P1): the
 * system of record contradicts what the worker claimed (section 6).
 *
 * `deliver --local` (local-only) is accepted when the worktree is clean, on
 * the run's branch, and has commits the default branch lacks.
 */

export interface Delivered {
  kind: "pr" | "local";
  /** The canonical PR URL, or the run branch for local-only work. */
  ref: string;
  head: string;
  at: number;
  /** The delivered head this one carries its standing from: it is that head plus only clean merges of main. */
  carriedFrom?: string;
}

/** The ref approvals bind to: the canonical PR URL, or `local:<branch>` for local-only work. */
export function approvalRef(d: Delivered): string {
  return d.kind === "pr" ? d.ref : `local:${d.ref}`;
}

/** The task's latest delivery, if any. */
export function deliveredOf(db: Db, taskId: string): Delivered | null {
  const row = db
    .query("SELECT kind, ref, head_sha, created_at, carried_from FROM artifacts WHERE task_id = ?1 AND kind IN ('pr','local') ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(taskId) as { kind: "pr" | "local"; ref: string; head_sha: string | null; created_at: number; carried_from: string | null } | null;
  if (!row || !row.head_sha) return null;
  return { kind: row.kind, ref: row.ref, head: row.head_sha, at: row.created_at, ...(row.carried_from ? { carriedFrom: row.carried_from } : {}) };
}

/** What the forge last said about a run's PR (run_evidence, source github, rank 1). */
export interface PrEvidence {
  url: string;
  number: number;
  title: string;
  state: PullRequest["state"];
  draft: boolean;
  head: string;
  head_ref: string;
  merge_sha: string | null;
  checks: { state: ChecksSummary["state"]; line: string; red: string[]; pending: string[]; total: number } | null;
  observed_at: number;
}

export function prEvidenceFrom(pr: PullRequest, checks: ChecksSummary | null, now: number): PrEvidence {
  return {
    url: pr.url,
    number: pr.number,
    title: pr.title,
    state: pr.state,
    draft: pr.draft,
    head: pr.headSha,
    head_ref: pr.headRef,
    merge_sha: pr.mergeSha,
    checks: checks
      ? {
          state: checks.state,
          line: checksLine(checks),
          red: checks.checks.filter((c) => c.state === "red").map((c) => c.name),
          pending: checks.checks.filter((c) => c.state === "pending").map((c) => c.name),
          total: checks.checks.length,
        }
      : null,
    observed_at: now,
  };
}

export function prEvidence(db: Db, runId: string): PrEvidence | null {
  const row = db.query("SELECT value FROM run_evidence WHERE run_id = ?1 AND source = 'github'").get(runId) as { value: string } | null;
  return row ? (JSON.parse(row.value) as PrEvidence) : null;
}

export function recordPrEvidence(db: Db, runId: string, evidence: PrEvidence, now: number): void {
  recordEvidence(db, runId, "github", 1, evidence, now);
}

/** The forge repository a project's PRs live in, from its repo URL. */
export function projectRepo(project: ProjectRow, webUrl: string): RepoRef | null {
  return project.repo_url ? repoOf(project.repo_url, webUrl) : null;
}

async function out(git: GitRunner, cwd: string, args: string[]): Promise<string | null> {
  const result = await git(args, cwd);
  return result.code === 0 ? result.stdout.trim() : null;
}

/** The SHA the remote has for a branch (`git ls-remote origin`), or null when it has none. */
export async function remoteHead(git: GitRunner, cwd: string, branch: string): Promise<string | null> {
  const listed = await out(git, cwd, ["ls-remote", "origin", `refs/heads/${branch}`]);
  if (!listed) return null;
  return listed.split(/\s+/)[0] || null;
}

export interface VerifiedPr {
  kind: "pr";
  pr: PullRequest;
  checks: ChecksSummary | null;
  url: string;
}

export interface VerifiedLocal {
  kind: "local";
  head: string;
  commits: number;
}

export interface DeliveryDeps {
  db: Db;
  git: GitRunner;
  forge: Forge;
  webUrl: string;
  now(): number;
}

function refuse(message: string, help?: string): never {
  throw new FlowrynError("delivery_refused", message, help);
}

/** Record the contradiction as a divergence (in its own transaction: the refusal that follows rolls nothing back). */
function diverge(deps: DeliveryDeps, run: RunWithPolicy, summary: string): void {
  tx(deps.db, () => openDivergence(deps.db, "github", { runId: run.id, taskId: run.task_id, higher: "github", lower: "worker", summary }, deps.now()));
}

/** The named-head gate. Async reads only; the caller records the result in one transaction. */
export async function verifyPrDelivery(deps: DeliveryDeps, run: RunWithPolicy, project: ProjectRow, rawUrl: string): Promise<VerifiedPr> {
  const ref = parsePrUrl(rawUrl, deps.webUrl);
  if (!ref) refuse(`${rawUrl} is not a pull request URL`, `deliver --pr ${deps.webUrl}/<owner>/<repo>/pull/<n>`);
  const repo = projectRepo(project, deps.webUrl);
  if (!repo) refuse(`project ${project.id} has no GitHub repository (repo URL ${project.repo_url || "none"})`, `flowryn project set ${project.id} --repo-url <url>`);
  if (repo.owner.toLowerCase() !== ref.owner.toLowerCase() || repo.repo.toLowerCase() !== ref.repo.toLowerCase()) {
    refuse(`${rawUrl} is not in the project's repository ${repo.owner}/${repo.repo}`);
  }
  let pr: PullRequest;
  try {
    pr = await deps.forge.pull(ref);
  } catch (error) {
    if (error instanceof ForgeError && error.kind === "not_found") refuse(`there is no pull request ${rawUrl}`);
    throw new FlowrynError("forge_unavailable", `cannot read ${rawUrl} from GitHub: ${(error as Error).message}`, "deliver again in a few minutes");
  }
  const url = canonicalPrUrl(ref, deps.webUrl);
  if (pr.state === "closed") refuse(`${url} is closed without being merged`);
  if (pr.draft) {
    diverge(deps, run, `deliver named ${url}, which GitHub shows as a draft`);
    throw new FlowrynError("pr_draft", `${url} is a draft`, "mark it ready for review, then deliver again");
  }
  if (pr.headRef !== run.branch) refuse(`${url} is from branch ${pr.headRef}, not this run's ${run.branch}`);
  const base = runBase(run, project);
  if (pr.baseRef !== base) refuse(`${url} targets ${pr.baseRef}, not ${base}`, run.base_branch ? `open it into ${base}: this task's base` : undefined);
  if (pr.state === "open") {
    const onRemote = await remoteHead(deps.git, run.worktree_path, pr.headRef);
    if (onRemote !== pr.headSha) {
      diverge(deps, run, `deliver named ${url} at ${pr.headSha.slice(0, 8)}, which is not the head of ${pr.headRef} on the remote (${onRemote?.slice(0, 8) ?? "absent"})`);
      throw new FlowrynError("head_not_on_remote", `the PR head ${pr.headSha.slice(0, 8)} is not what the remote has for ${pr.headRef} (${onRemote?.slice(0, 8) ?? "no such branch"})`, "push your branch, then deliver again");
    }
  }
  const local = await out(deps.git, run.worktree_path, ["rev-parse", "HEAD"]);
  if (local !== pr.headSha) {
    throw new FlowrynError(
      "head_mismatch",
      `your HEAD ${local?.slice(0, 8) ?? "(unreadable)"} is not the PR head ${pr.headSha.slice(0, 8)}`,
      `make them equal (git pull --ff-only origin ${pr.headRef}, or push), then deliver again`,
    );
  }
  let checks: ChecksSummary | null = null;
  try {
    checks = await deps.forge.checks(ref, pr.headSha);
  } catch {
    checks = null;
  }
  return { kind: "pr", pr, checks, url };
}

/** A local-only delivery: a clean worktree on the run's branch, with commits the default branch lacks. */
export async function verifyLocalDelivery(deps: DeliveryDeps, run: RunWithPolicy, project: ProjectRow): Promise<VerifiedLocal> {
  const wt = run.worktree_path;
  const branch = await out(deps.git, wt, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch !== run.branch) refuse(`the worktree is on ${branch ?? "a detached HEAD"}, not ${run.branch}`);
  const status = await deps.git(["status", "--porcelain"], wt);
  if (status.code !== 0) refuse(`cannot inspect ${wt}: ${status.stderr.trim()}`);
  const dirty = status.stdout.split("\n").filter((l) => l.length > 0 && !l.startsWith("?? .claude/"));
  if (dirty.length > 0) refuse(`the worktree has ${dirty.length} uncommitted change(s)`, "commit your work, then deliver again");
  const head = await out(deps.git, wt, ["rev-parse", "HEAD"]);
  if (!head) refuse("cannot read HEAD");
  const count = Number((await out(deps.git, wt, ["rev-list", "--count", `refs/heads/${project.default_branch}..HEAD`])) ?? "0");
  if (!(count > 0)) refuse(`the branch has no commits that ${project.default_branch} lacks`, "commit your work, then deliver again");
  return { kind: "local", head, commits: count };
}

function artifactId(now: number): string {
  return `a${now.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** The item a delivered ship opens: a P1 "PR ready", or a P0 for sensitive work that waits for a human. */
function openReadyItem(db: Db, run: RunWithPolicy, eventSeq: number, line: string, now: number): void {
  const kind = run.sensitive ? "sensitive_action_waiting" : "pr_ready";
  if (findOpenRunItem(db, kind, run.id)) {
    const lines = itemLines(line);
    db.query("UPDATE items SET line = ?3, full_line = ?4 WHERE run_id = ?1 AND kind = ?2 AND state IN ('open','presented')").run(run.id, kind, lines.line, lines.full_line);
    return;
  }
  openItem(db, { kind, eventSeq, taskId: run.task_id, runId: run.id, line, now });
}

/**
 * A new head proven to be the delivered head plus only clean merges of main
 * (src/policy/clean-merge.ts, docs/notes/2026-10-23-a-clean-merge-fm.md).
 */
export interface Carry {
  /** The delivered head the proof starts from. */
  from: string;
  steps: CleanMergeStep[];
  /** Today's verify policy of the project, or null when it has no verify steps (nothing to queue). */
  verifyPolicy: string | null;
}

/** A proof applies to routine work (yolo, not sensitive) delivered as a PR, from exactly the delivered head of the same PR. */
function carryApplies(db: Db, run: RunWithPolicy, previous: Delivered | null, ref: string, carry: Carry | null): carry is Carry {
  return carry !== null && previous !== null && previous.kind === "pr" && previous.ref === ref && previous.head === carry.from && isRoutineMerge(db, run.task_id);
}

/**
 * The carry's event, and the verify the new head still needs queued (re-verify
 * is never skipped: the merge gate wants a pass at exactly this head). Returns
 * what the ready line adds and the queued request, if one was made.
 */
function noteCarried(
  db: Db,
  run: RunWithPolicy,
  q: { ref: string; pr: PullRequest; carry: Carry; source: "cli" | "github"; via: string },
  now: number,
): { request: string | null; note: string; seq: number } {
  const to = q.pr.headSha;
  const request = q.carry.verifyPolicy
    ? queueCarriedVerify(db, { project_id: run.project_id, pr_url: q.ref, task_id: run.task_id, head_sha: to, policy_id: q.carry.verifyPolicy, pr_number: q.pr.number, head_ref: q.pr.headRef, now })
    : null;
  const event = appendEvent(db, {
    source: q.source,
    kind: "run.head_carried",
    runId: run.id,
    taskId: run.task_id,
    payload: { pr: q.ref, from: q.carry.from, to, steps: q.carry.steps, via: q.via, verify: request?.id ?? null },
    ts: now,
  });
  const note = `head ${to.slice(0, 8)} is ${q.carry.from.slice(0, 8)} plus only a clean merge of main${request ? `; verify queued (${request.id})` : ""}`;
  return { request: request?.id ?? null, note, seq: event.seq };
}

/**
 * A delivered routine PR whose head moved, on GitHub, to the delivered head
 * plus only clean merges of main: the delivery moves to the new head with no
 * worker turn. The run stays ready and its merge gate open; standing human
 * records are voided as at any new head (they bind the head you saw); the
 * verify of the new head is queued. Call inside a transaction, after
 * carryApplies held (applyPrObservation checks it).
 */
export function carryDelivery(db: Db, run: RunWithPolicy, delivered: Delivered, pr: PullRequest, checks: ChecksSummary | null, carry: Carry, now: number): { request: string | null } | null {
  if (!carryApplies(db, run, delivered, delivered.ref, carry)) return null;
  db.query("INSERT INTO artifacts (id, task_id, kind, ref, head_sha, created_at, carried_from) VALUES (?1, ?2, 'pr', ?3, ?4, ?5, ?6)").run(artifactId(now), run.task_id, delivered.ref, pr.headSha, now, delivered.head);
  voidApprovals(db, run.task_id, now, `the head moved to ${pr.headSha.slice(0, 8)} by a clean merge of main`);
  const { request, note, seq } = noteCarried(db, run, { ref: delivered.ref, pr, carry, source: "github", via: "watcher" }, now);
  const title = taskTitle(db, run.task_id);
  openReadyItem(db, run, seq, `PR ready: ${title} (${run.project_id}), ${checks ? checksLine(checks) : "checks unknown"}; ${note}`, now);
  return { request };
}

/**
 * Record a verified delivery: the artifact, run ready, the backlog link, the
 * item. `carry`: the worker delivered the delivered head plus only clean
 * merges of main; for routine work the artifact names the head it carries
 * from and the new head's verify is queued. Call inside a transaction.
 */
export function recordDelivery(db: Db, run: RunWithPolicy, verified: VerifiedPr | VerifiedLocal, via: string, now: number, carry: Carry | null = null): Record<string, unknown> {
  const previous = deliveredOf(db, run.task_id);
  const head = verified.kind === "pr" ? verified.pr.headSha : verified.head;
  const ref = verified.kind === "pr" ? verified.url : run.branch;
  const carried = verified.kind === "pr" && carryApplies(db, run, previous, ref, carry) ? carry : null;
  if (previous && previous.head !== head) voidApprovals(db, run.task_id, now, `a new head ${head.slice(0, 8)} was delivered`);
  if (!previous || previous.head !== head || previous.ref !== ref) {
    db.query("INSERT INTO artifacts (id, task_id, kind, ref, head_sha, created_at, carried_from) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").run(artifactId(now), run.task_id, verified.kind, ref, head, now, carried?.from ?? null);
  }
  db.query("UPDATE runs SET state = 'ready', updated_at = ?2 WHERE id = ?1").run(run.id, now);
  const title = taskTitle(db, run.task_id);
  let line: string;
  let queued: string | null = null;
  if (verified.kind === "pr") {
    recordPrEvidence(db, run.id, prEvidenceFrom(verified.pr, verified.checks, now), now);
    if (!previous || previous.ref !== ref) recordIntent(db, { file: "backlog", verb: "update", taskId: run.task_id, positional: [run.task_id], flags: { pr: ref }, now });
    const checks = verified.checks ? checksLine(verified.checks) : "checks unknown";
    line = run.sensitive ? `Sensitive PR waits for your approval: ${title} (${run.project_id}), ${checks}` : `PR ready: ${title} (${run.project_id}), ${checks}`;
    if (carried) {
      const noted = noteCarried(db, run, { ref, pr: verified.pr, carry: carried, source: "cli", via: "deliver" }, now);
      line += `; ${noted.note}`;
      queued = noted.request;
    }
  } else {
    line = run.sensitive
      ? `Sensitive local-only branch waits for your approval: ${title} (${run.project_id}), ${verified.commits} commit(s)`
      : `Branch ready to merge: ${title} (${run.project_id}), local-only, ${verified.commits} commit(s)`;
  }
  // A later delivery that passes settles what an earlier refused one contradicted.
  const settled = db.query("SELECT * FROM divergences WHERE run_id = ?1 AND higher = 'github' AND lower = 'worker' AND resolved_at IS NULL").all(run.id) as DivergenceRow[];
  for (const d of settled) closeDivergence(db, d, "delivered", "run.delivered", "cli", now);
  const event = appendEvent(db, {
    source: "cli",
    kind: "run.delivered",
    runId: run.id,
    taskId: run.task_id,
    payload: verified.kind === "pr"
      ? { outcome: "pr", pr: ref, head, draft: false, checks: verified.checks?.state ?? null, verified: "named-head", via }
      : { outcome: "local", branch: run.branch, head, commits: verified.commits, verified: "local", via },
    ts: now,
  });
  resolveRunItems(db, run.id, ["worker_idle", "pr_closed", "checks_red", "auto_merge_held"], "run.delivered", now);
  openReadyItem(db, run, event.seq, line, now);
  if (verified.kind === "local") return { run: run.id, state: "ready", branch: run.branch, head, commits: verified.commits };
  return { run: run.id, state: "ready", pr: ref, head, ...(carried ? { carried_from: carried.from, verify_queued: queued ?? "-" } : {}) };
}
