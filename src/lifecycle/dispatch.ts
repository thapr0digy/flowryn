import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hashToken, mintToken } from "../api/auth.ts";
import { FlowrynError } from "../api/errors.ts";
import { boolArg, stringArg, type HandlerCtx, type VerbSpec } from "../api/verbs.ts";
import { findOpenItem, openItem } from "../attention/items.ts";
import { resolveTool } from "../config/config.ts";
import { workersConfig } from "../config/workers.ts";
import { tx } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { HARNESS_IDS, type HarnessId } from "../harness/types.ts";
import { pendingIntents, recordIntent } from "../journal/journal.ts";
import { readSnapshot } from "../journal/snapshot.ts";
import { sanitizeBlock } from "../util/sanitize.ts";
import { ulid } from "../util/ulid.ts";
import { mintTaskId } from "./ids.ts";
import { getProject, type ProjectRow } from "./projects.ts";

export const TASK_KINDS = ["ship", "scout"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

const MAX_TITLE = 120;
const MAX_BODY = 64_000;
/** tasks-axi keeps the backlog readable; the full text lives in the run's task.md. */
const MAX_BACKLOG_BODY = 4_000;
const TRAILING_TAG = /\((?:kind|repo|priority|since|done|merged|hold|hold-kind|hold-until|blocked-by|pr|report): [^)]*\)\s*$/i;

/** The first line of the body, as a backlog title tasks-axi accepts. */
export function taskTitleFrom(explicit: string | undefined, body: string): string {
  const source = explicit ?? body.split("\n").find((line) => line.trim().length > 0) ?? "";
  let title = source.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim();
  while (TRAILING_TAG.test(title)) title = title.replace(TRAILING_TAG, "").trim();
  if (title.length > MAX_TITLE) title = `${title.slice(0, MAX_TITLE - 1).trimEnd()}…`;
  if (title.length === 0) throw new FlowrynError("bad_args", "the task needs a title", "pass --title or start the body with a line of text");
  return title;
}

/** The first stage of a workflow; workflows themselves arrive in M5. */
export function firstStage(kind: TaskKind): string {
  return kind === "scout" ? "investigate" : "build";
}

interface Prepared {
  project: ProjectRow;
  harness: HarnessId;
  version: string;
  base: string;
}

async function git(ctx: HandlerCtx, cwd: string, args: string[]): Promise<string | null> {
  const result = await ctx.runTool("git", ["-C", cwd, ...args]);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/** Design section 14, primary checkout tangle: refuse, and say so once as a P1; change nothing. */
function recordTangle(ctx: HandlerCtx, project: ProjectRow, branch: string | null): void {
  const { db } = ctx;
  tx(db, () => {
    const key = `project:${project.id}`;
    const event = appendEvent(db, { source: "cli", kind: "dispatch.refused", payload: { project: project.id, reason: "primary_checkout_tangle", branch } });
    if (!findOpenItem(db, "checkout_tangle", key)) {
      openItem(db, {
        kind: "checkout_tangle",
        eventSeq: event.seq,
        taskId: key,
        line: `Project ${project.id}: its primary checkout ${project.path} is on ${branch ?? "a detached HEAD"}, not ${project.default_branch}; dispatch refused until it is back`,
        now: ctx.now(),
      });
    }
  });
}

async function prepareDispatch(ctx: HandlerCtx, args: Record<string, unknown>): Promise<Prepared> {
  const projectId = stringArg(args as never, "project")!;
  const project = getProject(ctx.db, projectId);
  if (!project) throw new FlowrynError("not_found", `no project ${projectId}`, "flowryn project list");
  const kind = stringArg(args as never, "kind");
  if (!kind || !(TASK_KINDS as readonly string[]).includes(kind)) throw new FlowrynError("bad_args", "--kind must be ship or scout");
  const harness = (stringArg(args as never, "harness") ?? project.harness) as HarnessId;
  if (!(HARNESS_IDS as readonly string[]).includes(harness)) throw new FlowrynError("bad_args", "--harness must be claude or pi");
  const runtime = ctx.fleet.runtime();
  if (!runtime) throw new FlowrynError("herdr_unavailable", "Herdr is not configured, so no worker can start", "flowryn doctor");
  try {
    await runtime.ping();
  } catch (error) {
    throw new FlowrynError("herdr_unavailable", `Herdr is not reachable (${(error as Error).message}), so no worker can start`, "flowryn doctor");
  }
  const config = ctx.config();
  const binary = resolveTool(config, harness);
  if (!binary) throw new FlowrynError("tool_missing", `${harness} is not installed or not in [tools]`, "flowryn init");
  const version = await ctx.fleet.harnessVersion(harness, binary);
  if (!version) throw new FlowrynError("tool_missing", `cannot read the ${harness} version from ${binary} --version`);
  const passed = ctx.db.query("SELECT 1 FROM harness_contracts WHERE harness = ?1 AND version = ?2").get(harness, version);
  if (!passed) {
    throw new FlowrynError("contract_unverified", `no passing contract run for ${harness} ${version}`, `run the contract suite: flowryn doctor --contracts --harness ${harness}`);
  }
  const branch = await git(ctx, project.path, ["branch", "--show-current"]);
  if (branch !== project.default_branch) {
    recordTangle(ctx, project, branch || null);
    throw new FlowrynError("primary_checkout_tangle", `${project.path} is on ${branch || "a detached HEAD"}, not ${project.default_branch}`, `check out ${project.default_branch} there first`);
  }
  const base =
    (await git(ctx, project.path, ["rev-parse", "--verify", `refs/heads/${project.default_branch}^{commit}`])) ??
    (await git(ctx, project.path, ["rev-parse", "--verify", `refs/remotes/origin/${project.default_branch}^{commit}`]));
  if (!base) throw new FlowrynError("invalid_project", `cannot resolve ${project.default_branch} in ${project.path}`);
  return { project, harness, version, base };
}

function taken(ctx: HandlerCtx): (id: string) => boolean {
  const ids = new Set<string>();
  for (const row of ctx.db.query("SELECT task_id FROM task_policy").all() as { task_id: string }[]) ids.add(row.task_id);
  for (const task of readSnapshot(ctx.db, "backlog")?.tasks ?? []) ids.add(task.id);
  for (const intent of pendingIntents(ctx.db, "backlog")) if (intent.task_id) ids.add(intent.task_id);
  return (id) => ids.has(id);
}

/**
 * `flowryn dispatch <project> --kind ship|scout --body-file -` (design section
 * 12). One transaction records the task policy, the run in `launching`, the
 * tasks-axi `add … --start` intent and the event; the launch itself runs in the
 * background after commit, and `fleet` or `show` follow it.
 */
export const dispatchVerb: VerbSpec = {
  name: "dispatch",
  summary: "Start a worker on a task: a ship (ends in a PR) or a scout (ends in a report)",
  positionals: [{ name: "project", required: true, help: "project id" }],
  flags: {
    kind: { type: "string", help: "ship or scout", placeholder: "kind" },
    "body-file": { type: "string", help: "the task, from a file or - for stdin", fileFor: "body" },
    title: { type: "string", help: "backlog title (default: the body's first line)", placeholder: "text" },
    harness: { type: "string", help: "claude or pi (default: the project's)", placeholder: "harness" },
    sensitive: { type: "boolean", help: "security-relevant: merges need a human record even under yolo" },
  },
  kind: "mutation",
  roles: ["leader", "human"],
  prepare: (ctx, args) => prepareDispatch(ctx, args),
  apply(ctx, args, prepared) {
    const { project, harness, version, base } = prepared as Prepared;
    const kind = stringArg(args, "kind") as TaskKind;
    const body = sanitizeBlock(stringArg(args, "body") ?? "").trim();
    if (body.length === 0) throw new FlowrynError("bad_args", "the task needs a body", "pass --body-file - with the task on stdin");
    if (body.length > MAX_BODY) throw new FlowrynError("bad_args", `the task body is over ${MAX_BODY} characters`);
    const title = taskTitleFrom(stringArg(args, "title"), body);
    const now = ctx.now();
    const taskId = mintTaskId(title, taken(ctx));
    const runId = `r${ulid(now)}`;
    const workers = workersConfig(ctx.config());
    const worktree = join(workers.worktree_root, project.id, taskId);
    if (existsSync(worktree)) throw new FlowrynError("already_exists", `${worktree} already exists`);
    const workflow = kind === "scout" ? "scout" : project.workflow;
    const model = harness === "claude" ? workers.claude.model : workers.pi.model;
    const effort = harness === "claude" ? workers.claude.effort : workers.pi.effort;
    ctx.db
      .query(
        `INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, sensitive, workflow, auto, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8)`,
      )
      .run(taskId, project.id, kind, project.delivery_mode, project.yolo, boolArg(args, "sensitive") ? 1 : 0, workflow, now);
    // The run token is minted at launch and kept in the run's private directory; this hash is a placeholder no token matches.
    ctx.db
      .query(
        `INSERT INTO runs (id, task_id, harness, harness_version, model, effort, state, liveness, workflow, stage,
           agent_session, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'launching', 'starting', ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)`,
      )
      .run(runId, taskId, harness, version, model, effort, workflow, firstStage(kind), randomUUID(), worktree, `flowryn/${taskId}`, base, hashToken(mintToken("run")), now);
    const flags: Record<string, string | true> = { kind, repo: project.id, body: body.slice(0, MAX_BACKLOG_BODY), start: true };
    const intent = recordIntent(ctx.db, { file: "backlog", verb: "add", taskId, positional: [taskId, title], flags, now });
    appendEvent(ctx.db, {
      source: "cli",
      kind: "run.dispatched",
      runId,
      taskId,
      payload: { project: project.id, kind, harness, version, title, body, base, worktree, intent: intent.id, by: ctx.caller.role },
      ts: now,
    });
    return {
      data: { task: taskId, run: runId, harness: `${harness} ${version}`, mode: project.delivery_mode, yolo: project.yolo ? "on" : "off", state: "launching" },
      hints: [`flowryn show ${taskId}`, "flowryn fleet"],
    };
  },
  async settle(ctx, result) {
    ctx.fleet.launch(String(result.data.run), "fresh");
    return result;
  },
};
