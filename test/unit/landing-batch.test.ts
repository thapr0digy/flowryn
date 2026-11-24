import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeBriefing } from "../../src/attention/briefing.ts";
import { openItem } from "../../src/attention/items.ts";
import { parseConfig, type FlowrynConfig } from "../../src/config/config.ts";
import { effectiveConfig } from "../../src/config/effective.ts";
import { PROJECT_VERBS } from "../../src/lifecycle/projects.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { getRunWithPolicy } from "../../src/lifecycle/runs.ts";
import { answerDecision } from "../../src/lifecycle/decision-verbs.ts";
import { countersignOf } from "../../src/policy/countersign.ts";
import { gitRunner } from "../../src/policy/git.ts";
import type { HostVerdict } from "../../src/sched/host.ts";
import { inertDelivery } from "../../src/policy/services.ts";
import { batchMembers, batchRef, getBatch, liveBatch, type BatchRow } from "../../src/verify/batch-store.ts";
import { MAX_AUTO_RETRIES, RETRY_BACKOFF_MS } from "../../src/verify/batch-retry.ts";
import { pendingIntents } from "../../src/journal/journal.ts";
import { batchMax, landingBatched, landingMode, landingQueued, landingTrainDepth, lightVerifyConfig, MAX_BATCH, verifyConfig } from "../../src/verify/config.ts";
import { batchView, landingBoardLines } from "../../src/verify/landing-batch.ts";
import { landingCell, landingProgress, LandingQueue, liveLanding, type LandingRow } from "../../src/verify/landing-queue.ts";
import { verifyPolicyId } from "../../src/verify/policy.ts";
import { findQueued, getRequest, markStarted } from "../../src/verify/queue.ts";
import { admitRequest } from "../../src/verify/start.ts";
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
function ship(n: number, files: Record<string, string>, opts: { sensitive?: boolean; from?: string; task?: string } = {}): Ship {
  const task = opts.task ?? `t${n}`;
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
    db.query("INSERT OR IGNORE INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, sensitive, workflow, created_at) VALUES (?1, 'web', 'ship', 'local-only', 1, ?2, 'fix', 0)").run(task, opts.sensitive ? 1 : 0);
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
function queue(cfg = config(), host?: () => Promise<HostVerdict>): LandingQueue {
  const delivery = inertDelivery({ git, cleanup: async (runId) => {
    cleanups.push(runId);
    return { outcome: "cleaned" } as never;
  } });
  return new LandingQueue({ db, config: () => cfg, git, netGit: git, now: () => now, log: () => {}, kickScheduler: () => {}, delivery, ...(host ? { host } : {}) });
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

/** A step the runner killed at its deadline. */
const timedOut = (): VerifyStep[] => [{ name: "bun test", state: "failed", exit: 124, ms: 10, log: "x.log", tests: null, detail: null, attempts: 1, hangs: 1 }];

/** What a send-back tells the worker: its last stage's start note. */
const note = (s: Ship) => (db.query("SELECT stage_note FROM runs WHERE id = ?1").get(s.run) as { stage_note: string | null }).stage_note ?? "";
const runState = (s: Ship) => getRunWithPolicy(db, s.run)!.state;

describe("config", () => {
  test("batch needs verify steps and a local-only project; light_verify only with batch; a batch project queues, with no train", () => {
    expect(landingMode(config(), "web", "local-only")).toBe("batch");
    expect(landingMode(config(), "web", null)).toBe("batch");
    expect(() => landingMode(config(), "web", "direct-PR")).toThrow(/landing = "batch" is for local-only projects/);
    expect(() => verifyConfig(parseConfig(`[projects.web]\nlanding = "batch"\n`, dir), "web")).toThrow(/landing = "batch" needs verify steps/);
    expect(() => verifyConfig(parseConfig(`[projects.web]\nverify = ["x"]\nlight_verify = ["y"]\n`, dir), "web")).toThrow(/light_verify is the light check of landing = "batch"/);
    expect(() => verifyConfig(parseConfig(`[projects.web]\nverify = ["x"]\nlanding = "batch"\nlight_verify = [{ review = true }]\n`, dir), "web")).toThrow(/light_verify cannot hold the review step/);
    expect(landingQueued(config(), "web", "local-only")).toBe(true);
    expect(landingBatched(config(), "web", "local-only")).toBe(true);
    expect(landingQueued(config(), "web", "direct-PR")).toBe(false);
    expect(landingTrainDepth(config("landing_train_depth = 3\n"), "web", "local-only")).toBe(1);
    // The light check has its own policy; the full verify's is unchanged by it.
    expect(lightPolicy()).not.toBe(fullPolicy(config("", true)));
    expect(fullPolicy(config("", true))).toBe(fullPolicy(config()));
  });

  test("batch_max: an integer from 1 to 8, only with landing = \"batch\"; 8 when unset; shown in the effective config", () => {
    expect(batchMax(config(), "web")).toBe(MAX_BATCH);
    expect(batchMax(config("batch_max = 3\n"), "web")).toBe(3);
    expect(verifyConfig(config("batch_max = 1\n"), "web")).not.toBeNull();
    for (const bad of ["0", "9", "2.5", '"4"']) expect(() => verifyConfig(config(`batch_max = ${bad}\n`), "web")).toThrow(/batch_max must be an integer from 1 \(one branch per verify\) to 8/);
    expect(() => verifyConfig(parseConfig(`[projects.web]\nverify = ["x"]\nbatch_max = 2\n`, dir), "web")).toThrow(/batch_max is the batch size of landing = "batch"/);
    // An invalid table never throws here: the daemon refused it already.
    expect(batchMax(config("batch_max = 99\n"), "web")).toBe(MAX_BATCH);
    expect(effectiveConfig(config("batch_max = 2\n"), {}, { web: "local-only" })).toMatchObject({ sections: { projects: { web: { landing: "batch", batch_max: 2 } } } });
  });

  test("batch_max = 1 builds batches of one branch, in line order", async () => {
    const s1 = ship(1, { "one.txt": "one\n" });
    const s2 = ship(2, { "two.txt": "two\n" });
    const cfg = config("batch_max = 1\n");
    const lq = queue(cfg);
    await lq.pass();
    expect(batchMembers(db, batchOf().id).map((r) => r.task_id)).toEqual([s1.task]);
    verifyBatch("passed", [], cfg);
    await lq.pass();
    expect(batchMembers(db, batchOf().id).map((r) => r.task_id)).toEqual([s2.task]);
  });

  test("batch on a project that delivers PRs is refused where the project's mode is known: the effective config and project set", () => {
    expect(effectiveConfig(config(), {}, { web: "local-only" })).toMatchObject({ problems: [], sections: { projects: { web: { landing: "batch" } } } });
    const queueProject = parseConfig(`[projects.web]\nverify = ${JSON.stringify(STEPS)}\n`, dir);
    expect(effectiveConfig(queueProject, {}, { web: "local-only" }).sections.projects).toEqual(effectiveConfig(queueProject, {}).sections.projects);
    expect(effectiveConfig(config(), {}, { web: "direct-PR" }).problems).toEqual([expect.stringContaining(`landing = "batch" is for local-only projects; this one delivers direct-PR`)]);
    const projectSet = PROJECT_VERBS.find((v) => v.name === "project set")!;
    const ctx = { db, config: () => config() } as never;
    expect(() => tx(db, () => projectSet.apply!(ctx, { id: "web", mode: "direct-PR", "repo-url": "https://example.com/web.git" }, null))).toThrow(/landing = "batch" is for local-only projects/);
    expect(db.query("SELECT delivery_mode FROM projects WHERE id = 'web'").get()).toEqual({ delivery_mode: "local-only" });
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

  test("a migration number is only compared with members taken into the batch: one that waits for a conflict sends nobody back", async () => {
    const s1 = ship(1, { "same.txt": "one\n" });
    const s2 = ship(2, { "same.txt": "two\n", "db/migrations/000042_users.up.sql": "a\n" });
    const s3 = ship(3, { "db/migrations/000042_orders.up.sql": "b\n" });
    const lq = queue();
    await lq.pass();
    expect(batchMembers(db, batchOf().id).map((r) => r.task_id)).toEqual([s1.task, s3.task]);
    expect(row(s2)).toMatchObject({ state: "waiting", batch_id: null });
    expect(row(s3).state).toBe("landing");
    expect(runState(s3)).toBe("ready");
    expect(events("landing.batch_clash")).toEqual([]);
  });
});

describe("split on red (docs/notes/2026-11-21-landing-batches-one-27.md \"Split and retry\")", () => {
  const BAD_LOG = "--- FAIL: TestBudget (0.00s)\n    budget_test.go:9: over budget\nFAIL\texample.com/app/pkg/budget\t0.01s\n";
  const basePolicy = () => fullPolicy();
  const queuedBaseline = () => db.query("SELECT * FROM verify_queue WHERE pr_url LIKE 'base:%' AND state = 'queued'").get() as { pr_url: string; head_sha: string } | null;

  /**
   * Play the verify runner until the line is empty: each batch head fails when it holds a branch in
   * `bad`, and each baseline of main fails when `mainRed`. Returns the members of each batch verified, in order.
   */
  async function bisect(lq: LandingQueue, bad: Set<string>, opts: { mainRed?: boolean } = {}): Promise<string[][]> {
    const verified: string[][] = [];
    for (let i = 0; i < 40; i++) {
      const base = queuedBaseline();
      if (base) runVerify(base.pr_url, base.head_sha, basePolicy(), opts.mainRed ? "failed" : "passed", opts.mainRed ? failedStep("bun test", "FAIL\texample.com/app/pkg/main\t0.01s\n") : []);
      else {
        const b = liveBatch(db, "web");
        if (b && b.state !== "verifying") break;
        if (b && findQueued(db, batchRef("web", b.id), b.head_sha, fullPolicy())) {
          const members = batchMembers(db, b.id).map((r) => r.task_id);
          verified.push(members);
          verifyBatch(members.some((t) => bad.has(t)) ? "failed" : "passed", members.some((t) => bad.has(t)) ? failedStep("bun test", BAD_LOG) : []);
        } else if (!b && !db.query("SELECT 1 FROM landing_queue WHERE project_id = 'web' AND state = 'waiting'").get()) break;
      }
      await lq.pass();
    }
    return verified;
  }

  const ships = (n: number) => Array.from({ length: n }, (_, i) => ship(i + 1, { [`f${i + 1}.txt`]: `${i + 1}\n` }));
  const openHeld = () => db.query("SELECT kind, task_id FROM items WHERE kind IN ('landing_batch_held','auto_merge_held') AND state = 'open'").all() as { kind: string; task_id: string }[];

  test("one bad branch of eight: seven verifies, the green halves land on the way, the bad one goes back with its step and log, nobody is asked", async () => {
    const all = ships(8);
    const lq = queue();
    await lq.pass();
    const verified = await bisect(lq, new Set(["t6"]));

    expect(verified).toEqual([["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"], ["t1", "t2", "t3", "t4"], ["t5", "t6", "t7", "t8"], ["t5", "t6"], ["t5"], ["t6"], ["t7", "t8"]]);
    expect(all.map((s) => runState(s))).toEqual(["landed", "landed", "landed", "landed", "landed", "running", "landed", "landed"]);
    expect(row(all[5]!)).toMatchObject({ state: "left", reason: "culprit" });
    expect(note(all[5]!)).toContain("Landing batch: the daemon's flowryn verify");
    expect(note(all[5]!)).toContain("again with your branch alone merged onto main");
    expect(note(all[5]!)).toContain("budget_test.go:9: over budget");
    expect(events("landing.batch_split")).toHaveLength(3);
    expect(events("landing.batch_split")[0]).toMatchObject({ cause: "red", first: ["t1", "t2", "t3", "t4"], rest: ["t5", "t6", "t7", "t8"] });
    expect(events("landing.batch_sent_back")).toEqual([expect.objectContaining({ landing: row(all[5]!).id, step: "bun test" })]);
    expect(events("verify.sent_back")).toEqual([expect.objectContaining({ landing: row(all[5]!).id, step: "bun test" })]);
    // main had a green verify at its tip since the split began (t5's batch): no baseline was needed.
    expect(events("landing.batch_baseline")).toEqual([]);
    expect(openHeld()).toEqual([]);
    // Each landed branch has its own merge record; the bad one's code never reached main.
    expect((db.query("SELECT task_id FROM merges ORDER BY requested_at, rowid").all() as { task_id: string }[]).map((m) => m.task_id)).toEqual(["t1", "t2", "t3", "t4", "t5", "t7", "t8"]);
    expect(sh(primary, ["ls-tree", "--name-only", "main"]).split("\n")).not.toContain("f6.txt");
    for (const s of all) expect(sh(s.wt, ["rev-parse", "HEAD"])).toBe(s.head);
  });

  test("two bad branches: both go back to their workers, the other six land, nothing is held", async () => {
    const all = ships(8);
    const lq = queue();
    await lq.pass();
    await bisect(lq, new Set(["t2", "t7"]));
    expect(all.map((s) => runState(s))).toEqual(["landed", "running", "landed", "landed", "landed", "landed", "running", "landed"]);
    expect([row(all[1]!).reason, row(all[6]!).reason]).toEqual(["culprit", "culprit"]);
    expect(openHeld()).toEqual([]);
  });

  test("all bad: one baseline of main (nothing landed since the split began), then every branch goes back", async () => {
    const all = ships(4);
    const lq = queue();
    await lq.pass();
    const verified = await bisect(lq, new Set(["t1", "t2", "t3", "t4"]));
    expect(verified).toEqual([["t1", "t2", "t3", "t4"], ["t1", "t2"], ["t1"], ["t2"], ["t3", "t4"], ["t3"], ["t4"]]);
    expect(all.map((s) => runState(s))).toEqual(["running", "running", "running", "running"]);
    expect(events("landing.batch_baseline")).toHaveLength(1);
    expect(openHeld()).toEqual([]);
  });

  test("main itself red: the lone branch is not sent back; the batch is held for the leader with main's verify", async () => {
    const all = ships(2);
    const lq = queue();
    await lq.pass();
    await bisect(lq, new Set(["t1", "t2"]), { mainRed: true });
    const held = batchOf();
    expect(held).toMatchObject({ state: "held", reason: "main_red" });
    expect(held.detail).toContain(`main ${mainTip().slice(0, 8)} itself fails at \`bun test\``);
    expect(batchMembers(db, held.id).map((r) => r.task_id)).toEqual(["t1"]);
    expect(all.map((s) => runState(s))).toEqual(["ready", "ready"]);
    const item = db.query("SELECT line FROM items WHERE kind = 'landing_batch_held' AND state = 'open'").get() as { line: string };
    expect(item.line).toContain(`flowryn batch retry ${held.id}`);
    // The leader's retry: a new batch of t1 on main as it is, with t2 next on the stack.
    tx(db, () => lq.batches.retry(held.id));
    await lq.pass();
    expect(batchMembers(db, batchOf().id).map((r) => r.task_id)).toEqual(["t1"]);
  });

  test("a timeout is retried by itself after 5 minutes, and a pass then lands the whole batch", async () => {
    const all = ships(3);
    const lq = queue();
    await lq.pass();
    const b = batchOf();
    const red = verifyBatch("failed", timedOut());
    await lq.pass();
    const waiting = getBatch(db, b.id)!;
    expect(waiting).toMatchObject({ state: "verifying", auto_retries: 1, request_id: null, verification_id: red.id, retry_at: now + RETRY_BACKOFF_MS[0] });
    expect(waiting.detail).toBe(`verify ${red.id} failed (timeout); retry 1 of 2 in 5 min`);
    expect(events("landing.batch_auto_retry")).toEqual([expect.objectContaining({ batch: b.id, attempt: 1, cause: "timeout", of: red.id, at: now + RETRY_BACKOFF_MS[0] })]);
    expect(landingProgress(db, row(all[0]!))).toContain(`retry 1 of 2 in 5 min`);
    // Not before its backoff.
    now += RETRY_BACKOFF_MS[0] - 1;
    await lq.pass();
    expect(findQueued(db, batchRef("web", b.id), b.head_sha, fullPolicy())).toBeNull();
    now += 1;
    await lq.pass();
    expect(getBatch(db, b.id)).toMatchObject({ retry_at: null });
    expect(findQueued(db, batchRef("web", b.id), b.head_sha, fullPolicy())).not.toBeNull();
    verifyBatch("passed");
    await lq.pass();
    expect(all.map((s) => runState(s))).toEqual(["landed", "landed", "landed"]);
    expect(events("landing.batch_split")).toEqual([]);
  });

  test("assumption: load counts only while the host check refused on load during the verify, or when the red is judged", async () => {
    const blocked = (ts: number, reason = "load 2.10 per core, over 1.5") => tx(db, () => appendEvent(db, { source: "daemon", kind: "sched.host_blocked", payload: { ok: false, reason }, ts }));
    const hostOk = (ts: number) => tx(db, () => appendEvent(db, { source: "daemon", kind: "sched.host_ok", payload: { ok: true, reason: "ok" }, ts }));
    ships(2);
    // Blocked on load before the verify, cleared before it started: a plain red, so the batch splits.
    blocked(now - 20);
    hostOk(now - 10);
    let lq = queue();
    await lq.pass();
    let b = batchOf();
    verifyBatch("failed", failedStep("bun test", BAD_LOG));
    await lq.pass();
    expect(getBatch(db, b.id)).toMatchObject({ state: "dissolved", reason: "split" });

    // Blocked on load while it ran: retried.
    b = batchOf();
    const v = runVerify(batchRef("web", b.id), b.head_sha, fullPolicy(), "failed", failedStep("bun test", BAD_LOG));
    blocked(v.started_at + 1);
    await lq.pass();
    expect(getBatch(db, b.id)).toMatchObject({ state: "verifying", auto_retries: 1 });
    expect(events("landing.batch_auto_retry").at(-1)).toMatchObject({ cause: "load" });

    // Memory, not load, does not count; a host check refusing on load as the red is judged does.
    hostOk(now);
    now += RETRY_BACKOFF_MS[0];
    lq = queue(config(), async () => ({ ok: false, sample: null, reason: "load 3.00 per core, over 1.5" }));
    await lq.pass();
    b = batchOf();
    blocked(now + 1, "2.0 GB available, under 8 GB");
    verifyBatch("failed", failedStep("bun test", BAD_LOG));
    await lq.pass();
    expect(getBatch(db, b.id)).toMatchObject({ state: "verifying", auto_retries: 2 });
    expect(events("landing.batch_auto_retry").at(-1)).toMatchObject({ cause: "load", attempt: 2 });
  });

  test("retries used up: a batch of two splits; a lone branch still timing out leaves the line held for the leader, and the next half goes on", async () => {
    const [s1, s2] = ships(2);
    const lq = queue();
    await lq.pass();
    const timeoutUntilSettled = async () => {
      const b = batchOf();
      for (let attempt = 0; attempt <= MAX_AUTO_RETRIES; attempt++) {
        verifyBatch("failed", timedOut());
        await lq.pass();
        now += 15 * 60_000;
        await lq.pass();
      }
      return b;
    };
    const pair = await timeoutUntilSettled();
    expect(getBatch(db, pair.id)).toMatchObject({ state: "dissolved", reason: "split", auto_retries: MAX_AUTO_RETRIES });
    expect(events("landing.batch_split")).toEqual([expect.objectContaining({ cause: "timeout", first: [s1!.task], rest: [s2!.task] })]);
    const lone = await timeoutUntilSettled();
    expect(getBatch(db, lone.id)).toMatchObject({ state: "dissolved", reason: "held_member" });
    expect(row(s1!)).toMatchObject({ state: "left", reason: "held:verify_timeout" });
    expect(runState(s1!)).toBe("ready");
    expect(openHeld()).toEqual([{ kind: "auto_merge_held", task_id: s1!.task }]);
    expect(events("landing.batch_member_held")).toEqual([expect.objectContaining({ batch: lone.id, code: "verify_timeout" })]);
    // The rest go on: s2 is the next batch.
    expect(batchMembers(db, batchOf().id).map((r) => r.task_id)).toEqual([s2!.task]);
    verifyBatch("passed");
    await lq.pass();
    expect(runState(s2!)).toBe("landed");
  });

  test("nothing joins a batch while the split stack has halves: a branch delivered during a split lands after it", async () => {
    ships(4);
    const lq = queue();
    await lq.pass();
    verifyBatch("failed", failedStep("bun test", BAD_LOG));
    await lq.pass();
    const late = ship(9, { "late.txt": "late\n" });
    await lq.pass();
    expect(batchMembers(db, batchOf().id).map((r) => r.task_id)).toEqual(["t1", "t2"]);
    verifyBatch("passed");
    await lq.pass();
    expect(batchMembers(db, batchOf().id).map((r) => r.task_id)).toEqual(["t3", "t4"]);
    expect(batchView(db, batchOf())).toMatchObject({ split_rest: [] });
    verifyBatch("passed");
    await lq.pass();
    expect(batchMembers(db, batchOf().id).map((r) => r.task_id)).toEqual([late.task]);
  });

  test("a split stack survives a rebuild and a member that left; switching batching off clears it", async () => {
    ships(4);
    const lq = queue();
    await lq.pass();
    verifyBatch("failed", failedStep("bun test", BAD_LOG));
    await lq.pass();
    const first = batchOf();
    expect(batchView(db, first)).toMatchObject({ split_rest: [["t3", "t4"]] });
    // main moves by hand: rebuilt, the stack carried.
    writeFileSync(join(primary, "hand.txt"), "x\n");
    sh(primary, ["add", "."]);
    sh(primary, ["commit", "-q", "-m", "by hand"]);
    await lq.pass();
    const rebuilt = batchOf();
    expect(rebuilt.id).not.toBe(first.id);
    expect(batchView(db, rebuilt)).toMatchObject({ split_rest: [["t3", "t4"]] });
    // Batching off: dissolved, the stack cleared.
    await queue(parseConfig(`[projects.web]\nverify = ${JSON.stringify(STEPS)}\nlanding = "queue"\n`, dir)).pass();
    expect(getBatch(db, rebuilt.id)).toMatchObject({ state: "dissolved", reason: "batching_off", split_rest: null });
  });

  test("the leader's drop works on a verifying batch: its queued verify is cancelled and the rest are rebuilt; retry has no once-per-head limit", async () => {
    const [s1, s2] = ships(2);
    const lq = queue();
    await lq.pass();
    const b = batchOf();
    const request = b.request_id!;
    tx(db, () => lq.batches.drop(b.id, s1!.task));
    expect(getRequest(db, request)).toMatchObject({ state: "cancelled" });
    expect(note(s1!)).toContain(`Your leader dropped your branch from landing batch ${b.id} (verifying)`);
    expect(note(s1!)).toContain("No verify failed on it.");
    await lq.pass();
    expect(batchMembers(db, batchOf().id).map((r) => r.task_id)).toEqual([s2!.task]);
    expect(() => tx(db, () => lq.batches.retry(batchOf().id))).toThrow(/only a held batch is retried/);
    for (let i = 0; i < 2; i++) {
      tx(db, () => db.query("UPDATE landing_batches SET state = 'held', reason = 'verify_cancelled' WHERE id = ?1").run(batchOf().id));
      tx(db, () => lq.batches.retry(batchOf().id));
      await lq.pass();
      expect(batchOf().state).toBe("verifying");
    }
  });

  test("a batch row left fixing by an older daemon is dissolved: its fix task is dropped, its branches form a new batch", async () => {
    const [s1] = ships(1);
    const lq = queue();
    await lq.pass();
    const b = batchOf();
    tx(db, () => db.query("UPDATE landing_batches SET state = 'fixing', fix_task = 'fix-landing-batch-old', fix_state = 'open', fix_base = head_sha WHERE id = ?1").run(b.id));
    await lq.pass();
    expect(getBatch(db, b.id)).toMatchObject({ state: "dissolved", reason: "rebuilt", fix_state: "ended" });
    expect(db.query("SELECT task_id, dropped_by FROM drops").all()).toEqual([{ task_id: "fix-landing-batch-old", dropped_by: "daemon" }]);
    await lq.pass();
    expect(batchMembers(db, batchOf().id).map((r) => r.task_id)).toEqual([s1!.task]);
  });
});

describe("a gate loosening in a batch", () => {
  /** Two routine branches (fix workflow), the second raising a budget; the batch's verify green. */
  async function loosened(files: Record<string, string>): Promise<{ lq: LandingQueue; b: BatchRow; s1: Ship; s2: Ship; v: Verification }> {
    mkdirSync(join(primary, "ui", "tests"), { recursive: true });
    writeFileSync(join(primary, "ui", "tests", "budget.json"), '{ "brief": 228 }\n');
    sh(primary, ["add", "."]);
    sh(primary, ["commit", "-q", "-m", "budget"]);
    const s1 = ship(1, { "pkg/store/store.go": "package store\n" });
    const s2 = ship(2, files);
    const lq = queue();
    await lq.pass();
    const b = batchOf();
    const v = verifyBatch("passed");
    await lq.pass();
    return { lq, b, s1, s2, v };
  }

  test("a member that raises a budget holds the green batch as loosened_gate with a countersign decision; the leader's countersign lands it", async () => {
    const { lq, b, s1, s2, v } = await loosened({ "ui/tests/budget.json": '{ "brief": 229 }\n' });
    const held = getBatch(db, b.id)!;
    expect(held).toMatchObject({ state: "held", reason: "loosened_gate", culprit: s2.task, verification_id: v.id });
    expect(mainTip()).toBe(b.base_sha);
    const decision = countersignOf(db, s2.task, s2.head)!;
    expect(held.detail).toBe(`${s2.task} loosens a gate; ${decision.id} asks the countersign`);
    expect(decision.context).toContain("ui/tests/budget.json: raised 228 → 229");
    const item = db.query("SELECT line FROM items WHERE kind = 'landing_batch_held' AND state = 'open'").get() as { line: string };
    expect(item.line).toContain(`Next: flowryn decide ${decision.id} countersign | flowryn batch drop ${b.id} ${s2.task}`);
    await lq.pass();
    expect(db.query("SELECT COUNT(*) AS n FROM decisions WHERE origin = 'countersign'").get()).toEqual({ n: 1 });

    tx(db, () => answerDecision({ db, now: () => now }, decision, { choice: "countersign", words: "the brief screen grew by one icon", by: "leader", via: "cli" }));
    await lq.pass();
    expect(getBatch(db, b.id)!.state).toBe("landed");
    expect([runState(s1), runState(s2)]).toEqual(["landed", "landed"]);
    expect(events("landing.batch_countersigned")).toEqual([expect.objectContaining({ batch: b.id, from: "held" })]);
  });

  test("dropping the member of a batch held for a countersign dismisses its open decision; the rest are rebuilt", async () => {
    const { lq, b, s1, s2 } = await loosened({ "pkg/store/store_test.go": `package store\n\nfunc TestSave(t *testing.T) { t.Skip${"("}"later") }\n` });
    const decision = countersignOf(db, s2.task, s2.head)!;
    expect(getBatch(db, b.id)).toMatchObject({ state: "held", reason: "loosened_gate" });
    expect(decision.context).toContain("adds a test skip");

    tx(db, () => lq.batches.drop(b.id, s2.task));
    expect(countersignOf(db, s2.task, s2.head)).toMatchObject({ state: "dismissed" });
    expect(events("decision.dismissed")).toEqual([expect.objectContaining({ decision: decision.id, origin: "countersign", task: s2.task })]);
    await lq.pass();
    expect(batchMembers(db, batchOf().id).map((r) => r.task_id)).toEqual([s1.task]);
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
    const held = batchOf();
    expect(held).toMatchObject({ state: "held", reason: "base_moving" });
    const item = db.query("SELECT line, task_id FROM items WHERE kind = 'landing_batch_held' AND state = 'open'").get() as { line: string; task_id: string };
    expect(item.task_id).toBe(s1.task);
    expect(item.line).toEndWith(`Next: flowryn batch retry ${held.id}`);

    // retry on a batch main moved under: a new batch of the same branches on main as it is, counted afresh.
    tx(db, () => lq.batches.retry(held.id));
    expect(getBatch(db, held.id)).toMatchObject({ state: "dissolved", reason: "retried" });
    expect(row(s1)).toMatchObject({ state: "waiting", batch_id: null });
    expect(runState(s1)).toBe("ready");
    await lq.pass();
    const rebuilt = batchOf();
    expect(rebuilt).toMatchObject({ state: "verifying", base_sha: mainTip(), integrations: 0 });
    expect(batchMembers(db, rebuilt.id).map((r) => r.task_id)).toEqual([s1.task]);
    verifyBatch("passed");
    await lq.pass();
    expect(runState(s1)).toBe("landed");
  });

  test("dropping a branch from a batch held for main moving does not tell its worker a verify failed", async () => {
    const s1 = ship(1, { "one.txt": "one\n" });
    ship(2, { "two.txt": "two\n" });
    const lq = queue();
    await lq.pass();
    for (let i = 1; i <= 4; i++) {
      writeFileSync(join(primary, `hand${i}.txt`), "x\n");
      sh(primary, ["add", "."]);
      sh(primary, ["commit", "-q", "-m", `by hand ${i}`]);
      await lq.pass();
    }
    const held = batchOf();
    expect(held).toMatchObject({ state: "held", reason: "base_moving" });
    tx(db, () => lq.batches.drop(held.id, s1.task));
    expect(note(s1)).toContain(`Your leader dropped your branch from landing batch ${held.id} (held, base_moving)`);
    expect(note(s1)).not.toContain("failed its verify");
  });

  test("a member that leaves a green batch before main takes it: the batch is rebuilt without it, and main never holds its code", async () => {
    const s1 = ship(1, { "one.txt": "one\n" });
    const s2 = ship(2, { "two.txt": "two\n" });
    const lq = queue();
    await lq.pass();
    const b = batchOf();
    verifyBatch("passed");
    // Played: the batch went green and is landing, but could not land yet; then s2's worker was sent back.
    tx(db, () => db.query("UPDATE landing_batches SET state = 'landing' WHERE id = ?1").run(b.id));
    tx(db, () => db.query("UPDATE runs SET state = 'running' WHERE id = ?1").run(s2.run));
    await lq.pass();
    expect(row(s2)).toMatchObject({ state: "left", reason: "sent_back" });
    expect(mainTip()).not.toBe(b.head_sha);
    expect((await git(["merge-base", "--is-ancestor", s2.head, "refs/heads/main"], primary)).code).not.toBe(0);
    expect(getBatch(db, b.id)).toMatchObject({ state: "dissolved", reason: "rebuilt" });
    expect(batchMembers(db, batchOf().id).map((r) => r.task_id)).toEqual([s1.task]);
    expect(db.query("SELECT COUNT(*) AS n FROM merges").get()).toEqual({ n: 0 });
  });

  test("a member that leaves after main took the batch: the rest are recorded, and the leader gets an item naming it", async () => {
    const s1 = ship(1, { "one.txt": "one\n" });
    const s2 = ship(2, { "two.txt": "two\n" });
    const lq = queue();
    await lq.pass();
    const b = batchOf();
    verifyBatch("passed");
    // Played: main fast-forwarded to the batch, the daemon stopped, then s2's worker was sent back.
    tx(db, () => db.query("UPDATE landing_batches SET state = 'landing' WHERE id = ?1").run(b.id));
    sh(primary, ["merge", "-q", "--ff-only", b.head_sha]);
    tx(db, () => db.query("UPDATE runs SET state = 'running' WHERE id = ?1").run(s2.run));
    await lq.pass();
    expect(runState(s1)).toBe("landed");
    expect(getBatch(db, b.id)!.state).toBe("landed");
    expect(db.query("SELECT task_id FROM merges").all()).toEqual([{ task_id: s1.task }]);
    const items = db.query("SELECT line, task_id FROM items WHERE kind = 'landing_batch_held' AND state = 'open'").all() as { line: string; task_id: string }[];
    expect(items).toEqual([expect.objectContaining({ task_id: s2.task })]);
    expect(items[0]!.line).toContain("on main without a merge record");
    await lq.pass();
    expect(db.query("SELECT COUNT(*) AS n FROM items WHERE kind = 'landing_batch_held'").get()).toEqual({ n: 1 });
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
    expect(landingProgress(db, row(s1))).not.toContain("batch");
    expect(landingCell(db, row(s1))).not.toContain("batch");
    expect(landingBoardLines(db)).toEqual([]);
  });
});

describe("a flaky batch (docs/notes/2026-11-22-phase-flake-earns-a3.md)", () => {
  const STORE_LOG = "--- FAIL: TestSave (0.00s)\n    store_test.go:12: wrong\nFAIL\texample.com/app/pkg/store\t0.01s\n";
  const TEST = "example.com/app/pkg/store TestSave";
  const COMMAND = "go test -count=1 example.com/app/pkg/store";
  const flaky = () => parseConfig(`[projects.web]\nverify = [{ run = "bun test", rerun_failed = "go test -count=1 {failed}" }]\nlanding = "batch"\n`, dir);

  /** Two routine branches in one batch on the flaky config, its verify red at `bun test`, and the pass that judges it. */
  async function redBatch(log = STORE_LOG): Promise<{ lq: LandingQueue; b: BatchRow; s1: Ship; s2: Ship; red: Verification; cfg: FlowrynConfig }> {
    const cfg = flaky();
    const s1 = ship(1, { "pkg/store/store.go": "package store\n" });
    const s2 = ship(2, { "pkg/web/web.go": "package web\n" });
    const lq = queue(cfg);
    await lq.pass();
    const b = batchOf();
    const red = verifyBatch("failed", failedStep("bun test", log), cfg);
    await lq.pass();
    return { lq, b, s1, s2, red, cfg };
  }

  /** The verify runner's admission of the batch's request: the steps it runs. */
  const admitted = (cfg: FlowrynConfig) => tx(db, () => admitRequest(db, getRequest(db, batchOf().request_id!)!, verifyConfig(cfg, "web")!, { validation: 5 }, join(dir, "v"), primary, now));
  const finish = (v: Verification, state: "passed" | "failed", steps: VerifyStep[]) => tx(db, () => finishVerification(db, v, { state, steps, tests: null, detail: null, binary: null }, now + 1));
  const flakyRows = () => db.query("SELECT test, target, flakes, last_verification, task_id FROM flaky_tests ORDER BY test").all();

  test("failing tests that pass 3 of 3 alone at the same head land the batch, record the flake and file one fix task", async () => {
    const { lq, b, s1, s2, red, cfg } = await redBatch();
    // rerun_failed never changes the policy: the batch's pass counts under the same one.
    expect(fullPolicy(cfg)).toBe(fullPolicy());
    const rerunning = getBatch(db, b.id)!;
    expect(rerunning).toMatchObject({ state: "verifying", fix_task: null, verification_id: red.id });
    expect(rerunning.detail).toContain(`verify ${red.id} failed at \`bun test\`; rerunning its 1 failing test alone, 3 times`);
    expect(events("verify.flake_rerun")).toEqual([expect.objectContaining({ batch: b.id, head: b.head_sha, of: red.id, step: "bun test", command: COMMAND, targets: ["example.com/app/pkg/store"], tests: [TEST], passes: 3, request: rerunning.request_id })]);
    expect(getRequest(db, rerunning.request_id!)).toMatchObject({ state: "queued", head_sha: b.head_sha, policy_id: fullPolicy() });
    expect(db.query("SELECT COUNT(*) AS n FROM plans").get()).toEqual({ n: 0 });
    expect(batchView(db, rerunning)).toMatchObject({ flake: { state: "pending", of: red.id, tests: [TEST] } });

    // The runner runs the failed step's failing tests only, 3 times; the rest as configured.
    const rerun = admitted(cfg);
    expect(rerun.steps[0]).toMatchObject({ name: "bun test", rerun: { of: red.id, command: COMMAND, passes: 3, tests: [TEST] } });
    finish(rerun, "passed", [{ ...rerun.steps[0]!, state: "passed", exit: 0, ms: 5 }]);
    await lq.pass();

    expect(getBatch(db, b.id)!.state).toBe("landed");
    expect(mainTip()).toBe(b.head_sha);
    expect([runState(s1), runState(s2)]).toEqual(["landed", "landed"]);
    const [flake] = events("verify.flake");
    expect(flake).toMatchObject({ batch: b.id, project: "web", head: b.head_sha, of: red.id, rerun: rerun.id, step: "bun test", command: COMMAND, passes: 3, tests: [TEST], rerun_passed: true, ticketed: [] });
    const task = flake!.task as string;
    expect(flakyRows()).toEqual([{ test: TEST, target: "example.com/app/pkg/store", flakes: 1, last_verification: red.id, task_id: task }]);
    // One non-blocking fix task, through the plan-phase path, its brief naming the test and the failing run.
    expect(db.query("SELECT state, filed_by FROM plans").all()).toEqual([{ state: "approved", filed_by: `daemon (flaky tests in landing batch ${b.id})` }]);
    const phase = db.query("SELECT title, body FROM plan_phases WHERE task_id = ?1").get(task) as { title: string; body: string };
    expect(phase.title).toBe(`Fix flaky ${TEST}`);
    expect(phase.body).toContain(`- ${TEST}`);
    expect(phase.body).toContain(`\`${COMMAND}\``);
    expect(phase.body).toContain("Never add a retry, a skip or a longer timeout");
    expect(phase.body).toContain("```\n--- FAIL: TestSave (0.00s)");
    expect(pendingIntents(db, "backlog").filter((i) => i.task_id === task).map((i) => i.verb)).toEqual(["add"]);
    // The briefing says so once.
    const brief = () => composeBriefing(db, { session: null, now: now + 10, morningHour: 99, ageMs: 60_000, markMorning: false }).text;
    expect(brief()).toContain(`Flake `);
    expect(brief()).toContain(`landing batch ${b.id} (web): ${TEST} passed 3 of 3 alone; its rerun verify ${rerun.id} passed; fix task ${task}.`);
    expect(phase.body).toContain(`(verify ${rerun.id}), and that verify passed.`);
  });

  test("a rerun that fails splits the batch as before, with nothing recorded as flaky; no second rerun at that head", async () => {
    const { lq, b, s1, red, cfg } = await redBatch();
    const rerun = admitted(cfg);
    finish(rerun, "failed", [{ ...failedStep("bun test", STORE_LOG)[0]!, rerun: rerun.steps[0]!.rerun! }]);
    await lq.pass();

    expect(getBatch(db, b.id)).toMatchObject({ state: "dissolved", reason: "split" });
    expect(events("landing.batch_split")).toEqual([expect.objectContaining({ batch: b.id, of: rerun.id, cause: "red", first: [s1.task] })]);
    expect(events("verify.flake_rerun_failed")).toEqual([expect.objectContaining({ batch: b.id, of: red.id, rerun: rerun.id, ran: true })]);
    expect(events("verify.flake")).toEqual([]);
    expect(flakyRows()).toEqual([]);
    expect(events("verify.flake_rerun")).toHaveLength(1);
    const briefing = composeBriefing(db, { session: null, now: now + 10, morningHour: 99, ageMs: 60_000, markMorning: false }).text;
    expect(briefing).toContain(`landing batch ${b.id} (web): its failing tests failed again alone (${rerun.id}).`);
  });

  test.each(["waiting", "stopped"] as const)("a rerun step left %s (an earlier step or a group sibling failed) ends the rerun, and the briefing says the tests never ran", async (left) => {
    const { lq, b, red, cfg } = await redBatch();
    const rerun = admitted(cfg);
    finish(rerun, "failed", [{ ...rerun.steps[0]!, state: left }]);
    await lq.pass();

    expect(events("verify.flake_rerun_failed")).toEqual([expect.objectContaining({ batch: b.id, of: red.id, rerun: rerun.id, ran: false })]);
    expect(batchView(db, getBatch(db, b.id)!)).toMatchObject({ flake: { state: "ended", rerun: rerun.id } });
    expect(events("verify.flake")).toEqual([]);
    const briefing = composeBriefing(db, { session: null, now: now + 10, morningHour: 99, ageMs: 60_000, markMorning: false }).text;
    expect(briefing).toContain(`landing batch ${b.id} (web): its rerun ${rerun.id} ended before its failing tests ran.`);
    expect(briefing).not.toContain("failed again alone");
  });

  test("failing tests that pass 3 of 3 while the rerun verify still fails record the flake, but never say the batch landed", async () => {
    const { lq, b, cfg } = await redBatch();
    const rerun = admitted(cfg);
    finish(rerun, "failed", [{ ...rerun.steps[0]!, state: "passed", exit: 0, ms: 5 }]);
    await lq.pass();

    expect(getBatch(db, b.id)!.state).not.toBe("landed");
    const [flake] = events("verify.flake");
    expect(flake).toMatchObject({ batch: b.id, rerun: rerun.id, tests: [TEST], rerun_passed: false });
    const task = flake!.task as string;
    const phase = db.query("SELECT body FROM plan_phases WHERE task_id = ?1").get(task) as { body: string };
    expect(phase.body).toContain(`(verify ${rerun.id}), but a later step of that verify failed.`);
    expect(phase.body).not.toContain("batch landed");
    const briefing = composeBriefing(db, { session: null, now: now + 10, morningHour: 99, ageMs: 60_000, markMorning: false }).text;
    expect(briefing).toContain(`landing batch ${b.id} (web): ${TEST} passed 3 of 3 alone; its rerun verify ${rerun.id} failed at a later step; fix task ${task}.`);
    expect(briefing).not.toContain(`landing batch ${b.id} (web) landed`);
  });

  test("the weekly rule: a test that flaked this week earns another rerun only while its fix task is open; one fix task per test per week", async () => {
    // Flaked two days ago with no fix task: no rerun, split, and the refusal says why.
    tx(db, () => db.query("INSERT INTO flaky_tests (project_id, test, target, flakes, first_seen, last_seen, last_verification) VALUES ('web', ?1, 'example.com/app/pkg/store', 1, ?2, ?2, 'v0')").run(TEST, now - 2 * 86_400_000));
    const { b } = await redBatch();
    expect(getBatch(db, b.id)).toMatchObject({ state: "dissolved", reason: "split" });
    expect(events("verify.flake_rerun")).toEqual([]);
    expect(events("verify.flake_refused")).toEqual([expect.objectContaining({ batch: b.id, tests: [TEST], why: expect.stringContaining(`${TEST} already flaked within the week (2 days ago, v0) and has no fix task`) })]);
  });

  test("an open fix task keeps the rerun and files no second task; a log naming no tests earns none", async () => {
    tx(db, () => db.query("INSERT INTO flaky_tests (project_id, test, target, flakes, first_seen, last_seen, last_verification, task_id, task_filed_at) VALUES ('web', ?1, 'example.com/app/pkg/store', 1, ?2, ?2, 'v0', 'fix-flaky-open', ?2)").run(TEST, now - 86_400_000));
    const { lq, b, cfg } = await redBatch();
    const rerun = admitted(cfg);
    finish(rerun, "passed", [{ ...rerun.steps[0]!, state: "passed", exit: 0, ms: 5 }]);
    await lq.pass();
    expect(getBatch(db, b.id)!.state).toBe("landed");
    expect(events("verify.flake")).toEqual([expect.objectContaining({ task: null, ticketed: [TEST] })]);
    expect(db.query("SELECT COUNT(*) AS n FROM plans").get()).toEqual({ n: 0 });
    expect(flakyRows()).toEqual([expect.objectContaining({ test: TEST, flakes: 2, task_id: "fix-flaky-open" })]);
  });

  test("a red whose log names no failing test it can rerun alone is split, with the refusal recorded", async () => {
    const { b } = await redBatch("error: cannot connect to the database\n");
    expect(getBatch(db, b.id)).toMatchObject({ state: "dissolved", reason: "split" });
    expect(events("verify.flake_refused")).toEqual([expect.objectContaining({ batch: b.id, tests: [], why: expect.stringContaining("names no failing tests") })]);
  });
});
