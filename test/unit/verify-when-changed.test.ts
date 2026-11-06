import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FlowrynError } from "../../src/api/errors.ts";
import { parseConfig } from "../../src/config/config.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { gitRunner } from "../../src/policy/git.ts";
import { grantJobLease } from "../../src/sched/pools.ts";
import { anyMatches, changedSinceBase, compileGlob } from "../../src/verify/changed.ts";
import { verifyConfig, type VerifyConfig } from "../../src/verify/config.ts";
import { verifyPolicyId } from "../../src/verify/policy.ts";
import { changeGate, initialSteps, runVerification, type VerifyDeps } from "../../src/verify/runner.ts";
import { getVerification, insertVerification, type Verification } from "../../src/verify/store.ts";

/**
 * A verify step's when_changed globs (docs/notes/2026-11-06-fast-tests-parallel-36.md):
 * a step whose globs match a file changed against the base runs, one whose globs
 * match none is recorded as skipped with the reason, and a malformed glob is
 * refused when the config loads.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

const config = (text: string) => parseConfig(text, "/h");
const read = (verify: string) => verifyConfig(config(`[projects.web]\nverify = ${verify}\n`), "web")!;

function refusal(verify: string): string {
  try {
    read(verify);
  } catch (error) {
    return `${(error as FlowrynError).code}: ${(error as Error).message}`;
  }
  return "accepted";
}

interface Fixture {
  db: Db;
  deps: VerifyDeps;
  repo: string;
  run(cfg: VerifyConfig, base?: string | null): Promise<Verification>;
}

/** A repository whose main (and origin/main) has one commit, and whose head changes `changed` on top of it. */
function fixture(changed: string[]): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "fl-when-changed-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(repo, ["checkout", "-q", "-b", "feature"]);
  for (const file of changed) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), "changed\n");
  }
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "change"]);
  const head = git(repo, ["rev-parse", "HEAD"]);
  const db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  db.exec(`INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', 'https://github.com/acme/web.git', '${repo}', 'main', 'direct-PR')`);
  const root = join(dir, "state", "verify");
  const deps: VerifyDeps = { db, git: gitRunner("git", 30_000), now: Date.now, log: () => {}, root };
  return {
    db,
    deps,
    repo,
    async run(cfg, base = "main") {
      const v = tx(db, () => {
        const row = insertVerification(db, {
          project_id: "web",
          pr_url: "https://github.com/acme/web/pull/1",
          task_id: null,
          head_sha: head,
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
      await runVerification(deps, v, { prNumber: 1, headRef: "feature", binary: null, timeoutMs: 60_000, path: null, base }, { PATH: process.env.PATH, HOME: process.env.HOME });
      return getVerification(db, v.id)!;
    },
  };
}

describe("when_changed in config", () => {
  test("a step table carries its globs; plain steps and groups are read as before", () => {
    const cfg = read('[\n  "bun install",\n  ["bun run typecheck", { run = "true", when_changed = ["src/lifecycle/**", "src/harness/**"] }],\n  "bun test",\n]');
    expect(cfg.steps).toEqual(["bun install", ["bun run typecheck", "true"], "bun test"]);
    expect(cfg.when_changed).toEqual([null, null, ["src/lifecycle/**", "src/harness/**"], null]);
    expect(initialSteps(cfg.steps, cfg.when_changed).map((s) => s.when_changed ?? null)).toEqual([null, null, ["src/lifecycle/**", "src/harness/**"], null]);
    expect(read('["true"]').when_changed).toBeUndefined();
  });

  test("a bad glob refuses at load", () => {
    expect(refusal('[{ run = "true", when_changed = ["src/[abc"] }]')).toMatch(/^config_invalid: .*glob "src\/\[abc" of "true" has an unclosed \[/);
    expect(refusal('[{ run = "true", when_changed = ["/etc/**"] }]')).toMatch(/is absolute/);
    expect(refusal('[{ run = "true", when_changed = ["../x"] }]')).toMatch(/has a \.\. segment/);
    expect(refusal('[{ run = "true", when_changed = ["src/a**"] }]')).toMatch(/\*\* inside a path segment/);
    expect(refusal('[{ run = "true", when_changed = ["{a,{b,c}}"] }]')).toMatch(/nests/);
    expect(refusal('[{ run = "true", when_changed = [""] }]')).toMatch(/is empty/);
  });

  test("a malformed step table refuses at load", () => {
    expect(refusal('[{ run = "true", when_changed = [] }]')).toMatch(/non-empty list of globs/);
    expect(refusal('[{ run = "true", when_changed = "src/**" }]')).toMatch(/non-empty list of globs/);
    expect(refusal('[{ when_changed = ["src/**"] }]')).toMatch(/needs run/);
    expect(refusal('[{ run = "true", only = ["src/**"] }]')).toMatch(/not only/);
  });

  test("globs join the policy identity; a list without any hashes exactly as before", () => {
    const plain = read('["true", "bun test"]');
    expect(verifyPolicyId(plain)).toBe(verifyPolicyId({ steps: ["true", "bun test"], binary: null }));
    const gated = read('[{ run = "true", when_changed = ["src/**"] }, "bun test"]');
    expect(verifyPolicyId(gated)).not.toBe(verifyPolicyId(plain));
    expect(verifyPolicyId(read('[{ run = "true", when_changed = ["test/**"] }, "bun test"]'))).not.toBe(verifyPolicyId(gated));
  });
});

describe("glob matching", () => {
  const cases: [string, string, boolean][] = [
    ["src/lifecycle/**", "src/lifecycle/worker.ts", true],
    ["src/lifecycle/**", "src/lifecycle/a/b/c.ts", true],
    ["src/lifecycle/**", "src/lifecyclex/a.ts", false],
    ["src/lifecycle/**", "test/src/lifecycle/a.ts", false],
    ["src/*.ts", "src/main.ts", true],
    ["src/*.ts", "src/a/main.ts", false],
    ["**/*.md", "README.md", true],
    ["**/*.md", "docs/notes/x.md", true],
    ["src/**/adapter.ts", "src/harness/claude/adapter.ts", true],
    ["src/**/adapter.ts", "src/adapter.ts", true],
    ["src/{harness,contracts}/**", "src/contracts/revision.ts", true],
    ["src/{harness,contracts}/**", "src/reconcile/x.ts", false],
    ["src/?.ts", "src/a.ts", true],
    ["src/[ab].ts", "src/b.ts", true],
    ["src/[!ab].ts", "src/b.ts", false],
    ["package.json", "package.json", true],
    ["a.b", "axb", false],
  ];
  for (const [glob, path, expected] of cases) test(`${glob} ${expected ? "matches" : "does not match"} ${path}`, () => expect(compileGlob(glob).test(path)).toBe(expected));

  test("anyMatches is true when any glob matches any path", () => {
    expect(anyMatches(["src/x/**", "docs/**"], ["README.md", "docs/a.md"])).toBe(true);
    expect(anyMatches(["src/x/**"], [])).toBe(false);
  });
});

describe("a verify step with when_changed", () => {
  const gated = (globs: string) => read(`["true", { run = "echo ran > ran.txt", when_changed = [${globs}] }]`);

  test("a match runs the step", async () => {
    const f = fixture(["src/lifecycle/worker.ts", "docs/a.md"]);
    const v = await f.run(gated('"src/lifecycle/**"'));
    expect(v.state).toBe("passed");
    expect(v.steps.map((s) => s.state)).toEqual(["passed", "passed"]);
    expect(v.steps[1]!.detail).toBeNull();
  });

  test("no match skips it, with the reason, and the run passes", async () => {
    const f = fixture(["docs/a.md", "README.md"]);
    const v = await f.run(gated('"src/lifecycle/**", "src/harness/**"'));
    expect(v.state).toBe("passed");
    expect(v.steps[1]!.state).toBe("skipped");
    expect(v.steps[1]!.exit).toBeNull();
    expect(v.steps[1]!.detail).toBe("skipped: none of the 2 files changed against origin/main matches its when_changed (src/lifecycle/**, src/harness/**)");
    const step = (f.db.query("SELECT payload FROM events WHERE kind = 'pr.verify_step' ORDER BY seq DESC LIMIT 1").get() as { payload: string }).payload;
    expect(JSON.parse(step)).toMatchObject({ state: "skipped" });
  });

  test("a skipped step does not stop the next one, and a failing one still fails the run", async () => {
    const f = fixture(["docs/a.md"]);
    const v = await f.run(read('[{ run = "true", when_changed = ["src/**"] }, "false"]'));
    expect(v.steps.map((s) => s.state)).toEqual(["skipped", "failed"]);
    expect(v.state).toBe("failed");
  });

  test("a deleted or renamed path counts as changed", async () => {
    const f = fixture([]);
    mkdirSync(join(f.repo, "src/harness"), { recursive: true });
    writeFileSync(join(f.repo, "src/harness/a.ts"), "x\n");
    git(f.repo, ["add", "."]);
    git(f.repo, ["commit", "-q", "-m", "add"]);
    git(f.repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    mkdirSync(join(f.repo, "docs"));
    git(f.repo, ["mv", "src/harness/a.ts", "docs/a.ts"]);
    git(f.repo, ["commit", "-q", "-m", "move"]);
    const changed = await changedSinceBase(gitRunner("git", 30_000), f.repo, "main");
    expect("files" in changed && changed.files.sort()).toEqual(["docs/a.ts", "src/harness/a.ts"]);
  });

  test("when the changed files cannot be read, the step runs and says why", async () => {
    const f = fixture(["docs/a.md"]);
    const v = await f.run(gated('"src/**"'), "no-such-base");
    expect(v.steps[1]!.state).toBe("passed");
    expect(v.steps[1]!.detail).toMatch(/^ran: the changed files are unknown \(no merge base with origin\/no-such-base/);
  });

  test("without a base it diffs against origin's default branch", async () => {
    const f = fixture(["docs/a.md"]);
    const v = await f.run(gated('"src/**"'), null);
    expect(v.steps[1]!.detail).toContain("changed against origin/main");
  });

  test("changeGate leaves a step without globs alone", () => {
    expect(changeGate({}, { files: [], base: "origin/main" })).toEqual({ note: null });
    expect(changeGate({ when_changed: ["src/**"] }, null)).toEqual({ note: null });
  });
});
