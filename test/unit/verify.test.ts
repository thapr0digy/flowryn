import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlowrynError } from "../../src/api/errors.ts";
import { parseConfig } from "../../src/config/config.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { restartGuards } from "../../src/daemon/restart.ts";
import { summarize, type Annotation, type Check, type Forge, type PullRequest } from "../../src/forge/types.ts";
import type { ProjectRow } from "../../src/lifecycle/projects.ts";
import type { RunWithPolicy } from "../../src/lifecycle/runs.ts";
import { gitRunner } from "../../src/policy/git.ts";
import { checkGate, NOT_STARTED_ANNOTATION, notStartedChecks, type ChoiceResult, type MergeFacts } from "../../src/policy/merge.ts";
import { verifyConfig } from "../../src/verify/config.ts";
import { absolutePath, initialSteps, keepBinary, logName, pruneDirs, recoverVerifications, runVerification, stepEnv, type VerifyDeps, type VerifyPlan } from "../../src/verify/runner.ts";
import { getVerification, insertVerification, type Verification } from "../../src/verify/store.ts";
import { countsLine, parseBunSummary } from "../../src/verify/summary.ts";
import { verificationView } from "../../src/verify/verbs.ts";
import { NOT_STARTED_MESSAGE } from "../helpers/fake-github.ts";

/**
 * `flowryn verify`, below the daemon: the config, bun's summary, the step
 * environment, the job (a real git repository, real worktrees, real shell
 * steps) and the merge gate's local green.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fl-verify-"));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

const BUN_SUMMARY = ["bun test v1.3.8 (b64edcb4)", "", "test/a.test.ts:", "(pass) a [1.00ms]", "", " 1843 pass", " 4 skip", " 0 fail", " 5012 expect() calls", "Ran 1847 tests across 131 files. [212.40s]", ""].join("\n");

describe("bun's test summary", () => {
  test("pass, fail, skip and the Ran line are read", () => {
    expect(parseBunSummary(BUN_SUMMARY)).toEqual({ pass: 1843, fail: 0, skip: 4, todo: 0, tests: 1847, files: 131 });
    expect(countsLine(parseBunSummary(BUN_SUMMARY)!)).toBe("1843 pass · 0 fail · 4 skip · 131 files");
  });

  test("the last summary wins, a single test and file read too, and output with none is null", () => {
    const earlier = " 3 pass\n 1 fail\nRan 4 tests across 2 files. [1s]\n";
    expect(parseBunSummary(`${earlier}more output\n 1 pass\n 0 fail\nRan 1 test across 1 file. [5.00ms]\n`)).toEqual({ pass: 1, fail: 0, skip: 0, todo: 0, tests: 1, files: 1 });
    expect(parseBunSummary("Found 0 warnings and 0 errors.\n")).toBeNull();
    expect(parseBunSummary("the 3 pass was printed mid-line\n")).toBeNull();
  });
});

const config = (text: string) => parseConfig(text, "/h");

function bad(text: string): string {
  try {
    verifyConfig(config(text), "web");
  } catch (error) {
    return (error as FlowrynError).code;
  }
  return "accepted";
}

describe("[projects.<id>] verify", () => {
  test("a project without verify steps has none; a full table reads", () => {
    expect(verifyConfig(config(""), "web")).toBeNull();
    expect(verifyConfig(config("[projects.other]\nverify = [\"true\"]\n"), "web")).toBeNull();
    expect(verifyConfig(config('[projects.web]\nverify = ["bun install", "bun test"]\nverify_binary = "dist/flowryn"\nverify_timeout_min = 5\n'), "web")).toEqual({ steps: ["bun install", "bun test"], binary: "dist/flowryn", timeout_ms: 300_000 });
    expect(verifyConfig(config('[projects.web]\nverify = ["true"]\n'), "web")!.timeout_ms).toBe(30 * 60_000);
  });

  test("malformed settings are refused, and a binary must stay inside the worktree", () => {
    expect(bad('[projects.web]\nverify = []\n')).toBe("config_invalid");
    expect(bad('[projects.web]\nverify = "bun test"\n')).toBe("config_invalid");
    expect(bad('[projects.web]\nverify = ["  "]\n')).toBe("config_invalid");
    expect(bad('[projects.web]\nverify = ["true"]\nverify_binary = "../outside"\n')).toBe("config_invalid");
    expect(bad('[projects.web]\nverify = ["true"]\nverify_binary = "/usr/bin/true"\n')).toBe("config_invalid");
    expect(bad('[projects.web]\nverify = ["true"]\nverify_timeout_min = 0\n')).toBe("config_invalid");
    expect(bad('[projects.web]\nverify = ["true"]\nverfiy_binary = "dist/x"\n')).toBe("config_invalid");
  });
});

describe("the step environment", () => {
  test("assumption: steps never see this Flowryn, a Claude session or a GitHub token", () => {
    const env = stepEnv({ PATH: "/usr/bin", HOME: "/h", FLOWRYN_HOME: "/f", FLOWRYN_TOKEN: "t", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", GH_TOKEN: "g", GITHUB_TOKEN: "g", KEEP: "yes" });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/h", KEEP: "yes", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" });
  });

  test("the caller's PATH replaces the daemon's, keeping only absolute directories", () => {
    expect(absolutePath("/a/bin:.:node_modules/.bin::/b:/a/bin")).toBe("/a/bin:/b");
    expect(stepEnv({ PATH: "/usr/bin" }, "/home/me/.bun/bin:./bin").PATH).toBe("/home/me/.bun/bin");
    expect(stepEnv({ PATH: "/usr/bin" }, "./only-relative").PATH).toBe("/usr/bin");
  });

  test("log names are numbered and safe", () => {
    expect(logName(0, "bun install --frozen-lockfile")).toBe("1-bun-install-frozen-lockfile.log");
    expect(logName(3, "$(rm -rf /)")).toBe("4-rm-rf.log");
    expect(logName(1, "!!!")).toBe("2-step.log");
  });
});

interface Fixture {
  db: Db;
  deps: VerifyDeps;
  repo: string;
  head: string;
  root: string;
  start(steps: string[], over?: Partial<VerifyPlan>, head?: string, startedAt?: number): Promise<Verification>;
}

/** A project repository with one commit, a migrated database and a verify root. */
function fixture(): Fixture {
  const dir = tempDir();
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  const head = git(repo, ["rev-parse", "HEAD"]);
  const db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  db.exec(`INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', 'https://github.com/acme/web.git', '${repo}', 'main', 'direct-PR')`);
  const root = join(dir, "state", "verify");
  const logs: string[] = [];
  const deps: VerifyDeps = { db, git: gitRunner("git", 30_000), now: Date.now, log: (m) => logs.push(m), root };
  return {
    db,
    deps,
    repo,
    head,
    root,
    async start(steps, over = {}, at = head, startedAt = Date.now()) {
      const v = tx(db, () =>
        insertVerification(db, {
          project_id: "web",
          pr_url: "https://github.com/acme/web/pull/1",
          task_id: null,
          head_sha: at,
          steps: initialSteps(steps),
          dir: (id) => join(root, id),
          worktree: (id) => join(root, id, "wt"),
          project_path: repo,
          source: "cli",
          now: startedAt,
        }),
      );
      await runVerification(deps, v, { prNumber: 1, headRef: "flowryn/t", binary: null, timeoutMs: 60_000, path: null, ...over }, { PATH: process.env.PATH, HOME: process.env.HOME, FLOWRYN_HOME: "/must/not/leak" });
      return getVerification(db, v.id)!;
    },
  };
}

function events(db: Db, kind: string): Record<string, unknown>[] {
  return (db.query("SELECT payload FROM events WHERE kind = ?1 ORDER BY seq").all(kind) as { payload: string }[]).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
}

describe("a verification job", () => {
  test(
    "passing steps run in a detached worktree at the head; counts, the binary and its symlink are kept; the worktree goes",
    async () => {
      const f = fixture();
      const v = await f.start(
        [`test "$(git rev-parse HEAD)" = ${f.head}`, `printf ' 7 pass\\n 0 fail\\nRan 7 tests across 2 files. [1.00ms]\\n'`, "mkdir -p dist && printf bin > dist/flowryn && chmod 755 dist/flowryn && ln -s flowryn dist/flowrynd"],
        { binary: "dist/flowryn" },
      );
      expect(v.state).toBe("passed");
      expect(v.steps.map((s) => s.state)).toEqual(["passed", "passed", "passed"]);
      expect(v.tests).toEqual({ pass: 7, fail: 0, skip: 0, todo: 0, tests: 7, files: 2 });
      expect(v.binary_path).toBe(join(f.root, v.id, "bin", "flowryn"));
      expect(readFileSync(v.binary_path!, "utf8")).toBe("bin");
      expect(lstatSync(v.binary_path!).mode & 0o777).toBe(0o755);
      expect(readlinkSync(join(f.root, v.id, "bin", "flowrynd"))).toBe("flowryn");
      expect(existsSync(v.worktree_path)).toBe(false);
      expect(git(f.repo, ["worktree", "list", "--porcelain"])).not.toContain(v.worktree_path);
      // The project's own branches and HEAD are untouched.
      expect(git(f.repo, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
      const verified = events(f.db, "pr.verified");
      expect(verified).toHaveLength(1);
      expect(verified[0]).toMatchObject({ verification: v.id, head: f.head, state: "passed", ok: true, tests: v.tests, binary: v.binary_path });
      expect((verified[0]!.steps as { state: string }[]).map((s) => s.state)).toEqual(["passed", "passed", "passed"]);
      expect(typeof verified[0]!.duration_ms).toBe("number");
      expect(events(f.db, "pr.verify_step").length).toBe(6);
    },
    { timeout: 30_000 },
  );

  test("a failing step stops the run; later steps never start; its output is kept", async () => {
    const f = fixture();
    const v = await f.start(["true", "echo broken; printf ' 2 pass\\n 1 fail\\nRan 3 tests across 1 file.\\n'; exit 3", "touch never"]);
    expect(v.state).toBe("failed");
    expect(v.steps.map((s) => [s.state, s.exit])).toEqual([["passed", 0], ["failed", 3], ["waiting", null]]);
    expect(v.detail).toContain("exited 3");
    expect(v.tests).toMatchObject({ pass: 2, fail: 1 });
    expect(readFileSync(join(v.dir, v.steps[1]!.log), "utf8")).toContain("broken");
    expect(existsSync(v.worktree_path)).toBe(false);
  });

  test("assumption: steps never see this Flowryn (a step fails if any FLOWRYN_ variable reaches it)", async () => {
    const f = fixture();
    const v = await f.start(['test -z "$(env | grep ^FLOWRYN_)"']);
    expect(v.state).toBe("passed");
  });

  test("the run's time limit kills the step and everything it started", async () => {
    const f = fixture();
    const marker = join(tempDir(), "child-alive");
    const began = Date.now();
    const v = await f.start([`(sleep 3; touch ${marker}) & sleep 30`], { timeoutMs: 400 });
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(v.state).toBe("failed");
    expect(v.steps[0]!.detail).toContain("timed out");
    await Bun.sleep(3_500);
    expect(existsSync(marker)).toBe(false);
  }, 20_000);

  test("the time limit runs from when the job starts, not from the row's recorded start", async () => {
    const f = fixture();
    const v = await f.start(["sleep 0.2"], { timeoutMs: 60_000 }, f.head, Date.now() - 3_600_000);
    expect(v.state).toBe("passed");
    expect(v.steps[0]!.detail).toBeNull();
  });

  test("a head the project cannot fetch is an error, and no worktree is added", async () => {
    const f = fixture();
    const v = await f.start(["true"], {}, "0123456789abcdef0123456789abcdef01234567");
    expect(v.state).toBe("error");
    expect(v.detail).toContain("is not in");
    expect(v.steps[0]!.state).toBe("waiting");
    expect(existsSync(v.worktree_path)).toBe(false);
  });

  test("a head on the origin's branch is fetched without writing a ref", async () => {
    const f = fixture();
    const origin = join(tempDir(), "origin.git");
    git(f.repo, ["init", "-q", "--bare", origin]);
    git(f.repo, ["remote", "add", "origin", origin]);
    const other = join(tempDir(), "other");
    git(f.repo, ["clone", "-q", origin, other]);
    git(other, ["checkout", "-q", "-b", "flowryn/t"]);
    writeFileSync(join(other, "new.txt"), "x\n");
    git(other, ["add", "."]);
    git(other, ["commit", "-q", "-m", "pr"]);
    git(other, ["push", "-q", "origin", "flowryn/t"]);
    const head = git(other, ["rev-parse", "HEAD"]);
    const refsBefore = git(f.repo, ["for-each-ref", "--format=%(refname)"]);
    const v = await f.start(["test -f new.txt"], {}, head);
    expect(v.state).toBe("passed");
    expect(git(f.repo, ["for-each-ref", "--format=%(refname)"])).toBe(refsBefore);
  });

  test("a binary the steps did not build fails the run", async () => {
    const f = fixture();
    const v = await f.start(["true"], { binary: "dist/flowryn" });
    expect(v.state).toBe("failed");
    expect(v.detail).toContain("dist/flowryn was not built");
  });

  test("only the newest finished directories of a project are kept", async () => {
    const f = fixture();
    const runs: Verification[] = [];
    for (let i = 0; i < 5; i++) runs.push(await f.start(["true"]));
    expect(runs.map((v) => existsSync(v.dir))).toEqual([false, false, true, true, true]);
    // A path that is not a verification directory is never removed.
    f.db.exec(`UPDATE verifications SET dir = '${f.repo}' WHERE id = '${runs[0]!.id}'`);
    pruneDirs(f.deps, "web", 0);
    expect(existsSync(f.repo)).toBe(true);
  });

  test("a verification a dead daemon left running is recorded as an error at startup, its worktree removed", async () => {
    const f = fixture();
    const v = tx(f.db, () =>
      insertVerification(f.db, { project_id: "web", pr_url: "https://github.com/acme/web/pull/1", task_id: null, head_sha: f.head, steps: initialSteps(["true"]), dir: (id) => join(f.root, id), worktree: (id) => join(f.root, id, "wt"), project_path: f.repo, source: "cli", now: Date.now() }),
    );
    mkdirSync(v.dir, { recursive: true });
    git(f.repo, ["worktree", "add", "--detach", v.worktree_path, f.head]);
    expect(restartGuards(f.db, { mergesInFlight: [], cleanups: [], launching: [], approvalTasks: [] }, Date.now()).map((g) => g.kind)).toEqual(["verifying"]);
    expect(await recoverVerifications(f.deps)).toBe(1);
    const after = getVerification(f.db, v.id)!;
    expect(after.state).toBe("error");
    expect(after.detail).toContain("daemon stopped");
    expect(existsSync(v.worktree_path)).toBe(false);
    expect(restartGuards(f.db, { mergesInFlight: [], cleanups: [], launching: [], approvalTasks: [] }, Date.now())).toEqual([]);
  });

  test.skipIf(process.platform !== "darwin")(
    // codesign exists only on macOS.
    "assumption: a copied, ad-hoc signed binary keeps a valid signature",
    async () => {
      const dir = tempDir();
      const wt = join(dir, "wt");
      mkdirSync(join(wt, "dist"), { recursive: true });
      const source = join(wt, "dist", "tool");
      // Built the way scripts/build.sh builds flowryn: bun's compiled binary, re-signed ad hoc.
      writeFileSync(join(dir, "tool.ts"), 'console.log("kept");\n');
      expect(Bun.spawnSync(["bun", "build", join(dir, "tool.ts"), "--compile", "--outfile", source]).exitCode).toBe(0);
      expect(Bun.spawnSync(["codesign", "--force", "--sign", "-", source]).exitCode).toBe(0);
      const kept = keepBinary(wt, "dist/tool", join(dir, "v1"));
      const verified = Bun.spawnSync(["codesign", "--verify", "--strict", kept]);
      expect(verified.exitCode).toBe(0);
      const ran = Bun.spawnSync([kept]);
      expect(ran.exitCode).toBe(0);
      expect(ran.stdout.toString()).toBe("kept\n");
    },
    { timeout: 60_000 },
  );
});

// --- the merge gate's local green ---------------------------------------------------------------

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return { number: 1, url: "https://github.com/acme/web/pull/1", title: "t", state: "open", draft: false, headSha: "h2", headRef: "flowryn/t", headRepo: "acme/web", baseRef: "main", mergeSha: null, mergedAt: null, mergeable: true, ...over };
}

const NOT_STARTED: Check = { name: "typecheck, lint, test, build, fixtures", state: "red", detail: "failure", id: 7, app: "github-actions", annotations: 2 };

function verification(id: string, head: string, state: Verification["state"]): Verification {
  return { id, project_id: "web", pr_url: pr().url, task_id: "t", head_sha: head, state, steps: [], tests: { pass: 9, fail: 0, skip: 0, todo: 0, tests: 9, files: 1 }, detail: state === "passed" ? null : "bun test exited 1", binary_path: null, dir: "/d", worktree_path: "/d/wt", project_path: "/p", started_at: 1, finished_at: 2 };
}

function facts(over: Partial<MergeFacts> = {}): MergeFacts {
  return {
    run: { id: "r1", task_id: "t", sensitive: 0, branch: "flowryn/t", state: "ready" } as unknown as RunWithPolicy,
    project: { id: "web", path: "/p", default_branch: "main" } as unknown as ProjectRow,
    delivered: { kind: "pr", ref: pr().url, head: "h2", at: 0 },
    ref: pr().url,
    head: "h2",
    title: "t",
    pr: pr(),
    checks: summarize([NOT_STARTED]),
    remote: "h2",
    primaryBranch: null,
    primaryDirty: false,
    fastForward: false,
    local: { notStarted: [NOT_STARTED.id!], atHead: null, lastPassed: null },
    ...over,
  };
}

const approved: ChoiceResult = { choice: { kind: "row", row: { id: "a1", allow_red_check: null, channel: "cli-tty" } as never }, why: "" };

function refusal(fn: () => unknown): { code: string; message: string; help?: string } {
  try {
    fn();
  } catch (error) {
    return { code: (error as FlowrynError).code, message: (error as FlowrynError).message, help: (error as FlowrynError).help };
  }
  throw new Error("expected a refusal");
}

describe("verify show", () => {
  test("a kept binary that pruning removed reads as removed", () => {
    const dir = tempDir();
    const kept = join(dir, "flowryn");
    writeFileSync(kept, "bin");
    expect(verificationView({ ...verification("v1", "h2", "passed"), binary_path: kept }, 3).binary).toBe(kept);
    rmSync(kept);
    expect(verificationView({ ...verification("v1", "h2", "passed"), binary_path: kept }, 3).binary).toBe(`${kept} (removed)`);
    expect(verificationView(verification("v1", "h2", "passed"), 3).binary).toBe("-");
  });
});

describe("local green at the merge gate", () => {
  test("assumption: GitHub's not-started annotation reads as it did on PR #37", () => {
    expect(NOT_STARTED_ANNOTATION.test(NOT_STARTED_MESSAGE)).toBe(true);
    expect(NOT_STARTED_ANNOTATION.test("Process completed with exit code 1.")).toBe(false);
  });

  test("checks GitHub never started, and a passing verify at exactly this head: the merge goes ahead and names it", () => {
    const passed = verification("v4", "h2", "passed");
    expect(checkGate(facts({ local: { notStarted: [NOT_STARTED.id!], atHead: passed, lastPassed: passed } }), approved)).toEqual({ waived: null, alreadyMerged: false, localGreen: "v4" });
  });

  test("a verify that passed at an older head is head_moved", () => {
    const r = refusal(() => checkGate(facts({ local: { notStarted: [NOT_STARTED.id!], atHead: null, lastPassed: verification("v3", "h1", "passed") } }), approved));
    expect(r.code).toBe("head_moved");
    expect(r.message).toContain("v3 passed at h1");
    expect(r.help).toBe("verify this head: flowryn verify t");
  });

  test("no verify, or one that failed at this head, is red_checks with the way forward", () => {
    const none = refusal(() => checkGate(facts(), approved));
    expect(none.code).toBe("red_checks");
    expect(none.message).toContain("CI never started at h2");
    expect(none.help).toContain("flowryn verify t");
    const failed = refusal(() => checkGate(facts({ local: { notStarted: [NOT_STARTED.id!], atHead: verification("v5", "h2", "failed"), lastPassed: verification("v3", "h1", "passed") } }), approved));
    expect(failed.code).toBe("red_checks");
    expect(failed.message).toContain("v5 at this head failed");
  });

  test("a check that ran and failed is never covered, nor is a pending one, nor a missing approval", () => {
    const passed = verification("v4", "h2", "passed");
    const ran: Check = { name: "lint", state: "red", detail: "failure", id: 8, app: "github-actions", annotations: 1 };
    const mixed = refusal(() => checkGate(facts({ checks: summarize([NOT_STARTED, ran]), local: { notStarted: [NOT_STARTED.id!], atHead: passed, lastPassed: passed } }), approved));
    expect(mixed.code).toBe("red_checks");
    expect(mixed.message).toContain("2 red checks");
    const pending: Check = { name: "deploy", state: "pending", detail: "in_progress" };
    expect(refusal(() => checkGate(facts({ checks: summarize([NOT_STARTED, pending]), local: { notStarted: [NOT_STARTED.id!], atHead: passed, lastPassed: passed } }), approved)).code).toBe("checks_pending");
    expect(refusal(() => checkGate(facts({ local: { notStarted: [NOT_STARTED.id!], atHead: passed, lastPassed: passed } }), { choice: null, why: "none" })).code).toBe("approval_required");
  });

  test("a red run that ran and failed is not covered by a not-started run of the same name", () => {
    const passed = verification("v4", "h2", "passed");
    const rerun: Check = { ...NOT_STARTED, id: 9, annotations: 1 };
    const r = refusal(() => checkGate(facts({ checks: summarize([NOT_STARTED, rerun]), local: { notStarted: [NOT_STARTED.id!], atHead: passed, lastPassed: passed } }), approved));
    expect(r.code).toBe("red_checks");
    expect(r.message).toContain("2 red checks");
  });

  test("assumption: local green is evidence, not a waiver, so yolo may merge on it", () => {
    const passed = verification("v4", "h2", "passed");
    expect(checkGate(facts({ local: { notStarted: [NOT_STARTED.id!], atHead: passed, lastPassed: passed } }), { choice: { kind: "yolo" }, why: "" }).localGreen).toBe("v4");
  });
});

function forge(annotations: Record<number, Annotation[]>): Forge & { asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    pull: async () => pr(),
    pullsForBranch: async () => [],
    checks: async () => summarize([]),
    merge: async () => ({ merged: false, sha: null, message: "" }),
    annotations: async (_repo, id) => {
      asked.push(id);
      return annotations[id] ?? [];
    },
  };
}

const failure = (message: string): Annotation => ({ level: "failure", message });

describe("which red checks GitHub never started", () => {
  const ref = { owner: "acme", repo: "web", number: 1 };

  test("a github-actions run that failed with GitHub's not-started annotation counts", async () => {
    const f = forge({ 7: [failure(NOT_STARTED_MESSAGE), { level: "notice", message: "label migration" }] });
    expect(await notStartedChecks(f, ref, summarize([NOT_STARTED, { name: "ok", state: "green", detail: "success" }]))).toEqual([NOT_STARTED.id!]);
  });

  test("two red runs sharing a name: only the one GitHub never started counts", async () => {
    const f = forge({ 7: [failure(NOT_STARTED_MESSAGE)], 9: [failure("Process completed with exit code 1.")] });
    expect(await notStartedChecks(f, ref, summarize([NOT_STARTED, { ...NOT_STARTED, id: 9, annotations: 1 }]))).toEqual([NOT_STARTED.id!]);
  });

  test("a job that ran and failed, a notice in the same words, or any red that is not a github-actions run counts as nothing, and is not even asked", async () => {
    const ran = forge({ 7: [failure("Process completed with exit code 1.")] });
    expect(await notStartedChecks(ran, ref, summarize([NOT_STARTED]))).toEqual([]);
    const notice = forge({ 7: [{ level: "notice", message: NOT_STARTED_MESSAGE }] });
    expect(await notStartedChecks(notice, ref, summarize([NOT_STARTED]))).toEqual([]);
    const status: Check = { name: "ci/legacy", state: "red", detail: "failure" };
    const asked = forge({ 7: [failure(NOT_STARTED_MESSAGE)] });
    expect(await notStartedChecks(asked, ref, summarize([NOT_STARTED, status]))).toEqual([]);
    expect(asked.asked).toEqual([]);
    expect(await notStartedChecks(asked, ref, summarize([{ ...NOT_STARTED, annotations: 0 }]))).toEqual([]);
    expect(asked.asked).toEqual([]);
  });
});
