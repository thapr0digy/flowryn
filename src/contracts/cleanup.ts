import { existsSync, realpathSync } from "node:fs";
import { sep } from "node:path";
import { randomBytes } from "node:crypto";
import { openDb } from "../db/db.ts";

/**
 * Cleanup for contract and lab runs that work in linked worktrees of a real
 * checkout (the way a Claude run can use a checkout Claude already trusts).
 * Such a run gives every branch it creates a prefix unique to the run,
 * `flowryn/contract-<runid>-`, and removes exactly the worktrees and branches
 * its own database recorded, by exact name. Anything outside that prefix or
 * outside the run's worktree root is refused, so main, fm/* and every other
 * ref are out of reach whatever the database says.
 */

export interface CreatedWorktree {
  branch: string;
  worktree: string;
}

/** A run id and the branch prefix it owns. */
export function contractPrefix(): { runId: string; prefix: string } {
  const runId = randomBytes(4).toString("hex");
  return { runId, prefix: `flowryn/contract-${runId}-` };
}

/** Every branch and worktree the runs in this scratch database created. */
export function createdWorktrees(dbPath: string): CreatedWorktree[] {
  if (!existsSync(dbPath)) return [];
  const db = openDb(dbPath, { readonly: true });
  try {
    return (db.query("SELECT branch, worktree_path FROM runs").all() as { branch: string; worktree_path: string }[]).map((r) => ({ branch: r.branch, worktree: r.worktree_path }));
  } finally {
    db.close();
  }
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export type GitRun = (args: string[], cwd: string) => { code: number; out: string };

/** Remove exactly these worktrees and branches from `checkout`, and nothing else; returns what could not be removed. */
export function removeOwnWorktrees(checkout: string, created: CreatedWorktree[], prefix: string, worktreeRoot: string, git: GitRun, log: (line: string) => void): string[] {
  if (!/^flowryn\/contract-[0-9a-f]{8}-$/.test(prefix)) throw new Error(`refusing to clean up with branch prefix ${prefix}`);
  const root = real(worktreeRoot);
  const registered = git(["worktree", "list", "--porcelain"], checkout).out;
  const failed: string[] = [];
  for (const { branch, worktree } of created) {
    if (!branch.startsWith(prefix) || branch.length === prefix.length) {
      log(`left ${branch} alone: not a branch this run owns`);
      continue;
    }
    const path = real(worktree);
    if (!inside(path, root)) {
      log(`left ${worktree} alone: outside ${worktreeRoot}`);
      continue;
    }
    // Remove the worktree only when git has it checked out on exactly this branch.
    const block = registered.split("\n\n").find((b) => b.split("\n").some((l) => l === `worktree ${path}` || l === `worktree ${worktree}`));
    const onBranch = block !== undefined && block.split("\n").includes(`branch refs/heads/${branch}`);
    if (onBranch) {
      const removed = git(["worktree", "remove", "--force", path], checkout);
      log(removed.code === 0 ? `removed worktree ${path}` : `could not remove worktree ${path}`);
      if (removed.code !== 0) failed.push(`worktree ${path} not removed`);
    }
    if (git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], checkout).code === 0) {
      const deleted = git(["branch", "-D", branch], checkout);
      log(deleted.code === 0 ? `deleted branch ${branch}` : `could not delete branch ${branch}`);
      if (deleted.code !== 0) failed.push(`branch ${branch} not deleted`);
    }
  }
  return failed;
}
