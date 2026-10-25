import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * One worktree change at a time per repository, within the daemon.
 *
 * Concurrent `git worktree add` in one repository is not safe: an add lists the
 * repository's worktrees and fails on another add's half-made admin directory
 * (`fatal: failed to read .git/worktrees/wt1/commondir`). So every worktree
 * add, remove and prune the daemon runs takes this lock for its repository;
 * the steps between (a fetch, a verify's tests) run concurrently. Each git call
 * has its own deadline (runBounded), so a holder never keeps the lock forever.
 */

const tails = new Map<string, Promise<void>>();

function keyOf(repo: string): string {
  try {
    return realpathSync(repo);
  } catch {
    return resolve(repo);
  }
}

export async function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const key = keyOf(repo);
  const before = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((done) => (release = done));
  const tail = before.then(() => mine);
  tails.set(key, tail);
  await before;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
