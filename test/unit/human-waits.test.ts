import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Args, ReadCtx } from "../../src/api/verbs.ts";
import { composeBriefing } from "../../src/attention/briefing.ts";
import { explanationDetail, openExplanations, sweepExplanations, taskExplanations, type ExplanationRow } from "../../src/attention/explanations.ts";
import { explainHumanWaits } from "../../src/attention/human-waits.ts";
import { openItem } from "../../src/attention/items.ts";
import { parseConfig, type FlowrynConfig } from "../../src/config/config.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import type { ChecksSummary, PullRequest } from "../../src/forge/types.ts";
import { deliveredOf, prEvidenceFrom } from "../../src/lifecycle/delivery.ts";
import { LEADER_RUN_VERBS } from "../../src/lifecycle/leader-verbs.ts";
import { getProject } from "../../src/lifecycle/projects.ts";
import { getRunWithPolicy } from "../../src/lifecycle/runs.ts";
import { checkGate, chooseApproval, type MergeFacts } from "../../src/policy/merge.ts";
import { SCHED_VERBS } from "../../src/sched/verbs.ts";
import { verifyConfig } from "../../src/verify/config.ts";
import { verifyPolicyId } from "../../src/verify/policy.ts";

/**
 * Wait explanations for reviews, decisions and merges
 * (docs/notes/2026-10-29-why-waiting-covers-fy.md): one writer, each
 * scheduler pass, from stored facts only.
 */

const HOME = "/tmp/fw-human-waits";
const MIN = 60_000;
const NOW = new Date(2026, 9, 29, 12, 0, 0).getTime();
const PR = "https://github.com/acme/web/pull/7";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const VERIFY = '[projects.web]\nverify = ["bun test"]\n';

let dir: string;
let db: Db;
let now: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-hwaits-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  now = NOW;
  tx(db, () => {
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', 'https://github.com/acme/web.git', ?1, 'main', 'no-mistakes')").run(dir);
    seedRun("t1", "r1");
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedRun(task: string, run: string, opts: { yolo?: number; sensitive?: number; state?: string } = {}): void {
  db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, sensitive, workflow, created_at) VALUES (?1, 'web', 'ship', 'no-mistakes', ?2, ?3, 'feature', 0)").run(
    task,
    opts.yolo ?? 1,
    opts.sensitive ?? 0,
  );
  db.query(
    `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
     VALUES (?1, ?2, 'claude', '1', ?3, 'idle', 'feature', 'design', ?4, 'b', 'abc', 'h', ?5, ?5)`,
  ).run(run, task, opts.state ?? "running", dir, NOW - 600 * MIN);
}

function pass(config = ""): number {
  return tx(db, () => {
    const n = explainHumanWaits(db, parseConfig(config, HOME), now);
    sweepExplanations(db, now);
    return n;
  });
}

const open = (run = "r1"): ExplanationRow[] => openExplanations(db, run);
const only = (run = "r1"): ExplanationRow => {
  const rows = open(run);
  expect(rows).toHaveLength(1);
  return rows[0]!;
};
const unblock = (row: ExplanationRow) => JSON.parse(row.unblock) as { by: string; action: string }[];
const explainedEvents = () => (db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'run.explained'").get() as { n: number }).n;

function openReview(id = "g1", opened = NOW - 90 * MIN, run = "r1"): void {
  db.query("INSERT INTO gates (id, run_id, stage, kind, review_url, state, opened_at) VALUES (?1, ?2, 'design', 'review', 'http://127.0.0.1:4387/session/abc', 'open', ?3)").run(id, run, opened);
}

function addDecision(id: string, opts: { reserved?: string; defer?: string; gate?: string; created?: number; run?: string; task?: string } = {}): void {
  db.query(
    `INSERT INTO decisions (id, task_id, run_id, question, options, blocking, state, origin, reserved_reason, defer_until, gate_id, created_at)
     VALUES (?1, ?2, ?3, 'Which store?', '["db","file"]', 1, 'open', 'ask', ?4, ?5, ?6, ?7)`,
  ).run(id, opts.task ?? "t1", opts.run ?? "r1", opts.reserved ?? null, opts.defer ?? null, opts.gate ?? null, opts.created ?? NOW - 30 * MIN);
}

function deliver(opts: { at?: number; gateAt?: number } = {}): void {
  db.query("INSERT INTO artifacts (id, task_id, kind, ref, head_sha, created_at) VALUES ('a1', 't1', 'pr', ?1, ?2, ?3)").run(PR, HEAD, opts.at ?? NOW - 120 * MIN);
  db.query("INSERT INTO gates (id, run_id, stage, kind, state, opened_at) VALUES ('g9', 'r1', 'ship', 'merge', 'open', ?1)").run(opts.gateAt ?? NOW - 120 * MIN);
}

function holdItem(at: number): void {
  const { seq } = appendEvent(db, { source: "daemon", kind: "auto_merge.held", runId: "r1", taskId: "t1", ts: at });
  openItem(db, { kind: "auto_merge_held", eventSeq: seq, taskId: "t1", runId: "r1", line: "Auto-merge held", now: at });
}

function checks(red: string[], pending: string[], head = HEAD, notStarted: string[] = []): void {
  const value = { url: PR, number: 7, title: "t", state: "open", draft: false, head, head_ref: "b", merge_sha: null, checks: { state: red.length ? "red" : pending.length ? "pending" : "green", line: "-", red, pending, total: red.length + pending.length + 1, not_started: notStarted }, observed_at: now };
  db.query("INSERT OR REPLACE INTO run_evidence (run_id, source, rank, value, observed_at) VALUES ('r1', 'github', 1, ?1, ?2)").run(JSON.stringify(value), now);
}

function policy(config = VERIFY): string {
  return verifyPolicyId(verifyConfig(parseConfig(config, HOME), "web")!);
}

function verification(id: string, state: string, opts: { started?: number; finished?: number | null } = {}): void {
  db.query(
    `INSERT INTO verifications (id, project_id, pr_url, task_id, head_sha, state, steps, dir, worktree_path, project_path, started_at, finished_at, policy_id)
     VALUES (?1, 'web', ?2, 't1', ?3, ?4, '[]', '/d', '/w', '/p', ?5, ?6, ?7)`,
  ).run(id, PR, HEAD, state, opts.started ?? NOW - 40 * MIN, opts.finished === undefined ? (state === "running" ? null : NOW - 20 * MIN) : opts.finished, policy());
}

const pr = (): PullRequest => ({ number: 7, url: PR, title: "t", state: "open", draft: false, headSha: HEAD, headRef: "b", headRepo: "acme/web", baseRef: "main", mergeSha: null, mergedAt: null }) as PullRequest;
const summary = (red: string[], pending: string[]): ChecksSummary => ({
  state: red.length ? "red" : pending.length ? "pending" : "green",
  checks: [...red.map((name, i) => ({ name, id: i + 1, state: "red" as const, detail: "failure" })), ...pending.map((name) => ({ name, state: "pending" as const, detail: "queued" })), { name: "ok", state: "green" as const, detail: "success" }],
});
const ctx = (): ReadCtx => ({ db, config: parseConfig("", HOME), now, caller: { role: "human", runId: null, taskId: null } });
const briefing = () => composeBriefing(db, { session: null, now, morningHour: 99, ageMs: 3_600_000, markMorning: false }).text;

function gateCode(config: FlowrynConfig, red: string[], pending: string[], notStarted: string[] = []): string {
  const run = getRunWithPolicy(db, "r1")!;
  const project = getProject(db, "web")!;
  const delivered = deliveredOf(db, "t1")!;
  const verify = verifyConfig(config, "web");
  const p = verify ? verifyPolicyId(verify) : null;
  const atHead = p ? (db.query("SELECT * FROM verifications WHERE head_sha = ?1 AND state <> 'running' ORDER BY started_at DESC LIMIT 1").get(HEAD) as never) : null;
  const facts: MergeFacts = {
    run,
    project,
    delivered,
    ref: PR,
    head: HEAD,
    title: "t",
    pr: pr(),
    checks: summary(red, pending),
    remote: HEAD,
    primaryBranch: null,
    primaryDirty: false,
    fastForward: false,
    ...(p ? { local: { notStarted: notStarted.map((name) => red.indexOf(name) + 1), policy: p, atHead: atHead ? { ...(atHead as object), steps: [], tests: null } as never : null, otherPolicyAtHead: null, lastPassed: null } } : {}),
  };
  try {
    checkGate(facts, chooseApproval(db, facts, { caller: { role: "human", runId: null, taskId: null } }, "merge", now));
    return "pass";
  } catch (error) {
    return (error as { code: string }).code;
  }
}

const read = (verbs: { name: string; read?: (c: ReadCtx, a: Args) => { data: Record<string, unknown> } }[], name: string): Record<string, unknown> => verbs.find((v) => v.name === name)!.read!(ctx(), {}).data;

describe("reviews", () => {
  test("an open review gate is one row across many passes, dated when the gate opened, naming you and the page first", () => {
    openReview();
    expect(pass()).toBe(1);
    for (let i = 0; i < 5; i++) {
      now += MIN;
      expect(pass()).toBe(0);
    }
    expect(explainedEvents()).toBe(1);
    const row = only();
    expect(row.kind).toBe("gate");
    expect(row.subject).toBe("g1");
    expect(row.rule).toBe("gate.review");
    expect(row.opened_at).toBe(NOW - 90 * MIN);
    expect(row.reason).toBe("waiting for your design review (g1)");
    expect(unblock(row)).toEqual([
      { by: "captain", action: "answer on the review page http://127.0.0.1:4387/session/abc" },
      { by: "captain", action: "in your shell: flowryn approve t1 --gate design, or flowryn gate changes t1 --body-file -" },
      { by: "leader", action: "flowryn gate pass t1 once you say yes in chat" },
    ]);
  });

  test("a review's own questions are a fact of the gate, not rows of their own", () => {
    openReview();
    addDecision("q1", { gate: "g1", reserved: "the user's" });
    addDecision("q2", { gate: "g1", reserved: "the user's" });
    pass();
    const row = only();
    expect(row.reason).toBe("waiting for your design review (g1) and 2 questions");
    expect(explanationDetail(row, now).facts).toContain("questions open: q1, q2 (observed -)");
  });

  test("while answers on the page fail to reach Flowryn the shell command comes first; a changed failure wording is no new wait", () => {
    openReview();
    pass();
    db.query("UPDATE gates SET channel_failing_since = ?1, channel_reason = 'ECONNREFUSED pid 1' WHERE id = 'g1'").run(NOW - 5 * MIN);
    pass();
    const rows = taskExplanations(db, "t1");
    expect(rows.map((r) => [r.rule, r.closed_by])).toEqual([
      ["gate.review", `superseded by x${rows[1]!.id}`],
      ["gate.review_channel", null],
    ]);
    expect(unblock(rows[1]!)[0]!.action).toStartWith("in your shell: flowryn approve t1 --gate design");
    db.query("UPDATE gates SET channel_reason = 'ECONNREFUSED pid 2' WHERE id = 'g1'").run();
    expect(pass()).toBe(0);
  });

  test("the row closes with the gate's outcome", () => {
    openReview();
    pass();
    db.query("UPDATE gates SET state = 'passed', closed_at = ?1 WHERE id = 'g1'").run(now);
    pass();
    expect(open()).toEqual([]);
    expect(taskExplanations(db, "t1")[0]!.closed_by).toBe("gate passed");
  });
});

describe("decisions", () => {
  test("an open question is the leader's, with the decide line; one reserved for you names you", () => {
    addDecision("q1");
    addDecision("q2", { reserved: "a ship waiting on CI" });
    pass();
    const rows = open().toSorted((a, b) => a.id - b.id);
    expect(rows.map((r) => [r.subject, r.rule, r.reason])).toEqual([
      ["q1", "decision.leader", "waiting for the leader to answer q1 (the worker is blocked)"],
      ["q2", "decision.captain", "waiting for your answer to q2 (the worker is blocked)"],
    ]);
    expect(unblock(rows[0]!)).toEqual([
      { by: "leader", action: "flowryn decide q1 <choice> --rationale -" },
      { by: "captain", action: "the same in your terminal: flowryn decide q1 <choice> --by captain" },
    ]);
    expect(unblock(rows[1]!)).toEqual([{ by: "captain", action: "flowryn decide q2 <choice> --by captain, or tell the leader in chat" }]);
    expect(rows[0]!.opened_at).toBe(NOW - 30 * MIN);
  });

  test("assumption: two open questions on one run stay two rows, and answering one closes only it", () => {
    addDecision("q1");
    addDecision("q2");
    pass();
    pass();
    expect(open()).toHaveLength(2);
    db.query("UPDATE decisions SET state = 'answered', answer = 'db', answered_by = 'leader', answered_at = ?1 WHERE id = 'q1'").run(now);
    pass();
    expect(open().map((r) => r.subject)).toEqual(["q2"]);
    expect(taskExplanations(db, "t1").find((r) => r.subject === "q1")!.closed_by).toBe("answered by leader");
    db.query("UPDATE decisions SET state = 'dismissed' WHERE id = 'q2'").run();
    pass();
    expect(open()).toEqual([]);
    expect(taskExplanations(db, "t1").find((r) => r.subject === "q2")!.closed_by).toBe("dismissed");
  });

  test("a deferred question waits on Flowryn until its date", () => {
    addDecision("q1", { defer: "2026-11-02" });
    pass();
    const row = only();
    expect(row.rule).toBe("decision.deferred");
    expect(unblock(row)[0]).toEqual({ by: "flowryn", action: "shows it again on 2026-11-02" });
    now = new Date(2026, 10, 2, 9, 0).getTime();
    pass();
    expect(only().rule).toBe("decision.leader");
  });
});

describe("merges", () => {
  test("yolo work with no verify steps and green checks waits only for the leader's merge", () => {
    deliver();
    checks([], []);
    pass();
    const row = only();
    expect([row.kind, row.subject, row.rule, row.reason]).toEqual(["merge", "merge", "merge.ready", "ready to merge; waiting for the leader"]);
    expect(unblock(row)).toEqual([
      { by: "leader", action: "flowryn merge t1" },
      { by: "captain", action: "the same in your terminal: flowryn merge t1" },
    ]);
    expect(row.opened_at).toBe(NOW - 120 * MIN);
  });

  test("work that is not yolo, or is sensitive, waits for your approval until there is one at the head", () => {
    db.query("UPDATE task_policy SET yolo = 0 WHERE task_id = 't1'").run();
    deliver();
    pass();
    expect(only().rule).toBe("merge.approval");
    expect(unblock(only())[0]).toEqual({ by: "captain", action: "in your shell: flowryn approve t1" });
    db.query("INSERT INTO approvals (id, task_id, pr_url, head_sha, channel, actor, action, created_at, expires_at) VALUES ('ap1', 't1', ?1, ?2, 'cli-tty', 'me', 'merge', ?3, ?4)").run(PR, HEAD, now, now + 60 * MIN);
    pass();
    expect(only().rule).toBe("merge.ready");
    expect(explanationDetail(only(), now).facts).toContainEqual(expect.stringContaining("approval: ap1"));
    db.query("UPDATE task_policy SET yolo = 1, sensitive = 1 WHERE task_id = 't1'").run();
    db.query("UPDATE approvals SET consumed_at = ?1").run(now);
    pass();
    expect(only().reason).toBe("merge waits for your approval (sensitive work)");
  });

  test("red checks come first, with a waiver line for exactly one; pending checks wait on GitHub", () => {
    deliver();
    checks(["lint"], ["test"]);
    pass();
    expect(only().rule).toBe("merge.checks_red");
    expect(unblock(only())).toEqual([
      { by: "leader", action: "steer the worker to fix lint: flowryn steer t1 --body-file -" },
      { by: "captain", action: "waive it in your shell: flowryn approve t1 --allow-red lint" },
    ]);
    db.query("INSERT INTO approvals (id, task_id, pr_url, head_sha, channel, actor, action, allow_red_check, created_at, expires_at) VALUES ('ap1', 't1', ?1, ?2, 'cli-tty', 'me', 'merge', 'lint', ?3, ?4)").run(PR, HEAD, now, now + 60 * MIN);
    pass();
    expect(only().rule).toBe("merge.checks_pending");
    checks(["lint"], []);
    pass();
    expect(only().rule).toBe("merge.ready");
    expect(unblock(only())[0]).toEqual({ by: "leader", action: "flowryn merge t1 --allow-red lint" });
    db.query("DELETE FROM approvals").run();
    checks([], ["test"]);
    pass();
    expect(only().rule).toBe("merge.checks_pending");
    expect(unblock(only())[0]!.by).toBe("flowryn");
  });

  test("the evidence names the red checks GitHub never started, by the ids the gate read", () => {
    const evidence = prEvidenceFrom(pr(), summary(["lint", "test"], ["e2e"]), now, [2]);
    expect(evidence.checks!.red).toEqual(["lint", "test"]);
    expect(evidence.checks!.not_started).toEqual(["test"]);
  });

  test("evidence for another head is not read as this head's checks", () => {
    deliver();
    checks(["lint"], [], "ffff");
    pass();
    expect(only().rule).toBe("merge.ready");
  });

  test("with verify steps: none yet is the leader's verify; queued and running are Flowryn's; failed names the verification", () => {
    deliver();
    pass(VERIFY);
    expect(only().rule).toBe("merge.verify");
    expect(unblock(only())[0]).toEqual({ by: "leader", action: "flowryn verify t1" });
    db.query(
      `INSERT INTO verify_queue (id, project_id, pr_url, task_id, head_sha, policy_id, source, state, requested_at) VALUES ('vr1', 'web', ?1, 't1', ?2, ?3, 'cli', 'queued', ?4)`,
    ).run(PR, HEAD, policy(), NOW - 10 * MIN);
    pass(VERIFY);
    expect(only().reason).toBe("merge waits on its queued local verify vr1");
    expect(unblock(only())[0]!.by).toBe("flowryn");
    db.query("UPDATE verify_queue SET state = 'started' WHERE id = 'vr1'").run();
    verification("v1", "running");
    pass(VERIFY);
    expect(only().reason).toBe("merge waits on the local verify v1");
    db.query("UPDATE verifications SET state = 'failed', finished_at = ?1 WHERE id = 'v1'").run(NOW - 5 * MIN);
    pass(VERIFY);
    expect(only().rule).toBe("merge.verify_failed");
    expect(unblock(only())[0]!.action).toContain("flowryn verify show v1");
    verification("v2", "passed", { started: NOW - 4 * MIN, finished: NOW - 2 * MIN });
    pass(VERIFY);
    expect(only().rule).toBe("merge.ready");
    expect(only().opened_at).toBe(NOW - 2 * MIN);
    // Each step change superseded the one before: the history keeps them all, one open.
    expect(taskExplanations(db, "t1").map((r) => r.rule)).toEqual(["merge.verify", "merge.verify", "merge.verify", "merge.verify_failed", "merge.ready"]);
  });

  test("a live auto-merge is Flowryn's wait; a held one names the command its item names", () => {
    deliver();
    db.query(
      `INSERT INTO auto_merges (id, run_id, task_id, project_id, ref, head_sha, state, verification_id, created_at, state_since, updated_at)
       VALUES ('am1', 'r1', 't1', 'web', ?1, ?2, 'verifying', 'v1', ?3, ?3, ?3)`,
    ).run(PR, HEAD, NOW - 15 * MIN);
    pass(VERIFY);
    expect(only().rule).toBe("merge.auto");
    expect(only().reason).toBe("auto-merge am1: verify v1 is running");
    expect(unblock(only())[0]!.by).toBe("flowryn");
    db.query("UPDATE auto_merges SET state = 'held', reason = 'verify_timeout', detail = 'bun test hung', next = 'flowryn verify t1, then flowryn merge t1', state_since = ?1").run(NOW - 3 * MIN);
    holdItem(NOW - 3 * MIN);
    pass(VERIFY);
    expect(only().rule).toBe("merge.held");
    expect(unblock(only())).toEqual([
      { by: "leader", action: "flowryn verify t1, then flowryn merge t1" },
      { by: "captain", action: "the same in your terminal: flowryn verify t1, then flowryn merge t1" },
    ]);
    db.query("UPDATE auto_merges SET next = NULL").run();
    pass(VERIFY);
    expect(unblock(only())[0]!.action).toBe("flowryn show t1");
  });

  test("a held auto-merge the leader took over by hand moves on to the merge's own steps", () => {
    deliver();
    db.query(
      `INSERT INTO auto_merges (id, run_id, task_id, project_id, ref, head_sha, state, reason, created_at, state_since, updated_at)
       VALUES ('am1', 'r1', 't1', 'web', ?1, ?2, 'held', 'verify_timeout', ?3, ?3, ?3)`,
    ).run(PR, HEAD, NOW - 15 * MIN);
    holdItem(NOW - 15 * MIN);
    pass(VERIFY);
    expect(only().rule).toBe("merge.held");
    const { state } = db.query("SELECT state FROM runs WHERE id = 'r1'").get() as { state: string };
    db.query("UPDATE runs SET state = 'merging' WHERE id = 'r1'").run();
    pass(VERIFY);
    expect(only().rule).toBe("merge.merging");
    db.query("UPDATE runs SET state = ?1 WHERE id = 'r1'").run(state);
    db.query("UPDATE items SET state = 'resolved', resolved_at = ?1 WHERE kind = 'auto_merge_held'").run(NOW);
    pass(VERIFY);
    expect(only().rule).toBe("merge.verify");
  });

  test("a merge already requested waits on Flowryn, not on the approval it used up", () => {
    db.query("UPDATE task_policy SET yolo = 0 WHERE task_id = 't1'").run();
    deliver();
    checks([], []);
    db.query("INSERT INTO approvals (id, task_id, pr_url, head_sha, channel, actor, action, created_at, expires_at) VALUES ('ap1', 't1', ?1, ?2, 'cli-tty', 'me', 'merge', ?3, ?4)").run(PR, HEAD, now, now + 60 * MIN);
    pass();
    expect(only().rule).toBe("merge.ready");
    db.query("UPDATE approvals SET consumed_at = ?1").run(now);
    db.query("INSERT INTO merges (id, task_id, pr_url, head_sha, approval_id, requested_at, state) VALUES ('mg1', 't1', ?1, ?2, 'ap1', ?3, 'requested')").run(PR, HEAD, now);
    db.query("UPDATE runs SET state = 'merging' WHERE id = 'r1'").run();
    pass();
    const row = only();
    expect([row.rule, row.reason]).toEqual(["merge.merging", "merge mg1 requested; waiting for its result"]);
    expect(unblock(row)[0]!.by).toBe("flowryn");
    expect(taskExplanations(db, "t1").map((r) => r.rule)).toEqual(["merge.ready", "merge.merging"]);
  });

  test("the row closes when the merge gate closes: merged, or sent back", () => {
    deliver();
    pass();
    db.query("UPDATE gates SET state = 'passed', closed_at = ?1 WHERE id = 'g9'").run(now);
    pass();
    expect(open()).toEqual([]);
    expect(taskExplanations(db, "t1")[0]!.closed_by).toBe("merged");
    const closedEvents = db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'run.explanations_closed'").get() as { n: number };
    expect(closedEvents.n).toBe(1);
  });

  test("no merge gate, no row; a merged PR's evidence ends it", () => {
    db.query("INSERT INTO artifacts (id, task_id, kind, ref, head_sha, created_at) VALUES ('a1', 't1', 'pr', ?1, ?2, 1)").run(PR, HEAD);
    pass();
    expect(open()).toEqual([]);
    db.query("INSERT INTO gates (id, run_id, stage, kind, state, opened_at) VALUES ('g9', 'r1', 'ship', 'merge', 'open', 1)").run();
    const value = { url: PR, number: 7, title: "t", state: "merged", draft: false, head: HEAD, head_ref: "b", merge_sha: "m", checks: null, observed_at: now };
    db.query("INSERT INTO run_evidence (run_id, source, rank, value, observed_at) VALUES ('r1', 'github', 1, ?1, ?2)").run(JSON.stringify(value), now);
    pass();
    expect(open()).toEqual([]);
  });
});

describe("assumption: the merge rules agree with the merge gate on the same facts", () => {
  /** checkGate's refusal code for each state, against the rule the writer records for it. */


  const cases: { name: string; config: string; yolo: number; red: string[]; pending: string[]; verified: boolean; waived?: string; notStarted?: string[]; code: string; rule: string }[] = [
    { name: "a red check", config: "", yolo: 1, red: ["lint"], pending: [], verified: false, code: "red_checks", rule: "merge.checks_red" },
    { name: "a red check you waived", config: "", yolo: 0, red: ["lint"], pending: [], verified: false, waived: "lint", code: "pass", rule: "merge.ready" },
    { name: "checks GitHub never started, no verify yet", config: VERIFY, yolo: 1, red: ["lint"], pending: [], verified: false, notStarted: ["lint"], code: "verify_required", rule: "merge.verify" },
    { name: "checks GitHub never started, covered by a passing verify", config: VERIFY, yolo: 1, red: ["lint"], pending: [], verified: true, notStarted: ["lint"], code: "pass", rule: "merge.ready" },
    { name: "a check GitHub never started beside one that failed", config: VERIFY, yolo: 1, red: ["lint", "test"], pending: [], verified: true, notStarted: ["lint"], code: "red_checks", rule: "merge.checks_red" },
    { name: "no verify yet", config: VERIFY, yolo: 1, red: [], pending: [], verified: false, code: "verify_required", rule: "merge.verify" },
    { name: "checks still running", config: VERIFY, yolo: 1, red: [], pending: ["test"], verified: true, code: "checks_pending", rule: "merge.checks_pending" },
    { name: "no approval", config: "", yolo: 0, red: [], pending: [], verified: false, code: "approval_required", rule: "merge.approval" },
    { name: "nothing left", config: VERIFY, yolo: 1, red: [], pending: [], verified: true, code: "pass", rule: "merge.ready" },
  ];
  for (const c of cases) {
    test(c.name, () => {
      db.query("UPDATE task_policy SET yolo = ?1 WHERE task_id = 't1'").run(c.yolo);
      deliver();
      checks(c.red, c.pending, HEAD, c.notStarted);
      if (c.verified) verification("v1", "passed");
      if (c.waived) {
        db.query("INSERT INTO approvals (id, task_id, pr_url, head_sha, channel, actor, action, allow_red_check, created_at, expires_at) VALUES ('ap1', 't1', ?1, ?2, 'cli-tty', 'me', 'merge', ?3, ?4, ?5)").run(PR, HEAD, c.waived, now, now + 60 * MIN);
      }
      expect(gateCode(parseConfig(c.config, HOME), c.red, c.pending, c.notStarted)).toBe(c.code);
      pass(c.config);
      expect(only().rule).toBe(c.rule);
    });
  }
});

describe("the views and the run's end", () => {

  test("fleet and capacity list a review wait; the briefing leaves it to Needs you", () => {
    openReview("g1", NOW - 45 * MIN);
    pass();
    expect(read(LEADER_RUN_VERBS, "fleet").waiting).toEqual([{ task: "t1", waiting: "waiting for your design review (g1)", next: "answer on the review page http://127.0.0.1:4387/session/abc (captain)" }]);
    expect(read(SCHED_VERBS, "capacity").unresolved).toBe("gate 1 (longest 45m, total 45m)");
    expect(briefing()).not.toContain("Waiting (");
  });

  test("an ended run's rows close as run ended, and its waits are not written again", () => {
    openReview();
    addDecision("q1");
    pass();
    db.query("UPDATE runs SET state = 'cancelled' WHERE id = 'r1'").run();
    pass();
    expect(open()).toEqual([]);
    expect(taskExplanations(db, "t1").map((r) => r.closed_by)).toEqual(["run ended", "run ended"]);
    expect(pass()).toBe(0);
  });
});
