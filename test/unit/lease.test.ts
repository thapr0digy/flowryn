import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { authorize, resolveCaller } from "../../src/api/auth.ts";
import { FlowrynError } from "../../src/api/errors.ts";
import type { VerbSpec } from "../../src/api/verbs.ts";
import { carry } from "../../src/attention/presentations.ts";
import { openItem } from "../../src/attention/items.ts";
import { tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { attachProcess, claim, closeSession, getLease, getSession, heartbeat, leaseState, openSession, release } from "../../src/lease/lease.ts";
import type { PsRunner } from "../../src/runtime/proc.ts";
import { makeHome, seedRun, type TestHome } from "../helpers/harness.ts";

let h: TestHome;
let db: Db;

beforeEach(() => {
  h = makeHome();
  db = h.db();
});

afterEach(() => {
  db.close();
  h.cleanup();
});

function spec(roles: VerbSpec["roles"], name = "verb"): VerbSpec {
  return { name, summary: "", positionals: [], flags: {}, kind: "mutation", roles };
}

function refusal(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof FlowrynError ? error.code : String(error);
  }
}

/** A ps that knows exactly these live processes (pid 4242 started at 1_000_000 ms, a claude). */
function ps(alive: boolean): PsRunner {
  return async (pids) => (alive && pids.includes(4242) ? "4242 Thu Sep 24 04:00:00 2026 claude\n" : "");
}

describe("leader sessions and roles", () => {
  test("a session token is a reader until its session holds the lease, then the leader; it ends with its session", () => {
    const a = tx(db, () => openSession(db, { harness: "claude", pane: "w1:p2", cwd: "/x", now: 1 }));
    expect(resolveCaller(db, a.token, null)).toMatchObject({ role: "reader", session: a.session });
    tx(db, () => claim(db, a.session, "test", 2));
    expect(resolveCaller(db, a.token, null)).toMatchObject({ role: "leader", session: a.session });
    tx(db, () => closeSession(db, a.session, "quit", 3));
    expect(getLease(db).session_id).toBeNull();
    expect(refusal(() => resolveCaller(db, a.token, null))).toBe("bad_token");
  });

  test("a read-only session is refused leader mutations with not_leader and may read, claim and call hook verbs", () => {
    const a = tx(db, () => openSession(db, { harness: "claude", pane: "w1:p2", cwd: null, now: 1 }));
    const b = tx(db, () => openSession(db, { harness: "pi", pane: "w3:p1", cwd: null, now: 1 }));
    tx(db, () => claim(db, a.session, "test", 2));
    const reader = resolveCaller(db, b.token, null);
    expect(refusal(() => authorize(spec(["leader", "human"], "dispatch"), reader, db))).toBe("not_leader");
    expect(refusal(() => authorize(spec(["leader", "reader", "human"], "fleet"), reader, db))).toBeNull();
    expect(refusal(() => authorize(spec(["worker", "hook"], "hook.prompt"), reader, db))).toBeNull();
    expect(refusal(() => authorize(spec(["hook"], "hook.wait-p0"), reader, db))).toBeNull();
    const worker = seedRun(h);
    const workerCaller = resolveCaller(h.db(), worker.token, null);
    expect(refusal(() => authorize(spec(["hook"], "hook.wait-p0"), workerCaller, db))).toBe("worker_token");
  });
});

describe("the lease (design section 10)", () => {
  test("a claim moves it: epoch + 1, a new approval key, a banner for the old holder, its carries re-queued", () => {
    const a = tx(db, () => openSession(db, { harness: "claude", pane: "w1:p2", cwd: null, now: 1 }));
    const b = tx(db, () => openSession(db, { harness: "pi", pane: "w3:p1", cwd: null, now: 1 }));
    const first = tx(db, () => claim(db, a.session, "vacant", 2));
    expect(first).toMatchObject({ epoch: 1, previous: null });
    const item = tx(db, () => openItem(db, { kind: "yolo_merged", eventSeq: appendEvent(db, { source: "cli", kind: "t", payload: {} }).seq, line: "merged" }));
    tx(db, () => carry(db, { itemId: item, session: a.session, turn: 3, path: "digest", now: 3 }));
    const second = tx(db, () => claim(db, b.session, "explicit", 4));
    expect(second).toMatchObject({ epoch: 2, previous: a.session });
    expect(second.approvalKey).not.toBe(first.approvalKey);
    expect(getLease(db)).toMatchObject({ session_id: b.session, harness: "pi", pane_id: "w3:p1", epoch: 2 });
    expect(getSession(db, a.session)!.banner).toBe("Flowryn: leadership moved to pi in pane w3:p1; this session is read-only.");
    expect(getSession(db, b.session)!.brief_pending).toBe(1);
    expect(db.query("SELECT state FROM presentations WHERE item_id = ?1").get(item)).toEqual({ state: "lost" });
    expect(release(db, a.session, "not mine", 5)).toBe(false);
    expect(tx(db, () => release(db, b.session, "quit", 5))).toBe(true);
    expect(getLease(db)).toMatchObject({ session_id: null, epoch: 2 });
  });

  test("stale needs both a silent heartbeat and the holder's process gone; a live silent holder is never taken over", async () => {
    const a = tx(db, () => openSession(db, { harness: "claude", pane: null, cwd: null, now: 0 }));
    const b = tx(db, () => openSession(db, { harness: "claude", pane: null, cwd: null, now: 0 }));
    tx(db, () => claim(db, a.session, "vacant", 0));
    const staleMs = 600_000;
    // No process recorded: it cannot be proven gone.
    expect((await leaseState(db, b.session, 10 * staleMs, staleMs, ps(false))).state).toBe("held");
    tx(db, () => attachProcess(db, a.session, { pid: 4242, start: new Date(2026, 8, 24, 4, 0, 0).getTime(), exe: "claude" }, 0));
    tx(db, () => heartbeat(db, a.session, 1_000));
    expect((await leaseState(db, b.session, 2_000, staleMs, ps(false))).state).toBe("held");
    expect((await leaseState(db, b.session, 1_000 + staleMs, staleMs, ps(true))).state).toBe("held");
    expect(await leaseState(db, b.session, 1_000 + staleMs, staleMs, ps(false))).toEqual({ state: "stale", epoch: 1 });
    expect((await leaseState(db, a.session, 1_000 + staleMs, staleMs, ps(false))).state).toBe("mine");
    tx(db, () => closeSession(db, a.session, "quit", 5));
    expect((await leaseState(db, b.session, 6, staleMs, ps(true))).state).toBe("vacant");
  });
});
