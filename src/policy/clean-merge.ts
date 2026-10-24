import type { GitRunner } from "./landed.ts";

/**
 * A head that differs from an approved one only by a clean merge of main
 * (docs/notes/2026-10-23-a-clean-merge-fm.md): proven with git, never guessed.
 * Walking the first-parent chain from the new head back to the approved one,
 * every commit must be a two-parent merge whose first parent is the step
 * before and whose second parent is already on the default branch, and git's
 * own merge of those two parents (`merge-tree --write-tree`) must finish
 * without a conflict and write exactly the commit's tree. Anything git cannot
 * confirm (a failing or cut-off call, a missing object) is not covered.
 */

/** First-parent commits a carried chain may hold; a longer one is not covered. */
export const MAX_CARRY_COMMITS = 20;

export interface CleanMergeStep {
  /** The merge commit. */
  commit: string;
  /** Its second parent: the default-branch commit it merged in. */
  main: string;
  /** The tree git's own merge wrote, equal to the commit's. */
  tree: string;
}

export type CleanMerge = { ok: true; steps: CleanMergeStep[] } | { ok: false; why: string };

export interface CleanMergeQuery {
  /** The approved (delivered) head. */
  from: string;
  /** The new head. */
  to: string;
  /** The project's default branch, read as origin/<base>. */
  base: string;
  /** The fetch of origin/<base>, with its own deadline; `git` when absent. */
  fetchGit?: GitRunner;
}

function short(sha: string): string {
  return sha.slice(0, 8);
}

function gitFailed(what: string, r: { code: number; stderr: string }): CleanMerge {
  return { ok: false, why: `git could not say: ${what} exited ${r.code}${r.stderr.trim() ? ` (${r.stderr.trim().split("\n").at(-1)})` : ""}` };
}

/** Whether `sha` is on origin/<base>, fetching the branch once when this copy does not have it yet. */
async function onBase(git: GitRunner, cwd: string, sha: string, base: string, fetchGit: GitRunner, fetched: { done: boolean }): Promise<boolean | CleanMerge> {
  const ref = `refs/remotes/origin/${base}`;
  for (;;) {
    const r = await git(["merge-base", "--is-ancestor", sha, ref], cwd);
    if (r.code === 0) return true;
    // 1: not an ancestor; 128: the ref or the commit is unknown here. Either may be a stale copy of the branch.
    if ((r.code !== 1 && r.code !== 128) || fetched.done) return r.code === 1 ? false : gitFailed(`merge-base --is-ancestor ${short(sha)} origin/${base}`, r);
    fetched.done = true;
    const f = await fetchGit(["fetch", "--quiet", "--no-tags", "origin", base], cwd);
    if (f.code !== 0) return gitFailed(`fetch origin ${base}`, f);
  }
}

/**
 * Whether `to` is `from` plus only clean merges of origin/<base>. Every git
 * call goes through the caller's bounded runner, in `cwd` (a clone that has
 * both heads).
 */
export async function cleanMainMerge(git: GitRunner, cwd: string, q: CleanMergeQuery): Promise<CleanMerge> {
  if (q.from === q.to) return { ok: false, why: "the head did not move" };
  const listed = await git(["rev-list", "--first-parent", "--parents", `--max-count=${MAX_CARRY_COMMITS + 1}`, q.to, `^${q.from}`], cwd);
  if (listed.code !== 0) return gitFailed(`rev-list ${short(q.from)}..${short(q.to)}`, listed);
  const chain = listed.stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => line.trim().split(/\s+/))
    .toReversed();
  if (chain.length === 0) return { ok: false, why: `${short(q.to)} adds nothing to ${short(q.from)}` };
  if (chain.length > MAX_CARRY_COMMITS) return { ok: false, why: `more than ${MAX_CARRY_COMMITS} commits on top of ${short(q.from)}` };
  const fetched = { done: false };
  const steps: CleanMergeStep[] = [];
  let previous = q.from;
  for (const [commit, ...parents] of chain) {
    if (!commit) continue;
    if (parents.length !== 2) return { ok: false, why: parents.length < 2 ? `${short(commit)} is not a merge` : `${short(commit)} merges ${parents.length} parents` };
    const [first, second] = parents as [string, string];
    if (first !== previous) return { ok: false, why: `${short(commit)} does not build on ${short(previous)} (its first parent is ${short(first)})` };
    const main = await onBase(git, cwd, second, q.base, q.fetchGit ?? git, fetched);
    if (main !== true) return main === false ? { ok: false, why: `${short(commit)} merges ${short(second)}, which is not on ${q.base}` } : main;
    const merged = await git(["merge-tree", "--write-tree", "--no-messages", first, second], cwd);
    if (merged.code === 1) return { ok: false, why: `${short(commit)}: merging ${q.base} has conflicts, so its resolution is new code` };
    if (merged.code !== 0) return gitFailed(`merge-tree ${short(first)} ${short(second)}`, merged);
    const tree = merged.stdout.split("\n")[0]?.trim() ?? "";
    const actual = await git(["rev-parse", `${commit}^{tree}`], cwd);
    if (actual.code !== 0) return gitFailed(`rev-parse ${short(commit)}^{tree}`, actual);
    if (tree.length === 0 || tree !== actual.stdout.trim()) return { ok: false, why: `${short(commit)} holds changes beyond the clean merge of ${q.base}` };
    steps.push({ commit, main: second, tree });
    previous = commit;
  }
  if (previous !== q.to) return { ok: false, why: `the chain from ${short(q.from)} does not end at ${short(q.to)}` };
  return { ok: true, steps };
}
