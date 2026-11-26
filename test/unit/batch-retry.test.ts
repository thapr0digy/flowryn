import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { envCause, halve, nextBatchMembers, splitStack, stackJson } from "../../src/verify/batch-retry.ts";
import type { LandingRow } from "../../src/verify/landing-queue.ts";
import type { Verification, VerifyStep } from "../../src/verify/store.ts";

/** How a red landing batch is judged and what verifies next (src/verify/batch-retry.ts). */

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-batch-retry-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const step = (over: Partial<VerifyStep> = {}): VerifyStep => ({ name: "bun test", state: "failed", exit: 1, ms: 10, log: "x.log", tests: null, detail: null, ...over });
const verification = (over: Partial<Verification> = {}): Verification =>
  ({ id: "v1", project_id: "web", pr_url: "batch:web/lb1", task_id: null, head_sha: "abc", state: "failed", steps: [step()], tests: null, detail: null, binary_path: null, dir, worktree_path: dir, project_path: dir, started_at: 1_000, finished_at: 2_000, policy_id: "p", ...over }) as Verification;
const hostEvent = (kind: "sched.host_ok" | "sched.host_blocked", ts: number, reason: string) => tx(db, () => appendEvent(db, { source: "daemon", kind, payload: { ok: kind === "sched.host_ok", reason }, ts }));
const LOAD = "load 2.40 per core, over 1.5";

describe("why a verify failed", () => {
  test("a step at its deadline is a timeout; a verify error is an error; a plain nonzero step is red", () => {
    expect(envCause(db, verification({ steps: [step({ exit: 124, attempts: 1, hangs: 1 })] }), null, "")).toBe("timeout");
    expect(envCause(db, verification({ state: "error", steps: [] }), null, "")).toBe("error");
    expect(envCause(db, verification(), null, "--- FAIL: TestSave\n")).toBe("red");
  });

  test("assumption: a test runner's own timeout lines (Go's panic, bun 1.4.4's per-test line) read as test_timeout; an ordinary failure does not", () => {
    expect(envCause(db, verification(), null, "ok  \tpkg/a\npanic: test timed out after 5m0s\nrunning tests:\n")).toBe("test_timeout");
    // bun 1.4.4's own output for a test over its timeout, verbatim.
    expect(envCause(db, verification(), null, "t.test.ts:\n(fail) slow [50.20ms]\n  ^ this test timed out after 50ms.\n")).toBe("test_timeout");
    expect(envCause(db, verification(), null, "(fail) store > saves [3.10ms]\nexpect(received).toBe(expected)\n")).toBe("red");
    expect(envCause(db, verification(), null, "expected the request to time out after 5m0s\n")).toBe("red");
  });

  test("load: the host refused on load at the verify's start or during it, or when it is judged; memory or after the verify does not count", () => {
    hostEvent("sched.host_blocked", 500, LOAD);
    expect(envCause(db, verification(), null, "")).toBe("load");
    hostEvent("sched.host_ok", 900, "ok");
    expect(envCause(db, verification(), null, "")).toBe("red");
    hostEvent("sched.host_blocked", 1_500, "2.0 GB available, under 8 GB");
    expect(envCause(db, verification(), null, "")).toBe("red");
    hostEvent("sched.host_blocked", 2_500, LOAD);
    expect(envCause(db, verification(), null, "")).toBe("red");
    hostEvent("sched.host_blocked", 1_800, LOAD);
    expect(envCause(db, verification(), null, "")).toBe("load");
  });

  test("a fresh host check refusing on load counts; one refusing on memory or one that could not be read does not", () => {
    expect(envCause(db, verification(), { ok: false, sample: null, reason: LOAD, holds: ["load"] }, "")).toBe("load");
    expect(envCause(db, verification(), { ok: false, sample: null, reason: "Docker VM CPU pressure 31.0% (some avg60), over 30%", holds: ["vm_cpu"] }, "")).toBe("load");
    expect(envCause(db, verification(), { ok: false, sample: null, reason: "2.0 GB available, under 8 GB", holds: ["memory"] }, "")).toBe("red");
    expect(envCause(db, verification(), { ok: false, sample: null, reason: "system-wide memory free 15%, under 20%", holds: ["mem_free"] }, "")).toBe("red");
    expect(envCause(db, verification(), null, "")).toBe("red");
  });
});

describe("the split stack", () => {
  const rows = (...ids: string[]) => ids.map((id) => ({ id, task_id: `t-${id}` }) as LandingRow);

  test("a red batch halves in line order, the first half rounded up", () => {
    expect(halve([1, 2, 3, 4, 5, 6, 7, 8])).toEqual({ first: [1, 2, 3, 4], rest: [5, 6, 7, 8] });
    expect(halve([1, 2, 3])).toEqual({ first: [1, 2], rest: [3] });
    expect(halve([1, 2])).toEqual({ first: [1], rest: [2] });
  });

  test("with a stack, the next batch is its first half still waiting, and nothing else joins; empty, up to batch_max", () => {
    const eligible = rows("lq5", "lq6", "lq7", "lq9");
    const stack = { since: 10, halves: [["lq4", "lq5", "lq6"], ["lq7", "lq8"]] };
    expect(nextBatchMembers(stack, eligible, 8)).toEqual({ members: rows("lq5", "lq6"), stack: { since: 10, halves: [["lq7", "lq8"]] } });
    // A half whose members all left is skipped.
    expect(nextBatchMembers({ since: 10, halves: [["lq1"], ["lq7"]] }, eligible, 8)).toEqual({ members: rows("lq7"), stack: { since: 10, halves: [] } });
    // No half left waiting: the stack is spent, and today's rule applies.
    expect(nextBatchMembers({ since: 10, halves: [["lq1"]] }, eligible, 2)).toEqual({ members: rows("lq5", "lq6"), stack: null });
    expect(nextBatchMembers(null, eligible, 3)).toEqual({ members: rows("lq5", "lq6", "lq7"), stack: null });
  });

  test("the stored stack: a spent one keeps its since; none is stored as nothing; a malformed one reads as none", () => {
    expect(splitStack({ split_rest: stackJson({ since: 1, halves: [] }) })).toEqual({ since: 1, halves: [] });
    expect(stackJson(null)).toBeNull();
    expect(splitStack({ split_rest: stackJson({ since: 1, halves: [["lq1"]] }) })).toEqual({ since: 1, halves: [["lq1"]] });
    expect(splitStack({ split_rest: "not json" })).toBeNull();
    expect(splitStack({ split_rest: '{"halves": 3}' })).toBeNull();
  });
});
