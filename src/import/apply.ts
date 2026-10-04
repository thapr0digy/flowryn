import { FlowrynError } from "../api/errors.ts";
import { boolArg, stringArg, type VerbSpec } from "../api/verbs.ts";
import { decisionsConfig, reservedReason } from "../attention/decisions-policy.ts";
import { setMeta } from "../db/db.ts";
import { defaultAutonomy } from "../config/workflows.ts";
import { createStandaloneDecision } from "../lifecycle/decisions.ts";
import { getProject, inspectRepo, insertProject, type ProjectRow, type RepoFacts } from "../lifecycle/projects.ts";
import { queueTask } from "../lifecycle/queued.ts";
import type { FmDecision } from "./firstmate.ts";

/**
 * `import.apply` (cutover C3): the daemon half of `flowryn import firstmate`.
 * The CLI parses the Firstmate home and clones; this records what it found:
 * projects, queued tasks and decisions, each marked firstmate:<id>, so a
 * second run reports exists and changes nothing. Your own terminal only.
 */

export interface ImportPlan {
  projects: { name: string; path: string; mode: "no-mistakes" | "direct-PR" | "local-only"; yolo: boolean }[];
  tasks: { id: string; project: string; kind: "ship" | "scout"; title: string; body: string; priority: number | null; blockedBy: string[] }[];
  decisions: FmDecision[];
}

export interface PlanRow {
  item: string;
  kind: "project" | "task" | "decision";
  action: "create" | "exists" | "refuse";
  reason: string;
}

const source = (id: string) => `firstmate:${id}`;

function parsePlan(raw: string | undefined): ImportPlan {
  try {
    const plan = JSON.parse(raw ?? "") as ImportPlan;
    if (!Array.isArray(plan.projects) || !Array.isArray(plan.tasks) || !Array.isArray(plan.decisions)) throw new Error("shape");
    return plan;
  } catch {
    throw new FlowrynError("bad_args", "plan must be the JSON the import command builds");
  }
}

export const importApply: VerbSpec = {
  name: "import.apply",
  summary: "Internal: record a Firstmate import (projects, tasks, decisions)",
  positionals: [],
  flags: { plan: { type: "string", help: "the import plan, JSON" }, dry: { type: "boolean", help: "report only" } },
  kind: "mutation",
  roles: ["human"],
  async prepare(ctx, args) {
    const plan = parsePlan(stringArg(args, "plan"));
    const facts: Record<string, RepoFacts | string> = {};
    for (const p of plan.projects) {
      try {
        facts[p.name] = await inspectRepo(ctx, p.path);
      } catch (error) {
        facts[p.name] = (error as Error).message;
      }
    }
    return { plan, facts };
  },
  apply(ctx, args, prepared) {
    const { plan, facts } = prepared as { plan: ImportPlan; facts: Record<string, RepoFacts | string> };
    const dry = boolArg(args, "dry");
    const rows: PlanRow[] = [];
    const now = ctx.now();
    for (const p of plan.projects) {
      const existing = ctx.db.query("SELECT id FROM projects WHERE import_source = ?1").get(source(p.name)) as { id: string } | null;
      if (existing) {
        rows.push({ item: p.name, kind: "project", action: "exists", reason: `project ${existing.id}` });
        continue;
      }
      const f = facts[p.name]!;
      if (typeof f === "string") {
        rows.push({ item: p.name, kind: "project", action: dry ? "create" : "refuse", reason: dry ? "clone, then register" : f });
        continue;
      }
      if (getProject(ctx.db, p.name)) {
        rows.push({ item: p.name, kind: "project", action: "refuse", reason: `project ${p.name} already exists and was not imported` });
        continue;
      }
      if (!dry) {
        const row: ProjectRow = { id: p.name, repo_url: f.repoUrl ?? "", path: f.path, default_branch: f.defaultBranch ?? "main", delivery_mode: p.mode, yolo: p.yolo ? 1 : 0, priority: 2, harness: "claude", workflow: "fix", autonomy: defaultAutonomy(ctx.config()) };
        insertProject(ctx.db, row, source(p.name));
      }
      rows.push({ item: p.name, kind: "project", action: "create", reason: `${p.mode}${p.yolo ? " +yolo" : ""}` });
    }
    for (const t of plan.tasks) {
      if (ctx.db.query("SELECT 1 FROM task_policy WHERE task_id = ?1").get(t.id)) {
        rows.push({ item: t.id, kind: "task", action: "exists", reason: "already filed" });
        continue;
      }
      const project = getProject(ctx.db, t.project);
      if (!project && !dry) {
        rows.push({ item: t.id, kind: "task", action: "refuse", reason: `project ${t.project} is not registered` });
        continue;
      }
      if (!dry) queueTask(ctx.db, { taskId: t.id, title: t.title, body: t.body, kind: t.kind, project: project!, priority: t.priority, blockedBy: t.blockedBy, importSource: source(t.id), now });
      rows.push({ item: t.id, kind: "task", action: "create", reason: `queued ${t.kind}` });
    }
    const cfg = decisionsConfig(ctx.config());
    for (const d of plan.decisions) {
      if (ctx.db.query("SELECT 1 FROM decisions WHERE import_source = ?1").get(source(d.id))) {
        rows.push({ item: d.id, kind: "decision", action: "exists", reason: "already imported" });
        continue;
      }
      const reserved = reservedReason({ question: d.question, context: d.context, sourceReason: null, blocksYoloOff: false }, cfg);
      if (!dry) {
        const made = createStandaloneDecision(ctx.db, { key: d.key, question: d.question, options: [], context: d.context, origin: d.origin, reservedReason: reserved, project: d.project, now });
        ctx.db.query("UPDATE decisions SET import_source = ?2 WHERE id = ?1").run(made.id, source(d.id));
      }
      rows.push({ item: d.id, kind: "decision", action: "create", reason: reserved ? `reserved: ${reserved}` : "the leader may decide" });
    }
    if (!dry && rows.some((r) => r.kind === "decision" && r.action === "create")) setMeta(ctx.db, "import_triage", "1");
    return { data: { rows } };
  },
  async settle(ctx, result) {
    ctx.journal.kick();
    return result;
  },
};
