import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../util/fsx.ts";

/**
 * The record a launchd restart's helper leaves when it gives up
 * (src/service/relaunch.ts): `<state_dir>/restart-failed.json`. The CLI shows
 * it while the daemon is down; the next daemon turns it into a P1 and removes it.
 */

const FAILURE_FILE = "restart-failed.json";
/** What the user runs when a restart leaves the daemon down: the bootout and bootstrap that fixed it on 2026-10-23. */
export const RECOVERY_COMMAND = "flowryn daemon install";

export interface RestartFailure {
  at: number;
  label: string;
  old_pid: number;
  /** Each step the helper took and what came of it. */
  steps: string[];
  /** launchctl print's state lines for the agent at the end ("not loaded" when it is not). */
  launchd: string;
  run: string;
}

export function restartFailurePath(stateDir: string): string {
  return join(stateDir, FAILURE_FILE);
}

export function writeRestartFailure(stateDir: string, failure: RestartFailure): void {
  writeFileAtomic(restartFailurePath(stateDir), `${JSON.stringify(failure, null, 2)}\n`, 0o600);
}

/** The failure record, or null when there is none (or it cannot be read). */
export function readRestartFailure(stateDir: string): RestartFailure | null {
  const path = restartFailurePath(stateDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RestartFailure;
  } catch {
    return null;
  }
}

export function clearRestartFailure(stateDir: string): void {
  try {
    unlinkSync(restartFailurePath(stateDir));
  } catch {
    // already gone
  }
}

/** One line for a person: what happened and what to run. */
export function failureLine(failure: RestartFailure): string {
  const last = failure.steps.at(-1) ?? "no step ran";
  return `the daemon restart at ${new Date(failure.at).toISOString()} did not bring flowrynd back (launchd: ${failure.launchd}; ${last}); run ${failure.run} in your terminal`;
}
