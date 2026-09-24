import { join } from "node:path";
import { FlowrynError } from "../api/errors.ts";
import type { FlowrynConfig } from "./config.ts";
import { leaderTiming, notifyConfig } from "./leader.ts";
import { cleanupConfig, githubConfig } from "./delivery.ts";
import { toAbsolute } from "./paths.ts";

/**
 * Typed views of the config sections M2 owns: [herdr] and [workers.*]. M1 keeps
 * every later-milestone section verbatim in `config.extra`; these accessors
 * validate it on read, so a bad value fails the daemon's startup and doctor
 * with a config_invalid error instead of surfacing mid-launch.
 */

export interface HerdrConfig {
  /** Explicit API socket path. Wins over `session`; the lab and tests set it. */
  socket: string | null;
  /** Named Herdr session to resolve with `herdr session list --json` (default: the default session). */
  session: string | null;
}

export const CLAUDE_PERMISSION_MODES = ["bypassPermissions", "auto", "acceptEdits", "default", "dontAsk", "plan"] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

/** register: write workspace trust before launch (design section 5); check: refuse an untrusted worktree, never write. */
export const PRETRUST_MODES = ["register", "check"] as const;
export type PretrustMode = (typeof PRETRUST_MODES)[number];

export interface ClaudeWorkerConfig {
  model: string | null;
  effort: string | null;
  permission_mode: ClaudePermissionMode;
  pretrust: PretrustMode;
  /** Absolute path of Claude's config directory holding .claude.json (default: CLAUDE_CONFIG_DIR, else HOME). */
  config_dir: string | null;
  extra_args: string[];
}

export interface PiWorkerConfig {
  model: string | null;
  /** Pi's --thinking level (the design's per-harness effort). */
  effort: string | null;
  /** PI_CODING_AGENT_DIR for workers; null keeps Pi's own (~/.pi/agent). */
  agent_dir: string | null;
  /** --session-dir for workers; null keeps Pi's default. */
  session_dir: string | null;
  /** Extra extensions loaded with -e (the offline scripted provider in tests). */
  extensions: string[];
  /** M0 finding 12: the user's own Pi environment loads unless these say otherwise. */
  no_extensions: boolean;
  no_skills: boolean;
  no_context_files: boolean;
  extra_args: string[];
  /** Extra environment for the Pi process (PI_OFFLINE and the like). */
  env: Record<string, string>;
}

export interface WorkersConfig {
  worktree_root: string;
  /** Run branches are `<branch_prefix><task>`; contract and lab runs set a unique prefix so they can clean up by name. */
  branch_prefix: string;
  claude: ClaudeWorkerConfig;
  pi: PiWorkerConfig;
}

function table(value: unknown, where: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new FlowrynError("config_invalid", `${where} must be a table`);
  return value as Record<string, unknown>;
}

function optString(value: unknown, where: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) throw new FlowrynError("config_invalid", `${where} must be a non-empty string`);
  return value;
}

function optBool(value: unknown, where: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new FlowrynError("config_invalid", `${where} must be true or false`);
  return value;
}

function stringList(value: unknown, where: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) throw new FlowrynError("config_invalid", `${where} must be a list of strings`);
  return value as string[];
}

function stringMap(value: unknown, where: string): Record<string, string> {
  const raw = table(value, where);
  for (const [key, v] of Object.entries(raw)) {
    if (typeof v !== "string") throw new FlowrynError("config_invalid", `${where}.${key} must be a string`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new FlowrynError("config_invalid", `${where}: ${key} is not an environment variable name`);
  }
  return raw as Record<string, string>;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], where: string, fallback: T): T {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new FlowrynError("config_invalid", `${where} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function absPath(value: string | null, home: string): string | null {
  return value === null ? null : toAbsolute(value, home);
}

const BRANCH_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._/-]*[/-]$/;

function branchPrefix(value: string): string {
  if (!BRANCH_PREFIX.test(value) || value.includes("..") || value.includes("//")) {
    throw new FlowrynError("config_invalid", "[workers] branch_prefix must be a git ref prefix ending in / or -, such as flowryn/");
  }
  return value;
}

export function herdrConfig(config: FlowrynConfig): HerdrConfig {
  const raw = table(config.extra.herdr, "[herdr]");
  return {
    socket: absPath(optString(raw.socket, "[herdr] socket"), config.home),
    session: optString(raw.session, "[herdr] session"),
  };
}

export function workersConfig(config: FlowrynConfig): WorkersConfig {
  const raw = table(config.extra.workers, "[workers]");
  const claude = table(raw.claude, "[workers.claude]");
  const pi = table(raw.pi, "[workers.pi]");
  return {
    worktree_root: absPath(optString(raw.worktree_root, "[workers] worktree_root"), config.home) ?? join(config.data_dir, "worktrees"),
    branch_prefix: branchPrefix(optString(raw.branch_prefix, "[workers] branch_prefix") ?? "flowryn/"),
    claude: {
      model: optString(claude.model, "[workers.claude] model"),
      effort: optString(claude.effort, "[workers.claude] effort"),
      permission_mode: oneOf(claude.permission_mode, CLAUDE_PERMISSION_MODES, "[workers.claude] permission_mode", "bypassPermissions"),
      pretrust: oneOf(claude.pretrust, PRETRUST_MODES, "[workers.claude] pretrust", "register"),
      config_dir: absPath(optString(claude.config_dir, "[workers.claude] config_dir"), config.home),
      extra_args: stringList(claude.extra_args, "[workers.claude] extra_args"),
    },
    pi: {
      model: optString(pi.model, "[workers.pi] model"),
      effort: optString(pi.effort, "[workers.pi] effort"),
      agent_dir: absPath(optString(pi.agent_dir, "[workers.pi] agent_dir"), config.home),
      session_dir: absPath(optString(pi.session_dir, "[workers.pi] session_dir"), config.home),
      extensions: stringList(pi.extensions, "[workers.pi] extensions").map((p) => toAbsolute(p, config.home)),
      no_extensions: optBool(pi.no_extensions, "[workers.pi] no_extensions", false),
      no_skills: optBool(pi.no_skills, "[workers.pi] no_skills", false),
      no_context_files: optBool(pi.no_context_files, "[workers.pi] no_context_files", false),
      extra_args: stringList(pi.extra_args, "[workers.pi] extra_args"),
      env: stringMap(pi.env, "[workers.pi] env"),
    },
  };
}

/** Validate every section M2, M3 and M4 own at once; returns the problems (empty when sound). */
export function workerConfigProblems(config: FlowrynConfig): string[] {
  const problems: string[] = [];
  for (const check of [() => herdrConfig(config), () => workersConfig(config), () => timingConfig(config), () => leaderTiming(config), () => notifyConfig(config), () => githubConfig(config), () => cleanupConfig(config)]) {
    try {
      check();
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  return problems;
}

/**
 * The reconciler's clock (design sections 5, 6 and 9). Every default is the
 * design's number; the [reconcile] section exists so tests and the lab can
 * shrink them, and is not meant for day-to-day tuning.
 */
export interface Timing {
  /** Steady-state reconcile pass. */
  pass_ms: number;
  /** No worker-start this long after a launch: blocked_dialog (trust wedge). */
  trust_wedge_ms: number;
  /** Busy is a lease hooks refresh; nothing fires after an interrupt. */
  busy_lease_ms: number;
  /** An unacknowledged steer rings again after this long. */
  ring_interval_ms: number;
  /** Deliveries before a P1: the first ring plus three re-rings. */
  max_rings: number;
  /** Idle this long without an outcome: a P1 pointer. */
  idle_alert_ms: number;
  /** Busy with no hook event this long: a P1 pointer. */
  stale_hook_ms: number;
  /** How long a launch waits for the harness process to appear in its pane. */
  launch_timeout_ms: number;
  /** SIGTERM grace before SIGKILL on exit. */
  exit_grace_ms: number;
  /** A waiter's long poll holds the connection this long before asking again. */
  wait_poll_ms: number;
}

export const DEFAULT_TIMING: Timing = {
  pass_ms: 60_000,
  trust_wedge_ms: 30_000,
  busy_lease_ms: 10 * 60_000,
  ring_interval_ms: 5 * 60_000,
  max_rings: 4,
  idle_alert_ms: 15 * 60_000,
  stale_hook_ms: 30 * 60_000,
  launch_timeout_ms: 20_000,
  exit_grace_ms: 10_000,
  wait_poll_ms: 25_000,
};

export function timingConfig(config: FlowrynConfig): Timing {
  const raw = table(config.extra.reconcile, "[reconcile]");
  const timing: Timing = { ...DEFAULT_TIMING };
  for (const key of Object.keys(DEFAULT_TIMING) as (keyof Timing)[]) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new FlowrynError("config_invalid", `[reconcile] ${key} must be a positive integer`);
    timing[key] = value;
  }
  for (const key of Object.keys(raw)) {
    if (!(key in DEFAULT_TIMING)) throw new FlowrynError("config_invalid", `[reconcile] ${key} is not a known setting`);
  }
  return timing;
}
