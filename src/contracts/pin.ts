import { realpathSync } from "node:fs";
import { contractsCommand, type VersionOf } from "../lifecycle/harness-gate.ts";
import type { HarnessId } from "../harness/types.ts";

/** The harness binary and version a contract run tests, fixed when the run starts. */
export interface HarnessPin {
  harness: HarnessId;
  /** The real file behind the configured path, so an update that repoints a symlink does not reach the run. */
  binary: string;
  version: string;
}

/**
 * Resolve the harness once, at the start of a contract run. Claude's native
 * install keeps each version as its own file (~/.local/share/claude/versions/<ver>)
 * and its auto-updater repoints the `claude` symlink, so the real path is the
 * version under test for the whole run. A harness updated in place (the Pi
 * Launcher app replaces its bundled Pi) has no such file; `pinDrift` catches it.
 */
export async function pinHarness(harness: HarnessId, configured: string, versionOf: VersionOf): Promise<HarnessPin> {
  let binary: string;
  try {
    binary = realpathSync(configured);
  } catch {
    throw new Error(`${harness} is configured at ${configured}, which does not exist`);
  }
  const version = await versionOf(harness, binary);
  if (!version) throw new Error(`cannot read the ${harness} version from ${binary} --version`);
  return { harness, binary, version };
}

/** Why the pinned harness is no longer the version under test, or null while it still is. */
export async function pinDrift(pin: HarnessPin, versionOf: VersionOf): Promise<string | null> {
  const now = await versionOf(pin.harness, pin.binary);
  const rerun = `re-run ${contractsCommand(pin.harness)}`;
  if (!now) return `${pin.harness} ${pin.version} at ${pin.binary} was removed or cannot report its version mid-run; ${rerun}`;
  if (now !== pin.version) return `${pin.harness} updated to ${now} mid-run (the run started on ${pin.version}); ${rerun}`;
  return null;
}
