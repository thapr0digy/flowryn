import type { GitRunner } from "../policy/landed.ts";

/**
 * git's own merge of two commits written into the repository's object store
 * only (`merge-tree --write-tree`, then `commit-tree`): never into a worktree,
 * never pushed, so dropping the result rewrites nothing anyone has. Shared by
 * the landing train's candidates (src/verify/landing-queue.ts) and landing
 * batches (src/verify/landing-batch.ts). `first` is the new commit's first
 * parent, `second` its second.
 */
export type StoreMerge = { head: string } | { conflict: string[] } | { error: string };

export async function mergeInStore(git: GitRunner, cwd: string, first: string, second: string, message: string): Promise<StoreMerge> {
  const merged = await git(["merge-tree", "--write-tree", "--no-messages", "--name-only", first, second], cwd);
  if (merged.code === 1) {
    return { conflict: [...new Set(merged.stdout.split("\n").slice(1).map((f) => f.trim()).filter((f) => f.length > 0))] };
  }
  if (merged.code !== 0) return { error: `git merge-tree exited ${merged.code}: ${merged.stderr.trim()}` };
  const tree = merged.stdout.split("\n")[0]?.trim() ?? "";
  const commit = await git(["commit-tree", tree, "-p", first, "-p", second, "-m", message], cwd);
  const sha = commit.stdout.trim();
  if (commit.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) return { error: `git commit-tree failed: ${commit.stderr.trim()}` };
  return { head: sha };
}
