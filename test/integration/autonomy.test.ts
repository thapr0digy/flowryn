import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DOC_TEMPLATES } from "../../src/lifecycle/brief-templates.ts";
import { filledDesignPage } from "../helpers/design-page.ts";
import type { FakeClaudeLeader } from "../helpers/fake-claude-leader.ts";
import { REPO_ROOT, waitUntil } from "../helpers/harness.ts";
import { Pty } from "../helpers/pty.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";

/**
 * Unattended mode end to end (docs/notes/2026-11-05-unattended-mode-one-9e.md): a real daemon,
 * the fake GitHub over the project's bare origin, fake workers and a landing-queue project that
 * is not yolo. With the standing approval granted from your terminal, spec'd ships go from
 * dispatch through an automatic design pass, build and ship to the queue's merge with no human
 * input; a ship that asks a destructive question parks alone; `flowryn back` prints the
 * Autonomous section. And the security bar: who can and cannot grant it, and what it never covers.
 */

let env: ShipEnv | null = null;
const ptys: Pty[] = [];
const MAIN = join(REPO_ROOT, "src/main.ts");
afterEach(async () => {
  for (const pty of ptys.splice(0)) pty.kill();
  await env?.cleanup();
  env = null;
}, 30_000);

const STEPS = ["printf ' 1 pass\\n 0 fail\\n 1 expect() calls\\nRan 1 tests across 1 file. [1.00ms]\\n'"];
const CONFIG = `[projects.web]\nverify = ${JSON.stringify(STEPS)}\nlanding = "queue"\n`;
const SPEC = "# Build spec\\n\\n## Approach\\nWrite one file.\\n\\n## Files and interfaces\\nOne file.\\n\\n## Data and schema\\nOne table.\\n\\n## Error handling\\nRefuse loudly.\\n\\n## Security\\nNo token in logs.\\n\\n## Test plan\\nRead it back.\\n\\n## Rejected alternatives\\nNone: the only way.";
const HANDOFF = "## Done\\nWrote it.\\n\\n## Deviations\\nNone.\\n\\n## Risks\\nNone.";
const PAGE = filledDesignPage().replace("</details>", '<a href="spec.md">The build spec</a></details>');

/** A full ship brief (so autonomy may pass its review) whose Verification section carries the fake worker's steps. */
function brief(title: string, steps: string[]): string {
  return `${title}\n\n${DOC_TEMPLATES.ship.replace(/^<one-line title>\n/, "").replace(/\{\{[^}]*\}\}/g, "Written in full by the leader.")}\n${steps.join("\n")}\n`;
}

function designThenShip(file: string, apiUrl: string, before: string[] = []): string[] {
  return [
    ...before,
    `FAKE: write design/design.html ${PAGE}`,
    `FAKE: write design/spec.md ${SPEC}`,
    "FAKE: stage-done --review lavish:design/design.html --page $FLOWRYN_REPORT_DIR/design/design.html",
    `FAKE: commit ${file} ${file}`,
    `FAKE: write handoff.md ${HANDOFF}`,
    "FAKE: stage-done --handoff-file $FLOWRYN_REPORT_DIR/handoff.md",
    "FAKE: push",
    `FAKE: pr ${apiUrl} acme/web`,
    "FAKE: deliver-pr",
  ];
}

function rows<T>(e: ShipEnv, sql: string, ...params: string[]): T[] {
  const db = e.fleet.h.db();
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

async function dispatch(e: ShipEnv, title: string, steps: string[], extra: string[] = []): Promise<{ task: string; run: string }> {
  const reply = await e.fleet.json(["dispatch", "web", "--kind", "ship", "--harness", "claude", ...extra, "--body-file", "-"], { env: { FLOWRYN_TOKEN: e.leaderToken() }, stdin: brief(title, steps) });
  if (reply.code !== 0) throw new Error(`dispatch: ${JSON.stringify(reply.reply)}`);
  return reply.reply.data as { task: string; run: string };
}

/** Grant from your terminal: begin, then confirm with the code it showed (the /dev/tty read is the CLI's, tested through a pty below). */
async function grantFromTerminal(e: ShipEnv, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const begun = await e.call("autonomy.begin", args);
  if (!begun.ok) throw new Error(`autonomy.begin: ${JSON.stringify(begun.error)}`);
  const data = begun.data as { challenge: string; code: string };
  const confirmed = await e.call("autonomy.confirm", { challenge: data.challenge, code: data.code, actor: "tester" });
  if (!confirmed.ok) throw new Error(`autonomy.confirm: ${JSON.stringify(confirmed.error)}`);
  return confirmed.data as Record<string, unknown>;
}

/** You, in your own terminal: `flowryn away --autonomous` in a real pty, typing back what `answer` makes of the code it shows. */
async function awayInShell(e: ShipEnv, answer: (code: string) => string): Promise<{ code: number; text: string }> {
  const pty = Pty.spawn(["bun", MAIN, "away", "--autonomous", "--projects", "web", "--until", "+2h"], e.fleet.h.env, REPO_ROOT);
  ptys.push(pty);
  const [, code] = await pty.waitFor(/Type (\S+) to grant it/);
  await pty.type(`${answer(code!)}\n`);
  return { code: await pty.exited, text: pty.text() };
}

describe("unattended mode", () => {
  test(
    "from your terminal: piped input is refused, a wrong code grants nothing, the code read from /dev/tty grants it on cli-tty",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR", yolo: false, extraConfig: CONFIG });
      const e = env;
      const piped = await e.fleet.json(["away", "--autonomous", "--projects", "web", "--until", "+2h"], { env: { FLOWRYN_TOKEN: "" } });
      expect(piped.reply.error).toMatchObject({ code: "human_only" });
      const wrong = await awayInShell(e, (code) => (code === "ZZZZ" ? "YYYY" : "ZZZZ"));
      expect(wrong.code).not.toBe(0);
      expect(wrong.text).toContain("the code does not match; nothing was granted");
      expect(rows(e, "SELECT 1 FROM autonomy_grants")).toHaveLength(0);
      const right = await awayInShell(e, (code) => code);
      expect(right.code).toBe(0);
      expect(rows(e, "SELECT id, channel FROM autonomy_grants")).toEqual([{ id: "u1", channel: "cli-tty" }]);
    },
    { timeout: 60_000 },
  );

  test(
    "two spec'd ships run dispatch → design auto-pass → build → ship → queue merge with no input; a destructive question parks its ship alone; back prints all three",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR", yolo: false, extraConfig: CONFIG });
      const e = env;
      e.github.repo("acme/web").defaultChecks = [];
      expect((await e.fleet.json(["project", "set", "web", "--workflow", "feature"])).code).toBe(0);
      const started = await grantFromTerminal(e, { projects: "web", until: "+8h", body: "Ship the queue overnight" });
      expect(started).toMatchObject({ autonomy: "u1", projects: "web", channel: "cli-tty" });
      expect((await e.call("show", { target: "autonomy" })).data).toMatchObject({ autonomy: "u1", state: "live" });

      const one = await dispatch(e, "First file", designThenShip("one.txt", e.github.apiUrl));
      // Sensitive work merges on the standing approval too.
      const two = await dispatch(e, "Second file", designThenShip("two.txt", e.github.apiUrl), ["--sensitive"]);
      const three = await dispatch(e, "Third file", designThenShip("three.txt", e.github.apiUrl, ["FAKE: ask keep,drop Should I drop the legacy users table before the migration?"]));

      await waitUntil(() => rows(e, "SELECT 1 FROM runs WHERE task_id IN (?1, ?2) AND state IN ('landed','cleaned')", one.task, two.task).length === 2, 120_000, "both spec'd ships landed");
      const passes = rows<{ task_id: string; channel: string }>(e, "SELECT r.task_id, a.channel FROM gates g JOIN runs r ON r.id = g.run_id JOIN approvals a ON a.id = g.approval_id WHERE g.kind = 'review' AND g.state = 'passed' ORDER BY r.task_id");
      expect(passes.filter((p) => p.task_id === one.task || p.task_id === two.task).map((p) => p.channel)).toEqual(["autonomous", "autonomous"]);
      const merges = rows<{ task_id: string; channel: string; actor: string }>(e, "SELECT m.task_id, a.channel, a.actor FROM merges m JOIN approvals a ON a.id = m.approval_id ORDER BY m.requested_at");
      expect(merges.map((m) => m.channel)).toEqual(["autonomous", "autonomous"]);
      expect(merges.every((m) => m.actor.includes("standing approval u1"))).toBe(true);

      // The third waits alone: its question open for you, its task held, a morning item; its gate never opened.
      const parked = rows<{ id: string; state: string; autonomy_state: string }>(e, "SELECT id, state, autonomy_state FROM decisions WHERE task_id = ?1", three.task);
      expect(parked).toEqual([expect.objectContaining({ state: "open", autonomy_state: "parked" })]);
      expect(rows(e, "SELECT 1 FROM items WHERE kind = 'autonomy_parked' AND task_id = ?1 AND state IN ('open','presented')", three.task)).toHaveLength(1);
      expect(rows(e, "SELECT 1 FROM gates WHERE run_id = ?1", three.run)).toHaveLength(0);
      // Every autonomous action is an event naming the grant.
      const kinds = rows<{ kind: string; payload: string }>(e, "SELECT kind, payload FROM events WHERE kind LIKE 'autonomy.%' ORDER BY seq");
      for (const k of kinds) expect(JSON.parse(k.payload).autonomy).toBe("u1");
      expect(kinds.filter((k) => k.kind === "autonomy.gate_passed")).toHaveLength(2);

      const back = await e.call("back", {});
      expect(back.ok).toBe(true);
      const text = ((back.data as { brief: string[] }).brief ?? []).join("\n");
      expect(back.data).toMatchObject({ autonomy: "u1 ended (back)" });
      expect(text).toContain("Autonomous (u1: ended (back), projects web");
      expect(text).toContain("Gates passed (2):");
      expect(text).toContain("Merged (2):");
      expect(text).toContain(`${three.task}) on ${parked[0]!.id}: a destructive question`);
      expect(text).toContain("spec ");
      expect(text).toContain("https://");
      // Ended: nothing more is granted.
      expect(rows(e, "SELECT 1 FROM autonomy_grants WHERE ended_at IS NULL")).toHaveLength(0);
    },
    { timeout: 240_000 },
  );

  test(
    "on a project that merges by hand (no landing queue, auto_merge off) a delivered, not-yolo PR is verified and merged under the grant, and only while it lasts",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR", yolo: false, extraConfig: `[projects.web]\nverify = ${JSON.stringify(STEPS)}\n` });
      const e = env;
      e.github.repo("acme/web").defaultChecks = [];
      const steps = ["FAKE: commit manual.txt manual", "FAKE: push", `FAKE: pr ${e.github.apiUrl} acme/web`, "FAKE: deliver-pr"];
      // Delivered before the grant: nothing merges by itself.
      const before = await dispatch(e, "Manual merge", steps);
      await e.fleet.waitRun(before.run, (r) => r.state === "ready", "the delivery");
      expect(rows(e, "SELECT 1 FROM auto_merges WHERE run_id = ?1 AND merge = 1", before.run)).toHaveLength(0);
      await grantFromTerminal(e, { projects: "web", until: "+2h" });
      await waitUntil(() => rows(e, "SELECT 1 FROM runs WHERE id = ?1 AND state IN ('landed','cleaned')", before.run).length === 1, 90_000, "the merge under the grant");
      const merge = rows<{ channel: string; actor: string }>(e, "SELECT a.channel, a.actor FROM merges m JOIN approvals a ON a.id = m.approval_id WHERE m.task_id = ?1", before.task);
      expect(merge).toEqual([expect.objectContaining({ channel: "autonomous" })]);
      expect(merge[0]!.actor).toContain("standing approval u1");
    },
    { timeout: 150_000 },
  );

  test(
    "a worker can neither start autonomy nor reach its terminal verbs; a leader cannot without the user's chat answer; your socket call without the /dev/tty code grants nothing",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR", yolo: false, extraConfig: CONFIG });
      const e = env;
      const worker = await dispatch(e, "Worker tries", [
        "FAKE: verb away --autonomous --projects web --until +2h",
        "FAKE: verb back",
        "FAKE: sleep 120000",
      ]);
      const replies = await e.replies(worker.task, 2);
      expect(replies[0]!.code).toBe(77);
      expect(replies[1]!.code).toBe(77);

      const leader = await e.fleet.json(["away", "--autonomous", "--projects", "web", "--until", "+2h"], { env: { FLOWRYN_TOKEN: e.leaderToken() } });
      expect(leader.code).toBe(2);
      expect(leader.reply.error).toMatchObject({ code: "approval_required" });
      const human = await e.call("away", { autonomous: true, projects: "web", until: "+2h" });
      expect(human.error).toMatchObject({ code: "approval_required" });
      const leaderBegin = await e.call("autonomy.begin", { projects: "web", until: "+2h" }, e.leaderToken());
      expect(leaderBegin.ok).toBe(false);
      const wrongCode = await e.call("autonomy.begin", { projects: "web", until: "+2h" });
      const challenge = (wrongCode.data as { challenge: string }).challenge;
      expect((await e.call("autonomy.confirm", { challenge, code: "ZZZZ", actor: "x" })).error).toMatchObject({ code: "challenge_failed" });
      expect((await e.call("autonomy.begin", { projects: "web", until: "+17h" })).error).toMatchObject({ code: "bad_args" });
      expect(rows(e, "SELECT 1 FROM autonomy_grants")).toHaveLength(0);
    },
    { timeout: 60_000 },
  );

  test(
    "the Claude leader starts it only with your answer to the binding question for exactly those terms",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR", yolo: false, extraConfig: CONFIG });
      const e = env;
      const leader: FakeClaudeLeader = await e.claude();
      await leader.start();
      const refused = await e.fleet.json(["away", "--autonomous", "--projects", "web", "--until", "+2h"], { env: { FLOWRYN_TOKEN: e.leaderToken() } });
      expect(refused.code).toBe(2);
      const help = String((refused.reply.error as { help: string }).help);
      const ref = /flowryn chat-question (autonomy:\S+)/.exec(help)?.[1];
      expect(ref).toBeDefined();
      const asked = await e.fleet.json(["chat-question", ref!], { env: { FLOWRYN_TOKEN: e.leaderToken() } });
      const q = JSON.parse((asked.reply.data as { question: string }).question);
      const answered = await leader.ask([q], { answers: { [q.question]: "Start autonomy" }, notes: { [q.question]: "back at 8" } });
      expect(answered.denied).toBe(false);
      const grant = /Grant (c\d+)/.exec(answered.contexts.join("\n"))?.[1];
      expect(grant).toBeDefined();
      const used = await leader.runBash(`flowryn grant use ${grant} --json`, { approve: false });
      expect(used.code).toBe(0);
      expect(JSON.parse(used.stdout).data).toMatchObject({ autonomy: "u1", channel: "claude-chat", ran: "away" });
      const row = rows<{ channel: string; grant_id: string; words: string }>(e, "SELECT channel, grant_id, words FROM autonomy_grants WHERE id = 'u1'")[0]!;
      expect(row).toMatchObject({ channel: "claude-chat", grant_id: grant, words: "back at 8" });
      // The grant is used once; a second use, or the same command again, starts nothing.
      expect((await leader.runBash(`flowryn grant use ${grant} --json`, { approve: false })).code).toBe(2);
    },
    { timeout: 60_000 },
  );
});
