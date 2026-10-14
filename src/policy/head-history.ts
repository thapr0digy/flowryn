import type { GitRunner } from "./landed.ts";

/**
 * How a delivered PR's head moved: the new head `descends` from the delivered
 * one (commits added on top), or history was `rewritten` (a rebase and a
 * force-push: no-mistakes' CI conflict repair does this), or `unknown` when
 * git cannot say (an object it cannot fetch, a failing or cut-off call).
 */
export type HeadHistory = "descends" | "rewritten" | "unknown";

async function hasCommit(git: GitRunner, cwd: string, sha: string): Promise<boolean> {
  return (await git(["cat-file", "-e", `${sha}^{commit}`], cwd)).code === 0;
}

/**
 * One ancestry check, through the caller's bounded GitRunner: the new head is
 * fetched from GitHub's `refs/pull/<n>/head` first when this copy lacks it
 * (a force-pushed head never came through the worktree). `merge-base
 * --is-ancestor` exits 0 for an ancestor and 1 for none; anything else is unknown.
 */
export async function headHistory(git: GitRunner, cwd: string, delivered: string, head: string, prNumber: number | null): Promise<HeadHistory> {
  if (!(await hasCommit(git, cwd, delivered))) return "unknown";
  if (!(await hasCommit(git, cwd, head))) {
    if (prNumber === null || (await git(["fetch", "--quiet", "--no-tags", "origin", `refs/pull/${prNumber}/head`], cwd)).code !== 0) return "unknown";
    if (!(await hasCommit(git, cwd, head))) return "unknown";
  }
  const verdict = await git(["merge-base", "--is-ancestor", delivered, head], cwd);
  return verdict.code === 0 ? "descends" : verdict.code === 1 ? "rewritten" : "unknown";
}
