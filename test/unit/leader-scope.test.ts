import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCaller } from "../../src/api/auth.ts";
import { FlowrynError } from "../../src/api/errors.ts";
import { SERVER_VERBS } from "../../src/api/registry.ts";
import type { Caller, VerbSpec } from "../../src/api/verbs.ts";
import { composeBriefing } from "../../src/attention/briefing.ts";
import { openItem } from "../../src/attention/items.ts";
import { NotifyPump, recordingNotify } from "../../src/attention/notify.ts";
import { digestCandidates, p0Candidate } from "../../src/attention/router.ts";
import { leaderEnv, leaderToolkit } from "../../src/cli/commands/lead.ts";
import { accountById, CLAUDE_CREDENTIAL_ENV } from "../../src/config/accounts.ts";
import { parseConfig, type FlowrynConfig } from "../../src/config/config.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { applyLogin, confirmLogin, leaderAccount, loginArgs, sessionProjectsDir } from "../../src/leader/login.ts";
import { scopeDenyLists, writeScopeDenyLists } from "../../src/leader/scope-guard.ts";
import { adoptLegacyScope, enforceScope, lensFor, neutralLine, recordTaskScope, refScope, SEES_ALL, taskScope, unrestricted } from "../../src/leader/scope.ts";
import { allLeases, claim, getLease, getSession, isHolder, LEGACY_SCOPE, openSession, UNCONFIRMED_SCOPE } from "../../src/lease/lease.ts";
import type { LeaderFiles } from "../../src/bridges/files.ts";
import { readScopeDeny, scopeDenyFile, sharedStores } from "../../src/policy/scope-paths.ts";
import { leaderStaticLayers } from "../../src/policy/static.ts";
import { toolkitVerdict, type ToolkitPaths } from "../../src/policy/toolkit.ts";

/** A leader per scope (docs/notes/2026-10-24-leader-scoping-and-vj.md). */

const root = realpathSync(mkdtempSync(join(tmpdir(), "fl-scope-unit-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const HOME = join(root, "home");
const WORK = join(root, "work");
const CODE = join(root, "code");
const CLAUDE_WORK = join(HOME, ".claude-work");
for (const dir of [join(WORK, "api"), join(CODE, "site"), CLAUDE_WORK, join(HOME, ".claude"), join(HOME, "flowryn", "data"), join(HOME, "flowryn", "state")]) mkdirSync(dir, { recursive: true });

const SCOPES = `
data_dir = ${JSON.stringify(join(HOME, "flowryn", "data"))}
state_dir = ${JSON.stringify(join(HOME, "flowryn", "state"))}

[scopes]
default = "personal"

[scopes.work]
paths = [${JSON.stringify(WORK)}]

[scopes.personal]

[accounts.claude-work]
harness = "claude"
scope = "work"
config_dir = ${JSON.stringify(CLAUDE_WORK)}

[accounts.claude-personal]
harness = "claude"
scope = "personal"

[accounts.chatgpt]
harness = "pi"
scope = "personal"
provider = "openai-codex"
model = "openai-codex/gpt-5-codex"
`;

const twoScopes = (): FlowrynConfig => parseConfig(SCOPES, HOME);
const oneScope = (): FlowrynConfig => parseConfig("", HOME);

let db: Db;
let dbDir: string;

beforeEach(() => {
  dbDir = mkdtempSync(join(root, "db-"));
  db = openDb(join(dbDir, "flowryn.db"));
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

function seedProject(id: string, path: string): void {
  db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES (?1, '', ?2, 'main', 'local-only')").run(id, path);
}

function seedTask(taskId: string, project: string, runId: string | null = null): void {
  db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES (?1, ?2, 'ship', 'local-only', 0, 'fix', 1)").run(taskId, project);
  if (runId) {
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
       VALUES (?1, ?2, 'claude', '2.1.281', 'running', 'busy', 'fix', 'build', ?3, 'fm/x', 'abc', ?1, 1, 1)`,
    ).run(runId, taskId, join(HOME, "flowryn", "data", "worktrees", project, taskId));
  }
}

function item(kind: "pr_ready" | "failure_needs_you" | "forge_unavailable" | "contract_recorded", line: string, taskId: string | null): string {
  return tx(db, () => {
    const event = appendEvent(db, { source: "cli", kind: "test.item", payload: {} });
    return openItem(db, { kind, eventSeq: event.seq, line, ...(taskId ? { taskId } : {}) });
  });
}

/** Two projects in two scopes, each with a task, a run and an item. */
function seedBoth(): void {
  tx(db, () => {
    seedProject("api", join(WORK, "api"));
    seedProject("site", join(CODE, "site"));
    seedTask("api-w1", "api", "r01WORK");
    seedTask("site-p1", "site", "r01HOME");
  });
}

function caller(scope: string | undefined, role: Caller["role"] = "leader"): Caller {
  return { role, runId: null, taskId: null, session: "L1", ...(scope === undefined ? {} : { scope }) };
}

function refusal(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof FlowrynError ? error.code : String(error);
  }
}

function verb(name: string): VerbSpec {
  const spec = SERVER_VERBS.find((v) => v.name === name);
  if (!spec) throw new Error(`no verb ${name}`);
  return spec;
}

describe("every verb a leader reaches declares its scope rule", () => {
  test("a verb a leader, reader or leader hook can call without a scope rule fails here (and refuses a scoped caller)", () => {
    const missing = SERVER_VERBS.filter((v) => v.roles.some((r) => r === "leader" || r === "reader" || r === "hook") && !v.scope).map((v) => v.name);
    expect(missing).toEqual([]);
  });

  test("a verb without one refuses a scoped caller: fail closed", () => {
    const bare: VerbSpec = { name: "bare", summary: "", positionals: [], flags: {}, kind: "read", roles: ["leader"] };
    expect(refusal(() => enforceScope(bare, db, twoScopes(), caller("personal"), {}))).toBe("scope_refused");
    expect(refusal(() => enforceScope(bare, db, oneScope(), caller("default"), {}))).toBeNull();
  });
});

describe("a task's scope is its project's", () => {
  test("projects, runs, items, decisions, gates and plans resolve to their project's scope", () => {
    seedBoth();
    const config = twoScopes();
    const workItem = item("pr_ready", "PR ready: api", "api-w1");
    tx(db, () => {
      db.query("INSERT INTO decisions (id, task_id, question, options, blocking, state, created_at) VALUES ('q1', 'api-w1', 'which?', '[]', 0, 'open', 1)").run();
      db.query("INSERT INTO plans (id, project_id, title, state, source_task, filed_by, created_at) VALUES ('p1', 'site', 'plan', 'pending', 'site-p1', 'leader', 1)").run();
    });
    expect(taskScope(db, config, "api-w1")).toBe("work");
    expect(taskScope(db, config, "site-p1")).toBe("personal");
    expect(refScope(db, config, "r01WORK")).toBe("work");
    expect(refScope(db, config, workItem)).toBe("work");
    expect(refScope(db, config, "q1")).toBe("work");
    expect(refScope(db, config, "p1")).toBe("personal");
    expect(refScope(db, config, "merge:api-w1")).toBe("work");
    expect(refScope(db, config, "nothing-here")).toBeUndefined();
    // An item about no task (a key like a contract record's) belongs to every scope.
    expect(taskScope(db, config, "harness:claude")).toBe("global");
  });

  test("a task a scoped leader creates with no project stays in its scope; yours go to the default scope", () => {
    const config = twoScopes();
    tx(db, () => recordTaskScope(db, caller("work"), "todo-w1"));
    tx(db, () => recordTaskScope(db, caller(undefined, "human"), "todo-h1"));
    expect(taskScope(db, config, "todo-w1")).toBe("work");
    expect(taskScope(db, config, "todo-h1")).toBe("personal");
  });

  test("a home with one scope is unrestricted for its leaders; an unconfirmed session never is", () => {
    expect(unrestricted(oneScope(), "default")).toBe(true);
    expect(unrestricted(twoScopes(), "work")).toBe(false);
    expect(unrestricted(twoScopes(), undefined)).toBe(true);
    expect(unrestricted(oneScope(), UNCONFIRMED_SCOPE)).toBe(false);
    expect(lensFor(db, oneScope(), "default")).toBe(SEES_ALL);
  });
});

describe("the gateway's scope check", () => {
  test("a reference outside the caller's scope refuses with scope_refused and is recorded; its own passes; your terminal passes", () => {
    seedBoth();
    const config = twoScopes();
    const recorded: string[] = [];
    const record = (r: { ref: string }) => recorded.push(r.ref);
    expect(refusal(() => enforceScope(verb("show"), db, config, caller("personal"), { target: "api-w1" }, record))).toBe("scope_refused");
    expect(refusal(() => enforceScope(verb("steer"), db, config, caller("personal"), { target: "r01WORK" }, record))).toBe("scope_refused");
    expect(refusal(() => enforceScope(verb("dispatch"), db, config, caller("personal"), { project: "api" }, record))).toBe("scope_refused");
    expect(refusal(() => enforceScope(verb("show"), db, config, caller("personal"), { target: "site-p1" }, record))).toBeNull();
    expect(refusal(() => enforceScope(verb("show"), db, config, caller(undefined, "human"), { target: "api-w1" }, record))).toBeNull();
    expect(refusal(() => enforceScope(verb("fleet"), db, config, caller("personal"), {}, record))).toBeNull();
    expect(refusal(() => enforceScope(verb("show"), db, config, caller(UNCONFIRMED_SCOPE), { target: "site-p1" }, record))).toBe("scope_refused");
    // Not found stays the verb's own answer.
    expect(refusal(() => enforceScope(verb("show"), db, config, caller("personal"), { target: "no-such-task" }, record))).toBeNull();
    expect(recorded).toEqual(["api-w1", "r01WORK", "api", "site-p1"]);
  });

  test("verify start checks its --project too", () => {
    seedBoth();
    expect(refusal(() => enforceScope(verb("verify.start"), db, twoScopes(), caller("personal"), { target: "42", project: "api" }))).toBe("scope_refused");
    expect(refusal(() => enforceScope(verb("verify.start"), db, twoScopes(), caller("personal"), { target: "42", project: "site" }))).toBeNull();
  });
});

describe("one lease per scope", () => {
  test("a work and a personal session both lead, each over its own scope; claiming one never moves the other", () => {
    const work = tx(db, () => openSession(db, { harness: "claude", pane: "w1:p1", cwd: null, now: 1, account: "claude-work", scope: "work" }));
    const home = tx(db, () => openSession(db, { harness: "claude", pane: "w1:p2", cwd: null, now: 1, account: "claude-personal", scope: "personal" }));
    const second = tx(db, () => openSession(db, { harness: "pi", pane: "w1:p3", cwd: null, now: 1, account: "chatgpt", scope: "personal" }));
    tx(db, () => claim(db, work.session, "vacant", 2));
    tx(db, () => claim(db, home.session, "vacant", 2));
    expect(allLeases(db).map((l) => [l.scope, l.session_id, l.epoch])).toEqual([
      ["personal", home.session, 1],
      ["work", work.session, 1],
    ]);
    expect(resolveCaller(db, work.token, null)).toMatchObject({ role: "leader", scope: "work" });
    expect(resolveCaller(db, home.token, null)).toMatchObject({ role: "leader", scope: "personal" });
    expect(resolveCaller(db, second.token, null)).toMatchObject({ role: "reader", scope: "personal" });
    tx(db, () => claim(db, second.session, "explicit", 3));
    expect(getLease(db, "personal")).toMatchObject({ session_id: second.session, epoch: 2 });
    expect(getLease(db, "work")).toMatchObject({ session_id: work.session, epoch: 1 });
    expect(isHolder(db, work.session)).toBe(true);
    expect(isHolder(db, home.session)).toBe(false);
  });

  test("an unconfirmed session claims nothing", () => {
    const s = tx(db, () => openSession(db, { harness: "claude", pane: null, cwd: null, now: 1, account: "claude-work", scope: UNCONFIRMED_SCOPE }));
    expect(refusal(() => tx(db, () => claim(db, s.session, "vacant", 2)))).toBe("scope_refused");
    expect(allLeases(db)).toEqual([]);
  });

  test("migration 34 keeps the lease from before scopes, in the implicit scope; the daemon moves it to [scopes] default", () => {
    const s = tx(db, () => openSession(db, { harness: "claude", pane: null, cwd: null, now: 1 }));
    tx(db, () => claim(db, s.session, "vacant", 2));
    expect(getLease(db, LEGACY_SCOPE).session_id).toBe(s.session);
    // A home with no scopes keeps it where it is.
    expect(tx(db, () => adoptLegacyScope(db, oneScope(), 3))).toBe(0);
    expect(tx(db, () => adoptLegacyScope(db, twoScopes(), 3))).toBe(2);
    expect(getLease(db, "personal").session_id).toBe(s.session);
    expect(getSession(db, s.session)!.scope).toBe("personal");
    expect(resolveCaller(db, s.token, null)).toMatchObject({ role: "leader", scope: "personal" });
  });
});

describe("what a scoped leader is handed", () => {
  test("pushes, digests and the briefing carry only the leader's scope; other scopes are a count", () => {
    seedBoth();
    const config = twoScopes();
    const workP0 = item("failure_needs_you", "WORKSECRET failed", "api-w1");
    const homeP1 = item("pr_ready", "PR ready: site", "site-p1");
    const s = tx(db, () => openSession(db, { harness: "claude", pane: null, cwd: null, now: 1, account: "claude-personal", scope: "personal" }));
    tx(db, () => claim(db, s.session, "vacant", 2));
    const lens = lensFor(db, config, "personal");
    expect(p0Candidate(db, s.session, Date.now(), 86_400_000, null, lens)).toBeNull();
    expect(p0Candidate(db, s.session, Date.now(), 86_400_000, null, lensFor(db, config, "work"))?.id).toBe(workP0);
    expect(digestCandidates(db, s.session, Date.now(), 86_400_000, lens).map((i) => i.id)).toEqual([homeP1]);
    const briefing = composeBriefing(db, { session: s.session, now: Date.now(), morningHour: 9, ageMs: 86_400_000, markMorning: false, config });
    expect(briefing.text).not.toContain("WORKSECRET");
    expect(briefing.text).toContain("Other scope work: 1 item wait for its leader (not shown here).");
    expect(briefing.listed.map((i) => i.id)).toEqual([homeP1]);
    // Your terminal's briefing lists both.
    const yours = composeBriefing(db, { session: null, now: Date.now(), morningHour: 9, ageMs: 86_400_000, markMorning: false, config });
    expect(yours.text).toContain("WORKSECRET");
  });

  test("each scope's leader gets its own Morning line once a day; your terminal keeps the home's marker", () => {
    const config = twoScopes();
    const now = new Date(2026, 8, 24, 10, 0).getTime();
    const brief = (session: string | null) =>
      tx(db, () => composeBriefing(db, { session, now, morningHour: 9, ageMs: 86_400_000, markMorning: true, config })).morning;
    const work = tx(db, () => openSession(db, { harness: "claude", pane: null, cwd: null, now: 1, account: "claude-work", scope: "work" }));
    const personal = tx(db, () => openSession(db, { harness: "claude", pane: null, cwd: null, now: 1, account: "claude-personal", scope: "personal" }));
    expect(brief(work.session)).toBe(true);
    expect(brief(work.session)).toBe(false);
    expect(brief(personal.session)).toBe(true);
    expect(brief(personal.session)).toBe(false);
    expect(brief(null)).toBe(true);
    expect(brief(null)).toBe(false);
  });

  test("assumption broken by the build: task-less items do name tasks (a GitHub outage lists the merges that wait), so a scoped leader gets a neutral line", () => {
    seedBoth();
    const config = twoScopes();
    const outage = item("forge_unavailable", "GitHub is unavailable: 1 merge(s) wait (api-w1)", null);
    const contract = item("contract_recorded", "claude 2.1.308 passed", null);
    const s = tx(db, () => openSession(db, { harness: "claude", pane: null, cwd: null, now: 1, account: "claude-personal", scope: "personal" }));
    const shown = digestCandidates(db, s.session, Date.now(), 86_400_000, lensFor(db, config, "personal"));
    expect(shown.find((i) => i.id === outage)?.line).toBe(neutralLine({ id: outage, kind: "forge_unavailable" }));
    expect(shown.find((i) => i.id === contract)?.line).toBe("claude 2.1.308 passed");
    expect(JSON.stringify(shown)).not.toContain("api-w1");
    expect(digestCandidates(db, s.session, Date.now(), 86_400_000).find((i) => i.id === outage)?.line).toContain("api-w1");
  });

  test("notifications reach you whole, each labelled with its scope", async () => {
    seedBoth();
    const config = { ...twoScopes(), extra: { ...twoScopes().extra, notify: { macos: true, herdr: false } } } as FlowrynConfig;
    item("failure_needs_you", "api failed", "api-w1");
    const sent = join(dbDir, "notified.jsonl");
    const pump = new NotifyPump({ db, config: () => config, runtime: () => null, now: Date.now, log: () => {}, macos: recordingNotify(sent) });
    await pump.tick();
    const body = (JSON.parse(readFileSync(sent, "utf8").trim().split("\n")[0]!) as { body: string }).body;
    expect(body).toBe("[work] api failed");
  });
});

describe("the login decides a leader's account", () => {
  test("flowryn lead picks the account whose login folder the terminal points at, or the one named", () => {
    const config = twoScopes();
    expect(leaderAccount(config, "claude", null, { HOME, CLAUDE_CONFIG_DIR: CLAUDE_WORK }).id).toBe("claude-work");
    expect(leaderAccount(config, "claude", null, { HOME }).id).toBe("claude-personal");
    expect(leaderAccount(config, "claude", "claude-work", { HOME }).id).toBe("claude-work");
    expect(refusal(() => leaderAccount(config, "claude", null, { HOME, CLAUDE_CONFIG_DIR: join(root, "elsewhere") }))).toBe("not_found");
    expect(refusal(() => leaderAccount(config, "claude", "chatgpt", { HOME }))).toBe("bad_args");
    // The only account of the harness that keeps your terminal's login: nothing to choose between.
    expect(leaderAccount(oneScope(), "claude", null, { HOME, CLAUDE_CONFIG_DIR: join(root, "anything") }).id).toBe("claude");
  });

  test("the launch takes the account's login: CLAUDE_CONFIG_DIR set or unset, credential variables dropped; Pi gets its provider", () => {
    const config = twoScopes();
    const work: Record<string, string> = { ANTHROPIC_API_KEY: "sk-x", CLAUDE_CONFIG_DIR: join(HOME, ".claude") };
    applyLogin(work, accountById(config, "claude-work"));
    expect(work.CLAUDE_CONFIG_DIR).toBe(CLAUDE_WORK);
    for (const key of CLAUDE_CREDENTIAL_ENV) expect(work[key]).toBeUndefined();
    const personal: Record<string, string> = { CLAUDE_CONFIG_DIR: CLAUDE_WORK };
    applyLogin(personal, accountById(config, "claude-personal"));
    expect(personal.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(loginArgs(accountById(config, "chatgpt"))).toEqual(["--provider", "openai-codex", "--model", "openai-codex/gpt-5-codex"]);
  });

  test("a home with no [accounts] leads as before: the implicit account keeps your terminal's login and is not checked", () => {
    // [workers.claude] config_dir is the workers' login, not the leader's.
    const config = parseConfig(`[workers.claude]\nconfig_dir = ${JSON.stringify(CLAUDE_WORK)}\n`, HOME);
    const env: Record<string, string> = { ANTHROPIC_API_KEY: "sk-x", CLAUDE_CONFIG_DIR: join(HOME, ".claude") };
    applyLogin(env, accountById(config, "claude"));
    expect(env).toEqual({ ANTHROPIC_API_KEY: "sk-x", CLAUDE_CONFIG_DIR: join(HOME, ".claude") });
    expect(confirmLogin(config, { account: "claude", harness: "claude" }, { transcriptPath: join(HOME, ".claude", "projects", "-x", "s.jsonl"), login: { config_dir: null } }, HOME)).toBeNull();
  });

  test("assumption: the leader's hooks inherit the account's login folder and scope from the launch environment", () => {
    const files = { bin: "/b/flowryn", binDir: "/b" } as LeaderFiles;
    const launched = leaderEnv({ PATH: "/usr/bin", CLAUDE_CONFIG_DIR: join(HOME, ".claude") }, { token: "fwl_x", session: "L1", files, inactiveMs: 1, account: accountById(twoScopes(), "claude-work") });
    expect(launched.CLAUDE_CONFIG_DIR).toBe(CLAUDE_WORK);
    expect(launched.FLOWRYN_LEADER_SCOPE).toBe("work");
  });

  test("the first hook must confirm the login: its own folder and Claude's transcript under the account's", () => {
    const config = twoScopes();
    const session = { account: "claude-work", harness: "claude" as const };
    const transcript = join(CLAUDE_WORK, "projects", "-x", "s.jsonl");
    expect(confirmLogin(config, session, { transcriptPath: transcript, login: { config_dir: CLAUDE_WORK } }, HOME)).toBeNull();
    expect(confirmLogin(config, session, { transcriptPath: join(HOME, ".claude", "projects", "-x", "s.jsonl"), login: null }, HOME)).toContain("is not under");
    expect(confirmLogin(config, session, { transcriptPath: transcript, login: { config_dir: null } }, HOME)).toContain("the hook runs on");
    expect(confirmLogin(config, { account: "gone", harness: "claude" }, { transcriptPath: null, login: null }, HOME)).toContain("no longer in config");
    // A session from before accounts were recorded is not checked.
    expect(confirmLogin(config, { account: null, harness: "claude" }, { transcriptPath: null, login: null }, HOME)).toBeNull();
  });

  test("chat-answer grants look in the session's own login's projects folder; the implicit account keeps [grants]", () => {
    const config = twoScopes();
    expect(sessionProjectsDir(config, "claude-work", "/fallback", HOME)).toBe(join(CLAUDE_WORK, "projects"));
    expect(sessionProjectsDir(config, "claude-personal", "/fallback", HOME)).toBe(join(HOME, ".claude", "projects"));
    expect(sessionProjectsDir(oneScope(), "claude", "/fallback", HOME)).toBe("/fallback");
    expect(sessionProjectsDir(config, null, "/fallback", HOME)).toBe("/fallback");
  });
});

describe("the folder guard", () => {
  const PATHS: ToolkitPaths = {
    home: HOME,
    flowrynBacklog: join(HOME, "flowryn", "data", "backlog.md"),
    flowrynTodos: join(HOME, "flowryn", "data", "todos.md"),
    flowrynDb: join(HOME, "flowryn", "state", "flowryn.db"),
    scopeDenied: [join(WORK, "api"), join(HOME, "flowryn", "data", "backlog.md")],
  };
  const leaderCall = (toolName: string, toolInput: Record<string, unknown>, role: "leader" | "worker" = "leader") =>
    toolkitVerdict({ harness: "claude", role, toolName, toolInput, cwd: CODE }, PATHS)?.rule ?? null;

  test("a leader's read, search or shell use of another scope's folder is refused", () => {
    expect(leaderCall("Read", { file_path: join(WORK, "api", "README.md") })).toBe("scope-paths");
    expect(leaderCall("Grep", { pattern: "x", path: join(WORK, "api") })).toBe("scope-paths");
    expect(leaderCall("Bash", { command: `cat ${join(WORK, "api", "README.md")}` })).toBe("scope-paths");
    expect(leaderCall("Bash", { command: `git -C ${join(WORK, "api")} log` })).toBe("scope-paths");
    expect(leaderCall("Bash", { command: `cd ${join(WORK, "api")} && ls` })).toBe("scope-paths");
    expect(leaderCall("Bash", { command: `wc -l < ${join(HOME, "flowryn", "data", "backlog.md")}` })).toBe("scope-paths");
    expect(toolkitVerdict({ harness: "claude", role: "leader", toolName: "Bash", toolInput: { command: "tasks-axi list" }, cwd: join(HOME, "flowryn", "data") }, PATHS)?.rule).toBe("scope-paths");
  });

  test("a search with no path, a recursive search above another scope's folder, and words after a cd are refused", () => {
    const at = (cwd: string, toolName: string, toolInput: Record<string, unknown>) => toolkitVerdict({ harness: "claude", role: "leader", toolName, toolInput, cwd }, PATHS)?.rule ?? null;
    const data = join(HOME, "flowryn", "data");
    // Grep, Glob and LS with no path work on the cwd; Grep and Glob search under it.
    expect(at(WORK, "Grep", { pattern: "billing" })).toBe("scope-paths");
    expect(at(root, "Grep", { pattern: "billing" })).toBe("scope-paths");
    expect(at(root, "Glob", { pattern: "**/*.ts" })).toBe("scope-paths");
    expect(at(CODE, "Glob", { pattern: `${WORK}/**/*.ts` })).toBe("scope-paths");
    expect(at(CODE, "Glob", { path: join(CODE, "site"), pattern: `${WORK}/**/*.ts` })).toBe("scope-paths");
    expect(at(CODE, "Glob", { pattern: "../work/**" })).toBe("scope-paths");
    expect(at(CODE, "Glob", { path: join(CODE, "site"), pattern: "../../work/api/*.md" })).toBe("scope-paths");
    expect(at(CODE, "Glob", { path: join(CODE, "site"), pattern: "src/**/*.ts" })).toBeNull();
    expect(at(join(CODE, "site"), "Glob", { pattern: "{../../work,src}/**/*.ts" })).toBe("scope-paths");
    expect(at(CODE, "Glob", { path: join(CODE, "site"), pattern: `{${WORK},src}/**` })).toBe("scope-paths");
    expect(at(CODE, "Glob", { path: join(CODE, "site"), pattern: "{src,test}/**/*.ts" })).toBeNull();
    // A shell wildcard word reaches what it would expand to.
    expect(at(CODE, "Bash", { command: `cat ${root}/*/api/README.md` })).toBe("scope-paths");
    expect(at(join(CODE, "site"), "Bash", { command: "cat ../../*/api/README.md" })).toBe("scope-paths");
    expect(at(join(CODE, "site"), "Bash", { command: "cat ../../{work,code}/x" })).toBe("scope-paths");
    expect(at(root, "Bash", { command: "cat *" })).toBe("scope-paths");
    expect(at(join(CODE, "site"), "Bash", { command: "cat src/*.ts" })).toBeNull();
    expect(at(join(WORK, "api"), "LS", {})).toBe("scope-paths");
    expect(at(root, "LS", {})).toBeNull();
    expect(at(root, "Grep", { pattern: "x", path: CODE })).toBeNull();
    expect(at(CODE, "Grep", { pattern: "billing" })).toBeNull();
    // A recursive shell search whose root holds a denied folder.
    for (const command of ["rg billing", "grep -r billing .", "grep -rn billing", "find .", "ls -R", "tree", `rg billing ${root}`, "fd x ../"]) {
      expect(at(root, "Bash", { command })).toBe("scope-paths");
    }
    expect(at(CODE, "Bash", { command: "rg billing" })).toBeNull();
    expect(at(root, "Bash", { command: "rg billing ./code" })).toBeNull();
    expect(at(root, "Bash", { command: "ls" })).toBeNull();
    expect(at(root, "Bash", { command: "grep billing notes.txt" })).toBeNull();
    // Words after a cd are read from where it went; a bare name is a path too.
    expect(at(CODE, "Bash", { command: `cd ${data} && cat backlog.md` })).toBe("scope-paths");
    expect(at(CODE, "Bash", { command: `cd ${root} && cat work/api/README.md` })).toBe("scope-paths");
    expect(at(CODE, "Bash", { command: `cd ${root}; rg billing` })).toBe("scope-paths");
    expect(at(data, "Bash", { command: "cat backlog.md" })).toBe("scope-paths");
    expect(at(CODE, "Bash", { command: "cat backlog.md" })).toBeNull();
    expect(at(data, "Bash", { command: `cd ${CODE} && cat backlog.md` })).toBeNull();
  });

  test("its own folders, a worker, and a leader with no list are untouched", () => {
    expect(leaderCall("Read", { file_path: join(CODE, "site", "README.md") })).toBeNull();
    expect(leaderCall("Bash", { command: "flowryn fleet" })).toBeNull();
    expect(leaderCall("Read", { file_path: join(WORK, "api", "README.md") }, "worker")).toBeNull();
    expect(toolkitVerdict({ harness: "claude", role: "leader", toolName: "Read", toolInput: { file_path: join(WORK, "api", "x") }, cwd: CODE }, { ...PATHS, scopeDenied: [] })).toBeNull();
  });

  test("each scope's list names the other scopes' checkouts, worktrees, task folders and run state; the hook reads its own", () => {
    seedBoth();
    const config = twoScopes();
    const lists = Object.fromEntries(scopeDenyLists(db, config).map((l) => [l.scope, l.paths]));
    expect(lists.personal).toContain(join(WORK, "api"));
    expect(lists.personal).toContain(join(config.data_dir, "worktrees", "api"));
    expect(lists.personal).toContain(join(config.data_dir, "api-w1"));
    expect(lists.personal).toContain(join(config.state_dir, "runs", "r01WORK"));
    expect(lists.personal).not.toContain(join(CODE, "site"));
    expect(lists.work).toContain(join(CODE, "site"));
    expect(writeScopeDenyLists(db, config).toSorted()).toEqual([scopeDenyFile(config.state_dir, "personal"), scopeDenyFile(config.state_dir, "work")]);
    expect(writeScopeDenyLists(db, config)).toEqual([]);
    expect(readScopeDeny(config.state_dir, "personal")).toEqual(lists.personal!);
    expect(scopeDenyLists(db, oneScope())).toEqual([]);
    expect(sharedStores(config)).toContain(config.tasks.backlog);
  });

  test("the leader settings deny reading Flowryn's shared stores only with more than one scope, and writing every Claude account's transcripts", () => {
    const multi = leaderToolkit(twoScopes(), { HOME });
    expect(multi.permissionsDeny).toContain(`Read(/${twoScopes().tasks.backlog})`);
    expect(multi.permissionsDeny).toContain(`Edit(/${join(CLAUDE_WORK, "projects")}/**/*.jsonl)`);
    expect(multi.permissionsDeny).toContain(`Edit(/${join(HOME, ".claude", "projects")}/**/*.jsonl)`);
    const single = leaderStaticLayers(oneScope(), "/u/.claude/projects");
    expect(single.permissionsDeny.some((rule) => rule.startsWith("Read("))).toBe(false);
  });
});
