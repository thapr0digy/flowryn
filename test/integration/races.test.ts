import { afterEach, describe, expect, test } from "bun:test";
import { makeLeaderEnv, waitFor, type LeaderEnv } from "../helpers/leader-env.ts";

/**
 * M3 exit test: every race in design section 9 has a passing test. Each
 * drives the daemon through the real hook verbs, from a fake Claude leader
 * running the real settings file's hooks, a fake Pi running the real leader
 * extension, or a direct hook call where the race needs a precise order.
 */

let env: LeaderEnv | null = null;

afterEach(async () => {
  await env?.cleanup();
  env = null;
});

interface Presentation {
  session_id: string;
  turn_no: number;
  path: string;
  state: string;
}

function presentations(e: LeaderEnv, item: string): Presentation[] {
  return e.withDb((db) => db.query("SELECT session_id, turn_no, path, state FROM presentations WHERE item_id = ?1 ORDER BY carried_at, turn_no").all(item) as Presentation[]);
}

function session(e: LeaderEnv, id: string): { busy: number; busy_until: number | null; user_inactive_since: number | null; turn_no: number } {
  return e.withDb((db) => db.query("SELECT busy, busy_until, user_inactive_since, turn_no FROM leader_sessions WHERE session_id = ?1").get(id) as {
    busy: number;
    busy_until: number | null;
    user_inactive_since: number | null;
    turn_no: number;
  });
}

async function hook(e: LeaderEnv, token: string, name: string, input: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const reply = await e.call(`hook.${name}`, { harness: "claude", input: JSON.stringify(input), ...extra }, token);
  if (!reply.ok) throw new Error(`hook ${name}: ${JSON.stringify(reply.error)}`);
  return (reply.data ?? {}) as Record<string, unknown>;
}

const T = 30_000;

describe("design section 9 races", () => {
  test(
    "1. an interrupt leaves busy stuck: the busy lease expires and what it carried is carried again",
    async () => {
      env = await makeLeaderEnv();
      const lead = await env.claude();
      const item = await env.openP1("FLOWRYN-MARK-R1 which colour?");
      await lead.start();
      await lead.prompt("first");
      // You interrupt a busy turn: Claude sends no Stop, no StopFailure and no idle_prompt (M0 c04), and
      // this interrupt leaves no transcript marker either, so only the lease can end it.
      const next = await env.openP1("FLOWRYN-MARK-R1b and which shape?");
      await lead.promptBusy("interrupted");
      expect(presentations(env, next).map((p) => p.state)).toEqual(["carried"]);
      expect(session(env, lead.session()).busy).toBe(1);
      await waitFor("the busy lease to expire", 10_000, () => session(env!, lead.session()).busy === 0);
      expect(presentations(env, next).map((p) => p.state)).toEqual(["lost"]);
      // The next turn carries it again, once, and its turn end presents it.
      await lead.prompt("after");
      expect(await lead.saw("FLOWRYN-MARK-R1b")).toBe(2);
      expect(presentations(env, next).map((p) => p.state)).toEqual(["lost", "presented"]);
      expect(presentations(env, item).filter((p) => p.state === "presented").length).toBe(1);
    },
    T,
  );

  test(
    "2. a silent hook timeout: a digest handed over too late is not carried, so it is carried again",
    async () => {
      env = await makeLeaderEnv();
      const opened = await env.openSession("claude");
      await hook(env, opened.token, "session-start", { source: "startup" });
      const item = await env.openP1("FLOWRYN-MARK-R2 go ahead?");
      // The hook process started 40 s ago: past the budget, Claude would already have dropped its context.
      const late = await hook(env, opened.token, "prompt", { prompt: "hi" }, { "started-at": Date.now() - 40_000 });
      expect(late.context).toBeUndefined();
      expect(presentations(env, item)).toEqual([]);
      await hook(env, opened.token, "stop");
      const onTime = await hook(env, opened.token, "prompt", { prompt: "again" }, { "started-at": Date.now() });
      expect(String(onTime.context)).toContain("FLOWRYN-MARK-R2");
      expect(Number(onTime.deadline)).toBeGreaterThan(Date.now());
      // A turn with no turn end (a hook timeout, an API error) leaves it carried; the next turn carries it again.
      await hook(env, opened.token, "stop-failure");
      const retry = await hook(env, opened.token, "prompt", { prompt: "retry" }, { "started-at": Date.now() });
      expect(String(retry.context)).toContain("FLOWRYN-MARK-R2");
      await hook(env, opened.token, "stop");
      expect(presentations(env, item).map((p) => `${p.path}:${p.state}`)).toEqual(["digest:lost", "digest:presented"]);
    },
    T,
  );

  test(
    "3. a P0 through both continuation and waiter: the per-item delivery lease keeps it single",
    async () => {
      env = await makeLeaderEnv();
      const opened = await env.openSession("claude");
      await hook(env, opened.token, "session-start", { source: "startup" });
      await hook(env, opened.token, "prompt", { prompt: "hi" });
      await hook(env, opened.token, "stop");
      await hook(env, opened.token, "notify", { notification_type: "idle_prompt" });
      const item = await env.openP0("FLOWRYN-MARK-R3 cannot finish");
      // The waiter takes it (idle, you inactive)...
      const reply = await env.call("hook.wait-p0", { harness: "claude", waiter: "01ZZZZZZZZZZZZZZZZZZZZZZZZ" }, opened.token);
      expect((reply.data as { fire?: { id: string } }).fire?.id).toBe(item);
      // ...and a Stop deciding at the same moment cannot also continue with it.
      await hook(env, opened.token, "prompt", { prompt: "Flowryn P0 [x]: wake" });
      const stop = await hook(env, opened.token, "stop");
      expect(stop.context).toBeUndefined();
      const pushes = presentations(env, item).filter((p) => ["continuation", "waiter", "trigger"].includes(p.path));
      expect(pushes.map((p) => `${p.path}:${p.state}`)).toEqual(["waiter:presented"]);
      // The database refuses a second carried push outright.
      const second = env.withDb((db) => {
        try {
          db.query("INSERT INTO presentations (item_id, session_id, turn_no, path, state, carried_at) VALUES (?1, 'L9', 1, 'continuation', 'carried', 1), (?1, 'L8', 1, 'waiter', 'carried', 1)").run(item);
          return "inserted";
        } catch (error) {
          return (error as Error).message;
        }
      });
      expect(second).toContain("UNIQUE");
    },
    T,
  );

  test(
    "4. the composer race: no keystrokes, and no wake while you are active or drafting",
    async () => {
      env = await makeLeaderEnv();
      const lead = await env.pi();
      await lead.start();
      await lead.prompt("first");
      await lead.typeDraft("half typed, do not send");
      const item = await env.openP0("FLOWRYN-MARK-R4 needs you");
      await Bun.sleep(1_500);
      expect(await lead.saw("FLOWRYN-MARK-R4")).toBe(0);
      // Even when the daemon thinks you left, the extension checks the composer before it triggers, and declines.
      env.withDb((db) => db.query("UPDATE leader_sessions SET user_inactive_since = ?2 WHERE session_id = ?1").run(lead.session(), Date.now()));
      await waitFor("the extension to decline", 10_000, () =>
        env!.withDb((db) => db.query("SELECT 1 FROM events WHERE kind = 'leader.p0_declined' AND payload LIKE ?1").get(`%"${item}"%`) !== null),
      );
      expect(await lead.saw("FLOWRYN-MARK-R4")).toBe(0);
      expect(presentations(env, item).filter((p) => p.state !== "lost")).toEqual([]);
      // With the composer clear and you gone, it starts a turn.
      await lead.goInactive();
      await waitFor("the wake", 10_000, async () => (await lead.saw("FLOWRYN-MARK-R4")) > 0);
      await waitFor("the trigger presented", 10_000, () => presentations(env!, item).some((p) => p.path === "trigger" && p.state === "presented"));
    },
    T,
  );

  test(
    "5. a P0 that arrives while Stop is deciding: Stop asks once, and anything later goes to the waiter",
    async () => {
      env = await makeLeaderEnv();
      const opened = await env.openSession("claude");
      await hook(env, opened.token, "session-start", { source: "startup" });
      await hook(env, opened.token, "prompt", { prompt: "work" });
      const a = await env.openP0("FLOWRYN-MARK-R5a");
      const b = await env.openP0("FLOWRYN-MARK-R5b");
      const c = await env.openP0("FLOWRYN-MARK-R5c");
      // Stop continues with a P0 at most twice in a row.
      expect(String((await hook(env, opened.token, "stop")).context)).toContain("FLOWRYN-MARK-R5a");
      expect(String((await hook(env, opened.token, "stop", { stop_hook_active: true })).context)).toContain("FLOWRYN-MARK-R5b");
      expect((await hook(env, opened.token, "stop", { stop_hook_active: true })).context).toBeUndefined();
      expect(session(env, opened.session).busy).toBe(0);
      // The third, and one that arrives after the Stop decided, go to the waiter once you are away.
      const late = await env.openP0("FLOWRYN-MARK-R5d");
      await hook(env, opened.token, "notify", { notification_type: "idle_prompt" });
      const fired = await env.call("hook.wait-p0", { harness: "claude", waiter: "01ZZZZZZZZZZZZZZZZZZZZZZZZ" }, opened.token);
      expect([c, late]).toContain((fired.data as { fire: { id: string } }).fire.id);
      for (const [item, path] of [
        [a, "continuation"],
        [b, "continuation"],
      ] as const) {
        expect(presentations(env, item).map((p) => `${p.path}:${p.state}`)).toEqual([`${path}:presented`]);
      }
    },
    T,
  );

  test(
    "6. two leaders: one lease; the other is read-only until it claims",
    async () => {
      env = await makeLeaderEnv();
      const first = await env.claude();
      const second = await env.claude();
      await first.start();
      await second.start();
      expect(await second.saw("read-only: leader is claude")).toBe(1);
      const lease = env.withDb((db) => db.query("SELECT session_id, epoch FROM leader_lease").get() as { session_id: string; epoch: number });
      expect(lease.session_id).toBe(first.session());
      // A read-only session may read, and is refused leader mutations.
      const secondToken = second["opts" as keyof typeof second] as unknown as { env: Record<string, string> };
      const token = secondToken.env.FLOWRYN_TOKEN!;
      const refused = await env.call("steer", { target: "web-billing-q4", body: "x" }, token);
      expect(refused.error?.code).toBe("not_leader");
      expect((await env.call("fleet", {}, token)).ok).toBe(true);
      // The old holder's waiter exits when the lease moves.
      await first.prompt("before");
      const waitersBefore = first.liveWaiters();
      expect(waitersBefore).toBeGreaterThan(0);
      const claimed = await env.call("leader claim", {}, token);
      expect((claimed.data as { epoch: number }).epoch).toBe(lease.epoch + 1);
      await waitFor("the old holder's waiters to exit", 10_000, () => first.liveWaiters() === 0);
      await first.prompt("after");
      expect(await first.saw("leadership moved to claude")).toBe(1);
      const firstToken = (first["opts" as keyof typeof first] as unknown as { env: Record<string, string> }).env.FLOWRYN_TOKEN!;
      expect((await env.call("steer", { target: "web-billing-q4", body: "x" }, firstToken)).error?.code).toBe("not_leader");
    },
    T,
  );

  test(
    "7. compaction drops digests: the compact briefing re-lists every open actionable item",
    async () => {
      env = await makeLeaderEnv();
      const lead = await env.claude();
      await lead.start();
      const item = await env.openP1("FLOWRYN-MARK-R7 keep or drop?");
      await lead.prompt("digest");
      expect(await lead.saw("FLOWRYN-MARK-R7")).toBe(1);
      await lead.compact();
      expect(await lead.saw("FLOWRYN-MARK-R7")).toBe(2);
      const compactBrief = lead.seen.filter((s) => s.via === "SessionStart").at(-1)!.text;
      expect(compactBrief).toContain(`[${item}]`);
      expect(compactBrief).toContain("Needs you (1)");
    },
    T,
  );

  test(
    "8. Pi nextTurn never delivers while idle: a P0 triggers a turn, a P1 waits for your message",
    async () => {
      env = await makeLeaderEnv();
      const lead = await env.pi();
      await lead.start();
      await lead.prompt("first");
      await lead.goInactive();
      const p1 = await env.openP1("FLOWRYN-MARK-R8p1 later is fine");
      await Bun.sleep(1_500);
      expect(await lead.saw("FLOWRYN-MARK-R8p1")).toBe(0);
      const p0 = await env.openP0("FLOWRYN-MARK-R8p0 now");
      await waitFor("the triggered turn", 10_000, async () => (await lead.saw("FLOWRYN-MARK-R8p0")) > 0);
      expect(lead.seen.find((s) => s.text.includes("FLOWRYN-MARK-R8p0"))?.via).toBe("trigger");
      expect(await lead.saw("FLOWRYN-MARK-R8p1")).toBe(0);
      await lead.prompt("back");
      expect(await lead.saw("FLOWRYN-MARK-R8p1")).toBe(1);
      await waitFor("both presented", 10_000, () => presentations(env!, p0).some((p) => p.state === "presented") && presentations(env!, p1).some((p) => p.state === "presented"));
    },
    T,
  );

  test(
    "9. stale Herdr status: the harness's own idle signal decides",
    async () => {
      env = await makeLeaderEnv({ herdr: true });
      // Herdr calls the leader's pane working, as it does for an agent killed mid-turn; the hooks say idle.
      const pane = env.herdr!.addPaneWithStatus(env.h.home, "working");
      const lead = await env.claude(pane);
      await lead.start();
      await lead.prompt("first");
      await lead.goInactive();
      const item = await env.openP0("FLOWRYN-MARK-R9 wake anyway");
      await waitFor("the waiter to wake the idle leader", 10_000, async () => (await lead.saw("FLOWRYN-MARK-R9")) > 0);
      await waitFor("presented", 10_000, () => presentations(env!, item).some((p) => p.path === "waiter" && p.state === "presented"));
      // And the reverse: Herdr says idle while the hooks say busy, so nothing wakes it.
      env.herdr!.statusOverride.set(pane, "idle");
      await lead.promptBusy("busy");
      await lead.goInactive();
      const second = await env.openP0("FLOWRYN-MARK-R9b stay quiet");
      await Bun.sleep(2_000);
      expect(await lead.saw("FLOWRYN-MARK-R9b")).toBe(0);
      await lead.finishBusy();
      expect(await lead.saw("FLOWRYN-MARK-R9b")).toBe(1);
      expect(presentations(env, second).map((p) => p.path)).toEqual(["continuation"]);
    },
    T,
  );
});
