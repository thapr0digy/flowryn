import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tx, type Db } from "../../src/db/db.ts";
import { writeSnapshot } from "../../src/journal/snapshot.ts";
import type { BacklogTask } from "../../src/journal/tasks-axi.ts";
import { checkInvariant } from "../../src/reconcile/invariant.ts";
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

function task(id: string, state: BacklogTask["state"], extra: Partial<BacklogTask> = {}): BacklogTask {
  return { id, title: id, state, kind: null, repo: null, priority: null, body: "", created: null, closed: null, deps: [], hold: null, links: [], ...extra };
}

/**
 * A decision task (cutover C1) has no task_policy row and no run: it is held, Queued, until
 * answered. The invariant pass must not mistake that for drift (design section 8).
 */
describe("the invariant pass and decision tasks", () => {
  test("a held, Queued decision task with no run raises no divergence", () => {
    const now = Date.now();
    writeSnapshot(db, "backlog", "h", [task("decision-pick-db", "queued", { kind: "decision", hold: { kind: "captain", reason: "decision k1", until: null } })], now);
    const result = tx(db, () => checkInvariant(db, now));
    expect(result).toEqual({ opened: [], resolved: [] });
    expect(db.query("SELECT COUNT(*) AS n FROM divergences").get()).toEqual({ n: 0 });
  });
});
