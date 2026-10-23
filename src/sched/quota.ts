import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findOpenItem, openItem, resolveItems } from "../attention/items.ts";
import { CLAUDE_CREDENTIAL_ENV, type Account } from "../config/accounts.ts";
import type { Db } from "../db/db.ts";
import { runBounded } from "../runtime/bounded.ts";
import { getMeta, setMeta } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { sanitizeLine } from "../util/sanitize.ts";
import { accountKey, resumeCommand } from "./usage.ts";

/**
 * The quota floor, per account (the toolkit report's Q4;
 * docs/notes/2026-10-22-multiple-ai-provider-u9.md): before a new run starts
 * on an account, the scheduler reads quota-axi for that account's login, and
 * under the floor (`[capacity.quota] floor`, an effectivePercentRemaining,
 * default 5) no new run, plan phase or auto contract check starts on it; runs
 * already in flight drain, and other accounts carry on. The usage-limit pause
 * (usage.ts) still stops the account once its quota actually runs out.
 *
 * quota-axi reads the login it is pointed at: a Claude account through
 * CLAUDE_CONFIG_DIR (deleted for Claude's default login), a Pi account through
 * PI_CODING_AGENT_DIR for the providers whose Pi store quota-axi reads.
 *
 * A reading that cannot be had (quota-axi missing, failing, slow, another
 * schema, a status other than known, a Pi provider it cannot read) is
 * "unknown" and holds nothing: quota-axi needs the network, and a broken
 * probe must not stop all work.
 *
 * The state is recorded when it flips, with an event, and a P1 while it is
 * low. `flowryn capacity resume --account <id>` overrides a low reading until
 * the next reading that is not low.
 */

const PREFIX = "quota:";
/** Before accounts, one Claude state for the whole home (moved by legacy.ts). */
export const LEGACY_KEY = "claude_quota";
/** quota-axi's argv after its path for Claude; fixed, so the reading always has its schema. */
export const QUOTA_ARGS = ["--provider", "claude", "--json", "--no-credential-refresh"] as const;
/** The JSON schema the parser was written against (quota-axi 0.1.37). */
export const QUOTA_SCHEMA = 5;
const PROBE_TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 1024 * 1024;

/**
 * The Pi providers whose login quota-axi 0.1.37 reads from Pi's own store
 * (`<agent dir>/auth.json`), and the quota-axi provider that reports it. Its
 * report names the source only under --full; a reading from any other source
 * (the provider's own CLI login) is not this account's.
 */
export const PI_QUOTA_PROVIDERS: Readonly<Record<string, string>> = { "openai-codex": "codex", "kimi-coding": "kimi", xai: "grok" };

export type QuotaReading =
  | { state: "known"; percent: number; window: string | null; resets_at: string | null }
  | { state: "unknown"; detail: string };

export type QuotaVerdict = "ok" | "low" | "unknown";

export interface QuotaState {
  state: QuotaVerdict;
  /** effectivePercentRemaining when it was read; null when unknown. */
  percent: number | null;
  floor: number;
  /** The window that limits it (quota-axi's limitingWindowIds), and when that window resets. */
  window: string | null;
  resets_at: string | null;
  detail: string | null;
  since: number;
  /** You started work on the account anyway (capacity resume) while it is low. */
  override: boolean;
}

interface QuotaJson {
  schemaVersion?: unknown;
  providers?: {
    provider?: unknown;
    source?: unknown;
    windows?: { id?: unknown; resetsAt?: unknown }[];
    quotaSemantics?: { effectiveAvailability?: { scope?: unknown; status?: unknown; effectivePercentRemaining?: unknown; limitingWindowIds?: unknown }[] };
  }[];
}

/**
 * One quota-axi --json output, as the floor reads it: the provider's
 * all-models effective availability. With `source`, the reading counts only
 * when quota-axi says it came from there.
 */
export function parseQuota(text: string, provider = "claude", source: string | null = null): QuotaReading {
  let json: QuotaJson;
  try {
    json = JSON.parse(text) as QuotaJson;
  } catch {
    return { state: "unknown", detail: "quota-axi did not print JSON" };
  }
  if (json.schemaVersion !== QUOTA_SCHEMA) return { state: "unknown", detail: `quota-axi schema ${String(json.schemaVersion)}, not ${QUOTA_SCHEMA}` };
  const entry = json.providers?.find((p) => p.provider === provider);
  if (!entry) return { state: "unknown", detail: `quota-axi reported no ${provider} provider` };
  if (source !== null && entry.source !== source) return { state: "unknown", detail: `quota-axi read ${sanitizeLine(String(entry.source ?? "no source"), 40)}, not ${source}` };
  const all = entry.quotaSemantics?.effectiveAvailability?.find((a) => a.scope === "all_models");
  if (!all) return { state: "unknown", detail: `quota-axi reported no all_models availability for ${provider}` };
  if (all.status !== "known") return { state: "unknown", detail: `${provider} availability is ${sanitizeLine(String(all.status), 30)}` };
  const percent = all.effectivePercentRemaining;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return { state: "unknown", detail: `${provider} effectivePercentRemaining is not a number` };
  const limiting = Array.isArray(all.limitingWindowIds) && typeof all.limitingWindowIds[0] === "string" ? all.limitingWindowIds[0] : null;
  const resets = limiting ? entry.windows?.find((w) => w.id === limiting)?.resetsAt : undefined;
  return { state: "known", percent, window: limiting ? sanitizeLine(limiting, 40) : null, resets_at: typeof resets === "string" ? sanitizeLine(resets, 40) : null };
}

/** How quota-axi reads one account: its argv, what to parse, and the environment changes that point it at the login. */
export interface QuotaTarget {
  args: readonly string[];
  provider: string;
  source: string | null;
  set: Record<string, string>;
  unset: string[];
  /** Variables pointed at an empty directory for the probe, so the provider's own login cannot answer. */
  empty: string[];
}

/** Null (with why) when quota-axi cannot read this account's login. */
export function quotaTarget(account: Account | undefined): QuotaTarget | { none: string } {
  if (!account) return { args: QUOTA_ARGS, provider: "claude", source: null, set: {}, unset: [], empty: [] };
  if (account.harness === "claude") {
    // The implicit account launches on the inherited login (or [workers.claude] config_dir) and is read the same way.
    if (!account.declared) return { args: QUOTA_ARGS, provider: "claude", source: null, set: account.config_dir ? { CLAUDE_CONFIG_DIR: account.config_dir } : {}, unset: [], empty: [] };
    return {
      args: QUOTA_ARGS,
      provider: "claude",
      source: null,
      set: account.config_dir ? { CLAUDE_CONFIG_DIR: account.config_dir } : {},
      unset: [...CLAUDE_CREDENTIAL_ENV, ...(account.config_dir ? [] : ["CLAUDE_CONFIG_DIR"])],
      empty: [],
    };
  }
  const provider = account.provider ? PI_QUOTA_PROVIDERS[account.provider] : undefined;
  if (!account.provider || !account.agent_dir) return { none: `account ${account.id} names no Pi provider` };
  if (!provider) return { none: `quota-axi cannot read Pi provider ${sanitizeLine(account.provider, 40)}` };
  return {
    args: ["--provider", provider, "--json", "--full", "--no-credential-refresh"],
    provider,
    source: `pi:${account.provider}`,
    set: { PI_CODING_AGENT_DIR: account.agent_dir },
    unset: [],
    empty: provider === "codex" ? ["CODEX_HOME"] : [],
  };
}

/** The probe's environment: the daemon's, pointed at the account's login. */
export function quotaEnv(target: QuotaTarget, path: string, emptyDir: string | null, base: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !target.unset.includes(k)) env[k] = v;
  Object.assign(env, target.set, { PATH: path });
  if (emptyDir) for (const k of target.empty) env[k] = emptyDir;
  return env;
}

/**
 * Run quota-axi once for an account (no shell, a timeout); without one, as
 * Flowryn always has. quota-axi is a node script, so node's directory leads
 * PATH, as for lavish-axi in doctor.
 */
export async function probeQuota(tool: string | null, node: string | null, account?: Account, timeoutMs = PROBE_TIMEOUT_MS): Promise<QuotaReading> {
  const target = quotaTarget(account);
  if ("none" in target) return { state: "unknown", detail: target.none };
  if (!tool) return { state: "unknown", detail: "quota-axi is not installed" };
  const path = [node ? dirname(node) : null, dirname(tool), process.env.PATH ?? "/usr/bin:/bin"].filter(Boolean).join(":");
  const emptyDir = target.empty.length > 0 ? mkdtempSync(join(tmpdir(), "fl-quota-")) : null;
  try {
    const result = await runBounded([tool, ...target.args], { label: "quota-axi", timeoutMs, env: quotaEnv(target, path, emptyDir), maxOutputBytes: MAX_OUTPUT + 1 });
    if (result.spawnError !== null) throw new Error(result.spawnError);
    const { stdout: out, stderr: err, code } = result;
    if (result.timedOut) return { state: "unknown", detail: `quota-axi took over ${timeoutMs / 1000} s` };
    if (result.incomplete) return { state: "unknown", detail: out.length > MAX_OUTPUT ? "quota-axi printed over 1 MB" : `quota-axi ${result.incomplete}` };
    if (code !== 0) return { state: "unknown", detail: `quota-axi exited ${code}${err.trim() ? `: ${sanitizeLine(err.trim().split("\n")[0]!, 120)}` : ""}` };
    if (out.length > MAX_OUTPUT) return { state: "unknown", detail: "quota-axi printed over 1 MB" };
    return parseQuota(out, target.provider, target.source);
  } catch (error) {
    return { state: "unknown", detail: `quota-axi did not run: ${sanitizeLine((error as Error).message, 120)}` };
  } finally {
    if (emptyDir) rmSync(emptyDir, { recursive: true, force: true });
  }
}

export function quotaState(db: Db, account: string): QuotaState | null {
  const raw = getMeta(db, `${PREFIX}${account}`);
  return raw ? (JSON.parse(raw) as QuotaState) : null;
}

/** Every account's recorded quota state, by account id. */
export function quotaStates(db: Db): Map<string, QuotaState> {
  const rows = db.query("SELECT key, value FROM meta WHERE key LIKE 'quota:%' AND value != '' ORDER BY key").all() as { key: string; value: string }[];
  return new Map(rows.map((r) => [r.key.slice(PREFIX.length), JSON.parse(r.value) as QuotaState]));
}

export function judgeQuota(reading: QuotaReading, floor: number): QuotaVerdict {
  if (reading.state === "unknown") return "unknown";
  return reading.percent < floor ? "low" : "ok";
}

/** New runs on this account wait: its last reading was under the floor and you did not override it. */
export function quotaHolds(db: Db, account: string): boolean {
  const state = quotaState(db, account);
  return state !== null && state.state === "low" && !state.override;
}

/** The accounts whose quota holds new runs now. */
export function heldQuotaAccounts(db: Db): string[] {
  return [...quotaStates(db)].filter(([, s]) => s.state === "low" && !s.override).map(([a]) => a);
}

function clock(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toTimeString().slice(0, 5);
}

function lowLine(account: string, state: QuotaState): string {
  const at = clock(state.resets_at);
  const window = state.window ? ` (${state.window})` : "";
  const until = at ? ` until it resets at ${at}` : "";
  return `Account ${account}: quota ${state.percent}%${window}, under the ${state.floor}% floor; new runs on ${account} wait${until}; ${resumeCommand(account)} starts them anyway`;
}

/** One summary line for capacity, accounts and doctor. */
export function quotaLine(state: QuotaState): string {
  if (state.state === "unknown") return `unknown (${state.detail ?? "no reading"}); nothing waits on it`;
  const base = `${state.percent}% (floor ${state.floor}%)`;
  if (state.state === "ok") return `${base} ok`;
  return state.override ? `${base} low; you started work on it anyway` : `${base} low; new runs on it wait`;
}

/**
 * Record a reading for an account. Call inside a transaction. The state is
 * written only when its verdict changes (or the floor does), with an event;
 * the P1 opens when it turns low and resolves when it stops being low.
 * Returns the current state.
 */
export function recordQuota(db: Db, account: string, reading: QuotaReading, floor: number, now: number): QuotaState {
  const previous = quotaState(db, account);
  const verdict = judgeQuota(reading, floor);
  if (previous && previous.state === verdict && previous.floor === floor) return previous;
  const state: QuotaState = {
    state: verdict,
    percent: reading.state === "known" ? reading.percent : null,
    floor,
    window: reading.state === "known" ? reading.window : null,
    resets_at: reading.state === "known" ? reading.resets_at : null,
    detail: reading.state === "unknown" ? reading.detail : null,
    since: now,
    override: false,
  };
  setMeta(db, `${PREFIX}${account}`, JSON.stringify(state));
  const event = appendEvent(db, { source: "daemon", kind: `sched.quota_${verdict}`, payload: { account, ...state, previous: previous?.state ?? null }, ts: now });
  const key = accountKey(account);
  if (verdict === "low") {
    if (!findOpenItem(db, "quota_low", key)) openItem(db, { kind: "quota_low", eventSeq: event.seq, taskId: key, line: lowLine(account, state), now });
  } else resolveItems(db, "quota_low", key, `quota ${verdict}`, now);
  return state;
}

/** You start work on the account anyway while its quota is low (capacity resume). Call inside a transaction; true when it was held. */
export function overrideQuota(db: Db, account: string, now: number): boolean {
  const state = quotaState(db, account);
  if (!state || state.state !== "low" || state.override) return false;
  setMeta(db, `${PREFIX}${account}`, JSON.stringify({ ...state, override: true }));
  appendEvent(db, { source: "cli", kind: "sched.quota_override", payload: { account, percent: state.percent, floor: state.floor }, ts: now });
  resolveItems(db, "quota_low", accountKey(account), "started anyway (flowryn capacity resume)", now);
  return true;
}
