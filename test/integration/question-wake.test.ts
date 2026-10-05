import { afterEach, describe, expect, test } from "bun:test";
import { cliJson } from "../helpers/harness.ts";
import { makeLeaderEnv, waitFor, type LeaderEnv } from "../helpers/leader-env.ts";

/**
 * Worker questions wake the leader (task worker-questions-wake-cd): every new
 * open question reaches the leader without waiting for your message. Questions
 * a ship opens within question_batch_ms of the first go in one wake; a busy
 * Claude turn takes them at its Stop; a question a digest already showed is
 * never pushed; question wakes have their own hourly budget; only a blocking
 * question raises an OS alert.
 */

let env: LeaderEnv | null = null;

afterEach(async () => {
  await env?.cleanup();
  env = null;
});

const BATCH_MS = 1_500;
const WAKE_BATCH_MS = 5_000;
const T = 30_000;

function questionConfig(extra = ""): string {
  return `[leader]\nquestion_batch_ms = ${BATCH_MS}\n${extra}`;
}

interface Presentation {
  session_id: string;
  turn_no: number;
  path: string;
  state: string;
}

function presentations(e: LeaderEnv, item: string): Presentation[] {
  return e.withDb((db) => db.query("SELECT session_id, turn_no, path, state FROM presentations WHERE item_id = ?1 ORDER BY carried_at, turn_no").all(item) as Presentation[]);
}

function questionPushes(e: LeaderEnv): { items: string[]; path: string }[] {
  return e.withDb((db) => (db.query("SELECT payload FROM events WHERE kind = 'leader.questions_pushed' ORDER BY seq").all() as { payload: string }[]).map((r) => JSON.parse(r.payload)));
}

async function ask(e: LeaderEnv, text: string, blocking = false): Promise<string> {
  const args = ["ask", "--options", "yes,no", "--blocks", "the next step of the task", ...(blocking ? ["--blocking"] : []), "--body-file", "-"];
  const result = await cliJson(e.h, args, { env: { FLOWRYN_TOKEN: e.worker.token, FLOWRYN_RUN: e.worker.runId }, stdin: text });
  if (result.code !== 0) throw new Error(`ask failed: ${JSON.stringify(result.reply)}`);
  const decision = String((result.reply.data as { decision: string }).decision);
  return e.withDb((db) => (db.query("SELECT id FROM items WHERE decision_id = ?1").get(decision) as { id: string }).id);
}

describe("worker questions wake the leader", () => {
  test(
    "an idle Claude leader is woken once for questions opened within the batch window, and the woken turn gets each in full",
    async () => {
      // A window wide enough that both asks land in it even on a loaded machine.
      env = await makeLeaderEnv({ extraConfig: questionConfig().replace(`${BATCH_MS}`, `${WAKE_BATCH_MS}`) });
      const lead = await env.claude();
      await lead.start();
      await lead.prompt("first");
      await lead.goInactive();
      const first = await ask(env, "FLOWRYN-MARK-QW1 which colour?");
      const second = await ask(env, "FLOWRYN-MARK-QW2 which shape?");
      await waitFor("the woken turn to present both", 15_000, () =>
        [first, second].every((id) => presentations(env!, id).some((p) => p.path === "waiter" && p.state === "presented")),
      );
      expect(questionPushes(env).map((p) => `${p.path}:${p.items.join(",")}`)).toEqual([`waiter:${first},${second}`]);
      // Not before the window: the first question waited for the rest of its burst.
      const [openedAt, pushedAt] = env.withDb((db) => [
        (db.query("SELECT opened_at FROM items WHERE id = ?1").get(first) as { opened_at: number }).opened_at,
        (db.query("SELECT ts FROM events WHERE kind = 'leader.questions_pushed'").get() as { ts: number }).ts,
      ]);
      expect(pushedAt - openedAt).toBeGreaterThanOrEqual(WAKE_BATCH_MS);
      const wake = lead.seen.find((s) => s.via === "waiter")!.text;
      expect(wake).toContain(`Flowryn questions [${first},${second}]`);
      // The wake line stays one line; the woken turn's prompt hook hands over every question's line.
      const context = lead.seen.find((s) => s.via === "UserPromptSubmit" && s.text.includes("Flowryn questions for the user"))!.text;
      expect(context).toContain("FLOWRYN-MARK-QW1");
      expect(context).toContain("FLOWRYN-MARK-QW2");
      // A wake is not you coming back.
      const inactive = env.withDb((db) => (db.query("SELECT user_inactive_since FROM leader_sessions").get() as { user_inactive_since: number | null }).user_inactive_since);
      expect(inactive).not.toBeNull();
    },
    T,
  );

  test(
    "a busy Claude leader gets a question at its next Stop, without waiting for the window",
    async () => {
      env = await makeLeaderEnv({ extraConfig: questionConfig().replace(`${BATCH_MS}`, "600000") });
      const lead = await env.claude();
      await lead.start();
      await lead.promptBusy("busy");
      const item = await ask(env, "FLOWRYN-MARK-QBUSY keep or drop?");
      await lead.finishBusy();
      expect(await lead.saw("FLOWRYN-MARK-QBUSY")).toBe(1);
      expect(lead.seen.find((s) => s.text.includes("FLOWRYN-MARK-QBUSY"))?.via).toBe("Stop");
      expect(presentations(env, item).map((p) => `${p.path}:${p.state}`)).toEqual(["continuation:presented"]);
    },
    T,
  );

  test(
    "a question a digest already showed is never pushed",
    async () => {
      env = await makeLeaderEnv({ extraConfig: questionConfig() });
      const lead = await env.claude();
      await lead.start();
      const item = await ask(env, "FLOWRYN-MARK-QDIGEST go ahead?");
      await lead.prompt("you type first");
      expect(await lead.saw("FLOWRYN-MARK-QDIGEST")).toBe(1);
      await lead.goInactive();
      await Bun.sleep(BATCH_MS + 1_500);
      expect(await lead.saw("FLOWRYN-MARK-QDIGEST")).toBe(1);
      expect(presentations(env, item).map((p) => `${p.path}:${p.state}`)).toEqual(["digest:presented"]);
      expect(questionPushes(env)).toEqual([]);
    },
    T,
  );

  test(
    "question wakes have their own hourly budget: over it, your next message carries them",
    async () => {
      env = await makeLeaderEnv({ extraConfig: `${questionConfig()}\n[notify]\nmax_question_wakes_per_hour = 1` });
      const lead = await env.claude();
      await lead.start();
      await lead.prompt("first");
      await lead.goInactive();
      const first = await ask(env, "FLOWRYN-MARK-QCAP1 one?");
      await waitFor("the first wake", 10_000, async () => (await lead.saw("FLOWRYN-MARK-QCAP1")) > 0);
      await waitFor("the woken turn to end", 10_000, () => presentations(env!, first).some((p) => p.state === "presented"));
      await lead.goInactive();
      const second = await ask(env, "FLOWRYN-MARK-QCAP2 two?");
      await Bun.sleep(BATCH_MS + 1_500);
      expect(await lead.saw("FLOWRYN-MARK-QCAP2")).toBe(0);
      // A P0 is on its own budget, so it still wakes the leader.
      const p0 = await env.openP0("FLOWRYN-MARK-QCAPP0 cannot finish");
      await waitFor("the P0 wake", 10_000, async () => (await lead.saw("FLOWRYN-MARK-QCAPP0")) > 0);
      expect(presentations(env, p0)[0]?.path).toBe("waiter");
      await lead.prompt("back");
      expect(await lead.saw("FLOWRYN-MARK-QCAP2")).toBe(1);
      expect(presentations(env, second).map((p) => p.path)).toEqual(["digest"]);
    },
    T,
  );

  test(
    "only a blocking question raises an OS alert, at once, while its wake waits for the window",
    async () => {
      env = await makeLeaderEnv({ herdr: true, extraConfig: questionConfig().replace(`${BATCH_MS}`, "600000") });
      const blocking = await ask(env, "FLOWRYN-MARK-QBLOCK stuck without it", true);
      const plain = await ask(env, "FLOWRYN-MARK-QPLAIN later is fine");
      await waitFor("the blocking question's alert", 10_000, () => env!.withDb((db) => (db.query("SELECT item_ids FROM notifications").all() as { item_ids: string }[]).some((r) => r.item_ids.includes(blocking))));
      await Bun.sleep(2_500);
      const notified = env.withDb((db) => (db.query("SELECT item_ids FROM notifications").all() as { item_ids: string }[]).flatMap((r) => JSON.parse(r.item_ids) as string[]));
      expect(notified).toContain(blocking);
      expect(notified).not.toContain(plain);
    },
    T,
  );

  test(
    "an idle, inactive Pi leader gets one triggered turn with every question's line, and the whole batch is recorded",
    async () => {
      env = await makeLeaderEnv({ extraConfig: questionConfig() });
      const lead = await env.pi();
      await lead.start();
      await lead.prompt("first");
      await lead.goInactive();
      const first = await ask(env, "FLOWRYN-MARK-QPI1 which colour?");
      const second = await ask(env, "FLOWRYN-MARK-QPI2 which shape?");
      await waitFor("the triggered turn", 10_000, async () => (await lead.saw("FLOWRYN-MARK-QPI2")) > 0);
      const shown = lead.seen.filter((s) => s.text.includes("FLOWRYN-MARK-QPI1"));
      expect(shown).toHaveLength(1);
      expect(shown[0]!.via).toBe("trigger");
      expect(shown[0]!.text).toContain("FLOWRYN-MARK-QPI2");
      await waitFor("both presented", 10_000, () => [first, second].every((id) => presentations(env!, id).some((p) => p.path === "trigger" && p.state === "presented")));
      expect(questionPushes(env).map((p) => p.items)).toEqual([[first, second]]);
    },
    T,
  );
});
