import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FlowrynError } from "../../src/api/errors.ts";
import type { HandlerCtx } from "../../src/api/verbs.ts";
import { ATTENTION_VERBS } from "../../src/attention/verbs.ts";
import { tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { makeHome, seedRun, type TestHome } from "../helpers/harness.ts";

/**
 * Learning l77 (2026-11-24, again with q162 on 2026-11-25): dismissing a
 * question's item before answering it closed the question too, so the
 * answer that came later was refused and lost. Now an open question's item
 * is refused; an answered or deferred one dismisses as before.
 */

const NOW = new Date(2026, 10, 25, 21, 0).getTime();
const dismiss = ATTENTION_VERBS.find((v) => v.name === "dismiss")!;

let h: TestHome;
let db: Db;
let runId: string;
let taskId: string;

beforeEach(() => {
  h = makeHome();
  ({ runId, taskId } = seedRun(h));
  db = h.db();
  const { seq } = appendEvent(db, { source: "cli", kind: "test.ask", runId, taskId, payload: {} });
  db.query("INSERT INTO decisions (id, task_id, run_id, question, options, blocking, state, created_at) VALUES ('q1', ?1, ?2, 'keep the old flag?', '[\"yes\",\"no\"]', 1, 'open', ?3)").run(taskId, runId, NOW);
  db.query("INSERT INTO items (id, event_seq, class, lane, kind, task_id, run_id, decision_id, line, state, opened_at) VALUES ('i1', ?1, 'actionable', 'P1', 'worker_question', ?2, ?3, 'q1', 'Worker question q1', 'open', ?4)").run(seq, taskId, runId, NOW);
});

afterEach(() => {
  db.close();
  h.cleanup();
});

const run = (role: "leader" | "human" = "leader") =>
  tx(db, () => dismiss.apply!({ db, now: () => NOW, caller: { role } } as unknown as HandlerCtx, { item: "i1" }, undefined)).data;
const refusal = (role: "leader" | "human" = "leader"): FlowrynError => {
  try {
    run(role);
  } catch (error) {
    if (error instanceof FlowrynError) return error;
    throw error;
  }
  throw new Error("dismiss was not refused");
};
const states = () => ({
  item: (db.query("SELECT state FROM items WHERE id = 'i1'").get() as { state: string }).state,
  decision: (db.query("SELECT state FROM decisions WHERE id = 'q1'").get() as { state: string }).state,
});

describe("dismiss of an item whose question is open", () => {
  test("is refused for the leader and in the user's terminal, naming the question and the answer to give", () => {
    for (const role of ["leader", "human"] as const) {
      const refused = refusal(role);
      expect(refused.code).toBe("decision_open");
      expect(refused.message).toContain("q1");
      expect(refused.help).toContain("flowryn decide q1 <choice>");
      expect(refused.help).toContain("flowryn decision defer q1");
    }
    expect(states()).toEqual({ item: "open", decision: "open" });
  });

  test("a reserved question points at the user's chat answer", () => {
    db.query("UPDATE decisions SET reserved_reason = 'security' WHERE id = 'q1'").run();
    expect(refusal().help).toContain("flowryn chat-question q1");
  });

  test("once answered, the item dismisses and the answer stands", () => {
    db.query("UPDATE decisions SET state = 'answered', answer = 'yes', answered_at = ?1 WHERE id = 'q1'").run(NOW);
    expect(run()).toMatchObject({ item: "i1", state: "dismissed", steer: "-" });
    expect(states()).toEqual({ item: "dismissed", decision: "answered" });
  });

  test("once deferred, the item dismisses and the worker is told to decide", () => {
    db.query("UPDATE decisions SET defer_until = '2026-11-27' WHERE id = 'q1'").run();
    expect(run()).toMatchObject({ item: "i1", state: "dismissed", decision: "q1" });
    expect(states()).toEqual({ item: "dismissed", decision: "dismissed" });
    expect((db.query("SELECT body FROM messages WHERE decision_id = 'q1'").get() as { body: string }).body).toContain("question q1 was dismissed");
  });

  test("a deferral that has run out is open again", () => {
    db.query("UPDATE decisions SET defer_until = '2026-11-25' WHERE id = 'q1'").run();
    expect(refusal().code).toBe("decision_open");
  });
});
