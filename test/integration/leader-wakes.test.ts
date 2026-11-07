import { afterEach, describe, expect, test } from "bun:test";
import { FOLLOW_UP_HEADER } from "../../src/attention/router.ts";
import { cliJson } from "../helpers/harness.ts";
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
/** A short batch window, so the leader's action items come due within the test. */
const QUICK = "[leader]\naction_batch_ms = 300\n";
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
      env = await makeLeaderEnv({ extraConfig: QUICK });
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
    "with you at the composer, the follow-up waits; once you go inactive it wakes the idle leader",
    async () => {
      env = await makeLeaderEnv({ extraConfig: QUICK });
      const lead = await env.claude();
      await lead.start();
      await lead.prompt("first");
      expect((await env.call("decline", { task: env.worker.taskId, body: "again" }, null)).ok).toBe(true);
      const item = env.withDb((db) => (db.query("SELECT id FROM items WHERE kind = 'user_acted' AND task_id = ?1").get(env!.worker.taskId) as { id: string }).id);
      await Bun.sleep(QUIET_MS);
      expect(followUpPushes(env)).toEqual([]);
      await lead.goInactive();
      await waitFor("the follow-up wake", 15_000, () => lead.seen.some((s) => s.via === "waiter"));
      expect(followUpPushes(env)).toEqual([[item]]);
      await waitFor("the woken turn to end", 10_000, () => env!.withDb((db) => db.query("SELECT 1 FROM presentations WHERE item_id = ?1 AND state = 'presented'").get(item) !== null));
    },
    T,
  );
});

/**
 * Every item whose next move is the leader's wakes it (task no-idle-workers-23,
 * steer m569), through the real daemon, CLI and leader hooks.
 */
async function report(e: LeaderEnv, body: string): Promise<string> {
  const result = await cliJson(e.h, ["report", "finding", "--body-file", "-"], { env: { FLOWRYN_TOKEN: e.worker.token, FLOWRYN_RUN: e.worker.runId }, stdin: body });
  if (result.code !== 0) throw new Error(`report failed: ${JSON.stringify(result.reply)}`);
  return String((result.reply.data as { item: string }).item);
}

describe("the leader's action items wake it", () => {
  test(
    "a worker's report wakes the idle leader past the retired hourly cap; the woken turn gets its line",
    async () => {
      env = await makeLeaderEnv({ extraConfig: `${QUICK}[notify]\nmax_triggered_turns_per_hour = 1\n` });
      const lead = await env.claude();
      await lead.start();
      await lead.prompt("first");
      await lead.goInactive();
      const ids: string[] = [];
      for (const mark of ["FLOWRYN-MARK-RW1", "FLOWRYN-MARK-RW2"]) {
        const id = await report(env, `${mark} the contract step fails`);
        ids.push(id);
        await waitFor(`the wake for ${mark}`, 15_000, () => followUpPushes(env!).some((p) => p.includes(id)));
        await waitFor(`the woken turn for ${mark} to end`, 10_000, () => env!.withDb((db) => db.query("SELECT 1 FROM presentations WHERE item_id = ?1 AND state = 'presented'").get(id) !== null));
      }
      expect(followUpPushes(env).flat()).toEqual(ids);
      const woken = lead.seen.filter((s) => s.text.includes(FOLLOW_UP_HEADER)).map((s) => s.text).join("\n");
      expect(woken).toContain("FLOWRYN-MARK-RW1");
      expect(woken).toContain("FLOWRYN-MARK-RW2");
    },
    T,
  );

  test(
    "a busy Claude leader's Stop carries a new action item at once, in the action lines",
    async () => {
      env = await makeLeaderEnv();
      const lead = await env.claude();
      await lead.start();
      await lead.promptBusy("busy");
      const item = env.openPlainP1("FLOWRYN-MARK-STOPACT PR ready");
      await lead.finishBusy();
      const stop = lead.seen.find((s) => s.via === "Stop" && s.text.includes(FOLLOW_UP_HEADER));
      expect(stop?.text).toContain(`[${item}] PR ready: FLOWRYN-MARK-STOPACT PR ready`);
      expect(followUpPushes(env)).toEqual([[item]]);
    },
    T,
  );
});
