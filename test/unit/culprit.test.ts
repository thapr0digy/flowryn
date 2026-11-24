import { describe, expect, test } from "bun:test";
import { numberClashes } from "../../src/verify/culprit.ts";

/** The migration-number clash check of a landing batch (src/verify/culprit.ts). */

describe("migration number clashes", () => {
  test("the later of two branches adding the same number in one migrations directory", () => {
    expect(
      numberClashes([
        { task: "t1", files: ["db/migrations/000042_users.up.sql", "db/migrations/000042_users.down.sql"] },
        { task: "t2", files: ["db/migrations/42_orders.up.sql"] },
      ]),
    ).toEqual([{ task: "t2", path: "db/migrations/42_orders.up.sql", with: "t1", withPath: "db/migrations/000042_users.up.sql" }]);
  });

  test("other numbers, other directories, one branch's own up/down pair and date-prefixed notes are no clash", () => {
    expect(
      numberClashes([
        { task: "t1", files: ["db/migrations/0001_a.up.sql", "db/migrations/0001_a.down.sql", "docs/notes/2026-11-21-a.md"] },
        { task: "t2", files: ["db/migrations/0002_b.up.sql", "other/migrations/0001_c.sql", "docs/notes/2026-11-21-b.md"] },
      ]),
    ).toEqual([]);
  });
});
