import { isAbsolute, normalize } from "node:path";
import { FlowrynError } from "../api/errors.ts";
import { table, type FlowrynConfig } from "../config/config.ts";
import { compileGlob } from "./changed.ts";

/**
 * A project's verify steps, from config.toml `[projects.<id>]`: the commands
 * `flowryn verify` runs, in order, in a clean worktree at a PR head. They
 * live in your config, never in the repository, so a PR cannot change the
 * check that lets it through the merge gate. A nested list is a group whose
 * steps run at the same time (docs/notes/2026-10-22-verify-reliability-per-xe.md).
 */

/** One entry of `verify`: a step, or a group of two or more steps run in parallel. */
export type VerifyItem = string | string[];

export const LANDING_MODES = ["queue", "manual"] as const;
export type LandingMode = (typeof LANDING_MODES)[number];

export interface VerifyConfig {
  steps: VerifyItem[];
  /**
   * Each step's `when_changed` globs, by its place in the flattened list (groups in order),
   * or null: it always runs. Absent or empty: no step has any (docs/notes/2026-11-06-fast-tests-parallel-36.md).
   */
  when_changed?: (readonly string[] | null)[];
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

const isStep = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;

/** One step: its command, and its when_changed globs or null. */
interface ReadStep {
  run: string;
  when: string[] | null;
}

/**
 * A step as written: a command, or a table `{ run = "...", when_changed = ["src/x/**"] }`.
 * Null when it is neither; throws config_invalid on a table whose globs are malformed.
 */
function readStep(raw: unknown, where: string): ReadStep | null {
  if (isStep(raw)) return { run: raw, when: null };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  for (const key of Object.keys(entry)) if (key !== "run" && key !== "when_changed") throw new FlowrynError("config_invalid", `${where} verify: a step table takes run and when_changed, not ${key}`);
  if (!isStep(entry.run)) throw new FlowrynError("config_invalid", `${where} verify: a step table needs run, the command`);
  const globs = entry.when_changed;
  if (globs === undefined) return { run: entry.run, when: null };
  if (!Array.isArray(globs) || globs.length === 0 || !globs.every((g) => typeof g === "string")) {
    throw new FlowrynError("config_invalid", `${where} verify: when_changed of "${entry.run}" must be a non-empty list of globs`);
  }
  for (const glob of globs as string[]) {
    try {
      compileGlob(glob);
    } catch (error) {
      throw new FlowrynError("config_invalid", `${where} verify: when_changed glob "${glob}" of "${entry.run}" ${(error as Error).message}`);
    }
  }
  return { run: entry.run, when: [...(globs as string[])] };
}

/** The `verify` list, each group of one read as a plain step, with each step's globs in flattened order; null when malformed. */
function readItems(raw: unknown, where: string): { items: VerifyItem[]; when: (string[] | null)[] } | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const items: VerifyItem[] = [];
  const when: (string[] | null)[] = [];
  for (const item of raw) {
    const single = readStep(item, where);
    if (single) {
      items.push(single.run);
      when.push(single.when);
      continue;
    }
    if (!Array.isArray(item) || item.length === 0) return null;
    const group = item.map((step) => readStep(step, where));
    if (group.some((step) => step === null)) return null;
    const steps = group as ReadStep[];
    items.push(steps.length === 1 ? steps[0]!.run : steps.map((step) => step.run));
    when.push(...steps.map((step) => step.when));
  }
  return { items, when };
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
  if (!read) throw new FlowrynError("config_invalid", `${where} verify must be a non-empty list of commands (or { run, when_changed } tables), or of lists of them run in parallel`);
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
  const when_changed = read.when.some((w) => w !== null) ? read.when : undefined;
  return { steps: read.items, ...(when_changed ? { when_changed } : {}), binary, timeout_ms, step_timeout_ms };
}

/**
 * `[projects.<id>] auto_merge` (docs/notes/2026-10-22-daemon-run-verify-y3.md, phase 2):
 * the daemon verifies and merges the project's yolo deliveries itself. False
 * unless set; throws config_invalid like verifyConfig (it is refused without
 * verify steps).
 */
export function autoMergeEnabled(config: FlowrynConfig, projectId: string): boolean {
  if (!verifyConfig(config, projectId)) return false;
  return projectTable(config, projectId).auto_merge === true;
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
