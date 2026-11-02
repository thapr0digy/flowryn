import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brokenGitLink, relinkHint } from "../../src/lifecycle/relink.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "relink-")));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdin: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  return { code: r.exitCode, out: r.stdout.toString().trim() };
}

/** A checkout with one commit and a linked worktree on branch b. */
function repoWithWorktree(root: string): { repo: string; worktree: string } {
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "a"]);
  const worktree = join(root, "wt");
  expect(git(repo, ["worktree", "add", "-q", "-b", "b", worktree]).code).toBe(0);
  return { repo, worktree };
}

describe("brokenGitLink", () => {
  test("null for a linked worktree, a primary checkout and a folder with no .git", () => {
    const root = scratch();
    const { repo, worktree } = repoWithWorktree(root);
    expect(brokenGitLink(worktree)).toBeNull();
    expect(brokenGitLink(repo)).toBeNull();
    expect(brokenGitLink(root)).toBeNull();
  });

  test("names the missing admin dir once the checkout moved, absolute or relative", () => {
    const root = scratch();
    const { repo, worktree } = repoWithWorktree(root);
    renameSync(repo, join(root, "moved"));
    expect(brokenGitLink(worktree)).toBe(join(repo, ".git", "worktrees", "wt"));
    writeFileSync(join(worktree, ".git"), "gitdir: ../gone/.git/worktrees/wt\n");
    expect(brokenGitLink(worktree)).toBe(join(root, "gone", ".git", "worktrees", "wt"));
  });
});

describe("assumption: git worktree repair in the moved checkout relinks both directions", () => {
  test("after the checkout moves, repair with the worktree's path makes it readable and points the admin dir back at it", () => {
    const root = scratch();
    const { repo, worktree } = repoWithWorktree(root);
    const moved = join(root, "elsewhere", "repo");
    mkdirSync(join(root, "elsewhere"));
    renameSync(repo, moved);
    expect(git(worktree, ["rev-parse", "HEAD"]).code).not.toBe(0);
    expect(git(moved, ["worktree", "repair", worktree]).code).toBe(0);
    expect(git(worktree, ["rev-parse", "HEAD"]).code).toBe(0);
    expect(realpathSync(git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).out)).toBe(join(moved, ".git"));
    expect(readFileSync(join(moved, ".git", "worktrees", "wt", "gitdir"), "utf8").trim()).toBe(join(worktree, ".git"));
    // Idempotent: a second repair over a linked worktree succeeds and changes nothing.
    expect(git(moved, ["worktree", "repair", worktree]).code).toBe(0);
    expect(brokenGitLink(worktree)).toBeNull();
  });
});

describe("relinkHint", () => {
  test("relinks from the checkout when it is there, else asks for the new path", () => {
    const root = scratch();
    const { repo, worktree } = repoWithWorktree(root);
    expect(relinkHint({ id: "web", path: repo }, worktree)).toContain(`git -C ${repo} worktree repair ${worktree}`);
    expect(relinkHint({ id: "web", path: join(root, "nope") }, worktree)).toContain("flowryn project set web --path <its new path>");
  });
});
