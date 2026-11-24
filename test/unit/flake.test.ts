import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../../src/config/config.ts";
import { verifyConfig } from "../../src/verify/config.ts";
import { failedTests, failuresOf, MAX_TARGETS, rerunCommand, withRerun, type BatchFlake } from "../../src/verify/flake.ts";
import { verifyPolicyId } from "../../src/verify/policy.ts";
import { initialSteps, repeatedCommand } from "../../src/verify/runner.ts";
import type { Verification } from "../../src/verify/store.ts";

/**
 * Flakes earn one rerun (docs/notes/2026-11-22-phase-flake-earns-a3.md): the failing tests a step's
 * log names, the rerun command, its shell, and the rerun_failed config key. The batch flow is in
 * test/unit/landing-batch.test.ts ("a flaky batch").
 */

const config = (text: string) => verifyConfig(parseConfig(`[projects.web]\n${text}`, "/h"), "web");

describe("the failing tests a log names", () => {
  test("Go: top-level tests under their package; subtests and passing packages ignored; a package with no test named is itself", () => {
    const log = [
      "ok  \texample.com/app/pkg/ok\t0.01s",
      "--- FAIL: TestSave (0.00s)",
      "    --- FAIL: TestSave/empty (0.00s)",
      "    store_test.go:12: wrong",
      "FAIL",
      "FAIL\texample.com/app/pkg/store\t0.01s",
      "panic: test timed out after 5m0s",
      "FAIL\texample.com/app/pkg/audit\t300.01s",
      "FAIL",
      "make: *** [test-changed] Error 1",
    ].join("\n");
    expect(failedTests(log)).toEqual({ targets: ["example.com/app/pkg/store", "example.com/app/pkg/audit"], tests: ["example.com/app/pkg/store TestSave", "example.com/app/pkg/audit"] });
  });

  test("bun: each (fail) under its file header; the closing summary is not attributed to the last file", () => {
    const log = ["test/unit/a.test.ts:", "(pass) a > works [1.00ms]", "(fail) a > races [12.50ms]", "", "test/unit/b.test.ts:", "(pass) b > fine", "", "1 tests failed:", "(fail) a > races [12.50ms]", "", " 3 pass", " 1 fail"].join("\n");
    expect(failedTests(log)).toEqual({ targets: ["test/unit/a.test.ts"], tests: ["test/unit/a.test.ts > a > races"] });
  });

  test("bun: a second run after the first's summary is read too, each failure under its own file", () => {
    const log = [
      "test/unit/a.test.ts:",
      "(fail) a > races [12.50ms]",
      "1 tests failed:",
      "(fail) a > races [12.50ms]",
      " 1 fail",
      "test/integration/b.test.ts:",
      "(fail) b > breaks [3.00ms]",
      "1 tests failed:",
      "(fail) b > breaks [3.00ms]",
      " 1 fail",
    ].join("\n");
    expect(failedTests(log)).toEqual({ targets: ["test/unit/a.test.ts", "test/integration/b.test.ts"], tests: ["test/unit/a.test.ts > a > races", "test/integration/b.test.ts > b > breaks"] });
  });

  test("a step log longer than what is read earns no rerun: an early failure there would go unread", () => {
    const dir = mkdtempSync(join(tmpdir(), "fl-flake-"));
    try {
      const tail = "--- FAIL: TestX (0.00s)\nFAIL\texample.com/app/pkg/b\t0.01s\n";
      const step = { ...initialSteps(["go test ./..."])[0]! };
      writeFileSync(join(dir, step.log), tail);
      const v = { dir } as Verification;
      expect(failuresOf(v, step)).toEqual({ targets: ["example.com/app/pkg/b"], tests: ["example.com/app/pkg/b TestX"] });
      writeFileSync(join(dir, step.log), `FAIL\texample.com/app/pkg/a\t0.01s\n${"x".repeat(300 * 1024)}\n${tail}`);
      expect(failuresOf(v, step)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no rerun: nothing named, a build or setup failure, an unhandled error, a failure with no file, too many targets, a name the shell would read as more", () => {
    expect(failedTests("error: something broke\nmake: *** Error 2")).toBeNull();
    expect(failedTests("FAIL\texample.com/app/pkg/store [build failed]\nFAIL\texample.com/app/pkg/web\t0.1s")).toBeNull();
    expect(failedTests("FAIL\texample.com/app/pkg/store [setup failed]")).toBeNull();
    expect(failedTests("test/a.test.ts:\n(fail) x\n# Unhandled error between tests")).toBeNull();
    expect(failedTests("(fail) orphan")).toBeNull();
    const many = Array.from({ length: MAX_TARGETS + 1 }, (_, i) => `FAIL\texample.com/p${i}\t0.1s`).join("\n");
    expect(failedTests(many)).toBeNull();
    expect(failedTests("FAIL\t-run=x\t0.1s")).toBeNull();
    expect(failedTests("FAIL\texample.com/$(touch)\t0.1s")).toBeNull();
    expect(failedTests("FAIL\texample.com/../etc\t0.1s")).toBeNull();
  });
});

describe("the rerun command and its shell", () => {
  test("{failed} takes the targets as plain words, wherever it appears", () => {
    expect(rerunCommand("go test -count=1 {failed}", ["a/b", "c/d"])).toBe("go test -count=1 a/b c/d");
    expect(rerunCommand('make test PKGS="{failed}"', ["a/b"])).toBe('make test PKGS="a/b"');
  });

  test("the command runs N times in a row, each run marked; the first failure ends it with its exit code", async () => {
    const run = async (command: string) => {
      const proc = Bun.spawn(["/bin/sh", "-c", repeatedCommand(command, 3)], { stdout: "pipe" });
      return { code: await proc.exited, out: await new Response(proc.stdout).text() };
    };
    const green = await run("echo ok # a trailing comment does not swallow the subshell");
    expect(green.code).toBe(0);
    expect(green.out.match(/flake rerun \d of 3/g)).toEqual(["flake rerun 1 of 3", "flake rerun 2 of 3", "flake rerun 3 of 3"]);
    const red = await run("exit 4");
    expect(red.code).toBe(4);
    expect(red.out.match(/flake rerun \d of 3/g)).toEqual(["flake rerun 1 of 3"]);
  });

  test("withRerun marks only the failed step, by its place and name", () => {
    const steps = initialSteps(["make vet", "make test-changed"]);
    const flake: BatchFlake = { head: "h", of: "v1", index: 1, step: "make test-changed", command: "go test a/b", targets: ["a/b"], tests: ["a/b TestX"], state: "pending", verification: null };
    expect(withRerun(steps, flake).map((s) => s.rerun ?? null)).toEqual([null, { of: "v1", command: "go test a/b", passes: 3, tests: ["a/b TestX"] }]);
    expect(withRerun(steps, { ...flake, step: "renamed" }).every((s) => !s.rerun)).toBe(true);
  });
});

describe("rerun_failed in config", () => {
  test("a step table's rerun_failed is read by flattened place, and never changes the verify policy", () => {
    const read = config('verify = ["make vet", [{ run = "make test-changed", rerun_failed = "go test {failed}" }, "make lint"]]\n')!;
    expect(read.rerun_failed).toEqual([null, "go test {failed}", null]);
    expect(verifyPolicyId(read)).toBe(verifyPolicyId(config('verify = ["make vet", ["make test-changed", "make lint"]]\n')!));
    expect(config('verify = ["make vet"]\n')!.rerun_failed).toBeUndefined();
  });

  test("refused: a command without {failed}, a non-string, and rerun_failed in light_verify", () => {
    expect(() => config('verify = [{ run = "go test ./...", rerun_failed = "go test ./..." }]\n')).toThrow(/must be a command that names \{failed\}/);
    expect(() => config('verify = [{ run = "go test ./...", rerun_failed = 3 }]\n')).toThrow(/rerun_failed/);
    expect(() => config('verify = ["x"]\nlanding = "batch"\nlight_verify = [{ run = "go test ./...", rerun_failed = "go test {failed}" }]\n')).toThrow(/light_verify cannot take rerun_failed/);
    expect(() => config('verify = [{ run = "x", retry = 1 }]\n')).toThrow(/a step table takes run, when_changed, rerun_failed, not retry/);
  });
});
