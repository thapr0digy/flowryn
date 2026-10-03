import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tx, type Db } from "../../src/db/db.ts";
import { LATEST_SCHEMA_VERSION } from "../../src/db/schema.ts";
import { createStandaloneDecision, getDecision } from "../../src/lifecycle/decisions.ts";
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
  test("migration 6 is the latest", () => {
    expect(LATEST_SCHEMA_VERSION).toBe(6);
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
});
