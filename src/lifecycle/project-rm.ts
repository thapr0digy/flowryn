import { FlowrynError } from "../api/errors.ts";
import { stringArg, type VerbSpec } from "../api/verbs.ts";
import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { readSnapshot } from "../journal/snapshot.ts";
import { sanitizeLine } from "../util/sanitize.ts";
import { LIVE_BATCH_SQL } from "../verify/batch-store.ts";
import { requireActiveProject } from "./projects.ts";

/**
 * `flowryn project rm` (docs/notes/2026-11-22-flowryn-project-rm-74.md): unregister a
 * project that has no open work. The row stays, marked removed, because runs, plans,
 * decisions and events still name it; upkeep, the scheduler and project list skip it.
 * The checkout and its worktrees on disk are never touched.
 */

const SHOWN = 5;

function named(what: string, found: string[]): string | null {
  if (found.length === 0) return null;
  const shown = found.slice(0, SHOWN).join(", ");
  return `${found.length} ${what} (${shown}${found.length > SHOWN ? ", ..." : ""})`;
}

function ids(db: Db, sql: string, projectId: string): string[] {
  return (db.query(sql).all(projectId) as { id: string }[]).map((r) => r.id);
}

/** Each kind of open work the project still has, one line per kind; empty when it may be removed. */
export function openWorkOf(db: Db, projectId: string): string[] {
  const backlog = readSnapshot(db, "backlog")?.tasks ?? [];
  const backlogState = new Map(backlog.map((t) => [t.id, t.state]));
  const openTasks = backlog.filter((t) => t.repo === projectId && t.state !== "done").map((t) => t.id);
  const pendingAdds = ids(db, `SELECT task_id AS id FROM intents WHERE state = 'pending' AND verb = 'add' AND json_extract(args, '$.flags.repo') = ?1 ORDER BY seq`, projectId);
  const phases = db
    .query(
      `SELECT ph.task_id AS id,
              EXISTS (SELECT 1 FROM runs r WHERE r.task_id = ph.task_id AND r.state = 'landed') AS landed,
              EXISTS (SELECT 1 FROM drops d WHERE d.task_id = ph.task_id) AS dropped
       FROM plan_phases ph JOIN plans pl ON pl.id = ph.plan_id
       WHERE pl.project_id = ?1 AND pl.state IN ('pending','approved') ORDER BY pl.id, ph.phase_no`,
    )
    .all(projectId) as { id: string; landed: number; dropped: number }[];
  const openPhases = phases.filter((p) => !p.dropped && !p.landed && backlogState.get(p.id) !== "done").map((p) => p.id);
  // A run's decision belongs to its task's project; a standalone one to the repo its backlog task names (or will, once its add applies).
  const backlogRepo = new Map<string, string | null>(backlog.map((t) => [t.id, t.repo]));
  for (const id of pendingAdds) backlogRepo.set(id, projectId);
  const openDecisions = (
    db.query("SELECT d.id, d.task_id, tp.project_id FROM decisions d LEFT JOIN task_policy tp ON tp.task_id = d.task_id WHERE d.state = 'open' ORDER BY d.id").all() as {
      id: string;
      task_id: string;
      project_id: string | null;
    }[]
  )
    .filter((d) => (d.project_id ?? backlogRepo.get(d.task_id)) === projectId)
    .map((d) => d.id);
  const lines = [
    named("live runs", ids(db, `SELECT r.task_id AS id FROM runs r JOIN task_policy tp ON tp.task_id = r.task_id WHERE tp.project_id = ?1 AND r.ended_at IS NULL ORDER BY r.started_at`, projectId)),
    named("queued or held tasks", [...new Set([...openTasks, ...pendingAdds])]),
    named("open plan phases", openPhases),
    named("open decisions", openDecisions),
    named("landing batches", ids(db, `SELECT id FROM landing_batches WHERE project_id = ?1 AND ${LIVE_BATCH_SQL} ORDER BY id`, projectId)),
    named("landing queue entries", ids(db, `SELECT task_id AS id FROM landing_queue WHERE project_id = ?1 AND state IN ('waiting','landing') ORDER BY enqueued_at`, projectId)),
    named("delivery watches", ids(db, `SELECT task_id AS id FROM watches WHERE project_id = ?1 AND state = 'open' ORDER BY created_at`, projectId)),
    named("verifies", ids(db, `SELECT id FROM verify_queue WHERE project_id = ?1 AND state IN ('queued','started') UNION SELECT id FROM verifications WHERE project_id = ?1 AND state = 'running'`, projectId)),
    named("asks", ids(db, `SELECT id FROM asks WHERE project_id = ?1 AND state IN ('queued','running') ORDER BY created_at`, projectId)),
  ];
  return lines.filter((l): l is string => l !== null);
}

const projectRm: VerbSpec = {
  name: "project rm",
  summary: "Unregister a project with no open work (its checkout and history stay)",
  positionals: [{ name: "id", required: true, help: "project id", complete: "project" }],
  flags: {
    reason: { type: "string", help: "why it goes, kept on its event", placeholder: "text" },
  },
  kind: "mutation",
  roles: ["leader", "human"],
  scope: { kind: "project", arg: "id" },
  apply(ctx, args) {
    const id = stringArg(args, "id")!;
    const project = requireActiveProject(ctx.db, id);
    const open = openWorkOf(ctx.db, id);
    if (open.length > 0) {
      throw new FlowrynError("project_busy", `project ${id} still has open work: ${open.join("; ")}`, "finish, cancel or drop it first, then run project rm again (flowryn fleet, flowryn show <id>)");
    }
    const reason = stringArg(args, "reason");
    const cleaned = reason === undefined ? null : sanitizeLine(reason, 300) || null;
    const now = ctx.now();
    ctx.db.query("UPDATE projects SET removed_at = ?2, removed_reason = ?3 WHERE id = ?1").run(id, now, cleaned);
    appendEvent(ctx.db, { source: "cli", kind: "project.removed", payload: { id, path: project.path, reason: cleaned, by: ctx.caller.role }, ts: now });
    return {
      data: { project: id, removed: new Date(now).toISOString(), path: project.path, reason: cleaned ?? "-" },
      hints: [`its checkout ${project.path} and worktrees are untouched; delete them yourself when you want`, "flowryn project list --all"],
    };
  },
};

export const PROJECT_RM_VERBS: VerbSpec[] = [projectRm];
