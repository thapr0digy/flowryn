import { existsSync, lstatSync, readdirSync, renameSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ensureDir, writeFileAtomic } from "../util/fsx.ts";

/**
 * The binary every caller runs: workers' FLOWRYN_BIN and the leader's hooks
 * use `<state>/bin/flowryn`, a link to a copy of the build the running daemon
 * runs (`flowryn-<build>`), never the installed `dist/flowryn` itself. A
 * rebuild of the installed binary then changes nothing for a caller until the
 * daemon restarts onto it, so a build that bumps the protocol never leaves
 * callers speaking a protocol the running daemon refuses (exit 76). Each
 * daemon pins its own build at startup, before it opens its socket, so every
 * caller switches at the restart. A development command has no build and
 * keeps its wrapper script (src/lifecycle/fleet-services.ts workerBinary).
 */

/** Pinned copies kept, the running one included: a caller mid-exec of an older one still finds it. */
export const PINNED_KEPT = 3;
const PINNED_FILE = /^flowryn-[0-9a-f]{12}$/;

export function binDir(stateDir: string): string {
  return join(stateDir, "bin");
}

/** The path callers run. */
export function callerLink(stateDir: string): string {
  return join(binDir(stateDir), "flowryn");
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The pinned link, when it exists and points at a file; null otherwise. */
export function pinnedLink(stateDir: string): string | null {
  const link = callerLink(stateDir);
  return isLink(link) && existsSync(link) ? link : null;
}

/** Replace `path` with a symlink to `target` in one rename, so a caller never sees it missing. */
function swapLink(path: string, target: string): void {
  const tmp = `${path}.${randomBytes(4).toString("hex")}.link`;
  symlinkSync(target, tmp);
  try {
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // never created
    }
    throw error;
  }
}

/**
 * Pin the running build: write `flowryn-<build>` from the bytes this daemon
 * hashed (unless a copy is already there), point the link at it, and keep the
 * newest PINNED_KEPT copies. Returns the link.
 */
export function pinCallerBinary(stateDir: string, build: string, bytes: Uint8Array, now: Date = new Date()): string {
  const dir = binDir(stateDir);
  ensureDir(dir, 0o700);
  const name = `flowryn-${build}`;
  const copy = join(dir, name);
  let present = false;
  try {
    present = statSync(copy).size === bytes.byteLength;
  } catch {
    present = false;
  }
  if (!present) writeFileAtomic(copy, bytes, 0o700);
  swapLink(callerLink(stateDir), name);
  prunePinned(dir, name, now);
  return callerLink(stateDir);
}

function prunePinned(dir: string, current: string, now: Date): void {
  const others = readdirSync(dir)
    .filter((f) => PINNED_FILE.test(f) && f !== current)
    .map((f) => {
      try {
        return { f, mtime: statSync(join(dir, f)).mtimeMs };
      } catch {
        return { f, mtime: now.getTime() };
      }
    })
    .toSorted((a, b) => b.mtime - a.mtime);
  for (const old of others.slice(PINNED_KEPT - 1)) {
    try {
      unlinkSync(join(dir, old.f));
    } catch {
      // a caller's own cleanup, or already gone
    }
  }
}

/** Remove a pinned link before a development daemon writes its wrapper script there (a write would follow the link into the copy). */
export function unpinForScript(stateDir: string): void {
  const link = callerLink(stateDir);
  if (isLink(link)) unlinkSync(link);
}
