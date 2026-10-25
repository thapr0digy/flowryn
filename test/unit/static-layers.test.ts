import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, TOOL_BINARIES, TOOL_NAMES, type FlowrynConfig, type ToolName } from "../../src/config/config.ts";
import { leaderSettings, LEADER_PERMISSIONS } from "../../src/bridges/claude/settings.ts";
import { workerSettings } from "../../src/harness/claude/adapter.ts";
import { configStaticLayers, DENIED_MCP_SERVERS, staticLayers } from "../../src/policy/static.ts";
import { chromeEnabled, contractSteps, hiddenToolsVerdict, offeredTools } from "../../src/contracts/suite.ts";
import { chromeMcpCheck, toolChecks } from "../../src/doctor/doctor.ts";
import { INSTALL_HINTS, INSTALLERS } from "../../src/init/install.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fw-static-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PATHS = { backlog: "/h/data/backlog.md", todos: "/h/data/todos.md", db: "/h/state/flowryn.db" };

/** Claude's prefix match for a `Bash(<prefix> *)` rule, as verified live: the bare command or the command and a space. */
function bashRuleMatches(rule: string, command: string): boolean {
  const prefix = /^Bash\((.*) \*\)$/.exec(rule)?.[1];
  return prefix !== undefined && (command === prefix || command.startsWith(`${prefix} `));
}

describe("the toolkit's static layers", () => {
  const layers = staticLayers(PATHS);

  test("hide the denied MCP servers by bare name", () => {
    for (const server of ["mcp__claude-in-chrome", "mcp__claude_ai_Atlassian_MCP", "mcp__plugin_atlassian_atlassian", "mcp__atlassian"]) {
      expect(layers.permissionsDeny).toContain(server);
    }
    // A bare name, never a scoped `mcp__srv__tool`: only a bare name hides the tools.
    for (const server of DENIED_MCP_SERVERS) expect(server.slice(5)).not.toContain("__");
  });

  test("back the hook up for raw gh, worktree changes and acli jira, and never catch the axi tools", () => {
    const bash = layers.permissionsDeny.filter((rule) => rule.startsWith("Bash("));
    const denied = (command: string) => bash.some((rule) => bashRuleMatches(rule, command));
    for (const command of ["gh", "gh pr list", "hub pr", "git worktree add ../x", "git worktree prune", "acli jira workitem view X-1"]) expect(denied(command)).toBe(true);
    for (const command of ["gh-axi pr list", "git worktree list", "treehouse get --lease --json", "jira-axi issue view X-1", "acli --help"]) expect(denied(command)).toBe(false);
  });

  test("q31: no blanket sqlite3 deny, only Flowryn's own database", () => {
    expect(layers.permissionsDeny.filter((rule) => rule.startsWith("Bash(sqlite3"))).toEqual(["Bash(sqlite3 *flowryn.db*)"]);
  });

  test("deny editing Flowryn's backlog and to-dos by absolute path, and writing them and their locks in the sandbox", () => {
    expect(layers.permissionsDeny).toContain("Edit(//h/data/backlog.md)");
    expect(layers.permissionsDeny).toContain("Edit(//h/data/todos.md)");
    expect(layers.denyWrite).toEqual(["/h/data/backlog.md", "/h/data/todos.md", "/h/data/backlog.md.lock", "/h/data/todos.md.lock"]);
  });

  test("come from the config's own [tasks] and state_dir", () => {
    const config = { ...defaultConfig("/h"), tasks: { backlog: "/elsewhere/b.md", todos: "/elsewhere/t.md" } };
    const built = configStaticLayers(config);
    expect(built.permissionsDeny).toContain("Edit(//elsewhere/b.md)");
    expect(built.denyWrite[0]).toBe("/elsewhere/b.md");
  });

  test("the worker settings carry them: permissions.deny, and denyWrite beside the git paths", () => {
    const settings = workerSettings("/bin/flowryn", { socket: "/h/run/s.sock", writable: ["/h/spool"], readOnly: ["/repo/.git/hooks", ...layers.denyWrite], deny: layers.permissionsDeny }) as {
      permissions: { deny: string[] };
      sandbox: { filesystem: { denyWrite: string[] } };
    };
    expect(settings.permissions.deny).toEqual(layers.permissionsDeny);
    expect(settings.sandbox.filesystem.denyWrite).toEqual(["/repo/.git/hooks", ...layers.denyWrite]);
  });

  test("the leader settings append them to the leader's own denies and add the sandbox denyWrite", () => {
    const settings = leaderSettings({ bin: "/bin/flowryn", socket: "/h/run/s.sock", toolkit: layers }) as {
      permissions: { deny: string[] };
      sandbox: { network: { allowUnixSockets: string[] }; filesystem: { denyWrite: string[] } };
    };
    expect(settings.permissions.deny).toEqual([...LEADER_PERMISSIONS.deny, ...layers.permissionsDeny]);
    expect(settings.sandbox.filesystem.denyWrite).toEqual(layers.denyWrite);
    expect(settings.sandbox.network.allowUnixSockets).toEqual(["/h/run/s.sock"]);
  });
});

describe("the toolkit contract step", () => {
  test("runs for Claude only, after the interrupt and before the temp dir check and the exit", () => {
    const claude = contractSteps("claude").map((s) => s.name);
    expect(claude.slice(claude.indexOf("interrupt"), claude.indexOf("exit") + 1)).toEqual(["interrupt", "toolkit", "temp dir", "exit"]);
    expect(contractSteps("pi").map((s) => s.name)).not.toContain("toolkit");
  });

  const transcript = [
    JSON.stringify({ type: "user", message: "hi" }),
    JSON.stringify({ type: "attachment", attachment: { type: "deferred_tools_delta", addedNames: ["WebFetch", "mcp__x__y"], readdedNames: ["Monitor"] } }),
    JSON.stringify({ type: "attachment", attachment: { type: "deferred_tools_record", entries: [] } }),
    '{"type":"attachment","attachment":{"type":"deferred_tools_delta","addedNames":["torn',
  ].join("\n");

  test("reads the offered tools from the transcript's deferred_tools_delta records, past a torn line", () => {
    expect(offeredTools(transcript).toSorted()).toEqual(["Monitor", "WebFetch", "mcp__x__y"]);
    expect(offeredTools("")).toEqual([]);
  });

  test("fails when claude-in-chrome was offered, whatever the config says", () => {
    for (const enabled of [true, false]) expect(hiddenToolsVerdict(["WebFetch", "mcp__claude-in-chrome__navigate"], enabled).error).toContain("claude-in-chrome");
  });

  test("A6: fails when claude-in-chrome is enabled and the transcript lists no tools, so a changed record cannot pass silently", () => {
    expect(hiddenToolsVerdict([], true).error).toContain("no deferred tools");
  });

  test("passes, saying so, when claude-in-chrome is not enabled; passes when it is enabled and hidden", () => {
    expect(hiddenToolsVerdict([], false)).toEqual({ error: null, detail: expect.stringContaining("not enabled") });
    expect(hiddenToolsVerdict(["WebFetch", "Monitor"], true)).toEqual({ error: null, detail: "none of its 2 deferred tools is claude-in-chrome" });
  });

  test("reads claudeInChromeDefaultEnabled from the worker's .claude.json", () => {
    const store = tempDir();
    expect(chromeEnabled(store)).toBe(false);
    writeFileSync(join(store, ".claude.json"), JSON.stringify({ claudeInChromeDefaultEnabled: true }));
    expect(chromeEnabled(store)).toBe(true);
    writeFileSync(join(store, ".claude.json"), "{not json");
    expect(chromeEnabled(store)).toBe(false);
  });
});

describe("the toolkit's tools", () => {
  test("each has a binary, an install hint, and the offer covers the axi tools, acli and treehouse only", () => {
    for (const name of ["gh_axi", "jira_axi", "acli", "chrome_devtools_axi", "sqlite_axi", "quota_axi", "treehouse"] as ToolName[]) {
      expect(TOOL_NAMES).toContain(name);
      expect(TOOL_BINARIES[name].length).toBeGreaterThan(0);
      expect(INSTALLERS[name]).toBeDefined();
    }
    for (const name of TOOL_NAMES) expect(INSTALL_HINTS[name].length).toBeGreaterThan(0);
    for (const name of ["node", "git", "gh", "herdr", "claude", "pi", "no_mistakes", "docker"] as ToolName[]) expect(INSTALLERS[name]).toBeUndefined();
    expect(INSTALLERS.chrome_devtools_axi!.steps[0]).toContain("chrome-devtools-mcp");
  });

  /** A config whose recorded tools are real executables in a temp dir (doctor checks they exist). */
  function configWith(names: ToolName[], extra: Record<string, unknown> = {}): FlowrynConfig {
    const bin = tempDir();
    const tools: Partial<Record<ToolName, string>> = {};
    for (const name of names) {
      const path = join(bin, name);
      writeFileSync(path, "#!/bin/sh\n");
      chmodSync(path, 0o755);
      tools[name] = path;
    }
    return { ...defaultConfig(tempDir()), tools, extra };
  }

  function lineFor(config: FlowrynConfig, name: ToolName) {
    return toolChecks(config, () => null).find((c) => c.check === `tool ${name}`)!;
  }

  test("doctor (Q6): a missing gh-axi warns, with the install command", () => {
    expect(lineFor(configWith([]), "gh_axi")).toEqual({ check: "tool gh_axi", status: "warn", detail: expect.stringContaining("Install: npm install -g gh-axi") });
  });

  test("doctor (Q6): chrome-devtools-axi warns while a workflow runs a browser stage (feature-ui by default)", () => {
    expect(lineFor(configWith([]), "chrome_devtools_axi").status).toBe("warn");
  });

  test("doctor (Q6): acli warns only once jira-axi is installed", () => {
    expect(lineFor(configWith([]), "acli").status).toBe("info");
    expect(lineFor(configWith(["jira_axi"]), "acli")).toMatchObject({ status: "warn", detail: expect.stringContaining("jira-axi runs it") });
  });

  test("doctor (Q6): the rest are info, with the same hint as init", () => {
    for (const name of ["jira_axi", "sqlite_axi", "treehouse"] as ToolName[]) {
      expect(lineFor(configWith([]), name)).toEqual({ check: `tool ${name}`, status: "info", detail: expect.stringContaining(`Install: ${INSTALL_HINTS[name]}`) });
    }
  });

  test("doctor: a missing quota-axi warns while the quota floor is on (the default), and is info with floor = 0", () => {
    expect(lineFor(configWith([]), "quota_axi")).toEqual({ check: "tool quota_axi", status: "warn", detail: expect.stringContaining(`Install: ${INSTALL_HINTS.quota_axi}`) });
    expect(lineFor(configWith([], { capacity: { quota: { floor: 0 } } }), "quota_axi").status).toBe("info");
  });

  test("doctor suggests a global chrome-devtools-mcp only when chrome-devtools-axi is there without one", () => {
    const none = () => null;
    expect(chromeMcpCheck(configWith([]), {}, none)).toBeNull();
    const installed = configWith(["chrome_devtools_axi"]);
    expect(chromeMcpCheck(installed, {}, none)).toMatchObject({ status: "info", detail: expect.stringContaining("npm install -g chrome-devtools-mcp") });
    expect(chromeMcpCheck(installed, { CHROME_DEVTOOLS_AXI_MCP_PATH: "/x/mcp.js" }, none)).toBeNull();
    expect(chromeMcpCheck(installed, {}, (b) => (b === "chrome-devtools-mcp" ? "/opt/bin/chrome-devtools-mcp" : null))).toBeNull();
  });
});
