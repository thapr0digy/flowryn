import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_VERSION, makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";

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

async function accountsFleet(): Promise<FleetEnv> {
  // An inherited key in the daemon's environment must not answer for any account's login.
  const env = await makeFleetEnv({ origin: true, extraConfig: ACCOUNTS, daemonEnv: { ANTHROPIC_API_KEY: "sk-inherited" } });
  envs.push(env);
  signInClaude(env, [WORK, PERSONAL]);
  return env;
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

  test("a signed-out account refuses at dispatch and says how to sign in", async () => {
    const env = await accountsFleet();
    const refused = await env.json(["dispatch", "web", "--kind", "scout", "--account", "claude-work-2", "--body-file", "-"], { stdin: "x" });
    expect(refused.code).toBe(69);
    expect(JSON.stringify(refused.reply)).toContain(`CLAUDE_CONFIG_DIR=${WORK_SIGNED_OUT} claude, then /login`);
    expect(runCount(env)).toBe(0);
  });
});
