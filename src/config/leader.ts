import { FlowrynError } from "../api/errors.ts";
import type { FlowrynConfig } from "./config.ts";

/**
 * Typed views of the config sections M3 owns: [leader] (the leader clocks) and
 * [notify] (OS and Herdr notifications, design section 15). Like [reconcile],
 * [leader] exists for tests and the lab; every default is the design's number.
 */

export interface LeaderTiming {
  /** Busy is a lease the hooks refresh; nothing fires after an interrupt, so it expires (design section 5). */
  busy_lease_ms: number;
  /** A holder with no heartbeat this long, whose process is gone, is stale (design section 10). */
  stale_ms: number;
  /** Pi: idle, empty composer and no terminal input this long means you are inactive (design section 5). */
  inactive_ms: number;
  /** A digest the hook could not hand over this soon after it started is not carried (a timed-out hook's context is dropped). */
  digest_budget_ms: number;
  /** An actionable item open this long moves to the top of its lane (design section 9). */
  age_ms: number;
}

export const DEFAULT_LEADER_TIMING: LeaderTiming = {
  busy_lease_ms: 10 * 60_000,
  stale_ms: 10 * 60_000,
  inactive_ms: 60_000,
  digest_budget_ms: 1_500,
  age_ms: 24 * 60 * 60_000,
};

export interface NotifyConfig {
  /** macOS notifications through osascript. */
  macos: boolean;
  /** Herdr's notification.show, when a Herdr session is reachable. */
  herdr: boolean;
  /** At most one batched non-P0 notification this often. */
  min_interval_min: number;
  /** P0 notifications arriving within this window are coalesced into one. */
  p0_coalesce_s: number;
  /** Turns a P0 may start in a leader per hour; beyond that, notification only. */
  max_triggered_turns_per_hour: number;
  /** An unresolved P0 notifies again after this long. */
  p0_renotify_min: number;
}

export const DEFAULT_NOTIFY: NotifyConfig = {
  macos: true,
  herdr: true,
  min_interval_min: 30,
  p0_coalesce_s: 60,
  max_triggered_turns_per_hour: 3,
  p0_renotify_min: 240,
};

function table(value: unknown, where: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new FlowrynError("config_invalid", `${where} must be a table`);
  return value as Record<string, unknown>;
}

function positiveInts<T extends object>(raw: Record<string, unknown>, defaults: T, where: string, keys: readonly (keyof T)[]): T {
  const out = { ...defaults };
  for (const key of keys) {
    const value = raw[key as string];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new FlowrynError("config_invalid", `${where} ${String(key)} must be a positive integer`);
    (out as Record<string, unknown>)[key as string] = value;
  }
  return out;
}

export function leaderTiming(config: FlowrynConfig): LeaderTiming {
  const raw = table(config.extra.leader, "[leader]");
  for (const key of Object.keys(raw)) {
    if (!(key in DEFAULT_LEADER_TIMING)) throw new FlowrynError("config_invalid", `[leader] ${key} is not a known setting`);
  }
  return positiveInts(raw, DEFAULT_LEADER_TIMING, "[leader]", Object.keys(DEFAULT_LEADER_TIMING) as (keyof LeaderTiming)[]);
}

export function notifyConfig(config: FlowrynConfig): NotifyConfig {
  const raw = table(config.extra.notify, "[notify]");
  for (const key of Object.keys(raw)) {
    if (!(key in DEFAULT_NOTIFY)) throw new FlowrynError("config_invalid", `[notify] ${key} is not a known setting`);
  }
  const ints = ["min_interval_min", "p0_coalesce_s", "max_triggered_turns_per_hour", "p0_renotify_min"] as const;
  const out = positiveInts(raw, DEFAULT_NOTIFY, "[notify]", ints);
  for (const key of ["macos", "herdr"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") throw new FlowrynError("config_invalid", `[notify] ${key} must be true or false`);
    out[key] = value;
  }
  return out;
}

/** The terse style block is on unless [style] terse = false (design section 11). */
export function isTerse(config: FlowrynConfig): boolean {
  const style = config.extra.style as Record<string, unknown> | undefined;
  return style?.terse !== false;
}
