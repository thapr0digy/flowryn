import { FlowrynError } from "../api/errors.ts";
import { table, type FlowrynConfig } from "./config.ts";

/**
 * [daemon]: the build watcher (src/daemon/build-watch.ts). `auto_restart`
 * "merged" (the default) restarts onto a new installed build once the restart
 * guards clear, when it is a clean build of a commit on the remote's default
 * branch; "off" leaves every restart to `flowryn daemon restart`. The two
 * clocks exist so tests can shrink them, and are not meant for tuning.
 */

export const AUTO_RESTART_MODES = ["merged", "off"] as const;
export type AutoRestartMode = (typeof AUTO_RESTART_MODES)[number];

export interface DaemonConfig {
  auto_restart: AutoRestartMode;
  /** How often the watcher looks at the installed binary (a stat; it hashes only on change). */
  build_poll_ms: number;
  /** A changed binary must stay unchanged this long before it is judged: a build writes, then signs. */
  build_settle_ms: number;
}

export const DEFAULT_DAEMON: DaemonConfig = { auto_restart: "merged", build_poll_ms: 30_000, build_settle_ms: 10_000 };

function positiveInt(value: unknown, where: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new FlowrynError("config_invalid", `${where} must be a positive integer`);
  return value;
}

export function daemonConfig(config: FlowrynConfig): DaemonConfig {
  const raw = table(config.extra.daemon, "[daemon]");
  for (const key of Object.keys(raw)) {
    if (!(key in DEFAULT_DAEMON)) throw new FlowrynError("config_invalid", `[daemon] ${key} is not a known setting`);
  }
  const mode = raw.auto_restart ?? DEFAULT_DAEMON.auto_restart;
  if (typeof mode !== "string" || !(AUTO_RESTART_MODES as readonly string[]).includes(mode)) {
    throw new FlowrynError("config_invalid", `[daemon] auto_restart must be ${AUTO_RESTART_MODES.map((m) => `"${m}"`).join(" or ")}`);
  }
  return {
    auto_restart: mode as AutoRestartMode,
    build_poll_ms: positiveInt(raw.build_poll_ms, "[daemon] build_poll_ms", DEFAULT_DAEMON.build_poll_ms),
    build_settle_ms: positiveInt(raw.build_settle_ms, "[daemon] build_settle_ms", DEFAULT_DAEMON.build_settle_ms),
  };
}
