import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openItem } from "../../src/attention/items.ts";
import { parseConfig, type FlowrynConfig } from "../../src/config/config.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { getRunWithPolicy } from "../../src/lifecycle/runs.ts";
import { gitRunner } from "../../src/policy/git.ts";
import { inertDelivery } from "../../src/policy/services.ts";
import { batchMembers, batchRef, getBatch, liveBatch, type BatchRow } from "../../src/verify/batch-store.ts";
import { landingBatched, landingMode, landingQueued, landingTrainDepth, lightVerifyConfig, verifyConfig } from "../../src/verify/config.ts";
import { batchView, landingBoardLines } from "../../src/verify/landing-batch.ts";
import { landingCell, landingProgress, LandingQueue, liveLanding, type LandingRow } from "../../src/verify/landing-queue.ts";
import { verifyPolicyId } from "../../src/verify/policy.ts";
import { findQueued, getRequest, markStarted } from "../../src/verify/queue.ts";
import { finishVerification, insertVerification, type Verification, type VerifyStep } from "../../src/verify/store.ts";
import { GIT_ENV, scratchRepos, sh } from "../helpers/scratch-git.ts";

/**
 * Landing batches (docs/notes/2026-11-21-landing-batches-one-27.md), with real git and the merge
 * verb's own path: a batch project's ready branches are merged onto local main in one batch head
 * (object store only), verified once, and landed together, each with its own merge record. The
 * verify runner's part is played by the test (a verification recorded on the batch's request);
 * test/integration/landing-batch.test.ts runs it all through a real daemon.
 */

const STEPS = ["bun test"];
const LIGHT = ["make vet"];
const git = gitRunner(Bun.which("git") ?? "git", 30_000, GIT_ENV);

let dir: string;
let db: Db;
let primary: string;
let now: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-batch-"));
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

function config(extra = "", light = false): FlowrynConfig {
  return parseConfig(`[projects.web]\nverify = ${JSON.stringify(STEPS)}\nlanding = "batch"\n${light ? `light_verify = ${JSON.stringify(LIGHT)}\n` : ""}${extra}`, dir);
}

interface Ship {
  task: string;
  run: string;
  wt: string;
  branch: string;
  head: string;
}

/** A delivered local-only ship: a worktree of the primary checkout on its own branch from main, one commit per file. */
function ship(n: number, files: Record<string, string>, opts: { sensitive?: boolean; from?: string } = {}): Ship {
  const task = `t${n}`;
  const run = `r${n}`;
  const branch = `flowryn/${task}`;
  const wt = join(dir, `wt-${task}`);
  sh(primary, ["worktree", "add", "-q", "-b", branch, wt, opts.from ?? "main"]);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(wt, file, ".."), { recursive: true });
    writeFileSync(join(wt, file), text);
  }
  sh(wt, ["add", "."]);
  sh(wt, ["commit", "-q", "-m", Object.keys(files).join(" ")]);
  const head = sh(wt, ["rev-parse", "HEAD"]);
  const delivered = 1_000 + n;
  tx(db, () => {
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, sensitive, workflow, created_at) VALUES (?1, 'web', 'ship', 'local-only', 1, ?2, 'fix', 0)").run(task, opts.sensitive ? 1 : 0);
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, stage_state, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
       VALUES (?1, ?2, 'claude', '2.1.281', 'ready', 'idle', 'fix', 'ship', 'done', ?3, ?4, 'abc', ?1, ?5, ?5)`,
    ).run(run, task, wt, branch, delivered);
    db.query("INSERT INTO artifacts (id, task_id, kind, ref, head_sha, created_at) VALUES (?1, ?2, 'local', ?3, ?4, ?5)").run(`a${n}`, task, branch, head, delivered);
    const event = appendEvent(db, { source: "cli", kind: "run.delivered", runId: run, taskId: task, payload: {}, ts: delivered });
    openItem(db, { kind: "pr_ready", eventSeq: event.seq, taskId: task, runId: run, line: `Branch ready to merge: ${task} (web), local-only, 1 commit(s)`, now: delivered });
  });
  return { task, run, wt, branch, head };
}

const cleanups: string[] = [];
function queue(cfg = config()): LandingQueue {
  const delivery = inertDelivery({ git, cleanup: async (runId) => {
    cleanups.push(runId);
    return { outcome: "cleaned" } as never;
  } });
  return new LandingQueue({ db, config: () => cfg, git, netGit: git, now: () => now, log: () => {}, kickScheduler: () => {}, delivery });
}

function row(s: Ship): LandingRow {
  return liveLanding(db, s.run) ?? (db.query("SELECT * FROM landing_queue WHERE run_id = ?1 ORDER BY enqueued_at DESC LIMIT 1").get(s.run) as LandingRow);
}

function batchOf(): BatchRow {
  const b = liveBatch(db, "web");
  if (!b) throw new Error("no live batch");
  return b;
}

const mainTip = () => sh(primary, ["rev-parse", "refs/heads/main"]);
const parents = (sha: string) => sh(primary, ["rev-list", "--parents", "-n", "1", sha]).split(" ").slice(1);
const fullPolicy = (cfg = config()) => verifyPolicyId(verifyConfig(cfg, "web")!);
const lightPolicy = () => verifyPolicyId(lightVerifyConfig(verifyConfig(config("", true), "web")!)!);

function events(kind: string): Record<string, unknown>[] {
  return (db.query("SELECT payload FROM events WHERE kind = ?1 ORDER BY seq").all(kind) as { payload: string }[]).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
}

/** The verify runner's part: the request at (ref, head, policy) runs and ends in `state`. */
function runVerify(ref: string, head: string, policy: string, state: "passed" | "failed", steps: VerifyStep[] = [], task: string | null = null): Verification {
  return tx(db, () => {
    const request = findQueued(db, ref, head, policy);
    const v = insertVerification(db, { project_id: "web", pr_url: ref, task_id: task, head_sha: head, steps: [], policy_id: policy, dir: (id) => join(dir, "v", id), worktree: (id) => join(dir, `vwt-${id}`), project_path: primary, source: "daemon", now });
    if (request) markStarted(db, request, v.id, now);
    finishVerification(db, v, { state, steps, tests: null, detail: state === "failed" ? "a step failed" : null, binary: null }, now + 1);
    return v;
  });
}

function verifyBatch(state: "passed" | "failed", steps: VerifyStep[] = [], cfg = config()): Verification {
  const b = batchOf();
  return runVerify(batchRef("web", b.id), b.head_sha, fullPolicy(cfg), state, steps);
}

/** A failed step with its log on disk, as the runner leaves it. */
function failedStep(name: string, log: string): VerifyStep[] {
  const id = `s${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(join(dir, "v", "steps", id), { recursive: true });
  writeFileSync(join(dir, "v", "steps", id, "step.log"), log);
  return [{ name, state: "failed", exit: 1, ms: 10, log: join("..", "steps", id, "step.log"), tests: null, detail: null }];
}

/** What a send-back tells the worker: its last stage's start note. */
const note = (s: Ship) => (db.query("SELECT stage_note FROM runs WHERE id = ?1").get(s.run) as { stage_note: string | null }).stage_note ?? "";
const runState = (s: Ship) => getRunWithPolicy(db, s.run)!.state;

describe("config", () => {
  test("batch needs verify steps and a local-only project; light_verify only with batch; a batch project queues, with no train", () => {
    const at = (text: string) => parseConfig(text, dir);
    expect(landingMode(config(), "web", "local-only")).toBe("batch");
    expect(landingMode(config(), "web", null)).toBe("batch");
    expect(() => landingMode(config(), "web", "direct-PR")).toThrow(/landing = "batch" is for local-only projects/);
    expect(() => verifyConfig(at(`[projects.web]\nlanding = "batch"\n`), "web")).toThrow(/landing = "batch" needs verify steps/);
    expect(() => verifyConfig(at(`[projects.web]\nverify = ["x"]\nlight_verify = ["y"]\n`), "web")).toThrow(/light_verify is the light check of landing = "batch"/);
    expect(() => verifyConfig(at(`[projects.web]\nverify = ["x"]\nlanding = "batch"\nlight_verify = [{ review = true }]\n`), "web")).toThrow(/light_verify cannot hold the review step/);
    expect(landingQueued(config(), "web", "local-only")).toBe(true);
    expect(landingBatched(config(), "web", "local-only")).toBe(true);
    expect(landingQueued(config(), "web", "direct-PR")).toBe(false);
    expect(landingTrainDepth(config("landing_train_depth = 3\n"), "web", "local-only")).toBe(1);
    // The light check has its own policy; the full verify's is unchanged by it.
    expect(lightPolicy()).not.toBe(fullPolicy(config("", true)));
    expect(fullPolicy(config("", true))).toBe(fullPolicy(config()));
  });
});

describe("a batch of routine branches", () => {
  test("three branches land together after one verify; main's first-parent log has one merge per task; no worker branch moves", async () => {
    const base = mainTip();
    const s1 = ship(1, { "one.txt": "one\n" });
    const s2 = ship(2, { "two.txt": "two\n" });
    const s3 = ship(3, { "three.txt": "three\n" });
    const lq = queue();
    await lq.pass();

    const b = batchOf();
    expect(b).toMatchObject({ state: "verifying", base_sha: base });
    expect(batchMembers(db, b.id).map((r) => [r.task_id, r.batch_pos, r.state])).toEqual([
      [s1.task, 1, "landing"],
      [s2.task, 2, "landing"],
      [s3.task, 3, "landing"],
    ]);
    // The first holds main and is taken as it is; each other is a merge with the batch so far first.
    const head3 = b.head_sha;
    const [head2, third] = parents(head3);
    expect(third).toBe(s3.head);
    expect(parents(head2!)).toEqual([s1.head, s2.head]);
    expect(sh(primary, ["log", "-1", "--format=%s", head3])).toBe(`Merge ${s3.branch} (${s3.task}) into the landing batch on main ${base.slice(0, 8)} (Flowryn)`);
    // One request, for the batch head, under the full verify; nothing in a worktree.
    expect(getRequest(db, b.request_id!)).toMatchObject({ state: "queued", pr_url: batchRef("web", b.id), head_sha: head3, worktree: null, pr_number: null, policy_id: fullPolicy() });
    expect(db.query("SELECT COUNT(*) AS n FROM verify_queue").get()).toEqual({ n: 1 });
    expect(landingProgress(db, row(s2))).toBe(`landing batch ${b.id}: 2 of 3, verify queued, waiting for a slot (${b.request_id}, 1 of 1) (${row(s2).id})`);
    expect(landingCell(db, row(s2))).toMatch(new RegExp(`^batch ${b.id} 2/3 verify queued`));

    const v = verifyBatch("passed");
    await lq.pass();

    expect(mainTip()).toBe(head3);
    expect(getBatch(db, b.id)).toMatchObject({ state: "landed", verification_id: v.id });
    expect([s1, s2, s3].map((s) => [row(s).state, runState(s)])).toEqual([
      ["landed", "landed"],
      ["landed", "landed"],
      ["landed", "landed"],
    ]);
    // Each task has its own merge record at its delivered head.
    const merges = db.query("SELECT task_id, head_sha, state FROM merges ORDER BY requested_at, id").all() as { task_id: string; head_sha: string; state: string }[];
    expect(merges).toEqual([
      { task_id: s1.task, head_sha: s1.head, state: "merged" },
      { task_id: s2.task, head_sha: s2.head, state: "merged" },
      { task_id: s3.task, head_sha: s3.head, state: "merged" },
    ]);
    expect(cleanups.toSorted()).toEqual(expect.arrayContaining([s1.run, s2.run, s3.run]));
    // assumption: main's first-parent history is one merge commit per task after the first, and no branch was touched.
    expect(sh(primary, ["rev-list", "--first-parent", `${base}..main`]).split("\n")).toEqual([head3, head2!, s1.head]);
    for (const s of [s1, s2, s3]) expect(sh(s.wt, ["rev-parse", "HEAD"])).toBe(s.head);
    expect(db.query("SELECT COUNT(*) AS n FROM verifications").get()).toEqual({ n: 1 });
    expect(events("landing.batch_built")).toHaveLength(1);
    expect(events("landing.batch_landed")).toEqual([expect.objectContaining({ batch: b.id })]);
  });

  test("assumption: the landed proof holds for each member's head once main is at the batch head", async () => {
    const s1 = ship(1, { "one.txt": "one\n" });
    const s2 = ship(2, { "two.txt": "two\n" });
    const lq = queue();
    await lq.pass();
    verifyBatch("passed");
    await lq.pass();
    for (const s of [s1, s2]) expect((await git(["merge-base", "--is-ancestor", s.head, "refs/heads/main"], primary)).code).toBe(0);
  });

  test("a branch delivered while a batch is in flight waits for the next batch, which lands on its own verify", async () => {
    const s1 = ship(1, { "one.txt": "one\n" });
    const lq = queue();
    await lq.pass();
    const first = batchOf();
    const s2 = ship(2, { "two.txt": "two\n" });
    await lq.pass();
    expect(row(s2)).toMatchObject({ state: "waiting", batch_id: null });
    expect(landingProgress(db, row(s2))).toBe(`landing queue: waiting for the next batch (${row(s2).id})`);
    expect(landingBoardLines(db).join("\n")).toContain(`web  ${first.id} verify queued`);
    expect(landingBoardLines(db).join("\n")).toContain("next batch: 1 waiting");
    verifyBatch("passed");
    await lq.pass();
    expect(runState(s1)).toBe("landed");
    const second = batchOf();
    expect(second.id).not.toBe(first.id);
    expect(batchMembers(db, second.id).map((r) => r.task_id)).toEqual([s2.task]);
    verifyBatch("passed");
    await lq.pass();
    expect(runState(s2)).toBe("landed");
    expect(sh(primary, ["ls-tree", "--name-only", "main"]).split("\n").toSorted()).toEqual(["a.txt", "one.txt", "two.txt"]);
  });
});

describe("the light check", () => {
  test("each waiting branch's light check runs on its delivered head alone; only a pass joins a batch; a failing step sends it back once", async () => {
    const cfg = config("", true);
    const s1 = ship(1, { "one.txt": "one\n" });
    const s2 = ship(2, { "two.txt": "two\n" });
    const lq = queue(cfg);
    await lq.pass();
    expect(liveBatch(db, "web")).toBeNull();
    const light = lightPolicy();
    for (const s of [s1, s2]) expect(findQueued(db, `local:${s.branch}`, s.head, light)).toMatchObject({ head_sha: s.head, worktree: null, pr_number: null, source: "auto" });
    expect(landingProgress(db, row(s1))).toBe(`landing queue: waiting for the next batch, light check queued (${row(s1).id})`);

    runVerify(`local:${s1.branch}`, s1.head, light, "passed", [], s1.task);
    runVerify(`local:${s2.branch}`, s2.head, light, "failed", failedStep("make vet", "vet: two.txt:1: bad\n"), s2.task);
    await lq.pass();

    expect(batchMembers(db, batchOf().id).map((r) => r.task_id)).toEqual([s1.task]);
    expect(row(s2)).toMatchObject({ state: "left", reason: "light_failed" });
    expect(runState(s2)).toBe("running");
    expect(note(s2)).toContain("Light check: the daemon's flowryn verify");
    expect(note(s2)).toContain("before it may join a landing batch");
    expect(events("verify.sent_back")).toEqual([expect.objectContaining({ landing: row(s2).id, light: true, head: s2.head })]);
  });
});

describe("conflicts and clashes", () => {
  test("a branch clashing only with an earlier member waits for the next batch; then, against main, it goes back with the paths", async () => {
    const s1 = ship(1, { "same.txt": "one\n" });
    const s2 = ship(2, { "same.txt": "two\n" });
    const lq = queue();
    await lq.pass();
    expect(batchMembers(db, batchOf().id).map((r) => r.task_id)).toEqual([s1.task]);
    expect(row(s2)).toMatchObject({ state: "waiting", batch_id: null });
    expect(events("landing.batch_skipped")).toEqual([expect.objectContaining({ landing: row(s2).id, with: [s1.task], files: ["same.txt"] })]);
    expect(runState(s2)).toBe("ready");

    verifyBatch("passed");
    await lq.pass();
    expect(runState(s1)).toBe("landed");
    expect(row(s2)).toMatchObject({ state: "left", reason: "conflict" });
    expect(runState(s2)).toBe("running");
    expect(events("run.conflict_nudged")).toEqual([expect.objectContaining({ files: ["same.txt"] })]);
    expect(sh(s2.wt, ["rev-parse", "HEAD"])).toBe(s2.head);
  });

  test("two branches adding the same migration number: the later is sent back to renumber; date-prefixed notes never clash", async () => {
    const s1 = ship(1, { "db/migrations/000042_users.up.sql": "a\n", "docs/notes/2026-11-21-a.md": "a\n" });
    const s2 = ship(2, { "db/migrations/000042_orders.up.sql": "b\n", "docs/notes/2026-11-21-b.md": "b\n" });
    const s3 = ship(3, { "docs/notes/2026-11-21-c.md": "c\n" });
    const lq = queue();
    await lq.pass();
    expect(batchMembers(db, batchOf().id).map((r) => r.task_id)).toEqual([s1.task, s3.task]);
    expect(row(s2)).toMatchObject({ state: "left", reason: "number_clash" });
    expect(runState(s2)).toBe("running");
    expect(note(s2)).toContain("db/migrations/000042_orders.up.sql");
    expect(note(s2)).toContain("db/migrations/000042_users.up.sql");
    expect(events("landing.batch_clash")).toEqual([expect.objectContaining({ with: s1.task })]);
  });
});

describe("a red batch", () => {
  test("held with the likely culprit and one leader item; drop sends that branch back and a new batch of the rest is verified; retry once per head", async () => {
    const s1 = ship(1, { "pkg/store/store.go": "package store\n" });
    const s2 = ship(2, { "pkg/web/web.go": "package web\n" });
    const s3 = ship(3, { "README.md": "hi\n" });
    const lq = queue();
    await lq.pass();
    const b = batchOf();
    const v = verifyBatch("failed", failedStep("bun test", "--- FAIL: TestSave (0.00s)\n    store_test.go:12: wrong\nFAIL\texample.com/app/pkg/store\t0.01s\n"));
    await lq.pass();

    const held = getBatch(db, b.id)!;
    expect(held).toMatchObject({ state: "held", reason: "verify_failed", culprit: s1.task, verification_id: v.id });
    expect(held.detail).toContain(`likely ${s1.task}`);
    const items = db.query("SELECT kind, line, task_id FROM items WHERE kind = 'landing_batch_held' AND state = 'open'").all() as { kind: string; line: string; task_id: string | null }[];
    expect(items).toHaveLength(1);
    expect(items[0]!.line).toContain(`flowryn batch drop ${b.id} ${s1.task} | flowryn batch retry ${b.id}`);
    expect(batchView(db, held)).toMatchObject({ batch: b.id, state: "held", culprit: s1.task });
    expect(landingProgress(db, row(s2))).toContain(`landing batch ${b.id}: 2 of 3, held:`);
    // Held: nothing lands, a pass leaves it be.
    await lq.pass();
    expect(getBatch(db, b.id)!.state).toBe("held");

    // retry: once at this head.
    tx(db, () => lq.batches.retry(b.id));
    expect(getBatch(db, b.id)).toMatchObject({ state: "verifying", retried_head: b.head_sha });
    expect(db.query("SELECT state FROM items WHERE kind = 'landing_batch_held'").get()).toEqual({ state: "resolved" });
    await lq.pass();
    expect(getBatch(db, b.id)!.state).toBe("verifying");
    verifyBatch("failed", failedStep("bun test", "FAIL\texample.com/app/pkg/store\t0.01s\n"));
    await lq.pass();
    expect(getBatch(db, b.id)!.state).toBe("held");
    expect(() => tx(db, () => lq.batches.retry(b.id))).toThrow(/already retried/);
    expect(() => tx(db, () => lq.batches.drop(b.id, "t9"))).toThrow(/t9 is not in landing batch/);

    tx(db, () => lq.batches.drop(b.id, s1.task));
    expect(row(s1)).toMatchObject({ state: "left", reason: "dropped" });
    expect(runState(s1)).toBe("running");
    expect(note(s1)).toContain(`Your leader dropped your branch from landing batch ${b.id}`);
    expect(note(s1)).toContain("It was named the likely culprit");

    await lq.pass();
    expect(getBatch(db, b.id)).toMatchObject({ state: "dissolved", reason: "rebuilt" });
    const next = batchOf();
    expect(batchMembers(db, next.id).map((r) => r.task_id)).toEqual([s2.task, s3.task]);
    expect(db.query("SELECT state FROM items WHERE kind = 'landing_batch_held' AND state = 'open'").all()).toEqual([]);
    verifyBatch("passed");
    await lq.pass();
    expect([runState(s2), runState(s3)]).toEqual(["landed", "landed"]);
    expect(sh(primary, ["ls-tree", "-r", "--name-only", "main"]).split("\n")).not.toContain("pkg/store/store.go");
  });

  test("a verify timeout runs once more before it holds", async () => {
    ship(1, { "one.txt": "one\n" });
    const lq = queue();
    await lq.pass();
    const b = batchOf();
    const timedOut = (): VerifyStep[] => [{ name: "bun test", state: "failed", exit: 124, ms: 10, log: "x.log", tests: null, detail: null, attempts: 1, hangs: 1 }];
    verifyBatch("failed", timedOut());
    await lq.pass();
    const rerun = getBatch(db, b.id)!;
    expect(rerun.state).toBe("verifying");
    expect(getRequest(db, rerun.request_id!)).toMatchObject({ state: "queued", head_sha: b.head_sha });
    expect(events("verify.auto_rerun")).toHaveLength(1);
    verifyBatch("failed", timedOut());
    await lq.pass();
    expect(getBatch(db, b.id)).toMatchObject({ state: "held", reason: "verify_failed" });
    expect(mainTip()).not.toBe(b.head_sha);
  });
});

describe("what keeps a batch honest", () => {
  test("main moved by hand before the verify: rebuilt on the new main and verified again; held at the third move", async () => {
    const s1 = ship(1, { "one.txt": "one\n" });
    const lq = queue();
    await lq.pass();
    for (let i = 1; i <= 3; i++) {
      const before = batchOf();
      writeFileSync(join(primary, `hand${i}.txt`), "x\n");
      sh(primary, ["add", "."]);
      sh(primary, ["commit", "-q", "-m", `by hand ${i}`]);
      await lq.pass();
      expect(getBatch(db, before.id)).toMatchObject({ state: "dissolved", reason: "rebuilt" });
      const after = batchOf();
      expect(after).toMatchObject({ base_sha: mainTip(), integrations: i });
      expect(parents(after.head_sha)).toEqual([mainTip(), s1.head]);
    }
    writeFileSync(join(primary, "hand4.txt"), "x\n");
    sh(primary, ["add", "."]);
    sh(primary, ["commit", "-q", "-m", "by hand 4"]);
    await lq.pass();
    expect(batchOf()).toMatchObject({ state: "held", reason: "base_moving" });
  });

  test("a stop after the fast-forward, before the merge records: the next pass records the rest, nothing twice", async () => {
    const s1 = ship(1, { "one.txt": "one\n" });
    const s2 = ship(2, { "two.txt": "two\n" });
    const lq = queue();
    await lq.pass();
    const b = batchOf();
    verifyBatch("passed");
    // Played: the batch was moved to landing and main fast-forwarded, then the daemon stopped.
    tx(db, () => db.query("UPDATE landing_batches SET state = 'landing' WHERE id = ?1").run(b.id));
    sh(primary, ["merge", "-q", "--ff-only", b.head_sha]);
    await lq.pass();
    expect([runState(s1), runState(s2)]).toEqual(["landed", "landed"]);
    expect(getBatch(db, b.id)!.state).toBe("landed");
    expect(db.query("SELECT COUNT(*) AS n FROM merges").get()).toEqual({ n: 2 });
    expect(events("landing.batch_forwarded")).toEqual([]);
  });

  test("a member whose worktree moved past its delivery is refused by the gate: it leaves and the rest are rebuilt and verified again", async () => {
    const s1 = ship(1, { "one.txt": "one\n" });
    const s2 = ship(2, { "two.txt": "two\n" });
    const lq = queue();
    await lq.pass();
    const b = batchOf();
    verifyBatch("passed");
    writeFileSync(join(s2.wt, "more.txt"), "more\n");
    sh(s2.wt, ["add", "."]);
    sh(s2.wt, ["commit", "-q", "-m", "undelivered"]);
    await lq.pass();
    expect(row(s2)).toMatchObject({ state: "left", reason: "gate:head_moved" });
    expect(mainTip()).not.toBe(b.head_sha);
    expect(getBatch(db, b.id)).toMatchObject({ state: "dissolved", reason: "rebuilt" });
    expect(batchMembers(db, batchOf().id).map((r) => r.task_id)).toEqual([s1.task]);
    expect(runState(s1)).toBe("ready");
  });

  test("the gate counts the batch's pass only at the batch head under today's policy", async () => {
    ship(1, { "one.txt": "one\n" });
    const lq = queue();
    await lq.pass();
    const b = batchOf();
    // A pass under another policy (the steps changed since) does not land it: it is verified again under today's.
    runVerify(batchRef("web", b.id), b.head_sha, "vp1:other", "passed");
    await lq.pass();
    expect(getBatch(db, b.id)!.state).toBe("verifying");
    expect(mainTip()).not.toBe(b.head_sha);
  });

  test("a sensitive branch never joins a batch: it lands alone through the line, with its own candidate on main", async () => {
    const s1 = ship(1, { "secret.txt": "s\n" }, { sensitive: true });
    const s2 = ship(2, { "two.txt": "two\n" });
    // Your approval of the sensitive branch's delivered head puts it in line.
    tx(db, () =>
      db
        .query("INSERT INTO approvals (id, task_id, pr_url, head_sha, channel, actor, action, created_at, expires_at, allow_red_check) VALUES ('ap1', ?1, ?2, ?3, 'cli-tty', 'you', 'merge', ?4, ?5, NULL)")
        .run(s1.task, `local:${s1.branch}`, s1.head, now, now + 3_600_000),
    );
    const lq = queue();
    await lq.pass();
    expect(row(s1).batch_id).toBeNull();
    expect(row(s1).state).toBe("landing");
    expect(row(s1).train_head).toBe(s1.head);
    expect(row(s2)).toMatchObject({ state: "waiting", batch_id: null });
    expect(liveBatch(db, "web")).toBeNull();
  });

  test("switching the project back to the queue dissolves the live batch: its verify cancelled, its branches waiting again", async () => {
    const s1 = ship(1, { "one.txt": "one\n" });
    const lq0 = queue();
    await lq0.pass();
    const b = batchOf();
    const lq = queue(parseConfig(`[projects.web]\nverify = ${JSON.stringify(STEPS)}\nlanding = "queue"\n`, dir));
    await lq.pass();
    expect(getBatch(db, b.id)).toMatchObject({ state: "dissolved", reason: "batching_off" });
    expect(getRequest(db, b.request_id!)!.state).toBe("cancelled");
    expect(row(s1).batch_id).toBeNull();
    expect(["waiting", "landing"]).toContain(row(s1).state);
  });
});
