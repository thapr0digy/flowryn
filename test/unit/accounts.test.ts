import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { FlowrynError } from "../../src/api/errors.ts";
import { accountById, accountsConfig, normalizeRemote, projectScope, resolveAccount, runAccount, workersFor, type ScopedProject } from "../../src/config/accounts.ts";
import { parseConfig } from "../../src/config/config.ts";
import { workersConfig } from "../../src/config/workers.ts";
import { claudeAdapter, loginEnv } from "../../src/harness/claude/adapter.ts";
import { loadExtensionSource, piAdapter } from "../../src/harness/pi/adapter.ts";
import { accountSignIn } from "../../src/harness/sign-in.ts";
import type { RunContext } from "../../src/harness/types.ts";
import { shimScript } from "../../src/lifecycle/launcher.ts";
import { migrate, openDb } from "../../src/db/db.ts";
import { checkPhaseAccounts, fileWorkerPlan, parsePlan, phasesOf, recordPlan } from "../../src/lifecycle/plans.ts";
import { insertProject, type ProjectRow } from "../../src/lifecycle/projects.ts";
import { promotedAccount } from "../../src/lifecycle/promote.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "fl-accounts-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const HOME = join(root, "home");
const WORK = join(root, "work");
const PERSONAL = join(root, "code");
mkdirSync(join(WORK, "acme-api"), { recursive: true });
mkdirSync(join(PERSONAL, "site"), { recursive: true });

function config(text: string) {
  return parseConfig(text, HOME);
}

function project(id: string, path: string, repo_url = "", harness: "claude" | "pi" = "claude"): ScopedProject {
  return { id, path, repo_url, harness };
}

const TWO_SCOPES = `
[workers.claude]
model = "sonnet"
effort = "medium"

[scopes]
default = "personal"

[scopes.work]
paths = [${JSON.stringify(WORK)}]
remotes = ["github.com/acme/"]
accounts = ["claude-work"]

[scopes.personal]
accounts = ["claude-personal", "chatgpt"]

[accounts.claude-work]
harness = "claude"
scope = "work"
config_dir = "~/.claude-work"
model = "opus"

[accounts.claude-personal]
harness = "claude"
scope = "personal"

[accounts.chatgpt]
harness = "pi"
scope = "personal"
provider = "openai-codex"
model = "openai-codex/gpt-5-codex"
`;

function refusal(fn: () => unknown): FlowrynError {
  try {
    fn();
  } catch (error) {
    if (error instanceof FlowrynError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("accounts config", () => {
  test("no [accounts] is one implicit account per harness, from [workers.*], in the default scope", () => {
    const c = config(`[workers.claude]\nmodel = "opus"\nconfig_dir = "/x/claude"\n[workers.pi]\nagent_dir = "/x/pi"\n`);
    const a = accountsConfig(c);
    expect(a.default_scope).toBe("default");
    expect(a.accounts.claude).toMatchObject({ harness: "claude", scope: "default", config_dir: "/x/claude", model: "opus", declared: false });
    expect(a.accounts.pi).toMatchObject({ harness: "pi", scope: "default", agent_dir: "/x/pi", provider: null, declared: false });
    expect(resolveAccount(c, project("site", join(PERSONAL, "site"))).id).toBe("claude");
    expect(resolveAccount(c, project("site", join(PERSONAL, "site")), { harness: "pi" }).id).toBe("pi");
  });

  test("an implicit account launches exactly as [workers] did before accounts", () => {
    const c = config(`[workers.claude]\nmodel = "opus"\n`);
    const workers = workersConfig(c);
    expect(workersFor(workers, accountById(c, "claude"))).toEqual(workers);
    expect(loginEnv(workers.claude)).toEqual({});
  });

  test("declared accounts inherit model and effort from [workers.*], never the login", () => {
    const c = config(`[workers.claude]\nmodel = "sonnet"\neffort = "low"\nconfig_dir = "/x/work"\n[accounts.mine]\nharness = "claude"\n`);
    expect(accountById(c, "mine")).toMatchObject({ model: "sonnet", effort: "low", config_dir: null, declared: true });
  });

  test("a harness with no declared account keeps its implicit one", () => {
    const a = accountsConfig(config(`[accounts.mine]\nharness = "claude"\n`));
    expect(Object.keys(a.accounts).sort()).toEqual(["mine", "pi"]);
  });

  test.each([
    [`[accounts.x]\nharness = "claude"\ncolour = "red"\n`, "colour is not a known setting"],
    [`[accounts.x]\nharness = "codex"\n`, "harness must be one of claude, pi"],
    [`[accounts.X]\nharness = "claude"\n`, "is not an id"],
    [`[accounts.pi]\nharness = "claude"\n`, "an account named pi must be a pi account"],
    [`[accounts.x]\nharness = "claude"\nagent_dir = "/p"\n`, "agent_dir and provider are Pi settings"],
    [`[accounts.x]\nharness = "pi"\nmodel = "openai-codex/m"\n`, "provider must name the Pi provider"],
    [`[accounts.x]\nharness = "pi"\nprovider = "openai-codex"\nmodel = "anthropic/m"\n`, "model must be openai-codex/<model id>"],
    [`[accounts.x]\nharness = "claude"\nscope = "work"\n`, "scope work is not a scope"],
    [`[scopes.work]\naccounts = ["nobody"]\n`, "no account nobody"],
    [`[scopes.work]\naccounts = ["x"]\n[accounts.x]\nharness = "claude"\n`, "x belongs to scope default"],
    [`[scopes.work]\nflavour = 1\n`, "flavour is not a known setting"],
  ])("refuses %#", (text, message) => {
    expect(refusal(() => accountsConfig(config(text))).message).toContain(message);
  });
});

describe("project scope", () => {
  const c = config(TWO_SCOPES);
  const a = accountsConfig(c);

  test("a checkout under a scope's path is in that scope; elsewhere the default", () => {
    expect(projectScope(c, a, project("api", join(WORK, "acme-api")))).toBe("work");
    expect(projectScope(c, a, project("site", join(PERSONAL, "site")))).toBe("personal");
    // A path that only starts with the prefix's text is not under it.
    expect(projectScope(c, a, project("w2", `${WORK}-other`))).toBe("personal");
  });

  test("a remote under a scope's remote prefix is in that scope, whatever its URL form", () => {
    for (const url of ["git@github.com:acme/tool.git", "https://github.com/acme/tool", "ssh://git@GitHub.com/acme/tool.git"]) {
      expect(projectScope(c, a, project("tool", join(PERSONAL, "site"), url))).toBe("work");
    }
    expect(projectScope(c, a, project("tool", join(PERSONAL, "site"), "https://github.com/acme-other/tool"))).toBe("personal");
    expect(normalizeRemote("git@github.com:acme/tool.git")).toBe("github.com/acme/tool");
  });

  test("remotes compare case-insensitively, owner and repo too, as GitHub does", () => {
    for (const url of ["git@github.com:Acme/API.git", "https://GitHub.com/ACME/tool.GIT"]) {
      expect(projectScope(c, a, project("tool", join(PERSONAL, "site"), url))).toBe("work");
    }
    const upper = config(TWO_SCOPES.replace(`remotes = ["github.com/acme/"]`, `remotes = ["GitHub.com/Acme/"]`));
    expect(projectScope(upper, accountsConfig(upper), project("tool", join(PERSONAL, "site"), "git@github.com:acme/tool.git"))).toBe("work");
  });

  test("an explicit scope the rules contradict refuses, and so does a project two scopes match", () => {
    const contradicted = config(`${TWO_SCOPES}\n[projects.api]\nscope = "personal"\n`);
    expect(refusal(() => projectScope(contradicted, accountsConfig(contradicted), project("api", join(WORK, "acme-api")))).message).toContain("puts it in work");
    const both = config(TWO_SCOPES.replace(`[scopes.personal]\n`, `[scopes.personal]\nremotes = ["github.com/acme/"]\n`));
    expect(refusal(() => projectScope(both, accountsConfig(both), project("api", join(WORK, "acme-api"), "git@github.com:acme/api.git"))).message).toContain("matches scopes work and personal");
  });

  test("an explicit scope the rules agree with, or that no rule covers, wins", () => {
    const own = config(`${TWO_SCOPES}\n[projects.site]\nscope = "work"\n`);
    expect(projectScope(own, accountsConfig(own), project("site", join(PERSONAL, "site")))).toBe("work");
  });
});

describe("choosing the account", () => {
  const c = config(TWO_SCOPES);
  const api = project("api", join(WORK, "acme-api"));
  const site = project("site", join(PERSONAL, "site"));

  test("the scope's first account of the harness is the default", () => {
    expect(resolveAccount(c, api).id).toBe("claude-work");
    expect(resolveAccount(c, site).id).toBe("claude-personal");
    expect(resolveAccount(c, site, { harness: "pi" }).id).toBe("chatgpt");
  });

  test("a work project never runs on a personal account, nor the reverse, and nothing overrides it", () => {
    expect(refusal(() => resolveAccount(c, api, { account: "claude-personal" })).code).toBe("account_scope_mismatch");
    expect(refusal(() => resolveAccount(c, site, { account: "claude-work" })).code).toBe("account_scope_mismatch");
    const pinned = config(`${TWO_SCOPES}\n[projects.site]\naccount = "claude-work"\n`);
    expect(refusal(() => resolveAccount(pinned, site)).code).toBe("account_scope_mismatch");
  });

  test("--account, then the project's account, then the scope order", () => {
    const more = config(`${TWO_SCOPES}\n[accounts.claude-work-2]\nharness = "claude"\nscope = "work"\nconfig_dir = "/x/w2"\n[projects.api]\naccount = "claude-work-2"\n`);
    expect(resolveAccount(more, api).id).toBe("claude-work-2");
    expect(resolveAccount(more, api, { account: "claude-work" }).id).toBe("claude-work");
  });

  test("a requested harness the account is not refuses; a scope with no account of the harness refuses", () => {
    expect(refusal(() => resolveAccount(c, site, { account: "chatgpt", harness: "claude" })).code).toBe("bad_args");
    expect(refusal(() => resolveAccount(c, api, { harness: "pi" })).code).toBe("no_account");
    expect(refusal(() => resolveAccount(c, api, { account: "nobody" })).code).toBe("not_found");
  });

  test("a resume keeps the recorded account, and refuses once it is gone or out of scope", () => {
    expect(runAccount(c, api, "claude-work", "claude").id).toBe("claude-work");
    expect(refusal(() => runAccount(c, api, "claude-old", "claude")).message).toContain("no longer in config.toml");
    const moved = config(TWO_SCOPES.replace(`scope = "work"\nconfig_dir`, `scope = "personal"\nconfig_dir`).replace(`accounts = ["claude-work"]`, "accounts = []"));
    expect(refusal(() => runAccount(moved, api, "claude-work", "claude")).code).toBe("account_scope_mismatch");
    // Rows from before accounts name their harness's implicit account.
    expect(runAccount(config(""), site, null, "pi").id).toBe("pi");
  });

  test("a run on a harness's implicit account keeps its [workers] login once accounts of that harness are declared", () => {
    const resumed = runAccount(c, site, "claude", "claude");
    expect(resumed).toMatchObject({ id: "claude", declared: false, scope: "personal", model: "sonnet", config_dir: null });
    expect(runAccount(c, site, null, "claude").id).toBe("claude");
    // The scope rule still holds: the implicit account is in the default scope, not the work project's.
    expect(refusal(() => runAccount(c, api, "claude", "claude")).code).toBe("account_scope_mismatch");
  });

  test("an ended scout on a harness's implicit account is promoted on that login, under the scope rule", () => {
    const site = { ...project("site", join(PERSONAL, "site")) } as unknown as ProjectRow;
    const api = { ...project("api", join(WORK, "acme-api")) } as unknown as ProjectRow;
    expect(promotedAccount(c, site, {}, { account: "claude", harness: "claude" })).toMatchObject({ id: "claude", declared: false });
    expect(promotedAccount(c, site, {}, { account: "claude-personal", harness: "claude" }).id).toBe("claude-personal");
    expect(refusal(() => promotedAccount(c, api, {}, { account: "claude", harness: "claude" })).code).toBe("account_scope_mismatch");
    expect(promotedAccount(c, site, { harness: "pi" }, { account: "claude", harness: "claude" }).id).toBe("chatgpt");
  });
});

describe("launching on an account", () => {
  const c = config(TWO_SCOPES);
  const run = (dir: string): RunContext => ({
    runId: "r1", taskId: "t1", kind: "ship", worktree: dir, projectPath: dir, runDir: dir, sessionId: "s1",
    instructionsFile: join(dir, "task.md"), contractFile: join(dir, "contract.md"), promptLine: "go", flowrynBin: "/bin/flowryn",
    binary: "/bin/claude", daemonSocket: "/s", writable: [], readOnly: [], permissionsDeny: [],
  });

  test("a pinned Claude login gets its config dir and unsets the credentials that outrank it", () => {
    const plan = claudeAdapter.launch(run(root), workersFor(workersConfig(c), accountById(c, "claude-work")));
    // ~ is the user's home, not the Flowryn home.
    expect(plan.env.CLAUDE_CONFIG_DIR).toBe(join(homedir(), ".claude-work"));
    expect(plan.env.FLOWRYN_UNSET!.split(" ")).toEqual(expect.arrayContaining(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK"]));
    expect(plan.env.FLOWRYN_UNSET).not.toContain("CLAUDE_CONFIG_DIR");
    expect(plan.args).toContain("opus");
  });

  test("a declared account on Claude's default login unsets CLAUDE_CONFIG_DIR rather than blanking it", () => {
    const plan = claudeAdapter.launch(run(root), workersFor(workersConfig(c), accountById(c, "claude-personal")));
    expect(plan.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(plan.env.FLOWRYN_UNSET!.split(" ")).toContain("CLAUDE_CONFIG_DIR");
  });

  test("a Pi account passes its provider and pins its agent dir", async () => {
    await loadExtensionSource();
    const plan = piAdapter.launch(run(root), workersFor(workersConfig(c), accountById(c, "chatgpt")));
    expect(plan.args.join(" ")).toContain("--provider openai-codex --model openai-codex/gpt-5-codex");
    expect(plan.env.PI_CODING_AGENT_DIR).toMatch(/\.pi\/agent$/);
  });

  // Design assumption, found wrong in the build: Claude 2.1.x reads CLAUDE_CONFIG_DIR="" as a relative
  // config directory (projectsDirectory "projects"), not as unset. A pane can only be given values, so
  // the shim must really unset it.
  test("assumption: a blank variable is not unset, so the shim unsets FLOWRYN_UNSET's names", async () => {
    const shim = join(root, "shim");
    writeFileSync(shim, shimScript("/usr/bin/env"));
    chmodSync(shim, 0o755);
    const proc = Bun.spawn([shim], { env: { PATH: "/usr/bin:/bin", CLAUDE_CONFIG_DIR: "", ANTHROPIC_API_KEY: "sk-x", KEEP: "1", FLOWRYN_UNSET: "CLAUDE_CONFIG_DIR ANTHROPIC_API_KEY $(touch\x20/tmp/x) 1BAD" }, stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const names = out.split("\n").map((line) => line.split("=")[0]);
    expect(names).toContain("KEEP");
    expect(names).not.toContain("CLAUDE_CONFIG_DIR");
    expect(names).not.toContain("ANTHROPIC_API_KEY");
    expect(names).not.toContain("FLOWRYN_UNSET");
  });
});

describe("sign-in check", () => {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  // Signed in only for the expected login, and only when no inherited key could answer instead.
  const fake = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const claude = fake(
    "claude",
    `if [ -n "$ANTHROPIC_API_KEY" ]; then echo '{"loggedIn":true,"authMethod":"api-key"}'; exit 0; fi\nif [ "$CLAUDE_CONFIG_DIR" = "/x/good" ]; then echo '{"loggedIn":true}'; exit 0; fi\necho '{"loggedIn":false}'; exit 1`,
  );
  const pi = fake(
    "pi",
    `case "$*" in\n  *"auth check --provider ready"*) echo '{"status":"ready","provider":"ready"}' ;;\n  *"auth check --provider ext"*) echo '{"status":"not_ready","provider":"ext","reason":"provider_not_found"}' ;;\n  *"--list-models ext"*) printf 'provider model\\next m1\\n' ;;\n  *) echo '{"status":"not_ready","reason":"credentials_not_configured"}' ;;\nesac`,
  );
  const account = (over: Record<string, unknown>) => ({ id: "a", harness: "claude" as const, scope: "s", config_dir: null, agent_dir: null, provider: null, model: null, effort: null, declared: true, overflow: [], ...over });

  test("assumption: an inherited credential cannot answer for a login that is not signed in", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-inherited";
    try {
      expect(await accountSignIn(account({ id: "bad", config_dir: "/x/bad" }), claude)).toContain("not signed in");
      expect(await accountSignIn(account({ id: "good", config_dir: "/x/good" }), claude)).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  test("the refusal says how to sign in; an implicit account is never checked", async () => {
    expect(await accountSignIn(account({ id: "bad2", config_dir: "/x/bad" }), claude)).toContain("CLAUDE_CONFIG_DIR=/x/bad claude, then /login");
    expect(await accountSignIn(account({ id: "dflt" }), claude)).toContain("env -u CLAUDE_CONFIG_DIR claude");
    expect(await accountSignIn(account({ id: "imp", declared: false }), "/nonexistent")).toBeNull();
  });

  test("Pi: auth check's ready passes; an extension provider falls back to the model list", async () => {
    const piAccount = (provider: string) => account({ id: `pi-${provider}`, harness: "pi", agent_dir: "/x/pi", provider });
    expect(await accountSignIn(piAccount("ready"), pi)).toBeNull();
    expect(await accountSignIn(piAccount("ext"), pi)).toBeNull();
    expect(await accountSignIn(piAccount("other"), pi)).toContain("credentials_not_configured");
  });
});

describe("plan phases", () => {
  test("a phase may name its account", () => {
    const plan = parsePlan("## Phase 1: one\naccount: claude-work\nharness: claude\ndo it\n");
    expect(plan.phases[0]).toMatchObject({ account: "claude-work", harness: "claude", body: "do it" });
    expect(() => parsePlan("## Phase 1: one\naccount: Not An Id\n")).toThrow("is not an account id");
  });
});

describe("plan phases' accounts", () => {
  const c = config(TWO_SCOPES);
  const dir = mkdtempSync(join(root, "plans-"));
  const db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  afterAll(() => db.close());
  const site: ProjectRow = { ...project("site", join(PERSONAL, "site")), default_branch: "main", delivery_mode: "local-only", yolo: 0, priority: 2, workflow: "fix", autonomy: "manual" } as ProjectRow;
  insertProject(db, site);
  const file = (text: string, gateId: string) => fileWorkerPlan(db, c, { project: site, sourceTask: "site-design-a1", gateId, phases: parsePlan(text), workflow: "fix", now: 1 });

  test("a phase's account: line takes that account's own harness, not the project's", () => {
    const plan = file("## Phase 1: one\naccount: chatgpt\ndo it\n## Phase 2: two\ndo more\n", "g1");
    expect(phasesOf(db, plan).map((p) => ({ account: p.account, harness: p.harness }))).toEqual([
      { account: "chatgpt", harness: null },
      { account: null, harness: null },
    ]);
    // flowryn plan passes the project's harness for the whole plan; the phase's own account still wins.
    const phases = parsePlan("## Phase 1: one\naccount: chatgpt\ndo it\n## Phase 2: two\ndo more\n").phases;
    expect(() => checkPhaseAccounts(c, site, phases, { harness: "claude" })).not.toThrow();
    const filed = recordPlan(db, { project: site, title: "t", phases, sourceTask: null, gateId: null, workflow: "fix", harness: "claude", filedBy: "human", state: "pending", now: 1 });
    expect(filed.phases.map((p) => ({ account: p.account, harness: p.harness }))).toEqual([
      { account: "chatgpt", harness: null },
      { account: null, harness: "claude" },
    ]);
  });

  test("a worker's plan with a phase outside the project's scope refuses at filing", () => {
    expect(refusal(() => file("## Phase 1: one\naccount: claude-work\ndo it\n", "g2")).code).toBe("account_scope_mismatch");
    expect(refusal(() => file("## Phase 1: one\naccount: nobody\ndo it\n", "g3")).code).toBe("not_found");
  });
});
