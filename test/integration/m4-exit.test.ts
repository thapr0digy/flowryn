import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cli, REPO_ROOT, realTasksAxi, waitUntil } from "../helpers/harness.ts";
import { Pty } from "../helpers/pty.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";

/**
 * The M4 exit test (design section 17): a ship goes from dispatch to merged
 * and cleaned on each leader, with approval coming from each channel:
 *   Claude leader: Claude's own prompt (claude-ask), and `flowryn approve`
 *     in your shell (cli-tty, the code read from /dev/tty);
 *   Pi leader: ctx.ui.confirm in the flowryn_merge tool (pi-confirm), and the
 *     board's approve key (board).
 * The leaders are fakes that run the real leader bridge files; the workers
 * are M2's fake workers through the real CLI; GitHub is a local fake. The
 * live run against real Claude Code and Pi in a Herdr lab session is
 * scripts/lab/m4-live.sh.
 */

let env: ShipEnv | null = null;
const ptys: Pty[] = [];
const MAIN = join(REPO_ROOT, "src/main.ts");

afterEach(async () => {
  for (const pty of ptys.splice(0)) pty.kill();
  await env?.cleanup();
  env = null;
});

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdin: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

async function ship(e: ShipEnv, title: string): Promise<{ task: string; run: string }> {
  const db = e.fleet.h.db();
  const mode = (db.query("SELECT delivery_mode FROM projects WHERE id = 'web'").get() as { delivery_mode: string }).delivery_mode;
  db.close();
  const begin = mode === "no-mistakes" ? "FAKE: verb stage begin ship\n" : "";
  const steps = mode === "local-only" ? `FAKE: commit ${title}.txt ${title}\nFAKE: deliver-local\n` : `FAKE: commit ${title}.txt ${title}\n${begin}FAKE: push\nFAKE: pr ${e.github.apiUrl} acme/web\nFAKE: deliver-pr\n`;
  const dispatched = await e.fleet.json(["dispatch", "web", "--kind", "ship", "--harness", "claude", "--body-file", "-"], { env: { FLOWRYN_TOKEN: e.leaderToken() }, stdin: `${title}\n${steps}FAKE: sleep 120000` });
  if (dispatched.code !== 0) throw new Error(`dispatch: ${JSON.stringify(dispatched.reply)}`);
  const shipped = dispatched.reply.data as { task: string; run: string };
  await e.fleet.waitRun(shipped.run, (r) => r.state === "ready", `${title} delivered`);
  return shipped;
}

async function landedAndCleaned(e: ShipEnv, run: string, task: string): Promise<void> {
  const done = await e.fleet.waitRun(run, (r) => r.state === "cleaned", "cleaned", 30_000);
  expect(existsSync(done.worktree_path)).toBe(false);
  await waitUntil(() => /^\s*state:\s*done/m.test(Bun.spawnSync([realTasksAxi(), "show", task, "--file", e.fleet.h.backlog]).stdout.toString()), 20_000, `${task} done`);
}

function channelOf(e: ShipEnv, task: string): string {
  const db = e.fleet.h.db();
  try {
    const row = db.query("SELECT a.channel FROM merges m JOIN approvals a ON a.id = m.approval_id WHERE m.task_id = ?1 AND m.state = 'merged'").get(task) as { channel: string } | null;
    return row?.channel ?? "none";
  } finally {
    db.close();
  }
}

/** You, in your own terminal: `flowryn approve <task>` in a real pty, reading the code off the screen and typing it back. */
async function approveInShell(e: ShipEnv, task: string, extra: string[] = []): Promise<string> {
  const pty = Pty.spawn(["bun", MAIN, "approve", task, ...extra], e.fleet.h.env, REPO_ROOT);
  ptys.push(pty);
  const [, code] = await pty.waitFor(/Type ([A-Z]{4}) to approve/);
  await pty.type(`${code}\n`);
  expect(await pty.exited).toBe(0);
  return pty.text();
}

describe("M4 exit: dispatch to merged and cleaned, on each leader, approval from each channel", () => {
  test(
    "Claude leader, channel claude-ask: Claude prompts you, a no runs nothing, a yes merges; bypass mode never counts",
    async () => {
      env = await makeShipEnv({ mode: "direct-PR" });
      const e = env;
      const leader = await e.claude();
      await leader.start();
      const { task, run } = await ship(e, "claude-ask");
      const head = e.github.pr("acme/web", 1).headSha;

      const no = await leader.runBash(`flowryn merge ${task}`, { approve: false });
      expect(no).toMatchObject({ prompted: true, ran: false });
      expect(leader.prompts[0]).toContain("https://github.com/acme/web/pull/1");
      expect(leader.prompts[0]).toContain(head.slice(0, 8));
      expect(e.fleet.run(run).state).toBe("ready");

      const yes = await leader.runBash(`flowryn merge ${task} --json`, { approve: true });
      expect(yes).toMatchObject({ prompted: true, ran: true, code: 0 });
      expect(JSON.parse(yes.stdout).data).toMatchObject({ state: "merged", channel: "claude-ask" });
      await landedAndCleaned(e, run, task);
      expect(channelOf(e, task)).toBe("claude-ask");

      // Under bypassPermissions the prompt is not trusted (design section 7, defense in depth).
      const second = await ship(e, "bypass");
      leader.permissionMode = "bypassPermissions";
      const bypass = await leader.runBash(`flowryn merge ${second.task} --json`, { approve: true });
      expect(bypass.code).toBe(2);
      expect(JSON.parse(bypass.stdout).error.code).toBe("approval_required");
      // And the leader can never run approve or a hook verb itself.
      expect((await leader.runBash(`flowryn approve ${second.task}`, { approve: true })).denied).toBe(true);
    },
    { timeout: 120_000 },
  );

  test(
    "Pi leader, channel pi-confirm: the shell is blocked, the flowryn_merge tool shows the PR and asks; no merges nothing, yes merges",
    async () => {
      env = await makeShipEnv({ mode: "no-mistakes" });
      const e = env;
      const leader = await e.pi();
      await leader.start();
      const { task, run } = await ship(e, "pi-confirm");

      const shell = await leader.bash(`flowryn merge ${task}`);
      expect(shell.blocked).toBe(true);
      const no = await leader.callTool("flowryn_merge", { task }, false);
      expect(no).toContain("declined");
      expect(e.fleet.run(run).state).toBe("ready");
      expect(leader.confirms[0]!.message).toContain("https://github.com/acme/web/pull/1");
      expect(leader.confirms[0]!.message).toContain(e.github.pr("acme/web", 1).headSha.slice(0, 12));

      const yes = await leader.callTool("flowryn_merge", { task }, true);
      expect(yes).toContain(`Merged ${task}`);
      await landedAndCleaned(e, run, task);
      expect(channelOf(e, task)).toBe("pi-confirm");
    },
    { timeout: 120_000 },
  );

  test(
    "Claude leader, channel cli-tty: you approve in your own terminal with the code from /dev/tty; piped input and agent panes are refused",
    async () => {
      env = await makeShipEnv({ mode: "local-only" });
      const e = env;
      const leader = await e.claude();
      await leader.start();
      const { task, run } = await ship(e, "cli-tty");

      const piped = await cli(e.fleet.h, ["approve", task], { stdin: "ABCD\n" });
      expect(piped.code).toBe(77);
      expect(piped.stdout).toContain("human_only");
      const agent = await cli(e.fleet.h, ["approve", task], { env: { FLOWRYN_TOKEN: e.fleet.leader } });
      expect(agent.code).toBe(77);

      const screen = await approveInShell(e, task);
      expect(screen).toContain(`Merge ${task}`);
      expect(screen).toContain("into local main");
      const merged = await leader.runBash(`flowryn merge ${task} --json`, { approve: true });
      expect(merged.code).toBe(0);
      await landedAndCleaned(e, run, task);
      expect(channelOf(e, task)).toBe("cli-tty");
      expect(git(e.fleet.repo, ["show", "main:cli-tty.txt"])).toBe("cli-tty");
    },
    { timeout: 120_000 },
  );

  test(
    "Pi leader, channel board: you press a on the board, pick the ship, type the code; the leader's merge uses that record",
    async () => {
      env = await makeShipEnv({ mode: "local-only" });
      const e = env;
      const leader = await e.pi();
      await leader.start();
      const { task, run } = await ship(e, "board");

      const board = Pty.spawn(["bun", MAIN, "board"], e.fleet.h.env, REPO_ROOT);
      ptys.push(board);
      await board.waitFor(/a approve a merge/);
      await board.type("a");
      await board.waitFor(new RegExp(`1\\. ${task}`));
      await board.type("1\r");
      const [, code] = await board.waitFor(/Type ([A-Z]{4}) to approve/);
      await board.type(`${code}\r`);
      await board.waitFor(new RegExp(`Approved ${task}`));
      await board.type("\r");
      await board.waitFor(/a approve a merge[\s\S]*a approve a merge/);
      await board.type("q");
      expect(await board.exited).toBe(0);

      const merged = await leader.callTool("flowryn_merge", { task }, true);
      expect(merged).toContain(`Merged ${task}`);
      await landedAndCleaned(e, run, task);
      expect(channelOf(e, task)).toBe("board");
    },
    { timeout: 120_000 },
  );
});
