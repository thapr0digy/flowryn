import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_IDLE_NUDGE_MAX, DEFAULT_IDLE_NUDGE_MIN, DEFAULT_TIMING, workersConfig } from "../../src/config/workers.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { backgroundStartOf, recordBackgroundStart } from "../../src/lifecycle/background-jobs.ts";
import {
  NO_GIT_FACTS,
  NUDGE_KIND,
  nudgeText,
  readGitFacts,
  runIdleNudge,
  STALLED_KIND,
  UNKNOWN_KIND,
  type GitFacts,
  type IdleNudgeConfig,
} from "../../src/lifecycle/idle-nudge.ts";
import { openBlockedPrompt } from "../../src/lifecycle/prompt-wedge.ts";
import { getRun } from "../../src/lifecycle/runs.ts";
import { ackSteer, createSteer, getMessage, markRung, markSeen } from "../../src/lifecycle/steers.ts";
import { gitRunner } from "../../src/policy/git.ts";
import type { GitRunner } from "../../src/policy/landed.ts";
import type { FlowrynConfig } from "../../src/config/config.ts";

/**
 * The idle-with-work nudge (no-idle-workers-23 phase 2): a stopped worker
 * with work left gets a fixed steer at 10, 20 and 40 minutes, then one
 * worker_stalled P1; never while it rightly waits.
 */

const MIN = 60_000;
const CONFIG: IdleNudgeConfig = { firstMs: 10 * MIN, max: 3 };

let dir: string;
let db: Db;
let clock: number;
let transcript: string;

function run() {
  return getRun(db, "r1")!;
}

function update(sql: string, ...params: (string | number | null)[]): void {
  tx(db, () => db.query(sql).run(...params));
}

function event(kind: string, payload: Record<string, unknown> = {}): void {
  tx(db, () => appendEvent(db, { source: "cli", kind, runId: "r1", taskId: "t1", payload, ts: clock }));
}

/** One reconciler look at `clock`, with these git facts. */
function look(facts: GitFacts = NO_GIT_FACTS, restartBusy = false) {
  return tx(db, () => runIdleNudge(db, run(), { facts, config: CONFIG, timing: DEFAULT_TIMING, restartBusy }, clock));
}

function nudges(): { n: number; steer: string; outstanding: string[] }[] {
  return (db.query("SELECT payload FROM events WHERE kind = ?1 ORDER BY seq").all(NUDGE_KIND) as { payload: string }[]).map((e) => JSON.parse(e.payload));
}

function count(kind: string): number {
  return (db.query("SELECT COUNT(*) AS n FROM events WHERE kind = ?1").get(kind) as { n: number }).n;
}

function stalledItems(): { line: string; state: string }[] {
  return db.query("SELECT line, state FROM items WHERE kind = 'worker_stalled'").all() as { line: string; state: string }[];
}

/** The worker stopped at `clock`. */
function stopped(): void {
  update("UPDATE runs SET liveness = 'idle', idle_since = ?2, busy_until = NULL WHERE id = ?1", "r1", clock);
}

/** The nudge steer was carried to the worker and reached a model request (the woken turn). */
function carriedAndSeen(id: string): void {
  tx(db, () => {
    markRung(db, getMessage(db, id)!, run(), "waiter", clock, true, DEFAULT_TIMING);
    markSeen(db, run(), null, "post-tool", clock);
  });
}

const UNPUSHED = (n: number, head = "h1"): GitFacts => ({ ...NO_GIT_FACTS, head, remote: "r0", unpushed: n });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-nudge-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  clock = 10_000_000;
  transcript = join(dir, "session.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: "the task" } }) + "\n");
  tx(db, () => {
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('p', '', '/p', 'main', 'direct-PR')").run();
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES ('t1', 'p', 'ship', 'direct-PR', 0, 'fix', 0)").run();
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, stage_state, stage_started_at, worktree_path, branch, base_sha, token_hash, started_at, updated_at, pane_id, worker_started_at, transcript_path)
       VALUES ('r1', 't1', 'claude', 'v', 'running', 'busy', 'fix', 'build', 'active', ?1, '/w', 'b', 's', 'h', ?1, ?1, 'w1:p1', ?1, ?2)`,
    ).run(clock, transcript);
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("outstanding work", () => {
  test("unpushed commits plus idle: a nudge after the window naming them; once pushed and the stage done, no more", () => {
    stopped();
    clock += 10 * MIN - 1;
    expect(look(UNPUSHED(2)).steer).toBeNull();
    clock += 1;
    const first = look(UNPUSHED(2));
    expect(first.steer?.body).toBe("Flowryn: you are idle with work left: 2 commits not pushed (push, then deliver); stage build not done. Continue now; end with an outcome.");
    expect(nudges()).toMatchObject([{ n: 1, outstanding: ["unpushed:2", "stage:build"] }]);
    // The nudge woke it: it pushed (a new remote ref), finished its stage, and stopped again.
    carriedAndSeen(first.steer!.id);
    clock += MIN;
    event("stage.done", { stage: "build" });
    stopped();
    clock += 60 * MIN;
    expect(look({ ...NO_GIT_FACTS, head: "h1", remote: "h1", unpushed: 0 }).skipped).toBe("no outstanding work");
    expect(nudges()).toHaveLength(1);
  });

  test("an unacked steer it saw: a nudge naming it; the nudge itself is never outstanding", () => {
    const leaderSteer = tx(db, () => createSteer(db, run(), "write the docs", clock));
    carriedAndSeen(leaderSteer.id);
    update("UPDATE messages SET rings = ?2 WHERE id = ?1", leaderSteer.id, DEFAULT_TIMING.max_rings);
    stopped();
    clock += 10 * MIN;
    const nudge = look();
    expect(nudge.steer?.body).toContain(`unacked steer ${leaderSteer.id} (read it again: $FLOWRYN_BIN inbox)`);
    expect(nudges()[0]!.outstanding).toEqual([`steer:${leaderSteer.id}`, "stage:build"]);
    carriedAndSeen(nudge.steer!.id);
    update("UPDATE messages SET rings = ?2 WHERE id = ?1", nudge.steer!.id, DEFAULT_TIMING.max_rings);
    clock += 20 * MIN;
    expect(nudges().at(-1)!.outstanding).not.toContain(`steer:${nudge.steer!.id}`);
    expect(look().steer?.body).not.toContain(nudge.steer!.id);
  });

  test("a failed verification of the delivered head nobody answered is outstanding; a later steer about it is not", () => {
    tx(db, () => {
      db.query("INSERT INTO artifacts (id, task_id, kind, ref, head_sha, created_at) VALUES ('a1', 't1', 'pr', 'https://github.com/a/w/pull/1', 'hd', ?1)").run(clock);
      db.query(
        "INSERT INTO verifications (id, project_id, pr_url, task_id, head_sha, state, steps, dir, worktree_path, project_path, started_at, finished_at) VALUES ('v7', 'p', 'https://github.com/a/w/pull/1', 't1', 'hd', 'failed', '[]', '/d', '/d/wt', '/w', ?1, ?1)",
      ).run(clock);
    });
    update("UPDATE runs SET stage_state = 'active', stage_started_at = ?2 WHERE id = ?1", "r1", clock);
    event("stage.done", { stage: "build" });
    stopped();
    clock += 10 * MIN;
    expect(look({ ...NO_GIT_FACTS, head: "hd", undelivered: 0 }).steer?.body).toBe(
      "Flowryn: you are idle with work left: verification v7 of your delivered head failed (fix it, then deliver again). Continue now; end with an outcome.",
    );
  });

  test("commits past the delivered head: deliver again", () => {
    expect(nudgeText([{ kind: "undelivered", commits: 1 }])).toBe("Flowryn: you are idle with work left: 1 commit past your delivered head (deliver again). Continue now; end with an outcome.");
  });

  test("a git read that failed counts as unknown, never outstanding, and is recorded once per episode", () => {
    event("stage.done", { stage: "build" });
    stopped();
    clock += 10 * MIN;
    const unknown: GitFacts = { ...NO_GIT_FACTS, unknown: "git rev-parse HEAD: exit 124" };
    expect(look(unknown).skipped).toBe("no outstanding work");
    clock += MIN;
    look(unknown);
    expect(count(UNKNOWN_KIND)).toBe(1);
    expect(count(NUDGE_KIND)).toBe(0);
  });
});

describe("timing and the stall", () => {
  test("three nudges at 10, 20 and 40 minutes with no progress, then one worker_stalled P1 a window later", () => {
    stopped();
    const at: number[] = [];
    const start = clock;
    for (let minute = 1; minute <= 200; minute++) {
      clock = start + minute * MIN;
      if (look(UNPUSHED(1)).steer) at.push(minute);
    }
    // Each window runs from the previous nudge: 10, then 20 after it, then 40 after that.
    expect(at).toEqual([10, 30, 70]);
    expect(nudges().map((n) => n.n)).toEqual([1, 2, 3]);
    expect(count(STALLED_KIND)).toBe(1);
    const stalled = stalledItems();
    expect(stalled).toHaveLength(1);
    expect(stalled[0]!.line).toMatch(/idle with work left after 3 nudges \(m\d+, m\d+, m\d+\): 1 commit not pushed/);
    const payload = JSON.parse((db.query("SELECT payload FROM events WHERE kind = ?1").get(STALLED_KIND) as { payload: string }).payload);
    expect(payload).toMatchObject({ outstanding: ["unpushed:1", "stage:build"], idle_ms: 150 * MIN });
    // The stall came 80 minutes after the third nudge.
    const ts = (db.query("SELECT ts FROM events WHERE kind = ?1").get(STALLED_KIND) as { ts: number }).ts;
    expect(ts).toBe(start + 150 * MIN);
  });

  test("progress (an outcome, a new HEAD, a leader steer's ack) resets the count; a nudge's own ack does not", () => {
    stopped();
    clock += 10 * MIN;
    const n1 = look(UNPUSHED(1)).steer!;
    tx(db, () => ackSteer(db, run(), getMessage(db, n1.id)!, clock));
    clock += 20 * MIN;
    expect(look(UNPUSHED(1)).steer).not.toBeNull();
    expect(nudges().map((n) => n.n)).toEqual([1, 2]);
    // A new commit: HEAD moved since the last nudge, so the next one counts from 1 again.
    clock += 10 * MIN;
    expect(look(UNPUSHED(2, "h2")).steer).not.toBeNull();
    expect(nudges().at(-1)!.n).toBe(1);
    clock += 1;
    event("worker.report", { status: "finding" });
    clock += 10 * MIN;
    expect(look(UNPUSHED(2, "h2")).steer).not.toBeNull();
    expect(nudges().at(-1)!.n).toBe(1);
  });

  test("a background job ending starts the idle window", () => {
    const start = backgroundStartOf({
      tool_name: "Bash",
      tool_use_id: "toolu_bg",
      tool_input: { command: "bun test", run_in_background: true },
      tool_response: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "bjob" },
    })!;
    tx(db, () => recordBackgroundStart(db, run(), start, transcript, clock));
    stopped();
    clock += 30 * MIN;
    expect(look(UNPUSHED(1)).skipped).toBe("its own background job");
    appendFileSync(
      transcript,
      JSON.stringify({ type: "user", message: { role: "user", content: "<task-notification>\n<task-id>bjob</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n</task-notification>" } }) + "\n",
    );
    // This look records the end, then judges the window from it: not due yet.
    expect(look(UNPUSHED(1)).steer).toBeNull();
    clock += 10 * MIN - 1;
    expect(look(UNPUSHED(1)).steer).toBeNull();
    clock += 1;
    expect(look(UNPUSHED(1)).steer).not.toBeNull();
  });
});

describe("never a nudge while the worker rightly waits", () => {
  const waits: [string, () => void][] = [
    ["a review gate", () => update("UPDATE runs SET stage_state = 'review' WHERE id = 'r1'")],
    ["a capacity wait", () => update("UPDATE runs SET stage_state = 'waiting' WHERE id = 'r1'")],
    ["a pending launch", () => update("UPDATE runs SET pending_launch = 'stage' WHERE id = 'r1'")],
    ["an open question", () => update("INSERT INTO decisions (id, task_id, run_id, question, options, blocking, state) VALUES ('q1', 't1', 'r1', '?', '[]', 0, 'open')")],
    ["a reserved question", () => update("INSERT INTO decisions (id, task_id, run_id, question, options, blocking, state, reserved_class) VALUES ('q2', 't1', 'r1', '?', '[]', 1, 'open', 'merge')")],
    ["a blocked dialog", () => tx(db, () => openBlockedPrompt(db, run(), { suspected: false, screen: "Proceed?", harness: "claude", lastHook: clock }, clock))],
    ["an end-turn steer", () => tx(db, () => {
      const m = createSteer(db, run(), "end your turn", clock, null, false, true);
      markRung(db, m, run(), "waiter", clock, true, DEFAULT_TIMING);
      markSeen(db, run(), null, "post-tool", clock);
      ackSteer(db, run(), getMessage(db, m.id)!, clock);
    })],
  ];
  for (const [name, wait] of waits) {
    test(name, () => {
      stopped();
      wait();
      clock += 200 * MIN;
      expect(look(UNPUSHED(3)).steer).toBeNull();
      expect(count(NUDGE_KIND)).toBe(0);
      expect(stalledItems()).toHaveLength(0);
    });
  }

  test("a restart handoff", () => {
    stopped();
    clock += 200 * MIN;
    expect(look(UNPUSHED(3), true).skipped).toBe("restart handoff");
    expect(count(NUDGE_KIND)).toBe(0);
  });

  test("a steer ring in flight: the ring machinery owns it", () => {
    stopped();
    tx(db, () => {
      const m = createSteer(db, run(), "next", clock);
      markRung(db, m, run(), "waiter", clock, true, DEFAULT_TIMING);
    });
    clock += 200 * MIN;
    expect(look(UNPUSHED(3)).skipped).toBe("a steer ring in flight");
  });

  test("a busy or finished worker", () => {
    clock += 200 * MIN;
    expect(look(UNPUSHED(3)).skipped).toBe("not stopped");
    stopped();
    update("UPDATE runs SET state = 'ready' WHERE id = 'r1'");
    expect(look(UNPUSHED(3)).skipped).toBe("not stopped");
  });

  test("a nudge is a plain steer: no decision, never urgent, never end-turn", () => {
    stopped();
    clock += 10 * MIN;
    const steer = look(UNPUSHED(1)).steer!;
    expect(steer).toMatchObject({ decision_id: null, urgent: 0, end_turn: 0 });
  });
});

describe("the git facts", () => {
  async function repo(): Promise<{ cwd: string; git: GitRunner }> {
    const cwd = join(dir, "repo");
    const git = gitRunner("git", 10_000, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
    Bun.spawnSync(["git", "init", "-q", "-b", "b", cwd]);
    for (const args of [["commit", "-q", "--allow-empty", "-m", "one"], ["update-ref", "refs/remotes/origin/b", "HEAD"], ["commit", "-q", "--allow-empty", "-m", "two"], ["commit", "-q", "--allow-empty", "-m", "three"]]) {
      expect((await git(args, cwd)).code).toBe(0);
    }
    update("UPDATE runs SET worktree_path = ?2 WHERE id = ?1", "r1", cwd);
    return { cwd, git };
  }

  test("assumption: HEAD against refs/remotes/origin/<branch> and the delivered head, from local refs only", async () => {
    const { cwd, git } = await repo();
    const delivered = (await git(["rev-parse", "HEAD~1"], cwd)).stdout.trim();
    const facts = await readGitFacts(git, run(), delivered);
    expect(facts).toMatchObject({ unpushed: 2, undelivered: 1, unknown: null });
    expect(facts.head).toMatch(/^[0-9a-f]{40}$/);
  });

  test("assumption: a branch never pushed is not outstanding (no remote ref), and a HEAD behind its remote is not unpushed", async () => {
    const { cwd, git } = await repo();
    await git(["update-ref", "-d", "refs/remotes/origin/b"], cwd);
    expect(await readGitFacts(git, run(), null)).toMatchObject({ remote: null, unpushed: null, unknown: null });
    await git(["update-ref", "refs/remotes/origin/b", "HEAD"], cwd);
    await git(["reset", "-q", "--soft", "HEAD~1"], cwd);
    expect(await readGitFacts(git, run(), null)).toMatchObject({ unpushed: 0, unknown: null });
  });

  test("assumption: a timed-out or failed read is unknown (124/125 from runBounded), never outstanding", async () => {
    const timedOut: GitRunner = async () => ({ code: 124, stdout: "", stderr: "timed out" });
    expect(await readGitFacts(timedOut, run(), null)).toMatchObject({ unpushed: null, unknown: "git rev-parse HEAD: exit 124: timed out" });
    let calls = 0;
    const partial: GitRunner = async () => (++calls === 1 ? { code: 0, stdout: "abc\n", stderr: "" } : { code: 125, stdout: "", stderr: "" });
    expect((await readGitFacts(partial, run(), null)).unknown).toContain("exit 125");
  });
});

describe("[workers] idle_nudge_min and idle_nudge_max", () => {
  const config = (workers: Record<string, unknown>) => ({ extra: { workers }, home: dir, data_dir: dir }) as unknown as FlowrynConfig;

  test("default 10 minutes and 3 nudges; a fraction of a minute is allowed, a zero or fractional count is not", () => {
    expect(DEFAULT_IDLE_NUDGE_MIN).toBe(10);
    expect(DEFAULT_IDLE_NUDGE_MAX).toBe(3);
    expect(workersConfig(config({}))).toMatchObject({ idle_nudge_min: 10, idle_nudge_max: 3 });
    expect(workersConfig(config({ idle_nudge_min: 0.5, idle_nudge_max: 5 }))).toMatchObject({ idle_nudge_min: 0.5, idle_nudge_max: 5 });
    expect(() => workersConfig(config({ idle_nudge_min: 0 }))).toThrow("[workers] idle_nudge_min must be a positive number");
    expect(() => workersConfig(config({ idle_nudge_max: 1.5 }))).toThrow("[workers] idle_nudge_max must be a positive integer");
  });
});

describe("the long-command wording", () => {
  test("the build and visual QA skills carry it; the worker contract's outcome rule says never with work left", async () => {
    const { LONG_COMMAND_RULE, STAGE_SKILLS } = await import("../../src/skills/stages.ts");
    const { workerContract } = await import("../../src/harness/contract-text.ts");
    for (const name of ["flowryn-build-test", "flowryn-visual-qa"]) expect(STAGE_SKILLS.find((s) => s.name === name)!.body).toContain(LONG_COMMAND_RULE);
    expect(LONG_COMMAND_RULE).toContain("run_in_background");
    expect(LONG_COMMAND_RULE).toContain("axi run --wait` stays in the foreground");
    for (const harness of ["claude", "pi"] as const) expect(workerContract(harness, null, { defaultBranch: "main" })).toContain("or as a steer says; never with work left.");
  });
});
