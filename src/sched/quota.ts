import { dirname } from "node:path";
import { findOpenItem, openItem, resolveItems } from "../attention/items.ts";
import type { Db } from "../db/db.ts";
import { getMeta, setMeta } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { sanitizeLine } from "../util/sanitize.ts";
import { RESUME_COMMAND } from "./usage.ts";

/**
 * The Claude quota floor (the toolkit report's Q4): before a new Claude run
 * starts, the scheduler reads quota-axi, and under the floor
 * (`[capacity.quota] floor`, an effectivePercentRemaining, default 5) no new
 * Claude run, Claude plan phase or auto contract check starts; runs already in
 * flight drain. The usage-limit pause (usage.ts) still stops everything once
 * the quota actually runs out.
 *
 * A reading that cannot be had (quota-axi missing, failing, slow, another
 * schema, a status other than known) is "unknown" and holds nothing: quota-axi
 * needs the network, and a broken probe must not stop all work.
 *
 * The state is recorded when it flips, with an event, and a P1 while it is
 * low. `flowryn capacity resume --harness claude` overrides a low reading
 * until the next reading that is not low.
 */

const KEY = "claude_quota";
/** quota-axi's argv after its path; fixed, so the reading always has its schema. */
export const QUOTA_ARGS = ["--provider", "claude", "--json", "--no-credential-refresh"] as const;
/** The JSON schema the parser was written against (quota-axi 0.1.37). */
export const QUOTA_SCHEMA = 5;
const PROBE_TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 1024 * 1024;

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
  /** You started Claude work anyway (capacity resume) while it is low. */
  override: boolean;
}

interface QuotaJson {
  schemaVersion?: unknown;
  providers?: {
    provider?: unknown;
    windows?: { id?: unknown; resetsAt?: unknown }[];
    quotaSemantics?: { effectiveAvailability?: { scope?: unknown; status?: unknown; effectivePercentRemaining?: unknown; limitingWindowIds?: unknown }[] };
  }[];
}

/** One quota-axi --json output, as the floor reads it: Claude's all-models effective availability. */
export function parseQuota(text: string): QuotaReading {
  let json: QuotaJson;
  try {
    json = JSON.parse(text) as QuotaJson;
  } catch {
    return { state: "unknown", detail: "quota-axi did not print JSON" };
  }
  if (json.schemaVersion !== QUOTA_SCHEMA) return { state: "unknown", detail: `quota-axi schema ${String(json.schemaVersion)}, not ${QUOTA_SCHEMA}` };
  const claude = json.providers?.find((p) => p.provider === "claude");
  if (!claude) return { state: "unknown", detail: "quota-axi reported no claude provider" };
  const all = claude.quotaSemantics?.effectiveAvailability?.find((a) => a.scope === "all_models");
  if (!all) return { state: "unknown", detail: "quota-axi reported no all_models availability for claude" };
  if (all.status !== "known") return { state: "unknown", detail: `claude availability is ${sanitizeLine(String(all.status), 30)}` };
  const percent = all.effectivePercentRemaining;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return { state: "unknown", detail: "claude effectivePercentRemaining is not a number" };
  const limiting = Array.isArray(all.limitingWindowIds) && typeof all.limitingWindowIds[0] === "string" ? all.limitingWindowIds[0] : null;
  const resets = limiting ? claude.windows?.find((w) => w.id === limiting)?.resetsAt : undefined;
  return { state: "known", percent, window: limiting ? sanitizeLine(limiting, 40) : null, resets_at: typeof resets === "string" ? sanitizeLine(resets, 40) : null };
}

/**
 * Run quota-axi once (no shell, a timeout). quota-axi is a node script, so
 * node's directory leads PATH, as for lavish-axi in doctor.
 */
export async function probeQuota(tool: string | null, node: string | null): Promise<QuotaReading> {
  if (!tool) return { state: "unknown", detail: "quota-axi is not installed" };
  const path = [node ? dirname(node) : null, dirname(tool), process.env.PATH ?? "/usr/bin:/bin"].filter(Boolean).join(":");
  try {
    const proc = Bun.spawn([tool, ...QUOTA_ARGS], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: path } });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, PROBE_TIMEOUT_MS);
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    if (timedOut) return { state: "unknown", detail: `quota-axi took over ${PROBE_TIMEOUT_MS / 1000} s` };
    if (code !== 0) return { state: "unknown", detail: `quota-axi exited ${code}${err.trim() ? `: ${sanitizeLine(err.trim().split("\n")[0]!, 120)}` : ""}` };
    if (out.length > MAX_OUTPUT) return { state: "unknown", detail: "quota-axi printed over 1 MB" };
    return parseQuota(out);
  } catch (error) {
    return { state: "unknown", detail: `quota-axi did not run: ${sanitizeLine((error as Error).message, 120)}` };
  }
}

export function quotaState(db: Db): QuotaState | null {
  const raw = getMeta(db, KEY);
  return raw ? (JSON.parse(raw) as QuotaState) : null;
}

export function judgeQuota(reading: QuotaReading, floor: number): QuotaVerdict {
  if (reading.state === "unknown") return "unknown";
  return reading.percent < floor ? "low" : "ok";
}

/** New Claude runs wait: the last reading was under the floor and you did not override it. */
export function quotaHolds(db: Db): boolean {
  const state = quotaState(db);
  return state !== null && state.state === "low" && !state.override;
}

function clock(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toTimeString().slice(0, 5);
}

function lowLine(state: QuotaState): string {
  const at = clock(state.resets_at);
  const window = state.window ? ` (${state.window})` : "";
  const until = at ? ` until it resets at ${at}` : "";
  return `Claude quota ${state.percent}%${window}, under the ${state.floor}% floor; new Claude runs wait${until}; ${RESUME_COMMAND} starts them anyway`;
}

/** One summary line for capacity and doctor. */
export function quotaLine(state: QuotaState): string {
  if (state.state === "unknown") return `unknown (${state.detail ?? "no reading"}); nothing waits on it`;
  const base = `claude ${state.percent}% (floor ${state.floor}%)`;
  if (state.state === "ok") return `${base} ok`;
  return state.override ? `${base} low; you started Claude work anyway` : `${base} low; new Claude runs wait`;
}

/**
 * Record a reading. Call inside a transaction. The state is written only when
 * its verdict changes (or the floor does), with an event; the P1 opens when it
 * turns low and resolves when it stops being low. Returns the current state.
 */
export function recordQuota(db: Db, reading: QuotaReading, floor: number, now: number): QuotaState {
  const previous = quotaState(db);
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
  setMeta(db, KEY, JSON.stringify(state));
  const event = appendEvent(db, { source: "daemon", kind: `sched.quota_${verdict}`, payload: { ...state, previous: previous?.state ?? null }, ts: now });
  if (verdict === "low") {
    if (!findOpenItem(db, "quota_low", null)) openItem(db, { kind: "quota_low", eventSeq: event.seq, line: lowLine(state), now });
  } else resolveItems(db, "quota_low", null, `quota ${verdict}`, now);
  return state;
}

/** You start Claude work anyway while the quota is low (capacity resume). Call inside a transaction; true when it was held. */
export function overrideQuota(db: Db, now: number): boolean {
  const state = quotaState(db);
  if (!state || state.state !== "low" || state.override) return false;
  setMeta(db, KEY, JSON.stringify({ ...state, override: true }));
  appendEvent(db, { source: "cli", kind: "sched.quota_override", payload: { percent: state.percent, floor: state.floor }, ts: now });
  resolveItems(db, "quota_low", null, "started anyway (flowryn capacity resume)", now);
  return true;
}
