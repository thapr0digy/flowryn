import { afterEach, describe, expect, test } from "bun:test";
import { RELAY_FOOTER, RELAY_HEADER } from "../../src/attention/router.ts";
import { cliJson } from "../helpers/harness.ts";
import { makeLeaderEnv, type LeaderEnv } from "../helpers/leader-env.ts";

/**
 * Items the leader relays (task leader-stop-hook-yq): a Claude leader's turn
 * end carries each open worker report or dropped restart it has not seen yet,
 * with its line, once; the leader relays it to you or dismisses it. Driven
 * through the real CLI, the real leader bridge files and a fake Claude leader.
 */

let env: LeaderEnv | null = null;

afterEach(async () => {
  await env?.cleanup();
  env = null;
});

const T = 30_000;

/** A question window long enough that no wake fires during a test: only a Stop carries questions. */
const CONFIG = "[leader]\nquestion_batch_ms = 600000";

async function report(e: LeaderEnv, status: string, body: string): Promise<string> {
  const result = await cliJson(e.h, ["report", status, "--body-file", "-"], { env: { FLOWRYN_TOKEN: e.worker.token, FLOWRYN_RUN: e.worker.runId }, stdin: body });
  if (result.code !== 0) throw new Error(`report failed: ${JSON.stringify(result.reply)}`);
  return String((result.reply.data as { item: string }).item);
}

function presentations(e: LeaderEnv, item: string): string[] {
  return e.withDb((db) => (db.query("SELECT path, state FROM presentations WHERE item_id = ?1 ORDER BY carried_at").all(item) as { path: string; state: string }[]).map((p) => `${p.path}:${p.state}`));
}

function relayPushes(e: LeaderEnv): string[][] {
  return e.withDb((db) => (db.query("SELECT payload FROM events WHERE kind = 'leader.relay_pushed' ORDER BY seq").all() as { payload: string }[]).map((r) => (JSON.parse(r.payload) as { items: string[] }).items));
}

describe("the leader's turn end carries items to relay", () => {
  test(
    "a worker report opened during a busy turn continues that turn's Stop with its line, once",
    async () => {
      env = await makeLeaderEnv({ extraConfig: CONFIG });
      const lead = await env.claude();
      await lead.start();
      await lead.promptBusy("busy");
      const item = await report(env, "blocked", "FLOWRYN-MARK-RELAY1 deliver refused: the PR head moved");
      await lead.finishBusy();
      const shown = lead.seen.filter((s) => s.text.includes("FLOWRYN-MARK-RELAY1"));
      expect(shown).toHaveLength(1);
      expect(shown[0]!.via).toBe("Stop");
      expect(shown[0]!.text).toContain(RELAY_HEADER);
      expect(shown[0]!.text).toContain(`- [${item}] Report (blocked) from`);
      expect(shown[0]!.text).toContain(RELAY_FOOTER);
      // Shown once: the next turn's Stop and digest leave it alone, though it is still open.
      await lead.prompt("next");
      expect(await lead.saw("FLOWRYN-MARK-RELAY1")).toBe(1);
      expect(presentations(env, item)).toEqual(["continuation:presented"]);
      expect(relayPushes(env)).toEqual([[item]]);
    },
    T,
  );

  test(
    "a report the digest already showed this session never blocks a Stop",
    async () => {
      env = await makeLeaderEnv({ extraConfig: CONFIG });
      const lead = await env.claude();
      await lead.start();
      const item = await report(env, "finding", "FLOWRYN-MARK-RELAYDIGEST the contract fails after compaction");
      await lead.prompt("what's new?");
      expect(lead.seen.filter((s) => s.text.includes("FLOWRYN-MARK-RELAYDIGEST")).map((s) => s.via)).toEqual(["UserPromptSubmit"]);
      expect(presentations(env, item)).toEqual(["digest:presented"]);
      expect(relayPushes(env)).toEqual([]);
    },
    T,
  );

  test(
    "lines, not a count: five reports give four lines and +1 more; the fifth rides the next Stop",
    async () => {
      env = await makeLeaderEnv({ extraConfig: CONFIG });
      const lead = await env.claude();
      await lead.start();
      await lead.promptBusy("busy");
      const items: string[] = [];
      for (let n = 1; n <= 5; n++) items.push(await report(env, "finding", `FLOWRYN-MARK-RELAYN${n} finding number ${n}`));
      await lead.finishBusy();
      const stops = lead.seen.filter((s) => s.via === "Stop" && s.text.includes(RELAY_HEADER));
      // The first Stop carries four with "+1 more"; the continued turn's Stop carries the fifth.
      expect(stops).toHaveLength(2);
      for (let n = 1; n <= 4; n++) expect(stops[0]!.text).toContain(`FLOWRYN-MARK-RELAYN${n}`);
      expect(stops[0]!.text).toContain("+1 more: flowryn fleet");
      expect(stops[0]!.text).not.toContain("FLOWRYN-MARK-RELAYN5");
      expect(stops[1]!.text).toContain("FLOWRYN-MARK-RELAYN5");
      expect(relayPushes(env)).toEqual([items.slice(0, 4), [items[4]!]]);
    },
    T,
  );

  test(
    "a question and a report ride one continuation together",
    async () => {
      env = await makeLeaderEnv({ extraConfig: CONFIG });
      const lead = await env.claude();
      await lead.start();
      await lead.promptBusy("busy");
      await env.openP1("FLOWRYN-MARK-RELAYQ keep the old flag?");
      await report(env, "blocked", "FLOWRYN-MARK-RELAYR cannot push");
      await lead.finishBusy();
      const stops = lead.seen.filter((s) => s.via === "Stop");
      expect(stops).toHaveLength(1);
      expect(stops[0]!.text).toContain("FLOWRYN-MARK-RELAYQ");
      expect(stops[0]!.text).toContain("FLOWRYN-MARK-RELAYR");
    },
    T,
  );

  test(
    "a dismissed report is not carried; a progress report opens nothing to relay",
    async () => {
      env = await makeLeaderEnv({ extraConfig: CONFIG });
      const lead = await env.claude();
      await lead.start();
      await lead.promptBusy("busy");
      const item = await report(env, "blocked", "FLOWRYN-MARK-RELAYGONE stale");
      expect((await env.call("dismiss", { item }, null)).ok).toBe(true);
      await report(env, "progress", "FLOWRYN-MARK-RELAYPROG halfway");
      await lead.finishBusy();
      expect(await lead.saw("FLOWRYN-MARK-RELAYGONE")).toBe(0);
      expect(await lead.saw("FLOWRYN-MARK-RELAYPROG")).toBe(0);
      expect(relayPushes(env)).toEqual([]);
    },
    T,
  );
});
