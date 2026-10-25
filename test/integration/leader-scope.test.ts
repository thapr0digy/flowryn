import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openItem } from "../../src/attention/items.ts";
import { leaderEnv } from "../../src/cli/commands/lead.ts";
import { accountById } from "../../src/config/accounts.ts";
import { loadConfig } from "../../src/config/config.ts";
import { tx } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { hashToken, mintToken } from "../../src/api/auth.ts";
import { FakeClaudeLeader } from "../helpers/fake-claude-leader.ts";
import { cliJson, daemonCall, realTasksAxi } from "../helpers/harness.ts";
import { makeLeaderEnv, waitFor, type LeaderEnv } from "../helpers/leader-env.ts";

/**
 * A leader per scope (docs/notes/2026-10-24-leader-scoping-and-vj.md), through
 * the real daemon, CLI and leader hooks: a work leader on the work login and a
 * personal leader on the personal login run side by side, and every work task
 * carries a marker word that must never reach the personal leader.
 */

const MARK = "WORKSECRET";
const root = realpathSync(mkdtempSync(join(tmpdir(), "fl-scope-")));
const WORK = join(root, "work");
const WORK_REPO = join(WORK, "api");
const CLAUDE_WORK = join(root, "claude-work");
const CLAUDE_PERSONAL = join(root, "claude-personal");
for (const dir of [WORK_REPO, CLAUDE_WORK, CLAUDE_PERSONAL]) mkdirSync(dir, { recursive: true });
writeFileSync(join(WORK_REPO, "README.md"), `${MARK} notes\n`);

const SCOPES = `
[scopes]
default = "personal"

[scopes.work]
paths = [${JSON.stringify(WORK)}]

[accounts.claude-work]
harness = "claude"
scope = "work"
config_dir = ${JSON.stringify(CLAUDE_WORK)}

[accounts.claude-personal]
harness = "claude"
scope = "personal"
config_dir = ${JSON.stringify(CLAUDE_PERSONAL)}
`;

const WORK_TASK = "api-secret-w1";
let env: LeaderEnv;

interface Leader {
  fake: FakeClaudeLeader;
  session: string;
  token: string;
  env: Record<string, string>;
}

/** A leader started the way `flowryn lead --account <id>` starts one; `transcriptLogin` puts its transcript under another login. */
async function lead(account: string, transcriptLogin = account): Promise<Leader> {
  const config = loadConfig(env.h.home).config;
  const reply = await env.call("lead.open", { harness: "claude", pane: `w9:p${Math.floor(Math.random() * 90) + 10}`, cwd: join(env.h.home, "leader-cwd"), account }, null);
  if (!reply.ok) throw new Error(`lead.open: ${JSON.stringify(reply.error)}`);
  const { session, token } = reply.data as { session: string; token: string };
  const launched = leaderEnv({ ...env.h.env }, { token, session, files: env.files, inactiveMs: 400, account: accountById(config, account) });
  const loginDir = accountById(config, transcriptLogin).config_dir!;
  const fake = new FakeClaudeLeader({ settingsPath: env.files.claudeSettings, env: launched, dir: env.h.home, cwd: join(env.h.home, "leader-cwd"), projectsDir: join(loginDir, "projects") });
  return { fake, session, token, env: launched };
}

/** A work project, its task In flight with a delivered run, and an item whose line carries the marker. */
function seedWork(): void {
  const added = Bun.spawnSync([realTasksAxi(), "add", WORK_TASK, `${MARK} api task`, "--kind", "ship", "--repo", "api", "--start", "--file", env.h.backlog, "--json"], { stdin: "ignore", env: process.env });
  if (added.exitCode !== 0) throw new Error(`tasks-axi add failed: ${added.stdout.toString()}${added.stderr.toString()}`);
  env.withDb((db) =>
    tx(db, () => {
      const now = Date.now();
      db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('api', '', ?1, 'main', 'local-only')").run(WORK_REPO);
      db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES (?1, 'api', 'ship', 'local-only', 0, 'fix', ?2)").run(WORK_TASK, now);
      db.query(
        `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at, account)
         VALUES ('r01WORKAPI', ?1, 'claude', '2.1.281', 'ready', 'idle', 'fix', 'build', ?2, 'fm/api', 'abc123', ?3, ?4, ?4, 'claude-work')`,
      ).run(WORK_TASK, join(env.h.dataDir, "worktrees", "api", WORK_TASK), hashToken(mintToken("run")), now);
      const event = appendEvent(db, { source: "cli", kind: "test.item", payload: {} });
      openItem(db, { kind: "pr_ready", eventSeq: event.seq, line: `PR ready: ${MARK} first`, taskId: WORK_TASK, runId: "r01WORKAPI" });
    }),
  );
}

function openWorkItem(text: string): string {
  return env.withDb((db) =>
    tx(db, () => {
      const event = appendEvent(db, { source: "cli", kind: "test.item", payload: {} });
      return openItem(db, { kind: "pr_ready", eventSeq: event.seq, line: `PR ready: ${MARK} ${text}`, taskId: WORK_TASK, runId: "r01WORKAPI" });
    }),
  );
}

beforeAll(async () => {
  env = await makeLeaderEnv({ extraConfig: SCOPES });
  seedWork();
}, 60_000);

afterAll(async () => {
  await env.cleanup();
  rmSync(root, { recursive: true, force: true });
});

describe("a leader per scope", () => {
  let work: Leader;
  let personal: Leader;

  test("a work and a personal leader each hold their own scope's lease", async () => {
    work = await lead("claude-work");
    personal = await lead("claude-personal");
    await work.fake.start();
    await personal.fake.start();
    const status = await daemonCall(env.h.home, "leader status", {});
    expect(status.ok).toBe(true);
    const leases = (status.data as { leases: { scope: string; session: string }[] }).leases;
    expect(leases.map((l) => [l.scope, l.session])).toEqual([
      ["personal", personal.session],
      ["work", work.session],
    ]);
  }, 60_000);

  test("the personal leader's briefing never names work; it counts what waits for the work leader", async () => {
    expect(await work.fake.saw(MARK)).toBeGreaterThan(0);
    expect(await personal.fake.saw(MARK)).toBe(0);
    expect(await personal.fake.saw("Other scope work: 1 item wait for its leader")).toBe(1);
    // Each counts only its own scope's ship in flight.
    expect(await personal.fake.saw("In flight: 1 ship, 0 scouts")).toBe(1);
  }, 30_000);

  test("a new work item rides only the work leader's digest", async () => {
    openWorkItem("second");
    await personal.fake.prompt("personal");
    await work.fake.prompt("work");
    expect(await personal.fake.saw(`${MARK} second`)).toBe(0);
    expect(await work.fake.saw(`${MARK} second`)).toBe(1);
  }, 60_000);

  test("the personal leader's commands refuse or leave out work tasks", async () => {
    const shown = await cliJson(env.h, ["show", WORK_TASK], { env: { FLOWRYN_TOKEN: personal.token } });
    expect(shown.code).toBe(77);
    expect((shown.reply.error as { code: string }).code).toBe("scope_refused");
    expect(JSON.stringify(shown.reply)).not.toContain(MARK);
    const steer = await cliJson(env.h, ["steer", WORK_TASK, "--body-file", "-"], { env: { FLOWRYN_TOKEN: personal.token }, stdin: "hello" });
    expect((steer.reply.error as { code: string }).code).toBe("scope_refused");
    for (const verb of [["fleet"], ["brief"], ["decision", "list", "--all"], ["project", "list"], ["accounts"], ["capacity"], ["stats"]]) {
      const read = await cliJson(env.h, verb, { env: { FLOWRYN_TOKEN: personal.token } });
      expect(read.code).toBe(0);
      expect(JSON.stringify(read.reply)).not.toContain(MARK);
      expect(JSON.stringify(read.reply)).not.toContain(WORK_TASK);
    }
    const workFleet = await cliJson(env.h, ["fleet"], { env: { FLOWRYN_TOKEN: work.token } });
    expect(JSON.stringify(workFleet.reply)).toContain(WORK_TASK);
    expect(JSON.stringify(workFleet.reply)).not.toContain("web-billing-q4");
    // The personal side still gets its own work (the seeded worker's project is personal).
    const personalFleet = await cliJson(env.h, ["fleet"], { env: { FLOWRYN_TOKEN: personal.token } });
    expect(JSON.stringify(personalFleet.reply)).toContain("web-billing-q4");
    const refused = env.withDb((db) => db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'leader.scope_refused'").get() as { n: number });
    expect(refused.n).toBeGreaterThanOrEqual(2);
  }, 90_000);

  test("your own terminal still sees both scopes", async () => {
    const fleet = await daemonCall(env.h.home, "fleet", {});
    expect(JSON.stringify(fleet.data)).toContain(WORK_TASK);
    expect(JSON.stringify(fleet.data)).toContain("web-billing-q4");
  }, 30_000);

  test("the folder guard: the personal leader's hook refuses a shell read of the work checkout", async () => {
    await waitFor("the scope deny lists", 10_000, () => existsSync(join(env.h.stateDir, "leader", "scope-deny", "personal.json")));
    const read = await personal.fake.runBash(`cat ${join(WORK_REPO, "README.md")}`, { approve: true });
    expect(read.denied).toBe(true);
    expect(read.stdout).not.toContain(MARK);
    const workRead = await work.fake.runBash(`cat ${join(WORK_REPO, "README.md")}`, { approve: true });
    expect(workRead.denied).toBe(false);
  }, 60_000);

  test("a leader whose transcript is under another login leads nothing and sees nothing", async () => {
    const crossed = await lead("claude-work", "claude-personal");
    await crossed.fake.start();
    expect(await crossed.fake.saw("does not match account claude-work")).toBe(1);
    expect(await crossed.fake.saw(MARK)).toBe(0);
    const row = env.withDb((db) => db.query("SELECT scope FROM leader_sessions WHERE session_id = ?1").get(crossed.session) as { scope: string });
    expect(row.scope).toBe("");
    const fleet = await cliJson(env.h, ["fleet"], { env: { FLOWRYN_TOKEN: crossed.token } });
    expect(JSON.stringify(fleet.reply)).not.toContain(WORK_TASK);
    expect(JSON.stringify(fleet.reply)).not.toContain("web-billing-q4");
    crossed.fake.kill();
  }, 60_000);

  afterAll(() => {
    work?.fake.kill();
    personal?.fake.kill();
  });
});
