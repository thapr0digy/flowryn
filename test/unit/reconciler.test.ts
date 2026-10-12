import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openItem } from "../../src/attention/items.ts";
import { DEFAULT_TIMING } from "../../src/config/workers.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { getRun } from "../../src/lifecycle/runs.ts";
import type { SteerBus } from "../../src/lifecycle/steers.ts";
import { herdrEpisode, noteHerdrDown } from "../../src/reconcile/herdr-health.ts";
import { Reconciler } from "../../src/reconcile/reconciler.ts";
import type { HerdrRuntime } from "../../src/runtime/herdr/runtime.ts";

const dirs: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A database with one running run whose recorded process is gone and whose session can be resumed. */
function deadRunDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "fw-reconciler-"));
  dirs.push(dir);
  const db = openDb(join(dir, "flowryn.db"));
  dbs.push(db);
  migrate(db);
  const now = Date.now();
  db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', 'u', ?1, 'main', 'local-only')").run(dir);
  db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES ('t1', 'web', 'scout', 'local-only', 0, 'scout', ?1)").run(now);
  db.query(
    `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, pane_id, agent_session, worktree_path, branch, base_sha,
       proc_pid, proc_start, proc_exe, token_hash, started_at, updated_at)
     VALUES ('r1', 't1', 'claude', '1', 'running', 'busy', 'scout', 'investigate', 'w:1', 'sess', ?1, 'b', 'abc', 999999, 1, 'claude', 'h', ?2, ?2)`,
  ).run(dir, now);
  return db;
}

const slow = <T>(value: T) => Bun.sleep(40).then(() => value);

describe("reconciler", () => {
  test("a startup pass racing the connect-scheduled pass resumes a dead run once", async () => {
    const db = deadRunDb();
    const launches: string[] = [];
    const runtime = {
      processes: (paneId: string) => slow({ paneId, shellPid: 1, foregroundGroup: 1, processes: [] }),
      snapshotPanes: () => slow([]),
      agentStatus: () => slow(null),
    } as unknown as HerdrRuntime;
    const reconciler = new Reconciler({
      db,
      runtime: () => runtime,
      launch: (runId, mode) => launches.push(`${runId}:${mode}`),
      isLaunching: () => false,
      bus: { notify() {} } as unknown as SteerBus,
      timing: () => DEFAULT_TIMING,
      log: () => {},
      now: Date.now,
      ps: () => slow(""),
    });

    reconciler.schedule(undefined, "startup");
    await reconciler.passNow("startup");
    await Bun.sleep(300);
    reconciler.stop();

    expect(launches).toEqual(["r1:resume"]);
    expect((db.query("SELECT resume_count FROM runs WHERE id = 'r1'").get() as { resume_count: number }).resume_count).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM items WHERE run_id = 'r1' AND kind = 'auto_resumed'").get()).toEqual({ n: 1 });
  });

  test("a live run whose pane reads with no foreground group yet (M0 h02's handoff reply) is unknown for the pass, never orphaned", async () => {
    const db = deadRunDb();
    const start = new Date(2026, 9, 12, 10, 0, 0).getTime();
    db.query("UPDATE runs SET proc_start = ?1, liveness = 'idle' WHERE id = 'r1'").run(start);
    const launches: string[] = [];
    const runtime = {
      processes: (paneId: string) => Promise.resolve({ paneId, shellPid: 1, foregroundGroup: null, processes: [] }),
      snapshotPanes: () => Promise.resolve([]),
      agentStatus: () => Promise.resolve(null),
    } as unknown as HerdrRuntime;
    const reconciler = new Reconciler({
      db,
      runtime: () => runtime,
      launch: (runId, mode) => launches.push(`${runId}:${mode}`),
      isLaunching: () => false,
      bus: { notify() {} } as unknown as SteerBus,
      timing: () => DEFAULT_TIMING,
      log: () => {},
      now: Date.now,
      ps: () => Promise.resolve("999999 Mon Oct 12 10:00:00 2026 claude\n"),
    });

    const outcome = await reconciler.reconcileRun(getRun(db, "r1")!, "steady");
    reconciler.stop();

    expect(outcome).toBe("unknown");
    expect(db.query("SELECT liveness FROM runs WHERE id = 'r1'").get()).toEqual({ liveness: "unknown" });
    expect(db.query("SELECT COUNT(*) AS n FROM divergences").get()).toEqual({ n: 0 });
    expect(launches).toEqual([]);
  });

  test("a Herdr read that answers ends a Herdr outage episode", async () => {
    const db = deadRunDb();
    tx(db, () => noteHerdrDown(db, "ping timed out", "cli", Date.now() - 120_000));
    const runtime = {
      processes: (paneId: string) => Promise.resolve({ paneId, shellPid: 1, foregroundGroup: 1, processes: [] }),
      snapshotPanes: () => Promise.resolve([]),
      agentStatus: () => Promise.resolve(null),
    } as unknown as HerdrRuntime;
    const reconciler = new Reconciler({
      db,
      runtime: () => runtime,
      launch: () => {},
      isLaunching: () => false,
      bus: { notify() {} } as unknown as SteerBus,
      timing: () => DEFAULT_TIMING,
      log: () => {},
      now: Date.now,
      ps: () => Promise.resolve(""),
    });

    await reconciler.passNow("steady");
    reconciler.stop();

    expect(herdrEpisode(db)).toBeNull();
    expect(db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'herdr.reachable'").get()).toEqual({ n: 1 });
  });

  test("a dead run's open blocked_prompt item is resolved on its final death (resume_count already 1: no auto-resume to carry a hook)", async () => {
    const db = deadRunDb();
    db.query("UPDATE runs SET resume_count = 1 WHERE id = 'r1'").run();
    const now = Date.now();
    tx(db, () => {
      const event = appendEvent(db, { source: "hook", kind: "run.blocked_prompt", runId: "r1", taskId: "t1", payload: {}, ts: now });
      openItem(db, { kind: "blocked_prompt", eventSeq: event.seq, line: "waiting on a confirmation", taskId: "t1", runId: "r1", now });
    });
    const runtime = {
      processes: () => Promise.resolve(null),
      snapshotPanes: () => Promise.resolve([]),
      agentStatus: () => Promise.resolve(null),
    } as unknown as HerdrRuntime;
    const reconciler = new Reconciler({
      db,
      runtime: () => runtime,
      launch: () => {},
      isLaunching: () => false,
      bus: { notify() {} } as unknown as SteerBus,
      timing: () => DEFAULT_TIMING,
      log: () => {},
      now: Date.now,
      ps: () => Promise.resolve(""),
    });

    await reconciler.passNow("steady");
    reconciler.stop();

    expect((db.query("SELECT state FROM items WHERE kind = 'blocked_prompt' AND run_id = 'r1'").get() as { state: string }).state).toBe("resolved");
  });
});
