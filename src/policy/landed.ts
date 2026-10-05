import { isAbsolute, join } from "node:path";
import { parsePrUrl } from "../forge/github.ts";
import { ForgeError, type Forge, type PullRequest, type RepoRef } from "../forge/types.ts";

/**
 * The unlanded-work guard (design section 14, policy/cleanup-guard). Cleanup
 * removes a worktree only when its work is landed: reachable from a
 * remote-tracking branch (a fork counts); or its PR is merged and the PR head
 * contains the local work; or its content is already in an up-to-date default
 * branch (a squash merge whose branch was deleted). Uncommitted changes never
 * count. An unreachable forge with the content absent refuses. Discarding
 * needs a human-channel approval with action discard. The rules are ported
 * from the previous orchestrator's bin/fm-teardown.sh at a09090d1 and checked against the 21
 * fixtures in fixtures/cleanup-guard, which keep the previous orchestrator's case names.
 */

export type Verdict = "allow" | "refuse" | "discard";

export type ReasonClass =
  | "on_remote_tracking_branch"
  | "merged_to_local_default"
  | "merged_pr_contains_head"
  | "merged_pr_contains_patches"
  | "content_in_default"
  | "worktree_absent"
  | "scout_clean"
  | "unpushed"
  | "unlanded"
  | "not_in_merged_pr_head"
  | "forge_unreachable_content_absent"
  | "dirty"
  | "uninspectable"
  | "discard_approved";

export interface GuardInput {
  mode: "no-mistakes" | "direct-PR" | "local-only";
  kind: "ship" | "scout";
  worktree: string;
  branch: string;
  defaultBranch: string;
  /** The forge repository the PRs live in; null when there is none (local-only, or a remote that is not GitHub). */
  repo: RepoRef | null;
  recordedPrUrl: string | null;
  discardApproved: boolean;
  /** The project's primary checkout: where the run branch is judged once its worktree is gone. */
  primary?: string;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: string[], cwd: string, input?: string) => Promise<GitResult>;

export interface GuardDeps {
  git: GitRunner;
  /** Null: no forge to ask (local-only), which the verdict treats like an unreachable one. */
  forge: Forge | null;
  webUrl: string;
}

export interface GuardVerdict {
  verdict: Verdict;
  reason: ReasonClass;
  detail: string;
  /** The PR the verdict relied on (recorded, or discovered from the branch). */
  prUrl: string | null;
  /** Commits on no remote, newest first (at most 5), for a refusal's message. */
  unpushed: string[];
}

/** Untracked paths a harness may leave that are not work: Claude's own per-project directory. */
const IGNORED_UNTRACKED = /^\?\? \.claude\//;

async function out(deps: GuardDeps, cwd: string, args: string[]): Promise<string | null> {
  const result = await deps.git(args, cwd);
  return result.code === 0 ? result.stdout.trim() : null;
}

async function isAncestor(deps: GuardDeps, cwd: string, a: string, b: string): Promise<boolean> {
  return (await deps.git(["merge-base", "--is-ancestor", a, b], cwd)).code === 0;
}

/** Make sure a PR head's commit is in the local object store; GitHub keeps it at refs/pull/<n>/head. */
async function ensureCommit(deps: GuardDeps, cwd: string, sha: string, prNumber: number | null): Promise<boolean> {
  if ((await deps.git(["cat-file", "-e", `${sha}^{commit}`], cwd)).code === 0) return true;
  if (prNumber === null || (await out(deps, cwd, ["remote", "get-url", "origin"])) === null) return false;
  if ((await deps.git(["fetch", "--quiet", "origin", `refs/pull/${prNumber}/head`], cwd)).code !== 0) return false;
  return (await deps.git(["cat-file", "-e", `${sha}^{commit}`], cwd)).code === 0;
}

async function patchId(deps: GuardDeps, cwd: string, commit: string): Promise<string | null> {
  const shown = await deps.git(["show", "--pretty=medium", "--no-ext-diff", commit], cwd);
  if (shown.code !== 0) return null;
  const id = await deps.git(["patch-id", "--stable"], cwd, shown.stdout);
  if (id.code !== 0) return null;
  return id.stdout.trim().split(/\s+/)[0] || null;
}

/** The previous orchestrator's unpushed_patches_are_in_pr_head: every commit on no remote has its patch in merge-base..prHead. */
async function patchesIn(deps: GuardDeps, cwd: string, tip: string, prHead: string): Promise<boolean> {
  const base = await out(deps, cwd, ["merge-base", tip, prHead]);
  if (!base) return false;
  const inPr = await out(deps, cwd, ["log", "--format=%H", `${base}..${prHead}`, "--"]);
  if (inPr === null) return false;
  const ids = new Set<string>();
  for (const commit of inPr.split("\n").filter(Boolean)) {
    const id = await patchId(deps, cwd, commit);
    if (id) ids.add(id);
  }
  if (ids.size === 0) return false;
  const unpushed = await out(deps, cwd, ["log", "--format=%H", tip, "--not", "--remotes", "--"]);
  if (!unpushed) return false;
  for (const commit of unpushed.split("\n").filter(Boolean)) {
    const id = await patchId(deps, cwd, commit);
    if (!id || !ids.has(id)) return false;
  }
  return true;
}

/**
 * Is the branch's content already in the up-to-date default branch? Fetch
 * the default branch explicitly (a plain fetch may not refresh it), then
 * 3-way merge it with the tip: when the tip adds nothing, the merged tree
 * equals the default branch's tree. A conflict or any failure is
 * inconclusive: false.
 */
async function contentInDefault(deps: GuardDeps, cwd: string, tip: string, defaultBranch: string): Promise<boolean> {
  let ref: string;
  if ((await out(deps, cwd, ["remote", "get-url", "origin"])) !== null) {
    if ((await deps.git(["fetch", "--quiet", "origin", `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`], cwd)).code !== 0) return false;
    ref = `refs/remotes/origin/${defaultBranch}`;
  } else if ((await deps.git(["rev-parse", "--quiet", "--verify", `refs/heads/${defaultBranch}`], cwd)).code === 0) {
    ref = `refs/heads/${defaultBranch}`;
  } else return false;
  const tree = await out(deps, cwd, ["rev-parse", "--quiet", "--verify", `${ref}^{tree}`]);
  if (!tree) return false;
  const merged = await out(deps, cwd, ["merge-tree", "--write-tree", ref, tip]);
  return merged !== null && merged.split("\n")[0] === tree;
}

interface PrLookup {
  pr: PullRequest | null;
  forgeFailed: boolean;
}

/** The recorded PR, else the newest PR whose head is the task branch. A forge failure is remembered, never guessed past. */
async function findPr(deps: GuardDeps, input: GuardInput): Promise<PrLookup> {
  if (!deps.forge) return { pr: null, forgeFailed: input.recordedPrUrl !== null };
  try {
    const recorded = input.recordedPrUrl ? parsePrUrl(input.recordedPrUrl, deps.webUrl) : null;
    if (recorded) return { pr: await deps.forge.pull(recorded), forgeFailed: false };
    if (!input.repo) return { pr: null, forgeFailed: false };
    const list = await deps.forge.pullsForBranch(input.repo, input.branch);
    return { pr: list[0] ?? null, forgeFailed: false };
  } catch (error) {
    if (error instanceof ForgeError && error.kind === "not_found") return { pr: null, forgeFailed: false };
    return { pr: null, forgeFailed: true };
  }
}

function verdict(v: Verdict, reason: ReasonClass, detail: string, prUrl: string | null = null, unpushed: string[] = []): GuardVerdict {
  return { verdict: v, reason, detail, prUrl, unpushed };
}

/**
 * The worktree is gone, but its branch may still hold the only copy of the
 * work: judge the branch ref from the primary checkout by the same rules as a
 * HEAD. Only a branch that is gone too, or a scout's, has nothing to lose.
 */
async function absentWorktreeVerdict(input: GuardInput, deps: GuardDeps): Promise<GuardVerdict> {
  const gone = `${input.worktree} is not a git worktree any more`;
  if (input.kind === "scout") return verdict("allow", "worktree_absent", `${gone}; a scout delivers a report, so nothing can be lost`);
  if (!input.primary) return verdict("refuse", "uninspectable", `${gone}, and there is no primary checkout to judge branch ${input.branch} from`);
  const ref = `refs/heads/${input.branch}`;
  const found = await deps.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], input.primary);
  if (found.code === 1 && found.stdout.trim() === "") return verdict("allow", "worktree_absent", `${gone} and branch ${input.branch} is gone too; nothing can be lost`);
  if (found.code !== 0) return verdict("refuse", "uninspectable", `${gone}, and branch ${input.branch} cannot be read in ${input.primary}: ${found.stderr.trim() || `git exited ${found.code}`}`);
  const judged = await committedVerdict(input, deps, input.primary, ref);
  return { ...judged, detail: `${gone}; its branch ${input.branch}: ${judged.detail}` };
}

/** The landed-work verdict for one worktree, before any discard approval is applied. */
async function landedVerdict(input: GuardInput, deps: GuardDeps): Promise<GuardVerdict> {
  const wt = input.worktree;
  if ((await deps.git(["rev-parse", "--git-dir"], wt)).code !== 0) return absentWorktreeVerdict(input, deps);
  const status = await deps.git(["status", "--porcelain"], wt);
  if (status.code !== 0) return verdict("refuse", "uninspectable", `cannot inspect ${wt} for uncommitted changes: ${status.stderr.trim() || `git exited ${status.code}`}`);
  const dirty = status.stdout.split("\n").filter((l) => l.length > 0 && !IGNORED_UNTRACKED.test(l));
  if (dirty.length > 0) return verdict("refuse", "dirty", `uncommitted changes present in ${wt} (${dirty.length} path${dirty.length === 1 ? "" : "s"})`);
  if (input.kind === "scout") return verdict("allow", "scout_clean", "a scout delivers a report; its clean worktree holds nothing to lose");
  return committedVerdict(input, deps, wt, "HEAD");
}

/** The verdict on committed work: `tip` (HEAD in a worktree, or the branch ref) read in `cwd`. */
async function committedVerdict(input: GuardInput, deps: GuardDeps, cwd: string, tip: string): Promise<GuardVerdict> {
  const unpushedRaw = await out(deps, cwd, ["log", "--format=%h %s", tip, "--not", "--remotes", "--"]);
  if (unpushedRaw === null) return verdict("refuse", "uninspectable", `cannot inspect ${tip} in ${cwd} for commits not on a remote`);
  const unpushed = unpushedRaw.split("\n").filter(Boolean).slice(0, 5);
  if (unpushed.length === 0) return verdict("allow", "on_remote_tracking_branch", `${tip} is on a remote-tracking branch`);

  if (input.mode === "local-only") {
    const unmerged = await out(deps, cwd, ["log", "--format=%h", tip, "--not", `refs/heads/${input.defaultBranch}`, "--"]);
    if (unmerged === null) return verdict("refuse", "uninspectable", `cannot compare ${tip} in ${cwd} with local ${input.defaultBranch}`, null, unpushed);
    if (unmerged.length === 0) return verdict("allow", "merged_to_local_default", `the work is on local ${input.defaultBranch}`);
    return verdict("refuse", "unpushed", `local-only work is on no remote and not merged into local ${input.defaultBranch}`, null, unpushed);
  }

  const { pr, forgeFailed } = await findPr(deps, input);
  let mergedButNotContained = false;
  if (pr && pr.state === "merged" && pr.headSha) {
    const number = parsePrUrl(pr.url, deps.webUrl)?.number ?? pr.number;
    if (await ensureCommit(deps, cwd, pr.headSha, number)) {
      if (await isAncestor(deps, cwd, tip, pr.headSha)) return verdict("allow", "merged_pr_contains_head", `PR ${pr.url} is merged and its head contains ${tip}`, pr.url);
      if (await patchesIn(deps, cwd, tip, pr.headSha)) return verdict("allow", "merged_pr_contains_patches", `PR ${pr.url} is merged and carries every unpushed patch`, pr.url);
    }
    mergedButNotContained = true;
  }
  if (await contentInDefault(deps, cwd, tip, input.defaultBranch)) {
    return verdict("allow", "content_in_default", `the content is already in ${input.defaultBranch}`, pr?.url ?? input.recordedPrUrl);
  }
  if (forgeFailed) return verdict("refuse", "forge_unreachable_content_absent", "the forge could not be asked, and the content is not in the default branch", input.recordedPrUrl, unpushed);
  if (mergedButNotContained) return verdict("refuse", "not_in_merged_pr_head", `PR ${pr!.url} is merged, but local work is not in its head nor in ${input.defaultBranch}`, pr!.url, unpushed);
  return verdict("refuse", "unlanded", "the work is on no remote, has no merged PR, and its content is not in the default branch", pr?.url ?? input.recordedPrUrl, unpushed);
}

/**
 * The guard's verdict: landed work is allowed; unlanded work is refused, and
 * discarded only when a human-channel discard approval exists. A dirty
 * worktree always refuses without one.
 */
export async function judgeCleanup(input: GuardInput, deps: GuardDeps): Promise<GuardVerdict> {
  const landed = await landedVerdict(input, deps);
  if (landed.verdict === "refuse" && input.discardApproved) {
    return { ...landed, verdict: "discard", reason: "discard_approved", detail: `discarding: ${landed.detail} (a human approved the discard)` };
  }
  return landed;
}

/**
 * Record a PR's head (the previous orchestrator's fm-pr-check.sh): always the forge's head,
 * never the local HEAD, which can lag (a pipeline pushed follow-ups) or lead
 * (local commits the PR never got).
 */
export async function forgePrHead(prUrl: string, deps: Pick<GuardDeps, "forge" | "webUrl">): Promise<string> {
  const ref = parsePrUrl(prUrl, deps.webUrl);
  if (!ref) throw new ForgeError("protocol", `${prUrl} is not a pull request URL`);
  if (!deps.forge) throw new ForgeError("unreachable", "no forge is configured");
  return (await deps.forge.pull(ref)).headSha;
}

/** The absolute path of a worktree's git index.lock (it lives in the common dir for a linked worktree). */
export async function indexLockPath(git: GitRunner, worktree: string): Promise<string | null> {
  const result = await git(["rev-parse", "--git-path", "index.lock"], worktree);
  if (result.code !== 0) return null;
  const path = result.stdout.trim();
  if (!path) return null;
  return isAbsolute(path) ? path : join(worktree, path);
}
