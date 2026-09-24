import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "../util/fsx.ts";

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;

export type Log = (message: string) => void;

/**
 * The daemon's own log, rotated by size (flowrynd.log, .1 … .3), so launchd's
 * stdout/stderr files only ever hold crash output (design section 15).
 */
export function fileLogger(logDir: string, alsoStderr: boolean): Log {
  ensureDir(logDir, 0o700);
  const path = join(logDir, "flowrynd.log");
  return (message: string) => {
    const line = `${new Date().toISOString()} ${message}\n`;
    try {
      if (existsSync(path) && statSync(path).size > MAX_BYTES) rotate(path);
      appendFileSync(path, line, { mode: 0o600 });
    } catch {
      // Logging must never take the daemon down; stderr still has it.
    }
    if (alsoStderr) process.stderr.write(line);
  };
}

function rotate(path: string): void {
  for (let i = KEEP - 1; i >= 1; i--) {
    if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
  }
  renameSync(path, `${path}.1`);
}
