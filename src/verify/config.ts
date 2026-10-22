import { isAbsolute, normalize } from "node:path";
import { FlowrynError } from "../api/errors.ts";
import { table, type FlowrynConfig } from "../config/config.ts";

/**
 * A project's verify steps, from config.toml `[projects.<id>]`: the commands
 * `flowryn verify` runs, in order, in a clean worktree at a PR head. They
 * live in your config, never in the repository, so a PR cannot change the
 * check that lets it through the merge gate.
 */

export interface VerifyConfig {
  steps: string[];
  /** A file the steps build, relative to the worktree, copied out before the worktree goes. */
  binary: string | null;
  /** The whole run, every step together. */
  timeout_ms: number;
}

export const DEFAULT_VERIFY_TIMEOUT_MIN = 30;

// scope and account are read by src/config/accounts.ts.
const KNOWN = new Set(["verify", "verify_binary", "verify_timeout_min", "scope", "account"]);

/** What to paste for a bun project, shown when a project has no verify steps. */
export function verifySnippet(projectId: string): string {
  return `[projects.${projectId}]\nverify = ["bun install --frozen-lockfile", "bun run typecheck", "npx oxlint", "bun test", "bun run build"]`;
}

function projectTable(config: FlowrynConfig, projectId: string): Record<string, unknown> {
  const projects = table(config.extra.projects, "[projects]");
  return table(projects[projectId], `[projects.${projectId}]`);
}

/** The project's verify config, or null when it has no `verify` steps. Throws config_invalid on a malformed table. */
export function verifyConfig(config: FlowrynConfig, projectId: string): VerifyConfig | null {
  const where = `[projects.${projectId}]`;
  const raw = projectTable(config, projectId);
  for (const key of Object.keys(raw)) if (!KNOWN.has(key)) throw new FlowrynError("config_invalid", `${where} ${key} is not a known setting (${[...KNOWN].join(", ")})`);
  if (raw.verify === undefined) return null;
  const steps = raw.verify;
  if (!Array.isArray(steps) || steps.length === 0 || !steps.every((s) => typeof s === "string" && s.trim().length > 0)) {
    throw new FlowrynError("config_invalid", `${where} verify must be a non-empty list of commands`);
  }
  let binary: string | null = null;
  if (raw.verify_binary !== undefined) {
    const value = raw.verify_binary;
    if (typeof value !== "string" || value.length === 0 || isAbsolute(value) || normalize(value).split("/").includes("..")) {
      throw new FlowrynError("config_invalid", `${where} verify_binary must be a path inside the worktree, such as dist/flowryn`);
    }
    binary = normalize(value);
  }
  const minutes = raw.verify_timeout_min ?? DEFAULT_VERIFY_TIMEOUT_MIN;
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes <= 0) throw new FlowrynError("config_invalid", `${where} verify_timeout_min must be a positive integer`);
  return { steps: steps as string[], binary, timeout_ms: minutes * 60_000 };
}
