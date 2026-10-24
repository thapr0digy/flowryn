import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanMainMerge, MAX_CARRY_COMMITS } from "../../src/policy/clean-merge.ts";
import { gitRunner } from "../../src/policy/git.ts";
import type { GitRunner } from "../../src/policy/landed.ts";
import { GIT_ENV, mergeOnOrigin, scratchRepos, sh } from "../helpers/scratch-git.ts";

/**
 * "Only a clean merge of main", proven with git against scratch repositories
 * (docs/notes/2026-10-23-a-clean-merge-fm.md): each case is a head a worker,
 * the leader or GitHub's update button could push, and whether it carries.
 */

let dir: string;
let primary: string;
let other: string;
let approved: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-clean-merge-"));
  ({ primary, other } = scratchRepos(dir));
  sh(primary, ["switch", "-q", "-c", "ship"]);
  approved = commit(primary, "fix.txt", "fixed\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function commit(cwd: string, file: string, text: string): string {
  writeFileSync(join(cwd, file), text);
  sh(cwd, ["add", "."]);
  sh(cwd, ["commit", "-q", "-m", file]);
  return sh(cwd, ["rev-parse", "HEAD"]);
}

/** `git merge origin/main` into the checked-out branch, the way a worker is told to. */
function mergeMain(cwd: string): string {
  sh(cwd, ["fetch", "-q", "origin"]);
  sh(cwd, ["merge", "-q", "--no-edit", "origin/main"]);
  return sh(cwd, ["rev-parse", "HEAD"]);
}

const git = (): GitRunner => gitRunner("git", 10_000, GIT_ENV);
const prove = (to: string, from = approved, cwd = primary, runner = git(), fetchGit?: GitRunner) => cleanMainMerge(runner, cwd, { from, to, base: "main", ...(fetchGit ? { fetchGit } : {}) });

describe("a clean merge of main", () => {
  test("assumption 1: git's merge-tree writes the same tree as git merge, so a worker's clean merge of main carries", async () => {
    const main = mergeOnOrigin(other, "main.txt", "main moved\n");
    const head = mergeMain(primary);
    const proof = await prove(head);
    expect(proof).toEqual({ ok: true, steps: [{ commit: head, main, tree: sh(primary, ["rev-parse", `${head}^{tree}`]) }] });
  });

  test("two clean merges in a row carry: both are only main", async () => {
    mergeOnOrigin(other, "main.txt", "main moved\n");
    const first = mergeMain(primary);
    mergeOnOrigin(other, "main2.txt", "main moved again\n");
    const second = mergeMain(primary);
    const proof = await prove(second);
    expect(proof.ok).toBe(true);
    expect(proof.ok && proof.steps.map((s) => s.commit)).toEqual([first, second]);
  });

  test("the second parent may be any commit already on main, not only its tip", async () => {
    const older = mergeOnOrigin(other, "main.txt", "main moved\n");
    mergeOnOrigin(other, "main2.txt", "and again\n");
    sh(primary, ["fetch", "-q", "origin"]);
    sh(primary, ["merge", "-q", "--no-edit", older]);
    const proof = await prove(sh(primary, ["rev-parse", "HEAD"]));
    expect(proof.ok && proof.steps[0]!.main).toBe(older);
  });

  test("main not yet in this copy: one fetch of origin's main, then it carries", async () => {
    // A clone made before main moved, that receives the new head from the PR branch alone.
    const stale = join(dir, "stale");
    sh(dir, ["clone", "-q", join(dir, "origin.git"), stale]);
    mergeOnOrigin(other, "main.txt", "main moved\n");
    const head = mergeMain(primary);
    sh(primary, ["push", "-q", "origin", "ship"]);
    sh(stale, ["fetch", "-q", "origin", "ship"]);
    const fetches: string[][] = [];
    const fetchGit: GitRunner = (args, cwd) => {
      fetches.push(args);
      return git()(args, cwd);
    };
    const proof = await prove(head, approved, stale, git(), fetchGit);
    expect(proof.ok).toBe(true);
    expect(fetches).toEqual([["fetch", "--quiet", "--no-tags", "origin", "main"]]);
  });
});

describe("not a clean merge of main: today's path", () => {
  test("a merge whose conflicts were resolved by hand is new code", async () => {
    mergeOnOrigin(other, "fix.txt", "main's version\n");
    sh(primary, ["fetch", "-q", "origin"]);
    expect(Bun.spawnSync(["git", "merge", "-q", "--no-edit", "origin/main"], { cwd: primary, env: { ...process.env, ...GIT_ENV } }).exitCode).not.toBe(0);
    writeFileSync(join(primary, "fix.txt"), "resolved\n");
    sh(primary, ["add", "."]);
    sh(primary, ["commit", "-q", "--no-edit"]);
    const proof = await prove(sh(primary, ["rev-parse", "HEAD"]));
    expect(proof).toMatchObject({ ok: false });
    expect(!proof.ok && proof.why).toContain("has conflicts");
  });

  test("a clean merge that also slips in an edit (an evil merge) does not carry", async () => {
    mergeOnOrigin(other, "main.txt", "main moved\n");
    sh(primary, ["fetch", "-q", "origin"]);
    sh(primary, ["merge", "-q", "--no-commit", "--no-ff", "origin/main"]);
    writeFileSync(join(primary, "a.txt"), "quietly changed\n");
    sh(primary, ["add", "."]);
    sh(primary, ["commit", "-q", "--no-edit"]);
    const proof = await prove(sh(primary, ["rev-parse", "HEAD"]));
    expect(!proof.ok && proof.why).toContain("holds changes beyond the clean merge of main");
  });

  test("a merge of a branch that is not main does not carry", async () => {
    sh(other, ["switch", "-q", "-c", "side"]);
    commit(other, "side.txt", "side\n");
    sh(other, ["push", "-q", "origin", "side"]);
    sh(primary, ["fetch", "-q", "origin"]);
    sh(primary, ["merge", "-q", "--no-edit", "origin/side"]);
    const proof = await prove(sh(primary, ["rev-parse", "HEAD"]));
    expect(!proof.ok && proof.why).toContain("which is not on main");
  });

  test("main as the first parent (the branch merged into main) does not carry", async () => {
    mergeOnOrigin(other, "main.txt", "main moved\n");
    sh(primary, ["fetch", "-q", "origin"]);
    sh(primary, ["switch", "-q", "--detach", "origin/main"]);
    sh(primary, ["merge", "-q", "--no-edit", approved]);
    // Walking first parents from the head goes down main's own history, whose oldest new commit is main's, not a merge.
    const proof = await prove(sh(primary, ["rev-parse", "HEAD"]));
    expect(!proof.ok && proof.why).toMatch(/is not a merge|does not build on/);
  });

  test("an octopus merge does not carry", async () => {
    sh(other, ["switch", "-q", "-c", "side"]);
    commit(other, "side.txt", "side\n");
    sh(other, ["push", "-q", "origin", "side"]);
    sh(other, ["switch", "-q", "main"]);
    mergeOnOrigin(other, "main.txt", "main moved\n");
    sh(primary, ["fetch", "-q", "origin"]);
    sh(primary, ["merge", "-q", "--no-edit", "origin/main", "origin/side"]);
    const proof = await prove(sh(primary, ["rev-parse", "HEAD"]));
    expect(!proof.ok && proof.why).toContain("merges 3 parents");
  });

  test("a clean merge followed by an own commit does not carry", async () => {
    mergeOnOrigin(other, "main.txt", "main moved\n");
    mergeMain(primary);
    const own = commit(primary, "more.txt", "more\n");
    const proof = await prove(own);
    expect(!proof.ok && proof.why).toContain("is not a merge");
  });

  test("rewritten history (a rebase onto main) does not carry", async () => {
    mergeOnOrigin(other, "main.txt", "main moved\n");
    sh(primary, ["fetch", "-q", "origin"]);
    sh(primary, ["rebase", "-q", "origin/main"]);
    const proof = await prove(sh(primary, ["rev-parse", "HEAD"]));
    expect(proof.ok).toBe(false);
  });

  test(`more than ${MAX_CARRY_COMMITS} commits on top is not looked at`, async () => {
    let head = approved;
    for (let i = 0; i <= MAX_CARRY_COMMITS; i++) {
      mergeOnOrigin(other, `m${i}.txt`, `${i}\n`);
      head = mergeMain(primary);
    }
    const proof = await prove(head);
    expect(!proof.ok && proof.why).toContain(`more than ${MAX_CARRY_COMMITS} commits`);
  });

  test("git that cannot say is never a yes: a cut-off merge-tree, a missing head", async () => {
    mergeOnOrigin(other, "main.txt", "main moved\n");
    const head = mergeMain(primary);
    const cutOff: GitRunner = async (args, cwd) => (args[0] === "merge-tree" ? { code: 124, stdout: "", stderr: "timed out" } : git()(args, cwd));
    const proof = await prove(head, approved, primary, cutOff);
    expect(!proof.ok && proof.why).toContain("git could not say: merge-tree");
    const missing = await prove("0123456789abcdef0123456789abcdef01234567");
    expect(!missing.ok && missing.why).toContain("git could not say: rev-list");
    expect((await prove(approved)).ok).toBe(false);
  });
});
