import { join } from "node:path";

export interface GitAccess {
  /** What a commit in the linked worktree writes: the shared objects, refs and reflogs, and the worktree's own admin dir. */
  writable: string[];
  /** Never writable, even inside a writable path: git runs these unsandboxed later (hooks, and config such as core.fsmonitor). */
  readOnly: string[];
}

type Git = (args: string[]) => Promise<{ exitCode: number; stdout: string }>;

async function absolutePath(git: Git, worktree: string, flag: "--git-common-dir" | "--git-dir"): Promise<string | null> {
  const result = await git(["-C", worktree, "rev-parse", "--path-format=absolute", flag]);
  const dir = result.stdout.trim();
  return result.exitCode === 0 && dir ? dir : null;
}

/**
 * The git paths a ship worker's sandbox may write, for a commit in its linked
 * worktree (and a push's remote-tracking refs), and the ones it never may.
 * Nothing of the common dir beyond these: its hooks and config would run in
 * flowrynd's own git calls in the primary checkout.
 */
export async function shipGitAccess(git: Git, worktree: string): Promise<GitAccess> {
  const common = await absolutePath(git, worktree, "--git-common-dir");
  const own = await absolutePath(git, worktree, "--git-dir");
  if (!common || !own) return { writable: [], readOnly: [] };
  return {
    writable: [join(common, "objects"), join(common, "refs"), join(common, "logs"), join(common, "packed-refs"), join(common, "packed-refs.lock"), own],
    readOnly: [join(common, "hooks"), join(common, "config")],
  };
}
