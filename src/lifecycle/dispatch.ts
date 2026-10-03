import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hashToken, mintToken } from "../api/auth.ts";
import { FlowrynError } from "../api/errors.ts";
import { boolArg, stringArg, type HandlerCtx, type HandlerResult, type VerbSpec } from "../api/verbs.ts";
import { findOpenItem, openItem } from "../attention/items.ts";
import type { FlowrynConfig } from "../config/config.ts";
import { herdrConfig, workersConfig } from "../config/workers.ts";
import { alertHerdrIfDue, noteHerdrNeeded, noteHerdrUp } from "../reconcile/herdr-health.ts";
import { workflowFor, type WorkflowDef } from "../config/workflows.ts";
import { tx, type Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { HARNESS_IDS, type HarnessId } from "../harness/types.ts";
import { recordIntent } from "../journal/journal.ts";
import { readSnapshot } from "../journal/snapshot.ts";
import type { HerdrRuntime } from "../runtime/herdr/runtime.ts";
import { sanitizeBlock } from "../util/sanitize.ts";
import { ulid } from "../util/ulid.ts";
import { mintTaskId } from "./ids.ts";
import { gateHarness, harnessRefusal } from "./harness-gate.ts";
import { getPlan, parsePlan, phaseOfTask, phasesOf, recordPlan, takenIds, waitingOn } from "./plans.ts";
import { getProject, type ProjectRow } from "./projects.ts";
import { openRunForTask } from "./runs.ts";

export const TASK_KINDS = ["ship", "scout"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** What a task may wait for: a ship lands; a decision lands once answered (its task is done). */
export const BLOCKER_KINDS = ["ship", "decision"] as const;

const MAX_TITLE = 120;
const MAX_BODY = 64_000;
/** tasks-axi keeps the backlog readable; the full text lives in the run's task.md. */
export const MAX_BACKLOG_BODY = 4_000;
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

// --- starting a run -------------------------------------------------------------------------

/** What a start needs from the running daemon: the runtime, the harness version and git. */
export interface StartDeps {
  db: Db;
  config(): FlowrynConfig;
  runtime(): HerdrRuntime | null;
  harnessVersion(harness: HarnessId, binary: string): Promise<string | null>;
  /** `git -C <cwd> <args>`: stdout trimmed, or null on failure. */
  git(cwd: string, args: string[]): Promise<string | null>;
  now(): number;
}

export function startDepsOf(ctx: HandlerCtx): StartDeps {
  return {
    db: ctx.db,
    config: ctx.config,
    runtime: () => ctx.fleet.runtime(),
    harnessVersion: (harness, binary) => ctx.fleet.harnessVersion(harness, binary),
    git: async (cwd, args) => {
      const result = await ctx.runTool("git", ["-C", cwd, ...args]);
      return result.exitCode === 0 ? result.stdout.trim() : null;
    },
    now: ctx.now,
  };
}

/**
 * Design section 14, primary checkout tangle: refuse, and say so once, with
 * one event and a P1, until the item is resolved; the scheduler's retries of
 * a ready phase add nothing. Change nothing.
 */
function recordTangle(deps: StartDeps, project: ProjectRow, branch: string | null): void {
  const { db } = deps;
  tx(db, () => {
    const key = `project:${project.id}`;
    if (findOpenItem(db, "checkout_tangle", key)) return;
    const event = appendEvent(db, { source: "cli", kind: "dispatch.refused", payload: { project: project.id, reason: "primary_checkout_tangle", branch } });
    openItem(db, {
      kind: "checkout_tangle",
      eventSeq: event.seq,
      taskId: key,
      line: `Project ${project.id}: its primary checkout ${project.path} is on ${branch ?? "a detached HEAD"}, not ${project.default_branch}; dispatch refused until it is back`,
      now: deps.now(),
    });
  });
}

/**
 * Herdr is unreachable, so nothing can start (design section 16): the refusal,
 * with the episode noted as holding work up, and its P1 if it is due.
 */
function herdrRefusal(deps: StartDeps, message: string, detail: string): FlowrynError {
  tx(deps.db, () => {
    noteHerdrNeeded(deps.db, detail, "cli", deps.now());
    alertHerdrIfDue(deps.db, herdrConfig(deps.config()).unreachable_alert_ms, deps.now());
  });
  return new FlowrynError("herdr_unavailable", message, "flowryn doctor");
}

/**
 * Can a worker start on this project now? Herdr reachable, the harness
 * installed with a passing contract for its version, and the primary checkout
 * on its default branch (the base the worktree branches from).
 */
export async function checkStart(deps: StartDeps, project: ProjectRow, harness: HarnessId): Promise<{ version: string; base: string }> {
  const runtime = deps.runtime();
  if (!runtime) throw herdrRefusal(deps, "Herdr is not configured or its socket was not found, so no worker can start", "no Herdr socket");
  try {
    await runtime.ping();
  } catch (error) {
    throw herdrRefusal(deps, `Herdr is not reachable (${(error as Error).message}), so no worker can start`, (error as Error).message);
  }
  tx(deps.db, () => noteHerdrUp(deps.db, "cli", deps.now()));
  // The installed version, checked at every dispatch; an untested one refuses and opens its P1 (sections 5 and 16).
  const check = await gateHarness(deps.db, deps.config(), harness, deps.harnessVersion, "cli", "dispatch", deps.now);
  if (check.state !== "verified") throw harnessRefusal(check);
  const version = check.version;
  const branch = await deps.git(project.path, ["branch", "--show-current"]);
  if (branch !== project.default_branch) {
    recordTangle(deps, project, branch || null);
    throw new FlowrynError("primary_checkout_tangle", `${project.path} is on ${branch || "a detached HEAD"}, not ${project.default_branch}`, `check out ${project.default_branch} there first`);
  }
  const base =
    (await deps.git(project.path, ["rev-parse", "--verify", `refs/heads/${project.default_branch}^{commit}`])) ??
    (await deps.git(project.path, ["rev-parse", "--verify", `refs/remotes/origin/${project.default_branch}^{commit}`]));
  if (!base) throw new FlowrynError("invalid_project", `cannot resolve ${project.default_branch} in ${project.path}`);
  return { version, base };
}

export interface NewRun {
  taskId: string;
  title: string;
  body: string;
  project: ProjectRow;
  kind: TaskKind;
  harness: HarnessId;
  version: string;
  base: string;
  workflow: WorkflowDef;
  sensitive: boolean;
  /** An existing Queued task (a plan phase): started in the backlog, not added. */
  existing: boolean;
  by: string;
  now: number;
}

/**
 * One transaction's worth of a new run (the caller holds it): the task
 * policy, the run in `launching` waiting for its first grant (the scheduler
 * grants a worker slot and the first stage's pools, then launches), the
 * tasks-axi intent and the event. The workflow is frozen into the event, so
 * a later config edit never reshapes a running run.
 */
export function createRun(db: Db, config: FlowrynConfig, r: NewRun): string {
  const runId = `r${ulid(r.now)}`;
  const workers = workersConfig(config);
  const worktree = join(workers.worktree_root, r.project.id, r.taskId);
  if (existsSync(worktree)) throw new FlowrynError("already_exists", `${worktree} already exists`);
  if (openRunForTask(db, r.taskId)) throw new FlowrynError("already_exists", `${r.taskId} already has a run`);
  const model = r.harness === "claude" ? workers.claude.model : workers.pi.model;
  const effort = r.harness === "claude" ? workers.claude.effort : workers.pi.effort;
  db.query(
    `INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, sensitive, workflow, auto, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8)
     ON CONFLICT(task_id) DO UPDATE SET workflow = excluded.workflow, sensitive = MAX(sensitive, excluded.sensitive)`,
  ).run(r.taskId, r.project.id, r.kind, r.project.delivery_mode, r.project.yolo, r.sensitive ? 1 : 0, r.workflow.id, r.now);
  const first = r.workflow.stages[0]!;
  // The run token is minted at launch and kept in the run's private directory; this hash is a placeholder no token matches.
  db.query(
    `INSERT INTO runs (id, task_id, harness, harness_version, model, effort, state, liveness, workflow, stage,
       agent_session, worktree_path, branch, base_sha, token_hash, started_at, updated_at,
       stage_state, waiting_since, pending_launch)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'launching', 'starting', ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14, 'waiting', ?14, 'fresh')`,
  ).run(runId, r.taskId, r.harness, r.version, model, effort, r.workflow.id, first.id, randomUUID(), worktree, `${workers.branch_prefix}${r.taskId}`, r.base, hashToken(mintToken("run")), r.now);
  const intent = r.existing
    ? recordIntent(db, { file: "backlog", verb: "start", taskId: r.taskId, positional: [r.taskId], now: r.now })
    : recordIntent(db, { file: "backlog", verb: "add", taskId: r.taskId, positional: [r.taskId, r.title], flags: { kind: r.kind, repo: r.project.id, body: r.body.slice(0, MAX_BACKLOG_BODY), start: true }, now: r.now });
  appendEvent(db, {
    source: "cli",
    kind: "run.dispatched",
    runId,
    taskId: r.taskId,
    payload: { project: r.project.id, kind: r.kind, harness: r.harness, version: r.version, title: r.title, body: r.body, base: r.base, worktree, intent: intent.id, by: r.by, workflow_def: r.workflow },
    ts: r.now,
  });
  return runId;
}

// --- dispatch -------------------------------------------------------------------------------

type DispatchPlan =
  | { mode: "now"; project: ProjectRow; harness: HarnessId; version: string; base: string }
  | { mode: "task"; project: ProjectRow; harness: HarnessId; version: string; base: string; taskId: string }
  | { mode: "queue"; project: ProjectRow; harness: HarnessId; blockedBy: string[] };

function harnessArg(args: Record<string, unknown>, fallback: HarnessId): HarnessId {
  const harness = (stringArg(args as never, "harness") ?? fallback) as HarnessId;
  if (!(HARNESS_IDS as readonly string[]).includes(harness)) throw new FlowrynError("bad_args", "--harness must be claude or pi");
  return harness;
}

/** A blocker's task kind: a plan phase is a ship; null when there is no such task. */
function blockerKind(db: Db, id: string): string | null {
  const policy = db.query("SELECT kind FROM task_policy WHERE task_id = ?1").get(id) as { kind: string } | null;
  if (policy) return policy.kind;
  if (db.query("SELECT 1 FROM plan_phases WHERE task_id = ?1").get(id)) return "ship";
  // A decision task has no task_policy row (cutover C1); the decisions table itself names it, so a
  // just-added decision task can be a blocker at once, before the backlog snapshot has caught up.
  if (db.query("SELECT 1 FROM decisions WHERE task_id = ?1").get(id)) return "decision";
  const task = (readSnapshot(db, "backlog")?.tasks ?? []).find((t) => t.id === id);
  return task ? (task.kind ?? "ship") : null;
}

async function prepareDispatch(ctx: HandlerCtx, args: Record<string, unknown>): Promise<DispatchPlan> {
  const projectId = stringArg(args as never, "project")!;
  const project = getProject(ctx.db, projectId);
  if (!project) throw new FlowrynError("not_found", `no project ${projectId}`, "flowryn project list");
  const taskId = stringArg(args as never, "task");
  if (taskId) {
    // Start a Queued task yourself (a plan phase, or a dispatch that waited): its blockers must have landed.
    const phase = phaseOfTask(ctx.db, taskId);
    if (!phase || phase.project_id !== project.id) throw new FlowrynError("not_found", `${taskId} is not a queued task of project ${project.id}`, "flowryn show <plan id>");
    if (phase.plan_state !== "approved") throw new FlowrynError("not_ready", `${taskId} belongs to plan ${phase.plan_id}, which is ${phase.plan_state}`);
    if (openRunForTask(ctx.db, taskId)) throw new FlowrynError("already_exists", `${taskId} already has a run`, `flowryn show ${taskId}`);
    const waiting = waitingOn(ctx.db, taskId, readSnapshot(ctx.db, "backlog")?.tasks ?? null, JSON.parse(phase.blocked_by) as string[]);
    if (waiting.length > 0) throw new FlowrynError("blockers_not_landed", `${taskId} waits for ${waiting.join(", ")} to land`, "a phase starts only after its blockers have landed, never on an open PR");
    const harness = harnessArg(args, (phase.harness as HarnessId | null) ?? project.harness);
    return { mode: "task", project, harness, taskId, ...(await checkStart(startDepsOf(ctx), project, harness)) };
  }
  const kind = stringArg(args as never, "kind");
  if (!kind || !(TASK_KINDS as readonly string[]).includes(kind)) throw new FlowrynError("bad_args", "--kind must be ship or scout");
  const harness = harnessArg(args, project.harness);
  const blockedBy = (args["blocked-by"] as string[] | undefined) ?? [];
  if (blockedBy.length > 0) {
    if (kind !== "ship") throw new FlowrynError("bad_args", "a task that waits for others is a ship");
    const kinds = new Map(blockedBy.map((id) => [id, blockerKind(ctx.db, id)]));
    const unknown = blockedBy.filter((id) => kinds.get(id) === null);
    if (unknown.length > 0) throw new FlowrynError("not_found", `no task ${unknown.join(", ")}`, "flowryn fleet");
    const unshipped = blockedBy.filter((id) => !(BLOCKER_KINDS as readonly string[]).includes(kinds.get(id) ?? ""));
    if (unshipped.length > 0) {
      throw new FlowrynError("bad_args", `${unshipped.map((id) => `${id} is a ${kinds.get(id)}`).join(", ")}: only a ship or a decision lands, so a task can wait only for those`, "wait for the report yourself, then dispatch");
    }
    return { mode: "queue", project, harness, blockedBy };
  }
  if (boolArg(args as never, "auto")) throw new FlowrynError("bad_args", "--auto goes with --blocked-by: a task that starts by itself once its blockers land");
  return { mode: "now", project, harness, ...(await checkStart(startDepsOf(ctx), project, harness)) };
}

/**
 * `flowryn dispatch <project> --kind ship|scout --body-file -` (design section
 * 12): start a worker on a new task. The run waits for its first capacity
 * grant (a worker slot and its first stage's pools), then launches.
 * `--blocked-by <task>` files it Queued instead, starting by itself once
 * those tasks land when `--auto` is given (section 11: ad hoc tasks stay
 * manual unless you pass --auto); `--task <id>` starts such a Queued task yourself.
 */
export const dispatchVerb: VerbSpec = {
  name: "dispatch",
  summary: "Start a worker on a task: a ship (ends in a PR) or a scout (ends in a report); --task starts a Queued one",
  positionals: [{ name: "project", required: true, help: "project id" }],
  flags: {
    kind: { type: "string", help: "ship or scout", placeholder: "kind" },
    "body-file": { type: "string", help: "the task, from a file or - for stdin", fileFor: "body" },
    title: { type: "string", help: "backlog title (default: the body's first line)", placeholder: "text" },
    harness: { type: "string", help: "claude or pi (default: the project's)", placeholder: "harness" },
    sensitive: { type: "boolean", help: "security-relevant: merges need a human record even under yolo" },
    workflow: { type: "string", help: "the workflow: feature, fix, or one from [workflows] (default: the project's; scouts: scout)", placeholder: "id" },
    "blocked-by": { type: "list", help: "file it Queued until these tasks land (repeatable)", placeholder: "task" },
    auto: { type: "boolean", help: "with --blocked-by: start by itself once its blockers land" },
    task: { type: "string", help: "start this Queued task (a plan phase) now; its blockers must have landed", placeholder: "id" },
  },
  kind: "mutation",
  roles: ["leader", "human"],
  prepare: (ctx, args) => prepareDispatch(ctx, args),
  apply(ctx, args, prepared) {
    const plan = prepared as DispatchPlan;
    const now = ctx.now();
    const config = ctx.config();
    if (plan.mode === "task") {
      const phase = phaseOfTask(ctx.db, plan.taskId)!;
      const workflow = workflowFor(config, stringArg(args, "workflow") ?? phase.workflow, "ship");
      const runId = createRun(ctx.db, config, { taskId: plan.taskId, title: phase.title, body: phase.body, project: plan.project, kind: "ship", harness: plan.harness, version: plan.version, base: plan.base, workflow, sensitive: boolArg(args, "sensitive"), existing: true, by: ctx.caller.role, now });
      return { data: { task: plan.taskId, run: runId, harness: `${plan.harness} ${plan.version}`, workflow: workflow.id, state: "launching" }, hints: [`flowryn show ${plan.taskId}`, "flowryn fleet"] };
    }
    const kind = stringArg(args, "kind") as TaskKind;
    const body = sanitizeBlock(stringArg(args, "body") ?? "").trim();
    if (body.length === 0) throw new FlowrynError("bad_args", "the task needs a body", "pass --body-file - with the task on stdin");
    if (body.length > MAX_BODY) throw new FlowrynError("bad_args", `the task body is over ${MAX_BODY} characters`);
    const title = taskTitleFrom(stringArg(args, "title"), body);
    const workflow = workflowFor(config, stringArg(args, "workflow") ?? (kind === "scout" ? "scout" : plan.project.workflow), kind);
    if (plan.mode === "queue") {
      const filed = recordPlan(ctx.db, {
        project: plan.project,
        title,
        phases: [{ title, body, workflow: workflow.id, harness: plan.harness, after: null }],
        sourceTask: null,
        gateId: null,
        workflow: workflow.id,
        harness: plan.harness,
        blockedBy: plan.blockedBy,
        filedBy: ctx.caller.role,
        state: "approved",
        now,
      });
      const taskId = filed.phases[0]!.task_id;
      if (!boolArg(args, "auto")) ctx.db.query("UPDATE task_policy SET auto = 0 WHERE task_id = ?1").run(taskId);
      if (boolArg(args, "sensitive")) ctx.db.query("UPDATE task_policy SET sensitive = 1 WHERE task_id = ?1").run(taskId);
      return {
        data: { task: taskId, plan: filed.id, state: "queued", blocked_by: plan.blockedBy, auto: boolArg(args, "auto") ? "on" : "off" },
        hints: boolArg(args, "auto") ? [`flowryn show ${taskId}`] : [`flowryn dispatch ${plan.project.id} --task ${taskId} (once its blockers land)`],
      };
    }
    const taskId = mintTaskId(title, takenIds(ctx.db));
    const runId = createRun(ctx.db, config, { taskId, title, body, project: plan.project, kind, harness: plan.harness, version: plan.version, base: plan.base, workflow, sensitive: boolArg(args, "sensitive"), existing: false, by: ctx.caller.role, now });
    return {
      data: { task: taskId, run: runId, harness: `${plan.harness} ${plan.version}`, mode: plan.project.delivery_mode, yolo: plan.project.yolo ? "on" : "off", workflow: workflow.id, state: "launching" },
      hints: [`flowryn show ${taskId}`, "flowryn fleet"],
    };
  },
  async settle(ctx, result) {
    await ctx.sched.passNow();
    return withStartState(ctx, result);
  },
};

/** After the scheduler looked: launching, or waiting for capacity (and why). */
function withStartState(ctx: HandlerCtx, result: HandlerResult): HandlerResult {
  const runId = typeof result.data.run === "string" ? result.data.run : null;
  if (!runId) return result;
  const row = ctx.db.query("SELECT stage_state, pending_launch FROM runs WHERE id = ?1").get(runId) as { stage_state: string; pending_launch: string | null } | null;
  if (row && (row.stage_state === "waiting" || row.pending_launch === "fresh")) return { ...result, data: { ...result.data, state: "waiting for capacity" }, hints: ["flowryn capacity", ...(result.hints ?? []).slice(0, 1)] };
  return result;
}

// --- plan -----------------------------------------------------------------------------------

/**
 * `flowryn plan <project> --body-file plan.md` (design section 11): file a
 * phased feature as ship tasks chained with blocked-by. Filed by the leader
 * it is approved as filed; each phase starts by itself once the phase before
 * it has landed (the project's autonomy decides: plan, or manual).
 */
export const planVerb: VerbSpec = {
  name: "plan",
  summary: "File a phased feature: one ship per ## section, each starting by itself once the one before it lands",
  positionals: [{ name: "project", required: true, help: "project id" }],
  flags: {
    "body-file": { type: "string", help: "the plan: an optional # title, then one ## section per phase", fileFor: "body" },
    title: { type: "string", help: "the plan's title (default: its # heading)", placeholder: "text" },
    workflow: { type: "string", help: "the phases' workflow (default: the project's; a phase's workflow: line wins)", placeholder: "id" },
    harness: { type: "string", help: "claude or pi (default: the project's; a phase's harness: line wins)", placeholder: "harness" },
  },
  kind: "mutation",
  roles: ["leader", "human"],
  apply(ctx, args) {
    const projectId = stringArg(args, "project")!;
    const project = getProject(ctx.db, projectId);
    if (!project) throw new FlowrynError("not_found", `no project ${projectId}`, "flowryn project list");
    const parsed = parsePlan(stringArg(args, "body") ?? "");
    const config = ctx.config();
    const workflow = stringArg(args, "workflow") ?? project.workflow;
    const harness = harnessArg(args, project.harness);
    for (const phase of parsed.phases) workflowFor(config, phase.workflow ?? workflow, "ship");
    workflowFor(config, workflow, "ship");
    const now = ctx.now();
    const title = stringArg(args, "title") ?? parsed.title ?? parsed.phases[0]!.title;
    const filed = recordPlan(ctx.db, { project, title, phases: parsed.phases, sourceTask: null, gateId: null, workflow, harness, filedBy: ctx.caller.role, state: "approved", now });
    return {
      data: {
        plan: filed.id,
        title,
        autonomy: project.autonomy,
        phases: phasesOf(ctx.db, filed.id).map((p) => ({ phase: p.phase_no, task: p.task_id, title: p.title, workflow: p.workflow, blocked_by: (JSON.parse(p.blocked_by) as string[]).join(" ") || "-" })),
      },
      hints: project.autonomy === "plan" ? [`flowryn show ${filed.id}`] : [`autonomy is manual: flowryn dispatch ${project.id} --task <id>`],
    };
  },
  async settle(ctx, result) {
    ctx.journal.kick();
    ctx.sched.kick();
    return result;
  },
};

/** `flowryn show <plan>`: the plan's phases and where each is. */
export function planView(db: Db, planId: string): Record<string, unknown> | null {
  const plan = getPlan(db, planId);
  if (!plan) return null;
  const backlog = readSnapshot(db, "backlog")?.tasks ?? null;
  return {
    plan: plan.id,
    title: plan.title,
    project: plan.project_id,
    state: plan.state,
    from: plan.source_task ? `${plan.source_task}${plan.gate_id ? ` (gate ${plan.gate_id})` : ""}` : `filed by ${plan.filed_by}`,
    phases: phasesOf(db, planId).map((p) => {
      const run = db.query("SELECT state, stage, stage_state FROM runs WHERE task_id = ?1 ORDER BY started_at DESC LIMIT 1").get(p.task_id) as { state: string; stage: string; stage_state: string } | null;
      const waiting = run ? [] : waitingOn(db, p.task_id, backlog, JSON.parse(p.blocked_by) as string[]);
      return {
        phase: p.phase_no,
        task: p.task_id,
        title: p.title,
        at: run ? `${run.state} · ${run.stage} ${run.stage_state}` : plan.state !== "approved" ? plan.state : waiting.length > 0 ? `queued, waits for ${waiting.join(" ")}` : "queued, ready",
      };
    }),
  };
}
