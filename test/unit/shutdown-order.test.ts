import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TIMING } from "../../src/config/workers.ts";
import { InFlight, settleWithin } from "../../src/daemon/inflight.ts";
import { migrate, openDb, type Db } from "../../src/db/db.ts";
import type { SteerBus } from "../../src/lifecycle/steers.ts";
import { Reconciler } from "../../src/reconcile/reconciler.ts";
import { RUN_TOKEN, type HerdrRuntime, type PaneInfo } from "../../src/runtime/herdr/runtime.ts";

/**
 * The daemon's shutdown order (2026-10-23: "RangeError: Cannot use a closed
 * database" at getRun ← scanOrphans ← a reconcile pass that ran on after the
 * database was closed). Stopping waits for the pass under way, and a pass
 * that is stopped touches no table after its next await.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "fw-shutdown-"));
  dirs.push(dir);
  const db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  return db;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A reconciler whose pane snapshot (the orphan scan's Herdr call) waits until the test releases it. */
function reconcilerWithSlowHerdr(db: Db, errors: unknown[]) {
  const snapshot = deferred<PaneInfo[]>();
  let asked = false;
  const runtime = {
    processes: async (paneId: string) => ({ paneId, shellPid: 1, foregroundGroup: 1, processes: [] }),
    snapshotPanes: () => {
      asked = true;
      return snapshot.promise;
    },
    agentStatus: async () => null,
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
    ps: async () => "",
  });
  // The pass is what the steady timer starts; anything it throws is what launchd.err.log showed.
  const pass = reconciler.passNow("steady").catch((error: unknown) => errors.push(error));
  return { reconciler, pass, release: () => snapshot.resolve([{ paneId: "w:9", tokens: { [RUN_TOKEN]: "r1" } } as unknown as PaneInfo]), asked: () => asked };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check() && Date.now() < deadline) await Bun.sleep(5);
  expect(check()).toBe(true);
}

describe("shutdown order", () => {
  test("assumption: the reconciler's stop resolves only after the pass under way has ended, so the database closes after its last use", async () => {
    const db = freshDb();
    const errors: unknown[] = [];
    const slow = reconcilerWithSlowHerdr(db, errors);
    await until(slow.asked);
    let stopped = false;
    const stopping = slow.reconciler.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(30);
    expect(stopped).toBe(false);
    slow.release();
    await stopping;
    db.close();
    await slow.pass;
    expect(errors).toEqual([]);
  });

  test("a pass stopped while it waits on Herdr touches no table afterwards, even when the database is already closed", async () => {
    const db = freshDb();
    const errors: unknown[] = [];
    const slow = reconcilerWithSlowHerdr(db, errors);
    await until(slow.asked);
    const stopping = slow.reconciler.stop();
    // The shutdown grace ran out: the database closes while the pass still waits.
    db.close();
    slow.release();
    await stopping;
    await slow.pass;
    expect(errors).toEqual([]);
  });

  test("no pass starts after stop", async () => {
    const db = freshDb();
    let snapshots = 0;
    const runtime = { snapshotPanes: async () => (snapshots++, []) } as unknown as HerdrRuntime;
    const reconciler = new Reconciler({
      db,
      runtime: () => runtime,
      launch: () => {},
      isLaunching: () => false,
      bus: { notify() {} } as unknown as SteerBus,
      timing: () => DEFAULT_TIMING,
      log: () => {},
      now: Date.now,
      ps: async () => "",
    });
    await reconciler.stop();
    reconciler.schedule();
    await reconciler.passNow("steady");
    await Bun.sleep(80);
    db.close();
    expect(snapshots).toBe(0);
  });

  test("InFlight.settled waits for tracked work, including work started while it waits", async () => {
    const inflight = new InFlight();
    const first = deferred<void>();
    const second = deferred<void>();
    void inflight.track(first.promise);
    let settled = false;
    const waiting = inflight.settled().then(() => {
      settled = true;
    });
    void inflight.track(second.promise);
    first.resolve();
    await Bun.sleep(10);
    expect(settled).toBe(false);
    second.resolve();
    await waiting;
    expect(inflight.size).toBe(0);
  });

  test("InFlight forgets work that failed, and settled does not throw for it", async () => {
    const inflight = new InFlight();
    const failing = inflight.track(Promise.reject(new Error("boom")));
    await failing.catch(() => undefined);
    await inflight.settled();
    expect(inflight.size).toBe(0);
  });

  test("settleWithin names what is still running when the grace runs out, and nothing when all ended", async () => {
    const stuck = deferred<void>();
    const left = await settleWithin(
      [
        { name: "reconciler", done: stuck.promise },
        { name: "journal", done: Promise.resolve() },
        { name: "upkeep", done: Promise.reject(new Error("failed is ended")) },
      ],
      30,
    );
    expect(left).toEqual(["reconciler"]);
    stuck.resolve();
    expect(await settleWithin([{ name: "reconciler", done: stuck.promise }], 1_000)).toEqual([]);
  });
});
