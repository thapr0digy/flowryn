import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TIMING, type Timing } from "../../src/config/workers.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { taskTitleFrom } from "../../src/lifecycle/dispatch.ts";
import { getRun, type RunRow } from "../../src/lifecycle/runs.ts";
import { ackSteer, createSteer, dueSteers, flagUnackedSteers, getMessage, markRung, SteerBus } from "../../src/lifecycle/steers.ts";

let dir: string;
let db: Db;
let run: RunRow;
const timing: Timing = { ...DEFAULT_TIMING, ring_interval_ms: 1_000, max_rings: 3 };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-st-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  tx(db, () => {
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('p', '', '/p', 'main', 'local-only')").run();
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES ('t1', 'p', 'scout', 'local-only', 0, 'scout', 0)").run();
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
       VALUES ('r1', 't1', 'claude', 'v', 'running', 'idle', 'scout', 'investigate', '/w', 'b', 's', 'h', 0, 0)`,
    ).run();
  });
  run = getRun(db, "r1")!;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("steer rings", () => {
  test("a steer is due at once, again one ring interval after each ring, and never past max_rings", () => {
    const m = tx(db, () => createSteer(db, run, "use the new API", 0));
    expect(m.id).toBe("m1");
    expect(dueSteers(db, "r1", 0, timing).map((x) => x.id)).toEqual(["m1"]);
    tx(db, () => markRung(db, m, run, "waiter", 0));
    expect(dueSteers(db, "r1", 999, timing)).toEqual([]);
    expect(dueSteers(db, "r1", 1_000, timing).map((x) => x.id)).toEqual(["m1"]);
    tx(db, () => markRung(db, getMessage(db, "m1")!, run, "waiter", 1_000));
    tx(db, () => markRung(db, getMessage(db, "m1")!, run, "waiter", 2_000));
    expect(getMessage(db, "m1")!.rings).toBe(3);
    expect(dueSteers(db, "r1", 10_000, timing)).toEqual([]);
  });

  test("after the last ring and one more interval unacknowledged: one P1 per run", () => {
    const m = tx(db, () => createSteer(db, run, "x", 0));
    for (const at of [0, 1_000, 2_000]) tx(db, () => markRung(db, getMessage(db, m.id)!, run, "waiter", at));
    expect(tx(db, () => flagUnackedSteers(db, 2_500, timing))).toEqual([]);
    expect(tx(db, () => flagUnackedSteers(db, 3_000, timing))).toEqual(["r1"]);
    expect(tx(db, () => flagUnackedSteers(db, 9_000, timing))).toEqual([]);
    const items = db.query("SELECT kind, lane FROM items").all();
    expect(items).toEqual([{ kind: "steer_unacked", lane: "P1" }]);
  });

  test("an ack after re-rings resolves the P1 and says so once, as information", () => {
    const m = tx(db, () => createSteer(db, run, "x", 0));
    for (const at of [0, 1_000, 2_000]) tx(db, () => markRung(db, getMessage(db, m.id)!, run, "waiter", at));
    tx(db, () => flagUnackedSteers(db, 3_000, timing));
    expect(tx(db, () => ackSteer(db, run, getMessage(db, m.id)!, 4_000))).toEqual({ already: false });
    expect(tx(db, () => ackSteer(db, run, getMessage(db, m.id)!, 5_000))).toEqual({ already: true });
    const items = db.query("SELECT kind, class, state FROM items ORDER BY opened_at, id").all();
    expect(items).toEqual([
      { kind: "steer_unacked", class: "actionable", state: "resolved" },
      { kind: "steer_acked", class: "info", state: "open" },
    ]);
  });
});

describe("the waiter bus", () => {
  test("a newer waiter supersedes an older one; an older one arriving later is refused", async () => {
    const bus = new SteerBus();
    expect(bus.register("r1", "01B")).toBe(true);
    const older = bus.wait("r1", "01B", 5_000);
    expect(bus.register("r1", "01C")).toBe(true);
    expect(await older).toBe("superseded");
    expect(bus.register("r1", "01A")).toBe(false);
  });

  test("notify wakes a waiting waiter; a queued command is taken once", async () => {
    const bus = new SteerBus();
    bus.register("r1", "01A");
    const waiting = bus.wait("r1", "01A", 5_000);
    bus.command("r1", "interrupt");
    expect(await waiting).toBe("wake");
    expect(bus.takeCommand("r1")).toBe("interrupt");
    expect(bus.takeCommand("r1")).toBeNull();
  });

  test("closing the bus at shutdown answers every waiter at once", async () => {
    const bus = new SteerBus();
    bus.register("r1", "01A");
    const waiting = bus.wait("r1", "01A", 60_000);
    bus.close();
    expect(await waiting).toBe("timeout");
    expect(await bus.wait("r1", "01A", 60_000)).toBe("timeout");
  });
});

describe("dispatch titles", () => {
  test("the first line of the body, without markdown or a trailing tasks-axi tag", () => {
    expect(taskTitleFrom(undefined, "\n# Fix the login loop (pr: x)\nmore")).toBe("Fix the login loop");
    expect(taskTitleFrom("explicit", "body")).toBe("explicit");
    expect(taskTitleFrom(undefined, "x".repeat(300)).length).toBe(120);
    expect(() => taskTitleFrom(undefined, "   \n  ")).toThrow("needs a title");
  });
});
