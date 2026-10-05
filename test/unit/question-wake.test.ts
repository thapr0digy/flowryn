import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openItem, type ItemKind } from "../../src/attention/items.ts";
import { NotifyPump } from "../../src/attention/notify.ts";
import { acceptOffer, carry, confirmTurn, offer, releaseOffer, startedTurnsLastHour } from "../../src/attention/presentations.ts";
import { isQuestionWake, isWakePrompt, P0_LINE_MAX, p0Candidate, QUESTION_BATCH_MAX, questionBatch, questionsText, questionWakeLine, QUESTIONS_HEADER } from "../../src/attention/router.ts";
import { parseConfig } from "../../src/config/config.ts";
import { tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { makeHome, type TestHome } from "../helpers/harness.ts";

let h: TestHome;
let db: Db;

beforeEach(() => {
  h = makeHome();
  db = h.db();
});

afterEach(() => {
  db.close();
  h.cleanup();
});

const WINDOW = 30_000;

function open(kind: ItemKind, line: string, at: number, decision: string | null = null): string {
  return tx(db, () => {
    const event = appendEvent(db, { source: "cli", kind: "test.item", payload: {} });
    const id = openItem(db, { kind, eventSeq: event.seq, line, now: at });
    if (decision) db.query("UPDATE items SET decision_id = ?2 WHERE id = ?1").run(id, decision);
    return id;
  });
}

describe("the question batch", () => {
  test("is due once the oldest question has waited the window, and carries every question of the burst, blocking or not", () => {
    const now = Date.now();
    const first = open("worker_question", "Worker question q1", now - 10_000, "q1");
    const second = open("worker_question_blocking", "Worker question q2, blocking", now - 2_000, "q2");
    open("pr_ready", "not a question", now - 60_000);
    const batch = questionBatch(db, "L1", WINDOW)!;
    expect(batch.items.map((i) => i.id)).toEqual([first, second]);
    expect(batch.dueAt).toBe(now - 10_000 + WINDOW);
    expect(batch.more).toBe(0);
  });

  test("leaves out a question shown to this session, presented anywhere, or leased to another push path", () => {
    const now = Date.now();
    const shownHere = open("worker_question", "carried by a digest here", now);
    const presentedElsewhere = open("worker_question", "presented to another session", now);
    const leased = open("worker_question", "offered to another session's push", now);
    const fresh = open("worker_question", "fresh", now);
    tx(db, () => {
      carry(db, { itemId: shownHere, session: "L1", turn: 1, path: "digest", now });
      carry(db, { itemId: presentedElsewhere, session: "L2", turn: 1, path: "digest", now });
      confirmTurn(db, "L2", 1, now);
      offer(db, { itemId: leased, session: "L3", turn: 1, path: "trigger", now });
    });
    expect(questionBatch(db, "L1", WINDOW)!.items.map((i) => i.id)).toEqual([fresh]);
  });

  test("carries at most QUESTION_BATCH_MAX and counts the rest", () => {
    const now = Date.now();
    for (let n = 0; n < QUESTION_BATCH_MAX + 2; n++) open("worker_question", `q${n}`, now + n);
    const batch = questionBatch(db, "L1", WINDOW)!;
    expect(batch.items).toHaveLength(QUESTION_BATCH_MAX);
    expect(batch.more).toBe(2);
    expect(questionsText(batch.items, batch.more).split("\n").at(-1)).toBe("+2 more: flowryn decision list");
  });

  test("what the user sent from a review page rides in the same batch as the worker questions", () => {
    const now = Date.now();
    const question = open("worker_question", "Worker question q1", now - 1_000);
    const feedback = open("review_feedback", "Review feedback on t (design gate g1): the user wrote \"ok\"", now);
    expect(questionBatch(db, "L1", WINDOW)!.items.map((i) => i.id)).toEqual([question, feedback]);
  });

  test("a blocking question is never the P0 push path's: it goes in a batch", () => {
    const now = Date.now();
    open("worker_question_blocking", "Worker question q1, blocking", now);
    expect(p0Candidate(db, "L1", now, 86_400_000)).toBeNull();
    const failure = open("failure_needs_you", "Run failed", now);
    expect(p0Candidate(db, "L1", now, 86_400_000)?.id).toBe(failure);
  });
});

describe("the wake line", () => {
  test("is one line of at most P0_LINE_MAX characters naming the items and decisions, and counts as a wake", () => {
    const items = [
      { id: "i12", decision_id: "q7" },
      { id: "i13", decision_id: "q10" },
    ];
    const line = questionWakeLine(items);
    expect(line).toBe("Flowryn questions [i12,i13]: 2 worker questions for the user (q7, q10). Details: flowryn decision list");
    expect(line.length).toBeLessThanOrEqual(P0_LINE_MAX);
    expect(line).not.toContain("\n");
    const framed = `Stop hook blocking error from command "Stop": ${line}`;
    expect(isWakePrompt(framed)).toBe(true);
    expect(isQuestionWake(framed)).toBe(true);
    expect(isQuestionWake("Flowryn P0 [i1]: x")).toBe(false);
    const many = Array.from({ length: QUESTION_BATCH_MAX }, (_, n) => ({ id: `i${100_000 + n}`, decision_id: `q${100_000 + n}` }));
    expect(questionWakeLine(many).length).toBeLessThanOrEqual(P0_LINE_MAX);
  });

  test("the full text starts with the questions header, one line per question", () => {
    expect(questionsText([{ id: "i1", lane: "P1", line: "Worker question q1" }, { id: "i2", lane: "P0", line: "Worker question q2, blocking" }])).toBe(
      `${QUESTIONS_HEADER}\n- [i1] Worker question q1\n- [i2] P0 · Worker question q2, blocking`,
    );
  });
});

describe("question pushes in presentations", () => {
  test("a batch is one started turn, counted on the questions budget, not the P0 one", () => {
    const now = Date.now();
    const a = open("worker_question", "a", now);
    const b = open("worker_question", "b", now);
    const p0 = open("failure_needs_you", "p0", now);
    tx(db, () => {
      carry(db, { itemId: a, session: "L1", turn: 2, path: "waiter", now });
      carry(db, { itemId: b, session: "L1", turn: 2, path: "waiter", now });
      carry(db, { itemId: p0, session: "L1", turn: 4, path: "waiter", now });
    });
    expect(startedTurnsLastHour(db, "L1", now + 1, "questions")).toBe(1);
    expect(startedTurnsLastHour(db, "L1", now + 1, "p0")).toBe(1);
    expect(startedTurnsLastHour(db, "L1", now + 3_600_001, "questions")).toBe(0);
  });

  test("a Pi delivery or decline of the lead item covers every item offered in the same push", () => {
    const now = Date.now();
    const a = open("worker_question", "a", now);
    const b = open("worker_question", "b", now);
    const older = open("worker_question", "offered in an earlier push", now);
    tx(db, () => {
      offer(db, { itemId: older, session: "L1", turn: 1, path: "trigger", now: now - 5_000 });
      offer(db, { itemId: a, session: "L1", turn: 3, path: "trigger", now });
      offer(db, { itemId: b, session: "L1", turn: 3, path: "trigger", now });
    });
    expect(tx(db, () => acceptOffer(db, a, "L1", "trigger", 3, now + 1))).toEqual([a, b]);
    const states = (id: string) => db.query("SELECT state FROM presentations WHERE item_id = ?1").all(id).map((r) => (r as { state: string }).state);
    expect(states(b)).toEqual(["carried"]);
    expect(states(older)).toEqual(["offered"]);
    tx(db, () => releaseOffer(db, older, "L1"));
    expect(states(older)).toEqual([]);
  });
});

describe("question alerts", () => {
  test("a blocking question notifies at once; a non-blocking one, or review feedback, never does", async () => {
    const sent: string[] = [];
    const now = Date.now();
    const cfg = parseConfig("[notify]\nmacos = true\nherdr = false\nmin_interval_min = 30\n", h.home);
    const notifier = new NotifyPump({ db, config: () => cfg, runtime: () => null, now: () => now, log: () => {}, macos: async (title, body) => void sent.push(`${title}: ${body}`) });
    open("worker_question", "Worker question q1 later is fine", now);
    open("review_feedback", "Review feedback on t (design gate g1): the user wrote \"ok\"", now);
    await notifier.tick();
    expect(sent).toEqual([]);
    open("worker_question_blocking", "Worker question q2, blocking", now);
    await notifier.tick();
    expect(sent).toEqual(["Flowryn: a P0 needs you: Worker question q2, blocking"]);
  });
});
