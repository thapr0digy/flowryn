import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, normalize } from "node:path";
import type { FlowrynConfig } from "../config/config.ts";
import { spoolDir } from "../config/paths.ts";
import { scopeDenyFile } from "../policy/scope-paths.ts";
import type { Db } from "../db/db.ts";
import { projectScopeById, scopeIds, taskScope } from "./scope.ts";

/**
 * The folder guard's lists (docs/notes/2026-10-24-leader-scoping-and-vj.md).
 * For each scope, the folders that hold other scopes' work: their projects'
 * checkouts and worktrees, their tasks' report folders, their runs' state and
 * spool. The daemon rewrites one file per scope when they change; a leader's
 * hook reads its scope's file on every tool call (src/policy/toolkit.ts,
 * scope-paths), so a refusal holds with the daemon down. With one scope there
 * are no lists and nothing is refused.
 */

export interface ScopeDenyList {
  scope: string;
  paths: string[];
}

function clean(path: string): string {
  return normalize(path).replace(/\/+$/, "");
}

/** Each scope's denied folders, from the projects and runs Flowryn knows now. Empty with one scope. */
export function scopeDenyLists(db: Db, config: FlowrynConfig): ScopeDenyList[] {
  const scopes = scopeIds(config);
  if (scopes.length < 2) return [];
  const owned = new Map<string, Set<string>>(scopes.map((s) => [s, new Set<string>()]));
  const add = (scope: string | null, path: string | null | undefined) => {
    if (!path) return;
    // A thing of no known scope (a broken project rule) is every scope's to avoid: denied to all.
    for (const [s, paths] of owned) if (s !== scope) paths.add(clean(path));
  };
  const projects = db.query("SELECT id, path FROM projects").all() as { id: string; path: string }[];
  for (const p of projects) {
    const scope = projectScopeById(db, config, p.id);
    add(scope, p.path);
    add(scope, join(config.data_dir, "worktrees", p.id));
  }
  const tasks = db.query("SELECT task_id FROM task_policy").all() as { task_id: string }[];
  for (const { task_id } of tasks) {
    const scope = taskScope(db, config, task_id);
    if (scope === "global") continue;
    add(scope, join(config.data_dir, task_id));
  }
  const runs = db.query("SELECT id, task_id, worktree_path FROM runs").all() as { id: string; task_id: string; worktree_path: string | null }[];
  for (const r of runs) {
    const scope = taskScope(db, config, r.task_id);
    if (scope === "global") continue;
    add(scope, r.worktree_path);
    add(scope, join(config.state_dir, "runs", r.id));
    add(scope, join(spoolDir(config.data_dir), r.id));
  }
  return scopes.map((scope) => ({ scope, paths: [...owned.get(scope)!].toSorted() }));
}

const written = new Map<string, string>();

/** Write each scope's list when it changed (atomically: a hook never reads half a file). Returns the files written. */
export function writeScopeDenyLists(db: Db, config: FlowrynConfig): string[] {
  const out: string[] = [];
  for (const list of scopeDenyLists(db, config)) {
    const file = scopeDenyFile(config.state_dir, list.scope);
    const text = `${JSON.stringify({ scope: list.scope, paths: list.paths })}\n`;
    if (written.get(file) === text) continue;
    mkdirSync(join(config.state_dir, "leader", "scope-deny"), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, file);
    written.set(file, text);
    out.push(file);
  }
  return out;
}

let lastSignature: { config: FlowrynConfig; key: string } | null = null;

/**
 * Rewrite the lists when what they are made of changed: config, projects, policies or runs. Cheap
 * to call every attention tick, so a new run's folders are denied to the other scopes within a second.
 */
export function refreshScopeGuard(db: Db, config: FlowrynConfig): string[] {
  const row = db
    .query(
      `SELECT (SELECT COUNT(*) || ':' || COALESCE(MAX(rowid), 0) FROM projects) || '/' ||
              (SELECT COUNT(*) || ':' || COALESCE(MAX(rowid), 0) FROM task_policy) || '/' ||
              (SELECT COUNT(*) || ':' || COALESCE(MAX(rowid), 0) FROM runs) || '/' ||
              (SELECT COUNT(*) FROM runs WHERE worktree_path IS NOT NULL) || '/' ||
              (SELECT COUNT(*) || ':' || COALESCE(MAX(rowid), 0) FROM task_scopes) AS key`,
    )
    .get() as { key: string };
  if (lastSignature && lastSignature.config === config && lastSignature.key === row.key) return [];
  const out = writeScopeDenyLists(db, config);
  lastSignature = { config, key: row.key };
  return out;
}
