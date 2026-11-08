import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openItem } from "../../src/attention/items.ts";
import { parseConfig, type FlowrynConfig } from "../../src/config/config.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { getRunWithPolicy, type RunWithPolicy } from "../../src/lifecycle/runs.ts";
import { inertDelivery } from "../../src/policy/services.ts";
import { AutoMerger, getAutoMerge, startAutoMerge, type AutoMergeRow } from "../../src/verify/auto-merge.ts";
import { verifyPolicyId } from "../../src/verify/policy.ts";
import { getRequest, insertRequest, markStarted } from "../../src/verify/queue.ts";
import { cleanTail, MAX_VERIFY_SEND_BACKS, routeManualVerifies } from "../../src/verify/route.ts";
import { initialSteps } from "../../src/verify/runner.ts";
import { finishVerification, insertVerification, type Verification, type VerifyStep } from "../../src/verify/store.ts";

/**
 * Verify failures route themselves (task no-idle-workers-23, phase 3;
 * docs/notes/2026-11-06-no-idle-workers-23.md): one automatic re-run after a
 * timeout, a real failure sent back with its sanitised tail, and the leader
 * for a second timeout, the same step failing again, or a fourth send-back;
 * on the auto-merge's path and a leader's own `flowryn verify`.
 */

const dirs: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fl-vr-"));
  dirs.push(dir);
  return dir;
}

const STEPS = ["bun test", "oxlint"];
const PR_URL = "https://github.com/acme/web/pull/7";
const HEAD = "a".repeat(40);
const HEAD2 = "b".repeat(40);
const POLICY = verifyPolicyId({ steps: STEPS, binary: null });
const AUTO = `[projects.web]\nverify = ${JSON.stringify(STEPS)}\nauto_merge = true\n`;
/** Not yolo and auto_verify off: deliveries get no auto-merge row, so only a leader's verify runs. */
const MANUAL = `[projects.web]\nverify = ${JSON.stringify(STEPS)}\nauto_verify = false\n`;
const NOW = 1_000_000;

interface Fixture {
  db: Db;
  root: string;
  cfg: FlowrynConfig;
  run(): RunWithPolicy;
}

/** A ship of project web delivered at HEAD (state ready), or still working (running). */
function fixture(projects: string, state: "ready" | "running" | "failed" = "ready"): Fixture {
  const root = tempDir();
  const db = openDb(join(root, "flowryn.db"));
  dbs.push(db);
  migrate(db);
  tx(db, () => {
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode, yolo) VALUES ('web', 'https://github.com/acme/web', '/p', 'main', 'direct-PR', 1)").run();
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, sensitive, workflow, created_at) VALUES ('t1', 'web', 'ship', 'direct-PR', 1, 0, 'fix', 0)").run();
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, stage_state, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
       VALUES ('r1', 't1', 'claude', '2.1.281', ?1, 'idle', 'fix', 'ship', 'done', '/tmp/wt', 'flowryn/t1', 'abc', 'x', 1000, 1000)`,
    ).run(state);
    db.query("INSERT INTO artifacts (id, task_id, kind, ref, head_sha, created_at) VALUES ('a1', 't1', 'pr', ?1, ?2, 1000)").run(PR_URL, HEAD);
    const event = appendEvent(db, { source: "cli", kind: "run.delivered", runId: "r1", taskId: "t1", payload: {}, ts: 1000 });
    if (state === "ready") openItem(db, { kind: "pr_ready", eventSeq: event.seq, taskId: "t1", runId: "r1", line: "PR ready: t1 (web)", now: 1000 });
  });
  return { db, root, cfg: parseConfig(projects, tempDir()), run: () => getRunWithPolicy(db, "r1")! };
}

/** Deliver again at `head` (the worker's fix), back in state ready. */
function redeliver(f: Fixture, head: string, at: number): void {
  tx(f.db, () => {
    f.db.query("UPDATE runs SET state = 'ready' WHERE id = 'r1'").run();
    f.db.query("INSERT INTO artifacts (id, task_id, kind, ref, head_sha, created_at) VALUES (?1, 't1', 'pr', ?2, ?3, ?4)").run(`a${at}`, PR_URL, head, at);
  });
}

let started = 0;
/** A verification of `head`, started from a request of `source` (a leader's verify is cli). */
function verification(f: Fixture, head: string, source: "cli" | "auto"): Verification {
  return tx(f.db, () => {
    const at = NOW + ++started;
    const request = insertRequest(f.db, { project_id: "web", pr_url: PR_URL, task_id: "t1", head_sha: head, policy_id: POLICY, pr_number: 7, head_ref: "flowryn/t1", worktree: null, source, path: "/opt/bin", now: at });
    const v = insertVerification(f.db, {
      project_id: "web",
      pr_url: PR_URL,
      task_id: "t1",
      head_sha: head,
      steps: initialSteps(STEPS),
      policy_id: POLICY,
      dir: (id) => join(f.root, id),
      worktree: (id) => join(f.root, id, "wt"),
      project_path: "/p",
      source: source === "cli" ? "cli" : "daemon",
      now: at,
    });
    markStarted(f.db, request, v.id, at);
    return v;
  });
}

const TIMED_OUT = { exit: 143, attempts: 2, hangs: 2, detail: "hung twice: killed at 5 min both times" };

/** Finish `v` with step `index` failed as `over` says, writing `log` as its output. */
function fail(f: Fixture, v: Verification, index: number, over: Partial<VerifyStep> = {}, log = "boom\n"): void {
  mkdirSync(join(f.root, v.id), { recursive: true });
  const steps = v.steps.map((s, i) => (i < index ? { ...s, state: "passed" as const, exit: 0 } : i === index ? { ...s, state: "failed" as const, exit: 1, ...over } : s));
  writeFileSync(join(f.root, v.id, steps[index]!.log), log);
  tx(f.db, () => finishVerification(f.db, v, { state: "failed", steps, tests: null, detail: `${steps[index]!.name} failed`, binary: null }, NOW + ++started));
}

function merger(f: Fixture): { auto: AutoMerger; kicks: number[]; notified: string[] } {
  const kicks: number[] = [];
  const notified: string[] = [];
  const auto = new AutoMerger({ db: f.db, config: () => f.cfg, delivery: inertDelivery(), now: () => NOW + 500_000, log: () => {}, kickScheduler: () => kicks.push(1), notify: (r) => notified.push(r) });
  return { auto, kicks, notified };
}

/** The auto-merge row for the current delivery, verifying `v`. */
function verifying(f: Fixture, head: string, v: Verification): AutoMergeRow {
  const row = tx(f.db, () => startAutoMerge(f.db, f.cfg, f.run(), { ref: PR_URL, head, prNumber: 7, headRef: "flowryn/t1", worktree: null }, NOW))!;
  tx(f.db, () => f.db.query("UPDATE auto_merges SET state = 'verifying', verification_id = ?2, request_id = NULL WHERE id = ?1").run(row.id, v.id));
  return getAutoMerge(f.db, row.id)!;
}

function events(db: Db, kind: string): Record<string, unknown>[] {
  return (db.query("SELECT payload FROM events WHERE kind = ?1 ORDER BY seq").all(kind) as { payload: string }[]).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
}

function openKinds(db: Db, kind: string): string[] {
  return (db.query("SELECT line FROM items WHERE kind = ?1 AND state IN ('open','presented')").all(kind) as { line: string }[]).map((i) => i.line);
}

/** What a sent-back ship's stage start says (the send-back's steer). */
function stageNote(db: Db): string {
  return (db.query("SELECT stage_note FROM runs WHERE id = 'r1'").get() as { stage_note: string | null }).stage_note ?? "";
}

describe("the auto-merge's verify", () => {
  test("a verify timeout gets one automatic re-run at the same head; a second timeout is held for the leader", async () => {
    const f = fixture(AUTO);
    const v = verification(f, HEAD, "auto");
    const row = verifying(f, HEAD, v);
    fail(f, v, 0, TIMED_OUT);
    const { auto, kicks } = merger(f);
    await auto.pass();
    const after = getAutoMerge(f.db, row.id)!;
    expect(after.state).toBe("queued");
    expect(getRequest(f.db, after.request_id!)).toMatchObject({ head_sha: HEAD, state: "queued", source: "auto", pr_number: 7 });
    expect(events(f.db, "verify.auto_rerun")).toEqual([expect.objectContaining({ of: v.id, step: "bun test", head: HEAD, request: after.request_id })]);
    expect(kicks.length).toBe(1);
    expect(f.run().state).toBe("ready");

    const rerun = verification(f, HEAD, "auto");
    tx(f.db, () => f.db.query("UPDATE auto_merges SET state = 'verifying', verification_id = ?2 WHERE id = ?1").run(row.id, rerun.id));
    fail(f, rerun, 0, TIMED_OUT);
    await auto.pass();
    expect(getAutoMerge(f.db, row.id)).toMatchObject({ state: "held", reason: "verify_timeout" });
    expect(openKinds(f.db, "auto_merge_held")[0]).toContain("again after one automatic re-run");
    expect(events(f.db, "verify.escalated")).toEqual([expect.objectContaining({ verification: rerun.id, code: "verify_timeout", path: "auto_merge", auto_merge: row.id })]);
    expect(events(f.db, "verify.auto_rerun")).toHaveLength(1);
  });

  test("a real failure sends back the sanitised tail; the same step failing at a new head goes to the leader", async () => {
    const f = fixture(AUTO);
    const v = verification(f, HEAD, "auto");
    const row = verifying(f, HEAD, v);
    fail(f, v, 0, { exit: 2 }, `${Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")}\n\u001b[31mFAIL\u001b[0m token ghp_${"x".repeat(36)} leaked\u0007\n`);
    const { auto, kicks } = merger(f);
    await auto.pass();
    expect(getAutoMerge(f.db, row.id)).toMatchObject({ state: "sent_back", reason: "verify_failed" });
    expect(f.run().state).toBe("running");
    expect(kicks.length).toBe(1);
    const steer = stageNote(f.db);
    expect(steer).toContain(`step \`bun test\` exited 2. Its log: ${join(f.root, v.id, "1-bun-test.log")}`);
    expect(steer).toContain("FAIL token [redacted] leaked");
    expect(steer).not.toContain("ghp_");
    expect(steer).not.toContain("\u001b");
    expect(steer).not.toContain("line 9\n");
    expect(events(f.db, "verify.sent_back")).toEqual([expect.objectContaining({ verification: v.id, step: "bun test", exit: 2, head: HEAD, path: "auto_merge", auto_merge: row.id })]);

    // The worker's fix at a new head fails the same step: the leader's now.
    redeliver(f, HEAD2, NOW + 10);
    const v2 = verification(f, HEAD2, "auto");
    const row2 = verifying(f, HEAD2, v2);
    fail(f, v2, 0, { exit: 2 });
    await auto.pass();
    expect(getAutoMerge(f.db, row2.id)).toMatchObject({ state: "held", reason: "verify_failed" });
    expect(getAutoMerge(f.db, row2.id)!.detail).toContain(`the same step failed after its send-back at ${HEAD.slice(0, 8)}`);
    expect(f.run().state).toBe("ready");
    expect(openKinds(f.db, "auto_merge_held")).toHaveLength(1);
  });

  test("a different step failing at a new head is sent back again, up to MAX_VERIFY_SEND_BACKS, then escalates", async () => {
    const many = `[projects.web]\nverify = ${JSON.stringify(["s1", "s2", "s3", "s4"])}\nauto_merge = true\n`;
    const f = fixture(many);
    const policy = verifyPolicyId({ steps: ["s1", "s2", "s3", "s4"], binary: null });
    const { auto } = merger(f);
    const heads = ["1", "2", "3", "4"].map((c) => c.repeat(40));
    for (const [i, head] of heads.entries()) {
      redeliver(f, head, NOW + 100 + i);
      const v = tx(f.db, () =>
        insertVerification(f.db, { project_id: "web", pr_url: PR_URL, task_id: "t1", head_sha: head, steps: initialSteps(["s1", "s2", "s3", "s4"]), policy_id: policy, dir: (id) => join(f.root, id), worktree: (id) => join(f.root, id, "wt"), project_path: "/p", source: "daemon", now: NOW + i }),
      );
      const row = verifying(f, head, v);
      fail(f, v, i);
      await auto.pass();
      expect(getAutoMerge(f.db, row.id)!.state).toBe(i < MAX_VERIFY_SEND_BACKS ? "sent_back" : "held");
    }
    expect(events(f.db, "verify.sent_back").map((e) => e.step)).toEqual(["s1", "s2", "s3"]);
    expect(openKinds(f.db, "auto_merge_held")[0]).toContain("after 3 verify send-backs");
  });
});

describe("a leader's own flowryn verify", () => {
  test("a failure at the delivered head sends the ship back with the step and its tail", () => {
    const f = fixture(MANUAL);
    const v = verification(f, HEAD, "cli");
    fail(f, v, 1, { exit: 1 }, "src/a.ts: 1 error\n");
    const kicks: number[] = [];
    const judged = routeManualVerifies({ db: f.db, config: () => f.cfg, now: () => NOW + 500_000, log: () => {}, kickScheduler: () => kicks.push(1) });
    expect(judged).toEqual([v.id]);
    expect(f.run().state).toBe("running");
    expect(kicks.length).toBe(1);
    expect(stageNote(f.db)).toContain("Your leader's verify: the daemon's flowryn verify");
    expect(stageNote(f.db)).toContain("src/a.ts: 1 error");
    expect(events(f.db, "verify.sent_back")).toEqual([expect.objectContaining({ verification: v.id, step: "oxlint", path: "manual" })]);
  });

  test("a failure while the worker still works steers the live worker and carries it at once", async () => {
    const f = fixture(MANUAL, "running");
    const v = verification(f, HEAD, "cli");
    fail(f, v, 0, { exit: 1 });
    const { auto, notified } = merger(f);
    await auto.pass();
    expect(f.run().state).toBe("running");
    const steer = f.db.query("SELECT id, body, decision_id, urgent, end_turn FROM messages WHERE run_id = 'r1'").get() as { id: string; body: string; decision_id: string | null; urgent: number; end_turn: number };
    expect(steer).toMatchObject({ decision_id: null, urgent: 0, end_turn: 0 });
    expect(steer.body).toContain("step `bun test` exited 1");
    expect(notified).toEqual(["r1"]);
    expect(events(f.db, "verify.sent_back")[0]).toMatchObject({ steer: steer.id, path: "manual" });
    // Judged once: the next pass sends nothing more.
    await auto.pass();
    expect(f.db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 1 });
  });

  test("a failure with no live run escalates to the leader with a verify_failed item", async () => {
    const f = fixture(MANUAL, "failed");
    const v = verification(f, HEAD, "cli");
    fail(f, v, 0, { exit: 1 });
    await merger(f).auto.pass();
    expect(f.db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
    const [line] = openKinds(f.db, "verify_failed");
    expect(line).toContain(`flowryn verify show ${v.id}`);
    expect(line).toContain("its run is gone");
    expect(events(f.db, "verify.escalated")).toEqual([expect.objectContaining({ verification: v.id, code: "verify_failed", path: "manual" })]);
  });

  test("a timeout re-runs once as the leader's own request; the second timeout opens verify_failed", async () => {
    const f = fixture(MANUAL);
    const v = verification(f, HEAD, "cli");
    fail(f, v, 0, TIMED_OUT);
    const { auto, kicks } = merger(f);
    await auto.pass();
    const [rerun] = events(f.db, "verify.auto_rerun");
    expect(getRequest(f.db, rerun!.request as string)).toMatchObject({ source: "cli", head_sha: HEAD, path: "/opt/bin", state: "queued" });
    expect(kicks.length).toBe(1);
    expect(f.run().state).toBe("ready");

    const again = verification(f, HEAD, "cli");
    fail(f, again, 0, TIMED_OUT);
    await auto.pass();
    expect(openKinds(f.db, "verify_failed")[0]).toContain("again after one automatic re-run");
    expect(f.run().state).toBe("ready");
  });

  test("the auto-merge's own verifies, a landing train's and older ones are not the manual router's", async () => {
    const f = fixture(MANUAL);
    const auto = verification(f, HEAD, "auto");
    fail(f, auto, 0, { exit: 1 });
    const judged = routeManualVerifies({ db: f.db, config: () => f.cfg, now: () => NOW + 500_000, log: () => {}, kickScheduler: () => {} });
    expect(judged).toEqual([]);
    expect(f.run().state).toBe("ready");
    // A failure from before the first pass's lookback is history, not routed.
    const old = fixture(MANUAL);
    const v = verification(old, HEAD, "cli");
    fail(old, v, 0, { exit: 1 });
    expect(routeManualVerifies({ db: old.db, config: () => old.cfg, now: () => NOW + 60 * 60_000, log: () => {}, kickScheduler: () => {} })).toEqual([]);
  });

  test("a later verify of the same PR supersedes an earlier failure: it is skipped, with its reason", () => {
    const f = fixture(MANUAL);
    const v = verification(f, HEAD, "cli");
    fail(f, v, 0, { exit: 1 });
    verification(f, HEAD, "cli");
    routeManualVerifies({ db: f.db, config: () => f.cfg, now: () => NOW + 500_000, log: () => {}, kickScheduler: () => {} });
    expect(f.run().state).toBe("ready");
    expect(events(f.db, "verify.route_skipped")[0]).toMatchObject({ verification: v.id });
  });
});

describe("the log tail a send-back carries", () => {
  test("control characters and a token are cleaned, and only the last 40 lines kept", () => {
    const dir = tempDir();
    const log = join(dir, "step.log");
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
    writeFileSync(log, `${lines.join("\n")}\n\u001b[1mAuthorization: Bearer abc.def.ghi\u001b[0m\u0000\nkey AKIA${"A".repeat(16)} and sk-${"z".repeat(24)} and github_pat_${"q".repeat(30)}\n`);
    const tail = cleanTail(log);
    expect(tail.split("\n")).toHaveLength(40);
    // Matching control characters is the point.
    // oxlint-disable-next-line no-control-regex
    expect(tail).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
    expect(tail).toContain("Bearer [redacted]");
    expect(tail).not.toContain("abc.def.ghi");
    expect(tail).not.toContain("AKIA");
    expect(tail).not.toContain("sk-zzz");
    expect(tail).not.toContain("github_pat_");
    expect(tail).not.toContain("line 21\n");
  });
});
