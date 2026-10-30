import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEADER_WAKE_SQL, openItem } from "../../src/attention/items.ts";
import { parseConfig, type FlowrynConfig } from "../../src/config/config.ts";
import { effectiveConfig } from "../../src/config/effective.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { deliveredOf, prEvidenceFrom, recordPrEvidence } from "../../src/lifecycle/delivery.ts";
import { getRunWithPolicy, type RunWithPolicy } from "../../src/lifecycle/runs.ts";
import { findLandingApproval, insertApproval } from "../../src/policy/approvals.ts";
import { cleanMainMerge } from "../../src/policy/clean-merge.ts";
import { gitRunner } from "../../src/policy/git.ts";
import type { GitRunner } from "../../src/policy/landed.ts";
import { chooseApproval, DAEMON_CALLER, standingApproval, type MergeFacts } from "../../src/policy/merge.ts";
import { applyPrObservation } from "../../src/reconcile/delivery.ts";
import { createAutoMerge, getAutoMerge, liveAutoMerge, startAutoMerge } from "../../src/verify/auto-merge.ts";
import { landingMode, landingQueued } from "../../src/verify/config.ts";
import {
  BLOCKED_HOLD_MS,
  deliveredToQueue,
  enqueueLanding,
  LandingQueue,
  landingMergeMessage,
  liveLanding,
  MAX_INTEGRATIONS,
  projectLine,
  type LandingRow,
} from "../../src/verify/landing-queue.ts";
import { GIT_ENV, mergeOnOrigin, scratchRepos, sh } from "../helpers/scratch-git.ts";

/**
 * The landing queue below the daemon (docs/notes/2026-10-30-landing-queue-the-65.md), with real
 * git against scratch repositories: the config key, who joins the line, the daemon's own merge of
 * main in the run's worktree (clean, up to date, conflicting), the head of line skipping a busy
 * worker, what becomes of a human approval (the user's answer q130: it carries unless the work is
 * sensitive), a base that moves before the merge, a merge a stop cut off before its push, and the
 * watcher reading GitHub before it caught up with the push.
 */

const STEPS = ["bun test"];
const QUEUE = `[projects.web]\nverify = ${JSON.stringify(STEPS)}\nlanding = "queue"\n`;
const git = gitRunner(Bun.which("git") ?? "git", 30_000, GIT_ENV);

let dir: string;
let db: Db;
let repos: { origin: string; primary: string; other: string };
let now: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-landing-"));
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

function config(text = QUEUE): FlowrynConfig {
  return parseConfig(text, dir);
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

/** A delivered ship: a worktree of the primary checkout on its own branch, one commit of `file`, pushed, its PR delivered at that head. */
function ship(n: number, file: string, text: string, opts: { yolo?: number; sensitive?: number; liveness?: string } = {}): Ship {
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
  // Delivered before the test's clock, in order.
  const delivered = 1_000 + n;
  tx(db, () => {
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, sensitive, workflow, created_at) VALUES (?1, 'web', 'ship', 'direct-PR', ?2, ?3, 'fix', 0)").run(task, opts.yolo ?? 1, opts.sensitive ?? 0);
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, stage_state, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
       VALUES (?1, ?2, 'claude', '2.1.281', 'ready', ?3, 'fix', 'ship', 'done', ?4, ?5, 'abc', ?1, ?6, ?6)`,
    ).run(run, task, opts.liveness ?? "idle", wt, branch, delivered);
    db.query("INSERT INTO artifacts (id, task_id, kind, ref, head_sha, created_at) VALUES (?1, ?2, 'pr', ?3, ?4, ?5)").run(`a${n}`, task, url, head, delivered);
    recordPrEvidence(db, run, prEvidenceFrom({ number: n, url, title: task, state: "open", draft: false, headSha: head, headRef: branch, headRepo: "acme/web", baseRef: "main", mergeSha: null, mergedAt: null, mergeable: true }, null, now), now);
    const event = appendEvent(db, { source: "cli", kind: "run.delivered", runId: run, taskId: task, payload: {}, ts: delivered });
    const kind = opts.sensitive ? "sensitive_action_waiting" : "pr_ready";
    openItem(db, { kind, eventSeq: event.seq, taskId: task, runId: run, line: `PR ready: ${task} (web), no checks`, now: delivered });
  });
  return { task, run, wt, branch, head, url, get: () => getRunWithPolicy(db, run)! };
}

function queue(cfg = config(), logs: string[] = [], netGit: GitRunner = git): { lq: LandingQueue; kicks: number[]; logs: string[] } {
  const kicks: number[] = [];
  const lq = new LandingQueue({ db, config: () => cfg, git, netGit, now: () => now, log: (m) => logs.push(m), kickScheduler: () => kicks.push(1) });
  return { lq, kicks, logs };
}

function entries(): Pick<LandingRow, "task_id" | "state" | "reason" | "integrations">[] {
  return (db.query("SELECT task_id, state, reason, integrations FROM landing_queue ORDER BY enqueued_at, CAST(substr(id, 3) AS INTEGER)").all() as LandingRow[]).map((r) => ({
    task_id: r.task_id,
    state: r.state,
    reason: r.reason,
    integrations: r.integrations,
  }));
}

function originHead(branch: string): string {
  return sh(repos.origin, ["rev-parse", `refs/heads/${branch}`]);
}

function openItems(kind: string): string[] {
  return (db.query("SELECT line FROM items WHERE kind = ?1 AND state IN ('open','presented')").all(kind) as { line: string }[]).map((r) => r.line);
}

describe("[projects.<id>] landing", () => {
  test("manual by default; queue needs verify steps; anything else is refused; flowryn config shows it", () => {
    expect(landingMode(config(`[projects.web]\nverify = ["bun test"]\n`), "web")).toBe("manual");
    expect(landingMode(config(QUEUE), "web")).toBe("queue");
    expect(() => landingMode(config(`[projects.web]\nlanding = "queue"\n`), "web")).toThrow(/landing = "queue" needs verify steps/);
    expect(() => landingMode(config(`[projects.web]\nverify = ["x"]\nlanding = "fifo"\n`), "web")).toThrow(/landing must be "queue" or "manual"/);
    expect(landingQueued(config(`[projects.web]\nlanding = "fifo"\n`), "web")).toBe(false);
    expect(JSON.stringify(effectiveConfig(config(QUEUE)))).toContain('"landing":"queue"');
  });
});

describe("who joins the line", () => {
  test("a routine PR joins; work that is not routine joins only with your standing approval at its head; one entry per head", async () => {
    const routine = ship(1, "one.txt", "one\n");
    const asked = ship(2, "two.txt", "two\n", { yolo: 0, liveness: "busy" });
    const blocked = ship(3, "three.txt", "three\n", { liveness: "busy" });
    // Every worker is busy, so nothing starts landing and the line stays in arrival order.
    db.query("UPDATE runs SET liveness = 'busy' WHERE id = ?1").run(routine.run);
    const { lq } = queue();
    await lq.pass();
    expect(entries().map((e) => e.task_id)).toEqual([routine.task, blocked.task]);
    tx(db, () => insertApproval(db, { task: asked.task, ref: asked.url, head: asked.head, channel: "cli-tty", actor: "you", action: "merge", now }));
    await lq.pass();
    const row = liveLanding(db, asked.run)!;
    expect(row.approval_id).not.toBeNull();
    expect(projectLine(db, "web").map((r) => r.task_id)).toEqual([routine.task, blocked.task, asked.task]);
    // The leader is not woken for a PR in line.
    const woken = db.query(`SELECT i.task_id FROM items i WHERE i.kind = 'pr_ready' AND i.state = 'open' AND ${LEADER_WAKE_SQL}`).all() as { task_id: string }[];
    expect(woken).toEqual([]);
  });

  test("a delivery on a queue project starts no auto-merge of its own, even with auto_merge on", () => {
    const s = ship(1, "one.txt", "one\n");
    const both = config(`${QUEUE}auto_merge = true\n`);
    tx(db, () => {
      expect(deliveredToQueue(db, both, s.get(), s.head, now)).toBe(true);
    });
    expect(liveAutoMerge(db, s.run)).toBeNull();
    const manual = config(`[projects.web]\nverify = ["bun test"]\nauto_merge = true\n`);
    tx(db, () => {
      expect(deliveredToQueue(db, manual, s.get(), s.head, now)).toBe(false);
      startAutoMerge(db, manual, s.get(), { ref: s.url, head: s.head, prNumber: 1, headRef: s.branch, worktree: null }, now);
    });
    expect(liveAutoMerge(db, s.run)).not.toBeNull();
  });
});

describe("the head of line", () => {
  test("assumption: the daemon's merge of a moved main is a plain merge commit, pushed, that proves clean, and the next PR waits its turn", async () => {
    const first = ship(1, "one.txt", "one\n");
    const second = ship(2, "two.txt", "two\n");
    const main = mergeOnOrigin(repos.other, "main.txt", "main moved\n");
    const { lq } = queue();
    await lq.pass();

    expect(entries()).toEqual([
      { task_id: first.task, state: "landing", reason: null, integrations: 1 },
      { task_id: second.task, state: "waiting", reason: null, integrations: 0 },
    ]);
    const head = sh(first.wt, ["rev-parse", "HEAD"]);
    expect(sh(first.wt, ["rev-list", "--parents", "-n", "1", "HEAD"])).toBe(`${head} ${first.head} ${main}`);
    expect(sh(first.wt, ["log", "-1", "--format=%s"])).toBe(landingMergeMessage("main", first.branch));
    expect(originHead(first.branch)).toBe(head);
    expect(await cleanMainMerge(git, first.wt, { from: first.head, to: head, base: "main" })).toMatchObject({ ok: true });
    // The delivery was carried to the new head, its verify queued, and an auto-merge follows that request.
    expect(deliveredOf(db, first.task)).toMatchObject({ head, carriedFrom: first.head });
    const auto = liveAutoMerge(db, first.run)!;
    expect(auto).toMatchObject({ head_sha: head, state: "queued" });
    expect(db.query("SELECT head_sha, source FROM verify_queue WHERE id = ?1").get(auto.request_id!)).toEqual({ head_sha: head, source: "auto" });
    expect(openItems("pr_ready").find((l) => l.includes(second.task))).toContain(`landing queue: 2 of 2, behind ${first.task}`);
    // The second PR's worktree is untouched while it waits.
    expect(sh(second.wt, ["rev-parse", "HEAD"])).toBe(second.head);
  });

  test("a PR that already has main's tip is not merged into: its landing starts at the delivered head", async () => {
    const s = ship(1, "one.txt", "one\n");
    await queue().lq.pass();
    expect(entries()).toEqual([{ task_id: s.task, state: "landing", reason: null, integrations: 0 }]);
    expect(sh(s.wt, ["rev-parse", "HEAD"])).toBe(s.head);
    expect(liveAutoMerge(db, s.run)).toMatchObject({ head_sha: s.head });
  });

  test("a merge that conflicts is undone and the ship sent back with the conflicted files; the next PR goes", async () => {
    const first = ship(1, "a.txt", "mine\n");
    const second = ship(2, "two.txt", "two\n");
    mergeOnOrigin(repos.other, "a.txt", "theirs\n");
    const { lq, kicks } = queue();
    await lq.pass();

    expect(entries()).toEqual([
      { task_id: first.task, state: "left", reason: "conflict", integrations: 0 },
      { task_id: second.task, state: "landing", reason: null, integrations: 1 },
    ]);
    expect(sh(first.wt, ["status", "--porcelain"])).toBe("");
    expect(sh(first.wt, ["rev-parse", "HEAD"])).toBe(first.head);
    expect(originHead(first.branch)).toBe(first.head);
    expect(first.get().state).toBe("running");
    const nudge = db.query("SELECT source, payload FROM events WHERE kind = 'run.conflict_nudged'").get() as { source: string; payload: string };
    expect(nudge.source).toBe("daemon");
    expect(JSON.parse(nudge.payload)).toMatchObject({ files: ["a.txt"], nudge: 1, base: "main" });
    // The steer waits on the ship stage's grant, as any send-back's does.
    const steer = first.get().stage_note ?? "";
    expect(steer).toContain("the landing queue's merge of origin/main into");
    expect(steer).toContain("Conflicted: a.txt.");
    expect(steer).toContain("Never rebase or force-push.");
    expect(openItems("conflict_nudged")).toHaveLength(1);
    expect(kicks.length).toBeGreaterThan(0);
  });

  test("a busy worker or a changed worktree is skipped for the next PR, and held after 30 minutes", async () => {
    const busy = ship(1, "one.txt", "one\n", { liveness: "busy" });
    const dirty = ship(2, "two.txt", "two\n");
    writeFileSync(join(dirty.wt, "two.txt"), "edited, not committed\n");
    const { lq } = queue();
    await lq.pass();
    expect(entries().map((e) => e.state)).toEqual(["waiting", "waiting"]);
    expect(db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'landing.blocked'").get()).toEqual({ n: 2 });
    now += BLOCKED_HOLD_MS + 1;
    await lq.pass();
    expect(entries().map((e) => [e.state, e.reason])).toEqual([
      ["left", "landing_blocked"],
      ["left", "landing_blocked"],
    ]);
    expect(openItems("auto_merge_held").map((l) => l.split(":")[0])).toEqual(["Landing held", "Landing held"]);
    expect(busy.get().state).toBe("ready");
  });

  test("a head of line skipped while another PR landed gets its full 30 minutes again when it is next tried", async () => {
    const busy = ship(1, "one.txt", "one\n", { liveness: "busy" });
    const other = ship(2, "two.txt", "two\n");
    const { lq } = queue();
    await lq.pass();
    expect(entries().map((e) => e.state)).toEqual(["waiting", "landing"]);
    now += BLOCKED_HOLD_MS + 1;
    tx(db, () => db.query("UPDATE runs SET state = 'landed' WHERE id = ?1").run(other.run));
    await lq.pass();
    expect(entries().map((e) => [e.task_id, e.state])).toEqual([
      [busy.task, "waiting"],
      [other.task, "landed"],
    ]);
    expect(liveLanding(db, busy.run)!.blocked_since).toBe(now);
  });

  test("a direct auto-merge left from before the project queued is superseded when its entry starts landing", async () => {
    const s = ship(1, "one.txt", "one\n");
    mergeOnOrigin(repos.other, "main.txt", "main moved\n");
    const both = config(`[projects.web]\nverify = ${JSON.stringify(STEPS)}\nauto_merge = true\nlanding = "queue"\n`);
    const direct = tx(db, () => createAutoMerge(db, both, s.get(), { ref: s.url, head: s.head, prNumber: 1, headRef: s.branch, worktree: null, source: "cli" }, now));
    tx(db, () => enqueueLanding(db, s.get(), deliveredOf(db, s.task)!, null, now));
    await queue(both).lq.pass();
    const live = liveLanding(db, s.run)!;
    expect(live.state).toBe("landing");
    expect(getAutoMerge(db, direct.id)).toMatchObject({ state: "superseded", reason: "landing" });
    expect(liveAutoMerge(db, s.run)).toMatchObject({ id: live.auto_merge_id, head_sha: deliveredOf(db, s.task)!.head });
  });

  test("a merge a stop cut off before its push is pushed and carried on the next pass", async () => {
    const s = ship(1, "one.txt", "one\n");
    mergeOnOrigin(repos.other, "main.txt", "main moved\n");
    sh(s.wt, ["fetch", "-q", "origin", "main"]);
    sh(s.wt, ["merge", "-q", "--no-ff", "--no-edit", "origin/main"]);
    const local = sh(s.wt, ["rev-parse", "HEAD"]);
    await queue().lq.pass();
    expect(originHead(s.branch)).toBe(local);
    expect(deliveredOf(db, s.task)).toMatchObject({ head: local, carriedFrom: s.head });
    expect(entries()).toEqual([{ task_id: s.task, state: "landing", reason: null, integrations: 1 }]);
  });
});

describe("your approval across the queue's merge of main (q130: it carries unless the work is sensitive)", () => {
  function facts(s: Ship, head: string): MergeFacts {
    return { run: s.get(), ref: s.url, head } as unknown as MergeFacts;
  }

  test("a merge on a queue project leaves its approval standing: a record as it is, the yolo posture as none", () => {
    const s = ship(1, "one.txt", "one\n", { yolo: 0 });
    const record = tx(db, () => insertApproval(db, { task: s.task, ref: s.url, head: s.head, channel: "cli-tty", actor: "you", action: "merge", now }));
    expect(tx(db, () => standingApproval(db, facts(s, s.head), { kind: "row", row: record }, now))).toBe(record.id);
    expect(db.query("SELECT consumed_at FROM approvals WHERE id = ?1").get(record.id)).toEqual({ consumed_at: null });
    expect(tx(db, () => standingApproval(db, facts(s, s.head), { kind: "yolo" }, now))).toBeNull();
  });

  test("a standing record carries; it is found for the daemon only through the live entry", async () => {
    const s = ship(1, "one.txt", "one\n", { yolo: 0 });
    mergeOnOrigin(repos.other, "main.txt", "main moved\n");
    const record = tx(db, () => insertApproval(db, { task: s.task, ref: s.url, head: s.head, channel: "claude-ask", actor: "you (Claude prompt, leader L1)", action: "merge", allowRed: "ci/flaky", now }));
    tx(db, () => enqueueLanding(db, s.get(), deliveredOf(db, s.task)!, record.id, now));
    await queue().lq.pass();
    const head = deliveredOf(db, s.task)!.head;
    expect(head).not.toBe(s.head);
    const live = liveLanding(db, s.run)!;
    expect(live.state).toBe("landing");
    const carried = db.query("SELECT * FROM approvals WHERE id = ?1").get(live.approval_id!) as { head_sha: string; channel: string; allow_red_check: string; expires_at: number; actor: string };
    expect(carried).toMatchObject({ head_sha: head, channel: "claude-ask", allow_red_check: "ci/flaky", expires_at: record.expires_at });
    expect(carried.actor).toContain("carried across a clean merge of main");
    expect(db.query("SELECT consumed_at FROM approvals WHERE id = ?1").get(record.id)).not.toEqual({ consumed_at: null });
    expect(findLandingApproval(db, { task: s.task, ref: s.url, head, now })?.id).toBe(live.approval_id!);
    const chosen = chooseApproval(db, { run: s.get(), ref: s.url, head } as unknown as MergeFacts, { caller: DAEMON_CALLER }, "merge", now);
    expect(chosen.choice).toMatchObject({ kind: "row", row: { id: live.approval_id } });
    // Nobody else's merge finds it: a leader caller gets no standing record from the queue.
    expect(chooseApproval(db, { run: s.get(), ref: s.url, head } as unknown as MergeFacts, { caller: { role: "human" } as never }, "merge", now).choice).toBeNull();
  });

  test("sensitive work: the approval does not carry; the entry leaves for your word at the new head", async () => {
    const s = ship(1, "one.txt", "one\n", { yolo: 0, sensitive: 1 });
    mergeOnOrigin(repos.other, "main.txt", "main moved\n");
    const record = tx(db, () => insertApproval(db, { task: s.task, ref: s.url, head: s.head, channel: "cli-tty", actor: "you", action: "merge", now }));
    await queue().lq.pass();
    expect(entries()).toEqual([{ task_id: s.task, state: "left", reason: "approval_needed", integrations: 0 }]);
    expect(db.query("SELECT consumed_at FROM approvals WHERE id = ?1").get(record.id)).not.toEqual({ consumed_at: null });
    expect(db.query("SELECT COUNT(*) AS n FROM approvals WHERE consumed_at IS NULL").get()).toEqual({ n: 0 });
    expect(openItems("auto_merge_held")[0]).toContain(`flowryn merge ${s.task}`);
    expect(liveAutoMerge(db, s.run)).toBeNull();
    // The merge of main stands (pushed): your word at the new head is all it needs.
    expect(originHead(s.branch)).toBe(deliveredOf(db, s.task)!.head);
  });
});

describe("before the merge", () => {
  test("a base that moved sends the head of line back to merge it in again, at most MAX_INTEGRATIONS times", async () => {
    const s = ship(1, "one.txt", "one\n");
    const { lq } = queue();
    for (let i = 0; i < MAX_INTEGRATIONS; i++) {
      mergeOnOrigin(repos.other, `main${i}.txt`, `main ${i}\n`);
      await lq.pass();
      const live = liveLanding(db, s.run)!;
      expect(live.state).toBe("landing");
      mergeOnOrigin(repos.other, `late${i}.txt`, `late ${i}\n`);
      const auto = getAutoMerge(db, live.auto_merge_id!)!;
      expect(await lq.beforeMerge(auto)).toBe(false);
      if (i < MAX_INTEGRATIONS - 1) {
        expect(liveLanding(db, s.run)).toMatchObject({ state: "waiting", auto_merge_id: null });
        expect(getAutoMerge(db, auto.id)).toMatchObject({ state: "superseded", reason: "base_moved" });
      }
    }
    expect(entries()).toEqual([{ task_id: s.task, state: "left", reason: "base_moving", integrations: MAX_INTEGRATIONS }]);
    expect(openItems("auto_merge_held")).toHaveLength(1);
  });

  test("a head that still has its base merges; a row that is not the queue's is not asked", async () => {
    const s = ship(1, "one.txt", "one\n");
    const { lq } = queue();
    await lq.pass();
    const auto = getAutoMerge(db, liveLanding(db, s.run)!.auto_merge_id!)!;
    expect(await lq.beforeMerge(auto)).toBe(true);
    expect(await lq.beforeMerge({ ...auto, id: "am999" })).toBe(true);
  });
});

describe("the watcher after the queue's push", () => {
  /** A netGit whose push is followed at once by the watcher reading GitHub at the pushed head, before the queue carries the delivery. */
  function watchedPush(s: Ship, carry: boolean): GitRunner {
    return async (args, cwd) => {
      const result = await git(args, cwd);
      if (args[0] !== "push") return result;
      const pushed = sh(s.wt, ["rev-parse", "HEAD"]);
      const delivered = deliveredOf(db, s.task)!;
      const proof = await cleanMainMerge(git, s.wt, { from: delivered.head, to: pushed, base: "main" });
      const pr = { number: 1, url: s.url, title: s.task, state: "open" as const, draft: false, headSha: pushed, headRef: s.branch, headRepo: "acme/web", baseRef: "main", mergeSha: null, mergedAt: null, mergeable: true };
      // The daemon's hook for a carried head: on a queue project it waits its turn in the line.
      const autoMerge = (r: RunWithPolicy, moved: { headSha: string }, at: number) => void deliveredToQueue(db, config(), r, moved.headSha, at);
      tx(db, () => applyPrObservation(db, s.get(), delivered, { pr, checks: null }, new Set(), now, { nudgeConflicts: true, history: "descends", carry: carry ? { proof, verifyPolicy: null, autoMerge } : undefined }));
      return result;
    };
  }

  test("a moved head the watcher saw between the queue's push and its carry is settled by the carry", async () => {
    const s = ship(1, "one.txt", "one\n", { yolo: 0 });
    mergeOnOrigin(repos.other, "main.txt", "main moved\n");
    const record = tx(db, () => insertApproval(db, { task: s.task, ref: s.url, head: s.head, channel: "cli-tty", actor: "you", action: "merge", now }));
    tx(db, () => enqueueLanding(db, s.get(), deliveredOf(db, s.task)!, record.id, now));
    await queue(config(), [], watchedPush(s, false)).lq.pass();
    expect(liveLanding(db, s.run)).toMatchObject({ state: "landing" });
    expect(db.query("SELECT COUNT(*) AS n FROM divergences").get()).toEqual({ n: 1 });
    expect(db.query("SELECT resolution FROM divergences").get()).toEqual({ resolution: "carried" });
    expect(openItems("divergence")).toEqual([]);
  });

  test("routine work the watcher carried first starts landing at the carried head", async () => {
    const s = ship(1, "one.txt", "one\n");
    mergeOnOrigin(repos.other, "main.txt", "main moved\n");
    await queue(config(), [], watchedPush(s, true)).lq.pass();
    const head = deliveredOf(db, s.task)!.head;
    expect(head).not.toBe(s.head);
    expect(entries()).toEqual([{ task_id: s.task, state: "landing", reason: null, integrations: 1 }]);
    expect(liveAutoMerge(db, s.run)).toMatchObject({ head_sha: head });
    expect(db.query("SELECT COUNT(*) AS n FROM divergences").get()).toEqual({ n: 0 });
  });

  test("GitHub still showing the head the delivery was carried from is a lagging read, not a moved head", async () => {
    const s = ship(1, "one.txt", "one\n");
    mergeOnOrigin(repos.other, "main.txt", "main moved\n");
    await queue().lq.pass();
    const delivered = deliveredOf(db, s.task)!;
    expect(delivered.carriedFrom).toBe(s.head);
    const pr = { number: 1, url: s.url, title: s.task, state: "open" as const, draft: false, headSha: s.head, headRef: s.branch, headRepo: "acme/web", baseRef: "main", mergeSha: null, mergedAt: null, mergeable: true };
    tx(db, () => applyPrObservation(db, s.get(), delivered, { pr, checks: null }, new Set(), now, { nudgeConflicts: true }));
    expect(db.query("SELECT COUNT(*) AS n FROM divergences").get()).toEqual({ n: 0 });
    expect(s.get().state).toBe("ready");
  });
});
