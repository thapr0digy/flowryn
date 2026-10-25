import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_TMP_MAX_BYTES, ensureRunTmp, removeRunTmp, runTmpDir, sweepRunTmp, workerTmpDir, workerTmpEnv } from "../../src/lifecycle/run-tmp.ts";

const uid = process.getuid?.() ?? 0;
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A short scratch directory under /tmp, as a real root is (a test's tmpdir() can be too long for Claude's limit). */
function scratch(): string {
  const dir = mkdtempSync("/tmp/fwu-");
  made.push(dir);
  return dir;
}

const RUN_A = "r01M5K0ZV99EH391B278TH91JNQ";
const RUN_B = "r01M5K0ZV99EH391B278TH91ABC";
const STATE = "/h/state";

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("the run temp dir's path", () => {
  test("the last 12 characters of the run id, under the root", () => {
    expect(runTmpDir("/tmp/fw-501", RUN_A)).toBe("/tmp/fw-501/1B278TH91JNQ");
    expect(runTmpDir("/tmp/fw-501", RUN_A)).not.toBe(runTmpDir("/tmp/fw-501", RUN_B));
  });

  test("A1: a Claude worker's TMPDIR is the per-uid dir Claude's sandbox derives from CLAUDE_CODE_TMPDIR", () => {
    const dir = "/tmp/fw-501/H391B278TH91";
    expect(workerTmpEnv("claude", dir)).toEqual({ CLAUDE_CODE_TMPDIR: dir, TMPDIR: `${dir}/claude-${uid}` });
    // The default root leaves room under Claude's limit (it measures the path as given) for any uid up to 7 digits.
    expect(Buffer.byteLength(`/tmp/fw-1000001/H391B278TH91/claude-1000001`)).toBeLessThanOrEqual(CLAUDE_TMP_MAX_BYTES);
  });

  test("A4: a Pi worker's TMPDIR is the run dir itself (Pi has no sandbox to override it)", () => {
    expect(workerTmpEnv("pi", "/tmp/fw-501/H391B278TH91")).toEqual({ TMPDIR: "/tmp/fw-501/H391B278TH91" });
  });
});

describe("ensureRunTmp", () => {
  test("makes the root, the run dir and Claude's subdir private, and names the owner", () => {
    const root = join(scratch(), "root");
    const tmp = ensureRunTmp({ root, runId: RUN_A, stateDir: STATE, harness: "claude" });
    expect(tmp.dir).toBe(runTmpDir(root, RUN_A));
    expect(tmp.workerTmp).toBe(workerTmpDir("claude", tmp.dir));
    for (const path of [root, tmp.dir, tmp.workerTmp]) expect(mode(path)).toBe(0o700);
    expect(JSON.parse(readFileSync(join(tmp.dir, ".flowryn-run"), "utf8"))).toEqual({ run: RUN_A, state_dir: STATE });
    // macOS: /tmp is /private/tmp, so the sandbox gets both spellings.
    expect(tmp.writable).toContain(tmp.dir);
    expect(tmp.writable).toContain(realpathSync(tmp.dir));
  });

  test("a resume finds the same directory, with what the worker left in it", () => {
    const root = join(scratch(), "root");
    const first = ensureRunTmp({ root, runId: RUN_A, stateDir: STATE, harness: "pi" });
    writeFileSync(join(first.workerTmp, "intent.txt"), "mine\n");
    const again = ensureRunTmp({ root, runId: RUN_A, stateDir: STATE, harness: "pi" });
    expect(again.dir).toBe(first.dir);
    expect(readFileSync(join(again.workerTmp, "intent.txt"), "utf8")).toBe("mine\n");
  });

  test("two runs never share one", () => {
    const root = join(scratch(), "root");
    const a = ensureRunTmp({ root, runId: RUN_A, stateDir: STATE, harness: "claude" });
    const b = ensureRunTmp({ root, runId: RUN_B, stateDir: STATE, harness: "claude" });
    expect(a.workerTmp).not.toBe(b.workerTmp);
  });

  test("refuses a directory another run or another home owns (a run id tail collision)", () => {
    const root = join(scratch(), "root");
    ensureRunTmp({ root, runId: RUN_A, stateDir: STATE, harness: "pi" });
    const twin = "x".repeat(14) + RUN_A.slice(-12);
    expect(() => ensureRunTmp({ root, runId: twin, stateDir: STATE, harness: "pi" })).toThrow(`belongs to run ${RUN_A}`);
    expect(() => ensureRunTmp({ root, runId: RUN_A, stateDir: "/other/state", harness: "pi" })).toThrow("belongs to run");
  });

  test("refuses a root that is a symlink, or open to other users: /tmp is shared", () => {
    const base = scratch();
    const real = join(base, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, join(base, "link"));
    expect(() => ensureRunTmp({ root: join(base, "link"), runId: RUN_A, stateDir: STATE, harness: "pi" })).toThrow("is not a plain directory");
    const open = join(base, "open");
    mkdirSync(open);
    chmodSync(open, 0o755);
    expect(() => ensureRunTmp({ root: open, runId: RUN_A, stateDir: STATE, harness: "pi" })).toThrow("is open to other users (mode 755)");
  });

  test("refuses a Claude path over Claude's limit, which would fall back to the shared /tmp/claude-<uid>; Pi has no limit", () => {
    const root = join(scratch(), "a-root-long-enough-to-pass-the-limit");
    expect(() => ensureRunTmp({ root, runId: RUN_A, stateDir: STATE, harness: "claude" })).toThrow("set a shorter [workers] tmp_root");
    expect(existsSync(root)).toBe(false);
    expect(ensureRunTmp({ root, runId: RUN_A, stateDir: STATE, harness: "pi" }).dir).toBe(runTmpDir(root, RUN_A));
  });
});

describe("removeRunTmp", () => {
  test("removes the run's own directory, and leaves one it does not own", () => {
    const root = join(scratch(), "root");
    const tmp = ensureRunTmp({ root, runId: RUN_A, stateDir: STATE, harness: "claude" });
    writeFileSync(join(tmp.workerTmp, "scratch.txt"), "x");
    expect(removeRunTmp({ root, runId: RUN_A, stateDir: "/other/state" })).toBe("not_ours");
    expect(existsSync(tmp.dir)).toBe(true);
    expect(removeRunTmp({ root, runId: RUN_A, stateDir: STATE })).toBe("removed");
    expect(existsSync(tmp.dir)).toBe(false);
    expect(removeRunTmp({ root, runId: RUN_A, stateDir: STATE })).toBe("absent");
  });

  test("never follows a symlink planted at the run's path", () => {
    const base = scratch();
    const root = join(base, "root");
    mkdirSync(root, { mode: 0o700 });
    const target = join(base, "target");
    mkdirSync(target);
    writeFileSync(join(target, ".flowryn-run"), JSON.stringify({ run: RUN_A, state_dir: STATE }));
    symlinkSync(target, runTmpDir(root, RUN_A));
    expect(removeRunTmp({ root, runId: RUN_A, stateDir: STATE })).toBe("not_ours");
    expect(existsSync(join(target, ".flowryn-run"))).toBe(true);
  });
});

describe("sweepRunTmp", () => {
  test("removes this home's dirs whose run is gone or cleaned and a deleted home's; keeps live runs', another home's and foreign dirs", () => {
    const base = scratch();
    const root = join(base, "root");
    const otherHome = join(base, "other-state");
    mkdirSync(otherHome);
    const live = ensureRunTmp({ root, runId: "r0000000000000000000000LIVE1", stateDir: STATE, harness: "pi" });
    const done = ensureRunTmp({ root, runId: "r0000000000000000000000DONE1", stateDir: STATE, harness: "pi" });
    const other = ensureRunTmp({ root, runId: "r0000000000000000000000OTHR1", stateDir: otherHome, harness: "pi" });
    const gone = ensureRunTmp({ root, runId: "r0000000000000000000000GONE1", stateDir: join(base, "deleted-state"), harness: "pi" });
    const foreign = join(root, "not-a-run");
    mkdirSync(foreign);
    const swept = sweepRunTmp({ root, stateDir: STATE, keep: (run) => run.endsWith("LIVE1") });
    expect(swept.removed.toSorted()).toEqual([done.dir, gone.dir].toSorted());
    expect(swept.failed).toEqual([]);
    for (const kept of [live.dir, other.dir, foreign]) expect(existsSync(kept)).toBe(true);
  });

  test("a missing root is nothing to sweep", () => {
    expect(sweepRunTmp({ root: join(scratch(), "none"), stateDir: STATE, keep: () => false })).toEqual({ removed: [], failed: [] });
  });
});
