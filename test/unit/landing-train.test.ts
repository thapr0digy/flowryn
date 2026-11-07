import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openItem } from "../../src/attention/items.ts";
import { parseConfig, type FlowrynConfig } from "../../src/config/config.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { deliveredOf, prEvidenceFrom, recordPrEvidence } from "../../src/lifecycle/delivery.ts";
import { getRunWithPolicy, type RunWithPolicy } from "../../src/lifecycle/runs.ts";
import { gitRunner } from "../../src/policy/git.ts";
import { getAutoMerge, liveAutoMerge } from "../../src/verify/auto-merge.ts";
import { DEFAULT_TRAIN_DEPTH, landingTrainDepth, verifyConfig } from "../../src/verify/config.ts";
import { getLanding, LandingQueue, liveLanding, TRAIN_RANK, trainBaseHolds, type LandingRow } from "../../src/verify/landing-queue.ts";
import { verifyPolicyId } from "../../src/verify/policy.ts";
import { getRequest } from "../../src/verify/queue.ts";
import { finishVerification, insertVerification } from "../../src/verify/store.ts";
import { GIT_ENV, mergeOnOrigin, scratchRepos, sh } from "../helpers/scratch-git.ts";

/**
 * The landing train (docs/notes/2026-11-07-faster-landing-test-q7.md), with real git against
 * scratch repositories: while the head of line verifies, the entries behind it verify on
 * candidates built on the head ahead of them; a candidate lands, pushed as a fast-forward, only
 * when git proves main holds exactly its base; a base that changes re-bases the ones behind.
 * GitHub's squash merge is played by the other clone (`merge --squash`, push).
 */

const STEPS = ["bun test"];
const QUEUE = `[projects.web]\nverify = ${JSON.stringify(STEPS)}\nlanding = "queue"\n`;
const git = gitRunner(Bun.which("git") ?? "git", 30_000, GIT_ENV);

let dir: string;
let db: Db;
let repos: { origin: string; primary: string; other: string };
let now: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-train-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  repos = scratchRepos(dir);
  now = 1_000_000;
  tx(db, () => db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode, yolo) VALUES ('web', 'https://github.com/acme/web', ?1, 'main', 'direct-PR', 1)").run(repos.primary));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function config(depth: number | null = 3): FlowrynConfig {
  return parseConfig(`${QUEUE}${depth === null ? "" : `landing_train_depth = ${depth}\n`}`, dir);
}

interface Ship {
  task: string;
  run: string;
  wt: string;
  branch: string;
  head: string;
  url: string;
  get(): RunWithPolicy;
}

/** A delivered routine ship: a worktree of the primary checkout on its own branch, one commit of `file`, pushed, its PR delivered. */
function ship(n: number, file: string, text: string): Ship {
  const task = `t${n}`;
  const run = `r${n}`;
  const branch = `flowryn/${task}`;
  const wt = join(dir, `wt-${task}`);
  sh(repos.primary, ["fetch", "-q", "origin"]);
  sh(repos.primary, ["worktree", "add", "-q", "-b", branch, wt, "origin/main"]);
  writeFileSync(join(wt, file), text);
  sh(wt, ["add", "."]);
  sh(wt, ["commit", "-q", "-m", file]);
  sh(wt, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
  const head = sh(wt, ["rev-parse", "HEAD"]);
  const url = `https://github.com/acme/web/pull/${n}`;
  const delivered = 1_000 + n;
  tx(db, () => {
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, sensitive, workflow, created_at) VALUES (?1, 'web', 'ship', 'direct-PR', 1, 0, 'fix', 0)").run(task);
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, stage_state, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
       VALUES (?1, ?2, 'claude', '2.1.281', 'ready', 'idle', 'fix', 'ship', 'done', ?3, ?4, 'abc', ?1, ?5, ?5)`,
    ).run(run, task, wt, branch, delivered);
    db.query("INSERT INTO artifacts (id, task_id, kind, ref, head_sha, created_at) VALUES (?1, ?2, 'pr', ?3, ?4, ?5)").run(`a${n}`, task, url, head, delivered);
    recordPrEvidence(db, run, prEvidenceFrom({ number: n, url, title: task, state: "open", draft: false, headSha: head, headRef: branch, headRepo: "acme/web", baseRef: "main", mergeSha: null, mergedAt: null, mergeable: true }, null, now), now);
    const event = appendEvent(db, { source: "cli", kind: "run.delivered", runId: run, taskId: task, payload: {}, ts: delivered });
    openItem(db, { kind: "pr_ready", eventSeq: event.seq, taskId: task, runId: run, line: `PR ready: ${task} (web), no checks`, now: delivered });
  });
  return { task, run, wt, branch, head, url, get: () => getRunWithPolicy(db, run)! };
}

function queue(cfg = config()): LandingQueue {
  return new LandingQueue({ db, config: () => cfg, git, netGit: git, now: () => now, log: () => {}, kickScheduler: () => {} });
}

function row(s: Ship): LandingRow {
  return liveLanding(db, s.run) ?? (db.query("SELECT * FROM landing_queue WHERE run_id = ?1 ORDER BY enqueued_at DESC LIMIT 1").get(s.run) as LandingRow);
}

function parents(sha: string): string[] {
  return sh(repos.primary, ["rev-list", "--parents", "-n", "1", sha]).split(" ").slice(1);
}

function originHead(branch: string): string {
  return sh(repos.origin, ["rev-parse", `refs/heads/${branch}`]);
}

/** GitHub's squash merge of the PR's branch as it stands on origin, then the run landed (as the watcher records it). */
function squashLand(s: Ship): string {
  sh(repos.other, ["fetch", "-q", "origin"]);
  sh(repos.other, ["checkout", "-q", "main"]);
  sh(repos.other, ["merge", "-q", "--ff-only", "origin/main"]);
  sh(repos.other, ["merge", "-q", "--squash", `origin/${s.branch}`]);
  sh(repos.other, ["commit", "-q", "-m", `${s.task} (#squash)`]);
  sh(repos.other, ["push", "-q", "origin", "main"]);
  tx(db, () => db.query("UPDATE runs SET state = 'landed' WHERE id = ?1").run(s.run));
  return sh(repos.other, ["rev-parse", "HEAD"]);
}

function trainEvents(kind: string): Record<string, unknown>[] {
  return (db.query("SELECT payload FROM events WHERE kind = ?1 ORDER BY seq").all(kind) as { payload: string }[]).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
}

const policy = () => verifyPolicyId(verifyConfig(config(), "web")!);

describe("[projects.<id>] landing_train_depth", () => {
  test("2 by default on a queue project, 1 (no train) off one; outside 1..5 is refused", () => {
    expect(landingTrainDepth(config(null), "web")).toBe(DEFAULT_TRAIN_DEPTH);
    expect(DEFAULT_TRAIN_DEPTH).toBe(2);
    expect(landingTrainDepth(config(4), "web")).toBe(4);
    expect(landingTrainDepth(parseConfig(`[projects.web]\nverify = ["x"]\nlanding_train_depth = 3\n`, dir), "web")).toBe(1);
    for (const bad of ["0", "6", "1.5", '"2"']) expect(() => verifyConfig(parseConfig(`${QUEUE}landing_train_depth = ${bad}\n`, dir), "web")).toThrow(/landing_train_depth must be an integer from 1/);
  });

  test("depth 1 builds no candidate; the default builds one, for the entry right behind the head of line", async () => {
    ship(1, "one.txt", "one\n");
    const s2 = ship(2, "two.txt", "two\n");
    const s3 = ship(3, "three.txt", "three\n");
    await queue(config(1)).pass();
    expect([row(s2).train_head, row(s3).train_head]).toEqual([null, null]);
    await queue(config(null)).pass();
    expect(row(s2).train_head).not.toBeNull();
    expect(row(s3).train_head).toBeNull();
  });
});

describe("a train of three", () => {
  test("assumption: the entries behind the head verify on candidates built on the head ahead of them, never pushed, each request behind every other", async () => {
    const s1 = ship(1, "one.txt", "one\n");
    const s2 = ship(2, "two.txt", "two\n");
    const s3 = ship(3, "three.txt", "three\n");
    await queue().pass();
    expect(row(s1)).toMatchObject({ state: "landing", head_sha: s1.head, train_head: null });
    const c2 = row(s2);
    const c3 = row(s3);
    expect(c2).toMatchObject({ state: "waiting", train_base: s1.head });
    expect(c3).toMatchObject({ state: "waiting", train_base: c2.train_head });
    expect(parents(c2.train_head!)).toEqual([s2.head, s1.head]);
    expect(parents(c3.train_head!)).toEqual([s3.head, c2.train_head!]);
    // Each candidate's base is on its event.
    expect(trainEvents("landing.train_built").map((e) => [e.landing, e.base, e.head])).toEqual([
      [c2.id, s1.head, c2.train_head],
      [c3.id, c2.train_head, c3.train_head],
    ]);
    for (const c of [c2, c3]) {
      expect(getRequest(db, c.train_request!)).toMatchObject({ state: "queued", head_sha: c.train_head, pr_url: c.ref, rank: TRAIN_RANK, pr_number: null, worktree: null, policy_id: policy() });
    }
    expect([originHead(s2.branch), originHead(s3.branch)]).toEqual([s2.head, s3.head]);
    expect([sh(s2.wt, ["rev-parse", "HEAD"]), sh(s3.wt, ["rev-parse", "HEAD"])]).toEqual([s2.head, s3.head]);
    // A second pass keeps them: same base, same candidate.
    await queue().pass();
    expect([row(s2).train_head, row(s3).train_head]).toEqual([c2.train_head, c3.train_head]);
  });

  test("lands in order, each at its candidate on the head that landed before it, with the right bases", async () => {
    const s1 = ship(1, "one.txt", "one\n");
    const s2 = ship(2, "two.txt", "two\n");
    const s3 = ship(3, "three.txt", "three\n");
    const lq = queue();
    await lq.pass();
    const c2 = row(s2);
    const c3 = row(s3);

    squashLand(s1);
    await lq.pass();
    expect(row(s1).state).toBe("landed");
    expect(row(s2)).toMatchObject({ state: "landing", head_sha: c2.train_head, train_base: s1.head, integrations: 1 });
    expect(row(s2).detail).toContain(`the landing train's candidate on ${s1.head.slice(0, 8)}`);
    // Pushed as a fast-forward of the delivered head, the worktree caught up, the delivery carried.
    expect(originHead(s2.branch)).toBe(c2.train_head!);
    expect(sh(s2.wt, ["rev-parse", "HEAD"])).toBe(c2.train_head!);
    expect(deliveredOf(db, s2.task)).toMatchObject({ head: c2.train_head, carriedFrom: s2.head });
    // Its auto-merge follows the candidate's own verify, now ahead of the queue.
    const auto2 = liveAutoMerge(db, s2.run)!;
    expect(auto2).toMatchObject({ head_sha: c2.train_head, state: "queued", request_id: c2.train_request });
    expect(getRequest(db, c2.train_request!)!.rank).toBe(0);
    expect(await lq.beforeMerge(auto2)).toBe(true);
    // The one behind keeps its candidate: its base is the head now landing.
    expect(row(s3)).toMatchObject({ state: "waiting", train_head: c3.train_head, train_base: c2.train_head });

    squashLand(s2);
    await lq.pass();
    expect(row(s3)).toMatchObject({ state: "landing", head_sha: c3.train_head, train_base: c2.train_head });
    expect(originHead(s3.branch)).toBe(c3.train_head!);
    expect(await lq.beforeMerge(liveAutoMerge(db, s3.run)!)).toBe(true);

    squashLand(s3);
    await lq.pass();
    expect([row(s1), row(s2), row(s3)].map((r) => r.state)).toEqual(["landed", "landed", "landed"]);
    expect(sh(repos.other, ["ls-tree", "--name-only", "origin/main"]).split("\n").toSorted()).toEqual(["a.txt", "one.txt", "three.txt", "two.txt"]);
    // Every landing head was what its verify ran on; no candidate was dropped.
    expect(trainEvents("landing.landing").map((e) => [e.head, e.train_base])).toEqual([
      [s1.head, null],
      [c2.train_head, s1.head],
      [c3.train_head, c2.train_head],
    ]);
    expect(trainEvents("landing.train_dropped")).toEqual([]);
  });
});

describe("a car that leaves", () => {
  test("assumption: a middle car sent back re-bases the one behind it on the head ahead, without it, and re-verifies it", async () => {
    const s1 = ship(1, "one.txt", "one\n");
    const s2 = ship(2, "two.txt", "two\n");
    const s3 = ship(3, "three.txt", "three\n");
    const lq = queue();
    await lq.pass();
    const before = row(s3);
    const c2 = row(s2);
    // The middle one is sent back: its run is no longer ready.
    tx(db, () => db.query("UPDATE runs SET state = 'running' WHERE id = ?1").run(s2.run));
    await lq.pass();
    expect(row(s2)).toMatchObject({ state: "left", reason: "sent_back", train_head: null });
    expect(getRequest(db, c2.train_request!)!.state).toBe("cancelled");
    const after = row(s3);
    expect(after.train_base).toBe(s1.head);
    expect(after.train_head).not.toBe(before.train_head);
    expect(parents(after.train_head!)).toEqual([s3.head, s1.head]);
    expect(sh(repos.primary, ["ls-tree", "--name-only", after.train_head!]).split("\n")).not.toContain("two.txt");
    expect(getRequest(db, before.train_request!)).toMatchObject({ state: "cancelled", detail: expect.stringContaining("the landing train dropped") });
    expect(getRequest(db, after.train_request!)).toMatchObject({ state: "queued", head_sha: after.train_head });
    expect(trainEvents("landing.train_dropped").map((e) => e.landing)).toEqual([c2.id, before.id]);

    squashLand(s1);
    await lq.pass();
    expect(row(s3)).toMatchObject({ state: "landing", head_sha: after.train_head, train_base: s1.head });
  });

  test("a middle car whose candidate's verify failed stays in line: the train ends there, and it is integrated on main as before", async () => {
    const s1 = ship(1, "one.txt", "one\n");
    const s2 = ship(2, "two.txt", "two\n");
    const s3 = ship(3, "three.txt", "three\n");
    const lq = queue();
    await lq.pass();
    const c2 = row(s2);
    const c3 = row(s3);
    expect(c3.train_base).toBe(c2.train_head);
    tx(db, () => {
      const v = insertVerification(db, { project_id: "web", pr_url: c2.ref, task_id: s2.task, head_sha: c2.train_head!, steps: [], policy_id: policy(), dir: (id) => join(dir, id), worktree: (id) => join(dir, `vwt-${id}`), project_path: repos.primary, source: "daemon", now });
      finishVerification(db, v, { state: "failed", steps: [], tests: null, detail: "bun test exited 1", binary: null }, now + 1);
    });
    await lq.pass();
    expect(row(s2)).toMatchObject({ state: "waiting", train_head: c2.train_head, train_base: s1.head });
    expect(row(s3)).toMatchObject({ state: "waiting", train_head: null, train_base: null });
    expect(getRequest(db, c3.train_request!)!.state).toBe("cancelled");
    expect(trainEvents("landing.train_dropped")).toEqual([expect.objectContaining({ landing: c3.id, why: "the train ends ahead of it" })]);
    // Not rebuilt on a later pass either.
    await lq.pass();
    expect(row(s3).train_head).toBeNull();

    squashLand(s1);
    await lq.pass();
    const landing = row(s2);
    expect(landing).toMatchObject({ state: "landing", train_head: null, train_base: null });
    expect(landing.head_sha).not.toBe(c2.train_head);
    expect(parents(landing.head_sha)[0]).toBe(s2.head);
    expect(originHead(s2.branch)).toBe(landing.head_sha);
    expect(trainEvents("landing.train_dropped").at(-1)).toMatchObject({ landing: c2.id, why: `its verify at ${c2.train_head!.slice(0, 8)} failed` });
  });

  test("the head of line leaving: the one behind is integrated on main as before, its candidate never pushed", async () => {
    const s1 = ship(1, "one.txt", "one\n");
    const s2 = ship(2, "two.txt", "two\n");
    const lq = queue();
    await lq.pass();
    const c2 = row(s2);
    tx(db, () => db.query("UPDATE runs SET state = 'running' WHERE id = ?1").run(s1.run));
    await lq.pass();
    expect(row(s1).state).toBe("left");
    expect(row(s2)).toMatchObject({ state: "landing", head_sha: s2.head, train_head: null, train_base: null, integrations: 0 });
    expect(originHead(s2.branch)).toBe(s2.head);
    expect(getRequest(db, c2.train_request!)!.state).toBe("cancelled");
    expect(trainEvents("landing.train_dropped")[0]!.why).toContain("is not the last that landed");
  });

  test("a candidate that conflicts with the head ahead is not built, and the train ends there", async () => {
    ship(1, "same.txt", "mine\n");
    const s2 = ship(2, "same.txt", "theirs\n");
    const s3 = ship(3, "three.txt", "three\n");
    await queue().pass();
    await queue().pass();
    expect([row(s2).train_head, row(s3).train_head]).toEqual([null, null]);
    // Tried once, not on every pass.
    expect(trainEvents("landing.train_skipped")).toEqual([{ landing: row(s2).id, head: s2.head, base: expect.any(String), why: expect.stringContaining("conflicts") }]);
  });
});

describe("the train never lands a candidate on a base other than the one it was verified on", () => {
  test("main holding more than the base that landed: the candidate is dropped and the entry merges main as before", async () => {
    const s1 = ship(1, "one.txt", "one\n");
    const s2 = ship(2, "two.txt", "two\n");
    const lq = queue();
    await lq.pass();
    const c2 = row(s2);
    squashLand(s1);
    mergeOnOrigin(repos.other, "else.txt", "landed by hand\n");
    await lq.pass();
    const landing = row(s2);
    expect(landing.state).toBe("landing");
    expect(landing.head_sha).not.toBe(c2.train_head);
    expect(landing.train_base).toBeNull();
    expect(originHead(s2.branch)).toBe(landing.head_sha);
    expect(parents(landing.head_sha)[0]).toBe(s2.head);
    expect(trainEvents("landing.train_dropped")[0]!.why).toContain("does not hold exactly the base");
  });

  test("main moving after the promotion: beforeMerge refuses and sends it back to merge main, its train base cleared", async () => {
    const s1 = ship(1, "one.txt", "one\n");
    const s2 = ship(2, "two.txt", "two\n");
    const lq = queue();
    await lq.pass();
    squashLand(s1);
    await lq.pass();
    const promoted = row(s2);
    expect(promoted.train_base).toBe(s1.head);
    const auto = getAutoMerge(db, promoted.auto_merge_id!)!;
    expect(await lq.beforeMerge(auto)).toBe(true);
    mergeOnOrigin(repos.other, "else.txt", "landed by hand\n");
    expect(await lq.beforeMerge(auto)).toBe(false);
    expect(getLanding(db, promoted.id)).toMatchObject({ state: "waiting", auto_merge_id: null, train_head: null, train_base: null });
    expect(getAutoMerge(db, auto.id)).toMatchObject({ state: "superseded", reason: "base_moved" });
  });

  test("trainBaseHolds: the same tree as the base passes; another tree, or a merge that conflicts, does not", async () => {
    const s1 = ship(1, "one.txt", "one\n");
    const s2 = ship(2, "two.txt", "two\n");
    await queue().pass();
    const c2 = row(s2);
    const main = squashLand(s1);
    sh(repos.primary, ["fetch", "-q", "origin"]);
    expect(await trainBaseHolds(git, repos.primary, { head: c2.train_head!, base: s1.head, main })).toMatchObject({ ok: true });
    // Main is not the base: refused even though the candidate would merge.
    expect(await trainBaseHolds(git, repos.primary, { head: c2.train_head!, base: s2.head, main })).toMatchObject({ ok: false, why: expect.stringContaining("does not hold exactly the base") });
    expect(await trainBaseHolds(git, repos.primary, { head: c2.train_head!, base: s1.head, main: "0".repeat(40) })).toMatchObject({ ok: false, unknown: true });
  });
});
