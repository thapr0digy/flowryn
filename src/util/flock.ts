import { closeSync, openSync } from "node:fs";
import { dlopen, FFIType } from "bun:ffi";

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

type Libc = { symbols: { flock: (fd: number, op: number) => number } };
let libc: Libc | undefined;

function loadLibc(): Libc {
  if (libc) return libc;
  const name = process.platform === "darwin" ? "libc.dylib" : "libc.so.6";
  libc = dlopen(name, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }) as unknown as Libc;
  return libc;
}

export interface HeldLock {
  path: string;
  release(): void;
}

/**
 * Take an exclusive, non-blocking flock(2) on `path`. Returns null when another
 * process holds it. The kernel drops the lock when the process dies, so a
 * kill -9 never leaves a stale lock behind.
 */
export function tryExclusiveLock(path: string): HeldLock | null {
  const fd = openSync(path, "a", 0o600);
  const rc = loadLibc().symbols.flock(fd, LOCK_EX | LOCK_NB);
  if (rc !== 0) {
    closeSync(fd);
    return null;
  }
  let released = false;
  return {
    path,
    release() {
      if (released) return;
      released = true;
      loadLibc().symbols.flock(fd, LOCK_UN);
      closeSync(fd);
    },
  };
}

/** True when some process holds the lock; probes without keeping it. */
export function isLockHeld(path: string): boolean {
  const lock = tryExclusiveLock(path);
  if (!lock) return true;
  lock.release();
  return false;
}
