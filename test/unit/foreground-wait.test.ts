import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TIMING } from "../../src/config/workers.ts";
import { migrate, openDb, type Db } from "../../src/db/db.ts";
import { getRun } from "../../src/lifecycle/runs.ts";
import type { SteerBus } from "../../src/lifecycle/steers.ts";
import { Reconciler } from "../../src/reconcile/reconciler.ts";
import type { HerdrRuntime } from "../../src/runtime/herdr/runtime.ts";

/**
 * The design's assumption behind the foreground pipeline wait
 * (docs/notes/2026-10-23-workers-wait-on-fn.md): one `no-mistakes axi run
 * --wait` blocks a Bash call for up to 8 minutes, no-mistakes' default, with
 * no hook in between, and the worker must still read busy, with nothing
 * raised for the leader.
 */

const NO_MISTAKES_DEFAULT_WAIT_MS = 8 * 60_000;
/** The call's own start and return around the wait. */
const CALL_OVERHEAD_MS = 60_000;
const PID = 999_999;
const START = new Date(2026, 9, 23, 10, 0, 0).getTime();

const dirs: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A running ship whose pre-tool hook for the long Bash call landed at `hookAt`: busy, its lease from that hook. */
function busyRun(hookAt: number): Db {
  const dir = mkdtempSync(join(tmpdir(), "fw-fgwait-"));
  dirs.push(dir);
  const db = openDb(join(dir, "flowryn.db"));
  dbs.push(db);
  migrate(db);
  db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', 'u', ?1, 'main', 'no-mistakes')").run(dir);
  db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES ('t1', 'web', 'ship', 'no-mistakes', 0, 'feature', ?1)").run(hookAt);
  db.query(
    `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, pane_id, agent_session, worktree_path, branch, base_sha,
       proc_pid, proc_start, proc_exe, token_hash, started_at, updated_at, worker_started_at, last_hook_at, busy_until, idle_since)
     VALUES ('r1', 't1', 'claude', '1', 'running', 'busy', 'feature', 'ship', 'w:1', 'sess', ?1, 'b', 'abc', ?2, ?3, 'claude', 'h', ?4, ?4, ?4, ?4, ?5, NULL)`,
  ).run(dir, PID, START, hookAt, hookAt + DEFAULT_TIMING.busy_lease_ms);
  return db;
}

function reconcilerAt(db: Db, now: number): Reconciler {
  const runtime = {
    processes: (paneId: string) => Promise.resolve({ paneId, shellPid: 1, foregroundGroup: PID, processes: [{ pid: PID, cwd: "" }] }),
    snapshotPanes: () => Promise.resolve([]),
    // Herdr reads a Claude worker "working" throughout a long tool call (M0 h02).
    agentStatus: () => Promise.resolve("working"),
  } as unknown as HerdrRuntime;
  return new Reconciler({
    db,
    runtime: () => runtime,
    launch: () => {},
    isLaunching: () => false,
    bus: { notify() {}, hasWaiter: () => false } as unknown as SteerBus,
    timing: () => DEFAULT_TIMING,
    log: () => {},
    now: () => now,
    ps: () => Promise.resolve(`${PID} Fri Oct 23 10:00:00 2026 claude\n`),
  });
}

function raised(db: Db): { items: string[]; events: string[] } {
  const items = (db.query("SELECT kind FROM items WHERE run_id = 'r1'").all() as { kind: string }[]).map((r) => r.kind);
  const events = (db.query("SELECT kind FROM events WHERE run_id = 'r1' AND kind IN ('run.idle_alert', 'run.stale_hooks', 'run.blocked_prompt')").all() as { kind: string }[]).map((r) => r.kind);
  return { items, events };
}

describe("assumption: a foreground no-mistakes --wait keeps the worker busy", () => {
  test("the busy lease and the stale-hook pointer outlast the default wait plus the call's overhead", () => {
    expect(DEFAULT_TIMING.busy_lease_ms).toBeGreaterThan(NO_MISTAKES_DEFAULT_WAIT_MS + CALL_OVERHEAD_MS);
    expect(DEFAULT_TIMING.stale_hook_ms).toBeGreaterThan(NO_MISTAKES_DEFAULT_WAIT_MS + CALL_OVERHEAD_MS);
  });

  test("a reconciler pass 9 minutes into the call, Herdr reading working: still busy, nothing raised", async () => {
    const hookAt = Date.now();
    const db = busyRun(hookAt);
    const reconciler = reconcilerAt(db, hookAt + NO_MISTAKES_DEFAULT_WAIT_MS + CALL_OVERHEAD_MS);
    try {
      await reconciler.reconcileRun(getRun(db, "r1")!, "steady");
    } finally {
      reconciler.stop();
    }
    expect(getRun(db, "r1")!.liveness).toBe("busy");
    expect(raised(db)).toEqual({ items: [], events: [] });
  });
});
