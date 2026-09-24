import { readFileSync } from "node:fs";
import type { Db } from "../db/db.ts";
import { sha256Hex } from "../util/hash.ts";
import { isMissing } from "../util/fsx.ts";
import type { BacklogTask } from "./tasks-axi.ts";

/** The two tasks-axi files Flowryn journals: tasks and personal to-dos. */
export type JournalFile = "backlog" | "todos";
export const JOURNAL_FILES: readonly JournalFile[] = ["backlog", "todos"];

export interface Snapshot {
  file: JournalFile;
  contentHash: string;
  tasks: BacklogTask[];
  readAt: number;
}

/** Hash of the file's bytes; a missing file hashes as empty, which is what tasks-axi reads it as. */
export function hashFile(path: string): string {
  try {
    return sha256Hex(readFileSync(path));
  } catch (error) {
    if (isMissing(error)) return sha256Hex("");
    throw error;
  }
}

export function readSnapshot(db: Db, file: JournalFile): Snapshot | null {
  const row = db.query("SELECT * FROM backlog_snapshot WHERE file = ?1").get(file) as
    | { file: JournalFile; content_hash: string; parsed: string; read_at: number }
    | null;
  if (!row) return null;
  return { file: row.file, contentHash: row.content_hash, tasks: JSON.parse(row.parsed) as BacklogTask[], readAt: row.read_at };
}

export function writeSnapshot(db: Db, file: JournalFile, contentHash: string, tasks: BacklogTask[], now = Date.now()): void {
  db.query(
    `INSERT INTO backlog_snapshot (file, content_hash, parsed, read_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(file) DO UPDATE SET content_hash = excluded.content_hash, parsed = excluded.parsed, read_at = excluded.read_at`,
  ).run(file, contentHash, JSON.stringify(tasks), now);
}

/** Replace or insert one task in a parsed list; used when a post-write list read fails. */
export function patchTasks(tasks: BacklogTask[], task: BacklogTask): BacklogTask[] {
  const index = tasks.findIndex((t) => t.id === task.id);
  if (index === -1) return [...tasks, task];
  const next = tasks.slice();
  next[index] = task;
  return next;
}
