import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectRow } from "../../src/lifecycle/projects.ts";

/**
 * Scratch git repositories for the upkeep tests: a bare origin with one
 * commit on main, a primary checkout cloned from it, and a second clone that
 * pushes what a merge on GitHub would. No global or system git config.
 */

export const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

export function sh(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdin: "ignore", env: { ...process.env, ...GIT_ENV } });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** A bare origin with one commit on main, the primary checkout and a second clone that pushes. */
export function scratchRepos(dir: string): { origin: string; primary: string; other: string } {
  const origin = join(dir, "origin.git");
  const seed = join(dir, "seed");
  sh(dir, ["init", "-q", "--bare", "-b", "main", origin]);
  sh(dir, ["init", "-q", "-b", "main", seed]);
  writeFileSync(join(seed, "a.txt"), "one\n");
  sh(seed, ["add", "."]);
  sh(seed, ["commit", "-q", "-m", "one"]);
  sh(seed, ["push", "-q", origin, "main"]);
  const primary = join(dir, "primary");
  const other = join(dir, "other");
  sh(dir, ["clone", "-q", origin, primary]);
  sh(dir, ["clone", "-q", origin, other]);
  return { origin, primary, other };
}

/** A commit on origin's main, made from the other clone: what a merge on GitHub does. */
export function mergeOnOrigin(other: string, file: string, text: string): string {
  sh(other, ["pull", "-q", "--ff-only"]);
  writeFileSync(join(other, file), text);
  sh(other, ["add", "."]);
  sh(other, ["commit", "-q", "-m", `merge ${file}`]);
  sh(other, ["push", "-q", "origin", "main"]);
  return sh(other, ["rev-parse", "HEAD"]);
}

export function projectAt(path: string, id = "web"): ProjectRow {
  return { id, repo_url: "", path, default_branch: "main", delivery_mode: "direct-PR", yolo: 0, priority: 0, harness: "claude", workflow: "", autonomy: "manual" } as ProjectRow;
}
