import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openItem } from "../../src/attention/items.ts";
import { parseConfig, type FlowrynConfig } from "../../src/config/config.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { deliveredOf } from "../../src/lifecycle/delivery.ts";
import { getRunWithPolicy, type RunWithPolicy } from "../../src/lifecycle/runs.ts";
import { gitRunner } from "../../src/policy/git.ts";
import { liveAutoMerge } from "../../src/verify/auto-merge.ts";
import { MAX_SKIPPED_TURNS, verifyConfig } from "../../src/verify/config.ts";
import { landingCell, landingProgress, LandingQueue, liveLanding, TRAIN_RANK, type LandingRow } from "../../src/verify/landing-queue.ts";
import { verifyPolicyId } from "../../src/verify/policy.ts";
import { getRequest, markStarted } from "../../src/verify/queue.ts";
import { finishVerification, insertVerification, type Verification, type VerifyStep } from "../../src/verify/store.ts";
import { GIT_ENV, scratchRepos, sh } from "../helpers/scratch-git.ts";

/**
 * The merge queue for local-only projects (docs/notes/2026-11-15-local-only-auto-x9.md), with real
 * git: every entry lands at a candidate (its delivered head merged onto the head ahead, local main
 * for the first) built in the object store and verified once; main fast-forwards to it. The merge
 * itself (the merge verb's `git merge --ff-only` in the primary checkout) is played here by the
 * test, after the queue's beforeMerge said yes; test/integration/landing-local.test.ts runs it all
 * through a real daemon.
 */

const STEPS = ["bun test"];
const git = gitRunner(Bun.which("git") ?? "git", 30_000, GIT_ENV);

let dir: string;
let db: Db;
let primary: string;
let now: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-local-q-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  primary = scratchRepos(dir).primary;
  now = 1_000_000;
  tx(db, () => db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode, yolo) VALUES ('web', '', ?1, 'main', 'local-only', 1)").run(primary));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Unset `landing`: a local-only project with verify steps queues by default. */
function config(depth: number | null = null): FlowrynConfig {
  return parseConfig(`[projects.web]\nverify = ${JSON.stringify(STEPS)}\n${depth === null ? "" : `landing_train_depth = ${depth}\n`}`, dir);
}

interface Ship {
  task: string;
  run: string;
  wt: string;
  branch: string;
  head: string;
  get(): RunWithPolicy;
}

/** A delivered routine local-only ship: a worktree of the primary checkout on its own branch from main, one commit of `file`. */
function ship(n: number, file: string, text: string): Ship {
  const task = `t${n}`;
  const run = `r${n}`;
  const branch = `flowryn/${task}`;
  const wt = join(dir, `wt-${task}`);
  sh(primary, ["worktree", "add", "-q", "-b", branch, wt, "main"]);
  writeFileSync(join(wt, file), text);
  sh(wt, ["add", "."]);
  sh(wt, ["commit", "-q", "-m", file]);
  const head = sh(wt, ["rev-parse", "HEAD"]);
  const delivered = 1_000 + n;
  tx(db, () => {
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, sensitive, workflow, created_at) VALUES (?1, 'web', 'ship', 'local-only', 1, 0, 'fix', 0)").run(task);
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, stage_state, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
       VALUES (?1, ?2, 'claude', '2.1.281', 'ready', 'idle', 'fix', 'ship', 'done', ?3, ?4, 'abc', ?1, ?5, ?5)`,
    ).run(run, task, wt, branch, delivered);
    db.query("INSERT INTO artifacts (id, task_id, kind, ref, head_sha, created_at) VALUES (?1, ?2, 'local', ?3, ?4, ?5)").run(`a${n}`, task, branch, head, delivered);
    const event = appendEvent(db, { source: "cli", kind: "run.delivered", runId: run, taskId: task, payload: {}, ts: delivered });
    openItem(db, { kind: "pr_ready", eventSeq: event.seq, taskId: task, runId: run, line: `Branch ready to merge: ${task} (web), local-only, 1 commit(s)`, now: delivered });
  });
  return { task, run, wt, branch, head, get: () => getRunWithPolicy(db, run)! };
}

function queue(cfg = config()): LandingQueue {
  return new LandingQueue({ db, config: () => cfg, git, netGit: git, now: () => now, log: () => {}, kickScheduler: () => {} });
}

function row(s: Ship): LandingRow {
  return liveLanding(db, s.run) ?? (db.query("SELECT * FROM landing_queue WHERE run_id = ?1 ORDER BY enqueued_at DESC LIMIT 1").get(s.run) as LandingRow);
}

function parents(sha: string): string[] {
  return sh(primary, ["rev-list", "--parents", "-n", "1", sha]).split(" ").slice(1);
}

function mainTip(): string {
  return sh(primary, ["rev-parse", "refs/heads/main"]);
}

/** A commit on local main made by hand in the primary checkout. */
function commitOnMain(file: string, text: string): string {
  writeFileSync(join(primary, file), text);
  sh(primary, ["add", file]);
  sh(primary, ["commit", "-q", "-m", `by hand: ${file}`]);
  return mainTip();
}

function events(kind: string): Record<string, unknown>[] {
  return (db.query("SELECT payload FROM events WHERE kind = ?1 ORDER BY seq").all(kind) as { payload: string }[]).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
}

const policy = () => verifyPolicyId(verifyConfig(config(), "web")!);

/** The verify runner's part: the entry's candidate request runs and ends in `state`. */
function verify(r: LandingRow, state: "passed" | "failed", steps: VerifyStep[] = []): Verification {
  return tx(db, () => {
    const v = insertVerification(db, { project_id: "web", pr_url: r.ref, task_id: r.task_id, head_sha: r.train_head!, steps: [], policy_id: policy(), dir: (id) => join(dir, "v", id), worktree: (id) => join(dir, `vwt-${id}`), project_path: primary, source: "daemon", now });
    const request = getRequest(db, r.train_request!);
    if (request?.state === "queued") markStarted(db, request, v.id, now);
    finishVerification(db, v, { state, steps, tests: null, detail: state === "failed" ? "bun test exited 1" : null, binary: null }, now + 1);
    return v;
  });
}

/** A failed `bun test` step with its log on disk, as the runner leaves it. */
function failedStep(id: string): VerifyStep[] {
  mkdirSync(join(dir, "v", id), { recursive: true });
  writeFileSync(join(dir, "v", id, "bun-test.log"), "expect(received).toBe(expected)\n1 fail\n");
  return [{ name: "bun test", state: "failed", exit: 1, ms: 10, log: "bun-test.log", tests: null, detail: null }];
}

/** What a send-back tells the worker: its last stage's start note. */
function sentBackText(s: Ship): string {
  return (db.query("SELECT stage_note FROM runs WHERE id = ?1").get(s.run) as { stage_note: string | null }).stage_note ?? "";
}

/** The merge verb's local merge, once the queue's beforeMerge allowed it, and the run landed as its proof records it. */
async function land(lq: LandingQueue, s: Ship): Promise<void> {
  const auto = liveAutoMerge(db, s.run)!;
  expect(await lq.beforeMerge(auto)).toBe(true);
  sh(primary, ["merge", "-q", "--ff-only", auto.head_sha]);
  tx(db, () => db.query("UPDATE runs SET state = 'landed' WHERE id = ?1").run(s.run));
}

describe("two local branches ready together", () => {
  test("both verify at once, land in sequence with one verify each and no steer; the second's branch only gains a merge commit", async () => {
    const base = mainTip();
    const s1 = ship(1, "one.txt", "one\n");
    const s2 = ship(2, "two.txt", "two\n");
    const lq = queue();
    await lq.pass();

    // The first already holds main: it is its own candidate, verified at rank 0, landing at once.
    const r1 = row(s1);
    expect(r1).toMatchObject({ state: "landing", head_sha: s1.head, train_head: s1.head, train_base: base, detail: `on main at ${base.slice(0, 8)}` });
    expect(getRequest(db, r1.train_request!)).toMatchObject({ state: "queued", rank: 0, head_sha: s1.head, worktree: null, pr_number: null, pr_url: `local:${s1.branch}` });
    expect(liveAutoMerge(db, s1.run)).toMatchObject({ state: "queued", request_id: r1.train_request, head_sha: s1.head, ref: `local:${s1.branch}` });
    // The second verifies at the same time, on the first: git's merge, in the object store only.
    const r2 = row(s2);
    expect(r2).toMatchObject({ state: "waiting", train_base: s1.head });
    expect(parents(r2.train_head!)).toEqual([s2.head, s1.head]);
    expect(sh(primary, ["log", "-1", "--format=%s", r2.train_head!])).toBe(`Merge ${s1.head.slice(0, 8)}, the branch ahead in the merge queue, into ${s2.branch}`);
    expect(getRequest(db, r2.train_request!)).toMatchObject({ state: "queued", rank: TRAIN_RANK, head_sha: r2.train_head });
    expect(sh(s2.wt, ["rev-parse", "HEAD"])).toBe(s2.head);
    expect(landingProgress(db, r2)).toBe(`landing queue: 2 of 2, behind ${s1.task}, candidate ${r2.train_head!.slice(0, 8)} on ${s1.head.slice(0, 8)}, verify queued (${r2.train_request}) (${r2.id})`);

    const v1 = verify(row(s1), "passed");
    const v2 = verify(row(s2), "passed");
    expect(landingCell(db, row(s2))).toBe(`queue 2/2 verify ${v2.id} passed on ${s1.head.slice(0, 8)}`);
    await land(lq, s1);
    await lq.pass();
    expect(row(s1).state).toBe("landed");

    // The second lands at its candidate: the worktree fast-forwards to it, the delivery is carried, its verify is followed.
    const landing = row(s2);
    expect(landing).toMatchObject({ state: "landing", head_sha: r2.train_head, train_base: s1.head, integrations: 1, detail: `caught up with main at ${s1.head.slice(0, 8)}` });
    expect(sh(s2.wt, ["rev-parse", "HEAD"])).toBe(r2.train_head!);
    expect(deliveredOf(db, s2.task)).toMatchObject({ kind: "local", head: r2.train_head, carriedFrom: s2.head });
    expect(liveAutoMerge(db, s2.run)).toMatchObject({ state: "waiting_checks", verification_id: v2.id, head_sha: r2.train_head });
    expect(events("landing.caught_up")).toEqual([expect.objectContaining({ landing: landing.id, from: s2.head, to: r2.train_head, main: s1.head })]);
    expect(landingProgress(db, landing)).toBe(`landing queue: first in line, caught up with main at ${s1.head.slice(0, 8)}, verify ${v2.id} passed (${landing.id})`);
    await land(lq, s2);
    await lq.pass();

    expect([row(s1).state, row(s2).state]).toEqual(["landed", "landed"]);
    expect(mainTip()).toBe(r2.train_head!);
    expect(sh(primary, ["ls-tree", "--name-only", "main"]).split("\n").toSorted()).toEqual(["a.txt", "one.txt", "two.txt"]);
    // One verify each, no steer, nothing sent back.
    expect((db.query("SELECT head_sha FROM verifications ORDER BY id").all() as { head_sha: string }[]).map((v) => v.head_sha)).toEqual([v1.head_sha, v2.head_sha]);
    expect(db.query("SELECT COUNT(*) AS n FROM verify_queue").get()).toEqual({ n: 2 });
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM events WHERE kind IN ('verify.sent_back','run.conflict_nudged')").get()).toEqual({ n: 0 });
    // assumption: the branch only gained the merge commit (the delivered head is its first parent), and was never reset.
    expect(sh(s2.wt, ["rev-list", "--first-parent", "HEAD"]).split("\n").slice(0, 2)).toEqual([r2.train_head!, s2.head]);
    expect(sh(s2.wt, ["reflog", "--format=%gs", s2.branch])).not.toContain("reset");
  });

  test("a train of three lands in order, each candidate on the one before", async () => {
    const s1 = ship(1, "one.txt", "one\n");
    const s2 = ship(2, "two.txt", "two\n");
    const s3 = ship(3, "three.txt", "three\n");
    const lq = queue(config(3));
    await lq.pass();
    const c2 = row(s2);
    const c3 = row(s3);
    expect(c2.train_base).toBe(s1.head);
    expect(c3.train_base).toBe(c2.train_head);
    expect(parents(c3.train_head!)).toEqual([s3.head, c2.train_head!]);
    for (const s of [s1, s2, s3]) verify(row(s), "passed");
    await land(lq, s1);
    await lq.pass();
    expect(row(s2)).toMatchObject({ state: "landing", head_sha: c2.train_head });
    expect(row(s3)).toMatchObject({ state: "waiting", train_head: c3.train_head, train_base: c2.train_head });
    await land(lq, s2);
    await lq.pass();
    expect(row(s3)).toMatchObject({ state: "landing", head_sha: c3.train_head });
    await land(lq, s3);
    await lq.pass();
    expect(mainTip()).toBe(c3.train_head!);
    expect(db.query("SELECT COUNT(*) AS n FROM verifications").get()).toEqual({ n: 3 });
    expect(events("landing.train_dropped")).toEqual([]);
  });
});

describe("main moving", () => {
  test("main moved by hand before the merge: the head of line goes back, is rebuilt on the new main and verified there", async () => {
    const s1 = ship(1, "one.txt", "one\n");
    const lq = queue();
    await lq.pass();
    verify(row(s1), "passed");
    const moved = commitOnMain("hand.txt", "hand\n");
    expect(await lq.beforeMerge(liveAutoMerge(db, s1.run)!)).toBe(false);
    expect(row(s1)).toMatchObject({ state: "waiting", train_head: null });
    expect(events("landing.base_moved")).toEqual([expect.objectContaining({ base: "main", head: s1.head })]);
    await lq.pass();
    const again = row(s1);
    expect(again).toMatchObject({ state: "landing", train_base: moved, integrations: 1 });
    expect(parents(again.head_sha)).toEqual([s1.head, moved]);
    expect(sh(primary, ["log", "-1", "--format=%s", again.head_sha])).toBe(`Merge main at ${moved.slice(0, 8)} into ${s1.branch} (Flowryn merge queue)`);
    expect(sh(s1.wt, ["rev-parse", "HEAD"])).toBe(again.head_sha);
    expect(liveAutoMerge(db, s1.run)).toMatchObject({ state: "queued", head_sha: again.head_sha, request_id: again.train_request });
  });
});

describe("a conflict", () => {
  test("a car conflicting with the one ahead waits its turn; on main it goes back to its worker naming the paths, its branch untouched", async () => {
    const s1 = ship(1, "same.txt", "one\n");
    const s2 = ship(2, "same.txt", "two\n");
    const lq = queue();
    await lq.pass();
    expect(row(s2)).toMatchObject({ state: "waiting", train_head: null });
    expect(events("landing.train_skipped")).toEqual([expect.objectContaining({ landing: row(s2).id, base: s1.head, files: ["same.txt"] })]);
    verify(row(s1), "passed");
    await land(lq, s1);
    await lq.pass();

    expect(row(s2)).toMatchObject({ state: "left", reason: "conflict", detail: "merging main conflicts in 1 file(s): same.txt" });
    expect(s2.get().state).toBe("running");
    const nudge = events("run.conflict_nudged");
    expect(nudge).toEqual([expect.objectContaining({ base: "main", files: ["same.txt"], pr: `local:${s2.branch}` })]);
    const steer = sentBackText(s2);
    expect(steer).toContain(`Your branch ${s2.branch} conflicts with main`);
    expect(steer).toContain("Conflicted: same.txt.");
    expect(steer).toContain("deliver --local again");
    expect(sh(s2.wt, ["rev-parse", "HEAD"])).toBe(s2.head);
    expect(sh(s2.wt, ["status", "--porcelain"])).toBe("");
  });
});

describe("a failed car", () => {
  test("its candidate failed while the car ahead verified: once main is its base it goes back with that log, with no verify again", async () => {
    const s1 = ship(1, "one.txt", "one\n");
    const s2 = ship(2, "two.txt", "two\n");
    const lq = queue();
    await lq.pass();
    verify(row(s1), "passed");
    const c2 = row(s2);
    const failed = verify(c2, "failed", failedStep("v2"));
    await lq.pass();
    // The car ahead has not landed: the failure may be its, so the car stays.
    expect(row(s2)).toMatchObject({ state: "waiting", train_head: c2.train_head });
    await land(lq, s1);
    await lq.pass();

    expect(row(s2)).toMatchObject({ state: "left", reason: "verify_failed" });
    expect(s2.get().state).toBe("running");
    expect(events("landing.car_failed")).toEqual([expect.objectContaining({ landing: c2.id, verification: failed.id, step: "bun test", base: s1.head })]);
    expect(events("verify.sent_back")).toEqual([expect.objectContaining({ verification: failed.id, step: "bun test", landing: c2.id })]);
    const steer = sentBackText(s2);
    expect(steer).toContain(`Merge queue: the daemon's flowryn verify ${failed.id}`);
    expect(steer).toContain("1 fail");
    expect(steer).toContain(`merged with main at ${s1.head.slice(0, 8)}`);
    expect(db.query("SELECT COUNT(*) AS n FROM verifications").get()).toEqual({ n: 2 });
    expect(sh(s2.wt, ["rev-parse", "HEAD"])).toBe(s2.head);
  });

  test("a car whose base left is rebuilt on main", async () => {
    const s1 = ship(1, "one.txt", "one\n");
    const s2 = ship(2, "two.txt", "two\n");
    const lq = queue();
    await lq.pass();
    const before = row(s2);
    tx(db, () => db.query("UPDATE runs SET state = 'running' WHERE id = ?1").run(s1.run));
    await lq.pass();
    expect(row(s1)).toMatchObject({ state: "left", reason: "sent_back" });
    const after = row(s2);
    expect(after.train_head).not.toBe(before.train_head);
    expect(after).toMatchObject({ state: "landing", train_base: mainTip(), head_sha: s2.head, train_head: s2.head });
    expect(getRequest(db, before.train_request!)!.state).toBe("cancelled");
  });
});

describe("a worker that is not ready on its turn", () => {
  test(`waits 5 min, then the ones behind go ahead; it keeps its place, and is held at its ${MAX_SKIPPED_TURNS}rd skipped turn`, async () => {
    const s1 = ship(1, "one.txt", "one\n");
    const behind = [ship(2, "two.txt", "two\n"), ship(3, "three.txt", "three\n"), ship(4, "four.txt", "four\n")];
    // Main moved since s1 branched: its candidate is a merge, so its turn needs its checkout.
    commitOnMain("hand.txt", "hand\n");
    tx(db, () => db.query("UPDATE runs SET liveness = 'busy' WHERE id = ?1").run(s1.run));
    const lq = queue();
    await lq.pass();
    expect(row(s1)).toMatchObject({ state: "waiting", blocked_since: now, detail: "the worker is busy" });
    expect(behind.map((s) => row(s).state)).toEqual(["waiting", "waiting", "waiting"]);
    expect(landingCell(db, row(s1))).toContain("worker not ready");

    for (const [turn, s] of behind.entries()) {
      // Within the 5 min nothing goes past it, and it stays in the train: the one behind is built on its candidate, not rebuilt on main.
      for (const step of [60_000, 4 * 60_000 - 1]) {
        now += step;
        await lq.pass();
        expect(row(s).state).toBe("waiting");
        expect(row(s).train_base).toBe(row(s1).train_head);
      }
      // At 5 min the next one goes.
      now += 1;
      await lq.pass();
      expect(row(s).state).toBe("landing");
      expect(events("landing.turn_skipped").length).toBe(turn + 1);
      if (turn < MAX_SKIPPED_TURNS - 1) {
        expect(row(s1)).toMatchObject({ state: "waiting", blocked_since: null });
        expect(landingProgress(db, row(s1))).toContain(`passed over ${turn + 1} of ${MAX_SKIPPED_TURNS}`);
      }
      verify(row(s), "passed");
      await land(lq, s);
      await lq.pass();
      if (turn === MAX_SKIPPED_TURNS - 1) break;
    }
    expect(row(s1)).toMatchObject({ state: "left", reason: "turns_skipped" });
    expect(row(s1).detail).toContain("passed over 3 times while its worker was not ready (the worker is busy)");
    expect(db.query("SELECT line FROM items WHERE kind = 'auto_merge_held' AND run_id = ?1").get(s1.run)).toEqual({ line: expect.stringContaining("Landing held") });
    expect(sh(s1.wt, ["rev-parse", "HEAD"])).toBe(s1.head);
  });

  test("a worker that becomes ready in time takes its turn", async () => {
    const s1 = ship(1, "one.txt", "one\n");
    commitOnMain("hand.txt", "hand\n");
    writeFileSync(join(s1.wt, "scratch.txt"), "wip\n");
    const lq = queue();
    await lq.pass();
    expect(row(s1)).toMatchObject({ state: "waiting", detail: "the worktree has 1 uncommitted change(s)" });
    rmSync(join(s1.wt, "scratch.txt"));
    now += 60_000;
    await lq.pass();
    expect(row(s1)).toMatchObject({ state: "landing", blocked_since: null });
    expect(events("landing.turn_skipped")).toEqual([]);
  });
});
