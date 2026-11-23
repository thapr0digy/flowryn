import { afterEach, describe, expect, test } from "bun:test";
import { DOC_TEMPLATES } from "../../src/lifecycle/brief-templates.ts";
import { waitUntil } from "../helpers/harness.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";
import { useIntegrationTimeout } from "../helpers/integration-timeout.ts";

useIntegrationTimeout();

/**
 * The leader answers reserved worker questions while the user is away under unattended mode
 * (docs/notes/2026-11-23-while-the-user-67.md), through the real CLI and daemon: refused without
 * a grant, accepted with one (the worker steered, the return brief listing it), refused again after
 * back; a reader session and the worker itself are refused throughout.
 */

let env: ShipEnv | null = null;
afterEach(async () => {
  await env?.cleanup();
  env = null;
}, 30_000);

const STEPS = ["printf ' 1 pass\\n 0 fail\\n 1 expect() calls\\nRan 1 tests across 1 file. [1.00ms]\\n'"];
const CONFIG = `[projects.web]\nverify = ${JSON.stringify(STEPS)}\n`;

function brief(title: string, steps: string[]): string {
  return `${title}\n\n${DOC_TEMPLATES.ship.replace(/^<one-line title>\n/, "").replace(/\{\{[^}]*\}\}/g, "Written in full by the leader.")}\n${steps.join("\n")}\n`;
}

function rows<T>(e: ShipEnv, sql: string, ...params: string[]): T[] {
  const db = e.fleet.h.db();
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

async function grantFromTerminal(e: ShipEnv): Promise<void> {
  const begun = await e.call("autonomy.begin", { projects: "web", until: "+2h" });
  if (!begun.ok) throw new Error(`autonomy.begin: ${JSON.stringify(begun.error)}`);
  const data = begun.data as { challenge: string; code: string };
  const confirmed = await e.call("autonomy.confirm", { challenge: data.challenge, code: data.code, actor: "tester" });
  if (!confirmed.ok) throw new Error(`autonomy.confirm: ${JSON.stringify(confirmed.error)}`);
}

/** The open reserved question of the task, once the worker asked it. */
async function openReserved(e: ShipEnv, task: string, after: string | null = null): Promise<string> {
  const pick = () => rows<{ id: string }>(e, "SELECT id FROM decisions WHERE task_id = ?1 AND state = 'open' AND reserved_reason IS NOT NULL AND id IS NOT ?2", task, after ?? "");
  await waitUntil(() => pick().length === 1, 60_000, "the worker's reserved question");
  return pick()[0]!.id;
}

const errorCode = (reply: { reply: Record<string, unknown> }) => (reply.reply as { error?: { code: string } }).error?.code;

describe("the leader decides reserved questions while the user is away with autonomy", () => {
  test(
    "no grant: reserved_decision; grant: accepted as leader-away, the worker steered, the brief lists it; after back: reserved_decision again; reader and worker refused",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR", yolo: false, extraConfig: CONFIG });
      const e = env;
      const leader = { env: { FLOWRYN_TOKEN: e.leaderToken() } };
      const dispatched = await e.fleet.json(["dispatch", "web", "--kind", "ship", "--harness", "claude", "--body-file", "-"], {
        ...leader,
        stdin: brief("Legacy cleanup", [
          "FAKE: write q1.txt Should I drop the legacy users table before the migration?",
          "FAKE: write q2.txt Should I delete the old backups bucket permanently?",
          // Asked through the verb so the fake worker goes on (FAKE: ask ends its steps).
          "FAKE: verb ask --options keep,drop --consequence keep:stays --consequence drop:gone --blocks the-rest-of-this-fake-task --body-file $FLOWRYN_REPORT_DIR/q1.txt",
          // The worker tries to answer its own reserved question: its role is refused.
          "FAKE: verb decide q1 keep --rationale mine",
          "FAKE: verb ask --options keep,delete --consequence keep:stays --consequence delete:gone --blocks the-rest-of-this-fake-task --body-file $FLOWRYN_REPORT_DIR/q2.txt",
          // Short tool calls, so a steer reaches the busy worker at the next one.
          ...Array.from({ length: 60 }, () => "FAKE: sleep 2000"),
        ]),
      });
      expect(dispatched.code).toBe(0);
      const { task, run } = dispatched.reply.data as { task: string; run: string };
      const replies = await e.replies(task, 3);
      expect(replies.map((r) => r.code), JSON.stringify(replies)).toEqual([0, 77, 0]);
      expect(replies[1]!.args.slice(0, 2)).toEqual(["decide", "q1"]);
      const first = await openReserved(e, task, "q2");
      expect(first).toBe("q1");

      // No grant: refused as today.
      const refused = await e.fleet.json(["decide", first, "keep", "--rationale", "-"], { ...leader, stdin: "still read by billing" });
      expect(refused.code).toBe(2);
      expect(errorCode(refused)).toBe("reserved_decision");

      await grantFromTerminal(e);

      // A reader session (no lease) is refused by its role, grant or not.
      const opened = await e.call("lead.open", { harness: "claude", pane: "w9:p77", cwd: e.fleet.h.home });
      expect(opened.ok).toBe(true);
      const reader = await e.fleet.json(["decide", first, "keep", "--rationale", "-"], { env: { FLOWRYN_TOKEN: (opened.data as { token: string }).token }, stdin: "a reader" });
      expect(reader.code).toBe(77);

      // An empty reason is refused under the grant, and nothing is recorded.
      const empty = await e.fleet.json(["decide", first, "keep", "--rationale", "-"], { ...leader, stdin: "  " });
      expect(empty.code).toBe(3);
      expect(rows(e, "SELECT 1 FROM decisions WHERE id = ?1 AND state = 'open'", first)).toHaveLength(1);

      // The leader, under the grant: accepted, recorded as its own away answer, the worker steered.
      const accepted = await e.fleet.json(["decide", first, "keep", "--rationale", "-"], { ...leader, stdin: "the table is still read by billing; keep it" });
      expect(accepted.code).toBe(0);
      expect(accepted.reply.data).toMatchObject({ decision: first, answer: "keep", by: "leader" });
      const steer = String((accepted.reply.data as { steer: string }).steer);
      expect(steer).toMatch(/^m/);
      expect(JSON.stringify(accepted.reply)).toContain("their return brief lists it");
      expect(rows(e, "SELECT answered_by, answered_via, autonomy_id, rationale FROM decisions WHERE id = ?1", first)).toEqual([
        { answered_by: "leader", answered_via: "leader-away", autonomy_id: "u1", rationale: "the table is still read by billing; keep it" },
      ]);

      // The answer reached the worker as a steer, as any leader answer does.
      await waitUntil(() => rows(e, "SELECT 1 FROM messages WHERE id = ?1 AND run_id = ?2 AND acked_at IS NOT NULL", steer, run).length === 1, 30_000, "the worker to acknowledge the answer");

      // Back: the brief lists the reserved answer for review.
      const second = await openReserved(e, task, first);
      const back = await e.call("back", {});
      expect(back.ok).toBe(true);
      const text = ((back.data as { brief: string[] }).brief ?? []).join("\n");
      expect(text).toContain(`[${first}] Should I drop the legacy users table before the migration? → keep (reserved: destructive; the leader decided while you were away; undo: flowryn decide ${first} <choice> --by captain): the table is still read by billing; keep it`);

      // After back, the next reserved question is the user's again.
      const after = await e.fleet.json(["decide", second, "keep", "--rationale", "-"], { ...leader, stdin: "keep the backups" });
      expect(after.code).toBe(2);
      expect(errorCode(after)).toBe("reserved_decision");
    },
    { timeout: 150_000 },
  );
});
