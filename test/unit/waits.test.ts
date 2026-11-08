import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explain } from "../../src/attention/explanations.ts";
import { LEADER_WAKE_SQL } from "../../src/attention/items.ts";
import { parseConfig, type FlowrynConfig } from "../../src/config/config.ts";
import { effectiveConfig } from "../../src/config/effective.ts";
import { DEFAULT_HOST } from "../../src/config/workflows.ts";
import { migrate, openDb, setMeta, tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import type { BacklogTask } from "../../src/journal/tasks-axi.ts";
import { writeSnapshot } from "../../src/journal/snapshot.ts";
import { checkWaits, collectWaits, deadlineLabel, RECOVERY_GRACE_MS, WAIT_DEADLINES_MS, waitDeadlines, type WaitPassDeps } from "../../src/reconcile/waits.ts";
import { contractRevision } from "../../src/contracts/revision.ts";
import { AUTO_BUILD_KEY, saveAutoAttempt } from "../../src/lifecycle/harness-gate.ts";
import { hostRefusal } from "../../src/sched/wait-reasons.ts";
import { verifyPolicyId } from "../../src/verify/policy.ts";
import { clearWaiting, getRequest, insertRequest, markStarted, markWaiting } from "../../src/verify/queue.ts";
import { initialSteps } from "../../src/verify/runner.ts";
import { finishVerification, insertVerification } from "../../src/verify/store.ts";

/**
 * The wait registry (docs/notes/2026-11-06-no-silent-waits-vj.md): every wait
 * gets a deadline from one table; past it, recovery first (a kick), then one
 * wait_expired item naming the wait, its age, the cause and the fix, which
 * wakes the leader; an ended wait resolves its item.
 */

const MIN = 60_000;
const dirs: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fl-waits-"));
  dirs.push(dir);
  return dir;
}

function config(text = ""): FlowrynConfig {
  return parseConfig(text, tempDir());
}

function database(): Db {
  const db = openDb(join(tempDir(), "flowryn.db"));
  dbs.push(db);
  migrate(db);
  tx(db, () => db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode, yolo) VALUES ('web', 'https://github.com/acme/web', '/p', 'main', 'direct-PR', 1)").run());
  return db;
}

function seedRun(db: Db, run: { id: string; task: string; state?: string; stageState?: string; waitingSince?: number | null; pending?: string | null; auto?: number }): void {
  tx(db, () => {
    db.query("INSERT OR IGNORE INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, sensitive, workflow, auto, created_at) VALUES (?1, 'web', 'ship', 'direct-PR', 1, 0, 'fix', ?2, 0)").run(run.task, run.auto ?? 0);
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, stage_state, worktree_path, branch, base_sha, token_hash, started_at, updated_at, waiting_since, pending_launch)
       VALUES (?1, ?2, 'claude', '2.1.281', ?3, 'idle', 'fix', 'build', ?4, '/tmp/wt', 'flowryn/x', 'abc', 'x', 0, 0, ?5, ?6)`,
    ).run(run.id, run.task, run.state ?? "running", run.stageState ?? "waiting", run.waitingSince ?? null, run.pending ?? null);
  });
}

function pass(db: Db, cfg: FlowrynConfig, now: number, noCi = false): { result: ReturnType<typeof checkWaits>; kicks: string[] } {
  const kicks: string[] = [];
  const deps: WaitPassDeps = { db, config: () => cfg, now: () => now, kickScheduler: () => kicks.push("scheduler"), kickAutoMerger: () => kicks.push("auto_merger"), noCi: () => noCi };
  return { result: checkWaits(deps), kicks };
}

/** Open wait_expired items: `line` the whole text, `digest` what a briefing shows. */
function openWaitItems(db: Db): { id: string; line: string; digest: string; task_id: string | null; run_id: string | null }[] {
  return db
    .query("SELECT id, COALESCE(full_line, line) AS line, line AS digest, task_id, run_id FROM items WHERE kind = 'wait_expired' AND state IN ('open','presented') ORDER BY id")
    .all() as { id: string; line: string; digest: string; task_id: string | null; run_id: string | null }[];
}

function events(db: Db, kind: string): Record<string, unknown>[] {
  return (db.query("SELECT payload FROM events WHERE kind = ?1 ORDER BY seq").all(kind) as { payload: string }[]).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
}

/** A run whose stage waits on the host check, as the scheduler records it: the explanation, and the host state with its sample. */
function hostHeld(db: Db, since: number): void {
  seedRun(db, { id: "r1", task: "t1", waitingSince: since });
  tx(db, () => {
    setMeta(db, "sched_host", JSON.stringify({ ok: false, reason: "free memory 7.8 GB < 8 GB", since, free_mem_gb: 7.8, load_per_core: 0.4 }));
    const why = hostRefusal({ ok: false, reason: "free memory 7.8 GB < 8 GB", since, free_mem_gb: 7.8, load_per_core: 0.4 }, DEFAULT_HOST, "free memory 7.8 GB < 8 GB", since);
    explain(db, { run: { id: "r1", task_id: "t1", stage: "build" }, kind: "capacity", ...why, source: "daemon", now: since });
  });
}

describe("[waits] deadlines", () => {
  test("default to the table, take whole minutes, and refuse a bad value at load", () => {
    expect(waitDeadlines(config())).toEqual({ ...WAIT_DEADLINES_MS });
    expect(WAIT_DEADLINES_MS).toMatchObject({ verify_queue: 20 * MIN, capacity: 10 * MIN, host: 10 * MIN, phase_start: 10 * MIN, auto_merge: 30 * MIN });
    expect(waitDeadlines(config("[waits]\nhost_min = 5\n")).host).toBe(5 * MIN);
    for (const bad of ["host_min = 0", "host_min = 1.5", 'host_min = "5"', "host_min = 100000", "hostt_min = 5"]) {
      expect(() => waitDeadlines(config(`[waits]\n${bad}\n`))).toThrow("[waits]");
      expect(effectiveConfig(config(`[waits]\n${bad}\n`)).problems.join("\n")).toContain("[waits]");
    }
    expect(effectiveConfig(config("[waits]\nhost_min = 5\n")).sections.waits).toMatchObject({ host_min: 5, verify_queue_min: 20 });
  });
});

describe("a host-held launch", () => {
  test("is recovered (the scheduler kicked) at 10 min, not 30, then itemized a pass later with the measured value, the floor and the key", () => {
    const db = database();
    const cfg = config();
    hostHeld(db, 1_000);
    expect(pass(db, cfg, 1_000 + 9 * MIN).kicks).toEqual([]);
    const first = pass(db, cfg, 1_000 + 10 * MIN);
    expect(first.kicks).toEqual(["scheduler"]);
    expect(first.result.recovered).toEqual(["run:r1"]);
    expect(openWaitItems(db)).toEqual([]);
    expect(events(db, "wait.recovered")[0]).toMatchObject({ key: "run:r1", kind: "host", waited_ms: 10 * MIN, deadline_ms: 10 * MIN });
    // The same pass's recovery gets its grace before the item.
    expect(pass(db, cfg, 1_000 + 10 * MIN + RECOVERY_GRACE_MS - 1).result.itemized).toEqual([]);
    const second = pass(db, cfg, 1_000 + 10 * MIN + RECOVERY_GRACE_MS);
    expect(second.result.itemized).toEqual(["run:r1"]);
    expect(second.kicks).toEqual([]);
    const [item] = openWaitItems(db);
    expect(item!.line).toContain("7.8 GB free memory, under the 8 GB floor ([capacity.host] min_free_mem_gb)");
    expect(item!.line).toContain("Waiting 11m, past its 10m deadline");
    expect(item!.line).toContain("[capacity.host] min_free_mem_gb in config.toml");
    // The daemon reads config.toml only on SIGHUP, so the fix says how to reload it.
    expect(item!.line).toContain("then reload it (SIGHUP to the daemon, or flowryn daemon restart)");
    // The digest keeps the fix: it comes before the cause.
    expect(item!.digest).toContain("free the host, or change [capacity.host] min_free_mem_gb");
    expect(item).toMatchObject({ task_id: "t1", run_id: "r1" });
    // It wakes the leader.
    expect(db.query(`SELECT i.kind FROM items i WHERE i.id = ?1 AND ${LEADER_WAKE_SQL}`).all(item!.id)).toEqual([{ kind: "wait_expired" }]);
    // Once only: later passes add nothing.
    pass(db, cfg, 1_000 + 30 * MIN);
    expect(openWaitItems(db)).toHaveLength(1);
    expect(events(db, "wait.expired")).toHaveLength(1);
  });

  test("a wait that ends resolves its item with a wait.cleared event; a new episode starts over", () => {
    const db = database();
    const cfg = config();
    hostHeld(db, 1_000);
    pass(db, cfg, 1_000 + 10 * MIN);
    pass(db, cfg, 1_000 + 11 * MIN);
    const [item] = openWaitItems(db);
    tx(db, () => db.query("UPDATE runs SET stage_state = 'active', waiting_since = NULL WHERE id = 'r1'").run());
    expect(pass(db, cfg, 1_000 + 12 * MIN).result.cleared).toEqual(["run:r1"]);
    expect(db.query("SELECT state, resolved_by FROM items WHERE id = ?1").get(item!.id)).toEqual({ state: "resolved", resolved_by: "wait ended" });
    expect(events(db, "wait.cleared")[0]).toMatchObject({ key: "run:r1", item: item!.id });
    expect(db.query("SELECT COUNT(*) AS n FROM waits").get()).toEqual({ n: 0 });
    // Waiting again later: a fresh deadline from the new waiting_since.
    tx(db, () => db.query("UPDATE runs SET stage_state = 'waiting', waiting_since = ?1 WHERE id = 'r1'").run(1_000 + 20 * MIN));
    expect(pass(db, cfg, 1_000 + 25 * MIN).kicks).toEqual([]);
    expect(pass(db, cfg, 1_000 + 30 * MIN).kicks).toEqual(["scheduler"]);
  });

  test("a usage-limit wait an open usage_limit item already carries is recovered but never itemized twice", () => {
    const db = database();
    const cfg = config();
    seedRun(db, { id: "r1", task: "t1", waitingSince: 1_000 });
    tx(db, () => {
      explain(db, { run: { id: "r1", task_id: "t1", stage: "build" }, kind: "capacity", rule: "capacity.usage_limit", reason: "the usage limit on account a pauses its starts", facts: [], unblock: [{ by: "captain", action: "flowryn resume --account a" }], source: "daemon", now: 1_000 });
      const event = appendEvent(db, { source: "daemon", kind: "sched.usage_limit", payload: {}, ts: 1_000 });
      db.query("INSERT INTO items (id, event_seq, class, lane, kind, line, opened_at) VALUES ('i99', ?1, 'actionable', 'P1', 'usage_limit', 'usage limit', 1000)").run(event.seq);
    });
    expect(pass(db, cfg, 1_000 + 10 * MIN).kicks).toEqual(["scheduler"]);
    expect(pass(db, cfg, 1_000 + 11 * MIN).result.itemized).toEqual(["run:r1"]);
    expect(openWaitItems(db)).toEqual([]);
    expect(events(db, "wait.expired")[0]).toMatchObject({ covered_by: "i99" });
    // Its end never resolves the item it did not open.
    tx(db, () => db.query("UPDATE runs SET stage_state = 'active', waiting_since = NULL WHERE id = 'r1'").run());
    pass(db, cfg, 1_000 + 12 * MIN);
    expect(db.query("SELECT state FROM items WHERE id = 'i99'").get()).toEqual({ state: "open" });
  });

  test("a covered wait whose covering item closes while it still waits is itemized on the next pass", () => {
    const db = database();
    const cfg = config();
    seedRun(db, { id: "r1", task: "t1", waitingSince: 1_000 });
    tx(db, () => {
      explain(db, { run: { id: "r1", task_id: "t1", stage: "build" }, kind: "capacity", rule: "capacity.usage_limit", reason: "the usage limit on account a pauses its starts", facts: [], unblock: [{ by: "captain", action: "flowryn resume --account a" }], source: "daemon", now: 1_000 });
      const event = appendEvent(db, { source: "daemon", kind: "sched.usage_limit", payload: {}, ts: 1_000 });
      db.query("INSERT INTO items (id, event_seq, class, lane, kind, line, opened_at) VALUES ('i99', ?1, 'actionable', 'P1', 'usage_limit', 'usage limit', 1000)").run(event.seq);
    });
    pass(db, cfg, 1_000 + 10 * MIN);
    pass(db, cfg, 1_000 + 11 * MIN);
    expect(pass(db, cfg, 1_000 + 12 * MIN).result.itemized).toEqual([]);
    tx(db, () => db.query("UPDATE items SET state = 'resolved', resolved_at = ?1 WHERE id = 'i99'").run(1_000 + 12 * MIN));
    expect(pass(db, cfg, 1_000 + 13 * MIN).result.itemized).toEqual(["run:r1"]);
    expect(openWaitItems(db).map((i) => i.run_id)).toEqual(["r1"]);
    expect(events(db, "wait.expired").map((e) => e.covered_by)).toEqual(["i99", null]);
    expect(pass(db, cfg, 1_000 + 14 * MIN).result.itemized).toEqual([]);
  });
});

describe("a launch held on an untested harness version", () => {
  /** A fresh dispatch the grant refuses on claude 2.1.319 (flagged, no pass), with the automatic check in `state` when given. */
  function harnessHeld(db: Db, attempt: "waiting" | "running" | "failed" | null): void {
    seedRun(db, { id: "r1", task: "t1", stageState: "idle", waitingSince: 1_000, pending: "fresh" });
    tx(db, () => {
      setMeta(db, AUTO_BUILD_KEY, "build-1");
      setMeta(db, "harness_flagged:claude", JSON.stringify({ version: "2.1.319", revision: contractRevision("claude") }));
      if (attempt) saveAutoAttempt(db, "claude", { version: "2.1.319", revision: contractRevision("claude"), state: attempt, try: 2 });
      explain(db, { run: { id: "r1", task_id: "t1", stage: "build" }, kind: "capacity", rule: "capacity.harness_unverified", reason: "claude 2.1.319 has no passing contract", facts: [], unblock: [], source: "daemon", now: 1_000 });
    });
  }

  for (const attempt of ["waiting", "running"] as const) {
    test(`stays quiet past its deadline while the automatic check is ${attempt} (relaxed)`, () => {
      const db = database();
      const cfg = config('[policy]\nmode = "relaxed"\n');
      harnessHeld(db, attempt);
      expect(pass(db, cfg, 1_000 + 20 * MIN).kicks).toEqual(["scheduler"]);
      expect(pass(db, cfg, 1_000 + 21 * MIN).result.itemized).toEqual(["run:r1"]);
      expect(openWaitItems(db)).toEqual([]);
      expect(events(db, "wait.expired")[0]).toMatchObject({ key: "run:r1", kind: "harness_check", covered_by: "auto_check:claude" });
      expect(pass(db, cfg, 1_000 + 40 * MIN).result.itemized).toEqual([]);
      expect(openWaitItems(db)).toEqual([]);
    });
  }

  test("is itemized once the automatic check has failed for good and no harness_unverified item carries it", () => {
    const db = database();
    const cfg = config('[policy]\nmode = "relaxed"\n');
    harnessHeld(db, "running");
    pass(db, cfg, 1_000 + 20 * MIN);
    pass(db, cfg, 1_000 + 21 * MIN);
    tx(db, () => saveAutoAttempt(db, "claude", { version: "2.1.319", revision: contractRevision("claude"), state: "failed", try: 2 }));
    expect(pass(db, cfg, 1_000 + 22 * MIN).result.itemized).toEqual(["run:r1"]);
    expect(openWaitItems(db).map((i) => i.run_id)).toEqual(["r1"]);
  });

  test("strict mode keeps the 20-minute item even with an attempt on record", () => {
    const db = database();
    const cfg = config('[policy]\nmode = "strict"\n');
    harnessHeld(db, "running");
    pass(db, cfg, 1_000 + 20 * MIN);
    expect(pass(db, cfg, 1_000 + 21 * MIN).result.itemized).toEqual(["run:r1"]);
    expect(openWaitItems(db).map((i) => i.run_id)).toEqual(["r1"]);
    expect(events(db, "wait.expired")[0]).toMatchObject({ covered_by: null });
  });
});

describe("a plan phase", () => {
  function plan(db: Db, landedAt: number): void {
    seedRun(db, { id: "r0", task: "t-a", state: "cleaned", stageState: "done" });
    tx(db, () => {
      db.query("INSERT INTO plans (id, project_id, title, state, filed_by, created_at, approved_at) VALUES ('pl1', 'web', 'Big plan', 'approved', 'leader', 0, 0)").run();
      db.query("INSERT INTO plan_phases (plan_id, phase_no, task_id, title, body, workflow, blocked_by) VALUES ('pl1', 1, 't-a', 'A', 'b', 'fix', '[]'), ('pl1', 2, 't-b', 'B', 'b', 'fix', '[\"t-a\"]')").run();
      db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, sensitive, workflow, auto, created_at) VALUES ('t-b', 'web', 'ship', 'direct-PR', 1, 0, 'fix', 1, 0)").run();
      appendEvent(db, { source: "daemon", kind: "run.landed", runId: "r0", taskId: "t-a", payload: {}, ts: landedAt });
      const task = (id: string, state: BacklogTask["state"], deps: string[] = []): BacklogTask => ({ id, title: id, state, kind: "ship", repo: "web", priority: null, body: "", created: null, closed: null, deps, hold: null, links: [] });
      writeSnapshot(db, "backlog", "h", [task("t-a", "done"), task("t-b", "queued", ["blocked-by:t-a"])], landedAt);
    });
  }

  test("assumption: a phase with no run 10 min after its blocker landed is re-kicked, then itemized with why and the dispatch that starts it", () => {
    const db = database();
    const cfg = config();
    plan(db, 5_000);
    const [wait] = collectWaits(db, cfg, 5_000);
    expect(wait).toMatchObject({ key: "phase:t-b", kind: "phase_start", since: 5_000, due: 5_000 + 10 * MIN, fix: "flowryn dispatch web --task t-b" });
    expect(pass(db, cfg, 5_000 + 10 * MIN).kicks).toEqual(["scheduler"]);
    pass(db, cfg, 5_000 + 11 * MIN);
    const [item] = openWaitItems(db);
    expect(item!.line).toContain('phase 2 of "Big plan" (t-b)');
    expect(item!.line).toContain("the scheduler has not started it");
    expect(item!.digest).toContain("; flowryn dispatch web --task t-b; why:");
  });

  test("a held phase is not a wait on the scheduler; a phase_blocked item's reason is the cause; its run starting ends the wait", () => {
    const db = database();
    const cfg = config();
    plan(db, 5_000);
    tx(db, () => {
      const event = appendEvent(db, { source: "daemon", kind: "phase.blocked", taskId: "t-b", payload: {}, ts: 6_000 });
      db.query("INSERT INTO items (id, event_seq, class, lane, kind, task_id, line, opened_at) VALUES ('i7', ?1, 'actionable', 'P1', 'phase_blocked', 't-b', 'Phase 2 of \"Big plan\" is ready but cannot start: no contract', 6000)").run(event.seq);
    });
    expect(collectWaits(db, cfg, 6_000)[0]!.cause).toContain("cannot start: no contract");
    pass(db, cfg, 5_000 + 10 * MIN);
    pass(db, cfg, 5_000 + 11 * MIN);
    expect(openWaitItems(db)).toHaveLength(1);
    // Its run starts and waits on the host: the phase wait ends, the run's wait says it is the phase.
    seedRun(db, { id: "r2", task: "t-b", waitingSince: 5_000 + 11 * MIN });
    expect(pass(db, cfg, 5_000 + 12 * MIN).result.cleared).toEqual(["phase:t-b"]);
    expect(openWaitItems(db)).toEqual([]);
    expect(collectWaits(db, cfg, 5_000 + 12 * MIN)[0]).toMatchObject({ key: "run:r2", what: 'phase 2 of "Big plan" (t-b), stage build' });
  });
});

describe("the verify queue", () => {
  const POLICY = verifyPolicyId({ steps: ["true"], binary: null });

  function request(db: Db, now: number): string {
    return tx(db, () => insertRequest(db, { project_id: "web", pr_url: "https://github.com/acme/web/pull/7", task_id: "t1", head_sha: "a".repeat(40), policy_id: POLICY, pr_number: 7, head_ref: "flowryn/t1", worktree: null, source: "auto", path: null, now })).id;
  }

  test("its first request is due 20 min after its expected start; a verify running ahead moves that start to its usual end", () => {
    const db = database();
    const cfg = config(`[projects.web]\nverify = ["true"]\n`);
    // A clean pass of 15 min is this project's usual verify.
    const old = tx(db, () => insertVerification(db, { project_id: "web", pr_url: "x", task_id: "t0", head_sha: "b".repeat(40), steps: initialSteps(["true"]), policy_id: POLICY, dir: () => "/d", worktree: () => "/w", project_path: "/p", source: "daemon", now: 0 }));
    tx(db, () => finishVerification(db, old, { state: "passed", steps: old.steps, tests: null, detail: null, binary: null }, 15 * MIN));
    const running = tx(db, () => insertVerification(db, { project_id: "web", pr_url: "y", task_id: "t9", head_sha: "c".repeat(40), steps: initialSteps(["true"]), policy_id: POLICY, dir: () => "/d", worktree: () => "/w", project_path: "/p", source: "daemon", now: 20 * MIN }));
    const id = request(db, 21 * MIN);
    const [wait] = collectWaits(db, cfg, 21 * MIN);
    expect(wait).toMatchObject({ key: `verify:${id}`, kind: "verify_queue", since: 21 * MIN, due: 20 * MIN + 15 * MIN + 20 * MIN, fix: `flowryn verify show ${id}` });
    expect(running.state).toBe("running");
    expect(pass(db, cfg, 54 * MIN).kicks).toEqual([]);
    expect(pass(db, cfg, 55 * MIN).kicks).toEqual(["scheduler"]);
    pass(db, cfg, 56 * MIN);
    expect(openWaitItems(db)[0]!.line).toContain(`verify ${id} of t1`);
    // It starts: the wait ends.
    tx(db, () => markStarted(db, db.query("SELECT * FROM verify_queue WHERE id = ?1").get(id) as never, running.id, 57 * MIN));
    expect(pass(db, cfg, 57 * MIN).result.cleared).toEqual([`verify:${id}`]);
  });

  test("requests that go past a waiting first request never move its deadline, so its item stays open", () => {
    const db = database();
    const cfg = config(`[projects.web]\nverify = ["true"]\n`);
    const first = request(db, 0);
    function startBehind(at: number, pr: number): void {
      const behind = tx(db, () => insertRequest(db, { project_id: "web", pr_url: `https://github.com/acme/web/pull/${pr}`, task_id: `t${pr}`, head_sha: "d".repeat(40), policy_id: POLICY, pr_number: pr, head_ref: `flowryn/t${pr}`, worktree: null, source: "auto", path: null, now: at - MIN }));
      const v = tx(db, () => insertVerification(db, { project_id: "web", pr_url: behind.pr_url, task_id: behind.task_id, head_sha: behind.head_sha, steps: initialSteps(["true"]), policy_id: POLICY, dir: () => "/d", worktree: () => "/w", project_path: "/p", source: "daemon", now: at }));
      tx(db, () => markStarted(db, behind, v.id, at));
    }
    startBehind(5 * MIN, 8);
    expect(collectWaits(db, cfg, 5 * MIN)[0]).toMatchObject({ key: `verify:${first}`, due: 20 * MIN });
    expect(pass(db, cfg, 20 * MIN).kicks).toEqual(["scheduler"]);
    pass(db, cfg, 21 * MIN);
    expect(openWaitItems(db)).toHaveLength(1);
    startBehind(25 * MIN, 9);
    expect(pass(db, cfg, 26 * MIN).result.cleared).toEqual([]);
    expect(openWaitItems(db)[0]!.line).toContain(`verify ${first} of t1`);
  });

  test("two requests waiting on their own PR for different causes get two waits and two deadlines, each clock from when that request began waiting", () => {
    const db = database();
    // Project app's config is invalid (its R1 waits from 2 min); web's R2 got a 403 on its PR read (it waits from 7 min); R3 is next in line.
    const cfg = config(`[projects.web]\nverify = ["true"]\n[projects.app]\nverify = "true"\n`);
    const r1 = tx(db, () => insertRequest(db, { project_id: "app", pr_url: "https://github.com/acme/app/pull/3", task_id: "t3", head_sha: "a".repeat(40), policy_id: POLICY, pr_number: 3, head_ref: "flowryn/t3", worktree: null, source: "auto", path: null, now: 0 }));
    const r2 = tx(db, () => insertRequest(db, { project_id: "web", pr_url: "https://github.com/acme/web/pull/4", task_id: "t4", head_sha: "b".repeat(40), policy_id: POLICY, pr_number: 4, head_ref: "flowryn/t4", worktree: null, source: "auto", path: null, now: MIN }));
    const r3 = request(db, 2 * MIN);
    tx(db, () => markWaiting(db, r1, { reason: "config_invalid", ref: null }, 2 * MIN));
    tx(db, () => markWaiting(db, r2, { reason: "pr_unreadable", ref: "refused 403" }, 7 * MIN));
    const waits = collectWaits(db, cfg, 8 * MIN);
    expect(waits.map((w) => [w.key, w.since, w.due])).toEqual([
      [`verify:${r1.id}`, 2 * MIN, 22 * MIN],
      [`verify:${r3}`, 2 * MIN, 22 * MIN],
      [`verify:${r2.id}`, 7 * MIN, 27 * MIN],
    ]);
    const [w1, w3, w2] = waits;
    expect(w1!.cause).toStartWith("waits on its own PR, so the requests behind it go first: the [projects.app] config is invalid: ");
    expect(w1!.fix).toBe(`flowryn config; flowryn verify show ${r1.id}`);
    expect(w2!.cause).toBe("waits on its own PR, so the requests behind it go first: cannot read https://github.com/acme/web/pull/4 (refused 403)");
    expect(w2!.fix).toBe(`flowryn verify show ${r2.id}`);
    // The request next in line waits on the queue, not behind the requests that stepped aside.
    expect(w3!.cause).toBe("first in the verify queue behind requests waiting on their own PR and not started: starting");
    // Each is recovered and itemized on its own clock, naming its own cause.
    expect(pass(db, cfg, 22 * MIN).result.recovered).toEqual([`verify:${r1.id}`, `verify:${r3}`]);
    pass(db, cfg, 23 * MIN);
    expect(pass(db, cfg, 27 * MIN).result.recovered).toEqual([`verify:${r2.id}`]);
    pass(db, cfg, 28 * MIN);
    const items = openWaitItems(db);
    expect(items).toHaveLength(3);
    expect(items.find((i) => i.task_id === "t4")!.line).toContain("cannot read https://github.com/acme/web/pull/4 (refused 403)");
    expect(items.find((i) => i.task_id === "t3")!.line).toContain("the [projects.app] config is invalid");
    // R2 reads again and may start: its own wait ends, and it is first in line behind R1 from its request time.
    tx(db, () => clearWaiting(db, getRequest(db, r2.id)!, 29 * MIN));
    expect(pass(db, cfg, 29 * MIN).result.cleared).toContain(`verify:${r2.id}`);
    expect(collectWaits(db, cfg, 29 * MIN).find((w) => w.key === `verify:${r2.id}`)).toMatchObject({ since: MIN, cause: "first in the verify queue behind requests waiting on their own PR and not started: starting" });
  });

  test("a first request the drain holds names an invalid project config and its fix, or a GitHub outage", () => {
    const db = database();
    const id = request(db, 0);
    const invalid = collectWaits(db, config(`[projects.web]\nverify = "true"\n`), 21 * MIN)[0]!;
    expect(invalid.cause).toContain("the [projects.web] config is invalid");
    expect(invalid.fix).toBe(`flowryn config; flowryn verify show ${id}`);
    tx(db, () => setMeta(db, "forge_down_since", String(MIN)));
    const down = collectWaits(db, config(`[projects.web]\nverify = ["true"]\n`), 21 * MIN)[0]!;
    expect(down.cause).toBe("first in the verify queue and not started: GitHub has not answered for 20m, so its PR cannot be read");
    expect(down.fix).toBe(`flowryn verify show ${id}`);
  });
});

describe("an auto-merge", () => {
  function waitingChecks(db: Db, head: string, pending: string[]): void {
    seedRun(db, { id: "r1", task: "t1", state: "ready", stageState: "done" });
    tx(db, () => {
      db.query("INSERT INTO artifacts (id, task_id, kind, ref, head_sha, created_at) VALUES ('a1', 't1', 'pr', 'u', ?1, 0)").run("a".repeat(40));
      db.query("INSERT INTO auto_merges (id, run_id, task_id, project_id, ref, head_sha, state, created_at, state_since, updated_at) VALUES ('am4', 'r1', 't1', 'web', 'u', ?1, 'waiting_checks', 0, 1000, 1000)").run("a".repeat(40));
      db.query("INSERT INTO run_evidence (run_id, source, rank, value, observed_at) VALUES ('r1', 'github', 1, ?1, 1)").run(JSON.stringify({ head, checks: { state: pending.length ? "pending" : "green", pending } }));
    });
  }

  test("waiting on pending checks is due at the auto-merger's checks limit (6 h, 1 h under no_ci), then kicks it and is itemized with the checks pending", () => {
    const db = database();
    const cfg = config();
    waitingChecks(db, "a".repeat(40), ["ci/test"]);
    expect(pass(db, cfg, 1_000 + 31 * MIN).kicks).toEqual([]);
    expect(pass(db, cfg, 1_000 + 60 * MIN - 1, true).kicks).toEqual([]);
    expect(pass(db, cfg, 1_000 + 6 * 60 * MIN - 1).kicks).toEqual([]);
    expect(pass(db, cfg, 1_000 + 6 * 60 * MIN).kicks).toEqual(["auto_merger"]);
    pass(db, cfg, 1_000 + 6 * 60 * MIN + MIN);
    const [item] = openWaitItems(db);
    expect(item!.line).toContain("auto-merge am4 of t1");
    expect(item!.line).toContain("GitHub checks pending: ci/test");
    expect(item!.digest).toContain("flowryn merge t1");
  });

  test("under no_ci its pending checks are due at 1 h", () => {
    const db = database();
    waitingChecks(db, "a".repeat(40), ["ci/test"]);
    expect(pass(db, config(), 1_000 + 60 * MIN, true).kicks).toEqual(["auto_merger"]);
  });

  test("one whose PR head moved is due 30 min after the auto-merger first saw the move, not 30 min after it began waiting", () => {
    const db = database();
    const cfg = config();
    waitingChecks(db, "c".repeat(40), []);
    // Not seen yet: the table's deadline from its last change, so the recovery kicks the auto-merger, which records the sighting.
    expect(pass(db, cfg, 1_000 + 30 * MIN - 1).kicks).toEqual([]);
    expect(pass(db, cfg, 1_000 + 30 * MIN).kicks).toEqual(["auto_merger"]);
    tx(db, () => appendEvent(db, { source: "daemon", kind: "auto_merge.head_moved_seen", runId: "r1", taskId: "t1", payload: { auto_merge: "am4", head: "c".repeat(40) }, ts: 1_000 + 30 * MIN }));
    expect(pass(db, cfg, 1_000 + 30 * MIN + RECOVERY_GRACE_MS).result).toMatchObject({ itemized: [], cleared: ["auto_merge:am4"] });
    expect(pass(db, cfg, 1_000 + 60 * MIN - 1).kicks).toEqual([]);
    expect(pass(db, cfg, 1_000 + 60 * MIN).kicks).toEqual(["auto_merger"]);
    expect(openWaitItems(db)).toEqual([]);
  });

  test("one whose evidence still shows an earlier delivered head (GitHub catching up) is no move: the table's deadline, not the checks limit", () => {
    const db = database();
    waitingChecks(db, "0".repeat(40), ["ci/test"]);
    tx(db, () => db.query("INSERT INTO artifacts (id, task_id, kind, ref, head_sha, created_at) VALUES ('a0', 't1', 'pr', 'u', ?1, -1)").run("0".repeat(40)));
    expect(collectWaits(db, config(), 1_000 + 10 * MIN)[0]).toMatchObject({ key: "auto_merge:am4", due: 1_000 + 30 * MIN });
  });

  test("one following a queued or running verify is the verify's wait, not its own", () => {
    const db = database();
    const cfg = config();
    seedRun(db, { id: "r1", task: "t1", state: "ready", stageState: "done" });
    const POLICY = verifyPolicyId({ steps: ["true"], binary: null });
    const req = tx(db, () => insertRequest(db, { project_id: "web", pr_url: "u", task_id: "t1", head_sha: "a".repeat(40), policy_id: POLICY, pr_number: 7, head_ref: "b", worktree: null, source: "auto", path: null, now: 0 }));
    tx(db, () => db.query("INSERT INTO auto_merges (id, run_id, task_id, project_id, ref, head_sha, state, request_id, created_at, state_since, updated_at) VALUES ('am1', 'r1', 't1', 'web', 'u', ?1, 'queued', ?2, 0, 0, 0)").run("a".repeat(40), req.id));
    expect(collectWaits(db, cfg, 60 * MIN).map((w) => w.key)).toEqual([`verify:${req.id}`]);
  });
});

test("deadlineLabel says how long until a wait is due, or how long ago it passed", () => {
  expect(deadlineLabel({ due: 10 * MIN }, 2 * MIN)).toBe("in 8m");
  expect(deadlineLabel({ due: 10 * MIN }, 12 * MIN)).toBe("passed 2m ago");
});
