import { describe, expect, test } from "bun:test";
import { findLoosenings, looseningLine, raisedNumber } from "../../src/policy/loosening.ts";

/**
 * Gate loosening in a fix's diff (docs/notes/2026-11-22-phase-countersign-gate-7e.md). Skip
 * markers are spelled through `skip()` so this file's own diff never reads as a skipped test.
 */

const skip = (fn: string) => `${fn}.${"skip"}(`;

/** A one-file `git diff --unified=0` with the given removed and added lines. */
function diff(file: string, removed: string[], added: string[]): string {
  return [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -1,${removed.length} +1,${added.length} @@`, ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join("\n");
}

describe("raisedNumber", () => {
  test("a number raised on a line that differs only in its numbers", () => {
    expect(raisedNumber(`  "first_load_kb": 233,`, `  "first_load_kb": 234,`)).toEqual({ from: "233", to: "234" });
    expect(raisedNumber(`  "first_load_kb": 234,`, `  "first_load_kb": 233,`)).toBeNull();
    expect(raisedNumber(`limit = 3`, `max = 4`)).toBeNull();
  });

  test("units of one dimension compare after scaling: 5m → 400s is raised, 5m → 200s is not", () => {
    expect(raisedNumber("go test -timeout 5m ./...", "go test -timeout 400s ./...")).toEqual({ from: "5m", to: "400s" });
    expect(raisedNumber("go test -timeout 5m ./...", "go test -timeout 200s ./...")).toBeNull();
    expect(raisedNumber("max 200kb", "max 1mb")).toEqual({ from: "200kb", to: "1mb" });
  });
});

describe("findLoosenings", () => {
  test("a raised number in a file named *budget*", () => {
    const found = findLoosenings(diff("ui/tests/budget.json", [`  "brief": 228`], [`  "brief": 229`]));
    expect(found).toEqual([{ file: "ui/tests/budget.json", kind: "raised", line: `"brief": 229`, from: "228", to: "229" }]);
    expect(looseningLine(found[0]!)).toBe(`ui/tests/budget.json: raised 228 → 229: "brief": 229`);
  });

  test("a test runner's config counts only on a line naming a timeout, threshold, limit or retries", () => {
    expect(findLoosenings(diff("bunfig.toml", ["timeout = 5000"], ["timeout = 20000"])).map((l) => l.kind)).toEqual(["raised"]);
    expect(findLoosenings(diff("Makefile", ["\tgo test -timeout 5m ./..."], ["\tgo test -timeout 10m ./..."])).map((l) => l.kind)).toEqual(["raised"]);
    expect(findLoosenings(diff("Makefile", ["\tgo test -parallel 4 ./..."], ["\tgo test -parallel 8 ./..."]))).toEqual([]);
    // A package manifest's test script, and Python's tool sections, are test runner config too.
    expect(findLoosenings(diff("package.json", [`    "test": "bun test --timeout 5000",`], [`    "test": "bun test --timeout 20000",`]))).toEqual([
      { file: "package.json", kind: "raised", line: `"test": "bun test --timeout 20000",`, from: "5000", to: "20000" },
    ]);
    expect(findLoosenings(diff("pyproject.toml", ["timeout = 30"], ["timeout = 60"])).map((l) => l.kind)).toEqual(["raised"]);
    expect(findLoosenings(diff("package.json", [`  "version": "1.2.0",`], [`  "version": "1.3.0",`]))).toEqual([]);
    expect(findLoosenings(diff("setup.cfg", ["timeout = 30"], ["timeout = 60"])).map((l) => l.kind)).toEqual(["raised"]);
  });

  test("a dependency bump in a package manifest raises nothing, even when the package's name says limit or timeout", () => {
    for (const [before, after] of [
      [`    "express-rate-limit": "^6.7.0",`, `    "express-rate-limit": "^6.8.0",`],
      [`    "p-limit": "^3.1.0",`, `    "p-limit": "^3.2.0",`],
      [`    "p-timeout": "~4.1.0",`, `    "p-timeout": "~4.2.0",`],
      [`    "connect-timeout": "1.9.0",`, `    "connect-timeout": "1.9.1",`],
    ] as const) {
      expect(findLoosenings(diff("package.json", [before], [after]))).toEqual([]);
    }
    expect(findLoosenings(diff("pyproject.toml", [`  "ratelimit>=2.2",`], [`  "ratelimit>=2.3",`]))).toEqual([]);
    expect(findLoosenings(diff("pyproject.toml", [`  "pytest-timeout==2.2.0",`], [`  "pytest-timeout==2.3.1",`]))).toEqual([]);
    // A manifest line naming a limit that is not a test runner's timeout is not a gate either.
    expect(findLoosenings(diff("package.json", [`    "max-limit": 10,`], [`    "max-limit": 20,`]))).toEqual([]);
    // Any other file's numbers are its own business.
    expect(findLoosenings(diff("src/server.ts", ["const timeout = 5000;"], ["const timeout = 9000;"]))).toEqual([]);
  });

  test("an added test skip anywhere, in each language's spelling; a moved one and a platform skipIf are not", () => {
    for (const line of [`${skip("test")}"saves", () => {`, `  ${skip("it")}"loads", () => {`, `\tt.Skip${"("}"flaky on CI")`, `@pytest.mark.${"skip"}`, `#[${"ignore"}]`]) {
      expect(findLoosenings(diff("x.test", [], [line])).map((l) => l.kind)).toEqual(["skip"]);
    }
    const moved = `${skip("test")}"saves", () => {`;
    expect(findLoosenings(diff("a.test.ts", [moved], ["", moved]))).toEqual([]);
    expect(findLoosenings(diff("a.test.ts", [], [`test.${"skipIf"}(process.platform !== "darwin")("plutil", () => {`]))).toEqual([]);
    expect(findLoosenings(diff("a.test.ts", [], [`test.${"skipIf"}(true)("saves", () => {`])).map((l) => l.kind)).toEqual(["skip"]);
    expect(findLoosenings(diff("docs/notes/x.md", [], [`Write ${skip("test")}"x") to park a test.`]))).toEqual([]);
  });

  test("a new entry in an allowlist file; comments and removals are not", () => {
    expect(findLoosenings(diff("config/host-allowlist.txt", ["a.example"], ["a.example", "b.example", "# why"])).map((l) => [l.kind, l.line])).toEqual([["allowlist", "b.example"]]);
    expect(findLoosenings(diff("config/allow_list.txt", ["a.example"], []))).toEqual([]);
    // Removing a list's last entry drops the comma from the one before it: that narrows the list.
    expect(findLoosenings(diff("config/allowlist.json", [`  "a.example",`, `  "b.example"`], [`  "a.example"`]))).toEqual([]);
    expect(findLoosenings(diff("config/allowlist.json", [`  "a.example"`], [`  "a.example",`, `  "b.example"`])).map((l) => l.line)).toEqual([`"b.example"`]);
  });

  test("a deleted file and an ordinary edit loosen nothing", () => {
    const deleted = ["diff --git a/ui/budget.json b/ui/budget.json", "--- a/ui/budget.json", "+++ /dev/null", "@@ -1 +0,0 @@", `-"brief": 228`].join("\n");
    expect(findLoosenings(deleted)).toEqual([]);
    expect(findLoosenings(diff("pkg/store/store.go", ["return nil"], ["return err"]))).toEqual([]);
  });
});
