import type { Account } from "../config/accounts.ts";
import { runBounded } from "../runtime/bounded.ts";
import { sanitizeLine } from "../util/sanitize.ts";

/**
 * Is a declared account's login signed in? Asked of the harness itself, in an
 * environment with only HOME, PATH, TMPDIR, USER, LOGNAME and the account's
 * own directory, so a credential variable in the daemon's environment cannot
 * answer for an empty login. Flowryn reads no credential: Claude's
 * `auth status` prints the login's kind, Pi's `auth check` without
 * --credentials prints a status, and --no-refresh keeps the check from
 * rewriting tokens other workers use.
 *
 * Returns null when signed in, else why not, with the command that signs it in.
 */

const CHECK_TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 256 * 1024;
const PASSED_TTL_MS = 5 * 60_000;

const passed = new Map<string, number>();

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["HOME", "PATH", "TMPDIR", "USER", "LOGNAME"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

async function run(argv: string[], env: Record<string, string>): Promise<{ ok: boolean; stdout: string; detail: string }> {
  const result = await runBounded(argv, { label: "sign-in check", timeoutMs: CHECK_TIMEOUT_MS, env, maxOutputBytes: MAX_OUTPUT });
  if (result.spawnError !== null) return { ok: false, stdout: "", detail: `did not run: ${sanitizeLine(result.spawnError, 120)}` };
  if (result.timedOut) return { ok: false, stdout: "", detail: `took over ${CHECK_TIMEOUT_MS / 1000} s` };
  if (result.incomplete) return { ok: false, stdout: "", detail: result.incomplete };
  return { ok: result.code === 0, stdout: result.stdout, detail: `exited ${result.code}` };
}

function json(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function claudeSignedIn(account: Account, binary: string): Promise<string | null> {
  const env = cleanEnv(account.config_dir ? { CLAUDE_CONFIG_DIR: account.config_dir } : {});
  const out = await run([binary, "auth", "status", "--json"], env);
  const status = json(out.stdout);
  if (out.ok && status?.loggedIn === true) return null;
  const why = status && status.loggedIn === false ? "not signed in" : `claude auth status ${out.detail}`;
  return `account ${account.id} (${account.config_dir ?? "Claude's default login"}): ${why}; sign in with ${loginCommand(account)}`;
}

async function piSignedIn(account: Account, binary: string): Promise<string | null> {
  const provider = account.provider!;
  const env = cleanEnv({ PI_CODING_AGENT_DIR: account.agent_dir! });
  const check = await run([binary, "auth", "check", "--provider", provider, "--json", "--no-refresh"], env);
  const status = json(check.stdout);
  if (status?.status === "ready") return null;
  let why = status ? `${sanitizeLine(String(status.status), 30)} ${sanitizeLine(String(status.reason ?? ""), 60)}`.trim() : `pi auth check ${check.detail}`;
  // An extension-registered provider is unknown to `auth check`, which loads no extensions; the model list knows it.
  if (!status || status.reason === "provider_not_found") {
    const list = await run([binary, "--list-models", provider], env);
    const listed = list.ok && list.stdout.split("\n").slice(1).some((line) => line.trim().split(/\s+/)[0] === provider);
    if (listed) return null;
    why = `no model listed for provider ${provider}`;
  }
  return `account ${account.id} (${account.agent_dir}, provider ${provider}): ${why}; sign in with ${loginCommand(account)}`;
}

/** The command that signs the account's login in, in your own terminal. */
export function loginCommand(account: Account): string {
  if (account.harness === "pi") return `PI_CODING_AGENT_DIR=${account.agent_dir} pi, then /login`;
  return account.config_dir ? `CLAUDE_CONFIG_DIR=${account.config_dir} claude, then /login` : "env -u CLAUDE_CONFIG_DIR claude, then /login";
}

/** Null when the account may launch now. Only a declared account is checked: the implicit one launches as Flowryn always has. */
export async function accountSignIn(account: Account, binary: string, now = Date.now()): Promise<string | null> {
  if (!account.declared) return null;
  const key = `${account.id}\0${account.config_dir ?? ""}\0${account.agent_dir ?? ""}\0${account.provider ?? ""}\0${binary}`;
  const at = passed.get(key);
  if (at !== undefined && now - at < PASSED_TTL_MS) return null;
  const why = account.harness === "claude" ? await claudeSignedIn(account, binary) : await piSignedIn(account, binary);
  if (why === null) passed.set(key, now);
  else passed.delete(key);
  return why;
}
