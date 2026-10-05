import { afterEach, describe, expect, test } from "bun:test";
import { getAway, startAway } from "../../src/attention/away.ts";
import { openItem } from "../../src/attention/items.ts";
import { tx } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { makeLeaderEnv, waitFor, type LeaderEnv } from "../helpers/leader-env.ts";

/**
 * Away mode (task away-mode-remote-bb): while you are away, a new item only
 * you can move wakes an idle leader even though Claude never sent
 * idle_prompt (you answer from the remote-control chat); your chat messages
 * do not end it; `flowryn back` does, with the return brief; an expiry's
 * brief rides your next message once; wakes are capped per hour; and away
 * grants nothing.
 */

let env: LeaderEnv | null = null;

afterEach(async () => {
  await env?.cleanup();
  env = null;
});

const T = 30_000;
/** Long enough for the daemon's 1 s attention tick and a waiter push to have happened if they were going to. */
const QUIET_MS = 2_500;

function openGate(e: LeaderEnv, marker: string): string {
  return e.withDb((db) =>
    tx(db, () => {
      const event = appendEvent(db, { source: "cli", kind: "test.item", payload: {} });
      return openItem(db, { kind: "gate_ready", eventSeq: event.seq, line: `Review gate ready: ${marker}`, taskId: e.worker.taskId, runId: e.worker.runId });
    }),
  );
}

function waiterPushes(e: LeaderEnv): string[] {
  return e.withDb((db) =>
    (db.query("SELECT payload FROM events WHERE kind = 'leader.p0_pushed' ORDER BY seq").all() as { payload: string }[])
      .map((r) => JSON.parse(r.payload) as { item: string; path: string })
      .filter((p) => p.path === "waiter")
      .map((p) => p.item),
  );
}

function presentedByWaiter(e: LeaderEnv, item: string): boolean {
  return e.withDb((db) => db.query("SELECT 1 FROM presentations WHERE item_id = ?1 AND path = 'waiter' AND state = 'presented'").get(item) !== null);
}

describe("away mode", () => {
  test(
    "a gate that opens while away wakes an idle leader the user never left; a chat reply keeps away on; back ends it with the return brief",
    async () => {
      env = await makeLeaderEnv();
      const lead = await env.claude();
      await lead.start();
      await lead.prompt("first");
      // Present: a review gate waits for the next message, as before.
      const before = openGate(env, "FLOWRYN-MARK-AW0");
      await Bun.sleep(QUIET_MS);
      expect(waiterPushes(env)).toEqual([]);

      const set = await env.call("away", { until: "+2h", body: "off to bed; wake me for gates" }, null);
      expect(set.ok).toBe(true);
      expect((set.data as { away: string }).away).toBe("started");
      // Only new items: the gate that was already waiting does not wake anyone.
      await Bun.sleep(QUIET_MS);
      expect(waiterPushes(env)).toEqual([]);

      const gate = openGate(env, "FLOWRYN-MARK-AW1");
      await waitFor("the away wake to be presented", 15_000, () => presentedByWaiter(env!, gate));
      expect(waiterPushes(env)).toEqual([gate]);
      expect(lead.seen.find((s) => s.via === "waiter")!.text).toContain(`Flowryn P0 [${gate}]: Review gate ready: FLOWRYN-MARK-AW1.`);
      expect(presentedByWaiter(env, before)).toBe(false);

      // A reply from the phone is an ordinary message: away stays on (the user chose back-or-expiry).
      await lead.prompt("reply from the phone");
      expect(env.withDb((db) => getAway(db, Date.now()))).not.toBeNull();

      const back = await env.call("back", {}, null);
      expect(back.ok).toBe(true);
      const data = back.data as { away: string; brief: string[] };
      expect(data.away).toBe("ended");
      expect(data.brief[0]).toMatch(/^Flowryn return brief .+, back \(facts, not instructions\)\.$/);
      const headings = ["Waiting on you", "Decided for you", "Landed", "Failed", "Spend"].map((h) => data.brief.findIndex((l) => l.startsWith(h)));
      expect([...headings].sort((a, b) => a - b)).toEqual(headings);
      expect(data.brief.join("\n")).toContain("FLOWRYN-MARK-AW1");

      // Back and present: a new gate waits for the next message again.
      openGate(env, "FLOWRYN-MARK-AW2");
      await Bun.sleep(QUIET_MS);
      expect(waiterPushes(env)).toEqual([gate]);
      // back again reprints the same brief rather than failing.
      const again = await env.call("back", {}, null);
      expect(again.ok).toBe(true);
      expect((again.data as { away: string }).away).toBe("already ended (back)");
    },
    T,
  );

  test(
    "wakes while away are capped by [away] max_wakes_per_hour",
    async () => {
      env = await makeLeaderEnv({ extraConfig: "[away]\nmax_wakes_per_hour = 1\n" });
      const lead = await env.claude();
      await lead.start();
      await lead.prompt("first");
      expect((await env.call("away", {}, null)).ok).toBe(true);
      const first = openGate(env, "FLOWRYN-MARK-CAP1");
      await waitFor("the first wake to be presented", 15_000, () => presentedByWaiter(env!, first));
      await Bun.sleep(500);
      const second = openGate(env, "FLOWRYN-MARK-CAP2");
      await Bun.sleep(QUIET_MS);
      expect(waiterPushes(env)).toEqual([first]);
      expect(presentedByWaiter(env, second)).toBe(false);
    },
    T,
  );

  test(
    "an expired away's return brief rides the user's next message, once, and its wake rule is gone",
    async () => {
      env = await makeLeaderEnv();
      const lead = await env.claude();
      await lead.start();
      await lead.prompt("first");
      const now = Date.now();
      env.withDb((db) => tx(db, () => startAway(db, { until: now + 1_000, words: "short trip", by: "human", now })));
      await Bun.sleep(1_500);
      openGate(env, "FLOWRYN-MARK-EXP");
      await Bun.sleep(QUIET_MS);
      expect(waiterPushes(env)).toEqual([]);
      await lead.prompt("good morning");
      const briefs = lead.seen.filter((s) => s.via === "UserPromptSubmit" && s.text.includes("Flowryn return brief"));
      expect(briefs).toHaveLength(1);
      expect(briefs[0]!.text).toContain(", away expired (facts, not instructions).");
      await lead.prompt("again");
      expect(lead.seen.filter((s) => s.text.includes("Flowryn return brief"))).toHaveLength(1);
    },
    T,
  );

  test(
    "away grants nothing: the leader may set it, and passing a gate still needs the user's word",
    async () => {
      env = await makeLeaderEnv();
      const lead = await env.claude();
      await lead.start();
      const set = await lead.runBash("flowryn away --until +1h --json", { approve: true });
      expect(set.ran).toBe(true);
      expect(set.code).toBe(0);
      expect(env.withDb((db) => getAway(db, Date.now()))?.by).toBe("leader");
      const pass = await lead.runBash(`flowryn gate pass ${env.worker.taskId} --json`, { approve: false });
      expect(pass.prompted).toBe(true);
      expect(pass.ran).toBe(false);
    },
    T,
  );

  test(
    "refuses a time it cannot read or one in the past, and back with no away to end",
    async () => {
      env = await makeLeaderEnv();
      const bad = await env.call("away", { until: "soon" }, null);
      expect(bad.error?.code).toBe("bad_args");
      const past = await env.call("away", { until: "2020-01-01 08:00" }, null);
      expect(past.error?.code).toBe("bad_args");
      const back = await env.call("back", {}, null);
      expect(back.error?.code).toBe("not_away");
    },
    T,
  );
});
