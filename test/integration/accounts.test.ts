import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_VERSION, makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { quotaJson, waitUntil } from "../helpers/harness.ts";

/**
 * Accounts end to end (docs/notes/2026-10-22-multiple-ai-provider-u9.md): the
 * project "web" has an acme remote, so the [scopes.work] remote rule puts it
 * in the work scope; dispatch picks the work account, checks its login and
 * launches the worker with that login's environment.
 */

const logins = realpathSync(mkdtempSync(join(tmpdir(), "fl-logins-")));
const WORK = join(logins, "claude-work");
const WORK_SIGNED_OUT = join(logins, "claude-work-2");
const PERSONAL = join(logins, "claude-personal");
for (const dir of [WORK, WORK_SIGNED_OUT, PERSONAL]) mkdirSync(dir, { recursive: true });
afterAll(() => rmSync(logins, { recursive: true, force: true }));

const ACCOUNTS = `
[scopes]
default = "personal"
[scopes.work]
remotes = ["github.com/acme/"]
accounts = ["claude-work"]
[accounts.claude-work]
harness = "claude"
scope = "work"
config_dir = ${JSON.stringify(WORK)}
model = "opus"
[accounts.claude-work-2]
harness = "claude"
scope = "work"
config_dir = ${JSON.stringify(WORK_SIGNED_OUT)}
[accounts.claude-personal]
harness = "claude"
scope = "personal"
config_dir = ${JSON.stringify(PERSONAL)}
`;

/** A stand-in claude whose `auth status` signs in only the logins listed, and only with no inherited key in its environment. */
function signInClaude(env: FleetEnv, signedIn: string[]): void {
  const path = join(env.h.home, "bin", "claude");
  const cases = signedIn.map((dir) => `  ${JSON.stringify(dir)}) echo '{"loggedIn":true}'; exit 0 ;;`).join("\n");
  const script = `#!/bin/sh
if [ "$1" = "auth" ]; then
  [ -n "$ANTHROPIC_API_KEY" ] && { echo '{"loggedIn":true,"authMethod":"api-key"}'; exit 0; }
  case "$CLAUDE_CONFIG_DIR" in
${cases}
  esac
  echo '{"loggedIn":false}'; exit 1
fi
echo "${FAKE_VERSION} (fake claude)"
`;
  writeFileSync(`${path}.new`, script);
  chmodSync(`${path}.new`, 0o755);
  renameSync(`${path}.new`, path);
}

const envs: FleetEnv[] = [];
afterEach(async () => {
  for (const env of envs.splice(0)) await env.cleanup();
});

const FAST = "[sched]\npass_ms = 250\nquota_cache_ms = 300";

async function accountsFleet(extra = "", signedIn = [WORK, PERSONAL], accounts = ACCOUNTS): Promise<FleetEnv> {
  // An inherited key in the daemon's environment must not answer for any account's login.
  const env = await makeFleetEnv({ origin: true, extraConfig: `${accounts}\n${extra}`, daemonEnv: { ANTHROPIC_API_KEY: "sk-inherited" } });
  envs.push(env);
  signInClaude(env, signedIn);
  return env;
}

function one<T>(env: FleetEnv, sql: string): T | null {
  const db = env.h.db();
  try {
    return db.query(sql).get() as T | null;
  } finally {
    db.close();
  }
}

const openItem = (env: FleetEnv, kind: string) => one<{ line: string }>(env, `SELECT line FROM items WHERE kind = '${kind}' AND state IN ('open','presented')`);

async function dispatchOn(env: FleetEnv, account: string | null, body: string): Promise<string> {
  const sent = await env.json(["dispatch", "web", "--kind", "scout", ...(account ? ["--account", account] : []), "--body-file", "-"], { stdin: body });
  if (sent.code !== 0) throw new Error(`dispatch failed: ${JSON.stringify(sent.reply)}`);
  return (sent.reply.data as { run: string }).run;
}

function runCount(env: FleetEnv): number {
  const db = env.h.db();
  try {
    return (db.query("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe("accounts", () => {
  test("a work project runs on the work account's login, with the credentials that outrank it unset", async () => {
    const env = await accountsFleet();
    const sent = await env.json(["dispatch", "web", "--kind", "scout", "--body-file", "-"], { stdin: "look around\nFAKE: sleep 60000" });
    expect(sent.code).toBe(0);
    const { run: runId } = sent.reply.data as { run: string };
    expect(sent.reply.data).toMatchObject({ account: "claude-work" });
    const run = await env.waitRun(runId, (r) => r.pane_id !== null && r.proc_pid !== null, "the worker launched");
    expect(run).toMatchObject({ account: "claude-work", model: "opus" });
    const pane = env.herdr.panes.get(run.pane_id!)!;
    expect(pane.env.CLAUDE_CONFIG_DIR).toBe(WORK);
    expect(pane.env.FLOWRYN_UNSET!.split(" ")).toContain("ANTHROPIC_API_KEY");
    expect(pane.args).toContain("opus");

    const db = env.h.db();
    const event = db.query("SELECT payload FROM events WHERE kind = 'run.dispatched' AND run_id = ?1").get(runId) as { payload: string };
    db.close();
    expect(JSON.parse(event.payload)).toMatchObject({ account: "claude-work", scope: "work" });

    const shown = await env.json(["show", (sent.reply.data as { task: string }).task]);
    expect(shown.reply.data).toMatchObject({ account: "claude-work" });

    const listed = await env.json(["accounts"]);
    expect(listed.code).toBe(0);
    const data = listed.reply.data as { projects: { project: string; scope: string; account: string }[]; accounts: { account: string; open_runs: number }[] };
    expect(data.projects).toEqual([{ project: "web", scope: "work", account: "claude-work" }]);
    expect(data.accounts.find((a) => a.account === "claude-work")?.open_runs).toBe(1);
  });

  test("a work project never starts on the personal account, whatever the dispatch asks", async () => {
    const env = await accountsFleet();
    const refused = await env.json(["dispatch", "web", "--kind", "scout", "--account", "claude-personal", "--body-file", "-"], { stdin: "x" });
    expect(refused.code).toBe(2);
    expect(JSON.stringify(refused.reply)).toContain("account_scope_mismatch");
    expect(runCount(env)).toBe(0);
    // Nor through a plan phase's account: line, refused when the plan is filed.
    const plan = await env.json(["plan", "web", "--body-file", "-"], { stdin: "## Phase 1: one\naccount: claude-personal\ndo it\n" });
    expect(plan.code).toBe(2);
    expect(JSON.stringify(plan.reply)).toContain("account_scope_mismatch");
  });

  test("a signed-out account's run waits with a P1 naming the login command, and starts once it is signed in", async () => {
    const env = await accountsFleet(FAST);
    const sent = await env.json(["dispatch", "web", "--kind", "scout", "--account", "claude-work-2", "--body-file", "-"], { stdin: "x\nFAKE: sleep 60000" });
    expect(sent.code).toBe(0);
    const { run: runId } = sent.reply.data as { run: string };
    await waitUntil(() => openItem(env, "account_signed_out") !== null, 15_000, "the signed-out P1");
    expect(openItem(env, "account_signed_out")!.line).toContain(`CLAUDE_CONFIG_DIR=${WORK_SIGNED_OUT} claude, then /login`);
    expect(env.run(runId).proc_pid).toBeNull();
    expect(JSON.stringify((await env.json(["capacity"])).reply.data)).toContain("claude-work-2 signed out");
    signInClaude(env, [WORK, PERSONAL, WORK_SIGNED_OUT]);
    await env.waitRun(runId, (r) => r.proc_pid !== null, "the worker once its account is signed in");
    expect(openItem(env, "account_signed_out")).toBeNull();
  });

  test("a usage limit on one account holds only that account's runs", async () => {
    const env = await accountsFleet(FAST, [WORK, PERSONAL, WORK_SIGNED_OUT]);
    const limited = await dispatchOn(env, "claude-work", "Hits the limit\nFAKE: usage-limit\nFAKE: sleep 60000");
    await waitUntil(() => openItem(env, "usage_limit") !== null, 15_000, "the usage pause");
    expect(one<{ task_id: string }>(env, "SELECT task_id FROM items WHERE kind = 'usage_limit'")!.task_id).toBe("account:claude-work");
    const held = await dispatchOn(env, "claude-work", "Waits\nFAKE: sleep 60000");
    const other = await dispatchOn(env, "claude-work-2", "Carries on\nFAKE: sleep 60000");
    await env.waitRun(other, (r) => r.proc_pid !== null, "the run on the other account");
    await Bun.sleep(1_000);
    expect(env.run(held).proc_pid).toBeNull();
    const view = await env.json(["capacity"]);
    expect(JSON.stringify(view.reply.data)).toContain("claude-work usage limit");
    expect(view.reply.hints).toContain("flowryn capacity resume --account claude-work");
    expect(env.run(limited).account).toBe("claude-work");
  });

  test("a low quota moves a fresh launch to the overflow account; flowryn accounts shows each account's quota", async () => {
    const overflow = ACCOUNTS.replace('model = "opus"', 'model = "opus"\noverflow = ["claude-work-2"]');
    const env = await accountsFleet(FAST, [WORK, PERSONAL, WORK_SIGNED_OUT], overflow);
    writeFileSync(join(env.h.home, "quota-claude-work.json"), quotaJson(2));
    const runId = await dispatchOn(env, null, "Overflows\nFAKE: sleep 60000");
    const run = await env.waitRun(runId, (r) => r.proc_pid !== null, "the overflowed worker");
    expect(run).toMatchObject({ account: "claude-work-2" });
    expect(env.herdr.panes.get(run.pane_id!)!.env.CLAUDE_CONFIG_DIR).toBe(WORK_SIGNED_OUT);
    const moved = JSON.parse(one<{ payload: string }>(env, "SELECT payload FROM events WHERE kind = 'sched.overflow'")!.payload) as Record<string, string>;
    expect(moved).toMatchObject({ from: "claude-work", to: "claude-work-2", why: "capacity.quota_floor" });
    // One probe per account, each pointed at its own login.
    const calls = readFileSync(join(env.h.home, "quota-calls.log"), "utf8");
    expect(calls).toContain(`dir=${WORK}`);
    expect(calls).toContain(`dir=${WORK_SIGNED_OUT}`);
    const listed = (await env.json(["accounts"])).reply.data as { accounts: { account: string; quota: string; usage: string; overflow: string }[] };
    const byId = Object.fromEntries(listed.accounts.map((a) => [a.account, a]));
    expect(byId["claude-work"]).toMatchObject({ quota: "low 2% (floor 5%)", usage: "-", overflow: "claude-work-2" });
    expect(byId["claude-work-2"]!.quota).toMatch(/^ok 80% at \d\d:\d\d$/);
    expect(byId["claude-personal"]).toMatchObject({ quota: "not read yet", overflow: "-" });
    expect(byId.pi!.quota).toBe("unknown (account pi names no Pi provider)");
  });

  test("a ready plan phase on a held account starts on its overflow account", async () => {
    const overflow = ACCOUNTS.replace('model = "opus"', 'model = "opus"\noverflow = ["claude-work-2"]');
    const env = await accountsFleet(FAST, [WORK, PERSONAL, WORK_SIGNED_OUT], overflow);
    writeFileSync(join(env.h.home, "quota-claude-work.json"), quotaJson(1));
    expect((await env.json(["project", "set", "web", "--autonomy", "manual"])).code).toBe(0);
    const filed = await env.json(["plan", "web", "--body-file", "-"], { stdin: "# One step\n## Phase 1: Only\nFAKE: sleep 60000\n" });
    expect(filed.code).toBe(0);
    const task = (filed.reply.data as { phases: { task: string }[] }).phases[0]!.task;
    expect((await env.json(["project", "set", "web", "--autonomy", "plan"])).code).toBe(0);
    await waitUntil(() => one(env, `SELECT 1 FROM runs WHERE task_id = '${task}'`) !== null, 20_000, "the phase's run");
    expect(one<{ account: string; model: string | null }>(env, `SELECT account, model FROM runs WHERE task_id = '${task}'`)).toEqual({ account: "claude-work-2", model: null });
    const moved = JSON.parse(one<{ payload: string }>(env, "SELECT payload FROM events WHERE kind = 'sched.overflow'")!.payload) as Record<string, string>;
    expect(moved).toMatchObject({ from: "claude-work", to: "claude-work-2", at: "phase start" });
  });
});
