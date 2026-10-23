import { FlowrynError } from "../api/errors.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FlowrynConfig } from "./config.ts";

/**
 * Typed views of the config sections M3 owns: [leader] (the leader clocks) and
 * [notify] (OS and Herdr notifications, design section 15), and the later
 * [away], [grants] and [review]. Like [reconcile],
 * [leader] exists for tests and the lab; every default is the design's number.
 */

export interface LeaderTiming {
  /** Busy is a lease the hooks refresh; nothing fires after an interrupt, so it expires (design section 5). */
  busy_lease_ms: number;
  /** A holder with no heartbeat this long, whose process is gone, is stale (design section 10). */
  stale_ms: number;
  /** Pi: idle, empty composer and no terminal input this long means you are inactive (design section 5). */
  inactive_ms: number;
  /**
   * A digest the hook cannot hand over this soon after its process started is
   * not carried: the CLI gives up on a slow daemon after about 2 s, and a hook
   * that prints nothing hands nothing to the model.
   */
  digest_budget_ms: number;
  /** An actionable item open this long moves to the top of its lane (design section 9). */
  age_ms: number;
  /** Worker questions opened within this long of the first one wake an idle leader once, together. */
  question_batch_ms: number;
  /**
   * A Claude leader holding the lease with no waiter this long, while a wake
   * is due, gets the daemon's fixed rewake line typed into its pane
   * (src/leader/rewake.ts); at most once per this window.
   */
  waiter_grace_ms: number;
}

export const DEFAULT_LEADER_TIMING: LeaderTiming = {
  busy_lease_ms: 10 * 60_000,
  stale_ms: 10 * 60_000,
  inactive_ms: 60_000,
  digest_budget_ms: 2_000,
  age_ms: 24 * 60 * 60_000,
  question_batch_ms: 30_000,
  waiter_grace_ms: 30_000,
};

export interface NotifyConfig {
  /** macOS notifications through osascript: on unless your config says `macos = false` (flowryn init asks). */
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
  /** Turns a batch of worker questions may start in a leader per hour, apart from the P0 budget; beyond that, your next message carries them. */
  max_question_wakes_per_hour: number;
}

export const DEFAULT_NOTIFY: NotifyConfig = {
  macos: true,
  herdr: true,
  min_interval_min: 30,
  p0_coalesce_s: 60,
  max_triggered_turns_per_hour: 3,
  p0_renotify_min: 240,
  max_question_wakes_per_hour: 6,
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
  const ints = ["min_interval_min", "p0_coalesce_s", "max_triggered_turns_per_hour", "p0_renotify_min", "max_question_wakes_per_hour"] as const;
  const out = positiveInts(raw, DEFAULT_NOTIFY, "[notify]", ints);
  for (const key of ["macos", "herdr"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") throw new FlowrynError("config_invalid", `[notify] ${key} must be true or false`);
    out[key] = value;
  }
  return out;
}

/** [away]: away mode (`flowryn away`), which changes how items reach you, never who may act. */
export interface AwayConfig {
  /** Turns the P0 push path may start in a leader per hour while you are away, in place of max_triggered_turns_per_hour. */
  max_wakes_per_hour: number;
  /** How long away lasts when `flowryn away` names no --until. */
  default_hours: number;
  /** Inactive this long, with an item that would have woken the leader, before your next message suggests `flowryn away` (only while auto_after_min is 0). */
  suggest_after_min: number;
  /** No input from you this long and away starts by itself; your next message ends it. 0 turns it off. */
  auto_after_min: number;
}

export const DEFAULT_AWAY: AwayConfig = {
  max_wakes_per_hour: 6,
  default_hours: 12,
  suggest_after_min: 60,
  auto_after_min: 120,
};

export function awayConfig(config: FlowrynConfig): AwayConfig {
  const raw = table(config.extra.away, "[away]");
  for (const key of Object.keys(raw)) {
    if (!(key in DEFAULT_AWAY)) throw new FlowrynError("config_invalid", `[away] ${key} is not a known setting`);
  }
  const out = positiveInts(raw, DEFAULT_AWAY, "[away]", ["max_wakes_per_hour", "default_hours", "suggest_after_min"]);
  const auto = raw.auto_after_min;
  if (auto !== undefined) {
    if (typeof auto !== "number" || !Number.isInteger(auto) || auto < 0) throw new FlowrynError("config_invalid", "[away] auto_after_min must be a whole number of minutes (0 turns it off)");
    out.auto_after_min = auto;
  }
  return out;
}

/** [grants]: chat-answer grants (docs/notes/2026-10-10-chat-answers-authorise-5g.md). */
export interface GrantsConfig {
  /** Claude's projects directory, where a leader's transcript must live for its chat answers to count. */
  claude_projects_dir: string;
}

/** Claude keeps transcripts in $CLAUDE_CONFIG_DIR/projects, by default ~/.claude/projects. */
export function defaultClaudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.length > 0 ? env.CLAUDE_CONFIG_DIR : join(env.HOME ?? homedir(), ".claude"), "projects");
}

export function grantsConfig(config: FlowrynConfig, env: NodeJS.ProcessEnv = process.env): GrantsConfig {
  const raw = table(config.extra.grants, "[grants]");
  for (const key of Object.keys(raw)) {
    if (key !== "claude_projects_dir") throw new FlowrynError("config_invalid", `[grants] ${key} is not a known setting`);
  }
  const dir = raw.claude_projects_dir;
  if (dir !== undefined && (typeof dir !== "string" || dir.length === 0)) throw new FlowrynError("config_invalid", "[grants] claude_projects_dir must be a path");
  return { claude_projects_dir: typeof dir === "string" ? dir : defaultClaudeProjectsDir(env) };
}

/** [review]: review pages opened in your browser when a gate opens (docs/notes/2026-10-10-review-pages-open-4b.md). */
export interface ReviewConfig {
  /** Open each review gate's page in your browser once Flowryn's Lavish poll listens on it. */
  open_browser: boolean;
  /** The macOS application `open -a` hands the page to. */
  browser: string;
  /** How long a review page's Lavish poll fails before a review_channel item opens (src/lavish/channel.ts). */
  channel_alert_ms: number;
}

/** The default `[review] channel_alert_ms`: two minutes of failed polls. */
export const DEFAULT_CHANNEL_ALERT_MS = 120_000;

export const DEFAULT_REVIEW: ReviewConfig = { open_browser: true, browser: "Google Chrome", channel_alert_ms: DEFAULT_CHANNEL_ALERT_MS };

const MAX_BROWSER_NAME = 100;

function hasControlChars(text: string): boolean {
  return [...text].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
}

export function reviewConfig(config: FlowrynConfig): ReviewConfig {
  const raw = table(config.extra.review, "[review]");
  for (const key of Object.keys(raw)) {
    if (!(key in DEFAULT_REVIEW)) throw new FlowrynError("config_invalid", `[review] ${key} is not a known setting`);
  }
  const out = { ...DEFAULT_REVIEW };
  if (raw.open_browser !== undefined) {
    if (typeof raw.open_browser !== "boolean") throw new FlowrynError("config_invalid", "[review] open_browser must be true or false");
    out.open_browser = raw.open_browser;
  }
  if (raw.browser !== undefined) {
    const name = raw.browser;
    // An application name goes to `open -a` as one argument; no control characters, no leading dash.
    if (typeof name !== "string" || name.trim().length === 0 || name.length > MAX_BROWSER_NAME || hasControlChars(name) || name.startsWith("-")) {
      throw new FlowrynError("config_invalid", `[review] browser must be an application name (at most ${MAX_BROWSER_NAME} characters), like "Google Chrome"`);
    }
    out.browser = name;
  }
  if (raw.channel_alert_ms !== undefined) {
    const ms = raw.channel_alert_ms;
    if (typeof ms !== "number" || !Number.isInteger(ms) || ms < 0) throw new FlowrynError("config_invalid", "[review] channel_alert_ms must be a whole number of milliseconds, 0 or more");
    out.channel_alert_ms = ms;
  }
  return out;
}

/**
 * The notification override for everything that is not your own setup: tests,
 * the fixtures, the spikes, the contract suites and the live runs set
 * FLOWRYN_NOTIFY=off (or FLOWRYN_NOTIFIER=null). The daemon still decides
 * and records each notification (the rows and events stay the same), but
 * delivers nothing on any channel, whatever config.toml says.
 */
export function notificationsOff(env: NodeJS.ProcessEnv): boolean {
  return env.FLOWRYN_NOTIFY === "off" || env.FLOWRYN_NOTIFIER === "null";
}

/**
 * Every launcher of a daemon for testing (the test harness, the live-exit
 * scripts, the contract runner) calls this first: without FLOWRYN_NOTIFY=off
 * the daemon would post real notifications, so it refuses to start one.
 */
export function requireNotificationsOff(env: NodeJS.ProcessEnv | Record<string, string>, launcher: string): void {
  if (env.FLOWRYN_NOTIFY !== "off") {
    throw new Error(`${launcher} starts no daemon without FLOWRYN_NOTIFY=off: it would post real notifications to your Mac`);
  }
}

/**
 * How the daemon opens review pages: `record` appends each open to a file instead of running
 * `open` (FLOWRYN_OPENER=record:<path>, which the test harness sets); `off` when notifications are
 * off with no recorder (the lab, the contract homes, the spikes), so nothing outside your own setup
 * ever opens a tab on your Mac; otherwise `open`.
 */
export type OpenerMode = { kind: "open" } | { kind: "record"; path: string } | { kind: "off"; why: string };

export function openerMode(env: NodeJS.ProcessEnv): OpenerMode {
  const value = env.FLOWRYN_OPENER;
  if (value?.startsWith("record:") && value.length > "record:".length) return { kind: "record", path: value.slice("record:".length) };
  if (notificationsOff(env)) return { kind: "off", why: "FLOWRYN_NOTIFY=off" };
  return { kind: "open" };
}

/**
 * FLOWRYN_NOTIFIER=record:<path>: the macOS channel appends each notification
 * to that file instead of running osascript. The test harness sets it beside
 * FLOWRYN_NOTIFY=off, a second guard between a test daemon and osascript.
 */
export function recordingNotifierPath(env: NodeJS.ProcessEnv): string | null {
  const value = env.FLOWRYN_NOTIFIER;
  return value?.startsWith("record:") && value.length > "record:".length ? value.slice("record:".length) : null;
}
