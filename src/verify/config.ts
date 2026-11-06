import { isAbsolute, normalize } from "node:path";
import { FlowrynError } from "../api/errors.ts";
import { checkUsd } from "../config/ask.ts";
import { table, type FlowrynConfig } from "../config/config.ts";
import { HARNESS_IDS, type HarnessId } from "../harness/types.ts";

/**
 * A project's verify steps, from config.toml `[projects.<id>]`: the commands
 * `flowryn verify` runs, in order, in a clean worktree at a PR head. They
 * live in your config, never in the repository, so a PR cannot change the
 * check that lets it through the merge gate. A nested list is a group whose
 * steps run at the same time (docs/notes/2026-10-22-verify-reliability-per-xe.md).
 * A `{ review = true }` entry is the review step: one capped, read-only model
 * review of the PR diff against the task's brief and approved spec
 * (src/verify/review.ts, docs/notes/2026-11-06-auto-verify-every-t8.md).
 */

/** One entry of `verify`: a step, or a group of two or more steps run in parallel. */
export type VerifyItem = string | string[];

export const LANDING_MODES = ["queue", "manual"] as const;
export type LandingMode = (typeof LANDING_MODES)[number];

/** The review step's name in a verification's steps: no shell command is ever spelled like this. */
export const REVIEW_STEP = "flowryn:review";
/** The review step's spend cap and deadline when its entry sets none. */
export const DEFAULT_REVIEW_USD = 2;
export const DEFAULT_REVIEW_TIMEOUT_MIN = 10;

/** `{ review = true, max_usd?, timeout_min?, harness?, model? }`: who reviews, and its bounds. */
export interface ReviewConfig {
  max_usd: number;
  timeout_ms: number;
  harness: HarnessId;
  /** A model other than the builder's, where one is set; null: the harness's configured model. */
  model: string | null;
}

export interface VerifyConfig {
  /** In order; the review step appears as REVIEW_STEP. */
  steps: VerifyItem[];
  /** The review step's settings when `verify` has one. */
  review: ReviewConfig | null;
  /** A file the steps build, relative to the worktree, copied out before the worktree goes. */
  binary: string | null;
  /** The whole run, every step together. */
  timeout_ms: number;
  /** Every step's own deadline, from verify_step_timeout_min; null: each step's deadline comes from its history. */
  step_timeout_ms: number | null;
}

export const DEFAULT_VERIFY_TIMEOUT_MIN = 30;

// scope and account are read by src/config/accounts.ts, max_workers by src/config/workflows.ts.
const KNOWN = new Set(["verify", "verify_binary", "verify_timeout_min", "verify_step_timeout_min", "auto_merge", "landing", "scope", "account", "max_workers"]);

/** What to paste for a bun project, shown when a project has no verify steps. */
export function verifySnippet(projectId: string): string {
  return `[projects.${projectId}]\nverify = ["bun install --frozen-lockfile", ["bun run typecheck", "npx oxlint"], "bun test", "bun run build"]`;
}

function projectTable(config: FlowrynConfig, projectId: string): Record<string, unknown> {
  const projects = table(config.extra.projects, "[projects]");
  return table(projects[projectId], `[projects.${projectId}]`);
}

const isStep = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0 && s.trim() !== REVIEW_STEP;
const isTable = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const REVIEW_KEYS = new Set(["review", "max_usd", "timeout_min", "harness", "model"]);

/** A `{ review = true, ... }` entry, checked; throws config_invalid on anything else in it. */
function readReview(raw: Record<string, unknown>, where: string): ReviewConfig {
  for (const key of Object.keys(raw)) if (!REVIEW_KEYS.has(key)) throw new FlowrynError("config_invalid", `${where} the review step's ${key} is not a known setting (${[...REVIEW_KEYS].join(", ")})`);
  if (raw.review !== true) throw new FlowrynError("config_invalid", `${where} a table in verify must be { review = true }`);
  if (raw.harness !== undefined && !HARNESS_IDS.includes(raw.harness as HarnessId)) throw new FlowrynError("config_invalid", `${where} the review step's harness must be one of ${HARNESS_IDS.join(", ")}`);
  if (raw.model !== undefined && (typeof raw.model !== "string" || raw.model.trim() === "")) throw new FlowrynError("config_invalid", `${where} the review step's model must be a model name`);
  return {
    max_usd: raw.max_usd === undefined ? DEFAULT_REVIEW_USD : checkUsd(raw.max_usd, `${where} the review step's max_usd`),
    timeout_ms: positiveMinutes(raw.timeout_min ?? DEFAULT_REVIEW_TIMEOUT_MIN, where, "the review step's timeout_min"),
    harness: (raw.harness as HarnessId | undefined) ?? "claude",
    model: typeof raw.model === "string" ? raw.model.trim() : null,
  };
}

/** The `verify` list, each group of one read as a plain step; null when malformed. A review entry is REVIEW_STEP, at most once, never in a group. */
function readItems(raw: unknown, where: string): { items: VerifyItem[]; review: ReviewConfig | null } | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const items: VerifyItem[] = [];
  let review: ReviewConfig | null = null;
  for (const item of raw) {
    if (isStep(item)) items.push(item);
    else if (Array.isArray(item) && item.length > 0 && item.every(isStep)) items.push(item.length === 1 ? item[0]! : [...item]);
    else if (isTable(item)) {
      if (review) throw new FlowrynError("config_invalid", `${where} verify has more than one review step`);
      review = readReview(item, where);
      items.push(REVIEW_STEP);
    } else if (Array.isArray(item) && item.some(isTable)) throw new FlowrynError("config_invalid", `${where} the review step cannot run in a parallel group`);
    else return null;
  }
  return { items, review };
}

function positiveMinutes(value: unknown, where: string, key: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new FlowrynError("config_invalid", `${where} ${key} must be a positive integer`);
  return value * 60_000;
}

/** The project's verify config, or null when it has no `verify` steps. Throws config_invalid on a malformed table. */
export function verifyConfig(config: FlowrynConfig, projectId: string): VerifyConfig | null {
  const where = `[projects.${projectId}]`;
  const raw = projectTable(config, projectId);
  for (const key of Object.keys(raw)) if (!KNOWN.has(key)) throw new FlowrynError("config_invalid", `${where} ${key} is not a known setting (${[...KNOWN].join(", ")})`);
  if (raw.auto_merge !== undefined && typeof raw.auto_merge !== "boolean") throw new FlowrynError("config_invalid", `${where} auto_merge must be true or false`);
  if (raw.landing !== undefined && !LANDING_MODES.includes(raw.landing as LandingMode)) throw new FlowrynError("config_invalid", `${where} landing must be "queue" or "manual"`);
  if (raw.verify === undefined) {
    // Without verify steps the merge gate passes a PR that has no checks: auto-merge would land anything.
    if (raw.auto_merge === true) throw new FlowrynError("config_invalid", `${where} auto_merge needs verify steps: without them the merge gate passes a PR that has no checks`);
    // The queue re-verifies each PR at main's tip before it merges: with no steps there is nothing to re-verify.
    if (raw.landing === "queue") throw new FlowrynError("config_invalid", `${where} landing = "queue" needs verify steps: the queue verifies each PR again after merging main into it`);
    return null;
  }
  const read = readItems(raw.verify, where);
  if (!read) throw new FlowrynError("config_invalid", `${where} verify must be a non-empty list of commands, or of lists of commands run in parallel`);
  let binary: string | null = null;
  if (raw.verify_binary !== undefined) {
    const value = raw.verify_binary;
    if (typeof value !== "string" || value.length === 0 || isAbsolute(value) || normalize(value).split("/").includes("..")) {
      throw new FlowrynError("config_invalid", `${where} verify_binary must be a path inside the worktree, such as dist/flowryn`);
    }
    binary = normalize(value);
  }
  const timeout_ms = positiveMinutes(raw.verify_timeout_min ?? DEFAULT_VERIFY_TIMEOUT_MIN, where, "verify_timeout_min");
  const step_timeout_ms = raw.verify_step_timeout_min === undefined ? null : positiveMinutes(raw.verify_step_timeout_min, where, "verify_step_timeout_min");
  return { steps: read.items, review: read.review, binary, timeout_ms, step_timeout_ms };
}

/** `[projects.<id>] auto_merge` as written: true, false, or null when unset. Throws config_invalid like verifyConfig. */
export function autoMergeSetting(config: FlowrynConfig, projectId: string): boolean | null {
  verifyConfig(config, projectId);
  const value = projectTable(config, projectId).auto_merge;
  return typeof value === "boolean" ? value : null;
}

/**
 * `[projects.<id>] auto_merge` (docs/notes/2026-10-22-daemon-run-verify-y3.md, phase 2):
 * the daemon verifies and merges the project's yolo deliveries itself. Unset,
 * it follows the project's yolo posture (docs/notes/2026-11-06-auto-verify-every-t8.md):
 * a yolo project auto-merges, and `auto_merge = false` opts out. Never without
 * verify steps; throws config_invalid like verifyConfig.
 */
export function autoMergeEnabled(config: FlowrynConfig, projectId: string, projectYolo = false): boolean {
  if (!verifyConfig(config, projectId)) return false;
  return autoMergeSetting(config, projectId) ?? projectYolo;
}

/**
 * `[projects.<id>] landing` (docs/notes/2026-10-30-landing-queue-the-65.md):
 * "queue" has the daemon land the project's approved and routine PRs one at a
 * time, merging its base into each first (src/verify/landing-queue.ts);
 * "manual" (the default) leaves landing to the merge verb. Throws
 * config_invalid like verifyConfig (a queue is refused without verify steps).
 */
export function landingMode(config: FlowrynConfig, projectId: string): LandingMode {
  if (!verifyConfig(config, projectId)) return "manual";
  return projectTable(config, projectId).landing === "queue" ? "queue" : "manual";
}

/** landingMode for a pass that must not throw: an invalid table was refused by the daemon, and nothing queues on it. */
export function landingQueued(config: FlowrynConfig, projectId: string): boolean {
  try {
    return landingMode(config, projectId) === "queue";
  } catch {
    return false;
  }
}
