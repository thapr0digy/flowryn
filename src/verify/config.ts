import { isAbsolute, normalize } from "node:path";
import { FlowrynError } from "../api/errors.ts";
import { table, type FlowrynConfig } from "../config/config.ts";

/**
 * A project's verify steps, from config.toml `[projects.<id>]`: the commands
 * `flowryn verify` runs, in order, in a clean worktree at a PR head. They
 * live in your config, never in the repository, so a PR cannot change the
 * check that lets it through the merge gate. A nested list is a group whose
 * steps run at the same time (docs/notes/2026-10-22-verify-reliability-per-xe.md).
 */

/** One entry of `verify`: a step, or a group of two or more steps run in parallel. */
export type VerifyItem = string | string[];

export interface VerifyConfig {
  steps: VerifyItem[];
  /** A file the steps build, relative to the worktree, copied out before the worktree goes. */
  binary: string | null;
  /** The whole run, every step together. */
  timeout_ms: number;
  /** Every step's own deadline, from verify_step_timeout_min; null: each step's deadline comes from its history. */
  step_timeout_ms: number | null;
}

export const DEFAULT_VERIFY_TIMEOUT_MIN = 30;

const KNOWN = new Set(["verify", "verify_binary", "verify_timeout_min", "verify_step_timeout_min"]);

/** What to paste for a bun project, shown when a project has no verify steps. */
export function verifySnippet(projectId: string): string {
  return `[projects.${projectId}]\nverify = ["bun install --frozen-lockfile", ["bun run typecheck", "npx oxlint"], "bun test", "bun run build"]`;
}

function projectTable(config: FlowrynConfig, projectId: string): Record<string, unknown> {
  const projects = table(config.extra.projects, "[projects]");
  return table(projects[projectId], `[projects.${projectId}]`);
}

const isStep = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;

/** The `verify` list, each group of one read as a plain step; null when malformed. */
function readItems(raw: unknown): VerifyItem[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const items: VerifyItem[] = [];
  for (const item of raw) {
    if (isStep(item)) items.push(item);
    else if (Array.isArray(item) && item.length > 0 && item.every(isStep)) items.push(item.length === 1 ? item[0]! : [...item]);
    else return null;
  }
  return items;
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
  if (raw.verify === undefined) return null;
  const steps = readItems(raw.verify);
  if (!steps) throw new FlowrynError("config_invalid", `${where} verify must be a non-empty list of commands, or of lists of commands run in parallel`);
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
  return { steps, binary, timeout_ms, step_timeout_ms };
}

/** Every step, in order, groups flattened: what the job records one row per. */
export function flatSteps(items: readonly VerifyItem[]): string[] {
  return items.flatMap((item) => (typeof item === "string" ? [item] : item));
}
