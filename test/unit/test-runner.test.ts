import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { combinedSummary, plan, SERIAL_FILES, testJobs } from "../../scripts/test.ts";
import { parseBunSummary } from "../../src/verify/summary.ts";

/** scripts/test.ts (docs/notes/2026-11-06-fast-tests-parallel-36.md): the parallel suite and its serial files. */

const ROOT = join(import.meta.dir, "../..");

describe("the fast test runner", () => {
  test("every serial file exists, so a rename cannot drop it silently from both parts", () => {
    for (const file of SERIAL_FILES) expect(existsSync(join(ROOT, file))).toBe(true);
  });

  test("all is unit, then integration in parallel ignoring the serial files, then those alone", () => {
    const runs = plan("all", 6, { timings: true, updateTimings: false });
    expect(runs).toHaveLength(3);
    const [unit, integration, serial] = runs as [string[], string[], string[]];
    expect(unit).toEqual(["bun", "test", "--parallel=6", "--timeout=30000", "--timings=test/timings.json", "test/unit"]);
    expect(integration.slice(0, 4)).toEqual(["bun", "test", "--parallel=6", "--timeout=30000"]);
    expect(integration.at(-1)).toBe("test/integration");
    for (const file of SERIAL_FILES) expect(integration).toContain(`--path-ignore-patterns=${file}`);
    expect(serial).toEqual(["bun", "test", "--timeout=30000", ...SERIAL_FILES]);
  });

  test("unit has no serial part; without a timings file none is passed", () => {
    const runs = plan("unit", 4, { timings: false, updateTimings: false });
    expect(runs).toEqual([["bun", "test", "--parallel=4", "--timeout=30000", "test/unit"]]);
  });

  test("workers: FLOWRYN_TEST_JOBS, else two thirds of the cores within 2 to 8", () => {
    expect(testJobs({ FLOWRYN_TEST_JOBS: "3" }, 12)).toBe(3);
    expect(testJobs({ FLOWRYN_TEST_JOBS: "zero" }, 12)).toBe(8);
    expect(testJobs({}, 12)).toBe(8);
    expect(testJobs({}, 6)).toBe(4);
    expect(testJobs({}, 2)).toBe(2);
    expect(testJobs({}, 32)).toBe(8);
  });

  test("the closing summary adds the parts, and verify's parser reads it as the whole run", () => {
    const a = { pass: 3000, fail: 0, skip: 2, todo: 0, tests: 3002, files: 205 };
    const b = { pass: 38, fail: 0, skip: 0, todo: 0, tests: 38, files: 5 };
    const text = combinedSummary([a, b])!;
    expect(parseBunSummary(`noise\n 38 pass\n 0 fail\nRan 38 tests across 5 files. [1s]\n${text}`)).toEqual({ pass: 3038, fail: 0, skip: 2, todo: 0, tests: 3040, files: 210 });
    expect(combinedSummary([a, null])).toBeNull();
  });
});
