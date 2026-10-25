import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { FlowrynError } from "../api/errors.ts";
import { accountsConfig, CLAUDE_CREDENTIAL_ENV, type Account } from "../config/accounts.ts";
import type { FlowrynConfig } from "../config/config.ts";
import type { LeaderHarness, LeaderSessionRow } from "../lease/lease.ts";

/**
 * Which account a leader runs on (docs/notes/2026-10-24-leader-scoping-and-vj.md).
 * `flowryn lead` picks it in your terminal, from `--account` or from the login
 * folder your terminal points at, and launches the harness on that login; the
 * session's first hook then reports the folder it really runs on, and the
 * daemon checks the two agree. The account's scope is the session's.
 */

/** The login folder a session's hook reports from its own environment. */
export interface ReportedLogin {
  /** Claude: CLAUDE_CONFIG_DIR in the hook's environment ("" or null: Claude's default ~/.claude). */
  config_dir?: string | null;
  /** Pi: PI_CODING_AGENT_DIR in the hook's environment (null: Pi's default ~/.pi/agent). */
  agent_dir?: string | null;
}

function real(path: string): string {
  return existsSync(path) ? realpathSync(path) : normalize(path).replace(/\/+$/, "");
}

function claudeDefault(home: string): string {
  return join(home, ".claude");
}

function piDefault(home: string): string {
  return join(home, ".pi", "agent");
}

/**
 * The folder a declared account's login lives in, as a leader launch sets it. Null for a harness's
 * implicit account (a home with no `[accounts]`): its leader keeps whatever login your terminal
 * has, as before accounts, since `[workers.*]` names the workers' login, not the leader's.
 */
export function loginDir(account: Account, home = homedir()): string | null {
  if (!account.declared) return null;
  if (account.harness === "claude") return account.config_dir ?? claudeDefault(home);
  return account.agent_dir ?? piDefault(home);
}

/** The login folder your terminal points the harness at. */
function terminalDir(harness: LeaderHarness, env: NodeJS.ProcessEnv, home: string): string {
  if (harness === "claude") return env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.length > 0 ? env.CLAUDE_CONFIG_DIR : claudeDefault(home);
  return env.PI_CODING_AGENT_DIR && env.PI_CODING_AGENT_DIR.length > 0 ? env.PI_CODING_AGENT_DIR : piDefault(home);
}

function accountList(accounts: Account[]): string {
  return accounts.map((a) => `${a.id} (${a.scope}, ${loginDir(a) ?? "your terminal's login"})`).join(", ");
}

/**
 * The account a leader starts on: the one you name, else the one whose login folder is the one
 * your terminal points at. Refuses when none matches, or several do: a leader never guesses its scope.
 */
export function leaderAccount(config: FlowrynConfig, harness: LeaderHarness, requested: string | null, env: NodeJS.ProcessEnv = process.env): Account {
  const accounts = accountsConfig(config);
  const mine = Object.values(accounts.accounts).filter((a) => a.harness === harness);
  if (requested) {
    const account = accounts.accounts[requested];
    if (!account) throw new FlowrynError("not_found", `no account ${requested}`, "flowryn accounts");
    if (account.harness !== harness) throw new FlowrynError("bad_args", `account ${requested} is a ${account.harness} account; lead with ${account.harness === "pi" ? "--pi" : "Claude"}`);
    return account;
  }
  const home = env.HOME ?? homedir();
  // One account of the harness that keeps your terminal's login: nothing to choose between.
  if (mine.length === 1 && loginDir(mine[0]!, home) === null) return mine[0]!;
  const here = real(terminalDir(harness, env, home));
  const matched = mine.filter((a) => {
    const dir = loginDir(a, home);
    return dir !== null && real(dir) === here;
  });
  if (matched.length === 1) return matched[0]!;
  const variable = harness === "claude" ? "CLAUDE_CONFIG_DIR" : "PI_CODING_AGENT_DIR";
  if (matched.length === 0) {
    throw new FlowrynError("not_found", `no ${harness} account logs in at ${here} (your ${variable}); a leader leads its account's scope, so it needs one`, `flowryn lead${harness === "pi" ? " --pi" : ""} --account <id>, one of: ${accountList(mine)}`);
  }
  throw new FlowrynError("bad_args", `${matched.length} ${harness} accounts log in at ${here}: ${matched.map((a) => a.id).join(", ")}`, `name one: flowryn lead${harness === "pi" ? " --pi" : ""} --account <id>`);
}

/**
 * The harness's environment for an account's login, the way a worker gets it
 * (src/harness/claude/adapter.ts): a pinned Claude login sets or unsets
 * CLAUDE_CONFIG_DIR and drops the credential variables Claude ranks above a
 * stored login; a Pi account names its agent folder. The implicit account
 * changes nothing. Mutates `env`.
 */
export function applyLogin(env: Record<string, string>, account: Account): void {
  // The implicit account leaves your terminal's login alone (loginDir).
  if (!account.declared) return;
  if (account.harness === "claude") {
    for (const key of CLAUDE_CREDENTIAL_ENV) delete env[key];
    if (account.config_dir) env.CLAUDE_CONFIG_DIR = account.config_dir;
    else delete env.CLAUDE_CONFIG_DIR;
    return;
  }
  if (account.agent_dir) env.PI_CODING_AGENT_DIR = account.agent_dir;
}

/** Pi's provider and model for a declared Pi account, ahead of your own harness arguments. */
export function loginArgs(account: Account): string[] {
  if (account.harness !== "pi" || !account.declared || !account.provider || !account.model) return [];
  return ["--provider", account.provider, "--model", account.model];
}

/**
 * Does what the session's first hook reports match the account it was started on? Returns the
 * problem, or null. A session with no recorded account (opened before accounts were recorded) and
 * the implicit Claude account that keeps your terminal's login are not checked.
 */
export function confirmLogin(config: FlowrynConfig, session: Pick<LeaderSessionRow, "account" | "harness">, seen: { transcriptPath: string | null; login: ReportedLogin | null }, home = homedir()): string | null {
  if (!session.account) return null;
  let account: Account | undefined;
  try {
    account = accountsConfig(config).accounts[session.account];
  } catch (error) {
    return `config cannot be read: ${(error as Error).message}`;
  }
  if (!account) return `account ${session.account} is no longer in config.toml`;
  if (account.harness !== session.harness) return `account ${session.account} is a ${account.harness} account`;
  const expected = loginDir(account, home);
  if (expected === null) return null;
  const want = real(expected);
  if (seen.login) {
    const reported = account.harness === "claude" ? seen.login.config_dir : seen.login.agent_dir;
    const dir = reported && reported.length > 0 ? reported : account.harness === "claude" ? claudeDefault(home) : piDefault(home);
    if (real(dir) !== want) return `the hook runs on ${dir}, not ${expected}`;
  }
  if (account.harness === "claude" && seen.transcriptPath) {
    const transcript = real(seen.transcriptPath);
    if (!transcript.startsWith(`${real(join(expected, "projects"))}/`)) return `Claude's transcript ${seen.transcriptPath} is not under ${join(expected, "projects")}`;
  }
  return null;
}

/** Claude's projects folder for a leader session's account: where its chat-answer transcripts must live. */
export function sessionProjectsDir(config: FlowrynConfig, accountId: string | null, fallback: string, home = homedir()): string {
  if (!accountId) return fallback;
  let account: Account | undefined;
  try {
    account = accountsConfig(config).accounts[accountId];
  } catch {
    return fallback;
  }
  // The implicit account keeps [grants] claude_projects_dir, or the default from the daemon's environment, as before.
  if (!account || account.harness !== "claude" || !account.declared) return fallback;
  return join(loginDir(account, home)!, "projects");
}
