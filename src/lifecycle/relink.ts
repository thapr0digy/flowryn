import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Db } from "../db/db.ts";
import type { HandlerCtx } from "../api/verbs.ts";
import { appendEvent } from "../db/events.ts";
import { tx } from "../db/db.ts";
import { withRepoLock } from "../runtime/repo-lock.ts";
import { poolRoot, poolSlots } from "../runtime/treehouse.ts";
import { workersConfig } from "../config/workers.ts";
import { sanitizeLine } from "../util/sanitize.ts";

/**
 * A project's checkout moved (docs/notes/2026-11-01-flowryn-survive-a-xa.md):
 * its task worktrees' `.git` files still name the old admin dirs, and the
 * checkout's admin dirs name the old worktrees. `git worktree repair <paths>`
 * run in the moved checkout re-establishes both directions; it is idempotent,
 * so running it again is the retry.
 */

export type RelinkResult = "repaired" | "ok" | "failed";

export interface RelinkedWorktree {
  task: string;
  path: string;
  result: RelinkResult;
  detail?: string;
}

/** The worktrees of a project's runs that are not cleaned up, one per path, that still exist. */
export function projectWorktrees(db: Db, projectId: string): { task: string; path: string }[] {
  const rows = db
    .query(
      `SELECT r.task_id AS task, r.worktree_path AS path FROM runs r JOIN task_policy p ON p.task_id = r.task_id
       WHERE p.project_id = ?1 AND r.state != 'cleaned' AND (r.cleanup IS NULL OR r.cleanup != 'done')
       ORDER BY r.started_at`,
    )
    .all(projectId) as { task: string; path: string }[];
  const seen = new Set<string>();
  return rows.filter((r) => existsSync(r.path) && !seen.has(r.path) && seen.add(r.path) !== undefined);
}

/**
 * The project's treehouse pool worktrees no run holds (src/runtime/treehouse.ts): linked worktrees of the
 * checkout too, so a move breaks them alike, and the next lease would get a broken slot.
 */
function idlePoolSlots(ctx: HandlerCtx, projectId: string): { task: string; path: string }[] {
  const held = new Set(projectWorktrees(ctx.db, projectId).map((w) => w.path));
  return poolSlots(poolRoot(workersConfig(ctx.config()).worktree_root, projectId))
    .filter((path) => !held.has(path))
    .map((path) => ({ task: "(pool)", path }));
}

/** Runs of the project whose worker is up: it was launched with the old path in its sandbox. */
function liveRuns(db: Db, projectId: string): { task: string }[] {
  return db
    .query(
      `SELECT r.task_id AS task FROM runs r JOIN task_policy p ON p.task_id = r.task_id
       WHERE p.project_id = ?1 AND r.state NOT IN ('cleaned','failed','cancelled') AND r.liveness NOT IN ('dead','orphaned') ORDER BY r.started_at`,
    )
    .all(projectId) as { task: string }[];
}

/**
 * Where a worktree's `.git` file points, when that admin dir is missing (null
 * when the link is fine or the file is not a link). Read from the file, no git:
 * the doctor uses it too, with the daemon down.
 */
export function brokenGitLink(worktree: string): string | null {
  const file = join(worktree, ".git");
  let text: string;
  try {
    if (!statSync(file).isFile()) return null;
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!match) return null;
  const target = isAbsolute(match[1]!) ? match[1]! : resolve(worktree, match[1]!);
  return existsSync(target) ? null : target;
}

async function commonDir(ctx: HandlerCtx, dir: string): Promise<string | null> {
  const result = await ctx.runTool("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const out = result.stdout.trim();
  if (result.exitCode !== 0 || out === "") return null;
  try {
    return realpathSync(out);
  } catch {
    return null;
  }
}

/**
 * Relink every worktree of the project to the checkout at `checkout`, and
 * record what happened. `moved` (the path changed) also lists the live
 * workers, whose sandboxes still name the old path.
 */
export async function relinkWorktrees(ctx: HandlerCtx, projectId: string, checkout: string, moved: boolean): Promise<{ worktrees: RelinkedWorktree[]; live: { task: string }[] }> {
  const worktrees = [...projectWorktrees(ctx.db, projectId), ...idlePoolSlots(ctx, projectId)];
  const expected = await commonDir(ctx, checkout);
  const results: RelinkedWorktree[] = [];
  if (worktrees.length > 0) {
    const before = new Map<string, boolean>();
    for (const w of worktrees) before.set(w.path, expected !== null && (await commonDir(ctx, w.path)) === expected && brokenGitLink(w.path) === null);
    const repair = await withRepoLock(checkout, () => ctx.runTool("git", ["-C", checkout, "worktree", "repair", ...worktrees.map((w) => w.path)]));
    const repairError = repair.exitCode === 0 ? null : sanitizeLine(repair.stderr.trim() || repair.stdout.trim() || `git worktree repair exited ${repair.exitCode}`, 200);
    for (const w of worktrees) {
      const linked = expected !== null && brokenGitLink(w.path) === null && (await commonDir(ctx, w.path)) === expected;
      if (linked) results.push({ ...w, result: before.get(w.path) ? "ok" : "repaired" });
      else results.push({ ...w, result: "failed", detail: repairError ?? `still not linked to ${checkout}` });
    }
  }
  const live = moved ? liveRuns(ctx.db, projectId) : [];
  tx(ctx.db, () => {
    appendEvent(ctx.db, { source: "cli", kind: "project.relinked", payload: { id: projectId, path: checkout, worktrees: results, live: live.map((l) => l.task) } });
  });
  return { worktrees: results, live };
}

/** The fix for a worktree whose git link is broken: relink from the project's checkout, or give the project its new path. */
export function relinkHint(project: { id: string; path: string }, worktree: string): string {
  return existsSync(join(project.path, ".git"))
    ? `relink it: flowryn project set ${project.id} --path ${project.path} (or git -C ${project.path} worktree repair ${worktree})`
    : `project ${project.id}'s checkout ${project.path} is gone; if it moved: flowryn project set ${project.id} --path <its new path>`;
}
