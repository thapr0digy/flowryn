import { FlowrynError } from "../api/errors.ts";
import { table, type FlowrynConfig } from "./config.ts";

/**
 * [validation]: the CI-wait watchdog (src/lifecycle/ci-wait.ts). A ship whose
 * no-mistakes pipeline has waited in its `ci` step this many minutes with no
 * checks on its PR opens a decision for the user. 0 turns the watchdog off.
 */

export interface ValidationConfig {
  /** Minutes a pipeline may wait on CI with no checks registered before the user is asked. */
  ci_wait_alert: number;
}

export const DEFAULT_VALIDATION: ValidationConfig = { ci_wait_alert: 60 };

export function validationConfig(config: FlowrynConfig): ValidationConfig {
  const raw = table(config.extra.validation, "[validation]");
  for (const key of Object.keys(raw)) {
    if (!(key in DEFAULT_VALIDATION)) throw new FlowrynError("config_invalid", `[validation] ${key} is not a known setting`);
  }
  const alert = raw.ci_wait_alert ?? DEFAULT_VALIDATION.ci_wait_alert;
  if (typeof alert !== "number" || !Number.isInteger(alert) || alert < 0) throw new FlowrynError("config_invalid", "[validation] ci_wait_alert must be a whole number of minutes (0 turns the watchdog off)");
  return { ci_wait_alert: alert };
}
