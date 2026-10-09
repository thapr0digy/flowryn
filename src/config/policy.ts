import { FlowrynError } from "../api/errors.ts";
import { table, type FlowrynConfig } from "./config.ts";

/**
 * [policy] mode: how far the leader may act where the human-only boundary
 * was loosened on purpose. strict (the default, and a missing key): only your
 * own terminal records a harness contract pass. relaxed: the leader may also
 * record a pass, from the installed build only (src/contracts/grant.ts), and
 * the daemon runs the recording check itself when the harness gate finds a
 * new version (src/contracts/auto.ts).
 * Merges, gate approvals and discards are the same in both modes.
 */

export const POLICY_MODES = ["strict", "relaxed"] as const;
export type PolicyMode = (typeof POLICY_MODES)[number];

export const DEFAULT_POLICY_MODE: PolicyMode = "strict";

/** One line per mode, for `flowryn init` and `flowryn doctor`. */
export const POLICY_MODE_LINES: Record<PolicyMode, string> = {
  strict: "only your own terminal records a harness contract pass; the leader may run verify-only checks",
  relaxed: "the daemon checks a new harness version itself and the leader may record a contract pass, both from the installed build only, and you see each one",
};

export function policyMode(config: FlowrynConfig): PolicyMode {
  const raw = table(config.extra.policy, "[policy]");
  for (const key of Object.keys(raw)) if (key !== "mode") throw new FlowrynError("config_invalid", `[policy] ${key} is not a known setting`);
  const mode = raw.mode ?? DEFAULT_POLICY_MODE;
  if (typeof mode !== "string" || !(POLICY_MODES as readonly string[]).includes(mode)) {
    throw new FlowrynError("config_invalid", `[policy] mode must be ${POLICY_MODES.map((m) => `"${m}"`).join(" or ")}`);
  }
  return mode as PolicyMode;
}
