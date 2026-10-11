/**
 * The toolkit rules (src/policy/toolkit.ts) through the real hooks: a Claude
 * worker's `flowryn hook pre-tool`, a Pi worker's `flowryn hook tool-check`,
 * a Claude leader's PreToolUse and the real Pi leader extension. One raw
 * command per rule is denied with a reason naming the right tool, the daemon
 * records toolkit.denied, and with the daemon unreachable the denial holds.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";

const envs: FleetEnv[] = [];
let ship: ShipEnv | null = null;
afterEach(async () => {
  for (const env of envs.splice(0)) await env.cleanup();
  await ship?.cleanup();
  ship = null;
});

async function fleet(): Promise<FleetEnv> {
  const env = await makeFleetEnv();
  envs.push(env);
  return env;
}

/** A dispatched worker that sends no hooks of its own: the test plays its harness's hooks with the run's token. */
async function worker(env: FleetEnv, harness: "claude" | "pi" = "claude"): Promise<{ run: string; token: string }> {
  const { run } = await env.dispatch("Build\nFAKE: no-start", { harness });
  const launched = await env.waitRun(run, (r) => r.pane_id !== null && r.proc_pid !== null, "launched");
  return { run, token: env.herdr.panes.get(launched.pane_id!)!.env.FLOWRYN_TOKEN! };
}

interface Decision {
  permissionDecision: string;
  permissionDecisionReason: string;
}

async function preTool(env: FleetEnv, token: string, toolName: string, toolInput: Record<string, unknown>, extraEnv: Record<string, string> = {}): Promise<Decision | null> {
  const input = { tool_name: toolName, tool_input: toolInput, tool_use_id: `toolu_${crypto.randomUUID().slice(0, 8)}`, cwd: env.repo };
  const result = await env.cli(["hook", "pre-tool", "--harness", "claude"], { env: { FLOWRYN_TOKEN: token, ...extraEnv }, stdin: JSON.stringify(input) });
  expect(result.code).toBe(0);
  const out = result.stdout.trim();
  return out ? (JSON.parse(out) as { hookSpecificOutput: Decision }).hookSpecificOutput : null;
}

function denials(env: FleetEnv, where: { run?: string } = {}): Record<string, unknown>[] {
  const db = env.h.db();
  try {
    const rows = (where.run ? db.query("SELECT payload FROM events WHERE kind = 'toolkit.denied' AND run_id = ?1 ORDER BY seq").all(where.run) : db.query("SELECT payload FROM events WHERE kind = 'toolkit.denied' ORDER BY seq").all()) as { payload: string }[];
    return rows.map((r) => JSON.parse(r.payload) as Record<string, unknown>);
  } finally {
    db.close();
  }
}

describe("a Claude worker: one raw call per rule is denied through the real pre-tool hook", () => {
  test("each rule denies with a reason naming its tool, and records toolkit.denied", async () => {
    const env = await fleet();
    const { run, token } = await worker(env);
    const cases: { rule: string; tool: string; name: string; input: Record<string, unknown> }[] = [
      { rule: "github", tool: "gh-axi", name: "Bash", input: { command: "gh pr list" } },
      { rule: "sqlite", tool: "sqlite-axi", name: "Bash", input: { command: "sqlite3 app.db 'select * from users'" } },
      { rule: "worktree", tool: "treehouse", name: "Bash", input: { command: "git worktree add ../other -b other" } },
      { rule: "jira", tool: "jira-axi", name: "Bash", input: { command: "curl https://acme.atlassian.net/rest/api/3/issue/X-1" } },
      { rule: "browser", tool: "chrome-devtools-axi", name: "mcp__claude-in-chrome__navigate", input: { url: "https://x" } },
      { rule: "tasks", tool: "tasks-axi", name: "Edit", input: { file_path: join(env.repo, "backlog.md"), old_string: "a", new_string: "b" } },
      { rule: "flowryn-tasks", tool: "flowryn", name: "Bash", input: { command: `echo '- [ ] x' >> ${env.h.backlog}` } },
    ];
    for (const c of cases) {
      const decision = await preTool(env, token, c.name, c.input);
      expect(decision, c.rule).toMatchObject({ permissionDecision: "deny" });
      expect(decision!.permissionDecisionReason, c.rule).toContain(`toolkit rule (${c.rule})`);
      expect(decision!.permissionDecisionReason, c.rule).toContain(c.tool);
    }
    expect(denials(env, { run }).map((d) => d.rule)).toEqual(cases.map((c) => c.rule));
    // The event names the rule and the tool, never the command.
    expect(denials(env, { run })[0]).toEqual({ rule: "github", use: "gh-axi", tool_name: "Bash", harness: "claude" });
    expect(JSON.stringify(denials(env, { run }))).not.toContain("gh pr list");
    // An allowed call is untouched.
    expect(await preTool(env, token, "Bash", { command: "gh-axi pr list && git status" })).toBeNull();
  }, 60_000);

  test("the daemon down: the hook process still denies (no daemon call needed)", async () => {
    const env = await fleet();
    const { token } = await worker(env);
    const down = { FLOWRYN_SOCK: join(env.h.home, "run", "missing.sock") };
    const decision = await preTool(env, token, "Bash", { command: "env FOO=1 /opt/homebrew/bin/gh pr view 1" }, down);
    expect(decision).toMatchObject({ permissionDecision: "deny" });
    expect(decision!.permissionDecisionReason).toContain("gh-axi");
    // And an allowed call still steps aside quietly, as every hook does with the daemon down.
    expect(await preTool(env, token, "Bash", { command: "ls" }, down)).toBeNull();
  }, 60_000);

  test("an urgent steer due and a toolkit denial: one deny that carries the steer first", async () => {
    const env = await fleet();
    const { run, token } = await worker(env);
    await env.cli(["hook", "prompt", "--harness", "claude"], { env: { FLOWRYN_TOKEN: token }, stdin: "{}" });
    const steered = await env.json(["steer", run, "--urgent", "--body-file", "-"], { stdin: "stop the migration" });
    const id = String((steered.reply.data as { steer: string }).steer);
    const decision = await preTool(env, token, "Bash", { command: "gh pr list" });
    expect(decision!.permissionDecisionReason).toStartWith(`Flowryn steer [${id}]: stop the migration`);
    expect(decision!.permissionDecisionReason).toContain("toolkit rule (github)");
  }, 60_000);
});

describe("a Pi worker: hook tool-check", () => {
  test("denies a raw call with {block, reason} and records it; an allowed call gets {}", async () => {
    const env = await fleet();
    const { run, token } = await worker(env, "pi");
    const check = async (toolName: string, toolInput: Record<string, unknown>, extraEnv: Record<string, string> = {}) => {
      const result = await env.cli(["hook", "tool-check", "--harness", "pi"], { env: { FLOWRYN_TOKEN: token, ...extraEnv }, stdin: JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd: env.repo }) });
      expect(result.code).toBe(0);
      return JSON.parse(result.stdout.trim()) as { block?: boolean; reason?: string; rule?: string };
    };
    expect(await check("bash", { command: "bash -c 'gh pr list'" })).toMatchObject({ block: true, rule: "github" });
    // Pi's edit and write name the file `path` (Claude's name it file_path).
    expect(await check("write", { path: "todos.md", content: "x" })).toMatchObject({ block: true, rule: "tasks" });
    expect(await check("bash", { command: "npx playwright test" })).toEqual({});
    expect(denials(env, { run })).toEqual([
      { rule: "github", use: "gh-axi", tool_name: "bash", harness: "pi" },
      { rule: "tasks", use: "tasks-axi", tool_name: "write", harness: "pi" },
    ]);
    expect(await check("bash", { command: "gh pr list" }, { FLOWRYN_SOCK: join(env.h.home, "run", "missing.sock") })).toMatchObject({ block: true, rule: "github" });
  }, 60_000);
});

describe("leaders", () => {
  test("Claude: the leader's PreToolUse denies a raw call; nothing is gated or recorded as an attempt", async () => {
    ship = await makeShipEnv({ mode: "local-only" });
    const leader = await ship.claude();
    await leader.start();
    const denied = await leader.runBash("gh pr merge 1", { approve: true });
    expect(denied).toMatchObject({ denied: true, ran: false });
    const rows = denials(ship.fleet);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rule: "github", tool_name: "Bash", harness: "claude" });
    expect(typeof rows[0]!.session).toBe("string");
    const db = ship.fleet.h.db();
    try {
      expect((db.query("SELECT COUNT(*) AS n FROM approval_attempts").get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
  }, 60_000);

  test("Pi: the real leader extension blocks a raw call and the shell gate through hook tool-check", async () => {
    ship = await makeShipEnv({ mode: "local-only" });
    const leader = await ship.pi();
    await leader.start();
    const gh = await leader.bash("gh pr list");
    expect(gh.blocked).toBe(true);
    expect(gh.reason).toContain("gh-axi");
    const merge = await leader.bash("flowryn merge t1");
    expect(merge.blocked).toBe(true);
    expect(merge.reason).toContain("flowryn_merge");
    const repin = await leader.bash("flowryn leader repin");
    expect(repin.blocked).toBe(true);
    expect(repin.reason).toContain("leader repin is the user's own terminal");
    expect((await leader.bash("echo fine")).blocked).toBe(false);
    expect(denials(ship.fleet).map((d) => d.rule)).toEqual(["github", "leader-shell", "leader-shell"]);
  }, 60_000);
});
