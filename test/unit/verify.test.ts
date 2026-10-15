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
import { normalizeStep, verifyPolicyId } from "../../src/verify/policy.ts";
import { absolutePath, initialSteps, keepBinary, logName, pruneDirs, recoverVerifications, runVerification, stepEnv, type VerifyDeps, type VerifyPlan } from "../../src/verify/runner.ts";
import { finishedAtHead, finishedAtHeadUnderOther, finishVerification, getVerification, insertVerification, type Verification } from "../../src/verify/store.ts";
import { countsLine, parseBunSummary } from "../../src/verify/summary.ts";
import { verificationView } from "../../src/verify/verbs.ts";
import { grantJobLease, liveCounts, liveJobLeases, recordJobProcess } from "../../src/sched/pools.ts";
import { isAlive, psRunner, readIdentity, terminate, type ProcIdentity } from "../../src/runtime/proc.ts";
import { spawn } from "node:child_process";
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

const policyOf = (steps: string[], binary: string | null = null) => verifyPolicyId({ steps, binary });

describe("the verify policy identity", () => {

  test("assumption: formatting noise in a step (outer whitespace, runs of spaces and tabs) does not change the identity", () => {
    expect(normalizeStep("  bun   install\t--frozen-lockfile  ")).toBe("bun install --frozen-lockfile");
    expect(policyOf(["  bun   install\t--frozen-lockfile ", "bun test"])).toBe(policyOf(["bun install --frozen-lockfile", "bun test"]));
  });

  test("assumption: whitespace inside quotes or after a backslash is part of an argument, and a newline separates commands", () => {
    expect(normalizeStep(`echo "a  b"   'c\t d'`)).toBe(`echo "a  b" 'c\t d'`);
    expect(policyOf([`echo "a  b"`])).not.toBe(policyOf([`echo "a b"`]));
    expect(normalizeStep(String.raw`echo "a \"  b"   c`)).toBe(String.raw`echo "a \"  b" c`);
    expect(normalizeStep(String.raw`echo a\    b`)).toBe(String.raw`echo a\  b`);
    expect(policyOf([String.raw`echo a\  b`])).not.toBe(policyOf([String.raw`echo a\ b`]));
    expect(policyOf(["true\nfalse"])).not.toBe(policyOf(["true false"]));
  });

  test("assumption: a changed, added, removed or reordered step, or a changed or added artifact, is another policy", () => {
    const base = policyOf(["bun install", "bun test"]);
    expect(policyOf(["bun install", "bun test --bail"])).not.toBe(base);
    expect(policyOf(["bun install", "npx oxlint", "bun test"])).not.toBe(base);
    expect(policyOf(["bun install"])).not.toBe(base);
    expect(policyOf(["bun test", "bun install"])).not.toBe(base);
    expect(policyOf(["bun install", "bun test"], "dist/flowryn")).not.toBe(base);
    expect(policyOf(["bun install", "bun test"], "dist/flowryn")).not.toBe(policyOf(["bun install", "bun test"], "dist/other"));
    // Joining two steps into one is another run (a step's exit code is checked on its own).
    expect(policyOf(["bun install bun test"])).not.toBe(base);
  });

  test("the time limit is not part of it, and the artifact is compared as verifyConfig normalizes it", () => {
    const a = verifyConfig(config('[projects.web]\nverify = ["bun test"]\nverify_binary = "./dist/flowryn"\nverify_timeout_min = 5\n'), "web")!;
    const b = verifyConfig(config('[projects.web]\nverify = ["bun  test"]\nverify_binary = "dist/flowryn"\n'), "web")!;
    expect(verifyPolicyId(a)).toBe(verifyPolicyId(b));
  });

  test("assumption: the encoding is stable, so an upgrade does not quietly invalidate (or revalidate) stored results", () => {
    // sha256 of ["flowryn-verify-policy",1,["bun install --frozen-lockfile","bun test"],"dist/flowryn"]
    expect(policyOf(["bun install --frozen-lockfile", "bun test"], "dist/flowryn")).toBe("vp1:1e030c6a4a029f17bd56c322243558966e23287d43b2937919e2f52f951c836f");
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
      const v = tx(db, () => {
        const row = insertVerification(db, {
          project_id: "web",
          pr_url: "https://github.com/acme/web/pull/1",
          task_id: null,
          head_sha: at,
          steps: initialSteps(steps),
          policy_id: verifyPolicyId({ steps, binary: null }),
          dir: (id) => join(root, id),
          worktree: (id) => join(root, id, "wt"),
          project_path: repo,
          source: "cli",
          now: startedAt,
        });
        // As verify.start does: the row and its validation slot in one transaction.
        grantJobLease(db, { kind: "verify", id: row.id, taskId: null }, "validation", { validation: 5 }, startedAt);
        return row;
      });
      await runVerification(deps, v, { prNumber: 1, headRef: "flowryn/t", binary: null, timeoutMs: 60_000, path: null, ...over }, { PATH: process.env.PATH, HOME: process.env.HOME, FLOWRYN_HOME: "/must/not/leak" });
      return getVerification(db, v.id)!;
    },
  };
}

async function waitFor(check: () => Promise<boolean>, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

function events(db: Db, kind: string): Record<string, unknown>[] {
  return (db.query("SELECT payload FROM events WHERE kind = ?1 ORDER BY seq").all(kind) as { payload: string }[]).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
}

/** A running row and its slot as the last daemon left them, with a worktree, and the step's identity when one is given. */
function leftRunning(f: Fixture, proc: ProcIdentity | null): Verification {
  const v = tx(f.db, () => {
    const row = insertVerification(f.db, { project_id: "web", pr_url: "https://github.com/acme/web/pull/1", task_id: null, head_sha: f.head, steps: initialSteps(["sleep 30"]), policy_id: verifyPolicyId({ steps: ["sleep 30"], binary: null }), dir: (id) => join(f.root, id), worktree: (id) => join(f.root, id, "wt"), project_path: f.repo, source: "cli", now: Date.now() });
    grantJobLease(f.db, { kind: "verify", id: row.id, taskId: null }, "validation", { validation: 5 }, Date.now());
    if (proc) recordJobProcess(f.db, { kind: "verify", id: row.id, taskId: null }, proc, Date.now());
    return row;
  });
  mkdirSync(v.dir, { recursive: true });
  git(f.repo, ["worktree", "add", "--detach", v.worktree_path, f.head]);
  return v;
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

  test("a step read mid-exec (ps names it \"(sh)\") is re-read, so the lease holds the identity recovery can match", async () => {
    const f = fixture();
    let reads = 0;
    // The first read sees the leader still being exec'd, as macOS ps reports it.
    f.deps.ps = async (pids) => {
      const out = await psRunner(pids);
      return reads++ === 0 ? out.replace(/\S+\s*$/, "(sh)\n") : out;
    };
    const v = await f.start(["sleep 1"]);
    expect(v.state).toBe("passed");
    expect(reads).toBeGreaterThanOrEqual(2);
    const lease = f.db.query("SELECT proc_exe FROM job_leases WHERE job_id = ?1").get(v.id) as { proc_exe: string | null };
    expect(lease.proc_exe).not.toBeNull();
    expect(lease.proc_exe).not.toBe("(sh)");
  }, 20_000);

  test("a verification a dead daemon left running is recorded as an error at startup, its worktree removed", async () => {
    const f = fixture();
    const v = tx(f.db, () =>
      insertVerification(f.db, { project_id: "web", pr_url: "https://github.com/acme/web/pull/1", task_id: null, head_sha: f.head, steps: initialSteps(["true"]), policy_id: verifyPolicyId({ steps: ["true"], binary: null }), dir: (id) => join(f.root, id), worktree: (id) => join(f.root, id, "wt"), project_path: f.repo, source: "cli", now: Date.now() }),
    );
    mkdirSync(v.dir, { recursive: true });
    git(f.repo, ["worktree", "add", "--detach", v.worktree_path, f.head]);
    expect(restartGuards(f.db, { mergesInFlight: [], cleanups: [], launching: [], challenges: [] }, Date.now()).map((g) => g.kind)).toEqual(["verifying"]);
    expect(await recoverVerifications(f.deps)).toBe(1);
    const after = getVerification(f.db, v.id)!;
    expect(after.state).toBe("error");
    expect(after.detail).toContain("daemon stopped");
    expect(existsSync(v.worktree_path)).toBe(false);
    expect(restartGuards(f.db, { mergesInFlight: [], cleanups: [], launching: [], challenges: [] }, Date.now())).toEqual([]);
  });

  test("assumption: a job's slot is released once, only after its steps' process groups are gone and its worktree is removed (pass and fail)", async () => {
    const f = fixture();
    const seen: { worktree: boolean; live: number }[] = [];
    let wt = "";
    f.deps.released = () => seen.push({ worktree: existsSync(wt), live: liveJobLeases(f.db).length });
    const marker = join(tempDir(), "left-behind");
    // Each step leaves a background child in its group; the slot is freed only once the group is killed.
    const steps = [`(sleep 2; touch ${marker}) & sleep 0.3`];
    for (const tail of ["true", "exit 4"]) {
      wt = join(f.root, `v${seen.length + 1}`, "wt");
      const v = await f.start([...steps, tail]);
      expect(v.state).toBe(tail === "true" ? "passed" : "failed");
      expect(seen.at(-1)).toEqual({ worktree: false, live: 0 });
      expect(git(f.repo, ["worktree", "list", "--porcelain"])).not.toContain(v.worktree_path);
      const released = events(f.db, "pool.released").filter((e) => e.job === v.id);
      expect(released).toEqual([{ job: v.id, kind: "verify", pools: ["validation"], reason: `verification ${v.id} ended` }]);
      // The step that ran long enough for ps to read it was recorded on the lease.
      expect(events(f.db, "pool.job_process").filter((e) => e.job === v.id).length).toBeGreaterThanOrEqual(1);
    }
    expect(seen).toHaveLength(2);
    expect(liveCounts(f.db)).toEqual({});
    await Bun.sleep(2_200);
    expect(existsSync(marker)).toBe(false);
  }, 20_000);

  test("startup recovery ends a step the last daemon left running (its whole group), records the row, removes the worktree, then frees the slot once", async () => {
    const f = fixture();
    const marker = join(tempDir(), "grandchild-alive");
    const child = spawn("/bin/sh", ["-c", `(sleep 3; touch ${marker}) & sleep 30`], { detached: true, stdio: "ignore" });
    child.unref();
    let proc: ProcIdentity | null = null;
    await waitFor(async () => (proc = await readIdentity(child.pid!)) !== null);
    const v = leftRunning(f, proc);
    const order: string[] = [];
    f.deps.terminate = async (p, options) => {
      order.push(`terminate worktree=${existsSync(v.worktree_path)} live=${liveJobLeases(f.db).length}`);
      return terminate(p, { ...options, graceMs: 1_000 });
    };
    expect(await recoverVerifications(f.deps)).toBe(1);
    expect(order).toEqual(["terminate worktree=true live=1"]);
    expect(await isAlive(proc!)).toBe(false);
    expect(getVerification(f.db, v.id)).toMatchObject({ state: "error", detail: "the daemon stopped mid-run" });
    expect(existsSync(v.worktree_path)).toBe(false);
    expect(liveCounts(f.db)).toEqual({});
    expect(f.db.query("SELECT released_by FROM job_leases").all()).toEqual([{ released_by: "recovered at startup" }]);
    // A second startup finds nothing to do and records nothing.
    expect(await recoverVerifications(f.deps)).toBe(0);
    expect(events(f.db, "pool.released")).toHaveLength(1);
    await Bun.sleep(3_200);
    expect(existsSync(marker)).toBe(false);
  }, 20_000);

  test("startup recovery also ends a member of the step's group that ignores SIGTERM after its leader exits", async () => {
    const f = fixture();
    const pidFile = join(tempDir(), "member.pid");
    const child = spawn("/bin/sh", ["-c", `(trap '' TERM; exec sleep 30) & echo $! > ${pidFile}; wait`], { detached: true, stdio: "ignore" });
    child.unref();
    let proc: ProcIdentity | null = null;
    await waitFor(async () => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "" && (proc = await readIdentity(child.pid!)) !== null);
    const member = await readIdentity(Number(readFileSync(pidFile, "utf8").trim()));
    expect(member).not.toBeNull();
    const v = leftRunning(f, proc);
    f.deps.terminate = (p, options) => terminate(p, { ...options, graceMs: 1_000 });
    expect(await recoverVerifications(f.deps)).toBe(1);
    expect(await isAlive(proc!)).toBe(false);
    await waitFor(async () => !(await isAlive(member!)));
    expect(existsSync(v.worktree_path)).toBe(false);
    expect(liveCounts(f.db)).toEqual({});
  }, 20_000);

  test("a job whose recovery throws is logged and recorded as an error, keeps its slot for the next startup, and the next job is still recovered", async () => {
    const f = fixture();
    const broken = leftRunning(f, { pid: 999_998, start: 1_000, exe: "/bin/sh" });
    const fine = leftRunning(f, null);
    const logs: string[] = [];
    f.deps.log = (message) => logs.push(message);
    f.deps.terminate = async () => {
      throw new Error("ps failed");
    };
    expect(await recoverVerifications(f.deps)).toBe(2);
    expect(logs).toContain(`verify ${broken.id}: recovery failed: ps failed`);
    expect(getVerification(f.db, broken.id)).toMatchObject({ state: "error", detail: "the daemon stopped mid-run; recovering it failed (ps failed)" });
    expect(restartGuards(f.db, { mergesInFlight: [], cleanups: [], launching: [], challenges: [] }, Date.now())).toEqual([]);
    expect(existsSync(broken.worktree_path)).toBe(true);
    expect(getVerification(f.db, fine.id)).toMatchObject({ state: "error", detail: "the daemon stopped mid-run" });
    expect(existsSync(fine.worktree_path)).toBe(false);
    expect(liveJobLeases(f.db).map((l) => l.job_id)).toEqual([broken.id]);
    f.deps.terminate = async () => ({ ok: true, evidence: "absent", signal: "none" });
    expect(await recoverVerifications(f.deps)).toBe(0);
    expect(liveCounts(f.db)).toEqual({});
    expect(existsSync(broken.worktree_path)).toBe(false);
    expect(events(f.db, "pool.released").filter((e) => e.job === broken.id)).toHaveLength(1);
    expect(await recoverVerifications(f.deps)).toBe(0);
    expect(events(f.db, "pool.released")).toHaveLength(2);
  });

  test("a step that will not exit keeps its slot and its worktree; the next startup ends it and frees the slot", async () => {
    const f = fixture();
    const v = leftRunning(f, { pid: 999_999, start: 1_000, exe: "/bin/sh" });
    f.deps.terminate = async () => ({ ok: false, evidence: "timeout", signal: "SIGKILL" });
    expect(await recoverVerifications(f.deps)).toBe(1);
    expect(getVerification(f.db, v.id)!.state).toBe("error");
    expect(getVerification(f.db, v.id)!.detail).toContain("did not exit");
    expect(liveCounts(f.db)).toEqual({ validation: 1 });
    expect(existsSync(v.worktree_path)).toBe(true);
    f.deps.terminate = async () => ({ ok: true, evidence: "process", signal: "SIGTERM" });
    expect(await recoverVerifications(f.deps)).toBe(0);
    expect(liveCounts(f.db)).toEqual({});
    expect(existsSync(v.worktree_path)).toBe(false);
    expect(events(f.db, "pool.released")).toHaveLength(1);
    expect(events(f.db, "pr.verified")).toHaveLength(1);
  });

  test("a slot whose verification already finished (the daemon died before releasing it) is freed at startup", async () => {
    const f = fixture();
    const v = leftRunning(f, null);
    tx(f.db, () => f.db.query("UPDATE verifications SET state = 'passed', finished_at = 1 WHERE id = ?1").run(v.id));
    expect(await recoverVerifications(f.deps)).toBe(0);
    expect(getVerification(f.db, v.id)!.state).toBe("passed");
    expect(liveCounts(f.db)).toEqual({});
    expect(existsSync(v.worktree_path)).toBe(false);
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

/** The project's verify policy identity under today's config, in the gate's facts. */
const TODAY = verifyPolicyId({ steps: ["bun install", "bun test"], binary: null });

const NOT_STARTED: Check = { name: "typecheck, lint, test, build, fixtures", state: "red", detail: "failure", id: 7, app: "github-actions", annotations: 2 };

function verification(id: string, head: string, state: Verification["state"]): Verification {
  return { id, project_id: "web", pr_url: pr().url, task_id: "t", head_sha: head, state, steps: [], tests: { pass: 9, fail: 0, skip: 0, todo: 0, tests: 9, files: 1 }, detail: state === "passed" ? null : "bun test exited 1", binary_path: null, dir: "/d", worktree_path: "/d/wt", project_path: "/p", started_at: 1, finished_at: 2, policy_id: TODAY };
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
    local: { notStarted: [NOT_STARTED.id!], policy: TODAY, otherPolicyAtHead: null, atHead: null, lastPassed: null },
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
    expect(checkGate(facts({ local: { notStarted: [NOT_STARTED.id!], policy: TODAY, otherPolicyAtHead: null, atHead: passed, lastPassed: passed } }), approved)).toEqual({ waived: null, alreadyMerged: false, localGreen: "v4" });
  });

  test("a verify that passed at an older head is head_moved", () => {
    const r = refusal(() => checkGate(facts({ local: { notStarted: [NOT_STARTED.id!], policy: TODAY, otherPolicyAtHead: null, atHead: null, lastPassed: verification("v3", "h1", "passed") } }), approved));
    expect(r.code).toBe("head_moved");
    expect(r.message).toContain("v3 passed at h1");
    expect(r.help).toBe("verify this head: flowryn verify t");
  });

  test("no verify is verify_required, and one that failed at this head is verify_failed, each with the way forward", () => {
    const none = refusal(() => checkGate(facts(), approved));
    expect(none.code).toBe("verify_required");
    expect(none.message).toContain("CI never started at h2");
    expect(none.help).toContain("flowryn verify t");
    const failed = refusal(() => checkGate(facts({ local: { notStarted: [NOT_STARTED.id!], policy: TODAY, otherPolicyAtHead: null, atHead: verification("v5", "h2", "failed"), lastPassed: verification("v3", "h1", "passed") } }), approved));
    expect(failed.code).toBe("verify_failed");
    expect(failed.message).toContain("v5 at this head failed");
    expect(failed.help).toBe("flowryn verify show v5; once fixed: flowryn verify t");
  });

  test("a project with no verify steps: checks GitHub never started still want a pass, and none is red_checks as before", () => {
    const none = refusal(() => checkGate(facts({ local: { notStarted: [NOT_STARTED.id!], policy: null, otherPolicyAtHead: null, atHead: null, lastPassed: null } }), approved));
    expect(none.code).toBe("red_checks");
    expect(none.message).toContain("CI never started at h2");
  });

  test("a check that ran and failed is never covered, nor is a pending one, nor a missing approval", () => {
    const passed = verification("v4", "h2", "passed");
    const ran: Check = { name: "lint", state: "red", detail: "failure", id: 8, app: "github-actions", annotations: 1 };
    const mixed = refusal(() => checkGate(facts({ checks: summarize([NOT_STARTED, ran]), local: { notStarted: [NOT_STARTED.id!], policy: TODAY, otherPolicyAtHead: null, atHead: passed, lastPassed: passed } }), approved));
    expect(mixed.code).toBe("red_checks");
    expect(mixed.message).toContain("2 red checks");
    const pending: Check = { name: "deploy", state: "pending", detail: "in_progress" };
    expect(refusal(() => checkGate(facts({ checks: summarize([NOT_STARTED, pending]), local: { notStarted: [NOT_STARTED.id!], policy: TODAY, otherPolicyAtHead: null, atHead: passed, lastPassed: passed } }), approved)).code).toBe("checks_pending");
    expect(refusal(() => checkGate(facts({ local: { notStarted: [NOT_STARTED.id!], policy: TODAY, otherPolicyAtHead: null, atHead: passed, lastPassed: passed } }), { choice: null, why: "none" })).code).toBe("approval_required");
  });

  test("a red run that ran and failed is not covered by a not-started run of the same name", () => {
    const passed = verification("v4", "h2", "passed");
    const rerun: Check = { ...NOT_STARTED, id: 9, annotations: 1 };
    const r = refusal(() => checkGate(facts({ checks: summarize([NOT_STARTED, rerun]), local: { notStarted: [NOT_STARTED.id!], policy: TODAY, otherPolicyAtHead: null, atHead: passed, lastPassed: passed } }), approved));
    expect(r.code).toBe("red_checks");
    expect(r.message).toContain("2 red checks");
  });

  test("assumption: local green is evidence, not a waiver, so yolo may merge on it", () => {
    const passed = verification("v4", "h2", "passed");
    expect(checkGate(facts({ local: { notStarted: [NOT_STARTED.id!], policy: TODAY, otherPolicyAtHead: null, atHead: passed, lastPassed: passed } }), { choice: { kind: "yolo" }, why: "" }).localGreen).toBe("v4");
  });
});

describe("a project with verify steps merges only on a passing verify of exactly the head", () => {
  const RAN: Check = { name: "lint", state: "red", detail: "failure", id: 8, app: "github-actions", annotations: 1 };
  const GREEN: Check = { name: "ci", state: "green", detail: "success", id: 9, app: "github-actions" };
  const OLD = verifyPolicyId({ steps: ["bun test"], binary: null });
  const waiving = (check: string): ChoiceResult => ({ choice: { kind: "row", row: { id: "a2", allow_red_check: check, channel: "cli-tty" } as never }, why: "", allowRed: check });

  /** GitHub's checks, the not-started ids among them, and the approval the merge brings. */
  const CHECKS = {
    none: { checks: summarize([]), notStarted: [] as number[], chosen: approved },
    green: { checks: summarize([GREEN]), notStarted: [] as number[], chosen: approved },
    "red, not started": { checks: summarize([NOT_STARTED]), notStarted: [NOT_STARTED.id!], chosen: approved },
    "red, ran": { checks: summarize([RAN]), notStarted: [] as number[], chosen: approved },
    "red, ran, waived": { checks: summarize([RAN]), notStarted: [] as number[], chosen: waiving("lint") },
  } as const;

  /** The local verify evidence at the head h2 (null: the project has no verify steps). */
  const VERIFY = {
    passed: { policy: TODAY, atHead: verification("v4", "h2", "passed"), otherPolicyAtHead: null, lastPassed: verification("v4", "h2", "passed") },
    failed: { policy: TODAY, atHead: verification("v5", "h2", "failed"), otherPolicyAtHead: null, lastPassed: null },
    stale: { policy: TODAY, atHead: null, otherPolicyAtHead: under(verification("v3", "h2", "passed"), OLD), lastPassed: under(verification("v3", "h2", "passed"), OLD) },
    missing: { policy: TODAY, atHead: null, otherPolicyAtHead: null, lastPassed: null },
    "older head": { policy: TODAY, atHead: null, otherPolicyAtHead: null, lastPassed: verification("v2", "h1", "passed") },
    "no steps": null,
  } as const;

  const MERGE = "merge";
  /** The design's matrix: what the gate does for each row of checks and column of verify evidence. */
  const MATRIX: Record<keyof typeof CHECKS, Record<keyof typeof VERIFY, string>> = {
    none: { passed: MERGE, failed: "verify_failed", stale: "verify_stale", missing: "verify_required", "older head": "head_moved", "no steps": MERGE },
    green: { passed: MERGE, failed: "verify_failed", stale: "verify_stale", missing: "verify_required", "older head": "head_moved", "no steps": MERGE },
    "red, not started": { passed: MERGE, failed: "verify_failed", stale: "verify_stale", missing: "verify_required", "older head": "head_moved", "no steps": "red_checks" },
    "red, ran": { passed: "red_checks", failed: "red_checks", stale: "red_checks", missing: "red_checks", "older head": "red_checks", "no steps": "red_checks" },
    "red, ran, waived": { passed: MERGE, failed: "verify_failed", stale: "verify_stale", missing: "verify_required", "older head": "head_moved", "no steps": MERGE },
  };

  for (const [checksName, c] of Object.entries(CHECKS) as [keyof typeof CHECKS, (typeof CHECKS)[keyof typeof CHECKS]][]) {
    for (const [verifyName, v] of Object.entries(VERIFY) as [keyof typeof VERIFY, (typeof VERIFY)[keyof typeof VERIFY]][]) {
      const expected = MATRIX[checksName][verifyName];
      test(`checks ${checksName}, verify ${verifyName}: ${expected}`, () => {
        // A project with no verify steps reads evidence only to cover checks GitHub never started (gatherFacts).
        const notStarted = [...c.notStarted];
        const local = v ? { notStarted, ...v } : notStarted.length > 0 ? { notStarted, policy: null, atHead: null, otherPolicyAtHead: null, lastPassed: null } : undefined;
        const f = facts({ checks: c.checks, local });
        if (expected === MERGE) {
          const gate = checkGate(f, c.chosen);
          expect(gate.localGreen).toBe(v ? "v4" : null);
          expect(gate.waived).toBe(checksName === "red, ran, waived" ? "lint" : null);
        } else expect(refusal(() => checkGate(f, c.chosen)).code).toBe(expected);
      });
    }
  }

  test("the refusal says what GitHub's checks are, and the help is flowryn verify", () => {
    const none = refusal(() => checkGate(facts({ checks: summarize([]), local: { notStarted: [], ...VERIFY.missing } }), approved));
    expect(none.message).toContain("project web merges only on a passing flowryn verify of exactly the head (the PR has no checks at h2)");
    expect(none.help).toBe("verify it locally, then merge again: flowryn verify t");
    const green = refusal(() => checkGate(facts({ checks: summarize([GREEN]), local: { notStarted: [], ...VERIFY.missing } }), approved));
    expect(green.message).toContain("(checks: green (1) at h2)");
  });

  test("a waiver never stands in for a missing verify", () => {
    expect(refusal(() => checkGate(facts({ checks: summarize([RAN]), local: { notStarted: [], ...VERIFY.missing } }), waiving("lint"))).code).toBe("verify_required");
  });

  test("yolo merges on a passing verify, never without one", () => {
    const yolo: ChoiceResult = { choice: { kind: "yolo" }, why: "" };
    expect(checkGate(facts({ checks: summarize([]), local: { notStarted: [], ...VERIFY.passed } }), yolo).localGreen).toBe("v4");
    expect(refusal(() => checkGate(facts({ checks: summarize([]), local: { notStarted: [], ...VERIFY.missing } }), yolo)).code).toBe("verify_required");
  });

  test("local-only work: a passing verify of the worktree head merges; none is verify_required", () => {
    const local = { pr: null, checks: null, remote: null, delivered: { kind: "local" as const, ref: "flowryn/t", head: "h2", at: 0 }, ref: "local:flowryn/t", primaryBranch: "main", fastForward: true };
    expect(checkGate(facts({ ...local, local: { notStarted: [], ...VERIFY.passed } }), approved).localGreen).toBe("v4");
    const r = refusal(() => checkGate(facts({ ...local, local: { notStarted: [], ...VERIFY.missing } }), approved));
    expect(r.code).toBe("verify_required");
    expect(r.message).toContain("(local-only work at h2 has no CI)");
    expect(checkGate(facts({ ...local, local: undefined }), approved).localGreen).toBeNull();
  });

  test("checks still running wait for the verify first, then for the checks", () => {
    const pending: Check = { name: "deploy", state: "pending", detail: "in_progress" };
    expect(refusal(() => checkGate(facts({ checks: summarize([pending]), local: { notStarted: [], ...VERIFY.missing } }), approved)).code).toBe("verify_required");
    expect(refusal(() => checkGate(facts({ checks: summarize([pending]), local: { notStarted: [], ...VERIFY.passed } }), approved)).code).toBe("checks_pending");
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

/** A result at this head under the given policy (null: legacy). */
const under = (v: Verification, policy: string | null): Verification => ({ ...v, policy_id: policy });
/** Gate facts with no same-policy result at this head, only `other`. */
const stale = (other: Verification, over: Partial<MergeFacts["local"] & object> = {}) => facts({ local: { notStarted: [NOT_STARTED.id!], policy: TODAY, atHead: null, otherPolicyAtHead: other, lastPassed: other, ...over } });

describe("local green needs today's verify policy", () => {
  const OLD = verifyPolicyId({ steps: ["bun test"], binary: null });

  test("an unchanged policy reuses the pass at this head", () => {
    const passed = verification("v4", "h2", "passed");
    expect(passed.policy_id).toBe(TODAY);
    expect(checkGate(facts({ local: { notStarted: [NOT_STARTED.id!], policy: TODAY, atHead: passed, otherPolicyAtHead: null, lastPassed: passed } }), approved).localGreen).toBe("v4");
  });

  test("strengthened steps: a pass at the same head under the old policy is verify_stale, and the way forward is to re-verify", () => {
    const r = refusal(() => checkGate(stale(under(verification("v4", "h2", "passed"), OLD)), approved));
    expect(r.code).toBe("verify_stale");
    expect(r.message).toContain("CI never started at h2");
    expect(r.message).toContain("the local verify v4 (passed) at this head ran under another verify policy");
    expect(r.message).toContain(`today's is ${TODAY.slice(0, 16)}`);
    expect(r.message).toContain("[projects.web] verify steps or verify_binary changed since");
    expect(r.help).toBe("re-verify this head under today's steps: flowryn verify t");
  });

  test("a legacy result (no policy recorded) requests re-verification, not coverage", () => {
    const r = refusal(() => checkGate(stale(under(verification("v2", "h2", "passed"), null)), approved));
    expect(r.code).toBe("verify_stale");
    expect(r.message).toContain("ran before Flowryn recorded its verify policy");
    expect(r.help).toBe("re-verify this head under today's steps: flowryn verify t");
  });

  test("a project with no verify steps today has no policy: an old pass covers nothing, and the hint says to configure them", () => {
    const r = refusal(() => checkGate(stale(verification("v4", "h2", "passed"), { policy: null }), approved));
    expect(r.code).toBe("verify_stale");
    expect(r.message).toContain("project web has no verify steps now");
    expect(r.help).toContain("add [projects.web] verify steps to config.toml");
  });

  test("a stale pass never lifts a check that ran and failed, a pending check or a missing approval", () => {
    const old = under(verification("v4", "h2", "passed"), OLD);
    const ran: Check = { name: "lint", state: "red", detail: "failure", id: 8, app: "github-actions", annotations: 1 };
    const local = { notStarted: [NOT_STARTED.id!], policy: TODAY, atHead: null, otherPolicyAtHead: old, lastPassed: old };
    expect(refusal(() => checkGate(facts({ checks: summarize([NOT_STARTED, ran]), local }), approved)).code).toBe("red_checks");
    const pending: Check = { name: "deploy", state: "pending", detail: "in_progress" };
    expect(refusal(() => checkGate(facts({ checks: summarize([NOT_STARTED, pending]), local }), approved)).code).toBe("verify_stale");
    expect(refusal(() => checkGate(facts({ local }), { choice: null, why: "none" })).code).toBe("verify_stale");
    expect(refusal(() => checkGate(facts({ local }), { choice: { kind: "yolo" }, why: "" })).code).toBe("verify_stale");
  });

  test("finishedAtHead matches the policy exactly: a legacy or other-policy row never counts, and the other read names the newest of them", () => {
    const f = fixture();
    const url = "https://github.com/acme/web/pull/1";
    const add = (policy: string | null, state: "passed" | "failed", at: number) =>
      tx(f.db, () => {
        const v = insertVerification(f.db, { project_id: "web", pr_url: url, task_id: null, head_sha: "h2", steps: [], policy_id: policy ?? "x", dir: (id) => join(f.root, id), worktree: (id) => join(f.root, id, "wt"), project_path: f.repo, source: "cli", now: at });
        if (policy === null) f.db.query("UPDATE verifications SET policy_id = NULL WHERE id = ?1").run(v.id);
        finishVerification(f.db, v, { state, steps: [], tests: null, detail: null, binary: null }, at + 1);
        return v.id;
      });
    const legacy = add(null, "passed", 10);
    expect(finishedAtHead(f.db, url, "h2", TODAY)).toBeNull();
    expect(finishedAtHeadUnderOther(f.db, url, "h2", TODAY)?.id).toBe(legacy);
    expect(finishedAtHeadUnderOther(f.db, url, "h2", null)?.id).toBe(legacy);
    const old = add(OLD, "passed", 20);
    expect(finishedAtHead(f.db, url, "h2", TODAY)).toBeNull();
    expect(finishedAtHead(f.db, url, "h2", OLD)?.id).toBe(old);
    expect(finishedAtHeadUnderOther(f.db, url, "h2", TODAY)?.id).toBe(old);
    const today = add(TODAY, "passed", 30);
    expect(finishedAtHead(f.db, url, "h2", TODAY)?.id).toBe(today);
    expect(finishedAtHeadUnderOther(f.db, url, "h2", TODAY)?.id).toBe(old);
    expect(finishedAtHead(f.db, url, "h1", TODAY)).toBeNull();
  });
});

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
