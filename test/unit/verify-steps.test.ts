import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlowrynError } from "../../src/api/errors.ts";
import { parseConfig } from "../../src/config/config.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { gitRunner } from "../../src/policy/git.ts";
import { isAlive, readIdentity, terminate, type ProcIdentity } from "../../src/runtime/proc.ts";
import { grantJobLease, liveCounts, recordJobProcess } from "../../src/sched/pools.ts";
import { flatSteps, verifyConfig, type VerifyItem } from "../../src/verify/config.ts";
import { deadlineLine, STEP_DEADLINE_FLOOR_MS, stepDeadlines } from "../../src/verify/deadline.ts";
import { verifyPolicyId } from "../../src/verify/policy.ts";
import { groupRows, initialSteps, recoverVerifications, retryLogName, runVerification, stepGroups, type VerifyDeps, type VerifyPlan } from "../../src/verify/runner.ts";
import { finishVerification, getVerification, insertVerification, type Verification, type VerifyStep } from "../../src/verify/store.ts";

/**
 * The steps inside one verification (docs/notes/2026-10-22-verify-reliability-per-xe.md):
 * parallel groups, each step's own deadline (configured or from history), the
 * process table written to its log at a deadline, and one retry of a hang.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fl-verify-steps-"));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

const config = (text: string) => parseConfig(text, "/h");

function refused(text: string): string {
  try {
    verifyConfig(config(text), "web");
  } catch (error) {
    return (error as FlowrynError).code;
  }
  return "accepted";
}

interface Fixture {
  db: Db;
  deps: VerifyDeps;
  repo: string;
  head: string;
  root: string;
  insert(steps: VerifyItem[], project?: string): Verification;
  start(steps: VerifyItem[], over?: Partial<VerifyPlan>): Promise<Verification>;
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
  db.exec(`INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('api', 'https://github.com/acme/api.git', '${repo}', 'main', 'direct-PR')`);
  const root = join(dir, "state", "verify");
  const deps: VerifyDeps = { db, git: gitRunner("git", 30_000), now: Date.now, log: () => {}, root };
  const insert = (steps: VerifyItem[], project = "web") =>
    tx(db, () => {
      const row = insertVerification(db, {
        project_id: project,
        pr_url: `https://github.com/acme/${project}/pull/1`,
        task_id: null,
        head_sha: head,
        steps: initialSteps(steps),
        policy_id: verifyPolicyId({ steps, binary: null }),
        dir: (id) => join(root, id),
        worktree: (id) => join(root, id, "wt"),
        project_path: repo,
        source: "cli",
        now: Date.now(),
      });
      grantJobLease(db, { kind: "verify", id: row.id, taskId: null }, "validation", { validation: 5 }, Date.now());
      return row;
    });
  return {
    db,
    deps,
    repo,
    head,
    root,
    insert,
    async start(steps, over = {}) {
      const v = insert(steps);
      await runVerification(deps, v, { prNumber: 1, headRef: "flowryn/t", binary: null, timeoutMs: 60_000, path: null, ...over }, { PATH: process.env.PATH, HOME: process.env.HOME });
      return getVerification(db, v.id)!;
    },
  };
}

/** A finished verification of `project` whose steps ended as given: history for the deadlines. */
function pastRun(f: Fixture, steps: Partial<VerifyStep>[], project = "web", state: "passed" | "failed" = "passed"): void {
  const v = f.insert(steps.map((s) => s.name!), project);
  const ended = steps.map((s, i) => ({ ...v.steps[i]!, state: "passed" as const, exit: 0, ms: 1_000, ...s }));
  tx(f.db, () => finishVerification(f.db, v, { state, steps: ended, tests: null, detail: null, binary: null }, Date.now()));
  tx(f.db, () => f.db.query("UPDATE job_leases SET released_at = 1, released_by = 'test' WHERE job_id = ?1").run(v.id));
}

function events(db: Db, kind: string): Record<string, unknown>[] {
  return (db.query("SELECT payload FROM events WHERE kind = ?1 ORDER BY seq").all(kind) as { payload: string }[]).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
}

async function waitFor(check: () => Promise<boolean>, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

describe("verify groups and verify_step_timeout_min in config", () => {
  test("a nested list is a parallel group, a group of one is a plain step, and verify_step_timeout_min is read", () => {
    const read = verifyConfig(config('[projects.web]\nverify = [\n  "bun install",\n  ["bun run typecheck", "npx oxlint"],\n  ["bun test"],\n]\nverify_step_timeout_min = 4\n'), "web")!;
    expect(read.steps).toEqual(["bun install", ["bun run typecheck", "npx oxlint"], "bun test"]);
    expect(read.step_timeout_ms).toBe(240_000);
    expect(flatSteps(read.steps)).toEqual(["bun install", "bun run typecheck", "npx oxlint", "bun test"]);
    expect(verifyConfig(config('[projects.web]\nverify = ["true"]\n'), "web")!.step_timeout_ms).toBeNull();
  });

  test("assumption: Bun's TOML reads a group in a one-line list only when the list does not end in ]] (docs note: break the lines)", () => {
    expect(refused('[projects.web]\nverify = ["a", ["b", "c"]]\n')).toBe("config_invalid");
    expect(verifyConfig(config('[projects.web]\nverify = ["a", ["b", "c"] ]\n'), "web")!.steps).toEqual(["a", ["b", "c"]]);
  });

  test("an empty or nested-too-deep group, a blank step in a group and a bad step timeout are refused", () => {
    expect(refused('[projects.web]\nverify = ["a", []]\n')).toBe("config_invalid");
    expect(refused('[projects.web]\nverify = [ ["a", ["b"] ] ]\n')).toBe("config_invalid");
    expect(refused('[projects.web]\nverify = [ ["a", " "] ]\n')).toBe("config_invalid");
    expect(refused('[projects.web]\nverify = [ ["a", 3] ]\n')).toBe("config_invalid");
    expect(refused('[projects.web]\nverify = ["a"]\nverify_step_timeout_min = 0\n')).toBe("config_invalid");
    expect(refused('[projects.web]\nverify = ["a"]\nverify_step_timeout_min = 1.5\n')).toBe("config_invalid");
  });
});

describe("the verify policy identity with groups", () => {
  test("assumption: a flat list hashes exactly as before groups existed (flowryn's live config, recorded on v8 and v10)", () => {
    const flowryn = verifyConfig(
      config(
        '[projects.flowryn]\nverify = ["bun install --frozen-lockfile", "bun run typecheck", "npx oxlint", "bun test", "bun run build", "./dist/flowryn doctor --contracts --verify-only --harness claude"]\nverify_binary = "dist/flowryn"\nverify_timeout_min = 45\n',
      ),
      "flowryn",
    )!;
    expect(verifyPolicyId(flowryn)).toBe("vp1:bae79e935a0ec39c8316c381903fc5ecd1785ac7c6fbf2d28a6ce327b4f99d82");
  });

  test("the same steps grouped are another policy; a group of one is the plain step; formatting noise in a group is ignored", () => {
    const flat = verifyPolicyId({ steps: ["a", "b", "c"], binary: null });
    expect(verifyPolicyId({ steps: ["a", ["b", "c"]], binary: null })).not.toBe(flat);
    expect(verifyPolicyId({ steps: [["a", "b"], "c"], binary: null })).not.toBe(verifyPolicyId({ steps: ["a", ["b", "c"]], binary: null }));
    expect(verifyPolicyId(verifyConfig(config('[projects.web]\nverify = [["a"], "b", "c"]\n'), "web")!)).toBe(flat);
    expect(verifyPolicyId({ steps: ["a", ["b  ", " c"]], binary: null })).toBe(verifyPolicyId({ steps: ["a", ["b", "c"]], binary: null }));
  });
});

describe("each step's own deadline", () => {
  test("assumption: a step with no clean pass in the project has no deadline of its own (only the run's)", () => {
    const f = fixture();
    expect(stepDeadlines(f.db, "web", ["bun test"], null)).toEqual([null]);
  });

  test("it is 3× the slowest of the step's last 5 clean passes, and never under 2 min", () => {
    const f = fixture();
    // Oldest first: the 100 s pass is the sixth newest, so it no longer counts.
    for (const ms of [100_000, 40_000, 10_000, 60_000, 20_000, 30_000]) pastRun(f, [{ name: "doctor", ms }, { name: "typecheck", ms: 900 }]);
    const [doctor, typecheck] = stepDeadlines(f.db, "web", ["doctor", "typecheck"], null);
    expect(doctor).toEqual({ ms: 180_000, source: "history", usual_ms: 60_000 });
    expect(typecheck).toEqual({ ms: STEP_DEADLINE_FLOOR_MS, source: "history", usual_ms: 900 });
    expect(deadlineLine(typecheck!)).toBe("its 2 min deadline (it usually takes 0.9 s)");
    expect(deadlineLine(doctor!)).toBe("its 3 min deadline (it usually takes 1 min)");
  });

  test("a retried or hung pass, a failed step, a running row and another project's history do not count", () => {
    const f = fixture();
    pastRun(f, [{ name: "a", ms: 900_000, attempts: 2, hangs: 1 }]);
    pastRun(f, [{ name: "a", state: "failed", exit: 1, ms: 900_000 }], "web", "failed");
    pastRun(f, [{ name: "a", ms: 900_000 }], "api");
    f.insert(["a"]);
    expect(stepDeadlines(f.db, "web", ["a"], null)).toEqual([null]);
    pastRun(f, [{ name: "  a ", ms: 50_000 }]);
    // Formatting noise does not split a step's history.
    expect(stepDeadlines(f.db, "web", ["a"], null)[0]?.ms).toBe(150_000);
  });

  test("verify_step_timeout_min overrides history for every step", () => {
    const f = fixture();
    pastRun(f, [{ name: "a", ms: 1_000 }]);
    expect(stepDeadlines(f.db, "web", ["a", "b"], 300_000)).toEqual([
      { ms: 300_000, source: "config", usual_ms: null },
      { ms: 300_000, source: "config", usual_ms: null },
    ]);
    expect(deadlineLine({ ms: 300_000, source: "config", usual_ms: null })).toBe("its 5 min deadline (verify_step_timeout_min)");
  });

  test("the job records each step's deadline from the project's history", async () => {
    const f = fixture();
    pastRun(f, [{ name: "true", ms: 10 }]);
    const v = await f.start(["true", "echo new"]);
    expect(v.state).toBe("passed");
    expect(v.steps.map((s) => s.deadline_ms)).toEqual([STEP_DEADLINE_FLOOR_MS, null]);
  });
});

describe("a hang at a step's own deadline", () => {
  test(
    "assumption: a hung step is killed at its own deadline, its process group is written to its log, and it passes on its one retry",
    async () => {
      const f = fixture();
      const marker = join(tempDir(), "ran-once");
      const began = Date.now();
      const v = await f.start([`if [ -f ${marker} ]; then echo second; else touch ${marker}; sleep 30; fi`, "true"], { stepTimeoutMs: 700 });
      expect(Date.now() - began).toBeLessThan(15_000);
      expect(v.state).toBe("passed");
      const [hung, next] = v.steps;
      expect(hung).toMatchObject({ state: "passed", exit: 0, attempts: 2, hangs: 1, deadline_ms: 700 });
      expect(hung!.log.endsWith(".retry.log")).toBe(true);
      const firstLog = hung!.log.replace(/\.retry\.log$/, ".log");
      const listing = readFileSync(join(v.dir, firstLog), "utf8");
      expect(listing).toContain("--- flowryn verify: killed at its 0.7 s deadline (verify_step_timeout_min); its process group");
      expect(listing).toMatch(/PID\s+PPID\s+PGID/);
      expect(listing).toContain("sleep 30");
      expect(readFileSync(join(v.dir, hung!.log), "utf8")).toContain("second");
      expect(hung!.detail).toBe(`hung once: killed at its 0.7 s deadline (verify_step_timeout_min), process group in ${firstLog}; passed on its retry`);
      expect(v.detail).toContain("passed on its retry");
      expect(next).toMatchObject({ state: "passed", attempts: 1, hangs: 0 });
      const ran = events(f.db, "pr.verify_step").filter((e) => e.step === hung!.name);
      expect(ran.map((e) => [e.state, e.attempt])).toEqual([["running", 1], ["running", 2], ["passed", 2]]);
    },
    20_000,
  );

  test(
    "a step that hangs on its retry too fails the run, naming both hangs; later steps never start",
    async () => {
      const f = fixture();
      const v = await f.start(["sleep 30", "touch never"], { stepTimeoutMs: 500 });
      expect(v.state).toBe("failed");
      expect(v.steps.map((s) => s.state)).toEqual(["failed", "waiting"]);
      expect(v.steps[0]).toMatchObject({ attempts: 2, hangs: 2 });
      expect(v.detail).toBe("hung twice: killed at its 0.5 s deadline (verify_step_timeout_min) both times; process groups in 1-sleep-30.log and 1-sleep-30.retry.log");
      for (const log of ["1-sleep-30.log", "1-sleep-30.retry.log"]) expect(readFileSync(join(v.dir, log), "utf8")).toContain("--- flowryn verify: killed at");
    },
    20_000,
  );

  test(
    "the run's own deadline is never retried, and the step's process group is written to its log there too",
    async () => {
      const f = fixture();
      const v = await f.start(["sleep 30"], { timeoutMs: 500, stepTimeoutMs: 60_000 });
      expect(v.state).toBe("failed");
      expect(v.steps[0]).toMatchObject({ attempts: 1, hangs: 0, detail: "timed out: the run's 0.5 s were up" });
      expect(readFileSync(join(v.dir, v.steps[0]!.log), "utf8")).toContain("killed at the run's 0.5 s deadline");
    },
    20_000,
  );

  test("a listing that fails is noted in the log and the kill still happens", async () => {
    const f = fixture();
    f.deps.groupTable = async () => {
      throw new Error("no ps here");
    };
    const v = await f.start(["sleep 30"], { timeoutMs: 400 });
    expect(v.state).toBe("failed");
    expect(readFileSync(join(v.dir, v.steps[0]!.log), "utf8")).toContain("listing the process group failed: no ps here");
  }, 20_000);
});

describe("parallel groups", () => {
  test(
    "assumption: the steps of a group run at the same time (each waits for the other's marker)",
    async () => {
      const f = fixture();
      const dir = tempDir();
      const meet = (mine: string, theirs: string) => `touch ${join(dir, mine)}; for i in $(seq 100); do [ -f ${join(dir, theirs)} ] && exit 0; sleep 0.05; done; exit 9`;
      const v = await f.start(["true", [meet("a", "b"), meet("b", "a")], "true"]);
      expect(v.state).toBe("passed");
      expect(v.steps.map((s) => [s.state, s.group])).toEqual([["passed", 0], ["passed", 1], ["passed", 1], ["passed", 2]]);
      // One log per step, numbered in order.
      expect(v.steps.map((s) => s.log.split("-")[0])).toEqual(["1", "2", "3", "4"]);
    },
    20_000,
  );

  test(
    "a failing step stops its running siblings; the run fails naming it, and the next group never starts",
    async () => {
      const f = fixture();
      const began = Date.now();
      const v = await f.start([["sleep 0.3; exit 3", "sleep 30"], "touch never"]);
      expect(Date.now() - began).toBeLessThan(10_000);
      expect(v.state).toBe("failed");
      expect(v.steps.map((s) => s.state)).toEqual(["failed", "stopped", "waiting"]);
      expect(v.steps[1]!.detail).toBe("stopped: sleep 0.3; exit 3 failed");
      expect(v.detail).toBe("sleep 0.3; exit 3 exited 3");
      expect(liveCounts(f.db)).toEqual({});
    },
    20_000,
  );

  test("a row from before groups runs each step on its own; groups keep their order", () => {
    const old = initialSteps(["a", "b", "c"]).map(({ group: _g, ...s }) => s);
    expect(stepGroups(old)).toEqual([[0], [1], [2]]);
    expect(stepGroups(initialSteps(["a", ["b", "c"], "d", ["e", "f"]]))).toEqual([[0], [1, 2], [3], [4, 5]]);
  });

  test(
    "assumption: startup recovery ends every step group a parallel job left running",
    async () => {
      const f = fixture();
      const v = f.insert([["sleep 30", "sleep 30"]]);
      const procs: ProcIdentity[] = [];
      for (let i = 0; i < 2; i++) {
        const child = spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
        child.unref();
        let proc: ProcIdentity | null = null;
        await waitFor(async () => (proc = await readIdentity(child.pid!)) !== null && proc.exe !== "(sh)");
        procs.push(proc!);
        tx(f.db, () => recordJobProcess(f.db, { kind: "verify", id: v.id, taskId: null }, proc!, Date.now()));
      }
      f.deps.terminate = (p, options) => terminate(p, { ...options, graceMs: 1_000 });
      expect(await recoverVerifications(f.deps)).toBe(1);
      for (const proc of procs) expect(await isAlive(proc)).toBe(false);
      expect(getVerification(f.db, v.id)).toMatchObject({ state: "error", detail: "the daemon stopped mid-run" });
      expect(liveCounts(f.db)).toEqual({});
    },
    20_000,
  );
});

describe("the process table at a deadline", () => {
  test("only the header and the rows of the step's process group are kept", () => {
    const table = ["  PID  PPID  PGID STAT ELAPSED TIME RSS COMMAND", "  10     1    10 Ss   00:05 0:00.01 100 /bin/sh -c tsc", "  11    10    10 S    00:05 0:00.50 900 node tsc --noEmit", "  12     1    12 S    00:05 0:00.01 100 /usr/bin/other 10", ""].join("\n");
    expect(groupRows(table, 10).split("\n")).toEqual([
      "  PID  PPID  PGID STAT ELAPSED TIME RSS COMMAND",
      "  10     1    10 Ss   00:05 0:00.01 100 /bin/sh -c tsc",
      "  11    10    10 S    00:05 0:00.50 900 node tsc --noEmit",
    ]);
    expect(groupRows("", 10)).toBe("");
  });

  test("retry logs sit beside the first", () => {
    expect(retryLogName("2-bun-run-typecheck.log")).toBe("2-bun-run-typecheck.retry.log");
  });
});
