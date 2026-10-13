import { FlowrynError } from "../api/errors.ts";
import { table, type FlowrynConfig } from "./config.ts";

/**
 * [upkeep]: the routine work the daemon does by itself (spec 3, phase 3;
 * src/upkeep/). Each hook has its own switch:
 *
 * - `build_after_merge`: after a Flowryn merge, build origin's default branch
 *   in a daemon-owned clean worktree and rename it over the installed binary,
 *   so the build watcher applies it.
 * - `sync_primary`: fast-forward each project's primary checkout to its
 *   origin default branch, only when that is safe.
 * - `clean_ended_hours`: a failed or cancelled run's worktree goes through the
 *   cleanup guard once it has been idle this long; 0 turns it off.
 * - `nudge_conflicts`: a delivered PR GitHub reads as unmergeable sends its
 *   ship back to merge origin's default branch and deliver again.
 * - `explanations_keep_days`, `explanations_keep_per_run`: closed wait
 *   explanations older than this many days, and beyond a run's newest this
 *   many, are deleted; 0 turns either bound off. Open ones always stay.
 *
 * `interval_ms` is the upkeep clock; it exists so tests can shrink it.
 */

export interface UpkeepConfig {
  build_after_merge: boolean;
  sync_primary: boolean;
  clean_ended_hours: number;
  nudge_conflicts: boolean;
  explanations_keep_days: number;
  explanations_keep_per_run: number;
  interval_ms: number;
}

export const DEFAULT_UPKEEP: UpkeepConfig = {
  build_after_merge: true,
  sync_primary: true,
  clean_ended_hours: 24,
  nudge_conflicts: true,
  explanations_keep_days: 30,
  explanations_keep_per_run: 200,
  interval_ms: 600_000,
};

function bool(value: unknown, key: keyof UpkeepConfig): boolean {
  if (value === undefined) return DEFAULT_UPKEEP[key] as boolean;
  if (typeof value !== "boolean") throw new FlowrynError("config_invalid", `[upkeep] ${key} must be true or false`);
  return value;
}

function keep(value: unknown, key: "explanations_keep_days" | "explanations_keep_per_run"): number {
  if (value === undefined) return DEFAULT_UPKEEP[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new FlowrynError("config_invalid", `[upkeep] ${key} must be a whole number, 0 or more (0 turns it off)`);
  return value;
}

export function upkeepConfig(config: FlowrynConfig): UpkeepConfig {
  const raw = table(config.extra.upkeep, "[upkeep]");
  for (const key of Object.keys(raw)) {
    if (!(key in DEFAULT_UPKEEP)) throw new FlowrynError("config_invalid", `[upkeep] ${key} is not a known setting`);
  }
  const hours = raw.clean_ended_hours ?? DEFAULT_UPKEEP.clean_ended_hours;
  if (typeof hours !== "number" || !Number.isFinite(hours) || hours < 0) throw new FlowrynError("config_invalid", "[upkeep] clean_ended_hours must be a number of hours, 0 or more (0 turns it off)");
  const interval = raw.interval_ms ?? DEFAULT_UPKEEP.interval_ms;
  if (typeof interval !== "number" || !Number.isInteger(interval) || interval <= 0) throw new FlowrynError("config_invalid", "[upkeep] interval_ms must be a positive integer");
  return {
    build_after_merge: bool(raw.build_after_merge, "build_after_merge"),
    sync_primary: bool(raw.sync_primary, "sync_primary"),
    clean_ended_hours: hours,
    nudge_conflicts: bool(raw.nudge_conflicts, "nudge_conflicts"),
    explanations_keep_days: keep(raw.explanations_keep_days, "explanations_keep_days"),
    explanations_keep_per_run: keep(raw.explanations_keep_per_run, "explanations_keep_per_run"),
    interval_ms: interval,
  };
}
