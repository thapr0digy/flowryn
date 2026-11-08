import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { daemonCall, makeHome, seedRun, startDaemon, type DaemonProc, type TestHome } from "../helpers/harness.ts";
import { useIntegrationTimeout } from "../helpers/integration-timeout.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";

useIntegrationTimeout();

/**
 * The review-gate validator and the user-started trigger through the real daemon and CLI
 * (docs/notes/2026-11-08-unattended-loops-answer-4y.md). The validator's model call goes to a
 * stand-in `claude` that answers `-p` with what the test wrote to `<home>/validator-reply`
 * (Claude's JSON result around it), and refuses `--version` like the other stand-ins; it waits
 * while `<home>/validator-hold` exists. Nothing reaches a model.
 */

const homes: TestHome[] = [];
const daemons: DaemonProc[] = [];
let ship: ShipEnv | null = null;
afterEach(async () => {
  await ship?.cleanup();
  ship = null;
  for (const d of daemons.splice(0)) await d.kill9().catch(() => {});
  for (const h of homes.splice(0)) h.cleanup();
});

const HOUR = 3_600_000;
const PASS = JSON.stringify({ verdict: "pass", findings: [], questions: [] });
const CHANGES = JSON.stringify({ verdict: "changes", findings: [{ requirement: "Requirement 3", problem: "Undo is missing.", fix: "Add gate reopen." }], questions: [] });

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@example.test", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, stdin: "ignore" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

/** The stand-in `claude`: the path of its reply file and hold file are written into it (the call's environment is scrubbed). */
function fakeClaude(home: string): string {
  const path = join(home, "fake-claude");
  const reply = join(home, "validator-reply");
  const hold = join(home, "validator-hold");
  const calls = join(home, "validator-calls");
  writeFileSync(
    path,
    `#!/bin/sh
case "$1" in -p) ;; *) echo 'no harness in this test' >&2; exit 1 ;; esac
cat > /dev/null
echo call >> ${JSON.stringify(calls)}
while [ -e ${JSON.stringify(hold)} ]; do sleep 0.1; done
exec ${JSON.stringify(process.execPath)} -e 'const t = require("fs").readFileSync(process.argv[1], "utf8"); console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: t, total_cost_usd: 0.02 }))' ${JSON.stringify(reply)}
`,
  );
  chmodSync(path, 0o755);
  return path;
}

async function until(check: () => boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await Bun.sleep(100);
  }
  return check();
}

/** A run at its design review gate, open for 3h, with a page in its report dir and a git worktree. */
async function setup(reply: string | null, decisions = "") {
  // extraConfig lands right after the home's own [tools] keys, so a bare claude = line is a tool.
  const h = makeHome({ extraConfig: (home) => `claude = ${JSON.stringify(fakeClaude(home))}\n[decisions]\ndefault_gates = ["design"]\ndefault_after_h = 2\nvalidator_rounds = 2\n${decisions}` });
  homes.push(h);
  if (reply !== null) writeFileSync(join(h.home, "validator-reply"), reply);
  const run = seedRun(h);
  const wt = join(h.home, "wt");
  mkdirSync(wt);
  git(h.home, "init", "-q", "-b", "main", wt);
  writeFileSync(join(wt, "a.txt"), "a\n");
  git(wt, "add", ".");
  git(wt, "commit", "-qm", "base");
  git(wt, "update-ref", "refs/remotes/origin/main", "HEAD");
  const page = join(h.dataDir, run.taskId, "design", "design.html");
  mkdirSync(join(h.dataDir, run.taskId, "design"), { recursive: true });
  writeFileSync(page, "<html><body><h1>Design</h1><p>It works.</p></body></html>");
  const db = h.db();
  db.query("UPDATE runs SET worktree_path = ?2, workflow = 'feature', stage = 'design', stage_state = 'review' WHERE id = ?1").run(run.runId, wt);
  db.query("UPDATE task_policy SET workflow = 'feature' WHERE task_id = ?1").run(run.taskId);
  db.query("INSERT INTO gates (id, run_id, stage, kind, review_url, page_path, state, opened_at) VALUES ('g1', ?1, 'design', 'review', 'http://127.0.0.1:4387/session/x', ?2, 'open', ?3)").run(run.runId, page, Date.now() - 3 * HOUR);
  db.close();
  daemons.push(await startDaemon(h));
  const q = <T>(sql: string, ...params: string[]): T | null => {
    const scratch = h.db();
    try {
      return scratch.query(sql).get(...params) as T | null;
    } finally {
      scratch.close();
    }
  };
  const gateState = () => q<{ state: string }>("SELECT state FROM gates WHERE id = 'g1'")?.state;
  const validation = (id = "j1") => q<{ state: string; reason: string | null }>("SELECT state, reason FROM gate_validations WHERE id = ?1", id);
  return { h, run, q, gateState, validation };
}

describe("the review-gate validator", () => {
  test("a user-started away: a passing validator passes the gate on channel validator, the brief lists it with its report and undo, and gate reopen sends it back", async () => {
    const { h, run, q, gateState, validation } = await setup(PASS);
    await Bun.sleep(1_500);
    expect(validation()).toBeNull();
    expect((await daemonCall(h.home, "away", { until: "+8h" })).ok).toBe(true);
    expect(await until(() => gateState() === "passed")).toBe(true);
    expect(validation()).toMatchObject({ state: "passed" });
    expect(q("SELECT a.channel FROM gates g JOIN approvals a ON a.id = g.approval_id WHERE g.id = 'g1'")).toEqual({ channel: "validator" });

    const shown = await daemonCall(h.home, "show", { target: "j1" });
    expect(shown.data).toMatchObject({ validation: "j1", gate: "g1", state: "passed", verdict: "pass", spend: "$0.02" });

    const back = await daemonCall(h.home, "back", {});
    const brief = (back.data as { brief: string[] }).brief.join("\n");
    expect(brief).toContain(`- [j1] design review of ${run.taskId} → passed by the validator (after 3h 0m; report: flowryn show j1; undo: flowryn gate reopen ${run.taskId} --gate design --body-file -)`);

    // Your terminal (the human role): the undo of the validator's pass.
    const reopened = await daemonCall(h.home, "gate reopen", { task: run.taskId, gate: "design", body: "Keep the old trigger as an option." });
    expect(reopened.ok).toBe(true);
    expect(reopened.data).toMatchObject({ gate: "g1", state: "reopened", to: "design" });
    expect(q("SELECT stage FROM runs WHERE id = ?1", run.runId)).toEqual({ stage: "design" });
    expect(q("SELECT 1 AS n FROM events WHERE kind = 'gate.reopened'")).toEqual({ n: 1 });
  });

  test("an automatic away never starts the validator", async () => {
    const { h, validation, gateState } = await setup(PASS);
    const db = h.db();
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('away', ?1)").run(JSON.stringify({ since: Date.now() - HOUR, until: Date.now() + 8 * HOUR, words: null, by: "auto" }));
    db.close();
    await Bun.sleep(2_500);
    expect(validation()).toBeNull();
    expect(gateState()).toBe("open");
  });

  test("a validator asking for changes sends the findings to the worker as gate changes", async () => {
    const { h, run, q, gateState, validation } = await setup(CHANGES);
    expect((await daemonCall(h.home, "away", { until: "+8h" })).ok).toBe(true);
    expect(await until(() => gateState() === "changes")).toBe(true);
    expect(validation()).toMatchObject({ state: "changes" });
    expect(q<{ feedback: string }>("SELECT feedback FROM gates WHERE id = 'g1'")!.feedback).toContain("Fix: Add gate reopen.");
    // Back to design through the scheduler: the stage start's steer carries the findings, attributed to the validator.
    const back_to = q<{ stage: string; stage_note: string }>("SELECT stage, stage_note FROM runs WHERE id = ?1", run.runId)!;
    expect(back_to.stage).toBe("design");
    expect(back_to.stage_note).toContain("The independent validator (j1)");
    expect(back_to.stage_note).toContain("1. (requirement: Requirement 3) Undo is missing. Fix: Add gate reopen.");
    const back = await daemonCall(h.home, "back", {});
    expect((back.data as { brief: string[] }).brief.join("\n")).toContain("→ sent back by the validator with 1 finding (after 3h 0m; report: flowryn show j1)");
  });

  test("malformed output keeps the gate waiting, raises an item, and the brief says no verdict", async () => {
    const { h, q, gateState, validation } = await setup("Looks fine to me!");
    expect((await daemonCall(h.home, "away", { until: "+8h" })).ok).toBe(true);
    expect(await until(() => validation()?.state === "failed")).toBe(true);
    expect(validation()!.reason).toContain("did not follow the schema");
    expect(gateState()).toBe("open");
    expect(q("SELECT 1 AS n FROM items WHERE kind = 'validator_failed'")).toEqual({ n: 1 });
    // The second round fails too; then the gate waits for the user.
    expect(await until(() => validation("j2")?.state === "failed")).toBe(true);
    await Bun.sleep(2_000);
    expect(validation("j3")).toBeNull();
    const back = await daemonCall(h.home, "back", {});
    expect((back.data as { brief: string[] }).brief.join("\n")).toContain("→ no verdict, waits for you: the reply did not follow the schema");
  });

  test("the user returning mid-call turns the verdict into advice; nothing acts", async () => {
    const { h, gateState, validation } = await setup(null);
    writeFileSync(join(h.home, "validator-hold"), "");
    writeFileSync(join(h.home, "validator-reply"), PASS);
    expect((await daemonCall(h.home, "away", { until: "+8h" })).ok).toBe(true);
    expect(await until(() => existsSync(join(h.home, "validator-calls")))).toBe(true);
    expect((await daemonCall(h.home, "back", {})).ok).toBe(true);
    Bun.spawnSync(["rm", "-f", join(h.home, "validator-hold")]);
    expect(await until(() => validation()?.state === "advised")).toBe(true);
    expect(gateState()).toBe("open");
  });
});

describe("deadline defaults under an automatic away", () => {
  test("a due nomistakes question waits under an automatic away and is answered once the user starts away", async () => {
    const { h, run, q } = await setup(PASS, 'default_classes = ["nomistakes"]\n');
    const db = h.db();
    db.query("UPDATE gates SET state = 'passed' WHERE id = 'g1'").run();
    db.query(
      `INSERT INTO decisions (id, task_id, run_id, question, options, blocking, state, origin, key, recommendation, reserved_reason, reserved_class, created_at)
       VALUES ('q900', ?1, ?2, 'rb-1 in a touched file', '["fix","approve","skip"]', 0, 'open', 'worker', 'q900', 'fix', 'no-mistakes gate', 'nomistakes', ?3)`,
    ).run(run.taskId, run.runId, Date.now() - 5 * HOUR);
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('away', ?1)").run(JSON.stringify({ since: Date.now() - HOUR, until: Date.now() + 8 * HOUR, words: null, by: "auto" }));
    db.close();
    await Bun.sleep(2_500);
    expect(q("SELECT state FROM decisions WHERE id = 'q900'")).toEqual({ state: "open" });
    expect((await daemonCall(h.home, "away", { until: "+8h" })).ok).toBe(true);
    expect(await until(() => q<{ state: string }>("SELECT state FROM decisions WHERE id = 'q900'")?.state === "answered")).toBe(true);
    expect(q("SELECT answered_by, answered_via FROM decisions WHERE id = 'q900'")).toEqual({ answered_by: "policy", answered_via: "deadline" });
  });
});

describe("an away the user confirms in chat", () => {
  test(
    "the leader's own away is by leader and names the chat question; the user's answer through the real hooks makes it captain-chat, once",
    async () => {
      ship = await makeShipEnv({ mode: "direct-PR", yolo: false });
      const e = ship;
      const posture = () => {
        const db = e.fleet.h.db();
        try {
          return JSON.parse((db.query("SELECT value FROM meta WHERE key = 'away'").get() as { value: string }).value) as { by: string; words: string | null };
        } finally {
          db.close();
        }
      };
      const leader = await e.claude();
      await leader.start();
      const own = await e.fleet.json(["away", "--until", "+2h"], { env: { FLOWRYN_TOKEN: e.leaderToken() } });
      expect(own.code).toBe(0);
      expect(own.reply.data).toMatchObject({ by: "leader" });
      const hint = (own.reply.hints as string[]).join("\n");
      const ref = /flowryn chat-question (away:\S+)/.exec(hint)?.[1];
      expect(ref).toBeDefined();
      expect(posture().by).toBe("leader");
      const asked = await e.fleet.json(["chat-question", ref!], { env: { FLOWRYN_TOKEN: e.leaderToken() } });
      expect(asked.code).toBe(0);
      const q = JSON.parse((asked.reply.data as { question: string }).question);
      const answered = await leader.ask([q], { answers: { [q.question]: "Decide while I'm away" }, notes: { [q.question]: "back at 8" } });
      expect(answered.denied).toBe(false);
      const grant = /Grant (c\d+)/.exec(answered.contexts.join("\n"))?.[1];
      expect(grant).toBeDefined();
      const used = await leader.runBash(`flowryn grant use ${grant} --json`, { approve: false });
      expect(used.code).toBe(0);
      expect(JSON.parse(used.stdout).data).toMatchObject({ by: "captain-chat", ran: "away" });
      expect(posture()).toMatchObject({ by: "captain-chat", words: "back at 8" });
      expect((await leader.runBash(`flowryn grant use ${grant} --json`, { approve: false })).code).toBe(2);
    },
    { timeout: 60_000 },
  );
});
