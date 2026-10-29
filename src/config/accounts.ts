import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { FlowrynError } from "../api/errors.ts";
import { HARNESS_IDS, type HarnessId } from "../harness/types.ts";
import { table, type FlowrynConfig } from "./config.ts";
import { toAbsolute } from "./paths.ts";
import { workersConfig, type WorkersConfig } from "./workers.ts";

/**
 * Accounts and scopes (docs/notes/2026-10-22-multiple-ai-provider-u9.md).
 *
 * An account is one named login for one harness: `[accounts.<id>]` with its
 * harness, its scope, where the login lives (Claude's config directory, Pi's
 * agent directory and provider) and its model and effort. Every project
 * belongs to a scope too, and a run starts only on an account of its
 * project's scope. The rule is plain config, with no override, so a work
 * repository never runs on a personal login, or the reverse.
 *
 * Flowryn keeps only references: account ids and directory paths. The login
 * itself stays in the harness's own store.
 *
 * A harness with no declared account gets an implicit one named after it,
 * built from `[workers.<harness>]` in the default scope, so a config with no
 * `[accounts]` behaves exactly as before.
 */

export const ID = /^[a-z][a-z0-9-]{0,31}$/;
export const IMPLICIT_SCOPE = "default";

export interface Account {
  id: string;
  harness: HarnessId;
  scope: string;
  /** Claude: CLAUDE_CONFIG_DIR; null is Claude's default login (with `declared`, CLAUDE_CONFIG_DIR is unset at launch). */
  config_dir: string | null;
  /** Pi: PI_CODING_AGENT_DIR. */
  agent_dir: string | null;
  /** Pi: the provider whose login this account spends (passed as --provider). */
  provider: string | null;
  model: string | null;
  effort: string | null;
  /** From `[accounts.<id>]`; false for the implicit account built from `[workers.<harness>]`. */
  declared: boolean;
  /**
   * Accounts a fresh launch may move to while this one is held by its usage
   * pause or quota floor, in order: same scope and harness, checked at load.
   */
  overflow: string[];
}

export interface ScopeRule {
  id: string;
  /** Directory prefixes: a project whose checkout is under one belongs here. */
  paths: string[];
  /** Remote prefixes such as github.com/acme/, matched against the project's normalized repo URL. */
  remotes: string[];
  /** Account order for this scope: the first of a harness is that harness's default here. */
  accounts: string[];
}

export interface AccountsConfig {
  accounts: Record<string, Account>;
  scopes: Record<string, ScopeRule>;
  default_scope: string;
}

/**
 * The environment variables Claude ranks above a stored login (Claude Code's
 * authentication precedence): a pinned login unsets them at launch, so an
 * inherited key cannot silently answer for the account.
 */
export const CLAUDE_CREDENTIAL_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_PROFILE",
] as const;

const ACCOUNT_KEYS = new Set(["harness", "scope", "config_dir", "agent_dir", "provider", "model", "effort", "overflow"]);
const SCOPE_KEYS = new Set(["paths", "remotes", "accounts"]);
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function optString(value: unknown, where: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) throw new FlowrynError("config_invalid", `${where} must be a non-empty string`);
  return value;
}

function stringList(value: unknown, where: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.length > 0)) throw new FlowrynError("config_invalid", `${where} must be a list of non-empty strings`);
  return value as string[];
}

function id(value: string, where: string): string {
  if (!ID.test(value)) throw new FlowrynError("config_invalid", `${where}: ${value} is not an id (lowercase letters, digits and -, starting with a letter)`);
  return value;
}

/** A directory prefix, absolute, without a trailing slash; through its real path when it exists. */
function pathPrefix(value: string, home: string): string {
  const absolute = normalize(toAbsolute(value, home)).replace(/\/+$/, "") || "/";
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

/** `git@host:owner/repo.git`, `https://host/owner/repo` and `ssh://git@host/owner/repo` all become `host/owner/repo`, lowercased as GitHub compares them. */
export function normalizeRemote(url: string): string {
  let rest = url.trim();
  const scp = /^[^@/]+@([^:/]+):(.*)$/.exec(rest);
  if (scp) rest = `${scp[1]}/${scp[2]}`;
  else rest = rest.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "");
  return rest.replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
}

function remotePrefix(value: string): string {
  const normalized = normalizeRemote(value);
  return value.trim().endsWith("/") ? `${normalized}/` : normalized;
}

function declaredAccount(key: string, raw: Record<string, unknown>, workers: WorkersConfig, defaultScope: string, home: string): Account {
  const where = `[accounts.${key}]`;
  for (const k of Object.keys(raw)) if (!ACCOUNT_KEYS.has(k)) throw new FlowrynError("config_invalid", `${where} ${k} is not a known setting (${[...ACCOUNT_KEYS].join(", ")})`);
  const harness = optString(raw.harness, `${where} harness`);
  if (!harness || !(HARNESS_IDS as readonly string[]).includes(harness)) throw new FlowrynError("config_invalid", `${where} harness must be one of ${HARNESS_IDS.join(", ")}`);
  const h = harness as HarnessId;
  if ((HARNESS_IDS as readonly string[]).includes(key) && key !== h) throw new FlowrynError("config_invalid", `${where}: an account named ${key} must be a ${key} account`);
  const scope = id(optString(raw.scope, `${where} scope`) ?? defaultScope, `${where} scope`);
  const configDir = optString(raw.config_dir, `${where} config_dir`);
  const agentDir = optString(raw.agent_dir, `${where} agent_dir`);
  const provider = optString(raw.provider, `${where} provider`);
  const model = optString(raw.model, `${where} model`);
  if (h === "claude" && (agentDir !== null || provider !== null)) throw new FlowrynError("config_invalid", `${where}: agent_dir and provider are Pi settings; a Claude account takes config_dir`);
  if (h === "pi") {
    if (configDir !== null) throw new FlowrynError("config_invalid", `${where}: config_dir is a Claude setting; a Pi account takes agent_dir`);
    // A Pi agent directory can hold several providers' logins, so the account names the one it spends.
    if (provider === null || !PROVIDER.test(provider)) throw new FlowrynError("config_invalid", `${where} provider must name the Pi provider this login spends, such as openai-codex`);
    if (model === null || !model.startsWith(`${provider}/`)) throw new FlowrynError("config_invalid", `${where} model must be ${provider}/<model id>, so Pi cannot resolve it under another provider`);
  }
  const own = h === "claude" ? workers.claude : workers.pi;
  return {
    id: key,
    harness: h,
    scope,
    config_dir: configDir === null ? null : toAbsolute(configDir, home),
    // Pi's own default, made explicit so an inherited PI_CODING_AGENT_DIR cannot choose the login.
    agent_dir: h === "pi" ? (agentDir === null ? join(homedir(), ".pi", "agent") : toAbsolute(agentDir, home)) : null,
    provider,
    model: model ?? own.model,
    effort: optString(raw.effort, `${where} effort`) ?? own.effort,
    declared: true,
    overflow: stringList(raw.overflow, `${where} overflow`),
  };
}

function implicitAccount(harness: HarnessId, workers: WorkersConfig, scope: string): Account {
  const own = harness === "claude" ? workers.claude : workers.pi;
  return {
    id: harness,
    harness,
    scope,
    config_dir: harness === "claude" ? workers.claude.config_dir : null,
    agent_dir: harness === "pi" ? workers.pi.agent_dir : null,
    provider: null,
    model: own.model,
    effort: own.effort,
    declared: false,
    overflow: [],
  };
}

/** Overflow stays inside the account's scope and harness: a held work login never spills onto a personal one. */
function checkOverflow(account: Account, accounts: Record<string, Account>): void {
  const where = `[accounts.${account.id}] overflow`;
  const seen = new Set<string>();
  for (const ref of account.overflow) {
    const target = accounts[ref];
    if (!target) throw new FlowrynError("config_invalid", `${where}: no account ${ref}`);
    if (ref === account.id) throw new FlowrynError("config_invalid", `${where}: an account cannot overflow to itself`);
    if (seen.has(ref)) throw new FlowrynError("config_invalid", `${where}: ${ref} is listed twice`);
    seen.add(ref);
    if (target.scope !== account.scope) throw new FlowrynError("config_invalid", `${where}: ${ref} is in scope ${target.scope}, not ${account.scope}; overflow stays inside a scope`);
    if (target.harness !== account.harness) throw new FlowrynError("config_invalid", `${where}: ${ref} is a ${target.harness} account, not ${account.harness}; overflow stays on one harness`);
  }
}

export function accountsConfig(config: FlowrynConfig): AccountsConfig {
  const workers = workersConfig(config);
  const rawScopes = table(config.extra.scopes, "[scopes]");
  const rawAccounts = table(config.extra.accounts, "[accounts]");
  const defaultScope = id(optString(rawScopes.default, "[scopes] default") ?? IMPLICIT_SCOPE, "[scopes] default");

  const scopes: Record<string, ScopeRule> = {};
  for (const [key, value] of Object.entries(rawScopes)) {
    if (key === "default") continue;
    const where = `[scopes.${key}]`;
    id(key, where);
    const raw = table(value, where);
    for (const k of Object.keys(raw)) if (!SCOPE_KEYS.has(k)) throw new FlowrynError("config_invalid", `${where} ${k} is not a known setting (${[...SCOPE_KEYS].join(", ")})`);
    scopes[key] = {
      id: key,
      paths: stringList(raw.paths, `${where} paths`).map((p) => pathPrefix(p, config.home)),
      remotes: stringList(raw.remotes, `${where} remotes`).map(remotePrefix),
      accounts: stringList(raw.accounts, `${where} accounts`),
    };
  }
  if (!scopes[defaultScope]) scopes[defaultScope] = { id: defaultScope, paths: [], remotes: [], accounts: [] };

  const accounts: Record<string, Account> = {};
  for (const [key, value] of Object.entries(rawAccounts)) {
    id(key, `[accounts.${key}]`);
    accounts[key] = declaredAccount(key, table(value, `[accounts.${key}]`), workers, defaultScope, config.home);
  }
  for (const harness of HARNESS_IDS) {
    if (Object.values(accounts).some((a) => a.harness === harness)) continue;
    accounts[harness] = implicitAccount(harness, workers, defaultScope);
  }

  for (const account of Object.values(accounts)) {
    if (!scopes[account.scope]) throw new FlowrynError("config_invalid", `[accounts.${account.id}] scope ${account.scope} is not a scope; add [scopes.${account.scope}]`);
  }
  for (const account of Object.values(accounts)) checkOverflow(account, accounts);
  for (const scope of Object.values(scopes)) {
    for (const ref of scope.accounts) {
      const account = accounts[ref];
      if (!account) throw new FlowrynError("config_invalid", `[scopes.${scope.id}] accounts: no account ${ref}`);
      if (account.scope !== scope.id) throw new FlowrynError("config_invalid", `[scopes.${scope.id}] accounts: ${ref} belongs to scope ${account.scope}`);
    }
  }
  return { accounts, scopes, default_scope: defaultScope };
}

/** One account by id, as config has it now. */
export function accountById(config: FlowrynConfig, accountId: string): Account {
  const account = accountsConfig(config).accounts[accountId];
  if (!account) throw new FlowrynError("not_found", `no account ${accountId}`, "flowryn accounts");
  return account;
}

/**
 * The account a run's capacity is kept under, by its recorded id (null: the
 * harness's implicit account), with no scope check: the usage pause and the
 * quota floor are per login. Null when config no longer has it.
 */
export function capacityAccount(config: FlowrynConfig, accountId: string | null, harness: HarnessId): Account | null {
  const accounts = accountsConfig(config);
  const wanted = accountId ?? harness;
  return accounts.accounts[wanted] ?? (wanted === harness ? implicitAccount(harness, workersConfig(config), accounts.default_scope) : null);
}

/** The accounts of one harness in config order (its implicit account when none is declared). */
export function harnessAccounts(config: FlowrynConfig, harness: HarnessId): Account[] {
  return Object.values(accountsConfig(config).accounts).filter((a) => a.harness === harness);
}

/**
 * The harness's default account: what a run of a project in `[scopes] default`
 * starts on (that scope's first account of the harness), else the harness's
 * first account in config order. Without `[accounts]` it is the implicit one.
 */
export function defaultAccount(config: FlowrynConfig, harness: HarnessId): Account {
  const accounts = accountsConfig(config);
  const rule = accounts.scopes[accounts.default_scope]!;
  const ordered = [...rule.accounts, ...Object.keys(accounts.accounts).filter((a) => !rule.accounts.includes(a))].map((a) => accounts.accounts[a]!);
  return ordered.find((a) => a.harness === harness && a.scope === accounts.default_scope) ?? ordered.find((a) => a.harness === harness) ?? implicitAccount(harness, workersConfig(config), accounts.default_scope);
}

/** The directory a Claude account keeps its login and transcripts in. */
export function claudeConfigDir(account: Account, env: Record<string, string | undefined> = process.env): string {
  if (account.config_dir) return account.config_dir;
  // A declared account without config_dir is Claude's default login; the implicit one inherits the environment's.
  if (!account.declared && env.CLAUDE_CONFIG_DIR) return env.CLAUDE_CONFIG_DIR;
  return join(env.HOME ?? homedir(), ".claude");
}

function real(path: string): string {
  return existsSync(path) ? realpathSync(path) : normalize(path);
}

/**
 * The Claude account a session's transcript belongs to: Claude keeps
 * transcripts in `<config dir>/projects/`. Null when no account's directory
 * holds it (the caller decides the fallback).
 */
export function accountOfTranscript(config: FlowrynConfig, transcriptPath: string | null): Account | null {
  if (!transcriptPath) return null;
  const transcript = real(transcriptPath);
  return harnessAccounts(config, "claude").find((a) => transcript.startsWith(`${real(join(claudeConfigDir(a), "projects"))}/`)) ?? null;
}

// --- a project's scope and a run's account ------------------------------------------------------

/** What scoping needs from a project. */
export interface ScopedProject {
  id: string;
  path: string;
  repo_url: string;
  harness: HarnessId;
}

function projectSettings(config: FlowrynConfig, projectId: string): { scope: string | null; account: string | null } {
  const projects = table(config.extra.projects, "[projects]");
  const raw = table(projects[projectId], `[projects.${projectId}]`);
  return { scope: optString(raw.scope, `[projects.${projectId}] scope`), account: optString(raw.account, `[projects.${projectId}] account`) };
}

function underPrefix(path: string, prefix: string): boolean {
  return prefix === "/" || path === prefix || path.startsWith(`${prefix}/`);
}

function remoteMatches(remote: string, prefix: string): boolean {
  return remote === prefix.replace(/\/$/, "") || remote.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

/** The scopes whose path or remote rules match the project, in config order. */
export function matchingScopes(accounts: AccountsConfig, project: ScopedProject): string[] {
  const path = existsSync(project.path) ? realpathSync(project.path) : normalize(project.path);
  const remote = project.repo_url ? normalizeRemote(project.repo_url) : null;
  return Object.values(accounts.scopes)
    .filter((s) => s.paths.some((p) => underPrefix(path, p)) || (remote !== null && s.remotes.some((r) => remoteMatches(remote, r))))
    .map((s) => s.id);
}

/**
 * The project's scope: `[projects.<id>] scope`, else the one scope whose path
 * or remote rules match, else `[scopes] default`. An explicit scope that the
 * rules contradict, or rules matching two scopes, refuse: a mistyped tag must
 * never quietly win.
 */
export function projectScope(config: FlowrynConfig, accounts: AccountsConfig, project: ScopedProject): string {
  const own = projectSettings(config, project.id);
  const matched = matchingScopes(accounts, project);
  if (own.scope !== null) {
    if (!accounts.scopes[own.scope]) throw new FlowrynError("config_invalid", `[projects.${project.id}] scope ${own.scope} is not a scope`);
    if (matched.length > 0 && !matched.includes(own.scope)) {
      throw new FlowrynError("config_invalid", `[projects.${project.id}] scope is ${own.scope}, but its path or remote puts it in ${matched.join(" and ")}`, "fix the project's scope or the [scopes] rules");
    }
    return own.scope;
  }
  if (matched.length > 1) throw new FlowrynError("config_invalid", `project ${project.id} matches scopes ${matched.join(" and ")}`, `set [projects.${project.id}] scope`);
  return matched[0] ?? accounts.default_scope;
}

/** What a start asks for: an account by name (dispatch --account, a phase's account: line) or a harness. */
export interface AccountRequest {
  account?: string | null;
  harness?: HarnessId | null;
}

/** Refuse an account outside the project's scope. There is no override. */
export function guardScope(account: Account, scope: string, projectId: string): void {
  if (account.scope !== scope) {
    throw new FlowrynError("account_scope_mismatch", `account ${account.id} is in scope ${account.scope}, but project ${projectId} is in scope ${scope}; a run starts only on an account of its project's scope`, "flowryn accounts");
  }
}

/**
 * The account a new run starts on, first match wins: the requested account,
 * then `[projects.<id>] account`, then the scope's first account of the
 * harness (the requested one, else the project's). The account's scope must
 * be the project's.
 */
export function resolveAccount(config: FlowrynConfig, project: ScopedProject, request: AccountRequest = {}): Account {
  const accounts = accountsConfig(config);
  const scope = projectScope(config, accounts, project);
  const wanted = request.harness ?? null;
  const pick = (accountId: string, where: string): Account => {
    const account = accounts.accounts[accountId];
    if (!account) throw new FlowrynError("not_found", `${where}: no account ${accountId}`, "flowryn accounts");
    if (wanted !== null && account.harness !== wanted) throw new FlowrynError("bad_args", `account ${accountId} is a ${account.harness} account, not ${wanted}`);
    guardScope(account, scope, project.id);
    return account;
  };
  if (request.account) return pick(request.account, "--account");
  const own = projectSettings(config, project.id).account;
  if (own !== null && (wanted === null || accounts.accounts[own]?.harness === wanted)) return pick(own, `[projects.${project.id}] account`);
  const harness = wanted ?? project.harness;
  const rule = accounts.scopes[scope]!;
  const ordered = [...rule.accounts, ...Object.keys(accounts.accounts).filter((a) => !rule.accounts.includes(a))];
  const found = ordered.map((a) => accounts.accounts[a]!).find((a) => a.harness === harness && a.scope === scope);
  if (!found) throw new FlowrynError("no_account", `scope ${scope} (project ${project.id}) has no ${harness} account`, `add an [accounts.<id>] with harness = "${harness}" and scope = "${scope}"`);
  return found;
}

/**
 * The account a run recorded at dispatch, as config has it now. A resume never
 * moves to another account, since the harness keeps the session in the
 * account's own store: a removed account, or one moved out of the project's
 * scope, refuses. A run recorded on a harness's implicit account keeps its
 * `[workers.<harness>]` login after accounts of that harness are declared.
 */
export function runAccount(config: FlowrynConfig, project: ScopedProject, recorded: string | null, harness: HarnessId): Account {
  const accounts = accountsConfig(config);
  const accountId = recorded ?? harness;
  const account = accounts.accounts[accountId] ?? (accountId === harness ? implicitAccount(harness, workersConfig(config), accounts.default_scope) : undefined);
  if (!account) throw new FlowrynError("not_found", `the run's account ${accountId} is no longer in config.toml`, "add it back, or cancel the run");
  if (account.harness !== harness) throw new FlowrynError("config_invalid", `the run's account ${accountId} is now a ${account.harness} account, but the run is on ${harness}`);
  guardScope(account, projectScope(config, accounts, project), project.id);
  return account;
}

/**
 * `[workers]` as one account launches it: the account's login over the harness's own settings, and
 * the model and effort the run resolved (src/config/model-choice.ts), else the account's.
 */
export function workersFor(workers: WorkersConfig, account: Account, choice: { model: string | null; effort: string | null } = account): WorkersConfig {
  const { model, effort } = choice;
  if (account.harness === "claude") {
    return { ...workers, claude: { ...workers.claude, model, effort, config_dir: account.config_dir, pin_login: account.declared || account.config_dir !== null } };
  }
  return { ...workers, pi: { ...workers.pi, model, effort, agent_dir: account.agent_dir, provider: account.provider } };
}

/** The resolved view for `flowryn config` and doctor. */
export function accountsView(config: FlowrynConfig): Record<string, unknown> {
  const accounts = accountsConfig(config);
  return {
    default_scope: accounts.default_scope,
    scopes: accounts.scopes,
    accounts: Object.fromEntries(Object.values(accounts.accounts).map((a) => [a.id, { ...a, source: a.declared ? "config" : `implicit, from [workers.${a.harness}]` }])),
  };
}
