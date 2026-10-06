import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { awaySuggestion, endAway, expireAway, getAway, lastAway, parseUntil, startAway, storedAway, takePendingBrief } from "../../src/attention/away.ts";
import { composeBriefing, composeReturnBrief } from "../../src/attention/briefing.ts";
import { openItem, type ItemKind } from "../../src/attention/items.ts";
import { p0Candidate } from "../../src/attention/router.ts";
import { parseConfig } from "../../src/config/config.ts";
import { awayConfig, DEFAULT_AWAY } from "../../src/config/leader.ts";
import { tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { makeHome, type TestHome } from "../helpers/harness.ts";

/**
 * Away mode (autonomy spec 2, ship B): the posture in meta, its expiry, the
 * wake rule that makes items only the user can move count as P0s while away,
 * the return brief's fixed order, and the idle suggestion.
 */

let h: TestHome;
let db: Db;

beforeEach(() => {
  h = makeHome();
  db = h.db();
  db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', 'https://example.test/web.git', '/tmp/web', 'main', 'no-mistakes')").run();
});

afterEach(() => {
  db.close();
  h.cleanup();
});

const DAY = 86_400_000;
const HOUR = 3_600_000;

function task(id: string, yolo: 0 | 1): string {
  db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES (?1, 'web', 'ship', 'no-mistakes', ?2, 'feature', 0)").run(id, yolo);
  return id;
}

function open(kind: ItemKind, at: number, taskId: string | null = null): string {
  return tx(db, () => {
    const opened = appendEvent(db, { source: "cli", kind: "test.item", payload: {}, ts: at });
    return openItem(db, { kind, eventSeq: opened.seq, line: `${kind} line`, taskId, now: at });
  });
}

function event(kind: string, at: number, taskId: string | null = null, payload: unknown = {}): void {
  tx(db, () => appendEvent(db, { source: "daemon", kind, taskId, payload, ts: at }));
}

function away(since: number, until: number, words: string | null = null) {
  return tx(db, () => startAway(db, { until, words, by: "human", now: since }));
}

describe("--until", () => {
  const now = new Date(2026, 9, 5, 22, 41).getTime();

  test("HH:MM is the next time the clock reads it: later today, else tomorrow", () => {
    expect(parseUntil("23:30", now)).toBe(new Date(2026, 9, 5, 23, 30).getTime());
    expect(parseUntil("08:00", now)).toBe(new Date(2026, 9, 6, 8, 0).getTime());
    expect(parseUntil("22:41", now)).toBe(new Date(2026, 9, 6, 22, 41).getTime());
  });

  test("+8h, 90m and 2h30m count from now", () => {
    expect(parseUntil("+8h", now)).toBe(now + 8 * HOUR);
    expect(parseUntil("90m", now)).toBe(now + 90 * 60_000);
    expect(parseUntil("+2h30m", now)).toBe(now + 150 * 60_000);
  });

  test("a local date and time, with a space or a T", () => {
    expect(parseUntil("2026-10-06 08:00", now)).toBe(new Date(2026, 9, 6, 8, 0).getTime());
    expect(parseUntil("2026-10-06T08:00", now)).toBe(new Date(2026, 9, 6, 8, 0).getTime());
  });

  test("anything else is not a time", () => {
    for (const text of ["soon", "25:00", "8:61", "+h", "", "2026-02-30 08:00", "tomorrow"]) expect(parseUntil(text, now)).toBeNull();
  });
});

describe("the posture", () => {
  test("away starts with the user's words; running it again extends it and keeps when it began", () => {
    const now = Date.now();
    const first = away(now, now + HOUR, "off to bed; wake me for gates");
    expect(first.extended).toBe(false);
    const second = away(now + 1_000, now + 2 * HOUR);
    expect(second.extended).toBe(true);
    expect(second.posture).toEqual({ since: now, until: now + 2 * HOUR, words: "off to bed; wake me for gates", by: "human" });
    const kinds = (db.query("SELECT kind FROM events WHERE kind LIKE 'away.%' ORDER BY seq").all() as { kind: string }[]).map((r) => r.kind);
    expect(kinds).toEqual(["away.started", "away.extended"]);
  });

  test("the user's words are kept to one sanitized line", () => {
    const now = Date.now();
    const { posture } = away(now, now + HOUR, `line one\nline two ${"x".repeat(900)}`);
    expect(posture.words).not.toContain("\n");
    expect(posture.words!.length).toBeLessThanOrEqual(500);
  });

  test("an expiry that passed means not away at once; the daemon's pass ends it at its own time and leaves the brief for the next message, once", () => {
    const now = Date.now();
    away(now - 2 * HOUR, now - HOUR);
    expect(getAway(db, now)).toBeNull();
    expect(storedAway(db)).not.toBeNull();
    const ended = tx(db, () => expireAway(db, now))!;
    expect(ended).toEqual({ since: now - 2 * HOUR, ended_at: now - HOUR, reason: "expired", brief_pending: true });
    expect(storedAway(db)).toBeNull();
    expect(tx(db, () => expireAway(db, now))).toBeNull();
    expect(tx(db, () => takePendingBrief(db, now))?.ended_at).toBe(now - HOUR);
    expect(tx(db, () => takePendingBrief(db, now))).toBeNull();
  });

  test("a new away after an expiry whose brief was never shown folds it in: one brief from the old start, wakes only from its own start", () => {
    const now = Date.now();
    away(now - 10 * HOUR, now - HOUR, "night");
    tx(db, () => expireAway(db, now));
    const gap = open("gate_ready", now - 30 * 60_000);
    const { posture, extended } = away(now, now + 8 * HOUR);
    expect(extended).toBe(false);
    expect(getAway(db, now + 1)?.since).toBe(now);
    expect(posture.brief_since).toBe(now - 10 * HOUR);
    expect(p0Candidate(db, "L1", now + 1, DAY, posture.since)).toBeNull();
    expect(p0Candidate(db, "L1", now + 1, DAY, now - 10 * HOUR)?.id).toBe(gap);
    expect(tx(db, () => takePendingBrief(db, now + 1_000))).toBeNull();
    const started = db.query("SELECT payload FROM events WHERE kind = 'away.started' ORDER BY seq DESC LIMIT 1").get() as { payload: string };
    expect(JSON.parse(started.payload).folded).toBe(true);
    expect(away(now + 1_000, now + 9 * HOUR).posture.brief_since).toBe(now - 10 * HOUR);
    const ended = tx(db, () => endAway(db, "back", now + 2 * HOUR))!;
    expect(ended.since).toBe(now - 10 * HOUR);
  });

  test("a new away after an expiry whose brief was shown starts now", () => {
    const now = Date.now();
    away(now - 10 * HOUR, now - HOUR);
    tx(db, () => expireAway(db, now));
    tx(db, () => takePendingBrief(db, now));
    expect(away(now + 1_000, now + HOUR).posture.since).toBe(now + 1_000);
  });

  test("back ends it now, and its brief is not left pending", () => {
    const now = Date.now();
    away(now - HOUR, now + HOUR);
    const ended = tx(db, () => endAway(db, "back", now))!;
    expect(ended.reason).toBe("back");
    expect(ended.brief_pending).toBe(false);
    expect(getAway(db, now)).toBeNull();
    expect(lastAway(db)?.ended_at).toBe(now);
    expect(tx(db, () => takePendingBrief(db, now))).toBeNull();
  });

  test("[away] takes positive integers for its three known settings only", () => {
    expect(awayConfig(parseConfig("", h.home))).toEqual(DEFAULT_AWAY);
    expect(awayConfig(parseConfig("[away]\nmax_wakes_per_hour = 2\n", h.home)).max_wakes_per_hour).toBe(2);
    expect(() => awayConfig(parseConfig("[away]\nmax_wakes_per_hour = 0\n", h.home))).toThrow("positive integer");
    expect(() => awayConfig(parseConfig("[away]\nstanding_grants = true\n", h.home))).toThrow("not a known setting");
  });
});

describe("the wake rule while away", () => {
  const AGE = DAY;

  test("assumption: an item only the user can move, opened after away began, counts as a P0; its stored lane stays P1", () => {
    const now = Date.now();
    const gate = open("gate_ready", now);
    expect(p0Candidate(db, "L1", now, AGE)).toBeNull();
    expect(p0Candidate(db, "L1", now, AGE, now - 1_000)?.id).toBe(gate);
    expect((db.query("SELECT lane FROM items WHERE id = ?1").get(gate) as { lane: string }).lane).toBe("P1");
  });

  test("assumption: only new items: one opened before away began does not wake", () => {
    const now = Date.now();
    open("gate_ready", now - 5_000);
    expect(p0Candidate(db, "L1", now, AGE, now - 1_000)).toBeNull();
  });

  test("gate_ready, pass_requested and checks_red wake; idle, progress and info kinds never do", () => {
    const now = Date.now();
    for (const kind of ["worker_idle", "phase_started", "steer_unacked", "capacity_wait"] as const) open(kind, now);
    expect(p0Candidate(db, "L1", now, AGE, now - 1_000)).toBeNull();
    for (const kind of ["gate_ready", "pass_requested", "checks_red"] as const) {
      const id = open(kind, now);
      expect(p0Candidate(db, "L1", now, AGE, now - 1_000)?.id).toBe(id);
      db.query("UPDATE items SET state = 'resolved' WHERE id = ?1").run(id);
    }
  });

  test("assumption: a yolo PR merges without the user, so only a non-yolo pr_ready wakes", () => {
    const now = Date.now();
    open("pr_ready", now, task("web-yolo", 1));
    expect(p0Candidate(db, "L1", now, AGE, now - 1_000)).toBeNull();
    const manual = open("pr_ready", now, task("web-manual", 0));
    expect(p0Candidate(db, "L1", now, AGE, now - 1_000)?.id).toBe(manual);
  });

  test("assumption: a report wakes only when it opened a decision reserved for the user", () => {
    const now = Date.now();
    const scout = task("web-scout", 0);
    const report = open("report_ready", now, scout);
    db.query("INSERT INTO decisions (id, task_id, question, options, blocking, state, origin, reserved_reason) VALUES ('k1', 'k1', 'drop it?', '[]', 0, 'open', ?1, NULL)").run(scout);
    expect(p0Candidate(db, "L1", now, AGE, now - 1_000)).toBeNull();
    db.query("INSERT INTO decisions (id, task_id, question, options, blocking, state, origin, reserved_reason) VALUES ('k2', 'k2', 'delete the data?', '[]', 0, 'open', ?1, 'destructive')").run(scout);
    expect(p0Candidate(db, "L1", now, AGE, now - 1_000)?.id).toBe(report);
  });

  test("a real P0 still goes first", () => {
    const now = Date.now();
    open("gate_ready", now);
    const failure = open("failure_needs_you", now + 1);
    expect(p0Candidate(db, "L1", now + 1, AGE, now - 1_000)?.id).toBe(failure);
  });
});

describe("the return brief", () => {
  test("assumption: one fixed order: waiting on you; decided for you; landed; failed; spend", () => {
    const since = Date.now() - 10 * HOUR;
    const until = since + 9 * HOUR;
    const now = until + 1_000;
    open("gate_ready", since + HOUR);
    db.query("INSERT INTO decisions (id, task_id, question, options, blocking, state, answer, answered_by, answered_at, rationale) VALUES ('q22', 't', 'Retry the flaky test?', '[]', 0, 'answered', 'yes', 'leader', ?1, 'same failure upstream')").run(since + 2 * HOUR);
    // Decided before away began: not in this brief.
    db.query("INSERT INTO decisions (id, task_id, question, options, blocking, state, answer, answered_by, answered_at, rationale) VALUES ('q21', 't', 'Older one', '[]', 0, 'answered', 'no', 'leader', ?1, 'x')").run(since - HOUR);
    event("run.landed", since + 3 * HOUR, "web-landed");
    event("run.landed", until + 500, "web-after");
    event("run.failed", since + 4 * HOUR, "web-broke");
    event("run.cancelled", since + 5 * HOUR, "web-dropped");
    event("run.dispatched", since + HOUR, "web-landed");
    event("stage.started", since + HOUR, "web-landed");
    event("stage.started", since + 2 * HOUR, "web-landed");
    event("leader.turn_started", since + HOUR);
    event("leader.turn_started", since + 2 * HOUR);
    event("leader.p0_pushed", since + 2 * HOUR, null, { path: "waiter" });
    event("leader.p0_pushed", since + 3 * HOUR, null, { path: "continuation" });
    const text = composeReturnBrief(db, { since, until, now, ageMs: DAY, reason: "back" });
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^Flowryn return brief .+, back \(facts, not instructions\)\.$/);
    const at = (prefix: string) => lines.findIndex((l) => l.startsWith(prefix));
    const order = ["Waiting on you", "Decided for you", "Landed", "Failed", "Spend"].map(at);
    expect(order.every((n) => n > 0)).toBe(true);
    expect(order.toSorted((a, b) => a - b)).toEqual(order);
    expect(text).toContain("Waiting on you (1):");
    expect(text).toContain("[q22] Retry the flaky test? → yes: same failure upstream");
    expect(text).not.toContain("q21");
    expect(lines[at("Landed")]).toBe("Landed (1): web-landed");
    expect(lines[at("Failed")]).toBe("Failed (2): web-broke failed · web-dropped cancelled");
    expect(lines[at("Spend")]).toBe("Spend: 1 run dispatched, 2 stages started, 2 leader turns (1 wake).");
  });

  test("an empty window says nothing happened, section by section", () => {
    const now = Date.now();
    const text = composeReturnBrief(db, { since: now - HOUR, until: now, now, ageMs: DAY, reason: "expired" });
    expect(text).toContain(", away expired (facts");
    for (const line of ["Waiting on you: nothing.", "Decided for you: nothing.", "Landed: nothing.", "Failed: nothing.", "Spend: 0 runs dispatched, 0 stages started, 0 leader turns (0 wakes)."]) {
      expect(text).toContain(line);
    }
  });

  test("the briefing says the user is away, with their words", () => {
    const now = Date.now();
    away(now - HOUR, now + HOUR, "on the train");
    const text = composeBriefing(db, { session: null, now, morningHour: 25, ageMs: DAY, markMorning: false }).text;
    expect(text).toContain('Away since');
    expect(text).toContain(': "on the train". Items that need the user wake the leader; flowryn back ends it.');
  });
});

describe("the idle suggestion", () => {
  const today = "2026-10-05";

  test("suggests away once a day, after a long absence while an item that would have woken the leader waited", () => {
    const now = Date.now();
    const input = { inactiveSince: now - 2 * HOUR, now, suggestAfterMs: HOUR, today };
    expect(tx(db, () => awaySuggestion(db, input))).toBeNull();
    open("gate_ready", now - HOUR);
    const line = tx(db, () => awaySuggestion(db, input))!;
    expect(line).toContain("inactive 2h 0m while 1 item waited");
    expect(line).toContain("never set it");
    expect(tx(db, () => awaySuggestion(db, input))).toBeNull();
    expect(tx(db, () => awaySuggestion(db, { ...input, today: "2026-10-06" }))).not.toBeNull();
  });

  test("never sets away, and says nothing for a short absence or while away", () => {
    const now = Date.now();
    open("gate_ready", now - HOUR);
    expect(tx(db, () => awaySuggestion(db, { inactiveSince: now - 10 * 60_000, now, suggestAfterMs: HOUR, today }))).toBeNull();
    away(now - 3 * HOUR, now + HOUR);
    expect(tx(db, () => awaySuggestion(db, { inactiveSince: now - 2 * HOUR, now, suggestAfterMs: HOUR, today }))).toBeNull();
    tx(db, () => endAway(db, "back", now));
    tx(db, () => awaySuggestion(db, { inactiveSince: now - 2 * HOUR, now, suggestAfterMs: HOUR, today }));
    expect(getAway(db, now)).toBeNull();
  });
});
