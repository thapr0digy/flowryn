import { FlowrynError } from "../api/errors.ts";
import { table, type FlowrynConfig } from "./config.ts";

/**
 * [contracts]: the daemon's own watch on the harness versions it gates
 * (docs/notes/2026-11-06-a-claude-pi-y5.md).
 *
 * - `version_poll_ms`: how often the daemon reads the installed version of
 *   each harness in use, so a self-updated Claude or Pi is flagged (and, in
 *   relaxed mode, checked automatically) before anyone dispatches. 0 turns
 *   the poll off; the gate still checks at startup, dispatch and each launch.
 */
export interface ContractsConfig {
  version_poll_ms: number;
}

export const DEFAULT_CONTRACTS: ContractsConfig = {
  version_poll_ms: 600_000,
};

/** The shortest poll that is not 0: a version read is a process spawn when the binary changed. */
export const MIN_VERSION_POLL_MS = 10_000;

export function contractsConfig(config: FlowrynConfig): ContractsConfig {
  const raw = table(config.extra.contracts, "[contracts]");
  for (const key of Object.keys(raw)) {
    if (!(key in DEFAULT_CONTRACTS)) throw new FlowrynError("config_invalid", `[contracts] ${key} is not a known setting`);
  }
  const poll = raw.version_poll_ms;
  if (poll === undefined) return { ...DEFAULT_CONTRACTS };
  if (typeof poll !== "number" || !Number.isInteger(poll) || (poll !== 0 && poll < MIN_VERSION_POLL_MS)) {
    throw new FlowrynError("config_invalid", `[contracts] version_poll_ms must be 0 (off) or a whole number of at least ${MIN_VERSION_POLL_MS}`);
  }
  return { version_poll_ms: poll };
}
