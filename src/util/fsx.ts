import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, statSync, writeSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { randomBytes } from "node:crypto";

/** Create a directory (and parents) and force its mode, which mkdir alone does not do for existing dirs. */
export function ensureDir(path: string, mode = 0o700): void {
  mkdirSync(path, { recursive: true, mode });
  const st = statSync(path);
  if (!st.isDirectory()) throw new Error(`${path} exists and is not a directory`);
  if ((st.mode & 0o777) !== mode) chmodSync(path, mode);
}

/** Write a file atomically: write a hidden temp file in the same directory, fsync, rename. */
export function writeFileAtomic(path: string, data: string | Uint8Array, mode = 0o600): void {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, typeof data === "string" ? Buffer.from(data) : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
