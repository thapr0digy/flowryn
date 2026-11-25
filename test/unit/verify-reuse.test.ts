import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../../src/config/config.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { gitRunner } from "../../src/policy/git.ts";
import { grantJobLease } from "../../src/sched/pools.ts";
import { baseKey } from "../../src/verify/changed.ts";
import { lightVerifyConfig, verifyConfig, type VerifyConfig } from "../../src/verify/config.ts";
import { verifyPolicyId } from "../../src/verify/policy.ts";
import { initialSteps, runVerification, type VerifyDeps } from "../../src/verify/runner.ts";
import { getVerification, insertVerification, passedAtTree, verificationLine, type Verification } from "../../src/verify/store.ts";

/**
 * A verify reuses a pass at the same tree (docs/notes/2026-11-25-skip-a-batch-z7.md): only
 * the same project, policy, head tree and base reuse; anything else runs its steps.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function git(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: ENV });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

interface Fixture {
  db: Db;
  deps: VerifyDeps;
  repo: string;
  /** The branch's head: one commit on main. */
  head: string;
  /** Lines each step run appended: one per step that really ran. */
  runs(): number;
  config(extra?: string): VerifyConfig;
  run(cfg: VerifyConfig, opts?: { head?: string; base?: string | null; binary?: string | null }): Promise<Verification>;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "fl-verify-reuse-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(repo, ["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(repo, "app.txt"), "change\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "change"]);
  const head = git(repo, ["rev-parse", "HEAD"]);
  const counter = join(dir, "runs");
  const db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  db.exec(`INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', 'https://github.com/acme/web.git', '${repo}', 'main', 'direct-PR')`);
  const root = join(dir, "state", "verify");
  const deps: VerifyDeps = { db, git: gitRunner("git", 30_000), now: Date.now, log: () => {}, root };
  return {
    db,
    deps,
    repo,
    head,
    runs: () => (existsSync(counter) ? readFileSync(counter, "utf8").split("\n").filter(Boolean).length : 0),
    config(extra = "") {
      const text = `[projects.web]\nverify = ["echo fmt >> ${counter}", { run = "echo changed >> ${counter}", when_changed = ["**"] }]\nlanding = "batch"\nlight_verify = ["echo light >> ${counter}"]\n${extra}`;
      return verifyConfig(parseConfig(text, "/h"), "web")!;
    },
    async run(cfg, opts = {}) {
      const v = tx(db, () => {
        const row = insertVerification(db, {
          project_id: "web",
          pr_url: "https://github.com/acme/web/pull/1",
          task_id: null,
          head_sha: opts.head ?? head,
          steps: initialSteps(cfg.steps, cfg.when_changed),
          policy_id: verifyPolicyId(cfg),
          dir: (id) => join(root, id),
          worktree: (id) => join(root, id, "wt"),
          project_path: repo,
          source: "cli",
          now: Date.now(),
        });
        grantJobLease(db, { kind: "verify", id: row.id, taskId: null }, "validation", { validation: 5 }, Date.now());
        return row;
      });
      const plan = { prNumber: 1, headRef: "feature", binary: opts.binary ?? null, timeoutMs: 60_000, path: null, base: opts.base === undefined ? "main" : opts.base };
      await runVerification(deps, v, plan, { PATH: process.env.PATH, HOME: process.env.HOME });
      return getVerification(db, v.id)!;
    },
  };
}

/** A commit with the same tree and parent as `commit`, but another message: a batch rebuilt after a split. */
function sameTreeCommit(repo: string, commit: string): string {
  return git(repo, ["commit-tree", `${commit}^{tree}`, "-p", `${commit}^`, "-m", "rebuilt"]);
}

/** Move a branch of the fixture to a new commit with one more file. */
function moveBranch(repo: string, ref: string): void {
  const tree = git(repo, ["rev-parse", `${ref}^{tree}`]);
  writeFileSync(join(repo, "other.txt"), "main moved\n");
  const blob = git(repo, ["hash-object", "-w", "other.txt"]);
  rmSync(join(repo, "other.txt"));
  const idx = join(repo, ".git", "tmp-index");
  const env = { ...ENV, GIT_INDEX_FILE: idx };
  Bun.spawnSync(["git", "read-tree", tree], { cwd: repo, env });
  Bun.spawnSync(["git", "update-index", "--add", "--cacheinfo", `100644,${blob},other.txt`], { cwd: repo, env });
  const next = Bun.spawnSync(["git", "write-tree"], { cwd: repo, env }).stdout.toString().trim();
  rmSync(idx, { force: true });
  git(repo, ["update-ref", ref, git(repo, ["commit-tree", next, "-p", ref, "-m", "main moved"])]);
}

describe("reusing a pass at the same tree", () => {
  test("same tree, steps and base: the second verify passes without running a step and names the first", async () => {
    const f = fixture();
    const cfg = f.config();
    const first = await f.run(cfg);
    expect(first.state).toBe("passed");
    expect(first.tree_sha).toBe(git(f.repo, ["rev-parse", `${f.head}^{tree}`]));
    expect(first.reused_from).toBeNull();
    expect(f.runs()).toBe(2);

    // A rebuilt batch: another commit, the same tree on the same parent.
    const second = await f.run(cfg, { head: sameTreeCommit(f.repo, f.head) });
    expect(second.state).toBe("passed");
    expect(second.reused_from).toBe(first.id);
    expect(f.runs()).toBe(2);
    expect(second.steps.map((s) => s.state)).toEqual(["passed", "passed"]);
    expect(second.steps.every((s) => s.detail?.startsWith(`reused from ${first.id}`))).toBe(true);
    expect(second.detail).toContain(`reused ${first.id}`);
    expect(verificationLine(second)).toContain(`reused ${first.id}`);
    const event = f.db.query("SELECT payload FROM events WHERE kind = 'pr.verified' AND json_extract(payload, '$.verification') = ?1").get(second.id) as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ state: "passed", ok: true, reused_from: first.id });

    // A third reuses too and names the verification that ran the steps, not the one that reused them.
    const third = await f.run(cfg);
    expect(third.reused_from).toBe(first.id);
    expect(third.steps.map((s) => s.detail?.split(`reused from ${first.id}`).length)).toEqual([2, 2]);
    expect(f.runs()).toBe(2);
  });

  test("a different tree runs its steps", async () => {
    const f = fixture();
    const cfg = f.config();
    await f.run(cfg);
    writeFileSync(join(f.repo, "app.txt"), "another change\n");
    git(f.repo, ["commit", "-q", "-am", "more"]);
    const other = await f.run(cfg, { head: git(f.repo, ["rev-parse", "HEAD"]) });
    expect(other.state).toBe("passed");
    expect(other.reused_from).toBeNull();
    expect(f.runs()).toBe(4);
  });

  test("different steps at the same tree run", async () => {
    const f = fixture();
    await f.run(f.config());
    const changedSteps = verifyConfig(parseConfig(`[projects.web]\nverify = ["true", "echo fmt >> ${join(f.repo, "..", "runs")}"]\n`, "/h"), "web")!;
    const other = await f.run(changedSteps);
    expect(other.reused_from).toBeNull();
    expect(f.runs()).toBe(3);
  });

  test("a different base for a changed-only step runs: local main moved", async () => {
    const f = fixture();
    const cfg = f.config();
    await f.run(cfg);
    moveBranch(f.repo, "refs/heads/main");
    const other = await f.run(cfg);
    expect(other.reused_from).toBeNull();
    expect(f.runs()).toBe(4);
  });

  test("a different base runs: only origin's copy of main moved", async () => {
    const f = fixture();
    const cfg = f.config();
    await f.run(cfg);
    moveBranch(f.repo, "refs/remotes/origin/main");
    const other = await f.run(cfg);
    expect(other.reused_from).toBeNull();
    expect(f.runs()).toBe(4);
  });

  test("a light pass does not satisfy a full verify, nor a full pass a light one", async () => {
    const f = fixture();
    const full = f.config();
    const light = lightVerifyConfig(full)!;
    const lightPass = await f.run(light, { base: null });
    expect(lightPass.state).toBe("passed");
    const fullRun = await f.run(full, { base: null });
    expect(fullRun.reused_from).toBeNull();
    expect(f.runs()).toBe(3);
    const lightAgain = await f.run(light, { base: null });
    expect(lightAgain.reused_from).toBe(lightPass.id);
    expect(f.runs()).toBe(3);
  });

  test("a failed verify is never reused", async () => {
    const f = fixture();
    const failing = verifyConfig(parseConfig(`[projects.web]\nverify = ["echo x >> ${join(f.repo, "..", "runs")} && false"]\n`, "/h"), "web")!;
    expect((await f.run(failing)).state).toBe("failed");
    const again = await f.run(failing);
    expect(again.state).toBe("failed");
    expect(again.reused_from).toBeNull();
    expect(f.runs()).toBe(2);
  });

  test("a base that moved during the run records no key, so nothing reuses that pass", async () => {
    const f = fixture();
    const moves = verifyConfig(parseConfig(`[projects.web]\nverify = ["git -C ${f.repo} update-ref refs/heads/main refs/heads/feature"]\n`, "/h"), "web")!;
    const first = await f.run(moves);
    expect(first.state).toBe("passed");
    expect(first.tree_sha).toBeNull();
    const second = await f.run(moves);
    expect(second.reused_from).toBeNull();
  });

  test("a pass whose binary is gone is not reused; one whose binary is kept copies it", async () => {
    const f = fixture();
    const cfg = verifyConfig(parseConfig(`[projects.web]\nverify = ["echo b >> ${join(f.repo, "..", "runs")} && mkdir -p dist && printf bin > dist/app"]\nverify_binary = "dist/app"\n`, "/h"), "web")!;
    const first = await f.run(cfg, { binary: "dist/app" });
    expect(first.binary_path).not.toBeNull();
    const second = await f.run(cfg, { binary: "dist/app" });
    expect(second.reused_from).toBe(first.id);
    expect(readFileSync(second.binary_path!, "utf8")).toBe("bin");
    rmSync(first.binary_path!);
    rmSync(second.binary_path!);
    const third = await f.run(cfg, { binary: "dist/app" });
    expect(third.reused_from).toBeNull();
    expect(f.runs()).toBe(2);
  });

  test("a flake rerun's pass, which ran only the failed tests, is never offered", () => {
    const f = fixture();
    const cfg = f.config();
    const policy = verifyPolicyId(cfg);
    const key = { tree: "t1", base: "b1" };
    const steps = initialSteps(cfg.steps, cfg.when_changed).map((s) => ({ ...s, state: "passed" as const }));
    const insert = (rerun: boolean) => {
      const v = tx(f.db, () =>
        insertVerification(f.db, { project_id: "web", pr_url: "lb:1", task_id: null, head_sha: "h", steps: rerun ? [{ ...steps[0]!, rerun: { of: "v0", command: "x", passes: 3, tests: [] } }, steps[1]!] : steps, policy_id: policy, dir: () => "/d", worktree: () => "/d/wt", project_path: f.repo, source: "cli", now: 1 }),
      );
      f.db.query("UPDATE verifications SET state = 'passed', tree_sha = 't1', base_key = 'b1', finished_at = ?2 WHERE id = ?1").run(v.id, rerun ? 3 : 2);
      return v.id;
    };
    const full = insert(false);
    insert(true);
    expect(passedAtTree(f.db, "web", policy, key, "v99")?.id).toBe(full);
    expect(passedAtTree(f.db, "web", policy, { ...key, base: "b2" }, "v99")).toBeNull();
    expect(passedAtTree(f.db, "other", policy, key, "v99")).toBeNull();
  });
});

describe("baseKey", () => {
  test("the same tree reached by another history has another merge base, so another key", async () => {
    const f = fixture();
    const run = f.deps.git;
    const before = await baseKey(run, f.repo, f.head, "main");
    // The same tree as the head, but grown from an unrelated root: its merge base with main differs.
    const orphan = git(f.repo, ["commit-tree", `${f.head}^{tree}`, "-m", "orphan"]);
    const other = await baseKey(run, f.repo, orphan, "main");
    expect(before).not.toBeNull();
    expect(other).not.toBe(before);
    expect(await baseKey(run, f.repo, f.head, "main")).toBe(before);
  });

  test("a base branch that does not exist is part of the key, not an error", async () => {
    const f = fixture();
    const key = await baseKey(f.deps.git, f.repo, f.head, "develop");
    expect(key).toContain("refs/heads/develop=none");
    expect(key).toContain("refs/heads/main=");
  });
});
