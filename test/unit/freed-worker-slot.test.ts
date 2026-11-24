import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type FlowrynConfig } from "../../src/config/config.ts";
import { contractRevision } from "../../src/contracts/revision.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { getRunWithPolicy } from "../../src/lifecycle/runs.ts";
import { sendBack } from "../../src/lifecycle/send-back.ts";
import { createSteer } from "../../src/lifecycle/steers.ts";
import type { HostVerdict } from "../../src/sched/host.ts";
import { FREED_AT_DELIVERY, holdsLease, workerFreedAtDelivery, workersToRetire } from "../../src/sched/pools.ts";
import { Scheduler } from "../../src/sched/scheduler.ts";

/**
 * A batch project's delivery frees its worker slot (docs/notes/2026-11-22-phase-free-the-rn.md):
 * the scheduler retires the idle worker, and a send-back starts a fresh session through a grant,
 * never a resume. Driven through the real scheduler and send-back, with the account, harness and
 * host checks stood in and the worker's exit and launch recorded.
 */

const HOME = "/tmp/fw-freed-slot";
const CONFIG = `[tools]\nclaude = "/bin/true"\n`;

let dir: string;
let db: Db;
const now = () => 1_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-freed-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  tx(db, () => {
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', '', ?1, 'main', 'local-only')").run(join(dir, "web"));
    db.query("INSERT INTO harness_contracts (harness, version, revision, passed_at) VALUES ('claude', '1', ?1, 0)").run(contractRevision("claude"));
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

type Slot = "freed" | "live" | "exited";

/** A delivered ship (ready, its last stage done) with a live, idle worker, and its worker slot as `slot` says. */
function delivered(run: string, slot: Slot, liveness = "idle"): void {
  const task = run.replace("r", "t");
  tx(db, () => {
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES (?1, 'web', 'ship', 'local-only', 1, 'fix', 0)").run(task);
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, model, state, liveness, workflow, stage, stage_state, agent_session, worktree_path, branch, base_sha,
         token_hash, started_at, updated_at, proc_pid, proc_start, proc_exe, idle_since)
       VALUES (?1, ?2, 'claude', '1', 'opus', 'ready', ?4, 'fix', 'ship', 'done', 'old-session', ?3, 'b', 'abc', 'h', 1, 1, 4242, 1, '/bin/claude', 1)`,
    ).run(run, task, join(dir, task), liveness);
    const released = slot === "live" ? null : slot === "freed" ? FREED_AT_DELIVERY : "the worker exited";
    db.query("INSERT INTO pool_leases (pool, run_id, stage, granted_at, released_at, released_by) VALUES ('worker', ?1, 'build', 0, ?2, ?3)").run(run, released === null ? null : 1, released);
  });
}

interface Recorded {
  exits: string[];
  launches: string[];
  logs: string[];
}

function scheduler(recorded: Recorded, exit: (runId: string) => { ok: boolean; detail?: string } = () => ({ ok: true, detail: "SIGTERM" }), config: FlowrynConfig = parseConfig(CONFIG, HOME)): Scheduler {
  return new Scheduler({
    db,
    config: () => config,
    now,
    log: (m) => recorded.logs.push(m),
    launch: (runId, mode) => {
      recorded.launches.push(`${runId}:${mode}`);
      db.query("UPDATE runs SET pending_launch = NULL WHERE id = ?1").run(runId);
    },
    isLaunching: () => false,
    exitWorker: async (runId) => {
      recorded.exits.push(runId);
      return exit(runId);
    },
    notify: () => {},
    startDeps: { db, config: () => config, runtime: () => null, harnessVersion: async () => "1", git: async () => null, signIn: async () => null, now },
    kickJournal: () => {},
    host: async () => ({ ok: true, reason: "test" }) as HostVerdict,
    quota: async () => ({ state: "known", percent: 80, window: "five_hour", resets_at: null }),
  });
}

async function pass(recorded: Recorded, exit?: (runId: string) => { ok: boolean; detail?: string }): Promise<void> {
  const s = scheduler(recorded, exit);
  await s.passNow();
  await s.stop();
}

const fresh = (): Recorded => ({ exits: [], launches: [], logs: [] });
const kinds = (run: string) => (db.query("SELECT kind FROM events WHERE run_id = ?1 ORDER BY seq").all(run) as { kind: string }[]).map((e) => e.kind);

function sendBackRun(run: string, text = "Light check: verify v9 failed: step `make vet` exited 1.\nIts last lines:\n\nvet: one.go:1: bad\n"): void {
  tx(db, () => {
    sendBack(db, getRunWithPolicy(db, run)!, { text, feedback: "light check failed", why: "light check failed", event: { source: "daemon", kind: "verify.sent_back", payload: { light: true } } }, now());
  });
}

describe("the slot freed at delivery", () => {
  test("only the run's latest worker slot counts, and only when its delivery freed it", () => {
    delivered("r1", "freed");
    delivered("r2", "live");
    delivered("r3", "exited");
    expect(["r1", "r2", "r3"].map((r) => workerFreedAtDelivery(db, r))).toEqual([true, false, false]);
    // A fresh worker's new slot is the latest: the run holds a slot again.
    tx(db, () => db.query("INSERT INTO pool_leases (pool, run_id, stage, granted_at) VALUES ('worker', 'r1', 'ship', 2)").run());
    expect(workerFreedAtDelivery(db, "r1")).toBe(false);
  });
});

describe("retiring the delivered worker", () => {
  test("an idle worker whose slot was freed at delivery exits by its identity, once, with an event", async () => {
    delivered("r1", "freed");
    const recorded = fresh();
    await pass(recorded);
    expect(recorded.exits).toEqual(["r1"]);
    expect(kinds("r1")).toContain("run.worker_retired");
    const payload = JSON.parse((db.query("SELECT payload FROM events WHERE kind = 'run.worker_retired'").get() as { payload: string }).payload);
    expect(payload).toEqual({ pid: 4242, reason: FREED_AT_DELIVERY, detail: "SIGTERM" });
    // The reconciler then reads it dead (exited after delivery); a dead worker is never retired again.
    tx(db, () => db.query("UPDATE runs SET liveness = 'dead' WHERE id = 'r1'").run());
    const again = fresh();
    await pass(again);
    expect(again.exits).toEqual([]);
  });

  test("a worker that holds its slot, exited for another reason, is busy, owes an acknowledgement or is sent back is kept", async () => {
    delivered("r1", "live");
    delivered("r2", "exited");
    delivered("r3", "freed", "busy");
    delivered("r4", "freed");
    delivered("r5", "freed");
    tx(db, () => {
      createSteer(db, getRunWithPolicy(db, "r4")!, "look at this", now());
      db.query("UPDATE runs SET state = 'running', stage_state = 'waiting', pending_launch = 'stage' WHERE id = 'r5'").run();
    });
    expect(workersToRetire(db)).toEqual([]);
  });

  test("a refused exit is logged, backs off, and records no retirement", async () => {
    delivered("r1", "freed");
    const recorded = fresh();
    await pass(recorded, () => ({ ok: false, detail: "ps cannot read the process table" }));
    expect(recorded.exits).toEqual(["r1"]);
    expect(recorded.logs.join("\n")).toContain("the delivered worker of r1 did not exit (ps cannot read the process table; attempt 1)");
    expect(kinds("r1")).not.toContain("run.worker_retired");
  });
});

describe("a send-back after the slot was freed", () => {
  test("starts a fresh session through the grant: the worker slot is taken again and the failure rides in the task file's note", async () => {
    delivered("r1", "freed");
    sendBackRun("r1");
    const run = getRunWithPolicy(db, "r1")!;
    expect(run).toMatchObject({ state: "running", stage: "ship", stage_state: "waiting", pending_launch: "stage" });
    expect(run.stage_note).toContain("vet: one.go:1: bad");
    const requested = JSON.parse((db.query("SELECT payload FROM events WHERE run_id = 'r1' AND kind = 'stage.requested'").get() as { payload: string }).payload);
    expect(requested).toMatchObject({ stage: "ship", fresh: true });

    const recorded = fresh();
    await pass(recorded);
    // The old worker exits before the new session starts; it is the grant's replacement, not a retirement.
    expect(recorded.exits).toEqual(["r1"]);
    expect(recorded.launches).toEqual(["r1:stage"]);
    expect(holdsLease(db, "r1", "worker")).toBe(true);
    expect(getRunWithPolicy(db, "r1")!.agent_session).not.toBe("old-session");
    expect(kinds("r1")).toEqual(expect.arrayContaining(["pool.granted", "stage.started", "run.fresh_worker"]));
    expect(kinds("r1")).not.toContain("run.worker_retired");
  });

  test("a worker that still holds its slot carries on with a steer; one gone for another reason resumes its session", () => {
    delivered("r1", "live");
    delivered("r2", "exited", "dead");
    sendBackRun("r1");
    sendBackRun("r2");
    expect(getRunWithPolicy(db, "r1")!.pending_launch).toBeNull();
    expect(getRunWithPolicy(db, "r2")!.pending_launch).toBe("resume");
  });
});
