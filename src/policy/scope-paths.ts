import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FlowrynConfig } from "../config/config.ts";
import { stateFiles } from "../config/paths.ts";

/**
 * The files a leader's hook reads for the scope-paths rule (src/policy/toolkit.ts;
 * docs/notes/2026-10-24-leader-scoping-and-vj.md). Kept apart from the daemon's
 * side (src/leader/scope-guard.ts) so a hook process loads nothing more.
 */

export function scopeDenyFile(stateDir: string, scope: string): string {
  return join(stateDir, "leader", "scope-deny", `${scope}.json`);
}

/** Flowryn's stores that hold every scope's tasks: a leader of a multi-scope home reads them only through the verbs. */
export function sharedStores(config: Pick<FlowrynConfig, "tasks" | "state_dir">): string[] {
  const db = stateFiles(config.state_dir).db;
  return [config.tasks.backlog, config.tasks.todos, db, `${db}-wal`, `${db}-shm`, join(config.state_dir, "backups")];
}

/** A leader hook's read of its scope's list; empty when there is none or it cannot be read. */
export function readScopeDeny(stateDir: string, scope: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(scopeDenyFile(stateDir, scope), "utf8")) as { paths?: unknown };
    return Array.isArray(parsed.paths) ? parsed.paths.filter((p): p is string => typeof p === "string" && p.startsWith("/")) : [];
  } catch {
    return [];
  }
}
