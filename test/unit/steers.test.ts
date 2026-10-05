import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TIMING, type Timing } from "../../src/config/workers.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { taskTitleFrom } from "../../src/lifecycle/dispatch.ts";
import { getRun, type RunRow } from "../../src/lifecycle/runs.ts";
import { ackSteer, confirmPromptSeen, createSteer, dueSteers, flagUnackedSteers, getMessage, markLost, markRung, markSeen, nextDueAt, noteDeliveryMode, recentSteers, steerBrief, steerStatus, SteerBus } from "../../src/lifecycle/steers.ts";

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
    tx(db, () => markRung(db, m, run, "waiter", 0, false, timing));
    expect(dueSteers(db, "r1", 999, timing)).toEqual([]);
    expect(dueSteers(db, "r1", 1_000, timing).map((x) => x.id)).toEqual(["m1"]);
    tx(db, () => markRung(db, getMessage(db, "m1")!, run, "waiter", 1_000, false, timing));
    tx(db, () => markRung(db, getMessage(db, "m1")!, run, "waiter", 2_000, false, timing));
    expect(getMessage(db, "m1")!.rings).toBe(3);
    expect(dueSteers(db, "r1", 10_000, timing)).toEqual([]);
  });

  test("after the last ring and one more interval unacknowledged: one P1 per run", () => {
    const m = tx(db, () => createSteer(db, run, "x", 0));
    for (const at of [0, 1_000, 2_000]) tx(db, () => markRung(db, getMessage(db, m.id)!, run, "waiter", at, false, timing));
    expect(tx(db, () => flagUnackedSteers(db, 2_500, timing))).toEqual([]);
    expect(tx(db, () => flagUnackedSteers(db, 3_000, timing))).toEqual(["r1"]);
    expect(tx(db, () => flagUnackedSteers(db, 9_000, timing))).toEqual([]);
    const items = db.query("SELECT kind, lane FROM items").all();
    expect(items).toEqual([{ kind: "steer_unacked", lane: "P1" }]);
  });

  test("an ack after re-rings resolves the P1 and says so once, as information", () => {
    const m = tx(db, () => createSteer(db, run, "x", 0));
    for (const at of [0, 1_000, 2_000]) tx(db, () => markRung(db, getMessage(db, m.id)!, run, "waiter", at, false, timing));
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

function events(kind: string): Record<string, unknown>[] {
  return (db.query("SELECT payload FROM events WHERE kind = ?1 ORDER BY seq").all(kind) as { payload: string }[]).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
}

describe("seen and lost carries", () => {
  const slow: Timing = { ...DEFAULT_TIMING, ring_interval_ms: 300_000, seen_timeout_ms: 5_000, max_rings: 4 };

  test("an idle carry not seen within seen_timeout_ms rings again; a busy carry waits for the ring interval", () => {
    const idle = tx(db, () => createSteer(db, run, "idle one", 0));
    const busy = tx(db, () => createSteer(db, run, "busy one", 0));
    tx(db, () => markRung(db, idle, run, "waiter", 1_000, true, slow));
    tx(db, () => markRung(db, busy, run, "post-tool", 1_000, false, slow));
    expect(dueSteers(db, "r1", 5_999, slow)).toEqual([]);
    expect(nextDueAt(db, "r1", slow)).toBe(6_000);
    expect(dueSteers(db, "r1", 6_000, slow).map((m) => m.id)).toEqual([idle.id]);
    tx(db, () => markRung(db, getMessage(db, idle.id)!, run, "waiter", 6_000, true, slow));
    expect(events("steer.rung").at(-1)).toMatchObject({ steer: idle.id, ring: 2, again: "unseen" });
    expect(dueSteers(db, "r1", 10_999, slow)).toEqual([]);
    expect(dueSteers(db, "r1", 301_000, slow).map((m) => m.id)).toContain(busy.id);
  });

  test("a seen carry is not re-rung early, and seen_at keeps the first time", () => {
    const m = tx(db, () => createSteer(db, run, "x", 0));
    tx(db, () => markRung(db, m, run, "waiter", 100, true, slow));
    expect(tx(db, () => markSeen(db, run, null, "prompt", 150))).toEqual([m.id]);
    expect(dueSteers(db, "r1", 60_000, slow)).toEqual([]);
    expect(getMessage(db, m.id)).toMatchObject({ seen_at: 150, ring_state: "seen" });
    expect(events("steer.seen")).toEqual([{ steer: m.id, ring: 1, via: "prompt", after_carry_ms: 50 }]);
    tx(db, () => markRung(db, getMessage(db, m.id)!, run, "waiter", 300_100, true, slow));
    tx(db, () => markSeen(db, run, [m.id], "context", 300_200));
    expect(getMessage(db, m.id)!.seen_at).toBe(150);
    expect(steerStatus(getMessage(db, m.id)!, 400_000)).toBe("carried +100ms, seen +150ms");
  });

  test("markSeen with ids marks only those; markLost makes an unseen carry due at once", () => {
    const a = tx(db, () => createSteer(db, run, "a", 0));
    const b = tx(db, () => createSteer(db, run, "b", 0));
    tx(db, () => markRung(db, a, run, "extension", 10, false, slow));
    tx(db, () => markRung(db, b, run, "extension", 10, false, slow));
    expect(tx(db, () => markSeen(db, run, [b.id, "m99"], "context", 20))).toEqual([b.id]);
    expect(tx(db, () => markLost(db, run, "interrupted", 30))).toEqual([a.id]);
    expect(dueSteers(db, "r1", 30, slow).map((m) => m.id)).toEqual([a.id]);
    expect(steerBrief(db, "r1", 30)).toBe(`${a.id} lost, ringing`);
    tx(db, () => markRung(db, getMessage(db, a.id)!, run, "extension", 40, true, slow));
    expect(events("steer.rung").at(-1)).toMatchObject({ steer: a.id, ring: 2, again: "lost" });
  });

  test("a carry seen only at a Claude turn's prompt is lost when the turn fails, and rings again at once", () => {
    const m = tx(db, () => createSteer(db, run, "x", 0));
    tx(db, () => markRung(db, m, run, "waiter", 100, true, slow));
    tx(db, () => markSeen(db, run, null, "prompt", 150));
    expect(tx(db, () => markLost(db, run, "turn failed", 200))).toEqual([m.id]);
    expect(getMessage(db, m.id)).toMatchObject({ ring_state: "lost", seen_at: 150 });
    expect(dueSteers(db, "r1", 200, slow).map((x) => x.id)).toEqual([m.id]);
    expect(events("steer.lost")).toEqual([{ steer: m.id, ring: 1, reason: "turn failed", seen_via: "prompt" }]);
    tx(db, () => markRung(db, getMessage(db, m.id)!, run, "waiter", 210, true, slow));
    expect(getMessage(db, m.id)).toMatchObject({ ring_state: "carried", seen_via: null });
  });

  test("a later hook in the turn confirms a prompt-seen carry, so a failed turn keeps it seen", () => {
    const m = tx(db, () => createSteer(db, run, "x", 0));
    tx(db, () => markRung(db, m, run, "waiter", 100, true, slow));
    tx(db, () => markSeen(db, run, null, "prompt", 150));
    tx(db, () => confirmPromptSeen(db, run, "pre-tool"));
    expect(tx(db, () => markLost(db, run, "turn failed", 200))).toEqual([]);
    expect(getMessage(db, m.id)).toMatchObject({ ring_state: "seen", seen_via: "pre-tool" });
    expect(dueSteers(db, "r1", 60_000, slow)).toEqual([]);
  });

  test("a carry seen by the Pi context event is not lost on an interrupt", () => {
    const m = tx(db, () => createSteer(db, run, "x", 0));
    tx(db, () => markRung(db, m, run, "extension", 100, true, slow));
    tx(db, () => markSeen(db, run, [m.id], "context", 150));
    expect(tx(db, () => markLost(db, run, "interrupted", 200))).toEqual([]);
  });

  test("the Pi extension's delivery mode decides whether an unseen carry is idle", () => {
    const m = tx(db, () => createSteer(db, run, "x", 0));
    tx(db, () => markRung(db, m, run, "extension", 0, true, slow));
    expect(tx(db, () => noteDeliveryMode(db, run, m.id, "steer", 5))).toBe(true);
    expect(dueSteers(db, "r1", 10_000, slow)).toEqual([]);
    expect(events("steer.delivered")).toEqual([{ steer: m.id, ring: 1, mode: "steer" }]);
    tx(db, () => markSeen(db, run, [m.id], "context", 20));
    expect(tx(db, () => noteDeliveryMode(db, run, m.id, "followUp", 30))).toBe(false);
  });

  test("a max_rings cap still holds for fast re-rings", () => {
    const m = tx(db, () => createSteer(db, run, "x", 0));
    for (const at of [0, 5_000, 10_000, 15_000]) tx(db, () => markRung(db, getMessage(db, m.id)!, run, "waiter", at, true, slow));
    expect(dueSteers(db, "r1", 1_000_000, slow)).toEqual([]);
    expect(nextDueAt(db, "r1", slow)).toBeNull();
  });

  test("recentSteers keeps every unacknowledged steer and the latest acknowledged ones", () => {
    const first = tx(db, () => createSteer(db, run, "old, never acked", 0));
    for (let i = 1; i <= 6; i++) {
      const m = tx(db, () => createSteer(db, run, `n${i}`, i));
      tx(db, () => ackSteer(db, run, m, i + 1));
    }
    expect(recentSteers(db, "r1", 3).map((m) => m.id)).toEqual([first.id, "m5", "m6", "m7"]);
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
