import { FlowrynError } from "../api/errors.ts";
import { table, type FlowrynConfig } from "./config.ts";

/**
 * `[merge]` (docs/notes/2026-11-08-merge-sensitive-prs-rr.md): how merges behave beyond the gate.
 * `sensitive_when_away` (default false): during an away the user started themselves, a sensitive
 * task in a yolo project merges once verify and the independent validator pass at its exact head
 * (src/attention/away-merge.ts). Checked at load and on SIGHUP; anything but a boolean is refused.
 */
export interface MergeConfig {
  sensitive_when_away: boolean;
}

const MERGE_KEYS = ["sensitive_when_away"];

export function mergeConfig(config: FlowrynConfig): MergeConfig {
  const raw = table(config.extra.merge, "[merge]");
  for (const key of Object.keys(raw)) if (!MERGE_KEYS.includes(key)) throw new FlowrynError("config_invalid", `[merge] ${key} is not a known setting`);
  const value = raw.sensitive_when_away ?? false;
  if (typeof value !== "boolean") throw new FlowrynError("config_invalid", "[merge] sensitive_when_away must be true or false");
  return { sensitive_when_away: value };
}
