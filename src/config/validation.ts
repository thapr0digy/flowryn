import { FlowrynError } from "../api/errors.ts";
import { table, type FlowrynConfig } from "./config.ts";

/**
 * [validation]: the CI-wait watchdog (src/lifecycle/ci-wait.ts) and the
 * policy follow-through (src/upkeep/policy-follow.ts).
 *
 * - `ci_wait_alert`: a ship whose no-mistakes pipeline has waited in its `ci`
 *   step this many minutes with no checks on its PR opens a decision for the
 *   user. 0 turns the watchdog off.
 * - `follow_paths`: the policy files. When the default branch changes one
 *   after a ship's branch forked, the ship is steered to merge it. An empty
 *   list turns the follow-through off.
 * - `follow_interval_ms`: the follow-through's clock; it exists so tests can
 *   shrink it.
 */

export interface ValidationConfig {
  /** Minutes a pipeline may wait on CI with no checks registered before the user is asked. */
  ci_wait_alert: number;
  /** Git pathspecs (a file, or a directory with a trailing slash) whose change on the default branch steers in-flight ships. */
  follow_paths: string[];
  follow_interval_ms: number;
}

export const DEFAULT_VALIDATION: ValidationConfig = {
  ci_wait_alert: 60,
  follow_paths: [".no-mistakes.yaml", ".github/workflows/"],
  follow_interval_ms: 300_000,
};

/** A plain relative path: no pathspec magic (`:`), no option (`-`), nothing outside the repository. */
function plainPath(path: unknown): path is string {
  if (typeof path !== "string" || path.trim() !== path || path.length === 0) return false;
  if (path.startsWith("/") || path.startsWith(":") || path.startsWith("-")) return false;
  return !path.split("/").includes("..");
}

export function validationConfig(config: FlowrynConfig): ValidationConfig {
  const raw = table(config.extra.validation, "[validation]");
  for (const key of Object.keys(raw)) {
    if (!(key in DEFAULT_VALIDATION)) throw new FlowrynError("config_invalid", `[validation] ${key} is not a known setting`);
  }
  const alert = raw.ci_wait_alert ?? DEFAULT_VALIDATION.ci_wait_alert;
  if (typeof alert !== "number" || !Number.isInteger(alert) || alert < 0) throw new FlowrynError("config_invalid", "[validation] ci_wait_alert must be a whole number of minutes (0 turns the watchdog off)");
  const paths = raw.follow_paths ?? DEFAULT_VALIDATION.follow_paths;
  if (!Array.isArray(paths) || !paths.every(plainPath)) {
    throw new FlowrynError("config_invalid", "[validation] follow_paths must be a list of relative paths in the repository (an empty list turns the follow-through off)");
  }
  const interval = raw.follow_interval_ms ?? DEFAULT_VALIDATION.follow_interval_ms;
  if (typeof interval !== "number" || !Number.isInteger(interval) || interval <= 0) throw new FlowrynError("config_invalid", "[validation] follow_interval_ms must be a positive integer");
  return { ci_wait_alert: alert, follow_paths: [...paths], follow_interval_ms: interval };
}
