import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEADER_WAKE_SQL, openItem } from "../../src/attention/items.ts";
import { parseConfig, type FlowrynConfig } from "../../src/config/config.ts";
import { effectiveConfig } from "../../src/config/effective.ts";
import { migrate, openDb, setMeta, tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { getRunWithPolicy, type RunWithPolicy } from "../../src/lifecycle/runs.ts";
import { insertApproval } from "../../src/policy/approvals.ts";
import { recordMergeResult } from "../../src/policy/merge.ts";
import { inertDelivery } from "../../src/policy/services.ts";
import {
  AutoMerger,
  getAutoMerge,
  HEAD_MOVED_WAIT_MS,
  MAX_VERIFY_REQUEUES,
  NO_CI_CHECKS_WAIT_MS,
  requeueCount,
  liveAutoMerge,
  sendBackText,
  startAutoMerge,
  verifyVerdict,
  type AutoMergeDelivery,
} from "../../src/verify/auto-merge.ts";
import { autoMergeEnabled, verifyConfig } from "../../src/verify/config.ts";
import { verifyPolicyId } from "../../src/verify/policy.ts";
import { autoVerifyPath, getRequest, insertRequest, markStarted } from "../../src/verify/queue.ts";
import { initialSteps } from "../../src/verify/runner.ts";
import { cancelIsFinal, headMovedCancelled } from "../../src/verify/start.ts";
import { finishVerification, insertVerification, type Verification, type VerifyStep } from "../../src/verify/store.ts";

/**
 * Yolo auto-merge below the daemon (docs/notes/2026-10-22-daemon-run-verify-y3.md,
 * phase 2): the config key, the deliver-time trigger, the verify verdict, the
 * controller's moves that need no GitHub (the merge itself is the integration
 * test's), the wake rule, and the restart cases the design names.
 */

const dirs: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fl-am-"));
  dirs.push(dir);
  return dir;
}

const STEPS = ["bun test"];
const PR_URL = "https://github.com/acme/web/pull/7";
const HEAD = "a".repeat(40);

function config(projects: string): FlowrynConfig {
  return parseConfig(projects, tempDir());
}

const OPTED_IN = `[projects.web]\nverify = ${JSON.stringify(STEPS)}\nauto_merge = true\n`;
const POLICY = verifyPolicyId({ steps: STEPS, binary: null });

interface Fixture {
  db: Db;
  root: string;
  run(): RunWithPolicy;
  delivery: AutoMergeDelivery;
}

/** A delivered yolo ship of project web at HEAD, with its open pr_ready item. */
function fixture(opts: { yolo?: number; sensitive?: number; task?: string; run?: string } = {}): Fixture {
  const root = tempDir();
  const db = openDb(join(root, "flowryn.db"));
  dbs.push(db);
  migrate(db);
  const task = opts.task ?? "t1";
  const runId = opts.run ?? "r1";
  const now = 1_000;
  tx(db, () => {
    db.query("INSERT OR IGNORE INTO projects (id, repo_url, path, default_branch, delivery_mode, yolo) VALUES ('web', 'https://github.com/acme/web', '/p', 'main', 'direct-PR', 1)").run();
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, sensitive, workflow, created_at) VALUES (?1, 'web', 'ship', 'direct-PR', ?2, ?3, 'fix', 0)").run(task, opts.yolo ?? 1, opts.sensitive ?? 0);
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, stage_state, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
       VALUES (?1, ?2, 'claude', '2.1.281', 'ready', 'idle', 'fix', 'ship', 'done', '/tmp/wt', 'flowryn/t1', 'abc', 'x', ?3, ?3)`,
    ).run(runId, task, now);
    db.query("INSERT INTO artifacts (id, task_id, kind, ref, head_sha, created_at) VALUES ('a1', ?1, 'pr', ?2, ?3, ?4)").run(task, PR_URL, HEAD, now);
    const event = appendEvent(db, { source: "cli", kind: "run.delivered", runId, taskId: task, payload: {}, ts: now });
    openItem(db, { kind: "pr_ready", eventSeq: event.seq, taskId: task, runId, line: "PR ready: t1 (web), 1 green", now });
  });
  return { db, root, run: () => getRunWithPolicy(db, runId)!, delivery: { ref: PR_URL, head: HEAD, prNumber: 7, headRef: "flowryn/t1", worktree: null } };
}

function readyLine(db: Db): string {
  return (db.query("SELECT line FROM items WHERE kind = 'pr_ready' AND state IN ('open','presented')").get() as { line: string }).line;
}

function verification(f: Fixture, root: string, head = HEAD): Verification {
  return tx(f.db, () =>
    insertVerification(f.db, {
      project_id: "web",
      pr_url: PR_URL,
      task_id: "t1",
      head_sha: head,
      steps: initialSteps(STEPS),
      policy_id: POLICY,
      dir: (id) => join(root, id),
      worktree: (id) => join(root, id, "wt"),
      project_path: "/p",
      source: "daemon",
      now: 2_000,
    }),
  );
}

function finish(f: Fixture, v: Verification, state: "passed" | "failed" | "error", steps: VerifyStep[] = v.steps, detail: string | null = null): void {
  tx(f.db, () => finishVerification(f.db, v, { state, steps, tests: null, detail, binary: null }, 3_000));
}

function merger(f: Fixture, cfg: FlowrynConfig, now = 10_000): { auto: AutoMerger; kicks: number[]; logs: string[] } {
  const kicks: number[] = [];
  const logs: string[] = [];
  const auto = new AutoMerger({ db: f.db, config: () => cfg, delivery: inertDelivery(), now: () => now, log: (m) => logs.push(m), kickScheduler: () => kicks.push(1) });
  return { auto, kicks, logs };
}

describe("[projects.<id>] auto_merge", () => {
  test("is off unless set, on with verify steps, and refused without them or as a non-boolean", () => {
    expect(autoMergeEnabled(config(`[projects.web]\nverify = ["true"]\n`), "web")).toBe(false);
    expect(autoMergeEnabled(config(OPTED_IN), "web")).toBe(true);
    expect(autoMergeEnabled(config(""), "web")).toBe(false);
    expect(() => autoMergeEnabled(config(`[projects.web]\nauto_merge = true\n`), "web")).toThrow("auto_merge needs verify steps");
    expect(() => verifyConfig(config(`[projects.web]\nauto_merge = true\n`), "web")).toThrow("auto_merge needs verify steps");
    expect(() => verifyConfig(config(`[projects.web]\nverify = ["true"]\nauto_merge = "yes"\n`), "web")).toThrow("auto_merge must be true or false");
    // Opting out without steps is fine.
    expect(verifyConfig(config(`[projects.web]\nauto_merge = false\n`), "web")).toBeNull();
  });

  test("the daemon's config check refuses it without verify steps, and the effective view shows it", () => {
    expect(effectiveConfig(config(`[projects.web]\nauto_merge = true\n`)).problems.join("\n")).toContain("auto_merge needs verify steps");
    const view = effectiveConfig(config(OPTED_IN));
    expect(view.problems).toEqual([]);
    expect(JSON.stringify(view)).toContain('"auto_merge":true');
  });

  test("it does not change the verify policy, so earlier verifications still count", () => {
    expect(verifyPolicyId(verifyConfig(config(OPTED_IN), "web")!)).toBe(verifyPolicyId(verifyConfig(config(`[projects.web]\nverify = ${JSON.stringify(STEPS)}\n`), "web")!));
  });
});

describe("the deliver-time trigger", () => {
  test("an opted-in yolo, non-sensitive delivery queues a daemon verify (source auto) with the project's CLI PATH; the pr_ready line shows its place", () => {
    const f = fixture();
    tx(f.db, () => setMeta(f.db, "verify_path:web", "/opt/bin:/usr/bin"));
    const row = tx(f.db, () => startAutoMerge(f.db, config(OPTED_IN), f.run(), f.delivery, 5_000))!;
    expect(row).toMatchObject({ state: "queued", ref: PR_URL, head_sha: HEAD, task_id: "t1" });
    expect(getRequest(f.db, row.request_id!)).toMatchObject({ source: "auto", pr_number: 7, head_ref: "flowryn/t1", path: "/opt/bin:/usr/bin", policy_id: POLICY, state: "queued" });
    expect(readyLine(f.db)).toBe(`PR ready: t1 (web), 1 green; auto-merge: verify queued (${row.request_id}, 1 of 1)`);
  });

  test("without a CLI verify of the project, the daemon's PATH plus ~/.bun/bin", () => {
    const f = fixture();
    expect(autoVerifyPath(f.db, "web", { PATH: "/usr/bin:/bin" })).toMatch(/^\/usr\/bin:\/bin:.*\/\.bun\/bin$/);
  });

  test("not opted in, not yolo, or sensitive: no auto-merge", () => {
    const plain = fixture();
    expect(tx(plain.db, () => startAutoMerge(plain.db, config(`[projects.web]\nverify = ["true"]\n`), plain.run(), plain.delivery, 5_000))).toBeNull();
    const notYolo = fixture({ yolo: 0 });
    expect(tx(notYolo.db, () => startAutoMerge(notYolo.db, config(OPTED_IN), notYolo.run(), notYolo.delivery, 5_000))).toBeNull();
    const sensitive = fixture({ sensitive: 1 });
    expect(tx(sensitive.db, () => startAutoMerge(sensitive.db, config(OPTED_IN), sensitive.run(), sensitive.delivery, 5_000))).toBeNull();
    for (const f of [plain, notYolo, sensitive]) expect(f.db.query("SELECT COUNT(*) AS n FROM verify_queue").get()).toEqual({ n: 0 });
  });

  test("it follows a passed, running or queued verify of the head rather than queueing another", () => {
    const passed = fixture();
    const pv = verification(passed, passed.root);
    finish(passed, pv, "passed");
    expect(tx(passed.db, () => startAutoMerge(passed.db, config(OPTED_IN), passed.run(), passed.delivery, 5_000))).toMatchObject({ state: "waiting_checks", verification_id: pv.id, request_id: null });

    const running = fixture();
    const rv = verification(running, running.root);
    expect(tx(running.db, () => startAutoMerge(running.db, config(OPTED_IN), running.run(), running.delivery, 5_000))).toMatchObject({ state: "verifying", verification_id: rv.id });

    const queued = fixture();
    const cli = tx(queued.db, () => insertRequest(queued.db, { project_id: "web", pr_url: PR_URL, task_id: "t1", head_sha: HEAD, policy_id: POLICY, pr_number: 7, head_ref: "flowryn/t1", worktree: null, source: "cli", path: null, now: 4_000 }));
    expect(tx(queued.db, () => startAutoMerge(queued.db, config(OPTED_IN), queued.run(), queued.delivery, 5_000))).toMatchObject({ state: "queued", request_id: cli.id });
    expect(queued.db.query("SELECT COUNT(*) AS n FROM verify_queue").get()).toEqual({ n: 1 });
  });

  test("a failed verify at the head does not count: the redelivery verifies again", () => {
    const f = fixture();
    finish(f, verification(f, f.root), "failed");
    expect(tx(f.db, () => startAutoMerge(f.db, config(OPTED_IN), f.run(), f.delivery, 5_000))).toMatchObject({ state: "queued" });
  });

  test("a redelivery supersedes the live row; a run has one live row at most", () => {
    const f = fixture();
    const first = tx(f.db, () => startAutoMerge(f.db, config(OPTED_IN), f.run(), f.delivery, 5_000))!;
    const second = tx(f.db, () => startAutoMerge(f.db, config(OPTED_IN), f.run(), { ...f.delivery, head: "b".repeat(40) }, 6_000))!;
    expect(getAutoMerge(f.db, first.id)).toMatchObject({ state: "superseded", reason: "redelivered", detail: "delivered again at bbbbbbbb" });
    expect(liveAutoMerge(f.db, f.run().id)?.id).toBe(second.id);
    // Even a project that opted out since: the old row still ends.
    const third = tx(f.db, () => startAutoMerge(f.db, config(`[projects.web]\nverify = ["true"]\n`), f.run(), f.delivery, 7_000));
    expect(third).toBeNull();
    expect(getAutoMerge(f.db, second.id)?.state).toBe("superseded");
    expect(() => f.db.query("INSERT INTO auto_merges (id, run_id, task_id, project_id, ref, head_sha, state, created_at, state_since, updated_at) VALUES ('x1', 'r1', 't1', 'web', 'u', 'h', 'queued', 1, 1, 1), ('x2', 'r1', 't1', 'web', 'u', 'h', 'merging', 1, 1, 1)").run()).toThrow();
  });
});

describe("the verify verdict (the user's answer q78)", () => {
  const step = (over: Partial<VerifyStep>): VerifyStep => ({ name: "bun test", state: "failed", exit: 1, ms: 5, log: "1-bun-test.log", tests: null, detail: null, ...over });
  const v = (state: Verification["state"], steps: VerifyStep[], detail: string | null = null) => ({ id: "v9", state, steps, detail }) as Verification;

  test("a step that exited non-zero goes back to the worker", () => {
    expect(verifyVerdict(v("failed", [step({})]))).toEqual({ sendBack: step({}) });
  });

  test("a timeout, an error, or a failure with no failing step is held", () => {
    expect(verifyVerdict(v("failed", [step({ exit: null, detail: "timed out: the run's 30 min were up" })]))).toMatchObject({ hold: "verify_timeout" });
    expect(verifyVerdict(v("failed", [step({ exit: 143, detail: "timed out: the run's 30 min were up" })]))).toMatchObject({ hold: "verify_timeout" });
    expect(verifyVerdict(v("failed", [step({ exit: 143, attempts: 2, hangs: 2, detail: "hung twice: killed at 5 min both times; process groups in a.log and b.log" })]))).toMatchObject({ hold: "verify_timeout" });
    expect(verifyVerdict(v("failed", [step({ exit: 143, attempts: 1, hangs: 1, detail: "hung once: killed at 5 min, process group in a.log; no time left in the run to retry it" })]))).toMatchObject({ hold: "verify_timeout" });
    expect(verifyVerdict(v("failed", [step({ exit: 143, attempts: 2, hangs: 1, detail: "hung once: killed at 5 min, process group in a.log; timed out: the run's 30 min were up" })]))).toMatchObject({ hold: "verify_timeout" });
    expect(verifyVerdict(v("error", [], "the daemon stopped mid-run"))).toMatchObject({ hold: "verify_error" });
    expect(verifyVerdict(v("failed", [step({ state: "passed", exit: 0 })], "dist/flowryn was not built"))).toMatchObject({ hold: "verify_failed", detail: "verify v9 failed: dist/flowryn was not built" });
  });

  test("a step whose retry after one hang exited non-zero goes back to the worker", () => {
    const retried = step({ exit: 1, attempts: 2, hangs: 1, detail: "hung once: killed at 5 min, process group in a.log; its retry exited 1" });
    expect(verifyVerdict(v("failed", [retried]))).toEqual({ sendBack: retried });
  });

  test("the send-back carries the step, its exit and the tail of its log", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "v9"));
    writeFileSync(join(dir, "v9", "1-bun-test.log"), `${Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n")}\n(fail) the thing\n`);
    const text = sendBackText({ id: "v9", dir: join(dir, "v9"), head_sha: HEAD } as Verification, step({ exit: 1 }));
    expect(text).toContain(`verify v9 of your delivery at ${HEAD.slice(0, 8)} failed: step \`bun test\` exited 1`);
    expect(text).toContain("(fail) the thing");
    expect(text).not.toContain("line 10\n");
    expect(text).toContain("deliver again");
  });
});

describe("the controller, without GitHub", () => {
  test("queued follows its request to the verification; a passed verify waits on checks; a cancelled request holds", async () => {
    const f = fixture();
    const cfg = config(OPTED_IN);
    const row = tx(f.db, () => startAutoMerge(f.db, cfg, f.run(), f.delivery, 5_000))!;
    const v = verification(f, f.root);
    tx(f.db, () => markStarted(f.db, getRequest(f.db, row.request_id!)!, v.id, 2_000));
    const { auto } = merger(f, cfg);
    await auto.pass();
    expect(getAutoMerge(f.db, row.id)).toMatchObject({ state: "verifying", verification_id: v.id });
    expect(readyLine(f.db)).toEndWith(`auto-merge: verifying (${v.id})`);

    const other = fixture({ task: "t1", run: "r1" });
    const r2 = tx(other.db, () => startAutoMerge(other.db, cfg, other.run(), other.delivery, 5_000))!;
    tx(other.db, () => other.db.query("UPDATE verify_queue SET state = 'cancelled', detail = 'the PR is closed' WHERE id = ?1").run(r2.request_id));
    await merger(other, cfg).auto.pass();
    expect(getAutoMerge(other.db, r2.id)).toMatchObject({ state: "held", reason: "verify_cancelled" });
    const held = other.db.query("SELECT line FROM items WHERE kind = 'auto_merge_held'").get() as { line: string };
    expect(held.line).toContain("the PR is closed");
  });

  test("a queued row's place moving rewrites the pr_ready line with an auto_merge.queue_moved event; a steady queue writes nothing", async () => {
    const f = fixture();
    const cfg = config(OPTED_IN);
    const ahead = tx(f.db, () => insertRequest(f.db, { project_id: "web", pr_url: "https://github.com/acme/web/pull/6", task_id: "t0", head_sha: "c".repeat(40), policy_id: POLICY, pr_number: 6, head_ref: "flowryn/t0", worktree: null, source: "cli", path: null, now: 4_000 }));
    const row = tx(f.db, () => startAutoMerge(f.db, cfg, f.run(), f.delivery, 5_000))!;
    expect(readyLine(f.db)).toEndWith(`auto-merge: verify queued (${row.request_id}, 2 of 2)`);
    const moves = () => f.db.query("SELECT payload FROM events WHERE kind = 'auto_merge.queue_moved'").all() as { payload: string }[];

    await merger(f, cfg).auto.pass();
    expect(moves()).toEqual([]);

    tx(f.db, () => f.db.query("UPDATE verify_queue SET state = 'cancelled', detail = 'the PR is closed' WHERE id = ?1").run(ahead.id));
    await merger(f, cfg).auto.pass();
    expect(readyLine(f.db)).toEndWith(`auto-merge: verify queued (${row.request_id}, 1 of 1)`);
    expect(moves().map((m) => JSON.parse(m.payload))).toEqual([{ auto_merge: row.id, request: row.request_id, position: 1, of: 1 }]);

    await merger(f, cfg).auto.pass();
    expect(moves()).toHaveLength(1);
  });

  test("a cancelled verify is queued again at once, with one event saying why; the row follows it, and holds after MAX_VERIFY_REQUEUES", async () => {
    const f = fixture();
    const cfg = config(OPTED_IN);
    const row = tx(f.db, () => startAutoMerge(f.db, cfg, f.run(), f.delivery, 5_000))!;
    const moved = `the PR head moved from ${HEAD.slice(0, 8)} to bbbbbbbb; verify the new head`;
    expect(headMovedCancelled(moved)).toBe(true);
    expect(headMovedCancelled("the PR is closed")).toBe(false);
    let lost = row.request_id!;
    for (let attempt = 1; attempt <= MAX_VERIFY_REQUEUES; attempt++) {
      tx(f.db, () => f.db.query("UPDATE verify_queue SET state = 'cancelled', detail = ?2 WHERE id = ?1").run(lost, moved));
      const { auto, kicks } = merger(f, cfg, 5_000 + 60_000 * attempt);
      await auto.pass();
      const after = getAutoMerge(f.db, row.id)!;
      expect(after.state).toBe("queued");
      expect(after.request_id).not.toBe(lost);
      expect(getRequest(f.db, after.request_id!)).toMatchObject({ state: "queued", head_sha: HEAD, source: "auto", pr_number: 7, head_ref: "flowryn/t1" });
      expect(kicks.length).toBe(1);
      expect(requeueCount(f.db, row.id)).toBe(attempt);
      lost = after.request_id!;
    }
    const events = f.db.query("SELECT payload FROM events WHERE kind = 'auto_merge.verify_requeued'").all() as { payload: string }[];
    expect(JSON.parse(events[0]!.payload)).toMatchObject({ auto_merge: row.id, lost: row.request_id, head: HEAD, state: "queued", made: true, attempt: 1 });
    expect(JSON.parse(events[0]!.payload).why).toContain(moved);
    // The loss keeps happening: held for the leader, naming the fix.
    tx(f.db, () => f.db.query("UPDATE verify_queue SET state = 'cancelled', detail = ?2 WHERE id = ?1").run(lost, moved));
    await merger(f, cfg, 5_000 + 60_000 * 9).auto.pass();
    expect(getAutoMerge(f.db, row.id)).toMatchObject({ state: "held", reason: "verify_cancelled", next: "flowryn verify t1, then flowryn merge t1" });
  });

  test("assumption: GitHub reading an older delivered head (a carry it has not caught up with) re-verifies the delivered head, not the old one", async () => {
    const f = fixture();
    const cfg = config(OPTED_IN);
    const OLD = "b".repeat(40);
    tx(f.db, () => {
      f.db.query("UPDATE artifacts SET created_at = 900 WHERE id = 'a1'").run();
      f.db.query("INSERT INTO artifacts (id, task_id, kind, ref, head_sha, created_at) VALUES ('a0', 't1', 'pr', ?1, ?2, 500)").run(PR_URL, OLD);
      f.db.query("UPDATE artifacts SET carried_from = ?1 WHERE id = 'a1'").run(OLD);
      f.db.query("INSERT OR REPLACE INTO run_evidence (run_id, source, rank, value, observed_at) VALUES ('r1', 'github', 1, ?1, 1)").run(JSON.stringify({ url: PR_URL, number: 7, title: "t", state: "open", draft: false, head: OLD, head_ref: "flowryn/t1", merge_sha: null, checks: null, observed_at: 1 }));
    });
    const row = tx(f.db, () => startAutoMerge(f.db, cfg, f.run(), f.delivery, 5_000))!;
    tx(f.db, () => f.db.query("UPDATE verify_queue SET state = 'cancelled', detail = ?2 WHERE id = ?1").run(row.request_id, `the PR head moved from ${HEAD.slice(0, 8)} to ${OLD.slice(0, 8)}; verify the new head`));
    await merger(f, cfg).auto.pass();
    const after = getAutoMerge(f.db, row.id)!;
    expect(after.state).toBe("queued");
    expect(getRequest(f.db, after.request_id!)?.head_sha).toBe(HEAD);
  });

  test("a head that really moved gets its verify queued and supersedes the row: its delivery starts the next one", async () => {
    const f = fixture();
    const cfg = config(OPTED_IN);
    const NEW = "c".repeat(40);
    tx(f.db, () =>
      f.db.query("INSERT OR REPLACE INTO run_evidence (run_id, source, rank, value, observed_at) VALUES ('r1', 'github', 1, ?1, 1)").run(JSON.stringify({ url: PR_URL, number: 7, title: "t", state: "open", draft: false, head: NEW, head_ref: "flowryn/t1", merge_sha: null, checks: null, observed_at: 1 })),
    );
    const row = tx(f.db, () => startAutoMerge(f.db, cfg, f.run(), f.delivery, 5_000))!;
    tx(f.db, () => f.db.query("UPDATE verify_queue SET state = 'cancelled', detail = ?2 WHERE id = ?1").run(row.request_id, `the PR head moved from ${HEAD.slice(0, 8)} to ${NEW.slice(0, 8)}; verify the new head`));
    await merger(f, cfg).auto.pass();
    const after = getAutoMerge(f.db, row.id)!;
    expect(after).toMatchObject({ state: "superseded", reason: "head_moved" });
    expect(after.detail).toContain(`moved to ${NEW.slice(0, 8)}`);
    const queued = f.db.query("SELECT * FROM verify_queue WHERE state = 'queued'").all() as { head_sha: string }[];
    expect(queued.map((q) => q.head_sha)).toEqual([NEW]);
    // The worker delivers it: the new row follows the verify already queued.
    tx(f.db, () => f.db.query("INSERT INTO artifacts (id, task_id, kind, ref, head_sha, created_at) VALUES ('a2', 't1', 'pr', ?1, ?2, 6000)").run(PR_URL, NEW));
    const next = tx(f.db, () => startAutoMerge(f.db, cfg, f.run(), { ...f.delivery, head: NEW }, 6_000))!;
    expect(next).toMatchObject({ state: "queued", request_id: (f.db.query("SELECT id FROM verify_queue WHERE state = 'queued'").get() as { id: string }).id });
  });

  test("a verify request that is gone is queued again; a cancel no new request gets past (PR closed) holds at once", async () => {
    const f = fixture();
    const cfg = config(OPTED_IN);
    const row = tx(f.db, () => startAutoMerge(f.db, cfg, f.run(), f.delivery, 5_000))!;
    tx(f.db, () => f.db.query("DELETE FROM verify_queue WHERE id = ?1").run(row.request_id));
    await merger(f, cfg).auto.pass();
    expect(getAutoMerge(f.db, row.id)).toMatchObject({ state: "queued" });
    expect(cancelIsFinal(`${PR_URL} is closed`)).toBe(true);
    expect(cancelIsFinal("project web is gone")).toBe(true);
    expect(cancelIsFinal(`cannot read the head of local:flowryn/t1 in /tmp/wt`)).toBe(false);
    const again = getAutoMerge(f.db, row.id)!;
    tx(f.db, () => f.db.query("UPDATE verify_queue SET state = 'cancelled', detail = ?2 WHERE id = ?1").run(again.request_id, `${PR_URL} is closed`));
    await merger(f, cfg).auto.pass();
    expect(getAutoMerge(f.db, row.id)).toMatchObject({ state: "held", reason: "verify_cancelled" });
  });

  test("a non-zero step sends the ship back once per head, and the next failure there holds", async () => {
    const f = fixture();
    const cfg = config(OPTED_IN);
    const row = tx(f.db, () => startAutoMerge(f.db, cfg, f.run(), f.delivery, 5_000))!;
    const v = verification(f, f.root);
    tx(f.db, () => f.db.query("UPDATE auto_merges SET state = 'verifying', verification_id = ?2 WHERE id = ?1").run(row.id, v.id));
    finish(f, v, "failed", [{ ...v.steps[0]!, state: "failed", exit: 2 }], "bun test exited 2");
    const { auto, kicks } = merger(f, cfg);
    await auto.pass();
    expect(getAutoMerge(f.db, row.id)).toMatchObject({ state: "sent_back", reason: "verify_failed" });
    expect(f.run().state).toBe("running");
    expect(kicks.length).toBe(1);
    expect(f.db.query("SELECT COUNT(*) AS n FROM items WHERE kind = 'pr_ready' AND state IN ('open','presented')").get()).toEqual({ n: 0 });

    // Delivered again at the same head; it fails the same way.
    tx(f.db, () => f.db.query("UPDATE runs SET state = 'ready' WHERE id = 'r1'").run());
    const again = tx(f.db, () => startAutoMerge(f.db, cfg, f.run(), f.delivery, 20_000))!;
    const v2 = verification(f, f.root);
    tx(f.db, () => f.db.query("UPDATE auto_merges SET state = 'verifying', verification_id = ?2 WHERE id = ?1").run(again.id, v2.id));
    finish(f, v2, "failed", [{ ...v2.steps[0]!, state: "failed", exit: 2 }]);
    await auto.pass();
    expect(getAutoMerge(f.db, again.id)).toMatchObject({ state: "held", reason: "verify_failed" });
    expect(f.run().state).toBe("ready");
    expect(kicks.length).toBe(1);
  });

  test("restart: a verify the daemon stopped (error) follows its requeued rerun instead of holding", async () => {
    const f = fixture();
    const cfg = config(OPTED_IN);
    const row = tx(f.db, () => startAutoMerge(f.db, cfg, f.run(), f.delivery, 5_000))!;
    const v = verification(f, f.root);
    tx(f.db, () => f.db.query("UPDATE auto_merges SET state = 'verifying', verification_id = ?2 WHERE id = ?1").run(row.id, v.id));
    finish(f, v, "error", v.steps, "the daemon stopped mid-run");
    const rerun = tx(f.db, () => insertRequest(f.db, { project_id: "web", pr_url: PR_URL, task_id: "t1", head_sha: HEAD, policy_id: POLICY, pr_number: 7, head_ref: "flowryn/t1", worktree: null, source: "recovered", path: null, rank: -1, recovered_from: v.id, now: 4_000 }));
    await merger(f, cfg).auto.pass();
    expect(getAutoMerge(f.db, row.id)).toMatchObject({ state: "queued", request_id: rerun.id, verification_id: null });
    // Without a rerun (it was a rerun already), the work was never judged: a verify is queued once more.
    const v2 = verification(f, f.root);
    tx(f.db, () => markStarted(f.db, rerun, v2.id, 4_500));
    tx(f.db, () => f.db.query("UPDATE auto_merges SET state = 'verifying', verification_id = ?2 WHERE id = ?1").run(row.id, v2.id));
    finish(f, v2, "error", v2.steps, "the daemon stopped mid-run");
    await merger(f, cfg).auto.pass();
    const after = getAutoMerge(f.db, row.id)!;
    expect(after).toMatchObject({ state: "queued", verification_id: null });
    expect(getRequest(f.db, after.request_id!)).toMatchObject({ state: "queued", head_sha: HEAD, source: "auto" });
    expect(requeueCount(f.db, row.id)).toBe(1);
    // An error the verify itself reached (not a stop) still holds.
    const v3 = verification(f, f.root);
    tx(f.db, () => f.db.query("UPDATE auto_merges SET state = 'verifying', verification_id = ?2 WHERE id = ?1").run(row.id, v3.id));
    finish(f, v3, "error", v3.steps, "cannot create the worktree");
    await merger(f, cfg).auto.pass();
    expect(getAutoMerge(f.db, row.id)).toMatchObject({ state: "held", reason: "verify_error" });
  });

  test("restart: a row merging across a restart ends merged when the watcher proves its merge, landed by: auto with no landed wake", async () => {
    const f = fixture();
    const cfg = config(OPTED_IN);
    const row = tx(f.db, () => startAutoMerge(f.db, cfg, f.run(), f.delivery, 5_000))!;
    tx(f.db, () => {
      const approval = insertApproval(f.db, { task: "t1", ref: PR_URL, head: HEAD, channel: "yolo", actor: "yolo posture", action: "merge", now: 6_000 });
      f.db.query("INSERT INTO merges (id, task_id, pr_url, head_sha, approval_id, requested_at, state, method) VALUES ('mg1', 't1', ?1, ?2, ?3, 6000, 'unproven', 'squash')").run(PR_URL, HEAD, approval.id);
      f.db.query("UPDATE runs SET state = 'merging' WHERE id = 'r1'").run();
      f.db.query("UPDATE auto_merges SET state = 'merging', merge_id = 'mg1' WHERE id = ?1").run(row.id);
    });
    const { auto } = merger(f, cfg);
    await auto.pass();
    expect(getAutoMerge(f.db, row.id)?.state).toBe("merging");
    // The delivery watcher proves it after the restart (recordMergeResult with its default `by`).
    tx(f.db, () => recordMergeResult(f.db, f.run(), "mg1", { state: "merged", sha: "m".repeat(40), detail: "the watcher read the PR merged" }, 7_000));
    await auto.pass();
    expect(getAutoMerge(f.db, row.id)?.state).toBe("merged");
    expect(f.db.query("SELECT COUNT(*) AS n FROM items WHERE kind = 'landed'").get()).toEqual({ n: 0 });
    expect(f.db.query("SELECT COUNT(*) AS n FROM items WHERE kind = 'yolo_merged'").get()).toEqual({ n: 1 });
    const landed = f.db.query("SELECT payload FROM events WHERE kind = 'run.landed'").get() as { payload: string };
    expect(JSON.parse(landed.payload)).toMatchObject({ by: "auto" });
  });

  test("an auto-merge that used your standing approval (flowryn approve) lands by: other, so a landed item reports it", () => {
    const f = fixture();
    const cfg = config(OPTED_IN);
    const row = tx(f.db, () => startAutoMerge(f.db, cfg, f.run(), f.delivery, 5_000))!;
    tx(f.db, () => {
      const approval = insertApproval(f.db, { task: "t1", ref: PR_URL, head: HEAD, channel: "cli-tty", actor: "you", action: "merge", now: 6_000 });
      f.db.query("INSERT INTO merges (id, task_id, pr_url, head_sha, approval_id, requested_at, state, method) VALUES ('mg1', 't1', ?1, ?2, ?3, 6000, 'requested', 'squash')").run(PR_URL, HEAD, approval.id);
      f.db.query("UPDATE runs SET state = 'merging' WHERE id = 'r1'").run();
      f.db.query("UPDATE auto_merges SET state = 'merging', merge_id = 'mg1' WHERE id = ?1").run(row.id);
    });
    tx(f.db, () => recordMergeResult(f.db, f.run(), "mg1", { state: "merged", sha: "m".repeat(40), detail: "merged" }, 7_000, "auto"));
    expect(f.db.query("SELECT COUNT(*) AS n FROM items WHERE kind = 'landed'").get()).toEqual({ n: 1 });
    expect(f.db.query("SELECT COUNT(*) AS n FROM items WHERE kind = 'yolo_merged'").get()).toEqual({ n: 0 });
    const landed = f.db.query("SELECT payload FROM events WHERE kind = 'run.landed'").get() as { payload: string };
    expect(JSON.parse(landed.payload)).toMatchObject({ by: "other" });
  });

  test("a run sent back, cancelled, merged by hand or opted out supersedes the live row", async () => {
    const cases: [string, (f: Fixture) => void, FlowrynConfig | null, string][] = [
      ["sent back", (f) => f.db.query("UPDATE runs SET state = 'running' WHERE id = 'r1'").run(), null, "the run is running (sent back)"],
      ["cancelled", (f) => f.db.query("UPDATE runs SET state = 'cancelled' WHERE id = 'r1'").run(), null, "the run is cancelled"],
      ["opted out", () => {}, config(`[projects.web]\nverify = ${JSON.stringify(STEPS)}\n`), "auto_merge is off for project web"],
    ];
    for (const [name, change, after, why] of cases) {
      const f = fixture();
      const row = tx(f.db, () => startAutoMerge(f.db, config(OPTED_IN), f.run(), f.delivery, 5_000))!;
      tx(f.db, () => change(f));
      await merger(f, after ?? config(OPTED_IN)).auto.pass();
      expect({ name, ...getAutoMerge(f.db, row.id) }).toMatchObject({ name, state: "superseded", detail: why });
    }
  });

  test("a head that moved past a passed verify with nothing delivered holds after 30 min, not 6 h; a no_ci project's checks get 1 h", async () => {
    const f = fixture();
    const cfg = config(OPTED_IN);
    const v = verification(f, f.root);
    finish(f, v, "passed");
    const row = tx(f.db, () => startAutoMerge(f.db, cfg, f.run(), f.delivery, 5_000))!;
    const evidence = (head: string, pending: string[]) =>
      tx(f.db, () =>
        f.db
          .query("INSERT OR REPLACE INTO run_evidence (run_id, source, rank, value, observed_at) VALUES ('r1', 'github', 1, ?1, 1)")
          .run(JSON.stringify({ url: PR_URL, number: 7, title: "t", state: "open", draft: false, head, head_ref: "flowryn/t1", merge_sha: null, checks: { state: pending.length ? "pending" : "green", line: "x", red: [], pending, total: 1 }, observed_at: 1 })),
      );
    evidence("c".repeat(40), []);
    await merger(f, cfg, 5_000 + HEAD_MOVED_WAIT_MS).auto.pass();
    expect(getAutoMerge(f.db, row.id)?.state).toBe("waiting_checks");
    await merger(f, cfg, 5_000 + HEAD_MOVED_WAIT_MS + 1).auto.pass();
    expect(getAutoMerge(f.db, row.id)).toMatchObject({ state: "held", reason: "head_moved" });
    expect(getAutoMerge(f.db, row.id)!.detail).toContain("over 30 min ago");

    const g = fixture();
    const w = verification(g, g.root);
    finish(g, w, "passed");
    const other = tx(g.db, () => startAutoMerge(g.db, cfg, g.run(), g.delivery, 5_000))!;
    tx(g.db, () =>
      g.db
        .query("INSERT OR REPLACE INTO run_evidence (run_id, source, rank, value, observed_at) VALUES ('r1', 'github', 1, ?1, 1)")
        .run(JSON.stringify({ url: PR_URL, number: 7, title: "t", state: "open", draft: false, head: HEAD, head_ref: "flowryn/t1", merge_sha: null, checks: { state: "pending", line: "x", red: [], pending: ["ci/test"], total: 1 }, observed_at: 1 })),
    );
    const at = (now: number, noCi: boolean) => new AutoMerger({ db: g.db, config: () => cfg, delivery: inertDelivery(), now: () => now, log: () => {}, kickScheduler: () => {}, noCi: async () => noCi });
    await at(5_000 + NO_CI_CHECKS_WAIT_MS + 1, false).pass();
    expect(getAutoMerge(g.db, other.id)?.state).toBe("waiting_checks");
    await at(5_000 + NO_CI_CHECKS_WAIT_MS, true).pass();
    expect(getAutoMerge(g.db, other.id)?.state).toBe("waiting_checks");
    await at(5_000 + NO_CI_CHECKS_WAIT_MS + 1, true).pass();
    expect(getAutoMerge(g.db, other.id)).toMatchObject({ state: "held", reason: "checks_timeout" });
  });

  test("checks pending over 6 h, or a head that moved with nothing delivered since, hold", async () => {
    const f = fixture();
    const cfg = config(OPTED_IN);
    const v = verification(f, f.root);
    finish(f, v, "passed");
    const row = tx(f.db, () => startAutoMerge(f.db, cfg, f.run(), f.delivery, 5_000))!;
    expect(row.state).toBe("waiting_checks");
    const evidence = (head: string, pending: string[]) =>
      tx(f.db, () =>
        f.db
          .query("INSERT OR REPLACE INTO run_evidence (run_id, source, rank, value, observed_at) VALUES ('r1', 'github', 1, ?1, 1)")
          .run(JSON.stringify({ url: PR_URL, number: 7, title: "t", state: "open", draft: false, head, head_ref: "flowryn/t1", merge_sha: null, checks: { state: pending.length ? "pending" : "green", line: "x", red: [], pending, total: 1 }, observed_at: 1 })),
      );
    evidence(HEAD, ["ci/test"]);
    await merger(f, cfg, 5_000 + 60_000).auto.pass();
    expect(getAutoMerge(f.db, row.id)?.state).toBe("waiting_checks");
    evidence("c".repeat(40), []);
    await merger(f, cfg, 5_000 + 60_000).auto.pass();
    expect(getAutoMerge(f.db, row.id)?.state).toBe("waiting_checks");
    evidence(HEAD, ["ci/test"]);
    await merger(f, cfg, 5_000 + 6 * 3_600_000 + 1).auto.pass();
    expect(getAutoMerge(f.db, row.id)).toMatchObject({ state: "held", reason: "checks_timeout" });
  });
});

describe("waking the leader", () => {
  const wakes = (db: Db) => (db.query(`SELECT i.kind FROM items i WHERE ${LEADER_WAKE_SQL} AND i.state IN ('open','presented') ORDER BY i.kind`).all() as { kind: string }[]).map((r) => r.kind);

  test("a yolo pr_ready wakes it, but not while an auto-merge works on it; a held one wakes it", async () => {
    const f = fixture();
    expect(wakes(f.db)).toEqual(["pr_ready"]);
    const cfg = config(OPTED_IN);
    const row = tx(f.db, () => startAutoMerge(f.db, cfg, f.run(), f.delivery, 5_000))!;
    expect(wakes(f.db)).toEqual([]);
    tx(f.db, () => f.db.query("UPDATE verify_queue SET state = 'cancelled', detail = ?2 WHERE id = ?1").run(row.request_id, `${PR_URL} is closed`));
    await merger(f, cfg).auto.pass();
    expect(wakes(f.db)).toEqual(["auto_merge_held", "pr_ready"]);
  });
});

describe("shutdown", () => {
  test("stop ends the kicks and resolves only once a pass under way has ended, so the database closes after it", async () => {
    const f = fixture();
    let release!: () => void;
    let passes = 0;
    class Held extends AutoMerger {
      override pass(): Promise<void> {
        passes++;
        return new Promise((resolve) => (release = resolve));
      }
    }
    const auto = new Held({ db: f.db, config: () => config(OPTED_IN), delivery: inertDelivery(), now: () => 0, log: () => {}, kickScheduler: () => {} });
    auto.kick();
    auto.kick(); // a pass is running: this one would follow it
    let stopped = false;
    const done = auto.stop().then(() => (stopped = true));
    await Bun.sleep(5);
    expect(stopped).toBe(false);
    release();
    await done;
    expect(stopped).toBe(true);
    auto.kick();
    expect(passes).toBe(1);
  });
});
