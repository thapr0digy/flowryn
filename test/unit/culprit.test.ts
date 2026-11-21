import { describe, expect, test } from "bun:test";
import { likelyCulprit, namesInLog, numberClashes } from "../../src/verify/culprit.ts";

/** The likely culprit of a red landing batch and the migration-number clash check (src/verify/culprit.ts). */

describe("names in a failing log", () => {
  test("Go FAIL lines, file:line references and bun test file headers, each once", () => {
    const log = ["--- FAIL: TestSave (0.00s)", "    store_test.go:12: wrong", "FAIL\texample.com/app/internal/store\t0.01s", "test/unit/foo.test.ts:", "./src/a.ts:3:5 error", "src/a.ts:9"].join("\n");
    expect(namesInLog(log)).toEqual(["store_test.go", "example.com/app/internal/store", "test/unit/foo.test.ts", "src/a.ts"]);
  });

  test("a huge log is read only at its end, and the names it yields are bounded", () => {
    const log = `${"x/early.go:1\n".repeat(10)}${"a".repeat(40_000)}\n${Array.from({ length: 500 }, (_, i) => `f${i}.ts:1`).join("\n")}`;
    const names = namesInLog(log);
    expect(names).not.toContain("x/early.go");
    expect(names.length).toBeLessThanOrEqual(200);
  });
});

describe("the likely culprit", () => {
  const members = [
    { task: "t1", files: ["internal/store/store.go"] },
    { task: "t2", files: ["internal/web/web.go"] },
    { task: "t3", files: ["README.md"] },
  ];

  test("the branch that changed the failing package", () => {
    expect(likelyCulprit("FAIL\texample.com/app/internal/store\t0.01s\n", members)).toEqual({ task: "t1", why: "changes internal/store, a package the log names; t2: no overlap, t3: no overlap" });
  });

  test("an exact file outweighs a shared directory", () => {
    const both = [
      { task: "t1", files: ["src/a.ts"] },
      { task: "t2", files: ["src/b.ts"] },
    ];
    expect(likelyCulprit("src/b.ts:12:3 TypeError", both).task).toBe("t2");
  });

  test("a tie or nothing matched names no branch, never a guess", () => {
    expect(likelyCulprit("internal/web/x.go:1 and internal/store/y.go:2", members)).toMatchObject({ task: null, why: expect.stringContaining("no single likely branch: t1, t2") });
    expect(likelyCulprit("panic: out of memory", members)).toEqual({ task: null, why: "the log names no file or package; branches: t1, t2, t3" });
    expect(likelyCulprit("lib/other.go:3 boom", members)).toMatchObject({ task: null, why: expect.stringContaining("no branch changed what the log names") });
  });
});

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
