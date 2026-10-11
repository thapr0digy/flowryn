import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { claudeProjectSlug } from "../../src/policy/grants.ts";
import type { FakeClaudeLeader } from "../helpers/fake-claude-leader.ts";
import { REPO_ROOT } from "../helpers/harness.ts";
import { Pty } from "../helpers/pty.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";

/**
 * `flowryn leader repin` end to end (docs/notes/2026-10-11-flowryn-leader-repin-xv.md): a Claude
 * leader whose Claude runs in another directory than the one `flowryn lead` pinned gets every
 * grant refused, naming the fix; you repin in a real pty, typing the code back; a fresh answer
 * then works, the old grant never does, and `show L<n>` lists the pin's history. The leader
 * itself can never run it.
 */

let ship: ShipEnv | null = null;
const ptys: Pty[] = [];
const MAIN = join(REPO_ROOT, "src/main.ts");
afterEach(async () => {
  for (const pty of ptys.splice(0)) pty.kill();
  await ship?.cleanup();
  ship = null;
}, 30_000);

type Question = { question: string; header: string; options: { label: string; description: string }[]; multiSelect: boolean };

function token(e: ShipEnv) {
  return { env: { FLOWRYN_TOKEN: e.leaderToken() } };
}

async function chatQuestion(e: ShipEnv, ref: string): Promise<Question> {
  const reply = await e.fleet.json(["chat-question", ref], token(e));
  if (reply.code !== 0) throw new Error(`chat-question ${ref}: ${JSON.stringify(reply.reply)}`);
  return JSON.parse((reply.reply.data as { question: string }).question) as Question;
}

async function askedGrant(e: ShipEnv, leader: FakeClaudeLeader, decision: string): Promise<string> {
  const q = await chatQuestion(e, decision);
  const asked = await leader.ask([q], { answers: { [q.question]: "yes (Recommended)" } });
  const id = /Grant (c\d+)/.exec(asked.contexts.join("\n"))?.[1];
  if (!id) throw new Error(`no grant in ${JSON.stringify(asked.contexts)}`);
  return id;
}

/** The 2026-10-10 drift: the pin is `leader-cwd`, but Claude runs (and keeps its transcript) in `elsewhere`. */
async function driftedLeader(e: ShipEnv): Promise<{ leader: FakeClaudeLeader; decision: string; real: string }> {
  const added = await e.fleet.json(["decision", "add", "--key", "rotate", "--question", "Rotate the signing key now?", "--options", "yes,no", "--recommend", "yes", "--reserved", "security", "--body-file", "-"], { ...token(e), stdin: "The old one leaked." });
  const decision = (added.reply.data as { decision: string }).decision;
  const real = join(e.fleet.h.home, "elsewhere");
  mkdirSync(real, { recursive: true });
  const leader = await e.claude({ cwd: real });
  await leader.start();
  return { leader, decision, real };
}

/** You, in your own terminal: `flowryn leader repin` in a real pty. */
function repinInShell(e: ShipEnv, extra: string[] = [], env: Record<string, string> = {}): Pty {
  const pty = Pty.spawn(["bun", MAIN, "leader", "repin", ...extra], { ...e.fleet.h.env, ...env }, REPO_ROOT);
  ptys.push(pty);
  return pty;
}

describe("flowryn leader repin", () => {
  test(
    "a drifted leader's grant is refused naming the fix; you repin with the code; old grants stay dead, a fresh answer works",
    async () => {
      ship = await makeShipEnv({ mode: "local-only" });
      const e = ship;
      const { leader, decision, real } = await driftedLeader(e);
      const session = leader.session();
      const pinned = join(e.fleet.h.home, "leader-cwd");
      const old = await askedGrant(e, leader, decision);
      const refused = await leader.runBash(`flowryn grant use ${old} --json`, { approve: false });
      expect(refused.code).toBe(2);
      const error = JSON.parse(refused.stdout).error as { code: string; message: string; help: string };
      expect(error.code).toBe("approval_required");
      expect(error.message).toContain(`for the leader's directory (${pinned}); run flowryn leader repin in your terminal`);
      expect(error.help).toContain("flowryn leader repin");

      // A wrong code changes nothing.
      const wrong = repinInShell(e);
      await wrong.waitFor(/Type ([A-Z]{4}) to repin/);
      await wrong.type("NOPE\n");
      expect(await wrong.exited).toBe(3);
      expect(wrong.text()).toContain("the code does not match; nothing was repinned");

      const pty = repinInShell(e);
      const [, code] = await pty.waitFor(/Type ([A-Z]{4}) to repin/);
      const screen = pty.text();
      expect(screen).toContain(`Repin leader session ${session}`);
      expect(screen).toContain(`pinned now  ${pinned}`);
      expect(screen).toContain(`repin to    ${real}   (the transcript's own cwd)`);
      expect(screen).toContain(`transcript  ${join(e.fleet.h.home, "claude-projects", claudeProjectSlug(real))}`);
      expect(screen).toContain("1 live grant is voided");
      await pty.type(`${code}\n`);
      expect(await pty.exited).toBe(0);
      expect(pty.text()).toContain(`new_cwd: ${real}`);

      const again = await leader.runBash(`flowryn grant use ${old} --json`, { approve: false });
      expect(again.code).toBe(2);
      expect(JSON.parse(again.stdout).error.message).toContain("the leader was repinned");

      const fresh = await askedGrant(e, leader, decision);
      const used = await leader.runBash(`flowryn grant use ${fresh} --json`, { approve: false });
      expect(used).toMatchObject({ prompted: false, ran: true, code: 0 });
      expect(JSON.parse(used.stdout).data).toMatchObject({ decision, by: "captain", grant: fresh });

      const shown = (await e.fleet.json(["show", session], token(e))).reply.data as { cwd: string; lease: string; pin: string[]; grants: string[] };
      expect(shown).toMatchObject({ cwd: real, lease: "holder" });
      expect(shown.pin).toHaveLength(2);
      expect(shown.pin[0]).toContain(`opened at ${pinned}`);
      expect(shown.pin[1]).toContain(`repinned by ${e.fleet.h.env.USER || e.fleet.h.env.LOGNAME || "you"}: ${pinned} → ${real} (1 grant voided)`);
      expect(shown.grants.join("\n")).toContain(`${old} · ${decision} = yes`);
      expect(shown.grants.join("\n")).toContain("voided: the leader was repinned");
    },
    { timeout: 90_000 },
  );

  test(
    "human only: refused under a leader token, without a terminal, and from the Claude leader's own shell",
    async () => {
      ship = await makeShipEnv({ mode: "local-only" });
      const e = ship;
      const { leader } = await driftedLeader(e);

      const underToken = repinInShell(e, [], { FLOWRYN_TOKEN: e.leaderToken() });
      expect(await underToken.exited).toBe(77);
      expect(underToken.text()).toContain("leader repin runs only in your own terminal: FLOWRYN_TOKEN is set");

      const piped = await e.fleet.cli(["leader", "repin"]);
      expect(piped.code).toBe(77);
      expect(piped.stdout).toContain("human_only");

      const fromLeader = await leader.runBash("flowryn leader repin", { approve: true });
      expect(fromLeader).toMatchObject({ denied: true, ran: false });

      // The daemon verbs refuse a token caller outright, whatever the CLI does.
      const begun = await e.call("leader.repin.begin", {}, e.leaderToken());
      expect(begun.ok).toBe(false);
      expect(begun.error?.code).toBe("human_only");

      const db = e.fleet.h.db();
      try {
        expect(db.query("SELECT cwd, pinned_at FROM leader_sessions WHERE session_id = ?1").get(leader.session())).toEqual({ cwd: join(e.fleet.h.home, "leader-cwd"), pinned_at: null });
      } finally {
        db.close();
      }
    },
    { timeout: 60_000 },
  );

  test(
    "an approve confirm cannot take a repin challenge, nor a repin confirm an approval",
    async () => {
      ship = await makeShipEnv({ mode: "local-only" });
      const e = ship;
      const { real } = await driftedLeader(e);
      // Nothing asked yet, so the transcript names no directory: you name it.
      const begun = await e.call("leader.repin.begin", { dir: real });
      expect(begun.ok).toBe(true);
      const d = begun.data as { challenge: string; code: string };
      const confirmed = await e.call("approve.confirm", { challenge: d.challenge, code: d.code, actor: "tester" });
      expect(confirmed.ok).toBe(false);
      expect(confirmed.error?.message).toContain("that challenge is a repin, not an approval");
      const db = e.fleet.h.db();
      try {
        expect((db.query("SELECT COUNT(*) AS n FROM approvals").get() as { n: number }).n).toBe(0);
        expect((db.query("SELECT pinned_at FROM leader_sessions WHERE pinned_at IS NOT NULL").all() as unknown[]).length).toBe(0);
      } finally {
        db.close();
      }
    },
    { timeout: 60_000 },
  );
});
