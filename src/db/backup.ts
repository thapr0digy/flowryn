import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.ts";
import { localDate } from "../lifecycle/dates.ts";
import { ensureDir } from "../util/fsx.ts";

export const BACKUPS_KEPT = 7;
const BACKUP_FILE = /^flowryn-(\d{4}-\d{2}-\d{2})\.db$/;

export function listBackups(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => BACKUP_FILE.test(f))
    .toSorted()
    .map((f) => join(dir, f));
}

/**
 * Nightly backup: once per local day, VACUUM INTO a dated file, keeping the 7
 * newest (design section 13). Returns the new file, or null if today's exists.
 */
export function backupIfDue(db: Db, dir: string, now: Date = new Date()): string | null {
  ensureDir(dir, 0o700);
  const path = join(dir, `flowryn-${localDate(now)}.db`);
  if (existsSync(path)) return null;
  db.query("VACUUM INTO ?1").run(path);
  const backups = listBackups(dir);
  for (const old of backups.slice(0, Math.max(0, backups.length - BACKUPS_KEPT))) unlinkSync(old);
  return path;
}
