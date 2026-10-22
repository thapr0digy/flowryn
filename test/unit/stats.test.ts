import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlowrynError } from "../../src/api/errors.ts";
import type { ReadCtx } from "../../src/api/verbs.ts";
import {
  allWaits,
  answeredAsRecommended,
  dismissedAlone,
  DISMISS_ALONE_MS,
  firstSeqAtOrAfter,
  formatDuration,
  interventions,
  MAX_EVENT_ROWS,
  MAX_WAIT_ROWS,
  parseSince,
  percentile,
  STATS_VERBS,
  steeredBusy,
  summarizeInterventions,
  summarizeWaits,
  unneeded,
  type Scope,
  type Wait,
} from "../../src/attention/stats.ts";
import { dbLine, eventGrowth, MAX_EVENT_DAYS, readLatency, stateDirSizes, tableRows } from "../../src/attention/store-stats.ts";
import { parseConfig } from "../../src/config/config.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { appendEvent, type EventSource } from "../../src/db/events.ts";
import { POLICY_EVENT } from "../../src/upkeep/policy-follow.ts";

/** `flowryn stats` on seeded data with a fixed clock (docs/notes/2026-10-13-measure-waiting-time-na.md). */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 9, 13, 12, 0, 0).getTime();
const SINCE = NOW - 7 * DAY;

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-stats-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  tx(db, () => {
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', '', ?1, 'main', 'local-only'), ('api', '', ?1, 'main', 'local-only')").run(dir);
    const runs = [
      ["t1", "r1", "web", "running"],
      ["t2", "r2", "web", "running"],
      ["t3", "r3", "web", "cancelled"],
      ["t4", "r4", "api", "running"],
    ] as const;
    for (const [task, run, project, state] of runs) addRun(task, run, project, state, state === "cancelled" ? NOW - 2 * HOUR : null);
  });
});

function addRun(task: string, run: string, project: string, state: string, ended: number | null): void {
  db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES (?1, ?2, 'ship', 'local-only', 0, 'fix', 0)").run(task, project);
  db.query(
    `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at, ended_at)
     VALUES (?1, ?2, 'claude', '1', ?3, 'busy', 'fix', 'build', ?4, 'b', 'abc', 'h', ?5, ?6, ?7)`,
  ).run(run, task, state, dir, NOW - 9 * DAY, ended ?? NOW - 9 * DAY, ended);
}

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const taskOf = (run: string) => `t${run.slice(1)}`;

/** Events must be added in time order: the window search assumes ts does not decrease as seq grows. */
function ev(kind: string, ts: number, run: string | null, payload: Record<string, unknown> = {}, source: EventSource = "cli"): number {
  return appendEvent(db, { source, kind, runId: run, taskId: run ? taskOf(run) : null, payload, ts }).seq;
}

function scope(project: string | null = null, since = SINCE): Scope {
  return { since, now: NOW, project, firstSeq: firstSeqAtOrAfter(db, since) };
}

function explanation(run: string, rule: string, opened: number, closed: number | null, closedBy: string | null = closed === null ? null : "granted"): number {
  const kind = rule.split(".")[0]!;
  const result = db
    .query(
      `INSERT INTO explanations (run_id, task_id, stage, kind, rule, reason, facts, unblock, signature, event_seq, opened_at, closed_at, closed_by)
       VALUES (?1, ?2, 'build', ?3, ?4, 'why', '[]', '[]', 'sig', 0, ?5, ?6, ?7)`,
    )
    .run(run, taskOf(run), kind, rule, opened, closed, closedBy);
  return Number(result.lastInsertRowid);
}

function decision(id: string, run: string, created: number | null, answered: number | null, extra: { reserved?: string; gate?: string; recommendation?: string; state?: string } = {}): void {
  db.query(
    `INSERT INTO decisions (id, task_id, run_id, question, options, blocking, state, answered_at, created_at, reserved_reason, gate_id, recommendation)
     VALUES (?1, ?2, ?3, 'q?', '["a","b"]', 0, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).run(id, taskOf(run), run, extra.state ?? (answered === null ? "open" : "answered"), answered, created, extra.reserved ?? null, extra.gate ?? null, extra.recommendation ?? null);
}

function gate(id: string, run: string, kind: "review" | "merge", opened: number, closed: number | null): void {
  db.query("INSERT INTO gates (id, run_id, stage, kind, state, opened_at, closed_at) VALUES (?1, ?2, 'qa', ?3, ?4, ?5, ?6)").run(id, run, kind, closed === null ? "open" : "passed", opened, closed);
}

function item(id: string, run: string, kind: string, opened: number, resolved: number | null, extra: { cls?: "actionable" | "info"; decision?: string; state?: string } = {}): void {
  const seq = ev("item.test", opened, run);
  db.query(
    `INSERT INTO items (id, event_seq, class, lane, kind, task_id, run_id, decision_id, line, state, opened_at, resolved_at)
     VALUES (?1, ?2, ?3, 'P1', ?4, ?5, ?6, ?7, 'line', ?8, ?9, ?10)`,
  ).run(id, seq, extra.cls ?? "actionable", kind, taskOf(run), run, extra.decision ?? null, extra.state ?? (resolved === null ? "open" : "resolved"), opened, resolved);
}

const byReason = (waits: Wait[]) => Object.fromEntries(summarizeWaits(waits, { since: SINCE, now: NOW }).map((r) => [r.reason, r]));

function ctx(config = ""): ReadCtx {
  return { db, config: { ...parseConfig(config, dir), state_dir: dir }, now: NOW, caller: { role: "human", runId: null, taskId: null } };
}

describe("the window", () => {
  test("--since takes minutes, hours, days or a local date, and refuses anything else", () => {
    expect(parseSince("7d", NOW)).toBe(NOW - 7 * DAY);
    expect(parseSince("24h", NOW)).toBe(NOW - DAY);
    expect(parseSince("90m", NOW)).toBe(NOW - 90 * MIN);
    expect(parseSince("2026-10-01", NOW)).toBe(new Date(2026, 9, 1).getTime());
    for (const bad of ["0d", "7w", "d", "2026-02-31", "yesterday"]) expect(() => parseSince(bad, NOW)).toThrow(FlowrynError);
    expect(() => parseSince("2026-10-14", NOW)).toThrow("in the future");
  });

  test("the window's first event is found by binary search on seq, assuming ts does not decrease with it", () => {
    expect(firstSeqAtOrAfter(db, SINCE)).toBe(1);
    const seqs = [10, 20, 20, 30, 40].map((ts) => ev("x", ts, null));
    expect(firstSeqAtOrAfter(db, 0)).toBe(seqs[0]!);
    expect(firstSeqAtOrAfter(db, 20)).toBe(seqs[1]!);
    expect(firstSeqAtOrAfter(db, 21)).toBe(seqs[3]!);
    expect(firstSeqAtOrAfter(db, 41)).toBe(seqs[4]! + 1);
  });

  test("percentiles are nearest rank: the median of an even count is the lower middle value", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.9)).toBe(4);
    expect(percentile([5], 0.9)).toBe(5);
    expect(percentile([], 0.5)).toBeNull();
    expect([formatDuration(45_000), formatDuration(12 * MIN), formatDuration(3.5 * HOUR), formatDuration(2.1 * DAY), formatDuration(null)]).toEqual(["45s", "12m", "3.5h", "2.1d", "-"]);
  });

  test("a wait counts when it ended in the window (in full, even if it began before) or is open now", () => {
    gate("g1", "r1", "review", NOW - 8 * DAY, NOW - 6 * DAY); // began before, ended inside: 2 days
    gate("g2", "r1", "review", NOW - 10 * DAY, NOW - 8 * DAY); // ended before the window
    gate("g3", "r2", "review", NOW - 9 * DAY, null); // open now, begun long before
    const rows = byReason(allWaits(db, scope(), []));
    expect(rows["gate review"]).toMatchObject({ n: 1, median: "2.0d", max: "2.0d", open: 1, oldest: "9.0d g3" });
  });
});

describe("waits by reason", () => {
  test("explanations: a row superseded by one of the same rule continues the wait, even from before the window", () => {
    const head = explanation("r1", "capacity.pools_full", NOW - 8 * DAY, null);
    const mid = explanation("r1", "capacity.pools_full", NOW - 7.5 * DAY, null);
    const tail = explanation("r1", "capacity.pools_full", NOW - 1 * DAY, NOW - 2 * HOUR);
    db.query("UPDATE explanations SET closed_at = ?2, closed_by = ?3 WHERE id = ?1").run(head, NOW - 7.5 * DAY, `superseded by x${mid}`);
    db.query("UPDATE explanations SET closed_at = ?2, closed_by = ?3 WHERE id = ?1").run(mid, NOW - DAY, `superseded by x${tail}`);
    const rows = byReason(allWaits(db, scope(), []));
    expect(rows["capacity.pools_full"]).toMatchObject({ n: 1, max: formatDuration(8 * DAY - 2 * HOUR), open: 0 });
  });

  test("explanations: a successor of another rule ends one wait and starts the next; resume.auto waits for nothing", () => {
    const suspected = explanation("r1", "dialog.suspected", NOW - HOUR, null);
    const confirmed = explanation("r1", "dialog.confirmed", NOW - 50 * MIN, null);
    db.query("UPDATE explanations SET closed_at = ?2, closed_by = ?3 WHERE id = ?1").run(suspected, NOW - 50 * MIN, `superseded by x${confirmed}`);
    explanation("r2", "resume.auto", NOW - HOUR, NOW - HOUR, "resumed");
    const rows = byReason(allWaits(db, scope(), []));
    expect(rows["dialog.suspected"]).toMatchObject({ n: 1, median: "10m", open: 0 });
    expect(rows["dialog.confirmed"]).toMatchObject({ n: 0, open: 1, oldest: `50m x${confirmed}` });
    expect(rows["resume.auto"]).toBeUndefined();
  });

  test("decisions: only you answer a reserved one or a review gate's question; one with no created_at is a gap", () => {
    decision("q1", "r1", NOW - 3 * HOUR, NOW - HOUR, { reserved: "destructive" });
    decision("q2", "r1", NOW - 2 * HOUR, NOW - HOUR, { gate: "g9" });
    decision("q3", "r2", NOW - 30 * MIN, NOW - 20 * MIN);
    decision("q4", "r2", NOW - 40 * MIN, null);
    decision("q5", "r2", null, NOW - MIN);
    decision("q6", "r2", NOW - 9 * DAY, NOW - 8 * DAY);
    const gaps: string[] = [];
    const rows = byReason(allWaits(db, scope(), gaps));
    expect(rows["decision (captain)"]).toMatchObject({ n: 2, median: "60m", max: "2.0h", open: 0 });
    expect(rows["decision (leader)"]).toMatchObject({ n: 1, median: "10m", open: 1, oldest: "40m q4" });
    expect(gaps).toContain("decisions: 1 without created_at (before migration 6) left out of waits");
  });

  test("decisions: one a rule settled waits until the rule's answer, even when you undo it later", () => {
    decision("q1", "r1", NOW - 6 * HOUR, NOW - HOUR);
    ev("decision.settled_by_rule", NOW - 6 * HOUR + MIN, "r1", { decision: "q1", rules: ["review-warning-diff"], answer: "fix" }, "daemon");
    const rows = byReason(allWaits(db, scope(), []));
    expect(rows["decision (rule)"]).toMatchObject({ n: 1, median: "60s", open: 0 });
    expect(rows["decision (leader)"]).toBeUndefined();
  });

  test("gates: an open gate of a run that ended waits for nothing", () => {
    gate("g1", "r3", "merge", NOW - HOUR, null);
    gate("g2", "r1", "merge", NOW - 2 * HOUR, NOW - HOUR);
    const rows = byReason(allWaits(db, scope(), []));
    expect(rows["gate merge"]).toMatchObject({ n: 1, open: 0 });
  });

  test("items: actionable ones only, a dismissal ends the wait, and an item carrying a decision is the decision's", () => {
    item("i1", "r1", "blocked_prompt", NOW - 10 * MIN, NOW - 5 * MIN);
    item("i2", "r1", "worker_report", NOW - 20 * MIN, NOW - 10 * MIN, { state: "dismissed" });
    item("i3", "r1", "progress", NOW - 20 * MIN, null, { cls: "info" });
    item("i4", "r1", "worker_question", NOW - 20 * MIN, null, { decision: "q1" });
    item("i5", "r2", "capacity_wait", NOW - 30 * MIN, null, { state: "presented" });
    const rows = byReason(allWaits(db, scope(), []));
    expect(rows["item blocked_prompt"]).toMatchObject({ n: 1, median: "5m" });
    expect(rows["item worker_report"]).toMatchObject({ n: 1, median: "10m" });
    expect(rows["item capacity_wait"]).toMatchObject({ n: 0, open: 1, oldest: "30m i5" });
    expect(rows["item progress"]).toBeUndefined();
    expect(rows["item worker_question"]).toBeUndefined();
  });

  test("conflict nudges: until the next delivery, or the run's end; open while the run lives, even from before the window", () => {
    ev("run.conflict_nudged", NOW - 8 * DAY, "r2", {}, "github");
    ev("run.conflict_nudged", NOW - 3 * HOUR, "r1", {}, "github");
    ev("run.conflict_nudged", NOW - 3 * HOUR, "r3", {}, "github");
    ev("run.delivered", NOW - 2 * HOUR, "r1");
    const rows = byReason(allWaits(db, scope(), []));
    // r1: 1h to deliver again; r3: cancelled 2h ago, 1h after its nudge; r2: still open.
    expect(rows["conflict nudge"]).toMatchObject({ n: 2, median: "60m", max: "60m", open: 1, oldest: "8.0d t2" });
  });

  test("conflict nudges from before the window count when their run delivered or ended in it; a run ended before the window's do not", () => {
    addRun("t5", "r5", "web", "cleaned", NOW - HOUR);
    addRun("t6", "r6", "web", "failed", NOW - 3 * HOUR);
    addRun("t7", "r7", "web", "cleaned", NOW - 8 * DAY);
    ev("run.conflict_nudged", NOW - 9 * DAY, "r7", {}, "github");
    ev("run.conflict_nudged", NOW - 8 * DAY - HOUR, "r5", {}, "github");
    ev("run.conflict_nudged", NOW - 8 * DAY, "r6", {}, "github");
    ev("run.delivered", NOW - 2 * HOUR, "r5");
    const rows = byReason(allWaits(db, scope(), []));
    // r5: delivered again in the window, 8d - 1h after its nudge; r6: failed in the window without delivering, 8d - 3h after; r7 ended before the window.
    expect(rows["conflict nudge"]).toMatchObject({ n: 2, median: "7.9d", max: "8.0d", open: 0 });
  });

  test("--project keeps one project's waits", () => {
    gate("g1", "r1", "review", NOW - HOUR, NOW - MIN);
    gate("g2", "r4", "review", NOW - HOUR, NOW - MIN);
    expect(byReason(allWaits(db, scope("api"), []))["gate review"]).toMatchObject({ n: 1 });
    expect(byReason(allWaits(db, scope("web"), []))["gate review"]).toMatchObject({ n: 1 });
    expect(byReason(allWaits(db, scope(), []))["gate review"]).toMatchObject({ n: 2 });
  });

  test("a source that reaches its row limit says so in gaps", () => {
    const seq = ev("item.test", NOW - HOUR, "r1");
    const insert = db.query("INSERT INTO items (id, event_seq, class, lane, kind, task_id, run_id, line, state, opened_at) VALUES (?1, ?2, 'actionable', 'P1', 'x', 't1', 'r1', 'l', 'open', ?3)");
    tx(db, () => {
      for (let i = 0; i < MAX_WAIT_ROWS; i += 1) insert.run(`i${i}`, seq, NOW - HOUR);
    });
    const gaps: string[] = [];
    allWaits(db, scope(), gaps);
    expect(gaps).toContain(`items: capped at ${MAX_WAIT_ROWS} rows`);
  });

  test("a source at its row limit keeps its open waits and drops its oldest closed ones", () => {
    const closed = NOW - HOUR;
    const seq = ev("item.test", NOW - 2 * HOUR, "r1");
    tx(db, () => {
      const insertItem = db.query("INSERT INTO items (id, event_seq, class, lane, kind, task_id, run_id, line, state, opened_at, resolved_at) VALUES (?1, ?2, 'actionable', 'P1', 'x', 't1', 'r1', 'l', ?3, ?4, ?5)");
      for (let i = 0; i < MAX_WAIT_ROWS; i += 1) {
        explanation("r1", "capacity.pools_full", closed - MIN, closed);
        decision(`q${i}`, "r1", closed - MIN, closed);
        gate(`g${i}`, "r1", "review", closed - MIN, closed);
        insertItem.run(`i${i}`, seq, "resolved", closed - MIN, closed);
      }
      explanation("r2", "dialog.confirmed", NOW - 2 * DAY, null);
      decision("qopen", "r2", NOW - 2 * DAY, null);
      gate("gopen", "r2", "review", NOW - 2 * DAY, null);
      insertItem.run("iopen", seq, "open", NOW - 2 * DAY, null);
      ev("run.conflict_nudged", NOW - 2 * DAY, "r2", {}, "github");
      for (let i = 0; i < MAX_WAIT_ROWS; i += 1) ev("run.conflict_nudged", NOW - 3 * HOUR, "r3", {}, "github");
    });
    const gaps: string[] = [];
    const rows = byReason(allWaits(db, scope(), gaps));
    for (const reason of ["dialog.confirmed", "decision (leader)", "gate review", "item x", "conflict nudge"]) {
      expect({ reason, open: rows[reason]?.open, oldest: rows[reason]?.oldest.split(" ")[0] }).toEqual({ reason, open: 1, oldest: "2.0d" });
    }
    for (const source of ["wait explanations", "decisions", "gates", "items", "conflict nudges"]) expect(gaps).toContain(`${source}: capped at ${MAX_WAIT_ROWS} rows`);
  });
});

describe("interventions", () => {
  test("each action counted by who took it; Flowryn's own events are not interventions", () => {
    decision("q1", "r1", NOW - 2 * HOUR, NOW - 90 * MIN);
    const t = NOW - HOUR;
    ev("decision.answered", t, "r1", { decision: "q1", choice: "a", by: "captain", via: "claude-chat" });
    ev("decision.answered", t + 1, "r1", { decision: "q1", choice: "a", by: "leader", via: "leader" });
    ev("item.dismissed", t + 2, "r1", { item: "i1", kind: "worker_idle", by: "leader" });
    ev("gate.passed", t + 3, "r1", { gate: "g1", stage: "qa", channel: "cli-tty" });
    ev("gate.passed", t + 4, "r1", { gate: "g2", kind: "merge" });
    ev("gate.changes", t + 5, "r1", { gate: "g3", stage: "qa", by: "leader" });
    ev("gate.changes", t + 6, "r1", { gate: "g4", kind: "merge" });
    ev("run.declined", t + 7, "r1", { by: "human" });
    ev("operation.requested", t + 8, "r1", { kind: "cancel", by: "leader" });
    ev("operation.requested", t + 9, "r1", { kind: "launch", by: "scheduler" }, "daemon");
    ev("run.resume_requested", t + 10, "r1", { by: "leader" });
    ev("run.interrupted", t + 11, "r1", { ok: true }, "daemon");
    ev("divergence.resolved", t + 12, "r1", { by: "leader" });
    ev("divergence.resolved", t + 13, "r1", { by: "run.delivered" }, "reconciler");
    ev("sched.usage_resumed", t + 14, null, {});
    ev("sched.usage_resumed", t + 15, null, {}, "daemon");
    ev("sched.quota_override", t + 16, null, {});
    db.query("INSERT INTO approvals (id, task_id, pr_url, head_sha, channel, actor, action, created_at, expires_at) VALUES ('a1', 't1', 'u', 'h', 'board', 'me', 'merge', ?1, ?1), ('a2', 't1', 'u', 'h', 'yolo', 'me', 'merge', ?1, ?1)").run(t);
    const rows = summarizeInterventions(interventions(db, scope(), []));
    expect(rows).toEqual(
      expect.arrayContaining([
        { action: "answer", by: "you via claude-chat", n: 1 },
        { action: "answer", by: "leader", n: 1 },
        { action: "dismiss", by: "leader", n: 1 },
        { action: "gate pass", by: "cli-tty", n: 1 },
        { action: "gate changes", by: "leader", n: 1 },
        { action: "decline", by: "you", n: 1 },
        { action: "cancel", by: "leader", n: 1 },
        { action: "resume", by: "leader", n: 1 },
        { action: "interrupt", by: "-", n: 1 },
        { action: "divergence resolve", by: "leader", n: 1 },
        { action: "capacity resume", by: "you", n: 2 },
        { action: "approve merge", by: "board", n: 1 },
      ]),
    );
    expect(rows.reduce((sum, r) => sum + r.n, 0)).toBe(13);
  });

  test("a rule's answer is Flowryn's own; your undo of it is yours", () => {
    const t = NOW - HOUR;
    ev("decision.answered", t, "r1", { decision: "q1", choice: "fix", by: "policy", via: "rule:lint-added-file" });
    ev("decision.overridden", t + 1, "r1", { decision: "q1", from: "fix", rule: "rule:lint-added-file", choice: "approve", by: "captain", via: "cli-tty" });
    expect(summarizeInterventions(interventions(db, scope(), []))).toEqual([{ action: "answer", by: "you via cli-tty", n: 1 }]);
  });

  test("steers: the leader's and yours, not Flowryn's stage-start or policy-follow steers (matched by the id they name), nor an answer's", () => {
    const t = NOW - HOUR;
    ev("steer.created", t, "r1", { steer: "m1", decision: null });
    ev("steer.created", t + 1, "r1", { steer: "m2", decision: null });
    ev("item.test", t + 1, "r2", {}, "daemon");
    ev("stage.started", t + 1, "r1", { stage: "qa", steer: "m2" }, "daemon");
    ev("steer.created", t + 2, "r1", { steer: "m3", decision: null });
    ev("run.liveness", t + 2, "r1", { from: "busy", to: "idle" }, "hook");
    ev(POLICY_EVENT, t + 2, "r1", { via: "steer", steer: "m3" }, "daemon");
    ev("steer.created", t + 3, "r1", { steer: "m4", decision: "q1" });
    ev("steer.created", t + 4, "r1", { steer: "m5", decision: null });
    ev("stage.started", t + 4, "r1", { stage: "qa", steer: "m9" }, "daemon");
    ev("steer.created", t + 5, "r1", { steer: "m6", decision: null });
    ev("item.test", t + 5, "r1", { steer: "m6" }, "daemon");
    ev("stage.started", t + 5, "r1", { stage: "qa", steer: null }, "daemon");
    const steers = interventions(db, scope(), []).filter((i) => i.action === "steer");
    expect(steers.map((s) => s.payload.steer)).toEqual(["m1", "m5", "m6"]);
  });

  test("the steers Flowryn names, at their row limit, say so in gaps", () => {
    tx(db, () => {
      for (let i = 0; i < MAX_EVENT_ROWS; i += 1) ev("stage.started", NOW - HOUR, "r1", { stage: "qa", steer: `m${i}` }, "daemon");
    });
    const gaps: string[] = [];
    interventions(db, scope(), gaps);
    expect(gaps).toContain(`stage-start and policy steer events: capped at ${MAX_EVENT_ROWS} rows`);
  });

  test("events before the window and of other projects are left out", () => {
    ev("item.dismissed", NOW - 8 * DAY, "r1", { kind: "x", by: "leader" });
    ev("item.dismissed", NOW - HOUR, "r4", { kind: "x", by: "leader" });
    ev("item.dismissed", NOW - HOUR + 1, "r1", { kind: "x", by: "leader" });
    expect(interventions(db, scope(), []).length).toBe(2);
    expect(interventions(db, scope("web"), []).length).toBe(1);
  });
});

describe("unneeded: three rules", () => {
  test("U1: a dismissal with no other action on its task within 10 minutes", () => {
    const t = NOW - HOUR;
    ev("item.dismissed", t, "r1", { kind: "worker_report", by: "leader" });
    ev("item.dismissed", t, "r2", { kind: "worker_idle", by: "leader" });
    ev("steer.created", t + DISMISS_ALONE_MS, "r2", { steer: "m1", decision: null });
    ev("item.dismissed", t + DISMISS_ALONE_MS + 1, "r4", { kind: "worker_report", by: "leader" });
    ev("run.resume_requested", t + 2 * DISMISS_ALONE_MS + 2, "r4", { by: "leader" });
    const u1 = dismissedAlone(interventions(db, scope(), []), NOW);
    expect(u1.of).toBe(3);
    expect(u1.matched.map((d) => d.task_id)).toEqual(["t1", "t4"]);
  });

  test("U1: a dismissal whose 10 minutes have not ended by now is not counted", () => {
    ev("item.dismissed", NOW - DISMISS_ALONE_MS, "r1", { kind: "worker_report", by: "leader" });
    ev("item.dismissed", NOW - MIN, "r2", { kind: "worker_report", by: "leader" });
    const u1 = dismissedAlone(interventions(db, scope(), []), NOW);
    expect(u1.of).toBe(1);
    expect(u1.matched.map((d) => d.task_id)).toEqual(["t1"]);
  });

  test("U1: a dismissal of an item with no task (a system alert) is not judged, and the gaps say how many", () => {
    const t = NOW - HOUR;
    ev("item.dismissed", t, null, { kind: "nomistakes_down", by: "leader" });
    ev("item.dismissed", t + 1, null, { kind: "forge_unavailable", by: "human" });
    ev("item.dismissed", t + 2, "r1", { kind: "worker_report", by: "leader" });
    const list = interventions(db, scope(), []);
    expect(dismissedAlone(list, NOW)).toMatchObject({ of: 1, taskless: 2 });
    const gaps: string[] = [];
    const u1 = unneeded(db, scope(), list, gaps).find((r) => r.rule === "U1 dismissed alone");
    expect(u1).toMatchObject({ n: 1, of: 1, detail: "worker_report 1" });
    expect(gaps).toContain("dismissed alone: 2 dismissals of items with no task (system alerts) left out: no recorded action can follow them");
    expect(summarizeInterventions(list).find((r) => r.action === "dismiss" && r.by === "leader")).toMatchObject({ n: 2 });
  });

  test("U1: an item closed on read is neither a dismissal nor a follow-up; the detail counts it apart", () => {
    const t = NOW - HOUR;
    ev("item.read", t - 1, "r1", { item: "i1", kind: "worker_report", status: "finding", by: "leader", form: "item" });
    ev("item.dismissed", t, "r1", { kind: "worker_report", by: "leader" });
    ev("item.read", t + MIN, "r1", { item: "i2", kind: "worker_report", status: "finding", by: "leader", form: "item" });
    ev("item.read", t + 2 * MIN, "r4", { item: "i3", kind: "report_ready", status: null, by: "leader", form: "run-full" });
    const list = interventions(db, scope(), []);
    expect(list.map((i) => i.action)).toEqual(["dismiss"]);
    expect(dismissedAlone(list, NOW)).toMatchObject({ of: 1, matched: [expect.objectContaining({ task_id: "t1" })] });
    const u1 = unneeded(db, scope(), list, []).find((r) => r.rule === "U1 dismissed alone");
    expect(u1).toMatchObject({ n: 1, of: 1, detail: "worker_report 1; closed on read, not dismissed: worker_report 2, report_ready 1" });
    const web = unneeded(db, scope("web"), interventions(db, scope("web"), []), []).find((r) => r.rule === "U1 dismissed alone");
    expect(web!.detail).toBe("worker_report 1; closed on read, not dismissed: worker_report 2");
  });

  test("U2: a non-urgent steer to a busy run that had no open actionable item", () => {
    const t = NOW - HOUR;
    ev("run.liveness", t, "r1", { from: "idle", to: "busy" }, "hook");
    ev("run.liveness", t, "r2", { from: "busy", to: "idle" }, "hook");
    ev("run.liveness", t, "r4", { from: "idle", to: "busy" }, "hook");
    item("i1", "r4", "steer_unacked", t, null);
    ev("steer.created", t + MIN, "r1", { steer: "m1", decision: null });
    ev("steer.created", t + MIN, "r1", { steer: "m2", decision: null, urgent: true });
    ev("steer.created", t + MIN, "r2", { steer: "m3", decision: null });
    ev("steer.created", t + MIN, "r4", { steer: "m4", decision: null });
    const list = interventions(db, scope(), []);
    const u2 = steeredBusy(db, scope(), list, []);
    expect(u2.of).toBe(4);
    expect(u2.matched.map((s) => s.payload.steer)).toEqual(["m1"]);
  });

  test("U3: an answer equal to its decision's recommendation, split by who was asked", () => {
    decision("q1", "r1", NOW - 3 * HOUR, NOW - HOUR, { reserved: "destructive", recommendation: "a" });
    decision("q2", "r1", NOW - 3 * HOUR, NOW - HOUR, { recommendation: "a" });
    decision("q3", "r1", NOW - 3 * HOUR, NOW - HOUR);
    ev("decision.answered", NOW - HOUR, "r1", { decision: "q1", choice: "a", by: "captain" });
    ev("decision.answered", NOW - HOUR, "r1", { decision: "q2", choice: "b", by: "leader" });
    ev("decision.answered", NOW - HOUR, "r1", { decision: "q3", choice: "a", by: "leader" });
    const u3 = answeredAsRecommended(db, interventions(db, scope(), []));
    expect(u3).toEqual({ matched: [{ asked: "captain" }], of: 2 });
  });
});

describe("store growth", () => {
  test("events' MAX(seq) is its row count: append-only, so no gaps", () => {
    for (let i = 0; i < 25; i += 1) ev("x", NOW - i, null);
    const events = tableRows(db).find((t) => t.table === "events")!;
    expect(events.rows).toBe((db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n);
    expect(tableRows(db)[0]!.table).toBe("events");
  });

  test("the window's events by UTC day and its largest kinds, with payload bytes", () => {
    ev("old", NOW - 8 * DAY, null);
    ev("a", Date.UTC(2026, 9, 11, 23, 0), null, { x: 1 });
    ev("a", Date.UTC(2026, 9, 12, 1, 0), null, { x: 1 });
    ev("b", Date.UTC(2026, 9, 12, 2, 0), null);
    const growth = eventGrowth(db, scope(), []);
    expect(growth.events_per_day_utc).toEqual([
      { day: "2026-10-11", n: 1, bytes: "7 B" },
      { day: "2026-10-12", n: 2, bytes: "9 B" },
    ]);
    expect(growth.event_kinds).toEqual([
      { kind: "a", n: 2, bytes: "14 B" },
      { kind: "b", n: 1, bytes: "2 B" },
    ]);
  });

  test("events per day keep the newest days, with a gap line at the cap", () => {
    const since = NOW - (MAX_EVENT_DAYS + 5) * DAY;
    for (let d = MAX_EVENT_DAYS + 4; d >= 0; d -= 1) ev("a", NOW - d * DAY, null);
    const gaps: string[] = [];
    const days = eventGrowth(db, scope(null, since), gaps).events_per_day_utc;
    expect(days.length).toBe(MAX_EVENT_DAYS);
    expect(days.at(-1)!.day).toBe(new Date(NOW).toISOString().slice(0, 10));
    expect(days[0]!.day < days.at(-1)!.day).toBe(true);
    expect(gaps).toEqual([`events per day: only the newest ${MAX_EVENT_DAYS} days are listed`]);
    expect(eventGrowth(db, scope(), []).events_per_day_utc.length).toBeLessThan(MAX_EVENT_DAYS);
  });

  test("events per day with exactly the cap's days list them all, with no gap line", () => {
    const since = NOW - MAX_EVENT_DAYS * DAY;
    for (let d = MAX_EVENT_DAYS - 1; d >= 0; d -= 1) ev("a", NOW - d * DAY, null);
    const gaps: string[] = [];
    const days = eventGrowth(db, scope(null, since), gaps).events_per_day_utc;
    expect(days.length).toBe(MAX_EVENT_DAYS);
    expect(days[0]!.day).toBe(new Date(NOW - (MAX_EVENT_DAYS - 1) * DAY).toISOString().slice(0, 10));
    expect(gaps).toEqual([]);
  });

  test("the fleet and brief reads are timed through their own verbs", () => {
    const latency = readLatency(ctx());
    expect(latency.map((l) => l.read)).toEqual(["fleet", "brief"]);
    for (const l of latency) expect(l.median).toMatch(/^\d+\.\d ms$/);
    expect(readLatency(ctx(), [], ["fleet"])).toEqual([{ read: "fleet", median: "no such read" }]);
  });

  test("the database line has its files and SQLite's page accounting; an in-memory one says so", () => {
    expect(dbLine(db)).toMatch(/^db \d.* · wal .* · shm .* · \d+ pages × \d+ B \(.*\), \d+ free$/);
    const memory = openDb(":memory:");
    expect(dbLine(memory)).toStartWith("in memory · ");
    memory.close();
  });

  test("the state directory walk: bytes and files per entry, symlinks not followed, a capped walk marked", () => {
    const state = join(dir, "state");
    mkdirSync(join(state, "logs", "deep"), { recursive: true });
    writeFileSync(join(state, "logs", "a.log"), "x".repeat(100));
    writeFileSync(join(state, "logs", "deep", "b.log"), "x".repeat(50));
    writeFileSync(join(state, "flowryn.db"), "x".repeat(10));
    symlinkSync("/usr", join(state, "bin"));
    expect(stateDirSizes(state, [])).toEqual([
      { entry: "logs", bytes: "150 B", files: 2 },
      { entry: "flowryn.db", bytes: "10 B", files: 1 },
      // The link itself: its size is the length of "/usr", not the tree it points at.
      { entry: "bin", bytes: "4 B", files: 1 },
    ]);
    const gaps: string[] = [];
    const capped = stateDirSizes(state, gaps, 2);
    expect(capped.some((e) => e.bytes.startsWith("≥"))).toBe(true);
    expect(gaps[0]).toContain("the walk stopped at 2 entries");
    const missing: string[] = [];
    expect(stateDirSizes(join(dir, "nope"), missing)).toEqual([]);
    expect(missing[0]).toContain("state_dir");
  });
});

describe("the verb", () => {
  const stats = STATS_VERBS.find((v) => v.name === "stats")!;

  test("one reply: window, waits, interventions, unneeded, store, gaps and the time each section took", () => {
    gate("g1", "r1", "review", NOW - HOUR, NOW - MIN);
    ev("item.dismissed", NOW - HOUR, "r1", { kind: "worker_idle", by: "leader" });
    const data = stats.read!(ctx(), { project: "web" }).data;
    expect(Object.keys(data)).toEqual(["window", "waits", "interventions", "unneeded", "store", "gaps", "took"]);
    expect(data.window).toEqual({ since: "2026-10-06 12:00 (7d)", until: "2026-10-13 12:00", project: "web" });
    expect(data.waits).toEqual([{ reason: "gate review", n: 1, median: "59m", p90: "59m", max: "59m", open: 0, oldest: "-" }]);
    expect(data.interventions).toEqual([{ action: "dismiss", by: "leader", n: 1 }]);
    expect((data.unneeded as { rule: string }[]).map((u) => u.rule)).toEqual(["U1 dismissed alone", "U2 steer to a busy run", "U3 answered as recommended"]);
    expect(Object.keys(data.took as object)).toEqual(["window", "waits", "interventions", "store"]);
    expect((data.gaps as string[])[0]).toContain("record no caller");
  });

  test("an unknown project is not found; a window past the explanations' retention is a gap", () => {
    expect(() => stats.read!(ctx(), { project: "nope" })).toThrow("no project nope");
    const gaps = stats.read!(ctx(), { since: "40d" }).data.gaps as string[];
    expect(gaps.some((g) => g.includes("pruned ([upkeep] explanations_keep_days)"))).toBe(true);
    expect((stats.read!(ctx(), {}).data.gaps as string[]).some((g) => g.includes("pruned"))).toBe(false);
  });
});
