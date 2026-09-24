import { existsSync, realpathSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { FlowrynError } from "../api/errors.ts";
import { appendEvent } from "../db/events.ts";
import type { Db } from "../db/db.ts";
import { boolArg, intArg, stringArg, type Args, type HandlerCtx, type VerbSpec } from "../api/verbs.ts";
import { slugify } from "./ids.ts";

export const DELIVERY_MODES = ["no-mistakes", "direct-PR", "local-only"] as const;
export const HARNESSES = ["claude", "pi"] as const;
export const AUTONOMY = ["plan", "manual"] as const;
const WORKFLOW_ID = /^[a-z][a-z0-9-]{0,31}$/;
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface ProjectRow {
  id: string;
  repo_url: string;
  path: string;
  default_branch: string;
  delivery_mode: (typeof DELIVERY_MODES)[number];
  yolo: number;
  priority: number;
  harness: (typeof HARNESSES)[number];
  workflow: string;
  autonomy: (typeof AUTONOMY)[number];
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], flag: string): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new FlowrynError("invalid_project", `--${flag} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function priorityArg(args: Args): number | undefined {
  const value = intArg(args, "priority");
  if (value === undefined) return undefined;
  if (value < 0 || value > 4) throw new FlowrynError("invalid_project", "--priority must be 0 (highest) to 4");
  return value;
}

function workflowArg(args: Args): string | undefined {
  const value = stringArg(args, "workflow");
  if (value !== undefined && !WORKFLOW_ID.test(value)) throw new FlowrynError("invalid_project", "--workflow must be a workflow id such as fix, feature or scout");
  return value;
}

function onOff(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (value === "on") return 1;
  if (value === "off") return 0;
  throw new FlowrynError("invalid_project", `--${flag} must be on or off`);
}

export function getProject(db: Db, id: string): ProjectRow | null {
  return db.query("SELECT * FROM projects WHERE id = ?1").get(id) as ProjectRow | null;
}

export function listProjects(db: Db): ProjectRow[] {
  return db.query("SELECT * FROM projects ORDER BY priority, id").all() as ProjectRow[];
}

function projectView(p: ProjectRow): Record<string, unknown> {
  return {
    id: p.id,
    path: p.path,
    repo: p.repo_url || "-",
    branch: p.default_branch,
    mode: p.delivery_mode,
    yolo: p.yolo ? "on" : "off",
    priority: p.priority,
    harness: p.harness,
    workflow: p.workflow,
    autonomy: p.autonomy,
  };
}

interface RepoFacts {
  path: string;
  repoUrl: string | null;
  defaultBranch: string | null;
}

async function git(ctx: HandlerCtx, cwd: string, args: string[]): Promise<string | null> {
  const result = await ctx.runTool("git", ["-C", cwd, ...args]);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/** Read what git knows about a checkout: its top level, origin URL and default branch. */
async function inspectRepo(ctx: HandlerCtx, rawPath: string): Promise<RepoFacts> {
  if (!isAbsolute(rawPath)) throw new FlowrynError("invalid_project", "project path must be absolute");
  if (!existsSync(rawPath)) throw new FlowrynError("invalid_project", `no such directory: ${rawPath}`);
  const path = realpathSync(rawPath);
  const top = await git(ctx, path, ["rev-parse", "--show-toplevel"]);
  if (!top) throw new FlowrynError("invalid_project", `${path} is not a git checkout`);
  if (realpathSync(top) !== path) {
    throw new FlowrynError("invalid_project", `${path} is inside the checkout ${top}; register the top level`, `flowryn project add ${top}`);
  }
  const repoUrl = await git(ctx, path, ["remote", "get-url", "origin"]);
  const originHead = await git(ctx, path, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const defaultBranch = originHead ? originHead.replace(/^origin\//, "") : await git(ctx, path, ["symbolic-ref", "--short", "HEAD"]);
  return { path, repoUrl, defaultBranch };
}

const projectAdd: VerbSpec = {
  name: "project add",
  summary: "Register a repository checkout as a project",
  positionals: [{ name: "path", required: true, help: "absolute path of the primary checkout" }],
  flags: {
    id: { type: "string", help: "project id (default: the directory name)" },
    "repo-url": { type: "string", help: "remote URL (default: origin)", placeholder: "url" },
    "default-branch": { type: "string", help: "default branch (default: origin/HEAD)", placeholder: "branch" },
    mode: { type: "string", help: "delivery mode: no-mistakes, direct-PR or local-only", placeholder: "mode" },
    yolo: { type: "boolean", help: "merge green, non-sensitive work without a human record" },
    priority: { type: "int", help: "0 (highest) to 4; default 2", placeholder: "n" },
    harness: { type: "string", help: "worker harness: claude or pi", placeholder: "harness" },
    workflow: { type: "string", help: "default workflow: fix, feature, scout", placeholder: "workflow" },
    autonomy: { type: "string", help: "plan or manual", placeholder: "mode" },
  },
  kind: "mutation",
  roles: ["leader", "human"],
  prepare: (ctx, args) => inspectRepo(ctx, stringArg(args, "path")!),
  apply(ctx, args, prepared) {
    const facts = prepared as RepoFacts;
    const id = stringArg(args, "id") ?? slugify(basename(facts.path), 6);
    if (!PROJECT_ID.test(id)) throw new FlowrynError("invalid_project", "--id must be lowercase letters, digits and dashes");
    if (getProject(ctx.db, id)) throw new FlowrynError("already_exists", `project ${id} already exists`, `flowryn project set ${id} ...`);
    const byPath = ctx.db.query("SELECT id FROM projects WHERE path = ?1").get(facts.path) as { id: string } | null;
    if (byPath) throw new FlowrynError("already_exists", `${facts.path} is already project ${byPath.id}`);
    const mode = oneOf(stringArg(args, "mode"), DELIVERY_MODES, "mode") ?? "no-mistakes";
    const repoUrl = stringArg(args, "repo-url") ?? facts.repoUrl ?? "";
    if (repoUrl === "" && mode !== "local-only") {
      throw new FlowrynError("invalid_project", `${facts.path} has no origin remote`, "pass --repo-url, or --mode local-only");
    }
    const defaultBranch = stringArg(args, "default-branch") ?? facts.defaultBranch;
    if (!defaultBranch) throw new FlowrynError("invalid_project", "cannot tell the default branch", "pass --default-branch <branch>");
    const row: ProjectRow = {
      id,
      repo_url: repoUrl,
      path: facts.path,
      default_branch: defaultBranch,
      delivery_mode: mode,
      yolo: boolArg(args, "yolo") ? 1 : 0,
      priority: priorityArg(args) ?? 2,
      harness: oneOf(stringArg(args, "harness"), HARNESSES, "harness") ?? "claude",
      workflow: workflowArg(args) ?? "fix",
      autonomy: oneOf(stringArg(args, "autonomy"), AUTONOMY, "autonomy") ?? "plan",
    };
    ctx.db
      .query(
        `INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode, yolo, priority, harness, workflow, autonomy)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .run(row.id, row.repo_url, row.path, row.default_branch, row.delivery_mode, row.yolo, row.priority, row.harness, row.workflow, row.autonomy);
    appendEvent(ctx.db, { source: "cli", kind: "project.added", payload: row });
    return { data: { project: projectView(row) }, hints: ["flowryn project list", `flowryn project set ${id} --mode <mode>`] };
  },
};

const SETTABLE: Record<string, keyof ProjectRow> = {
  mode: "delivery_mode",
  yolo: "yolo",
  priority: "priority",
  harness: "harness",
  workflow: "workflow",
  autonomy: "autonomy",
  "default-branch": "default_branch",
  "repo-url": "repo_url",
};

const projectSet: VerbSpec = {
  name: "project set",
  summary: "Change a project's delivery mode, yolo posture, priority or defaults",
  positionals: [{ name: "id", required: true, help: "project id" }],
  flags: {
    mode: { type: "string", help: "no-mistakes, direct-PR or local-only", placeholder: "mode" },
    yolo: { type: "string", help: "on or off", placeholder: "on|off" },
    priority: { type: "int", help: "0 (highest) to 4", placeholder: "n" },
    harness: { type: "string", help: "claude or pi", placeholder: "harness" },
    workflow: { type: "string", help: "fix, feature, scout", placeholder: "workflow" },
    autonomy: { type: "string", help: "plan or manual", placeholder: "mode" },
    "default-branch": { type: "string", help: "default branch", placeholder: "branch" },
    "repo-url": { type: "string", help: "remote URL", placeholder: "url" },
  },
  kind: "mutation",
  roles: ["leader", "human"],
  apply(ctx, args) {
    const id = stringArg(args, "id")!;
    const current = getProject(ctx.db, id);
    if (!current) throw new FlowrynError("not_found", `no project ${id}`, "flowryn project list");
    const updates: Partial<ProjectRow> = {};
    const mode = oneOf(stringArg(args, "mode"), DELIVERY_MODES, "mode");
    if (mode) updates.delivery_mode = mode;
    const yolo = onOff(stringArg(args, "yolo"), "yolo");
    if (yolo !== undefined) updates.yolo = yolo;
    const priority = priorityArg(args);
    if (priority !== undefined) updates.priority = priority;
    const harness = oneOf(stringArg(args, "harness"), HARNESSES, "harness");
    if (harness) updates.harness = harness;
    const workflow = workflowArg(args);
    if (workflow) updates.workflow = workflow;
    const autonomy = oneOf(stringArg(args, "autonomy"), AUTONOMY, "autonomy");
    if (autonomy) updates.autonomy = autonomy;
    const branch = stringArg(args, "default-branch");
    if (branch) updates.default_branch = branch;
    const repoUrl = stringArg(args, "repo-url");
    if (repoUrl) updates.repo_url = repoUrl;
    const changed = Object.entries(updates).filter(([key, value]) => current[key as keyof ProjectRow] !== value);
    if (Object.keys(updates).length === 0) {
      throw new FlowrynError("bad_args", "nothing to change", `flags: ${Object.keys(SETTABLE).map((f) => `--${f}`).join(" ")}`);
    }
    const next = { ...current, ...updates };
    if (next.repo_url === "" && next.delivery_mode !== "local-only") {
      throw new FlowrynError("invalid_project", `project ${id} has no remote, so its mode must stay local-only`, "pass --repo-url too");
    }
    const columns = new Set<string>(Object.values(SETTABLE));
    for (const [column, value] of changed) {
      // Column names come from SETTABLE, never from input; values are bound parameters.
      if (!columns.has(column)) throw new Error(`refusing to update unexpected column ${column}`);
      ctx.db.query(`UPDATE projects SET ${column} = ?2 WHERE id = ?1`).run(id, value as string | number);
    }
    appendEvent(ctx.db, {
      source: "cli",
      kind: "project.updated",
      payload: { id, changes: Object.fromEntries(changed.map(([key, value]) => [key, { from: current[key as keyof ProjectRow], to: value }])) },
    });
    return { data: { project: projectView(next), changed: changed.map(([key]) => key) }, hints: ["flowryn project list"] };
  },
};

const projectList: VerbSpec = {
  name: "project list",
  summary: "List registered projects",
  positionals: [],
  flags: {},
  kind: "read",
  roles: ["leader", "reader", "human"],
  read(ctx) {
    const projects = listProjects(ctx.db).map((p) => ({
      id: p.id,
      mode: p.delivery_mode,
      yolo: p.yolo ? "on" : "off",
      priority: p.priority,
      harness: p.harness,
      branch: p.default_branch,
      path: p.path,
    }));
    return { data: { projects }, hints: projects.length === 0 ? ["flowryn project add <path>"] : ["flowryn project set <id> --mode <mode>"] };
  },
};

export const PROJECT_VERBS: VerbSpec[] = [projectAdd, projectSet, projectList];
