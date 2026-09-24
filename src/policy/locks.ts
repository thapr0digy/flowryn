import { statSync } from "node:fs";
import { runCommand } from "./command.ts";

/**
 * Git index.lock handling for cleanup (design section 14, cleanup order:
 * "never delete a live git index.lock"). A lock is provably stale only when
 * it exists, lsof proves nothing holds it or the worktree open, and it is at
 * least lock_age_ms old. Any doubt (lsof missing or failing, an unreadable
 * mtime) is "not provably stale", and the lock stays. Ported from Firstmate's
 * bin/fm-lock-lib.sh (fm_lock_is_provably_stale) at a09090d1.
 */

export type Holder = "held" | "free" | "unknown";

/** lsof -- <path>: exit 0 means a process holds it, exit 1 with no output means provably none, anything else is unknown. */
export async function holderOf(lsof: string | null, path: string): Promise<Holder> {
  if (!lsof) return "unknown";
  const result = await runCommand([lsof, "--", path], { timeoutMs: 10_000 });
  if (result.code === 0) return "held";
  if (result.code === 1 && result.stdout.trim() === "" && result.stderr.trim() === "") return "free";
  return "unknown";
}

export interface Staleness {
  stale: boolean;
  why: string;
}

export async function provablyStale(lsof: string | null, lock: string, companion: string, minAgeMs: number, now = Date.now()): Promise<Staleness> {
  for (const target of [lock, companion]) {
    const holder = await holderOf(lsof, target);
    if (holder === "held") return { stale: false, why: `a live process holds ${target}` };
    if (holder === "unknown") return { stale: false, why: `cannot tell whether a process holds ${target} (lsof ${lsof ? "failed" : "is missing"})` };
  }
  let mtime: number;
  try {
    mtime = statSync(lock).mtimeMs;
  } catch (error) {
    return { stale: false, why: `cannot read the mtime of ${lock}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}` };
  }
  const age = now - mtime;
  if (age < minAgeMs) return { stale: false, why: `${lock} is only ${Math.round(age / 1000)}s old` };
  return { stale: true, why: `${lock} is ${Math.round(age / 1000)}s old and nothing holds it` };
}
