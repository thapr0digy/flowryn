import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeClaudeLeader } from "../helpers/fake-claude-leader.ts";
import { waitUntil } from "../helpers/harness.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";
import { useIntegrationTimeout } from "../helpers/integration-timeout.ts";

useIntegrationTimeout();

/**
 * Chat-answer approvals for discard and allow-red (docs/notes/2026-11-09-chat-answer-approvals-wa.md),
 * end to end through the real leader hooks and CLI with the fake Claude leader and the fake forge.
 */

let ship: ShipEnv | null = null;
afterEach(async () => {
  await ship?.cleanup();
  ship = null;
}, 30_000);

type Question = { question: string; header: string; options: { label: string; description: string }[]; multiSelect: boolean };

const RED = "CI / build (ubuntu-latest, 20)";

function token(e: ShipEnv) {
  return { env: { FLOWRYN_TOKEN: e.leaderToken() } };
}

async function chatQuestion(e: ShipEnv, ref: string): Promise<Question> {
  const reply = await e.fleet.json(["chat-question", ref], token(e));
  if (reply.code !== 0) throw new Error(`chat-question ${ref}: ${JSON.stringify(reply.reply)}`);
  return JSON.parse((reply.reply.data as { question: string }).question) as Question;
}

function grantOf(contexts: string[]): string {
  const id = /Grant (c\d+)/.exec(contexts.join("\n"))?.[1];
  if (!id) throw new Error(`no grant in ${JSON.stringify(contexts)}`);
  return id;
}

function rows<T>(e: ShipEnv, sql: string, ...params: string[]): T[] {
  const db = e.fleet.h.db();
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdin: "ignore",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function errorOf(stdout: string): { code: string; message: string; help?: string } {
  return (JSON.parse(stdout) as { error: { code: string; message: string; help?: string } }).error;
}

async function claudeLeader(e: ShipEnv): Promise<FakeClaudeLeader> {
  const leader = await e.claude();
  await leader.start();
  return leader;
}

/** A cancelled ship with an unlanded commit, and the refusal that records what a discard would remove. */
async function abandoned(e: ShipEnv): Promise<{ task: string; run: string; worktree: string }> {
  const { task, run } = await e.fleet.dispatch("Abandon\nFAKE: commit wip.txt work in progress\nFAKE: sleep 120000", { kind: "ship" });
  await e.fleet.waitRun(run, (r) => r.worker_started_at !== null, "worker started");
  const worktree = e.fleet.run(run).worktree_path;
  await waitUntil(() => git(worktree, ["log", "--oneline", "-1"]).includes("wip.txt"), 10_000, "the commit");
  expect((await e.fleet.json(["cancel", task])).code).toBe(0);
  const refused = await e.fleet.json(["cleanup", task, "--discard"], token(e));
  expect((refused.reply.error as { code: string; help: string }).code).toBe("approval_required");
  expect((refused.reply.error as { help: string }).help).toContain(`flowryn chat-question discard:${task}`);
  expect((refused.reply.error as { help: string }).help).toContain(`flowryn approve ${task} --discard`);
  return { task, run, worktree };
}

function discardApprovals(e: ShipEnv, task: string): { channel: string; actor: string; consumed: boolean }[] {
  return rows<{ channel: string; actor: string; consumed_at: number | null }>(e, "SELECT channel, actor, consumed_at FROM approvals WHERE task_id = ?1 AND action = 'discard'", task).map((r) => ({
    channel: r.channel,
    actor: r.actor,
    consumed: r.consumed_at !== null,
  }));
}

describe("discard by chat answer", () => {
  test(
    "tap Discard, grant use, and the worktree goes, recorded as claude-chat with the grant",
    async () => {
      ship = await makeShipEnv({ mode: "direct-PR" });
      const e = ship;
      const { task, worktree } = await abandoned(e);
      const leader = await claudeLeader(e);
      const q = await chatQuestion(e, `discard:${task}`);
      expect(q.question).toContain(`discard ${task} · `);
      expect(q.question).toContain(git(worktree, ["rev-parse", "HEAD"]).slice(0, 8));
      expect(q.question).toContain("cannot be undone");

      const keep = await leader.ask([q], { answers: { [q.question]: "Keep it" } });
      expect(keep.contexts.join("\n")).toContain("nothing is granted");

      const grant = grantOf((await leader.ask([q], { answers: { [q.question]: "Discard" } })).contexts);
      const used = await leader.runBash(`flowryn grant use ${grant} --json`, { approve: false });
      expect(used).toMatchObject({ prompted: false, ran: true, code: 0 });
      expect(JSON.parse(used.stdout).data).toMatchObject({ removed: true, reason: "discard_approved", grant, ran: "cleanup" });
      expect(existsSync(worktree)).toBe(false);
      const approvals = discardApprovals(e, task);
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({ channel: "claude-chat", consumed: true });
      expect(approvals[0]!.actor).toContain(`chat answer ${grant}`);
      expect(rows<{ consumed_by: string }>(e, "SELECT consumed_by FROM captain_grants WHERE id = ?1", grant)[0]!.consumed_by).toBe(`discard ${task}`);
    },
    { timeout: 90_000 },
  );

  test(
    "a new commit or a new uncommitted file after the tap refuses it, naming why",
    async () => {
      ship = await makeShipEnv({ mode: "direct-PR" });
      const e = ship;
      const { task, worktree } = await abandoned(e);
      const leader = await claudeLeader(e);

      const q = await chatQuestion(e, `discard:${task}`);
      const first = grantOf((await leader.ask([q], { answers: { [q.question]: "Discard" } })).contexts);
      writeFileSync(join(worktree, "late.txt"), "more work");
      const files = await leader.runBash(`flowryn grant use ${first} --json`, { approve: false });
      expect(files.code).not.toBe(0);
      expect(errorOf(files.stdout).message).toContain("uncommitted files have changed");
      expect(existsSync(worktree)).toBe(true);

      // Asked again, the hooks refresh what is recorded; then a commit moves the head.
      const stale = await leader.ask([q], { answers: { [q.question]: "Discard" } });
      expect(stale.denied).toBe(true);
      expect(stale.reason).toContain(`flowryn chat-question discard:${task}`);
      const fresh = await chatQuestion(e, `discard:${task}`);
      expect(fresh.question).toContain("1 uncommitted change(s)");
      const second = grantOf((await leader.ask([fresh], { answers: { [fresh.question]: "Discard" } })).contexts);
      git(worktree, ["add", "late.txt"]);
      git(worktree, ["commit", "-m", "late"]);
      const head = await leader.runBash(`flowryn grant use ${second} --json`, { approve: false });
      expect(head.code).not.toBe(0);
      expect(errorOf(head.stdout).message).toContain(`the head is now ${git(worktree, ["rev-parse", "HEAD"]).slice(0, 8)}`);
      expect(existsSync(worktree)).toBe(true);
      expect(discardApprovals(e, task)).toEqual([]);
    },
    { timeout: 90_000 },
  );

  test(
    "a question that brings its own answer is denied and grants nothing",
    async () => {
      ship = await makeShipEnv({ mode: "direct-PR" });
      const e = ship;
      const { task, worktree } = await abandoned(e);
      const leader = await claudeLeader(e);
      const q = await chatQuestion(e, `discard:${task}`);
      const forged = await leader.ask([q], { answers: { [q.question]: "Discard" } }, { prefill: { [q.question]: "Discard" } });
      expect(forged.denied).toBe(true);
      expect(forged.reason).toContain("may not carry its own answers");
      expect(rows(e, "SELECT id FROM captain_grants")).toEqual([]);
      const plain = await e.fleet.json(["cleanup", task, "--discard"], token(e));
      expect((plain.reply.error as { code: string }).code).toBe("approval_required");
      expect(existsSync(worktree)).toBe(true);
    },
    { timeout: 90_000 },
  );
});

async function redShip(e: ShipEnv): Promise<{ task: string; run: string }> {
  e.github.repo("acme/web").defaultChecks = [
    { name: "ci/test", state: "green" },
    { name: RED, state: "red" },
  ];
  const steps = `FAKE: commit red.txt red\nFAKE: push\nFAKE: pr ${e.github.apiUrl} acme/web\nFAKE: deliver-pr\n`;
  const dispatched = await e.fleet.json(["dispatch", "web", "--kind", "ship", "--harness", "claude", "--body-file", "-"], { ...token(e), stdin: `red\n${steps}FAKE: sleep 120000` });
  if (dispatched.code !== 0) throw new Error(`dispatch: ${JSON.stringify(dispatched.reply)}`);
  const shipped = dispatched.reply.data as { task: string; run: string };
  await e.fleet.waitRun(shipped.run, (r) => r.state === "ready", "delivered");
  await waitUntil(
    () => {
      const row = rows<{ value: string }>(e, "SELECT value FROM run_evidence WHERE run_id = ?1 AND source = 'github'", shipped.run)[0];
      return row ? ((JSON.parse(row.value) as { checks?: { red?: string[] } }).checks?.red ?? []).includes(RED) : false;
    },
    10_000,
    "the red check read",
  );
  return shipped;
}

describe("allow-red by chat answer", () => {
  test(
    "tap Waive and merge: the wrong check refuses, the named one merges as claude-chat; a plain merge grant never waives",
    async () => {
      ship = await makeShipEnv({ mode: "direct-PR" });
      const e = ship;
      const { task } = await redShip(e);
      const leader = await claudeLeader(e);

      // The plain merge question's grant never waives the red check.
      const plain = await chatQuestion(e, `merge:${task}`);
      grantOf((await leader.ask([plain], { answers: { [plain.question]: "Merge" } })).contexts);
      const unwaived = await leader.runBash(`flowryn merge ${task} --json`, { approve: false });
      expect(unwaived.code).not.toBe(0);

      const q = await chatQuestion(e, `allow-red:${task}`);
      expect(q.question).toContain(`waiving the one failing check "${RED}"`);
      const grant = grantOf((await leader.ask([q], { answers: { [q.question]: "Waive and merge" } })).contexts);
      const wrong = await e.fleet.json(["merge", task, "--allow-red", "ci/test"], token(e));
      expect((wrong.reply.error as { code: string }).code).toBe("grant_mismatch");
      expect((wrong.reply.error as { message: string }).message).toContain(RED);

      const used = await leader.runBash(`flowryn grant use ${grant} --json`, { approve: false });
      expect(used).toMatchObject({ prompted: false, ran: true, code: 0 });
      expect(JSON.parse(used.stdout).data).toMatchObject({ state: "merged", channel: "claude-chat", grant });
      const approval = rows<{ channel: string; allow_red_check: string | null }>(e, "SELECT a.channel, a.allow_red_check FROM merges m JOIN approvals a ON a.id = m.approval_id WHERE m.task_id = ?1 AND m.state = 'merged'", task)[0];
      expect(approval).toEqual({ channel: "claude-chat", allow_red_check: RED });
    },
    { timeout: 90_000 },
  );

  test(
    "a tap for one head used on another is refused",
    async () => {
      ship = await makeShipEnv({ mode: "direct-PR" });
      const e = ship;
      const { task } = await redShip(e);
      const leader = await claudeLeader(e);
      const q = await chatQuestion(e, `allow-red:${task}`);
      const grant = grantOf((await leader.ask([q], { answers: { [q.question]: "Waive and merge" } })).contexts);
      // The answer was bound to an earlier head than the PR has now.
      const db = e.fleet.h.db();
      db.query("UPDATE captain_grants SET binds = ?2 WHERE id = ?1").run(grant, "f".repeat(40));
      db.close();
      const used = await leader.runBash(`flowryn grant use ${grant} --json`, { approve: false });
      expect(used.code).not.toBe(0);
      expect(errorOf(used.stdout).message).toContain(`grant ${grant} was for head ffffffff; the head is now ${e.github.pr("acme/web", 1).headSha.slice(0, 8)}`);
      expect(rows(e, "SELECT id FROM merges WHERE task_id = ?1 AND state = 'merged'", task)).toEqual([]);
    },
    { timeout: 90_000 },
  );
});
