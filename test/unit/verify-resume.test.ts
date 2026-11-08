import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { gitRunner } from "../../src/policy/git.ts";
import { grantJobLease } from "../../src/sched/pools.ts";
import type { VerifyConfig } from "../../src/verify/config.ts";
import { verifyPolicyId } from "../../src/verify/policy.ts";
import { insertRequest } from "../../src/verify/queue.ts";
import { initialSteps, recoverVerifications, runVerification, stopVerifications, type VerifyDeps } from "../../src/verify/runner.ts";
import { admitRequest } from "../../src/verify/start.ts";
import { getVerification, insertVerification, STOPPED_MID_RUN, type Verification } from "../../src/verify/store.ts";

/**
 * Verify resume (docs/notes/2026-11-07-faster-landing-test-q7.md): a verification a daemon stop
 * cut off keeps its worktree, and the next one of the same PR, head and policy takes it over,
 * keeping the steps that passed (with their logs) and running from the first unfinished one.
 * Real git, real worktrees, real shell steps.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PR = "https://github.com/acme/web/pull/1";
const CAPS = { validation: 5 };

function git(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

interface Fixture {
  db: Db;
  deps: VerifyDeps;
  repo: string;
  head: string;
  root: string;
  /** Lines appended by the first step each time it really runs. */
  counter: string;
  /** While absent, the second step hangs (it is cut off); once there, it passes. */
  go: string;
  steps: string[];
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "fl-resume-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  const db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  const root = join(dir, "state", "verify");
  const counter = join(dir, "counter");
  const go = join(dir, "go");
  // The first step builds something in the worktree the second needs: a resume must keep the worktree, not only the row.
  const steps = [`echo ran >> ${counter} && touch built`, `test -f built && { test -f ${go} || sleep 30; }`];
  return { db, deps: { db, git: gitRunner("git", 30_000), now: Date.now, log: () => {}, root }, repo, head: git(repo, ["rev-parse", "HEAD"]), root, counter, go, steps };
}

function configOf(steps: string[]): VerifyConfig {
  return { steps, review: null, binary: null, timeout_ms: 60_000, step_timeout_ms: null };
}

/** A request and its admission, as the drain does it. */
function admit(f: Fixture, steps = f.steps, head = f.head): Verification {
  return tx(f.db, () => {
    const config = configOf(steps);
    const request = insertRequest(f.db, { project_id: "web", pr_url: PR, task_id: null, head_sha: head, policy_id: verifyPolicyId(config), pr_number: 1, head_ref: "flowryn/t", worktree: null, source: "auto", path: null, now: Date.now() });
    return admitRequest(f.db, request, config, CAPS, f.root, f.repo, Date.now());
  });
}

function run(f: Fixture, v: Verification): Promise<void> {
  return runVerification(f.deps, v, { prNumber: 1, headRef: "flowryn/t", binary: null, timeoutMs: 60_000, path: null }, { PATH: process.env.PATH, HOME: process.env.HOME });
}

async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

/** Start a verification and stop the daemon's jobs while its second step runs. */
async function interrupted(f: Fixture): Promise<Verification> {
  const v = admit(f);
  const job = run(f, v);
  await waitFor(() => getVerification(f.db, v.id)!.steps[1]!.state === "running");
  stopVerifications();
  await job;
  // There is something to resume from: the cases that start fresh do so by the rule, not for want of a worktree.
  expect(existsSync(v.worktree_path)).toBe(true);
  return getVerification(f.db, v.id)!;
}

function ranCount(f: Fixture): number {
  return existsSync(f.counter) ? readFileSync(f.counter, "utf8").trim().split("\n").length : 0;
}

function events(db: Db, kind: string): Record<string, unknown>[] {
  return (db.query("SELECT payload FROM events WHERE kind = ?1 ORDER BY seq").all(kind) as { payload: string }[]).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
}

describe("a verification a stop cut off", () => {
  test("assumption: it keeps its worktree, and the next one at the same head and policy resumes: the passed step is kept with its log, the rest runs", async () => {
    const f = fixture();
    const first = await interrupted(f);
    expect(first).toMatchObject({ state: "error", detail: STOPPED_MID_RUN });
    expect(first.steps.map((s) => s.state)).toEqual(["passed", "failed"]);
    expect(existsSync(join(first.worktree_path, "built"))).toBe(true);
    expect(ranCount(f)).toBe(1);

    writeFileSync(f.go, "");
    const second = admit(f);
    expect(second.steps[0]).toMatchObject({ state: "passed", resumed_from: first.id, detail: `kept from ${first.id}` });
    expect(second.steps[1]).toMatchObject({ state: "waiting" });
    expect(events(f.db, "pr.verify_started").at(-1)).toMatchObject({ verification: second.id, resumed_from: first.id, kept: [f.steps[0]] });
    await run(f, second);

    const done = getVerification(f.db, second.id)!;
    expect(done.state).toBe("passed");
    expect(done.steps.map((s) => s.state)).toEqual(["passed", "passed"]);
    // The first step did not run again, and the second found what it built.
    expect(ranCount(f)).toBe(1);
    expect(readFileSync(join(done.dir, done.steps[0]!.log), "utf8")).toBe(readFileSync(join(first.dir, first.steps[0]!.log), "utf8"));
    expect(existsSync(first.worktree_path)).toBe(false);
    expect(existsSync(done.worktree_path)).toBe(false);
    expect(git(f.repo, ["worktree", "list", "--porcelain"])).not.toContain(f.root);
  }, 30_000);

  test("one a dead daemon left running keeps its worktree through startup recovery and resumes", async () => {
    const f = fixture();
    // As the last daemon left it: the first step passed, the second was running, the slot held.
    const v = tx(f.db, () => {
      const row = insertVerification(f.db, { project_id: "web", pr_url: PR, task_id: null, head_sha: f.head, steps: initialSteps(f.steps), policy_id: verifyPolicyId(configOf(f.steps)), dir: (id) => join(f.root, id), worktree: (id) => join(f.root, id, "wt"), project_path: f.repo, source: "daemon", now: Date.now() });
      grantJobLease(f.db, { kind: "verify", id: row.id, taskId: null }, "validation", CAPS, Date.now());
      const steps = row.steps.map((s, i) => (i === 0 ? { ...s, state: "passed" as const, exit: 0, ms: 5 } : { ...s, state: "running" as const }));
      f.db.query("UPDATE verifications SET steps = ?2 WHERE id = ?1").run(row.id, JSON.stringify(steps));
      return row;
    });
    mkdirSync(v.dir, { recursive: true });
    writeFileSync(join(v.dir, v.steps[0]!.log), "first step's output\n");
    git(f.repo, ["worktree", "add", "--detach", v.worktree_path, f.head]);
    writeFileSync(join(v.worktree_path, "built"), "");
    expect(await recoverVerifications(f.deps)).toBe(1);
    expect(getVerification(f.db, v.id)).toMatchObject({ state: "error", detail: STOPPED_MID_RUN });
    expect(existsSync(v.worktree_path)).toBe(true);

    writeFileSync(f.go, "");
    const resumed = admit(f);
    expect(resumed.steps[0]!.resumed_from).toBe(v.id);
    await run(f, resumed);
    expect(getVerification(f.db, resumed.id)).toMatchObject({ state: "passed" });
    expect(ranCount(f)).toBe(0);
    expect(readFileSync(join(resumed.dir, resumed.steps[0]!.log), "utf8")).toBe("first step's output\n");
  }, 30_000);

  test("assumption: a new head during the interrupt starts fresh: no step is kept", async () => {
    const f = fixture();
    await interrupted(f);
    writeFileSync(join(f.repo, "next.txt"), "next\n");
    git(f.repo, ["add", "."]);
    git(f.repo, ["commit", "-q", "-m", "next"]);
    const moved = git(f.repo, ["rev-parse", "HEAD"]);
    writeFileSync(f.go, "");
    const fresh = admit(f, f.steps, moved);
    expect(fresh.steps.every((s) => s.state === "waiting" && s.resumed_from === undefined)).toBe(true);
    expect(events(f.db, "pr.verify_started").at(-1)!.resumed_from).toBeUndefined();
    await run(f, fresh);
    expect(getVerification(f.db, fresh.id)!.state).toBe("passed");
    expect(ranCount(f)).toBe(2);
  }, 30_000);

  test("assumption: a changed verify policy during the interrupt starts fresh: no step is kept", async () => {
    const f = fixture();
    await interrupted(f);
    writeFileSync(f.go, "");
    const changed = [...f.steps, "true"];
    const fresh = admit(f, changed);
    expect(fresh.steps.every((s) => s.state === "waiting" && s.resumed_from === undefined)).toBe(true);
    await run(f, fresh);
    expect(getVerification(f.db, fresh.id)!.state).toBe("passed");
    expect(ranCount(f)).toBe(2);
  }, 30_000);

  test("a source worktree that is gone, or not at the head, drops the resume with an event and runs every step", async () => {
    const f = fixture();
    const first = await interrupted(f);
    writeFileSync(f.go, "");
    const second = admit(f);
    expect(second.steps[0]!.resumed_from).toBe(first.id);
    // Something moved the kept worktree off the head between the admission and the run.
    writeFileSync(join(first.worktree_path, "x.txt"), "x\n");
    git(first.worktree_path, ["add", "."]);
    git(first.worktree_path, ["commit", "-q", "-m", "x"]);
    await run(f, second);
    const done = getVerification(f.db, second.id)!;
    expect(done.state).toBe("passed");
    expect(done.steps.every((s) => s.resumed_from === undefined)).toBe(true);
    expect(ranCount(f)).toBe(2);
    expect(events(f.db, "pr.verify_resume_dropped")).toEqual([{ verification: second.id, from: first.id, why: expect.stringContaining(`not ${f.head.slice(0, 8)}`) }]);
  }, 30_000);

  test("a verification that failed (not cut off) is never resumed", async () => {
    const f = fixture();
    const v = admit(f, [`echo ran >> ${f.counter}`, "exit 3"]);
    await run(f, v);
    expect(getVerification(f.db, v.id)!.state).toBe("failed");
    const again = admit(f, [`echo ran >> ${f.counter}`, "exit 3"]);
    expect(again.steps.every((s) => s.resumed_from === undefined)).toBe(true);
  }, 30_000);
});
