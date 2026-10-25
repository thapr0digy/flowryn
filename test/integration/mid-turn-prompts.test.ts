import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeLeaderEnv, type LeaderEnv } from "../helpers/leader-env.ts";

/**
 * A prompt Claude takes into a running turn (a background notice, a message typed while busy)
 * joins that turn: no new turn number, nothing it carried is lost
 * (docs/notes/2026-10-23-background-notifications-6g.md). Each test drives the daemon through
 * the real hook verbs in the order Claude fires them.
 */

let env: LeaderEnv | null = null;

afterEach(async () => {
  await env?.cleanup();
  env = null;
});

const T = 30_000;

/** What Claude's UserPromptSubmit carries for a finished background command taken in mid-turn (spike c16, N2). */
const NOTICE =
  "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command \"sleep 15\" completed (exit code 0)</summary>\n</task-notification>";

async function hook(e: LeaderEnv, token: string, name: string, input: Record<string, unknown> = {}) {
  const reply = await e.call(`hook.${name}`, { harness: "claude", input: JSON.stringify(input) }, token);
  if (!reply.ok) throw new Error(`hook ${name}: ${JSON.stringify(reply.error)}`);
  return (reply.data ?? {}) as Record<string, unknown>;
}

function states(e: LeaderEnv, item: string): string[] {
  return e.withDb((db) => (db.query("SELECT state FROM presentations WHERE item_id = ?1 ORDER BY carried_at, turn_no").all(item) as { state: string }[]).map((p) => p.state));
}

function turnNo(e: LeaderEnv, session: string): number {
  return e.withDb((db) => (db.query("SELECT turn_no FROM leader_sessions WHERE session_id = ?1").get(session) as { turn_no: number }).turn_no);
}

function events(e: LeaderEnv, kind: string): Record<string, unknown>[] {
  return e.withDb((db) => (db.query("SELECT payload FROM events WHERE kind = ?1 ORDER BY seq").all(kind) as { payload: string }[]).map((r) => JSON.parse(r.payload)));
}

/** A Claude leader session that has started, with a transcript file the hooks name. */
async function claudeSession(e: LeaderEnv): Promise<{ token: string; session: string; transcript: string }> {
  const opened = await e.openSession("claude");
  const transcript = join(e.h.home, `transcript-${opened.session}.jsonl`);
  writeFileSync(transcript, "");
  await hook(e, opened.token, "session-start", { source: "startup", transcript_path: transcript });
  return { token: opened.token, session: opened.session, transcript };
}

describe("prompts taken into a running turn", () => {
  test(
    "a background notice mid-turn joins the turn: same turn number, the digest's carry is presented at Stop and not shown again",
    async () => {
      env = await makeLeaderEnv();
      const s = await claudeSession(env);
      const item = env.openPlainP1("FLOWRYN-MARK-M1 merge it?");
      const first = await hook(env, s.token, "prompt", { prompt: "hi" });
      expect(String(first.context)).toContain("FLOWRYN-MARK-M1");
      const turn = turnNo(env, s.session);
      await hook(env, s.token, "pre-tool", { tool_name: "Bash", tool_input: { command: "sleep 15" } });
      await hook(env, s.token, "post-tool", { tool_name: "Bash", tool_input: { command: "sleep 15" } });

      const notice = await hook(env, s.token, "prompt", { prompt: NOTICE });
      expect(String(notice.context ?? "")).not.toContain("FLOWRYN-MARK-M1");
      expect(turnNo(env, s.session)).toBe(turn);
      expect(states(env, item)).toEqual(["carried"]);
      expect(events(env, "leader.turn_started")).toHaveLength(1);
      expect(events(env, "leader.prompt_taken")).toEqual([{ session: s.session, turn, source: "prompt" }]);

      await hook(env, s.token, "stop");
      expect(states(env, item)).toEqual(["presented"]);
      const next = await hook(env, s.token, "prompt", { prompt: "next" });
      expect(String(next.context ?? "")).not.toContain("FLOWRYN-MARK-M1");
      expect(turnNo(env, s.session)).toBe(turn + 1);
    },
    T,
  );

  test(
    "a message typed while busy joins the turn too, and still marks the user active",
    async () => {
      env = await makeLeaderEnv();
      const s = await claudeSession(env);
      const item = env.openPlainP1("FLOWRYN-MARK-M2 merge it?");
      await hook(env, s.token, "prompt", { prompt: "hi" });
      const turn = turnNo(env, s.session);
      env.withDb((db) => db.query("UPDATE leader_sessions SET user_inactive_since = ?2 WHERE session_id = ?1").run(s.session, Date.now() - 60_000));

      await hook(env, s.token, "prompt", { prompt: "also check the docs" });
      expect(turnNo(env, s.session)).toBe(turn);
      expect(states(env, item)).toEqual(["carried"]);
      expect(events(env, "leader.user_active")).toHaveLength(1);
      await hook(env, s.token, "stop");
      expect(states(env, item)).toEqual(["presented"]);
    },
    T,
  );

  test(
    "a notice while idle (after Stop) starts a new turn, as before",
    async () => {
      env = await makeLeaderEnv();
      const s = await claudeSession(env);
      await hook(env, s.token, "prompt", { prompt: "hi" });
      await hook(env, s.token, "stop");
      const turn = turnNo(env, s.session);
      await hook(env, s.token, "prompt", { prompt: NOTICE });
      expect(turnNo(env, s.session)).toBe(turn + 1);
      expect(events(env, "leader.turn_started")).toHaveLength(2);
      expect(events(env, "leader.prompt_taken")).toEqual([]);
    },
    T,
  );

  test(
    "after an interrupt marker in the transcript a prompt starts a new turn, and the interrupted turn's carries are lost",
    async () => {
      env = await makeLeaderEnv();
      const s = await claudeSession(env);
      const item = env.openPlainP1("FLOWRYN-MARK-M4 merge it?");
      await hook(env, s.token, "prompt", { prompt: "hi" });
      const turn = turnNo(env, s.session);
      // Esc during a tool: no Stop, only the marker (M0 c04, finding 6).
      appendFileSync(s.transcript, JSON.stringify({ type: "user", message: { content: "[Request interrupted by user for tool use]" } }) + "\n");
      const after = await hook(env, s.token, "prompt", { prompt: "do this instead" });
      expect(turnNo(env, s.session)).toBe(turn + 1);
      expect(states(env, item)).toEqual(["lost", "carried"]);
      expect(String(after.context)).toContain("FLOWRYN-MARK-M4");
    },
    T,
  );

  test(
    "after the busy lease expired a prompt starts a new turn",
    async () => {
      env = await makeLeaderEnv();
      const s = await claudeSession(env);
      await hook(env, s.token, "prompt", { prompt: "hi" });
      const turn = turnNo(env, s.session);
      env.withDb((db) => db.query("UPDATE leader_sessions SET busy_until = ?2 WHERE session_id = ?1").run(s.session, Date.now() - 1));
      await hook(env, s.token, "prompt", { prompt: NOTICE });
      expect(turnNo(env, s.session)).toBe(turn + 1);
    },
    T,
  );

  test(
    "after the daemon restarts mid-turn the turn's state is unknown, so a prompt while busy starts a new turn",
    async () => {
      env = await makeLeaderEnv();
      const s = await claudeSession(env);
      const item = env.openPlainP1("FLOWRYN-MARK-M6 merge it?");
      await hook(env, s.token, "prompt", { prompt: "hi" });
      const turn = turnNo(env, s.session);
      await env.restartDaemon();
      env.withDb((db) => db.query("UPDATE leader_sessions SET busy_until = ?2 WHERE session_id = ?1").run(s.session, Date.now() + 60_000));
      // Esc after the restart: the marker is in the transcript, but the new daemon has no offset to read it from.
      appendFileSync(s.transcript, JSON.stringify({ type: "user", message: { content: "[Request interrupted by user for tool use]" } }) + "\n");
      const after = await hook(env, s.token, "prompt", { prompt: "do this instead" });
      expect(turnNo(env, s.session)).toBe(turn + 1);
      expect(states(env, item)).toEqual(["lost", "carried"]);
      expect(String(after.context)).toContain("FLOWRYN-MARK-M6");
      expect(events(env, "leader.prompt_taken")).toEqual([]);
    },
    T,
  );

  test(
    "assumption: the answered question's PostToolUse comes before the notice, so a dialog open past the busy lease still keeps the notice in the turn",
    async () => {
      env = await makeLeaderEnv();
      const s = await claudeSession(env);
      await hook(env, s.token, "prompt", { prompt: "hi" });
      const turn = turnNo(env, s.session);
      const ask = { tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Which?", header: "Pick", options: [{ label: "a" }, { label: "b" }] }] } };
      await hook(env, s.token, "pre-tool", ask);
      // The dialog stays open past the busy lease; nothing refreshes it until the answer.
      env.withDb((db) => db.query("UPDATE leader_sessions SET busy_until = ?2 WHERE session_id = ?1").run(s.session, Date.now() - 1));
      await hook(env, s.token, "post-tool", { ...ask, tool_use_id: "toolu_1", tool_response: { answers: { "Which?": "a" } } });
      await hook(env, s.token, "prompt", { prompt: NOTICE });
      expect(turnNo(env, s.session)).toBe(turn);
    },
    T,
  );
});
