import { afterEach, describe, expect, test } from "bun:test";
import { cliJson } from "../helpers/harness.ts";
import { makeLeaderEnv, waitFor, type LeaderEnv } from "../helpers/leader-env.ts";
import { useIntegrationTimeout } from "../helpers/integration-timeout.ts";

useIntegrationTimeout();

/**
 * The runaway ceiling (task no-idle-workers-23, docs/notes/2026-11-06-no-idle-workers-23.md):
 * leader wakes have no hourly cap, but past [leader] wake_ceiling_per_hour started
 * turns in an hour the session is woken no more and one leader_wake_runaway P0
 * names it. Driven through the real daemon, CLI and leader hooks.
 */

let env: LeaderEnv | null = null;

afterEach(async () => {
  await env?.cleanup();
  env = null;
});

const T = 40_000;
const QUIET_MS = 3_000;

function followUpPushes(e: LeaderEnv): string[][] {
  return e.withDb((db) =>
    (db.query("SELECT payload FROM events WHERE kind = 'leader.follow_ups_pushed' ORDER BY seq").all() as { payload: string }[]).map((r) => (JSON.parse(r.payload) as { items: string[] }).items),
  );
}

async function report(e: LeaderEnv, body: string): Promise<string> {
  const result = await cliJson(e.h, ["report", "finding", "--body-file", "-"], { env: { FLOWRYN_TOKEN: e.worker.token, FLOWRYN_RUN: e.worker.runId }, stdin: body });
  if (result.code !== 0) throw new Error(`report failed: ${JSON.stringify(result.reply)}`);
  return String((result.reply.data as { item: string }).item);
}

describe("the leader wake runaway ceiling", () => {
  test(
    "past the ceiling a new action item does not wake the leader, and one runaway P0 names the session",
    async () => {
      env = await makeLeaderEnv({ extraConfig: "[leader]\naction_batch_ms = 300\nwake_ceiling_per_hour = 1\n" });
      const lead = await env.claude();
      await lead.start();
      await lead.prompt("first");
      await lead.goInactive();
      const first = await report(env, "FLOWRYN-MARK-CEIL1 first finding");
      await waitFor("the first wake", 15_000, () => followUpPushes(env!).some((p) => p.includes(first)));
      await waitFor("the woken turn to end", 10_000, () => env!.withDb((db) => db.query("SELECT 1 FROM presentations WHERE item_id = ?1 AND state = 'presented'").get(first) !== null));
      await lead.goInactive();

      const second = await report(env, "FLOWRYN-MARK-CEIL2 second finding");
      await waitFor("the runaway P0", 15_000, () => env!.withDb((db) => db.query("SELECT 1 FROM items WHERE kind = 'leader_wake_runaway'").get() !== null));
      await Bun.sleep(QUIET_MS);
      expect(followUpPushes(env).some((p) => p.includes(second))).toBe(false);
      const runaway = env.withDb((db) => db.query("SELECT line, state FROM items WHERE kind = 'leader_wake_runaway'").all()) as { line: string; state: string }[];
      const ceilingEvents = env.withDb((db) => db.query("SELECT payload FROM events WHERE kind = 'leader.wake_ceiling'").all()) as { payload: string }[];
      expect(runaway).toHaveLength(1);
      expect(runaway[0]!.line).toContain("wake_ceiling_per_hour = 1");
      expect(ceilingEvents).toHaveLength(1);
      expect(runaway[0]!.line).toContain(String((JSON.parse(ceilingEvents[0]!.payload) as { session: string }).session));
    },
    T,
  );
});
