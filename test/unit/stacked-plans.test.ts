import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlowrynError } from "../../src/api/errors.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { ForgeError, type Forge, type PullRequest } from "../../src/forge/types.ts";
import { parsePlan, pendingPlanLine, recordPlan } from "../../src/lifecycle/plans.ts";
import type { ProjectRow } from "../../src/lifecycle/projects.ts";
import { getRun } from "../../src/lifecycle/runs.ts";
import { MAX_STACK_DEPTH, phaseReadiness, retargetStacks, steerStackedOnRedelivery, takeBaseSteps } from "../../src/lifecycle/stacks.ts";
import { checkGate } from "../../src/policy/merge.ts";

/**
 * Stacked plans (docs/notes/2026-10-27-stack-a-plan-4y.md, phase 2): the
 * plan's opt-in, when a phase may start on the open PR beneath it, the merges
 * that take a squash-merged base in, the retarget pass, and the base-lost P1.
 * The whole flow through a daemon is test/integration/stacked-plans.test.ts.
 */

describe("the plan's stack line", () => {
  test("stack: on before the first ## stacks the plan; off or no line does not", () => {
    expect(parsePlan("# T\nstack: on\n## One\nx").stack).toBe(true);
    expect(parsePlan("Stack: ON\n## One\nx").stack).toBe(true);
    expect(parsePlan("stack: off\n## One\nx").stack).toBe(false);
    expect(parsePlan("## One\nx").stack).toBe(false);
    // Inside a phase it is the phase's text, not the plan's opt-in.
    const inside = parsePlan("## One\nstack: on");
    expect(inside.stack).toBe(false);
    expect(inside.phases[0]!.body).toBe("stack: on");
  });

  test("any other value is refused", () => {
    expect(() => parsePlan("stack: yes\n## One\nx")).toThrow("takes on or off");
  });
});

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function git(cwd: string, args: string[]): { code: number; out: string } {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdin: "ignore", env: GIT_ENV });
  return { code: result.exitCode, out: `${result.stdout.toString()}${result.stderr.toString()}`.trim() };
}

function ok(cwd: string, args: string[]): string {
  const result = git(cwd, args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.out}`);
  return result.out;
}

function commit(cwd: string, file: string, text: string, message: string): void {
  writeFileSync(join(cwd, file), text);
  ok(cwd, ["add", file]);
  ok(cwd, ["commit", "-q", "-m", message]);
}

describe("taking a squash-merged base into a stacked branch", () => {
  let dir: string;
  let origin: string;
  let work: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fw-stack-git-"));
    origin = join(dir, "origin.git");
    ok(dir, ["init", "-q", "--bare", "-b", "main", origin]);
    ok(dir, ["clone", "-q", origin, "work"]);
    work = join(dir, "work");
    commit(work, "f", "a\nb\nc\n", "base");
    ok(work, ["push", "-q", "origin", "HEAD:main"]);
    // Phase 1 adds a line; phase 2, stacked on it, changes that line; phase 1 then gets a review fix phase 2 follows.
    ok(work, ["switch", "-q", "-c", "one"]);
    commit(work, "f", "a\nB1\nc\nd\n", "phase 1");
    ok(work, ["switch", "-q", "-c", "two"]);
    commit(work, "f", "a\nB1\nc\nD2\n", "phase 2");
    commit(work, "g", "x\n", "phase 2 more");
    ok(work, ["switch", "-q", "one"]);
    commit(work, "h", "fix\n", "phase 1 review fix");
    ok(work, ["switch", "-q", "two"]);
    ok(work, ["merge", "-q", "--no-edit", "one"]);
    // main moves on, then phase 1 lands as a squash (GitHub's squash: one parent, phase 1's whole change).
    ok(work, ["switch", "-q", "main"]);
    commit(work, "other", "z\n", "unrelated");
    ok(work, ["merge", "-q", "--squash", "one"]);
    ok(work, ["commit", "-q", "-m", "phase 1 (#1)"]);
    commit(work, "after", "w\n", "after the landing");
    ok(work, ["push", "-q", "origin", "HEAD:main"]);
    ok(work, ["push", "-q", "origin", "one:one"]);
    ok(work, ["switch", "-q", "two"]);
    ok(work, ["fetch", "-q", "origin"]);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("assumption: a plain merge of main conflicts once phase 2 changed a line phase 1 added", () => {
    expect(git(work, ["merge-tree", "--write-tree", "HEAD", "origin/main"]).code).not.toBe(0);
  });

  test("assumption: the named merges are clean and leave only phase 2's own changes against main", () => {
    const squash = ok(work, ["rev-parse", "origin/main~1"]);
    const finalHead = ok(work, ["rev-parse", "one"]);
    const before = ok(work, ["rev-parse", "HEAD"]);
    for (const step of takeBaseSteps("main", finalHead, squash).split("\n")) {
      expect(git(work, step.split(" ").slice(1)), step).toMatchObject({ code: 0 });
    }
    // Only new commits on top: history is never rewritten.
    expect(git(work, ["merge-base", "--is-ancestor", before, "HEAD"]).code).toBe(0);
    expect(ok(work, ["diff", "--name-only", "origin/main", "HEAD"]).split("\n").toSorted()).toEqual(["f", "g"]);
    expect(ok(work, ["show", "HEAD:f"])).toBe("a\nB1\nc\nD2");
  });

  test("the same merges are clean after a merge-commit landing", () => {
    ok(work, ["switch", "-q", "main"]);
    ok(work, ["reset", "-q", "--hard", "origin/main~2"]);
    ok(work, ["merge", "-q", "--no-ff", "--no-edit", "one"]);
    const landing = ok(work, ["rev-parse", "HEAD"]);
    ok(work, ["push", "-q", "-f", "origin", "HEAD:main"]);
    ok(work, ["switch", "-q", "two"]);
    ok(work, ["fetch", "-q", "origin"]);
    for (const step of takeBaseSteps("main", ok(work, ["rev-parse", "one"]), landing).split("\n")) {
      expect(git(work, step.split(" ").slice(1)), step).toMatchObject({ code: 0 });
    }
    expect(ok(work, ["diff", "--name-only", "origin/main", "HEAD"]).split("\n").toSorted()).toEqual(["f", "g"]);
  });
});

const HEAD = "a".repeat(40);

function forge(prs: PullRequest[], fail = false): Forge & { patched: { number: number; base: string }[] } {
  const patched: { number: number; base: string }[] = [];
  return {
    patched,
    pull: async () => prs[0]!,
    pullsForBranch: async () => prs,
    checks: async () => ({ state: "none", checks: [] }),
    annotations: async () => [],
    merge: async () => ({ merged: false, sha: null, message: "" }),
    feedback: async () => ({ reviews: [], reviewComments: [], issueComments: [] }),
    reviewThreads: async () => [],
    setBase: async (ref, base) => {
      if (fail) throw new ForgeError("unreachable", "GitHub is down (test)");
      patched.push({ number: ref.number, base });
      return { ...prs.find((p) => p.number === ref.number)!, baseRef: base };
    },
  };
}

function pr(number: number, baseRef: string, state: PullRequest["state"] = "open"): PullRequest {
  return { number, url: `https://github.com/acme/web/pull/${number}`, title: "t", state, draft: false, headSha: HEAD, headRef: "flowryn/two", headRepo: "acme/web", baseRef, mergeSha: null, mergedAt: null, mergeable: null };
}

describe("stacked runs in the database", () => {
  let dir: string;
  let db: Db;
  const now = 9_000_000;
  const project: ProjectRow = { id: "p", repo_url: "https://github.com/acme/web", path: "/p", default_branch: "main", delivery_mode: "direct-PR", yolo: 0, priority: 2, harness: "claude", workflow: "fix", autonomy: "plan" };

  function addRun(task: string, state: string, opts: { stackedOn?: string | null; base?: string | null; mode?: string; started?: number; id?: string } = {}): string {
    const id = opts.id ?? `r-${task}`;
    db.query("INSERT OR IGNORE INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES (?1, 'p', 'ship', ?2, 0, 'fix', ?3)").run(task, opts.mode ?? "direct-PR", now);
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, base_branch, stacked_on, token_hash, started_at, updated_at)
       VALUES (?1, ?2, 'claude', 'v', ?3, 'idle', 'fix', 'ship', '/w', ?4, 's', ?5, ?6, ?1, ?7, ?7)`,
    ).run(id, task, state, `flowryn/${task}`, opts.base ?? null, opts.stackedOn ?? null, opts.started ?? now);
    return id;
  }

  function deliver(task: string, number: number, head = HEAD): void {
    db.query("INSERT INTO artifacts (id, task_id, kind, ref, head_sha, created_at) VALUES (?1, ?2, 'pr', ?3, ?4, ?5)").run(`a-${task}-${head.slice(0, 4)}`, task, `https://github.com/acme/web/pull/${number}`, head, now);
  }

  function stackedPlan(): { one: string; two: string } {
    const filed = recordPlan(db, { project, title: "t", phases: parsePlan("stack: on\n## One\nx\n## Two\ny").phases, stack: true, sourceTask: null, gateId: null, workflow: "fix", filedBy: "test", state: "approved", now });
    return { one: filed.phases[0]!.task_id, two: filed.phases[1]!.task_id };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fw-stacks-"));
    db = openDb(join(dir, "flowryn.db"));
    migrate(db);
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('p', 'https://github.com/acme/web', '/p', 'main', 'direct-PR')").run();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a stacked phase is ready on a delivered, open PR beneath it; an unstacked one waits for the landing", () => {
    const { one, two } = tx(db, () => stackedPlan());
    expect(phaseReadiness(db, two, null, [one])).toMatchObject({ ready: false, waiting: [one], why: `${one} has not delivered` });
    tx(db, () => {
      addRun(one, "ready");
      deliver(one, 1);
    });
    expect(phaseReadiness(db, two, null, [one])).toEqual({ ready: true, stack: { task: one, run: `r-${one}`, branch: `flowryn/${one}`, head: HEAD, ref: "https://github.com/acme/web/pull/1" } });

    const plain = tx(db, () => recordPlan(db, { project, title: "u", phases: parsePlan("## A\nx\n## B\ny").phases, sourceTask: null, gateId: null, workflow: "fix", filedBy: "test", state: "approved", now }));
    tx(db, () => {
      addRun(plain.phases[0]!.task_id, "ready");
      deliver(plain.phases[0]!.task_id, 3);
    });
    expect(phaseReadiness(db, plain.phases[1]!.task_id, null, [plain.phases[0]!.task_id])).toMatchObject({ ready: false, why: null });
  });

  test("a draft or closed PR beneath, or a stack already three deep, is not stacked on", () => {
    const { one, two } = tx(db, () => stackedPlan());
    const run = tx(db, () => {
      deliver(one, 1);
      return addRun(one, "ready");
    });
    tx(db, () => db.query("INSERT INTO run_evidence (run_id, source, rank, value, observed_at) VALUES (?1, 'github', 1, ?2, ?3)").run(run, JSON.stringify({ state: "open", draft: true }), now));
    expect(phaseReadiness(db, two, null, [one])).toMatchObject({ ready: false, why: `${one}'s PR is a draft` });
    tx(db, () => db.query("UPDATE run_evidence SET value = ?2 WHERE run_id = ?1").run(run, JSON.stringify({ state: "open", draft: false })));
    expect(phaseReadiness(db, two, null, [one])).toMatchObject({ ready: true });

    // one sits on x, which sits on y: the next one would be the fourth open PR in the stack.
    tx(db, () => {
      addRun("y", "ready");
      addRun("x", "ready", { stackedOn: "y" });
      db.query("UPDATE runs SET stacked_on = 'x' WHERE id = ?1").run(run);
    });
    expect(MAX_STACK_DEPTH).toBe(3);
    expect(phaseReadiness(db, two, null, [one])).toMatchObject({ ready: false, why: "3 stacked PRs already sit beneath it" });
  });

  test("a stacked plan is refused for a local-only project, and the gate's plan line says stacked", () => {
    expect(() => tx(db, () => recordPlan(db, { project: { ...project, delivery_mode: "local-only" }, title: "t", phases: parsePlan("## One\nx").phases, stack: true, sourceTask: null, gateId: null, workflow: "fix", filedBy: "test", state: "approved", now }))).toThrow(FlowrynError);
    tx(db, () => recordPlan(db, { project, title: "t", phases: parsePlan("## One\nx\n## Two\ny").phases, stack: true, sourceTask: "src", gateId: "g1", workflow: "fix", filedBy: "test", state: "pending", now }));
    expect(pendingPlanLine(db, "g1")).toContain("2 stacked phases that start by themselves once the task before each delivers its PR");
  });

  test("the merge gate refuses a stacked run (stack_not_landed)", () => {
    const run = { task_id: "two", stacked_on: "one" } as never;
    expect(() => checkGate({ run, delivered: {}, pr: null, project } as never, {} as never)).toThrow("stacked on one, which has not landed");
  });

  test("a new head beneath steers the working runs stacked on it, not the delivered ones", () => {
    tx(db, () => {
      addRun("one", "ready");
      addRun("work", "running", { stackedOn: "one", base: "flowryn/one" });
      addRun("done", "ready", { stackedOn: "one", base: "flowryn/one" });
    });
    expect(tx(db, () => steerStackedOnRedelivery(db, "one", HEAD, HEAD, "flowryn/one", now))).toEqual([]);
    expect(tx(db, () => steerStackedOnRedelivery(db, "one", HEAD, "b".repeat(40), "flowryn/one", now))).toEqual(["r-work"]);
    const body = (db.query("SELECT body FROM messages WHERE run_id = 'r-work'").get() as { body: string }).body;
    expect(body).toContain("git merge --no-edit origin/flowryn/one");
  });

  function landOne(): void {
    tx(db, () => {
      const run = addRun("one", "landed");
      deliver("one", 1);
      appendEvent(db, { source: "daemon", kind: "run.landed", runId: run, taskId: "one", payload: { merge_sha: "c".repeat(40) }, ts: now });
    });
  }

  const deps = (f: Forge) => ({ db, forge: () => f, webUrl: () => "https://github.com", now: () => now, log: () => {}, kickScheduler: () => {} });

  test("a working stacked run whose base landed has its open PR moved to main and is steered with the merges", async () => {
    landOne();
    tx(db, () => addRun("two", "running", { stackedOn: "one", base: "flowryn/one" }));
    const f = forge([pr(2, "flowryn/one"), pr(1, "flowryn/one", "closed")]);
    await retargetStacks(deps(f));
    expect(f.patched).toEqual([{ number: 2, base: "main" }]);
    expect(getRun(db, "r-two")).toMatchObject({ base_branch: null, stacked_on: null, state: "running" });
    const event = JSON.parse((db.query("SELECT payload FROM events WHERE kind = 'run.retargeted'").get() as { payload: string }).payload);
    expect(event).toMatchObject({ from: "flowryn/one", to: "main", on: "one", merge_sha: "c".repeat(40) });
    const body = (db.query("SELECT body FROM messages WHERE run_id = 'r-two'").get() as { body: string }).body;
    expect(body).toContain(`git merge --no-edit -s ours ${"c".repeat(40)}`);
    expect(body).toContain("git fetch origin refs/pull/1/head");
  });

  test("a PR GitHub already moved is not patched; a forge failure leaves the run stacked for the next pass", async () => {
    landOne();
    tx(db, () => addRun("two", "running", { stackedOn: "one", base: "flowryn/one" }));
    await retargetStacks(deps(forge([pr(2, "flowryn/one")], true)));
    expect(getRun(db, "r-two")).toMatchObject({ stacked_on: "one", base_branch: "flowryn/one" });
    const moved = forge([pr(2, "main")]);
    await retargetStacks(deps(moved));
    expect(moved.patched).toEqual([]);
    expect(getRun(db, "r-two")).toMatchObject({ stacked_on: null, base_branch: null });
  });

  test("a base that can no longer land opens one stack_base_lost, settled when it comes back", async () => {
    tx(db, () => {
      addRun("one", "failed");
      addRun("two", "ready", { stackedOn: "one", base: "flowryn/one" });
    });
    const f = forge([]);
    await retargetStacks(deps(f));
    await retargetStacks(deps(f));
    const items = () => db.query("SELECT kind, line, resolved_at FROM items WHERE kind = 'stack_base_lost'").all() as { line: string; resolved_at: number | null }[];
    expect(items()).toHaveLength(1);
    expect(items()[0]!.line).toContain("one's run failed");
    // one runs again and delivers: the base is back.
    tx(db, () => {
      addRun("one", "ready", { started: now + 1, id: "r-one-again" });
    });
    await retargetStacks(deps(f));
    expect(items()[0]!.resolved_at).not.toBeNull();
    expect(getRun(db, "r-two")).toMatchObject({ stacked_on: "one" });
  });
});
