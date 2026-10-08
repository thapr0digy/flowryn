import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tx, type Db } from "../../src/db/db.ts";
import { LATEST_SCHEMA_VERSION } from "../../src/db/schema.ts";
import { createStandaloneDecision, getDecision } from "../../src/lifecycle/decisions.ts";
import { takenIds } from "../../src/lifecycle/plans.ts";
import { capStoredText, MAX_STORED_TEXT_CHARS } from "../../src/util/sanitize.ts";
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

function intents(): { verb: string; task_id: string; args: string }[] {
  return db.query("SELECT verb, task_id, args FROM intents ORDER BY seq").all() as { verb: string; task_id: string; args: string }[];
}

describe("standalone decisions", () => {
  test("migration 6 landed decisions", () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(6);
  });

  test("a standalone decision owns a held decision task, and blocks what it names", () => {
    const made = tx(db, () =>
      createStandaloneDecision(db, { key: "retention-policy", question: "Keep 365 days?", options: ["yes", "no"], recommendation: "yes", context: "Blocks P1.", origin: "fathom-arch-r2", blocks: ["fathom-p1-x1"], project: "fathom", now: 1_000 }),
    );
    expect(made.id).toBe("k1");
    expect(made.created).toBe(true);
    const row = getDecision(db, "k1")!;
    expect(row).toMatchObject({ task_id: made.taskId, run_id: null, origin: "fathom-arch-r2", key: "retention-policy", recommendation: "yes", state: "open", blocking: 1, created_at: 1_000 });
    expect(JSON.parse(row.options)).toEqual(["yes", "no"]);
    const recorded = intents();
    expect(recorded.map((i) => i.verb)).toEqual(["add", "hold", "block"]);
    expect(JSON.parse(recorded[0]!.args).flags).toMatchObject({ kind: "decision", repo: "fathom" });
    expect(JSON.parse(recorded[1]!.args).flags).toMatchObject({ kind: "captain" });
    expect(recorded[2]).toMatchObject({ task_id: "fathom-p1-x1" });
    expect(JSON.parse(recorded[2]!.args)).toMatchObject({ positional: ["fathom-p1-x1"], flags: { by: made.taskId } });
  });

  test("the same origin and key is not created twice", () => {
    const first = tx(db, () => createStandaloneDecision(db, { key: "k", question: "Q?", options: [], origin: "o", now: 1 }));
    const again = tx(db, () => createStandaloneDecision(db, { key: "k", question: "Q again?", options: [], origin: "o", now: 2 }));
    expect(again).toEqual({ ...first, created: false });
    expect(intents().filter((i) => i.verb === "add")).toHaveLength(1);
  });

  test("a bad key is refused", () => {
    expect(() => tx(db, () => createStandaloneDecision(db, { key: "Bad Key", question: "Q?", options: [], origin: "o", now: 1 }))).toThrow(/key/);
  });

  test("a decision's task id counts as taken even once pruned: no task_policy row, no pending intent, no backlog snapshot", () => {
    const made = tx(db, () => createStandaloneDecision(db, { key: "reused", question: "Q?", options: [], origin: "o", now: 1 }));
    expect(db.query("SELECT 1 FROM task_policy WHERE task_id = ?1").get(made.taskId)).toBeNull();
    // Simulate the journal having applied its intents and the task later pruned from Done history:
    // takenIds must still see it (through the decisions table itself), not through a pending intent.
    db.query("UPDATE intents SET state = 'applied' WHERE task_id = ?1").run(made.taskId);
    expect(takenIds(db)(made.taskId)).toBe(true);
  });

  test("a long question is stored whole, and only past the hard cap is it cut, saying how much", () => {
    const long = `${"Allow Bash(gh:*), Bash(sqlite3:*), more.\n".repeat(200)}the last line`;
    expect(long.length).toBeGreaterThan(2_000);
    const made = tx(db, () => createStandaloneDecision(db, { key: "long", question: long, options: [], origin: "o", now: 1 }));
    expect(getDecision(db, made.id)!.question).toBe(long);

    const huge = "x".repeat(MAX_STORED_TEXT_CHARS + 500);
    const cut = tx(db, () => createStandaloneDecision(db, { key: "huge", question: huge, options: [], origin: "o", now: 2 }));
    expect(getDecision(db, cut.id)!.question).toBe(`${"x".repeat(MAX_STORED_TEXT_CHARS)}\n[truncated 500 chars]`);
  });
});

describe("capStoredText", () => {
  test("keeps text up to the cap whole and marks only what it cuts", () => {
    expect(capStoredText("short")).toBe("short");
    expect(capStoredText("y".repeat(MAX_STORED_TEXT_CHARS))).toBe("y".repeat(MAX_STORED_TEXT_CHARS));
    expect(capStoredText("abcdef", 4)).toBe("abcd\n[truncated 2 chars]");
  });
});
