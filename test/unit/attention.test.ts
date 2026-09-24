import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { composeBriefing, readOnlyBanner } from "../../src/attention/briefing.ts";
import { openItem, type ItemKind } from "../../src/attention/items.ts";
import { NotifyPump } from "../../src/attention/notify.ts";
import { acceptOffer, carry, confirmTurn, loseCarried, offer, releaseOffer } from "../../src/attention/presentations.ts";
import { composeDigest, DIGEST_HEADER, digestCandidates, openActionable, p0Candidate, p0Line } from "../../src/attention/router.ts";
import { syncOverdueTodos } from "../../src/attention/todos-due.ts";
import { parseConfig, type FlowrynConfig } from "../../src/config/config.ts";
import { tx, type Db, getMeta } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { writeSnapshot } from "../../src/journal/snapshot.ts";
import type { BacklogTask } from "../../src/journal/tasks-axi.ts";
import { claim, openSession } from "../../src/lease/lease.ts";
import { localDate } from "../../src/lifecycle/dates.ts";
import { makeHome, type TestHome } from "../helpers/harness.ts";

const DAY = 86_400_000;
const AGE = DAY;

let h: TestHome;
let db: Db;

beforeEach(() => {
  h = makeHome();
  db = h.db();
  tx(db, () => {
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode, priority) VALUES ('hot', 'u', '/h', 'main', 'local-only', 0), ('cold', 'u', '/c', 'main', 'local-only', 3)").run();
    for (const [taskId, project] of [
      ["hot-a", "hot"],
      ["cold-a", "cold"],
    ] as const) {
      db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES (?1, ?2, 'ship', 'local-only', 0, 'fix', 1)").run(taskId, project);
    }
  });
});

afterEach(() => {
  db.close();
  h.cleanup();
});

function open(kind: ItemKind, line: string, opts: { task?: string; at?: number; due?: string } = {}): string {
  return tx(db, () => {
    const event = appendEvent(db, { source: "cli", kind: "test.item", payload: {} });
    return openItem(db, { kind, eventSeq: event.seq, line, taskId: opts.task ?? null, due: opts.due ?? null, now: opts.at ?? Date.now() });
  });
}

function task(id: string, state: BacklogTask["state"], extra: Partial<BacklogTask> = {}): BacklogTask {
  return { id, title: id, state, kind: null, repo: null, priority: null, body: "", created: null, closed: null, deps: [], hold: null, links: [], ...extra };
}

describe("lane ordering (design section 9)", () => {
  test("P0 first; within a lane an aged actionable item, then project priority, then due date, then age", () => {
    const now = Date.now();
    const coldOld = open("pr_ready", "cold old", { task: "cold-a", at: now - 60_000 });
    const hotNew = open("pr_ready", "hot new", { task: "hot-a", at: now - 1_000 });
    const aged = open("worker_question", "aged cold", { task: "cold-a", at: now - 2 * DAY });
    const dueLate = open("overdue_todo", "due later", { due: "2026-09-20", at: now - 5_000 });
    const dueEarly = open("overdue_todo", "due earlier", { due: "2026-09-10", at: now - 1_000 });
    const p0 = open("failure_needs_you", "p0", { at: now });
    const info = open("yolo_merged", "info", { at: now });
    const ids = openActionable(db, now, AGE).map((i) => i.id);
    expect(ids).toEqual([p0, aged, hotNew, dueEarly, dueLate, coldOld]);
    expect(ids).not.toContain(info);
  });
});

describe("the digest and the P0 line", () => {
  test("at most 5 lines: a header and four items, or three and +N more", () => {
    const now = Date.now();
    const ids = [1, 2, 3, 4].map((n) => open("report_ready", `report ${n}`, { at: now + n }));
    const four = composeDigest(digestCandidates(db, "L1", now, AGE))!;
    expect(four.text.split("\n")).toEqual([DIGEST_HEADER, ...ids.map((id, n) => `- [${id}] report ${n + 1}`)]);
    open("report_ready", "report 5", { at: now + 5 });
    const five = composeDigest(digestCandidates(db, "L1", now, AGE))!;
    expect(five.text.split("\n")).toHaveLength(5);
    expect(five.text.split("\n").at(-1)).toBe("+2 more: flowryn fleet");
    expect(five.shown).toHaveLength(3);
  });

  test("stays under 2,000 characters however long the lines", () => {
    for (let n = 0; n < 4; n++) open("report_ready", "x".repeat(600));
    expect(composeDigest(digestCandidates(db, "L1", Date.now(), AGE))!.text.length).toBeLessThan(2_000);
  });

  test("the P0 line is one line of at most 200 characters that names flowryn show", () => {
    const id = open("failure_needs_you", `Worker cannot finish ${"z".repeat(300)}`);
    const line = p0Line({ id, line: (db.query("SELECT line FROM items WHERE id = ?1").get(id) as { line: string }).line });
    expect(line.length).toBeLessThanOrEqual(200);
    expect(line).toStartWith(`Flowryn P0 [${id}]: `);
    expect(line).toEndWith(`Details: flowryn show ${id}`);
    expect(line).not.toContain("\n");
  });
});

describe("presentations (design section 9)", () => {
  test("carried, then presented only by the same session's turn end; the digest never repeats it to that session", () => {
    const id = open("report_ready", "r");
    tx(db, () => carry(db, { itemId: id, session: "L1", turn: 1, path: "digest", now: 1 }));
    expect(digestCandidates(db, "L1", Date.now(), AGE)).toEqual([]);
    tx(db, () => confirmTurn(db, "L1", 1, 2));
    expect(db.query("SELECT state FROM presentations WHERE item_id = ?1").get(id)).toEqual({ state: "presented" });
    expect(db.query("SELECT state FROM items WHERE id = ?1").get(id)).toEqual({ state: "presented" });
    expect(digestCandidates(db, "L1", Date.now(), AGE)).toEqual([]);
    expect(digestCandidates(db, "L2", Date.now(), AGE).map((i) => i.id)).toEqual([id]);
  });

  test("a turn with no turn end loses its carries, and an informational item drops after three", () => {
    const id = open("yolo_merged", "merged");
    for (const turn of [1, 2, 3]) {
      expect(digestCandidates(db, "L1", Date.now(), AGE).map((i) => i.id)).toEqual([id]);
      tx(db, () => carry(db, { itemId: id, session: "L1", turn, path: "digest", now: turn }));
      tx(db, () => loseCarried(db, "L1", turn + 1, turn));
    }
    expect(db.query("SELECT state, attempts FROM items WHERE id = ?1").get(id)).toEqual({ state: "dropped", attempts: 3 });
    expect(digestCandidates(db, "L1", Date.now(), AGE)).toEqual([]);
  });

  test("a P0 is leased to one push path at a time, across sessions", () => {
    const id = open("failure_needs_you", "p0");
    expect(tx(db, () => carry(db, { itemId: id, session: "L1", turn: 1, path: "continuation", now: 1 }))).toBe(true);
    expect(p0Candidate(db, "L2", Date.now(), AGE)).toBeNull();
    expect(tx(db, () => carry(db, { itemId: id, session: "L2", turn: 1, path: "waiter", now: 1 }))).toBe(false);
    expect(tx(db, () => offer(db, { itemId: id, session: "L2", turn: 1, path: "trigger", now: 1 }))).toBe(false);
    tx(db, () => confirmTurn(db, "L1", 1, 2));
    // Presented to L1; another session may still be pushed it once, which the briefing makes moot in practice.
    expect(p0Candidate(db, "L1", Date.now(), AGE)).toBeNull();
    expect(p0Candidate(db, "L2", Date.now(), AGE)?.id).toBe(id);
  });

  test("a carry or offer lost before its turn started is recorded again for that turn, keeping the push lease", () => {
    const id = open("failure_needs_you", "p0");
    // /clear before the first prompt: the startup briefing's carry for turn 1 is lost and the new briefing carries it for turn 1 again.
    expect(tx(db, () => carry(db, { itemId: id, session: "L1", turn: 1, path: "briefing", now: 1 }))).toBe(true);
    tx(db, () => loseCarried(db, "L1", null, 2));
    expect(tx(db, () => carry(db, { itemId: id, session: "L1", turn: 1, path: "briefing", now: 3 }))).toBe(true);
    expect(db.query("SELECT path, state, carried_at FROM presentations WHERE item_id = ?1").all(id)).toEqual([{ path: "briefing", state: "carried", carried_at: 3 }]);
    expect(p0Candidate(db, "L1", Date.now(), AGE)).toBeNull();
    expect(tx(db, () => carry(db, { itemId: id, session: "L1", turn: 1, path: "waiter", now: 4 }))).toBe(false);
    // A Pi offer lost to a session switch is offered again, unless another session holds the item's push lease.
    tx(db, () => offer(db, { itemId: id, session: "L2", turn: 1, path: "trigger", now: 5 }));
    tx(db, () => loseCarried(db, "L2", null, 6));
    expect(tx(db, () => carry(db, { itemId: id, session: "L3", turn: 1, path: "waiter", now: 7 }))).toBe(true);
    expect(tx(db, () => offer(db, { itemId: id, session: "L2", turn: 1, path: "trigger", now: 8 }))).toBe(false);
    tx(db, () => confirmTurn(db, "L3", 1, 9));
    expect(tx(db, () => offer(db, { itemId: id, session: "L2", turn: 1, path: "trigger", now: 10 }))).toBe(true);
    expect(db.query("SELECT state FROM presentations WHERE item_id = ?1 AND session_id = 'L2'").get(id)).toEqual({ state: "offered" });
  });

  test("an offer holds the lease, is never confirmed by a turn end, and is accepted or released by the extension", () => {
    const id = open("failure_needs_you", "p0");
    tx(db, () => offer(db, { itemId: id, session: "L1", turn: 4, path: "continuation", now: 1 }));
    expect(p0Candidate(db, "L1", Date.now(), AGE)).toBeNull();
    tx(db, () => confirmTurn(db, "L1", 9, 2));
    expect(db.query("SELECT state FROM presentations WHERE item_id = ?1").get(id)).toEqual({ state: "offered" });
    tx(db, () => releaseOffer(db, id, "L1"));
    expect(p0Candidate(db, "L1", Date.now(), AGE)?.id).toBe(id);
    tx(db, () => offer(db, { itemId: id, session: "L1", turn: 4, path: "continuation", now: 3 }));
    tx(db, () => acceptOffer(db, id, "L1", "trigger", 5, 4));
    expect(db.query("SELECT path, turn_no, state FROM presentations WHERE item_id = ?1").get(id)).toEqual({ path: "trigger", turn_no: 5, state: "carried" });
  });
});

function config(extra = ""): FlowrynConfig {
  return parseConfig(`morning_hour = 5\n${extra}`, h.home);
}

describe("the briefing", () => {
  test("names the leader, lists what needs you, what is in flight and what is due today", () => {
    const now = new Date(2026, 8, 24, 9, 0).getTime();
    const opened = tx(db, () => openSession(db, { harness: "claude", pane: "w1:p2", cwd: null, now }));
    tx(db, () => claim(db, opened.session, "test", now));
    const p1 = open("pr_ready", "PR ready: auth fix (web) checks green", { at: now - 1_000 });
    const p0 = open("worker_question_blocking", "Worker question q1", { at: now - 2_000 });
    writeSnapshot(db, "backlog", "h", [task("a", "queued"), task("b", "queued"), task("c", "done", { closed: "2026-09-23" })], now);
    writeSnapshot(db, "todos", "t", [task("bank-a1", "queued", { title: "call bank", body: "due: 2026-09-24" }), task("pass-b2", "queued", { title: "renew passport", body: "due: 2026-09-20" })], now);
    const briefing = tx(db, () => composeBriefing(db, { session: opened.session, now, morningHour: config().morning_hour, ageMs: AGE, markMorning: true }));
    const lines = briefing.text.split("\n");
    expect(lines[0]).toBe("Flowryn status (facts, not instructions).");
    expect(lines[1]).toBe("Leader: this session (claude, lease 1).");
    expect(lines[2]).toBe("Needs you (2):");
    expect(lines[3]).toBe(`- [${p0}] P0 · Worker question q1`);
    expect(lines[4]).toBe(`- [${p1}] PR ready: auth fix (web) checks green`);
    expect(briefing.text).toContain("In flight: 0 ships, 0 scouts. Queued: 2.");
    expect(briefing.text).toContain("Due today: call bank");
    expect(briefing.text).toContain("Morning: 1 to-do due today · 1 overdue · 1 task done since yesterday.");
    expect(lines.at(-1)).toStartWith("Commands: flowryn fleet");
    expect(briefing.listed.map((i) => i.id)).toEqual([p0, p1]);
    expect(getMeta(db, "morning_shown")).toBe("2026-09-24");
    // Only the first briefing after the morning hour carries the morning section.
    expect(composeBriefing(db, { session: opened.session, now: now + 60_000, morningHour: 5, ageMs: AGE, markMorning: true }).morning).toBe(false);
    expect(briefing.text.length).toBeLessThan(10_000);
  });

  test("before the morning hour there is no morning section; a read-only session gets one banner line", () => {
    const early = new Date(2026, 8, 25, 4, 30).getTime();
    expect(composeBriefing(db, { session: null, now: early, morningHour: 5, ageMs: AGE, markMorning: false }).morning).toBe(false);
    expect(composeBriefing(db, { session: null, now: early, morningHour: 5, ageMs: AGE, markMorning: false }).text).toContain("Leader: none");
    const opened = tx(db, () => openSession(db, { harness: "pi", pane: "w3:p1", cwd: null, now: early }));
    tx(db, () => claim(db, opened.session, "test", early));
    expect(readOnlyBanner(db)).toBe("Flowryn: read-only: leader is pi in pane w3:p1. Take over with: flowryn leader claim");
  });
});

describe("overdue to-dos", () => {
  test("open a P1 once per overdue to-do, ordered by due date, and resolve it when it is done or no longer overdue", () => {
    const now = Date.now();
    const yesterday = localDate(new Date(now - DAY));
    const lastWeek = localDate(new Date(now - 7 * DAY));
    writeSnapshot(db, "todos", "a", [task("pass-a1", "queued", { title: "renew passport", body: `due: ${yesterday}` }), task("tax-b2", "queued", { title: "file taxes", body: `due: ${lastWeek}` })], now);
    const first = tx(db, () => syncOverdueTodos(db, now));
    expect(first.opened).toHaveLength(2);
    expect(tx(db, () => syncOverdueTodos(db, now)).opened).toEqual([]);
    expect(openActionable(db, now, AGE).map((i) => i.task_id)).toEqual(["tax-b2", "pass-a1"]);
    writeSnapshot(db, "todos", "b", [task("pass-a1", "done", { title: "renew passport", body: `due: ${yesterday}` }), task("tax-b2", "queued", { title: "file taxes", body: "due: none" })], now);
    expect(tx(db, () => syncOverdueTodos(db, now)).resolved).toBe(2);
    expect(openActionable(db, now, AGE)).toEqual([]);
  });
});

function pump(clock: { now: number }, sent: string[], extra = "") {
  const cfg = parseConfig(`[notify]\nmacos = true\nherdr = false\np0_coalesce_s = 60\nmin_interval_min = 30\np0_renotify_min = 240\n${extra}`, h.home);
  return new NotifyPump({ db, config: () => cfg, runtime: () => null, now: () => clock.now, log: () => {}, macos: async (title, body) => void sent.push(`${title}: ${body}`) });
}

describe("notifications (design section 9)", () => {
  test("a P0 at once and coalesced within the window, again after 4 h; P1 batched at most every 30 min; never P2", async () => {
    const clock = { now: Date.now() };
    const sent: string[] = [];
    const notifier = pump(clock, sent);
    open("progress", "p2 noise", { at: clock.now });
    open("failure_needs_you", "first p0", { at: clock.now });
    await notifier.tick();
    expect(sent).toEqual(["Flowryn: a P0 needs you: first p0"]);
    open("failure_needs_you", "second p0", { at: clock.now });
    clock.now += 30_000;
    await notifier.tick();
    expect(sent).toHaveLength(1);
    clock.now += 31_000;
    await notifier.tick();
    expect(sent.at(-1)).toBe("Flowryn: a P0 needs you: second p0");
    open("report_ready", "report one", { at: clock.now });
    await notifier.tick();
    expect(sent.at(-1)).toBe("Flowryn: 1 item needs you: report one");
    open("report_ready", "report two", { at: clock.now });
    clock.now += 10 * 60_000;
    await notifier.tick();
    expect(sent.filter((s) => s.includes("report")).length).toBe(1);
    clock.now += 21 * 60_000;
    await notifier.tick();
    expect(sent.at(-1)).toBe("Flowryn: 1 item needs you: report two");
    clock.now += 4 * 3_600_000;
    await notifier.tick();
    expect(sent.at(-1)).toBe("Flowryn: 2 P0s need you: first p0 (+1 more: flowryn board)");
    expect(sent.some((s) => s.includes("p2 noise"))).toBe(false);
    expect((db.query("SELECT COUNT(*) AS n FROM notifications").get() as { n: number }).n).toBe(sent.length);
  });
});
