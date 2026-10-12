import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FakeClaudeLeader } from "../helpers/fake-claude-leader.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";

/**
 * The leader's pin never drifts with its hooks (docs/notes/2026-10-11-add-a-regression-d9.md):
 * `leader_sessions.cwd` is a grant anchor, written only by `lead.open` (and `flowryn leader repin`).
 * Before #57 the SessionStart hook copied its input's `cwd` into it, so a compact after the leader
 * `cd`'d moved the pin off the transcript's folder and every chat-answer grant then failed.
 */

let ship: ShipEnv | null = null;
afterEach(async () => {
  await ship?.cleanup();
  ship = null;
}, 30_000);

type Question = { question: string; header: string; options: { label: string; description: string }[]; multiSelect: boolean };

function token(e: ShipEnv) {
  return { env: { FLOWRYN_TOKEN: e.leaderToken() } };
}

function pinOf(e: ShipEnv, session: string): { cwd: string | null; pinned_at: number | null } {
  const db = e.fleet.h.db();
  try {
    return db.query("SELECT cwd, pinned_at FROM leader_sessions WHERE session_id = ?1").get(session) as { cwd: string | null; pinned_at: number | null };
  } finally {
    db.close();
  }
}

async function decisionGrantWorks(e: ShipEnv, leader: FakeClaudeLeader, key: string): Promise<void> {
  const added = await e.fleet.json(["decision", "add", "--key", key, "--question", "Rotate the signing key now?", "--options", "yes,no", "--recommend", "yes", "--reserved", "security", "--body-file", "-"], { ...token(e), stdin: "The old one leaked." });
  const decision = (added.reply.data as { decision: string }).decision;
  const asked = await e.fleet.json(["chat-question", decision], token(e));
  const q = JSON.parse((asked.reply.data as { question: string }).question) as Question;
  const answered = await leader.ask([q], { answers: { [q.question]: "yes (Recommended)" } });
  const grant = /Grant (c\d+)/.exec(answered.contexts.join("\n"))?.[1];
  if (!grant) throw new Error(`no grant in ${JSON.stringify(answered.contexts)}`);
  const used = await leader.runBash(`flowryn grant use ${grant} --json`, { approve: false });
  expect(used).toMatchObject({ prompted: false, ran: true, code: 0 });
  expect(JSON.parse(used.stdout).data).toMatchObject({ decision, answer: "yes", by: "captain", grant });
}

describe("the leader pin", () => {
  test(
    "a SessionStart after the leader cd'd leaves the pin where lead.open put it; a chat-answer grant still validates",
    async () => {
      ship = await makeShipEnv({ mode: "local-only" });
      const e = ship;
      const pinned = join(e.fleet.h.home, "leader-cwd");
      const elsewhere = join(e.fleet.h.home, "leader-cwd", "elsewhere");
      mkdirSync(elsewhere, { recursive: true });
      const leader = await e.claude();
      await leader.start();
      const session = leader.session();
      expect(pinOf(e, session)).toEqual({ cwd: pinned, pinned_at: null });

      // The 2026-10-08 drift: `cd` in a Bash call, then Claude compacts; the hook input names the new cwd.
      leader.cd(elsewhere);
      await leader.compact();
      expect(pinOf(e, session)).toEqual({ cwd: pinned, pinned_at: null });
      await decisionGrantWorks(e, leader, "after-compact");

      // A cleared or resumed conversation keeps the same session and the same pin.
      for (const source of ["clear", "resume", "startup"]) {
        await leader.hook("SessionStart", { source });
        expect(pinOf(e, session)).toEqual({ cwd: pinned, pinned_at: null });
      }
      await decisionGrantWorks(e, leader, "after-clear");
    },
    { timeout: 60_000 },
  );

  test(
    "the leader's own token reaching the hook verb with any cwd cannot move the pin",
    async () => {
      ship = await makeShipEnv({ mode: "local-only" });
      const e = ship;
      const pinned = join(e.fleet.h.home, "leader-cwd");
      const leader = await e.claude();
      await leader.start();
      const session = leader.session();
      const transcript = leader.transcriptPath();
      for (const source of ["compact", "startup", "clear", "resume"]) {
        const reply = await e.call(
          "hook.session-start",
          { harness: "claude", input: JSON.stringify({ hook_event_name: "SessionStart", source, cwd: "/", transcript_path: transcript, session_id: transcript.replace(/^.*\/(.*)\.jsonl$/, "$1") }) },
          e.leaderToken(),
        );
        expect(reply.ok).toBe(true);
        expect(pinOf(e, session)).toEqual({ cwd: pinned, pinned_at: null });
      }
      await decisionGrantWorks(e, leader, "after-forged");
    },
    { timeout: 60_000 },
  );
});
