import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../../src/config/config.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { gitRunner } from "../../src/policy/git.ts";
import { grantJobLease } from "../../src/sched/pools.ts";
import type { VerifyConfig } from "../../src/verify/config.ts";
import { verifyPolicyId } from "../../src/verify/policy.ts";
import { insertRequest } from "../../src/verify/queue.ts";
import { initialSteps, ownPath, pruneDirs, recoverVerifications, runVerification, slotPath, type VerifyDeps } from "../../src/verify/runner.ts";
import { admitRequest } from "../../src/verify/start.ts";
import { getVerification, insertVerification, type Verification } from "../../src/verify/store.ts";

/**
 * Reusable verify checkouts (docs/notes/2026-11-24-verifies-reuse-one-a6.md): a verification runs
 * in its project's lowest free slot, <root>/slots/<project>/<k>, reset to exactly its head before
 * the steps run and cleaned after; a slot that cannot be made clean is bypassed for a checkout of
 * its own. Real git, real worktrees, real shell steps.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    // A test leaves a read-only directory behind on purpose; make it removable.
    Bun.spawnSync(["chmod", "-R", "u+w", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
});

const CAPS = { validation: 5 };

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fl-slots-"));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

interface Fixture {
  db: Db;
  deps: VerifyDeps;
  repo: string;
  root: string;
  /** Two commits with different trees: `one` has one.txt, `two` has two.txt; both ignore .env. */
  one: string;
  two: string;
  admit(steps: string[], head: string, pr?: number): Verification;
  run(v: Verification): Promise<Verification>;
}

function fixture(): Fixture {
  const dir = tempDir();
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  writeFileSync(join(repo, ".gitignore"), ".env\n");
  writeFileSync(join(repo, "one.txt"), "1\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "one"]);
  const one = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["rm", "-q", "one.txt"]);
  writeFileSync(join(repo, "two.txt"), "2\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "two"]);
  const two = git(repo, ["rev-parse", "HEAD"]);
  const db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  const root = join(dir, "state", "verify");
  const deps: VerifyDeps = { db, git: gitRunner("git", 30_000), now: Date.now, log: () => {}, root };
  return {
    db,
    deps,
    repo,
    root,
    one,
    two,
    admit(steps, head, pr = 1) {
      return tx(db, () => {
        const config: VerifyConfig = { steps, review: null, binary: null, timeout_ms: 60_000, step_timeout_ms: null };
        const request = insertRequest(db, { project_id: "web", pr_url: `https://github.com/acme/web/pull/${pr}`, task_id: null, head_sha: head, policy_id: verifyPolicyId(config), pr_number: pr, head_ref: "flowryn/t", worktree: null, source: "auto", path: null, now: Date.now() });
        return admitRequest(db, request, config, CAPS, root, repo, Date.now());
      });
    },
    async run(v) {
      await runVerification(deps, v, { prNumber: 1, headRef: "flowryn/t", binary: null, timeoutMs: 60_000, path: null }, { PATH: process.env.PATH, HOME: process.env.HOME });
      return getVerification(db, v.id)!;
    },
  };
}

function events(db: Db, kind: string): Record<string, unknown>[] {
  return (db.query("SELECT payload FROM events WHERE kind = ?1 ORDER BY seq").all(kind) as { payload: string }[]).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
}

function releasing(f: Fixture, commands: string[]): void {
  f.deps.config = () => parseConfig(`data_dir = "/tmp/d"\nstate_dir = "/tmp/s"\n[projects.web]\nrelease = ${JSON.stringify(commands)}\n`, "/h");
}

function script(path: string, body: string): string {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** What a later verify must not find: an untracked file, an ignored secret, a nested repository, an edited tracked file. */
const LEAVE_BEHIND = "echo secret > .env && echo junk > untracked.txt && mkdir nested && git -C nested init -q && echo edited >> README.md";
/** The step that proves it is exactly a fresh checkout of `two`. */
const SEES_NOTHING = 'test ! -e .env && test ! -e untracked.txt && test ! -e nested && test ! -e one.txt && test -f two.txt && test "$(cat README.md)" = fixture && test -z "$(git status --porcelain --ignored --untracked-files=all)"';

/** Plant what a crashed verify would leave in an idle slot. */
function plant(slot: string): void {
  writeFileSync(join(slot, ".env"), "secret\n");
  writeFileSync(join(slot, "untracked.txt"), "junk\n");
  writeFileSync(join(slot, "README.md"), "edited\n");
  mkdirSync(join(slot, "nested"));
  git(join(slot, "nested"), ["init", "-q"]);
}

describe("slot checkouts", () => {
  test("assumption: two consecutive verifies of different trees share the slot's absolute path and the second sees nothing of the first", async () => {
    const f = fixture();
    const first = await f.run(f.admit([LEAVE_BEHIND], f.one));
    expect(first.state).toBe("passed");
    const second = await f.run(f.admit([SEES_NOTHING], f.two, 2));
    expect(second.state).toBe("passed");
    expect(first.worktree_path).toBe(slotPath(f.root, "web", 0));
    expect(second.worktree_path).toBe(first.worktree_path);
    // The slot stays, cleaned down to the tracked tree, for the next one.
    expect(git(second.worktree_path, ["status", "--porcelain", "--ignored", "--untracked-files=all"])).toBe("");
  }, 30_000);

  test("assumption: leftovers in an idle slot (a crash's) are reset away before the steps run", async () => {
    const f = fixture();
    const first = await f.run(f.admit(["true"], f.one));
    plant(first.worktree_path);
    const second = await f.run(f.admit([SEES_NOTHING], f.two, 2));
    expect(second).toMatchObject({ state: "passed", worktree_path: first.worktree_path });
  }, 30_000);

  test("assumption: concurrent admissions get different slots; once both end, the next takes slot 0", async () => {
    const f = fixture();
    const a = f.admit(["true"], f.one, 1);
    const b = f.admit(["true"], f.two, 2);
    expect([a.worktree_path, b.worktree_path]).toEqual([slotPath(f.root, "web", 0), slotPath(f.root, "web", 1)]);
    await Promise.all([f.run(a), f.run(b)]);
    expect(f.admit(["true"], f.one, 3).worktree_path).toBe(slotPath(f.root, "web", 0));
  }, 30_000);

  test("a crashed verify's slot is free after startup recovery and its next user resets it", async () => {
    const f = fixture();
    const slot = slotPath(f.root, "web", 0);
    const v = tx(f.db, () => {
      const row = insertVerification(f.db, { project_id: "web", pr_url: "https://github.com/acme/web/pull/1", task_id: null, head_sha: f.one, steps: initialSteps(["sleep 30"]), policy_id: verifyPolicyId({ steps: ["sleep 30"], binary: null }), dir: (id) => join(f.root, id), worktree: () => slot, project_path: f.repo, source: "cli", now: Date.now() });
      grantJobLease(f.db, { kind: "verify", id: row.id, taskId: null }, "validation", CAPS, Date.now());
      return row;
    });
    mkdirSync(v.dir, { recursive: true });
    git(f.repo, ["worktree", "add", "--detach", slot, f.one]);
    plant(slot);
    expect(await recoverVerifications(f.deps)).toBe(1);
    const next = await f.run(f.admit([SEES_NOTHING], f.two, 3));
    expect(next).toMatchObject({ state: "passed", worktree_path: slot });
  }, 30_000);

  test("a crashed verify that had fallen back to its own checkout has it removed at recovery: only a slot is resumed", async () => {
    const f = fixture();
    const v = tx(f.db, () => {
      const row = insertVerification(f.db, { project_id: "web", pr_url: "https://github.com/acme/web/pull/1", task_id: null, head_sha: f.one, steps: initialSteps(["sleep 30"]), policy_id: verifyPolicyId({ steps: ["sleep 30"], binary: null }), dir: (id) => join(f.root, id), worktree: (id) => join(f.root, id, "wt"), project_path: f.repo, source: "cli", now: Date.now() });
      grantJobLease(f.db, { kind: "verify", id: row.id, taskId: null }, "validation", CAPS, Date.now());
      return row;
    });
    mkdirSync(v.dir, { recursive: true });
    git(f.repo, ["worktree", "add", "--detach", v.worktree_path, f.one]);
    expect(await recoverVerifications(f.deps)).toBe(1);
    expect(getVerification(f.db, v.id)!.state).toBe("error");
    expect(existsSync(v.worktree_path)).toBe(false);
    expect(git(f.repo, ["worktree", "list", "--porcelain"])).not.toContain(v.worktree_path);
  }, 30_000);

  test("assumption: after a clean end the release runs only at the end of each use", async () => {
    const f = fixture();
    const out = tempDir();
    const seen = join(out, "seen.log");
    releasing(f, [script(join(out, "release"), `echo "$(pwd) $(git rev-parse HEAD)" >> ${seen}`)]);
    await f.run(f.admit(["true"], f.one));
    await f.run(f.admit(["true"], f.two, 2));
    const slot = realpathSync(slotPath(f.root, "web", 0));
    expect(readFileSync(seen, "utf8").trim().split("\n")).toEqual([`${slot} ${f.one}`, `${slot} ${f.two}`]);
  }, 30_000);

  test("a release that needs an ignored file the steps made keeps the slot from one verify to the next", async () => {
    const f = fixture();
    const out = tempDir();
    releasing(f, [script(join(out, "release"), "test -f .env")]);
    const first = await f.run(f.admit(["echo built > .env"], f.one));
    const second = await f.run(f.admit(["echo built > .env"], f.two, 2));
    expect([first.state, second.state]).toEqual(["passed", "passed"]);
    expect(second.worktree_path).toBe(slotPath(f.root, "web", 0));
    expect(events(f.db, "verify.release_failed")).toEqual([]);
    expect(events(f.db, "verify.slot_fallback")).toEqual([]);
  }, 30_000);

  test("after a failed end release the next use releases at the start, in the previous tree", async () => {
    const f = fixture();
    const out = tempDir();
    const seen = join(out, "seen.log");
    const failing = join(out, "fail");
    writeFileSync(failing, "");
    releasing(f, [script(join(out, "release"), `echo "$(git rev-parse HEAD)" >> ${seen}; test ! -e ${failing}`)]);
    await f.run(f.admit(["true"], f.one));
    rmSync(failing);
    const v = await f.run(f.admit(["true"], f.two, 2));
    expect(v.worktree_path).toBe(slotPath(f.root, "web", 0));
    expect(readFileSync(seen, "utf8").trim().split("\n")).toEqual([f.one, f.one, f.two]);
  }, 30_000);

  test("a release that fails at the start bypasses the slot: the verify runs in its own checkout, with verify.slot_fallback", async () => {
    const f = fixture();
    const out = tempDir();
    releasing(f, [script(join(out, "release"), 'echo "no such container" >&2; exit 2')]);
    await f.run(f.admit(["true"], f.one));
    const v = await f.run(f.admit([SEES_NOTHING], f.two, 2));
    expect(v.state).toBe("passed");
    expect(v.worktree_path).toBe(join(v.dir, "wt"));
    expect(existsSync(v.worktree_path)).toBe(false);
    expect(events(f.db, "verify.slot_fallback")).toEqual([{ verification: v.id, slot: slotPath(f.root, "web", 0), why: expect.stringContaining("release commands failed") }]);
  }, 30_000);

  test("assumption: a read-only leftover that git clean cannot remove gets the slot recreated, proven clean", async () => {
    const f = fixture();
    const first = await f.run(f.admit(["true"], f.one));
    mkdirSync(join(first.worktree_path, "ro", "d"), { recursive: true });
    writeFileSync(join(first.worktree_path, "ro", "d", "f"), "r\n");
    Bun.spawnSync(["chmod", "-R", "a-w", join(first.worktree_path, "ro")]);
    const second = await f.run(f.admit([`test ! -e ro && ${SEES_NOTHING}`], f.two, 2));
    expect(second).toMatchObject({ state: "passed", worktree_path: first.worktree_path });
    expect(events(f.db, "verify.slot_fallback")).toEqual([]);
  }, 30_000);

  test("a slot directory that is not a checkout of the project is recreated", async () => {
    const f = fixture();
    const slot = slotPath(f.root, "web", 0);
    mkdirSync(slot, { recursive: true });
    writeFileSync(join(slot, "stray.txt"), "x\n");
    const v = await f.run(f.admit([`test ! -e stray.txt && ${SEES_NOTHING}`], f.two));
    expect(v).toMatchObject({ state: "passed", worktree_path: slot });
  }, 30_000);

  test("assumption: a symlinked slots/<project> is refused: the verify runs in its own checkout and nothing outside the root is touched", async () => {
    const f = fixture();
    const outside = tempDir();
    mkdirSync(join(outside, "0"));
    writeFileSync(join(outside, "0", "keep.txt"), "mine\n");
    mkdirSync(join(f.root, "slots"), { recursive: true });
    symlinkSync(outside, join(f.root, "slots", "web"));
    const v = await f.run(f.admit([SEES_NOTHING], f.two));
    expect(v.state).toBe("passed");
    expect(v.worktree_path).toBe(join(v.dir, "wt"));
    expect(readFileSync(join(outside, "0", "keep.txt"), "utf8")).toBe("mine\n");
    expect(events(f.db, "verify.slot_fallback")).toEqual([{ verification: v.id, slot: slotPath(f.root, "web", 0), why: expect.stringContaining("symlink") }]);
  }, 30_000);

  test("pruning old verification directories never removes a slot", async () => {
    const f = fixture();
    const v = await f.run(f.admit(["true"], f.one));
    pruneDirs(f.deps, "web", 0);
    expect(existsSync(v.dir)).toBe(false);
    expect(existsSync(v.worktree_path)).toBe(true);
  }, 30_000);
});

describe("the cleanup guard", () => {
  test("it names a verification's own directory, its own checkout and a slot, nothing else", () => {
    const root = join(tempDir(), "verify");
    for (const ok of ["v1", "v12/wt", "slots/web/0", "slots/v12/3"]) expect(ownPath(root, join(root, ok), ok.includes("/") ? "wt" : "dir")).toBe(true);
    for (const bad of ["slots/web/0/..", "slots/../x/0", "slots/Web/0", "slots/web/x", "slots/web", "slots/web/0/wt", "v1/wt/..", "x/v1/wt"]) expect(ownPath(root, `${root}/${bad}`, "wt")).toBe(false);
    expect(ownPath(root, "/elsewhere/slots/web/0", "wt")).toBe(false);
    expect(ownPath(root, `${root}/slots/web/0`, "dir")).toBe(false);
  });

  test("assumption: a symlink anywhere below the root is refused, never followed", () => {
    const root = join(tempDir(), "verify");
    const outside = tempDir();
    mkdirSync(join(outside, "0"));
    mkdirSync(join(root, "slots", "api"), { recursive: true });
    symlinkSync(outside, join(root, "slots", "web"));
    symlinkSync(join(outside, "0"), join(root, "slots", "api", "0"));
    symlinkSync(outside, join(root, "v7"));
    expect(ownPath(root, join(root, "slots", "web", "0"), "wt")).toBe(false);
    expect(ownPath(root, join(root, "slots", "api", "0"), "wt")).toBe(false);
    expect(ownPath(root, join(root, "v7"), "dir")).toBe(false);
    expect(ownPath(root, join(root, "v7", "wt"), "wt")).toBe(false);
    // A real directory, or one not made yet, is fine.
    expect(ownPath(root, join(root, "slots", "api", "1"), "wt")).toBe(true);
  });
});
