import { FlowrynError } from "../api/errors.ts";
import type { FlowrynConfig } from "./config.ts";

/**
 * Typed views of the config sections M4 owns: [github] (the forge the
 * watcher, the named-head gate and the merge talk to) and [cleanup] (the
 * cleanup guard's clocks). Every default is the design's number or GitHub's
 * own; api_url exists so tests, the fixtures and the lab can point the same
 * code at a local fake forge.
 */

export const MERGE_METHODS = ["squash", "merge", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

export interface GitHubConfig {
  /** REST API base, no trailing slash. */
  api_url: string;
  /** Web base the canonical PR URLs use: <web_url>/<owner>/<repo>/pull/<n>. */
  web_url: string;
  /** Environment variables the daemon reads a token from, in order; `gh auth token` is the fallback. */
  token_env: string[];
  /** How often the watcher polls a delivered PR and its checks (ETags keep a quiet poll free). */
  poll_ms: number;
  /** One request's timeout. */
  timeout_ms: number;
  merge_method: MergeMethod;
}

export const DEFAULT_GITHUB: GitHubConfig = {
  api_url: "https://api.github.com",
  web_url: "https://github.com",
  token_env: ["GH_TOKEN", "GITHUB_TOKEN"],
  poll_ms: 60_000,
  timeout_ms: 15_000,
  merge_method: "squash",
};

export interface CleanupConfig {
  /** A git index.lock is provably stale only once it is this old and nothing holds it open. */
  lock_age_ms: number;
  /** How long to wait for a lock to clear by itself before judging it, per attempt. */
  lock_wait_ms: number;
  /** Attempts before a lock that is not provably stale refuses the cleanup. */
  lock_retries: number;
  /** SIGTERM grace for a leaked process before SIGKILL. */
  reap_grace_ms: number;
  /** Reap passes before leftover processes refuse the cleanup. */
  reap_passes: number;
  /** Timeout for each no-mistakes status or abort call. */
  nomistakes_timeout_ms: number;
}

export const DEFAULT_CLEANUP: CleanupConfig = {
  lock_age_ms: 30_000,
  lock_wait_ms: 1_000,
  lock_retries: 3,
  reap_grace_ms: 1_000,
  reap_passes: 3,
  nomistakes_timeout_ms: 10_000,
};

function table(value: unknown, where: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new FlowrynError("config_invalid", `${where} must be a table`);
  return value as Record<string, unknown>;
}

function unknownKeys(raw: Record<string, unknown>, known: object, where: string): void {
  for (const key of Object.keys(raw)) if (!(key in known)) throw new FlowrynError("config_invalid", `${where} ${key} is not a known setting`);
}

function positiveInt(raw: Record<string, unknown>, key: string, where: string, fallback: number): number {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new FlowrynError("config_invalid", `${where} ${key} must be a positive integer`);
  return value;
}

function baseUrl(raw: Record<string, unknown>, key: string, fallback: string): string {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^https?:\/\/[^\s/]+(?::\d+)?(\/[^\s]*)?$/.test(value)) throw new FlowrynError("config_invalid", `[github] ${key} must be an http(s) URL`);
  return value.replace(/\/+$/, "");
}

export function githubConfig(config: FlowrynConfig): GitHubConfig {
  const raw = table(config.extra.github, "[github]");
  unknownKeys(raw, DEFAULT_GITHUB, "[github]");
  const tokenEnv = raw.token_env ?? DEFAULT_GITHUB.token_env;
  if (!Array.isArray(tokenEnv) || !tokenEnv.every((v) => typeof v === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v))) {
    throw new FlowrynError("config_invalid", "[github] token_env must be a list of environment variable names");
  }
  const method = raw.merge_method ?? DEFAULT_GITHUB.merge_method;
  if (typeof method !== "string" || !(MERGE_METHODS as readonly string[]).includes(method)) {
    throw new FlowrynError("config_invalid", `[github] merge_method must be one of ${MERGE_METHODS.join(", ")}`);
  }
  return {
    api_url: baseUrl(raw, "api_url", DEFAULT_GITHUB.api_url),
    web_url: baseUrl(raw, "web_url", DEFAULT_GITHUB.web_url),
    token_env: tokenEnv as string[],
    poll_ms: positiveInt(raw, "poll_ms", "[github]", DEFAULT_GITHUB.poll_ms),
    timeout_ms: positiveInt(raw, "timeout_ms", "[github]", DEFAULT_GITHUB.timeout_ms),
    merge_method: method as MergeMethod,
  };
}

export function cleanupConfig(config: FlowrynConfig): CleanupConfig {
  const raw = table(config.extra.cleanup, "[cleanup]");
  unknownKeys(raw, DEFAULT_CLEANUP, "[cleanup]");
  const out = { ...DEFAULT_CLEANUP };
  for (const key of Object.keys(DEFAULT_CLEANUP) as (keyof CleanupConfig)[]) out[key] = positiveInt(raw, key, "[cleanup]", DEFAULT_CLEANUP[key]);
  return out;
}
