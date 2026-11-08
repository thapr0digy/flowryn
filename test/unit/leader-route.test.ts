import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LANE_TABLE, LEADER_ROUTE, LEADER_WAKE_KINDS, openItem, QUESTION_KINDS, RELAY_KINDS, type ItemKind } from "../../src/attention/items.ts";
import { carry } from "../../src/attention/presentations.ts";
import { FOLLOW_UP_BATCH_MAX, followUpBatch } from "../../src/attention/router.ts";
import { inertAttention } from "../../src/attention/services.ts";
import { parseConfig } from "../../src/config/config.ts";
import { DEFAULT_LEADER_TIMING, leaderTiming } from "../../src/config/leader.ts";
import { tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { leaderPush } from "../../src/leader/hooks.ts";
import { syncWakeCeiling, WAKE_CEILING_EVENT } from "../../src/leader/wake-ceiling.ts";
import { claim, getSession, openSession, type LeaderSessionRow } from "../../src/lease/lease.ts";
import { makeHome, type TestHome } from "../helpers/harness.ts";

/**
 * Every new item whose next move is the leader's wakes an idle leader
 * (task no-idle-workers-23, steer m569): one route table, a batch window, no
 * hourly cap, and a runaway ceiling.
 */

let h: TestHome;
let db: Db;
let clock: number;

beforeEach(() => {
  h = makeHome();
  db = h.db();
  clock = Date.now();
});

afterEach(() => {
  db.close();
  h.cleanup();
});

const BATCH = DEFAULT_LEADER_TIMING.action_batch_ms;

function open(kind: ItemKind, line: string, at: number = clock - BATCH): string {
  return tx(db, () => {
    const event = appendEvent(db, { source: "cli", kind: "test.item", payload: {} });
    return openItem(db, { kind, eventSeq: event.seq, line, now: at });
  });
}

function holder(fields: Partial<LeaderSessionRow> = {}, harness: "claude" | "pi" = "claude"): LeaderSessionRow {
  return tx(db, () => {
    const { session } = openSession(db, { harness, pane: "p1", cwd: "/x", now: clock - 60_000 });
    claim(db, session, "vacant", clock - 60_000);
    const set = { proc_pid: 4242, user_inactive_since: clock - 120_000, last_event_at: clock - 60_000, has_ui: 1, ...fields } as Record<string, unknown>;
    const keys = Object.keys(set);
    db.query(`UPDATE leader_sessions SET ${keys.map((k, i) => `${k} = ?${i + 2}`).join(", ")} WHERE session_id = ?1`).run(session, ...(keys.map((k) => set[k]) as (string | number | null)[]));
    return getSession(db, session)!;
  });
}

const ctx = (notify: Record<string, number> = {}, timing: Partial<typeof DEFAULT_LEADER_TIMING> = {}) => ({
  db,
  attention: inertAttention({ notify: () => ({ ...inertAttention().notify(), ...notify }), timing: () => ({ ...DEFAULT_LEADER_TIMING, ...timing }) }),
  config: () => parseConfig("", h.home),
});

describe("the leader route table", () => {
  test("it lists every ItemKind, and only those", () => {
    expect(Object.keys(LEADER_ROUTE).toSorted()).toEqual(Object.keys(LANE_TABLE).toSorted());
  });

  test("info kinds are nobody's move; questions are the question batch's; what unattended mode parked is the user's; every other actionable kind is the leader's", () => {
    const userOnly: readonly ItemKind[] = ["autonomy_parked", "validator_failed", "validator_held"];
    for (const kind of Object.keys(LANE_TABLE) as ItemKind[]) {
      const expected = LANE_TABLE[kind].class === "info" ? "info" : QUESTION_KINDS.includes(kind) ? "question" : userOnly.includes(kind) ? "user" : "act";
      expect(`${kind}:${LEADER_ROUTE[kind]}`).toBe(`${kind}:${expected}`);
    }
  });

  test("the batch kinds are the leader's P1 action kinds: a worker report, a failed check, an unacknowledged steer among them", () => {
    expect(LEADER_WAKE_KINDS).toEqual(expect.arrayContaining(["worker_report", "checks_red", "steer_unacked", "validation_stuck", "pr_conflict", "auto_merge_held", "pr_ready", "worker_idle"]));
    for (const kind of LEADER_WAKE_KINDS) expect(LANE_TABLE[kind].lane).toBe("P1");
    expect(LEADER_WAKE_KINDS).not.toContain("worker_question");
    expect(LEADER_WAKE_KINDS).not.toContain("steer_acked");
    // Unattended mode parks it for the morning brief: no wake (docs/notes/2026-11-05-unattended-mode-one-9e.md).
    expect(LEADER_WAKE_KINDS).not.toContain("autonomy_parked");
  });
});

describe("action items wake an idle leader", () => {
  test("a worker report wakes the idle leader past the retired hourly cap", () => {
    const s = holder();
    const capped = ctx({ max_triggered_turns_per_hour: 3, max_question_wakes_per_hour: 1 });
    for (let n = 1; n <= 4; n++) {
      const id = open("worker_report", `report ${n}`);
      const { push } = leaderPush(capped, s, clock);
      expect(push).toMatchObject({ kind: "follow_up", mode: "waiter", items: [{ id }] });
      tx(db, () => carry(db, { itemId: id, session: s.session_id, turn: s.turn_no + n, path: "waiter", now: clock }));
    }
  });

  test("items inside the batch window share one wake, due when the oldest has waited the window", () => {
    const s = holder();
    const first = open("checks_red", "checks red on t1", clock - 10_000);
    const second = open("worker_report", "a finding", clock - 2_000);
    expect(leaderPush(ctx(), s, clock)).toEqual({ push: null, dueAt: clock - 10_000 + BATCH, ceiling: null });
    const due = leaderPush(ctx(), s, clock - 10_000 + BATCH);
    expect(due.push).toMatchObject({ kind: "follow_up", items: [{ id: first }, { id: second }] });
  });

  test("a busy Pi leader takes action items at once as a continuation: the window only holds back a wake", () => {
    const s = holder({ busy: 1, busy_until: clock + 60_000 }, "pi");
    const id = open("worker_report", "a finding", clock);
    expect(leaderPush(ctx(), s, clock).push).toMatchObject({ kind: "follow_up", mode: "continuation", items: [{ id }] });
  });

  test("while the user is at the composer nothing is pushed; once inactive, or away, the wake goes", () => {
    const active = holder({ user_inactive_since: null });
    const id = open("worker_report", "a finding");
    expect(leaderPush(ctx(), active, clock).push).toBeNull();
    const inactive = { ...active, user_inactive_since: clock - 1_000 };
    expect(leaderPush(ctx(), inactive, clock).push).toMatchObject({ kind: "follow_up", items: [{ id }] });
  });

  test("an info item never wakes the leader", () => {
    const s = holder();
    open("phase_started", "phase 2 started");
    open("steer_acked", "m1 acked");
    expect(leaderPush(ctx(), s, clock).push).toBeNull();
    expect(followUpBatch(db, s.session_id, 0)).toBeNull();
  });

  test("leaving out relay kinds happens before the batch is cut, so a newer action item rides and more counts only action items", () => {
    const s = holder();
    for (let n = 0; n < FOLLOW_UP_BATCH_MAX + 2; n++) open("worker_report", `report ${n}`, clock - 20_000 + n);
    const red = open("checks_red", "checks red on t1", clock - 1_000);
    expect(followUpBatch(db, s.session_id, 0)?.items.map((i) => i.id)).not.toContain(red);
    expect(followUpBatch(db, s.session_id, 0, undefined, RELAY_KINDS)).toMatchObject({ items: [{ id: red }], more: 0 });
  });

  test("the loop guard: an item that woke this session never wakes it again", () => {
    const s = holder();
    const id = open("pr_conflict", "PR conflicts");
    tx(db, () => carry(db, { itemId: id, session: s.session_id, turn: s.turn_no + 1, path: "waiter", now: clock }));
    expect(leaderPush(ctx(), s, clock).push).toBeNull();
  });
});

describe("the runaway ceiling", () => {
  test("[leader] action_batch_ms and wake_ceiling_per_hour are settings, default 60 s and 60", () => {
    expect(DEFAULT_LEADER_TIMING.action_batch_ms).toBe(60_000);
    expect(DEFAULT_LEADER_TIMING.wake_ceiling_per_hour).toBe(60);
    const t = leaderTiming(parseConfig("[leader]\naction_batch_ms = 5000\nwake_ceiling_per_hour = 12\n", h.home));
    expect([t.action_batch_ms, t.wake_ceiling_per_hour]).toEqual([5_000, 12]);
    expect(() => leaderTiming(parseConfig("[leader]\nwake_ceiling_per_hour = 0\n", h.home))).toThrow("positive integer");
  });

  test("at the ceiling nothing starts a turn; one P0 opens with an event, never a second while it is open", () => {
    const s = holder();
    const woke = open("worker_report", "first");
    tx(db, () => carry(db, { itemId: woke, session: s.session_id, turn: s.turn_no + 1, path: "waiter", now: clock }));
    open("worker_report", "second");
    const decision = leaderPush(ctx({}, { wake_ceiling_per_hour: 1 }), s, clock);
    expect(decision).toEqual({ push: null, dueAt: null, ceiling: { started: 1, limit: 1 } });
    const opened = tx(db, () => syncWakeCeiling(db, s.session_id, decision.ceiling, "hook", clock));
    expect(opened).not.toBeNull();
    expect(tx(db, () => syncWakeCeiling(db, s.session_id, decision.ceiling, "hook", clock))).toBeNull();
    const row = db.query("SELECT lane, line FROM items WHERE id = ?1").get(opened!) as { lane: string; line: string };
    expect(row.lane).toBe("P0");
    expect(row.line).toContain("wake_ceiling_per_hour = 1");
    expect((db.query("SELECT COUNT(*) AS n FROM events WHERE kind = ?1").get(WAKE_CEILING_EVENT) as { n: number }).n).toBe(1);
    expect(tx(db, () => syncWakeCeiling(db, s.session_id, null, "hook", clock))).toBeNull();
  });

  test("an open runaway P0 for one session never keeps another session's from opening", () => {
    const hit = { started: 60, limit: 60 };
    const first = tx(db, () => syncWakeCeiling(db, "L-scope-a", hit, "hook", clock));
    expect(first).not.toBeNull();
    expect(tx(db, () => syncWakeCeiling(db, "L-scope-a", hit, "hook", clock))).toBeNull();
    const second = tx(db, () => syncWakeCeiling(db, "L-scope-b", hit, "hook", clock));
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    const line = (db.query("SELECT line FROM items WHERE id = ?1").get(second!) as { line: string }).line;
    expect(line).toContain("Leader session L-scope-b");
    expect((db.query("SELECT COUNT(*) AS n FROM events WHERE kind = ?1").get(WAKE_CEILING_EVENT) as { n: number }).n).toBe(2);
  });

  test("a push that rides a running turn is never held by the ceiling", () => {
    const s = holder({ busy: 1, busy_until: clock + 60_000 }, "pi");
    const woke = open("worker_report", "first");
    tx(db, () => carry(db, { itemId: woke, session: s.session_id, turn: s.turn_no + 1, path: "trigger", now: clock }));
    const id = open("worker_report", "second");
    expect(leaderPush(ctx({}, { wake_ceiling_per_hour: 1 }), s, clock).push).toMatchObject({ mode: "continuation", items: [{ id }] });
  });
});
