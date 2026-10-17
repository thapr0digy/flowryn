import { afterEach, describe, expect, test } from "bun:test";
import { FOLLOW_UP_HEADER } from "../../src/attention/router.ts";
import { makeLeaderEnv, waitFor, type LeaderEnv } from "../helpers/leader-env.ts";

/**
 * Leader wakes reliably (docs/notes/2026-10-17-leader-wakes-reliably-vn.md):
 * an action you take outside the leader session opens a follow-up that wakes
 * the idle leader once, through the real leader hooks and waiter.
 */

let env: LeaderEnv | null = null;

afterEach(async () => {
  await env?.cleanup();
  env = null;
});

const T = 30_000;
/** Long enough for the daemon's 1 s attention tick and a waiter push to have happened if they were going to. */
const QUIET_MS = 2_500;

function followUpPushes(e: LeaderEnv): string[][] {
  return e.withDb((db) =>
    (db.query("SELECT payload FROM events WHERE kind = 'leader.follow_ups_pushed' ORDER BY seq").all() as { payload: string }[]).map((r) => (JSON.parse(r.payload) as { items: string[] }).items),
  );
}

describe("your own actions wake the leader", () => {
  test(
    "cause 1: a decline from your terminal wakes the idle leader, you inactive, once; the woken turn gets the follow-up in full",
    async () => {
      env = await makeLeaderEnv();
      const lead = await env.claude();
      await lead.start();
      await lead.prompt("first");
      await lead.goInactive();
      const declined = await env.call("decline", { task: env.worker.taskId, body: "FLOWRYN-MARK-WK1 make it blue" }, null);
      expect(declined.ok).toBe(true);
      const item = env.withDb((db) => (db.query("SELECT id FROM items WHERE kind = 'user_acted' AND task_id = ?1").get(env!.worker.taskId) as { id: string } | null)?.id);
      expect(item).toBeDefined();
      await waitFor("the follow-up wake", 15_000, () => lead.seen.some((s) => s.via === "waiter"));
      const wake = lead.seen.find((s) => s.via === "waiter")!.text;
      expect(wake).toContain(`Flowryn follow-up [${item}]: the user acted outside this session (1). Details: flowryn fleet`);
      await waitFor("the woken turn's context", 10_000, () => lead.seen.some((s) => s.text.includes(FOLLOW_UP_HEADER)));
      const full = lead.seen.find((s) => s.text.includes(FOLLOW_UP_HEADER))!.text;
      expect(full).toContain(`[${item}] The user declined`);
      // The woken turn keeps you inactive; one action is one wake, never a loop.
      expect(env.withDb((db) => (db.query("SELECT user_inactive_since FROM leader_sessions").get() as { user_inactive_since: number | null }).user_inactive_since)).not.toBeNull();
      await Bun.sleep(QUIET_MS);
      expect(followUpPushes(env)).toEqual([[item!]]);
    },
    T,
  );

  test(
    "with you active, the follow-up waits for your next message and tops its digest",
    async () => {
      env = await makeLeaderEnv();
      const lead = await env.claude();
      await lead.start();
      await lead.prompt("first");
      env.openPlainP1("FLOWRYN-MARK-WK2 an older PR waits");
      expect((await env.call("decline", { task: env.worker.taskId, body: "again" }, null)).ok).toBe(true);
      await Bun.sleep(QUIET_MS);
      expect(followUpPushes(env)).toEqual([]);
      expect(lead.seen.some((s) => s.via === "waiter")).toBe(false);
      await lead.prompt("second");
      const digest = lead.seen.findLast((s) => s.text.includes("Flowryn updates"))!.text.split("\n");
      expect(digest[1]).toContain("The user declined");
    },
    T,
  );
});
