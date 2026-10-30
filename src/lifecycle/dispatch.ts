import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hashToken, mintToken } from "../api/auth.ts";
import { FlowrynError } from "../api/errors.ts";
import { boolArg, stringArg, type HandlerCtx, type HandlerResult, type VerbSpec } from "../api/verbs.ts";
import { decisionsConfig } from "../attention/decisions-policy.ts";
import { findOpenItem, openItem } from "../attention/items.ts";
import { resolveTool, type FlowrynConfig } from "../config/config.ts";
import { resolveAccount, type Account } from "../config/accounts.ts";
import { herdrConfig, workersConfig } from "../config/workers.ts";
import { accountSignIn } from "../harness/sign-in.ts";
import { alertHerdrIfDue, noteHerdrNeeded, noteHerdrUp } from "../reconcile/herdr-health.ts";
import { workflowFor, type WorkflowDef } from "../config/workflows.ts";
import { checkPins, EFFORT_CHOICES, NO_PINS, overPins, pinsOf, resolveModelChoice, type ModelPins } from "../config/model-choice.ts";
import { tx, type Db } from "../db/db.ts";
import { appendEvent, type EventSource } from "../db/events.ts";
import { HARNESS_IDS, type HarnessId } from "../harness/types.ts";
import { recordIntent } from "../journal/journal.ts";
import { readSnapshot } from "../journal/snapshot.ts";
import type { HerdrRuntime } from "../runtime/herdr/runtime.ts";
import { sanitizeBlock } from "../util/sanitize.ts";
import { ulid } from "../util/ulid.ts";
import { reserveDecision } from "./decisions.ts";
import { MAX_BACKLOG_BODY, mintTaskId } from "./ids.ts";
import { gateHarness, harnessRefusal } from "./harness-gate.ts";
import { checkPhaseAccounts, getPlan, parsePlan, phaseOfTask, phasesOf, recordPlan, takenIds, waitingOn } from "./plans.ts";
import { DELIVERY_MODES, getProject, type ProjectRow } from "./projects.ts";
import { queuedTaskOf } from "./queued.ts";
import { modelView, openRunForTask } from "./runs.ts";
import { isDropped } from "./drop.ts";
import { projectRepo } from "./delivery.ts";
import { blockerLabel, openWatch, parseAfter, setWaiter, watchLabel, watchOfTask, type AfterEvent } from "./watches.ts";
import { ForgeError } from "../forge/types.ts";
import { dismissEarlierRunsQuestions } from "./gate-questions.ts";
import { applyAsk, prepareAsk, withAskState, type AskPlan } from "../ask/dispatch.ts";

/** Re-exported for existing importers (e.g. divergences.ts); the constant now lives in ids.ts to avoid a cycle with queued.ts. */
export { MAX_BACKLOG_BODY };

export const TASK_KINDS = ["ship", "scout"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** What `dispatch --kind` takes: a task kind, or an ask (src/ask/: one read-only question, no task). */
export const DISPATCH_KINDS = [...TASK_KINDS, "ask"] as const;

/** What a task may wait for: a ship lands; a decision lands once answered (its task is done). */
export const BLOCKER_KINDS = ["ship", "decision"] as const;

const MAX_TITLE = 120;
const MAX_BODY = 64_000;
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
  /** Null when the account's login is signed in, else why not; default: ask the harness (src/harness/sign-in.ts). The scheduler asks it at each launch grant. */
  signIn?(account: Account): Promise<string | null>;
  now(): number;
}

/** The sign-in check against the harness binary Flowryn resolved. */
export async function signInOf(config: FlowrynConfig, account: Account): Promise<string | null> {
  if (!account.declared) return null;
  const binary = resolveTool(config, account.harness);
  if (!binary) return `${account.harness} is not installed or not in [tools]`;
  return accountSignIn(account, binary);
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
    signIn: (account) => signInOf(ctx.config(), account),
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
 * Can a worker start on this project now? Herdr reachable, the account's
 * harness installed with a passing contract for its version, and the primary
 * checkout on its default branch (the base the worktree branches from). The
 * account was resolved for this project, so its scope already matched. Its
 * sign-in is checked at each launch grant instead (the scheduler): a
 * signed-out account's runs wait, with a P1 saying how to sign it in. A
 * task with its own base branch (`dispatch --base`) starts from origin's tip
 * of that branch, fetched now.
 */
export async function checkStart(deps: StartDeps, project: ProjectRow, account: Account, baseBranch: string | null = null): Promise<{ version: string; base: string; baseBranch: string | null }> {
  const harness = account.harness;
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
  if (check.state !== "verified") throw harnessRefusal(check, deps.db, deps.config());
  const version = check.version;
  const branch = await deps.git(project.path, ["branch", "--show-current"]);
  if (branch !== project.default_branch) {
    recordTangle(deps, project, branch || null);
    throw new FlowrynError("primary_checkout_tangle", `${project.path} is on ${branch || "a detached HEAD"}, not ${project.default_branch}`, `check out ${project.default_branch} there first`);
  }
  if (baseBranch) return { version, base: await remoteBaseTip(deps, project, baseBranch), baseBranch };
  const base =
    (await deps.git(project.path, ["rev-parse", "--verify", `refs/heads/${project.default_branch}^{commit}`])) ??
    (await deps.git(project.path, ["rev-parse", "--verify", `refs/remotes/origin/${project.default_branch}^{commit}`]));
  if (!base) throw new FlowrynError("invalid_project", `cannot resolve ${project.default_branch} in ${project.path}`);
  return { version, base, baseBranch: null };
}

/** origin's tip of a task's base branch, fetched now: the task must start from what its PR will target. */
async function remoteBaseTip(deps: StartDeps, project: ProjectRow, branch: string): Promise<string> {
  const fetched = await deps.git(project.path, ["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  const tip = await deps.git(project.path, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}^{commit}`]);
  if (fetched === null || !tip) throw new FlowrynError("bad_args", `cannot fetch ${branch} from origin in ${project.path}`, "push the base branch first, or check the name");
  return tip;
}

/**
 * `dispatch --base <branch>`: the branch a new task starts from and its PR
 * targets instead of the project's default. Only a ship or scout that ends in
 * a PR takes one: a local-only delivery lands by merging into local default,
 * and a scout opens no PR. Null when not given.
 */
async function baseFlag(deps: StartDeps, args: Record<string, unknown>, project: ProjectRow, kind: string, mode: ProjectRow["delivery_mode"]): Promise<string | null> {
  const base = stringArg(args as never, "base")?.trim();
  if (base === undefined) return null;
  if (kind !== "ship") throw new FlowrynError("bad_args", "--base is for a ship: a scout opens no PR");
  if (mode === "local-only") throw new FlowrynError("bad_args", `${project.id} ships local-only, which lands by merging into local ${project.default_branch}; --base needs a delivery that opens a PR`);
  if (base === project.default_branch) return null;
  if (base.length === 0 || base.startsWith("-") || (await deps.git(project.path, ["check-ref-format", "--branch", base])) === null) {
    throw new FlowrynError("bad_args", `--base ${base} is not a valid branch name`);
  }
  return base;
}

/** The base a Queued task was filed with (`dispatch --blocked-by … --base`); null: the default. */
export function storedBase(db: Db, taskId: string): string | null {
  return (db.query("SELECT base_branch FROM task_policy WHERE task_id = ?1").get(taskId) as { base_branch: string | null } | null)?.base_branch ?? null;
}

export interface NewRun {
  taskId: string;
  title: string;
  body: string;
  project: ProjectRow;
  kind: TaskKind;
  account: Account;
  /** The task's own model and effort (dispatch --model/--effort, a phase's lines), checked against the account. */
  pins?: ModelPins;
  version: string;
  base: string;
  /** The task's own base branch (`dispatch --base`); null or absent: the project's default. */
  baseBranch?: string | null;
  workflow: WorkflowDef;
  sensitive: boolean;
  /** An existing Queued task (a plan phase): started in the backlog, not added. */
  existing: boolean;
  /** The stage the run starts at (default: the workflow's first); a review carried on by a new run starts at its gated stage. */
  stage?: string;
  by: string;
  /** cutover C3: a per-task delivery mode override, carried into the dispatch event's audit trail. */
  override: ModeOverride | null;
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
  if (isDropped(db, r.taskId)) throw new FlowrynError("not_found", `${r.taskId} was dropped`, `flowryn show ${r.taskId}`);
  const { harness } = r.account;
  const pins = r.pins ?? NO_PINS;
  const choice = resolveModelChoice(config, { pins, workflow: r.workflow, account: r.account });
  db.query(
    `INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, sensitive, workflow, auto, created_at, base_branch)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9)
     ON CONFLICT(task_id) DO UPDATE SET workflow = excluded.workflow, sensitive = MAX(sensitive, excluded.sensitive)`,
  ).run(r.taskId, r.project.id, r.kind, r.project.delivery_mode, r.project.yolo, r.sensitive ? 1 : 0, r.workflow.id, r.now, r.baseBranch ?? null);
  const first = r.stage === undefined ? r.workflow.stages[0]! : r.workflow.stages.find((s) => s.id === r.stage);
  if (!first) throw new FlowrynError("bad_args", `workflow ${r.workflow.id} has no stage ${r.stage}`);
  // The run token is minted at launch and kept in the run's private directory; this hash is a placeholder no token matches.
  db.query(
    `INSERT INTO runs (id, task_id, harness, harness_version, model, effort, state, liveness, workflow, stage,
       agent_session, worktree_path, branch, base_sha, token_hash, started_at, updated_at,
       stage_state, waiting_since, pending_launch, account, model_pin, effort_pin, base_branch)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'launching', 'starting', ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14, 'waiting', ?14, 'fresh', ?15, ?16, ?17, ?18)`,
  ).run(runId, r.taskId, harness, r.version, choice.model, choice.effort, r.workflow.id, first.id, randomUUID(), worktree, `${workers.branch_prefix}${r.taskId}`, r.base, hashToken(mintToken("run")), r.now, r.account.id, pins.model, pins.effort, r.baseBranch ?? null);
  const source: EventSource = r.by === "scheduler" ? "daemon" : "cli";
  dismissEarlierRunsQuestions(db, r.taskId, runId, r.now, source);
  const intent = r.existing
    ? recordIntent(db, { file: "backlog", verb: "start", taskId: r.taskId, positional: [r.taskId], now: r.now })
    : recordIntent(db, { file: "backlog", verb: "add", taskId: r.taskId, positional: [r.taskId, r.title], flags: { kind: r.kind, repo: r.project.id, body: r.body.slice(0, MAX_BACKLOG_BODY), start: true }, now: r.now });
  appendEvent(db, {
    source,
    kind: "run.dispatched",
    runId,
    taskId: r.taskId,
    payload: {
      project: r.project.id,
      kind: r.kind,
      harness,
      account: r.account.id,
      scope: r.account.scope,
      ...choice,
      version: r.version,
      title: r.title,
      body: r.body,
      base: r.base,
      ...(r.baseBranch ? { base_branch: r.baseBranch } : {}),
      worktree,
      intent: intent.id,
      by: r.by,
      workflow_def: r.workflow,
      ...(r.stage !== undefined ? { stage: first.id } : {}),
      ...(r.override ? { mode: r.override.mode, mode_reason: r.override.reason } : {}),
    },
    ts: r.now,
  });
  return runId;
}

// --- dispatch -------------------------------------------------------------------------------

/** A per-task delivery mode override (cutover C3): with a reason, kept in `task_policy.mode_reason`. */
export interface ModeOverride {
  mode: ProjectRow["delivery_mode"];
  reason: string;
}

type DispatchPlan = AskPlan | TaskDispatchPlan;

type TaskDispatchPlan = { pins: ModelPins } & (
  | { mode: "now"; project: ProjectRow; account: Account; version: string; base: string; baseBranch: string | null; override: ModeOverride | null }
  | { mode: "task"; project: ProjectRow; account: Account; version: string; base: string; baseBranch: string | null; taskId: string; override: ModeOverride | null }
  | { mode: "queued"; project: ProjectRow; account: Account; version: string; base: string; baseBranch: string | null; taskId: string; kind: TaskKind; title: string; body: string; override: ModeOverride | null }
  | { mode: "queue"; project: ProjectRow; account: Account; blockedBy: string[]; events: AfterEvent[]; prHint: string | null; baseBranch: string | null; override: ModeOverride | null }
);

/** --model and --effort, checked against the account the task starts on. */
export function pinsFor(args: Record<string, unknown>, account: Account, stored: ModelPins = NO_PINS, where = "dispatch"): ModelPins {
  const pins = overPins(pinsOf(args.model, args.effort), stored);
  checkPins(pins, account, where);
  return pins;
}

/** --harness when given: claude or pi. */
export function harnessFlag(args: Record<string, unknown>): HarnessId | null {
  const harness = stringArg(args as never, "harness");
  if (harness === undefined) return null;
  if (!(HARNESS_IDS as readonly string[]).includes(harness)) throw new FlowrynError("bad_args", "--harness must be claude or pi");
  return harness as HarnessId;
}

/**
 * The account a start uses (src/config/accounts.ts): --account, else what
 * the task stored (a plan phase's account: and harness: lines; --harness
 * replaces a stored account), else the project's account and its scope's
 * default. An account outside the project's scope refuses.
 */
export function accountFor(config: FlowrynConfig, project: ProjectRow, args: Record<string, unknown>, stored: { account?: string | null; harness?: HarnessId | null } = {}): Account {
  const harness = harnessFlag(args);
  const account = stringArg(args as never, "account") ?? (harness ? null : (stored.account ?? null));
  return resolveAccount(config, project, { account, harness: harness ?? stored.harness ?? null });
}

/** A per-task delivery mode (cutover C3): with a reason, never local-only on a project that pushes, and never a pushing mode on a project with no remote. */
function modeOverride(args: Record<string, unknown>, project: ProjectRow): ModeOverride | null {
  const mode = stringArg(args as never, "mode");
  if (mode === undefined) return null;
  if (!(DELIVERY_MODES as readonly string[]).includes(mode)) throw new FlowrynError("bad_args", "--mode must be no-mistakes, direct-PR or local-only");
  const reason = stringArg(args as never, "mode-reason")?.trim();
  if (!reason) throw new FlowrynError("bad_args", "--mode needs --mode-reason <why>");
  if (mode === "local-only" && project.delivery_mode !== "local-only") throw new FlowrynError("delivery_refused", `${project.id} ships through ${project.delivery_mode}; a task cannot switch it to local-only`);
  if (mode !== "local-only" && project.repo_url === "") throw new FlowrynError("delivery_refused", `${project.id} has no remote, so a task cannot ship it through ${mode}`);
  return { mode: mode as ProjectRow["delivery_mode"], reason };
}

/** Applies a per-task mode override (cutover C3) to the task's policy row, once it exists. */
export function applyModeOverride(db: Db, taskId: string, override: ModeOverride | null): void {
  if (!override) return;
  db.query("UPDATE task_policy SET delivery_mode = ?2, mode_reason = ?3 WHERE task_id = ?1").run(taskId, override.mode, override.reason);
}

/** A blocker's task kind: a plan phase is a ship; null when there is no such task. */
function blockerKind(db: Db, id: string): string | null {
  const policy = db.query("SELECT kind FROM task_policy WHERE task_id = ?1").get(id) as { kind: string } | null;
  if (policy) return policy.kind;
  if (db.query("SELECT 1 FROM plan_phases WHERE task_id = ?1").get(id)) return "ship";
  // A decision task has no task_policy row (cutover C1); the decisions table itself names it, so a
  // just-added decision task can be a blocker at once, before the backlog snapshot has caught up.
  // run_id IS NULL: a run-scoped q<N> names a run's own task, which always has a task_policy row
  // caught by the check above, so this branch is standalone (k<N>) decisions only.
  if (db.query("SELECT 1 FROM decisions WHERE task_id = ?1 AND run_id IS NULL").get(id)) return "decision";
  // A watch's task (src/lifecycle/watches.ts) has no task_policy row either; it lands when its event fires.
  if (watchOfTask(db, id)) return "watch";
  const task = (readSnapshot(db, "backlog")?.tasks ?? []).find((t) => t.id === id);
  return task ? (task.kind ?? "ship") : null;
}

/** A task that merges only with a human record waits on these decisions, so only the user may answer them. */
function reserveBlockingDecisions(db: Db, blockedBy: string[], now: number): void {
  for (const id of blockedBy) {
    const d = db.query("SELECT id, task_id, reserved_reason FROM decisions WHERE task_id = ?1 AND run_id IS NULL AND state = 'open'").get(id) as { id: string; task_id: string; reserved_reason: string | null } | null;
    if (d) reserveDecision(db, d, "merge", now);
  }
}

async function prepareDispatch(ctx: HandlerCtx, args: Record<string, unknown>): Promise<DispatchPlan> {
  const projectId = stringArg(args as never, "project")!;
  const project = getProject(ctx.db, projectId);
  if (!project) throw new FlowrynError("not_found", `no project ${projectId}`, "flowryn project list");
  if (stringArg(args as never, "kind") === "ask") return prepareAsk(ctx, args, project);
  if (args["max-usd"] !== undefined || boolArg(args as never, "no-promote")) throw new FlowrynError("bad_args", "--max-usd and --no-promote go with --kind ask");
  const override = modeOverride(args, project);
  const taskId = stringArg(args as never, "task");
  if (taskId) {
    if (args.after !== undefined || args["blocked-by"] !== undefined || boolArg(args as never, "auto")) throw new FlowrynError("bad_args", "--task starts a task that is already filed: --after, --blocked-by and --auto go with a new task");
    if (stringArg(args as never, "base") !== undefined) throw new FlowrynError("bad_args", "--base is set when a task is filed; a Queued task starts on the base it was filed with");
    if (isDropped(ctx.db, taskId)) throw new FlowrynError("not_found", `${taskId} was dropped`, `flowryn show ${taskId}`);
    // A queued task that is not a plan phase (cutover C3: imported work): its blockers must have landed.
    const queued = queuedTaskOf(ctx.db, taskId);
    if (queued) {
      if (queued.project_id !== project.id) throw new FlowrynError("not_found", `${taskId} belongs to project ${queued.project_id}`);
      const waiting = waitingOn(ctx.db, taskId, readSnapshot(ctx.db, "backlog")?.tasks ?? null, []);
      if (waiting.length > 0) throw new FlowrynError("blockers_not_landed", `${taskId} waits for ${waiting.join(", ")} to land`);
      const account = accountFor(ctx.config(), project, args);
      return { mode: "queued", project, account, pins: pinsFor(args, account), taskId, kind: queued.kind, title: queued.title, body: queued.body, override, ...(await checkStart(startDepsOf(ctx), project, account, storedBase(ctx.db, taskId))) };
    }
    // Start a Queued task yourself (a plan phase, or a dispatch that waited): its blockers must have landed.
    const phase = phaseOfTask(ctx.db, taskId);
    if (!phase || phase.project_id !== project.id) throw new FlowrynError("not_found", `${taskId} is not a queued task of project ${project.id}`, "flowryn show <plan id>");
    if (phase.plan_state !== "approved") throw new FlowrynError("not_ready", `${taskId} belongs to plan ${phase.plan_id}, which is ${phase.plan_state}`);
    if (openRunForTask(ctx.db, taskId)) throw new FlowrynError("already_exists", `${taskId} already has a run`, `flowryn show ${taskId}`);
    const waiting = waitingOn(ctx.db, taskId, readSnapshot(ctx.db, "backlog")?.tasks ?? null, JSON.parse(phase.blocked_by) as string[]);
    if (waiting.length > 0) throw new FlowrynError("blockers_not_landed", `${taskId} waits for ${waiting.join(", ")} to land`, "a phase starts only after its blockers have landed, never on an open PR");
    const account = accountFor(ctx.config(), project, args, { account: phase.account, harness: phase.harness as HarnessId | null });
    // --model and --effort win over the phase's own lines, each on its own.
    const pins = pinsFor(args, account, { model: phase.model, effort: phase.effort });
    return { mode: "task", project, account, pins, taskId, override, ...(await checkStart(startDepsOf(ctx), project, account, storedBase(ctx.db, taskId))) };
  }
  const kind = stringArg(args as never, "kind");
  if (!kind || !(TASK_KINDS as readonly string[]).includes(kind)) throw new FlowrynError("bad_args", "--kind must be ship, scout or ask");
  const account = accountFor(ctx.config(), project, args);
  const pins = pinsFor(args, account);
  const baseBranch = await baseFlag(startDepsOf(ctx), args, project, kind, override?.mode ?? project.delivery_mode);
  const after = parseAfter((args.after as string[] | undefined) ?? []);
  const blockedBy = [...new Set([...((args["blocked-by"] as string[] | undefined) ?? []), ...after.tasks])];
  if (blockedBy.length > 0 || after.events.length > 0) {
    if (kind !== "ship") throw new FlowrynError("bad_args", "a task that waits for others is a ship");
    const kinds = new Map(blockedBy.map((id) => [id, blockerKind(ctx.db, id)]));
    const unknown = blockedBy.filter((id) => kinds.get(id) === null);
    if (unknown.length > 0) throw new FlowrynError("not_found", `no task ${unknown.join(", ")}`, "flowryn fleet");
    const unshipped = blockedBy.filter((id) => !(BLOCKER_KINDS as readonly string[]).includes(kinds.get(id) ?? ""));
    if (unshipped.length > 0) {
      const scout = unshipped.find((id) => kinds.get(id) === "scout");
      const watch = unshipped.some((id) => kinds.get(id) === "watch");
      throw new FlowrynError("bad_args", `${unshipped.map((id) => `${id} is a ${kinds.get(id)}`).join(", ")}: only a ship or a decision lands, so a task can wait only for those`, scout ? `wait for its report instead: --after report:${scout}` : watch ? "wait for the event itself: --after pr:<number> or --after report:<scout task>" : "wait for the report yourself, then dispatch");
    }
    const prHint = await checkAfterEvents(ctx, project, after.events);
    return { mode: "queue", project, account, pins, blockedBy, events: after.events, prHint, baseBranch, override };
  }
  if (boolArg(args as never, "auto")) throw new FlowrynError("bad_args", "--auto goes with --blocked-by or --after: a task that starts by itself once its blockers land");
  return { mode: "now", project, account, pins, override, ...(await checkStart(startDepsOf(ctx), project, account, baseBranch)) };
}

/**
 * Refuse an --after event that cannot happen: a scout task not of this
 * project, or a PR GitHub does not know or closed unmerged. A merged PR is
 * accepted (its watch fires on the next pass). GitHub out of reach is not a
 * refusal: the watcher reads the PR later; the hint says so.
 */
async function checkAfterEvents(ctx: HandlerCtx, project: ProjectRow, events: AfterEvent[]): Promise<string | null> {
  let hint: string | null = null;
  for (const event of events) {
    if (event.kind === "report") {
      if (isDropped(ctx.db, event.task)) throw new FlowrynError("not_found", `${event.task} was dropped`, `flowryn show ${event.task}`);
      const policy = ctx.db.query("SELECT kind, project_id FROM task_policy WHERE task_id = ?1").get(event.task) as { kind: string; project_id: string } | null;
      if (!policy) throw new FlowrynError("not_found", `no task ${event.task}`, "flowryn fleet");
      if (policy.kind !== "scout") throw new FlowrynError("bad_args", `${event.task} is a ${policy.kind}, not a scout: only a scout reports`, `wait for it to land instead: --after task:${event.task}`);
      if (policy.project_id !== project.id) throw new FlowrynError("bad_args", `${event.task} belongs to project ${policy.project_id}, not ${project.id}`);
      continue;
    }
    const webUrl = ctx.delivery.github().web_url;
    const repo = projectRepo(project, webUrl);
    if (!repo) throw new FlowrynError("bad_args", `project ${project.id} has no GitHub remote, so it has no PR ${event.number}`);
    try {
      const pr = await ctx.delivery.forge().pull({ ...repo, number: event.number });
      if (pr.state === "closed") throw new FlowrynError("bad_args", `PR #${event.number} in ${repo.owner}/${repo.repo} was closed without merging`, pr.url);
    } catch (error) {
      if (error instanceof FlowrynError) throw error;
      if (error instanceof ForgeError && error.kind === "not_found") throw new FlowrynError("not_found", `no PR #${event.number} in ${repo.owner}/${repo.repo}`);
      hint = `GitHub did not answer (${(error as Error).message}); the PR is checked once it does`;
    }
  }
  return hint;
}

/**
 * `flowryn dispatch <project> --kind ship|scout|ask --body-file -` (design section
 * 12): start a worker on a new task. The run waits for its first capacity
 * grant (a worker slot and its first stage's pools), then launches.
 * `--blocked-by <task>` files it Queued instead, starting by itself once
 * those tasks land when `--auto` is given (section 11: ad hoc tasks stay
 * manual unless you pass --auto); `--task <id>` starts such a Queued task yourself.
 * `--after <event>` files it Queued until each event happens and implies
 * --auto: task:<id> is a blocker like --blocked-by; pr:<n> and report:<task>
 * are watches (src/lifecycle/watches.ts). `--kind ask` queues a question
 * instead (src/ask/dispatch.ts): no task, no worktree, an answer item.
 */
export const dispatchVerb: VerbSpec = {
  name: "dispatch",
  summary: "Start a worker on a task: a ship (ends in a PR) or a scout (ends in a report), or ask a read-only question (an answer); --task starts a Queued one",
  positionals: [{ name: "project", required: true, help: "project id", complete: "project" }],
  flags: {
    kind: { type: "string", help: "ship, scout or ask", placeholder: "kind", values: DISPATCH_KINDS },
    "body-file": { type: "string", help: "the task, from a file or - for stdin", fileFor: "body" },
    title: { type: "string", help: "backlog title (default: the body's first line)", placeholder: "text" },
    harness: { type: "string", help: "claude or pi (default: the project's)", placeholder: "harness", values: HARNESS_IDS },
    account: { type: "string", help: "the account to run on, from [accounts] (default: the project's, else its scope's); never one outside the project's scope", placeholder: "id", complete: "account" },
    model: { type: "string", help: "the worker's model (default: the workflow's, else the account's, else the harness's); a Pi account takes <provider>/<id>", placeholder: "model" },
    effort: { type: "string", help: "the worker's effort: claude low|medium|high|xhigh|max, pi off|minimal|low|medium|high|xhigh|max (default: the workflow's, else the account's, else the harness's)", placeholder: "level", values: EFFORT_CHOICES },
    sensitive: { type: "boolean", help: "security-relevant: merges need a human record even under yolo" },
    workflow: { type: "string", help: "the workflow: feature, feature-ui (with visual QA), fix, or one from [workflows] (default: the project's; scouts: scout)", placeholder: "id", complete: "workflow" },
    "blocked-by": { type: "list", help: "file it Queued until these tasks land (repeatable)", placeholder: "task", complete: "task" },
    after: { type: "list", help: "file it Queued until this happens, then start it by itself: task:<id> lands, pr:<number> merges, or report:<scout task> lands (repeatable)", placeholder: "event" },
    auto: { type: "boolean", help: "with --blocked-by: start by itself once its blockers land (--after implies it)" },
    task: { type: "string", help: "start this Queued task (a plan phase) now; its blockers must have landed", placeholder: "id", complete: "task" },
    mode: { type: "string", help: "this task's delivery mode, overriding the project's: no-mistakes, direct-PR or local-only", placeholder: "mode", values: DELIVERY_MODES },
    "mode-reason": { type: "string", help: "with --mode: why (kept on the task)", placeholder: "text" },
    base: { type: "string", help: "a ship's base branch on origin: it starts from it and its PR targets it (default: the project's default branch); not on local-only", placeholder: "branch" },
    "max-usd": { type: "string", help: "an ask's spend cap in dollars (default: [ask] max_usd)", placeholder: "dollars" },
    "no-promote": { type: "boolean", help: "an ask that needs to write answers so instead of becoming a scout" },
  },
  kind: "mutation",
  roles: ["leader", "human"],
  scope: { kind: "project", arg: "project" },
  prepare: (ctx, args) => prepareDispatch(ctx, args),
  apply(ctx, args, prepared) {
    const plan = prepared as DispatchPlan;
    if (plan.mode === "ask") return applyAsk(ctx, args, plan);
    const now = ctx.now();
    const config = ctx.config();
    if (plan.mode === "task") {
      const phase = phaseOfTask(ctx.db, plan.taskId)!;
      const workflow = workflowFor(config, stringArg(args, "workflow") ?? phase.workflow, "ship");
      const runId = createRun(ctx.db, config, { taskId: plan.taskId, title: phase.title, body: phase.body, project: plan.project, kind: "ship", account: plan.account, pins: plan.pins, version: plan.version, base: plan.base, baseBranch: plan.baseBranch, workflow, sensitive: boolArg(args, "sensitive"), existing: true, by: ctx.caller.role, override: plan.override, now });
      applyModeOverride(ctx.db, plan.taskId, plan.override);
      return { data: { task: plan.taskId, run: runId, harness: `${plan.account.harness} ${plan.version}`, account: plan.account.id, ...choiceOf(ctx.db, runId), workflow: workflow.id, state: "launching" }, hints: [`flowryn show ${plan.taskId}`, "flowryn fleet"] };
    }
    if (plan.mode === "queued") {
      const workflow = workflowFor(config, stringArg(args, "workflow") ?? (plan.kind === "scout" ? "scout" : plan.project.workflow), plan.kind);
      const runId = createRun(ctx.db, config, { taskId: plan.taskId, title: plan.title, body: plan.body, project: plan.project, kind: plan.kind, account: plan.account, pins: plan.pins, version: plan.version, base: plan.base, baseBranch: plan.baseBranch, workflow, sensitive: boolArg(args, "sensitive"), existing: true, by: ctx.caller.role, override: plan.override, now });
      applyModeOverride(ctx.db, plan.taskId, plan.override);
      return { data: { task: plan.taskId, run: runId, harness: `${plan.account.harness} ${plan.version}`, account: plan.account.id, ...choiceOf(ctx.db, runId), mode: plan.override?.mode ?? plan.project.delivery_mode, workflow: workflow.id, state: "launching" }, hints: [`flowryn show ${plan.taskId}`] };
    }
    const kind = stringArg(args, "kind") as TaskKind;
    const body = sanitizeBlock(stringArg(args, "body") ?? "").trim();
    if (body.length === 0) throw new FlowrynError("bad_args", "the task needs a body", "pass --body-file - with the task on stdin");
    if (body.length > MAX_BODY) throw new FlowrynError("bad_args", `the task body is over ${MAX_BODY} characters`);
    const title = taskTitleFrom(stringArg(args, "title"), body);
    const workflow = workflowFor(config, stringArg(args, "workflow") ?? (kind === "scout" ? "scout" : plan.project.workflow), kind);
    if (plan.mode === "queue") {
      const watches = plan.events.map((event) => openWatch(ctx.db, { project: plan.project, event, now }));
      const blockedBy = [...plan.blockedBy, ...watches.map((w) => w.task_id)];
      const auto = boolArg(args, "auto") || watches.length > 0 || ((args.after as string[] | undefined) ?? []).length > 0;
      const filed = recordPlan(ctx.db, {
        project: plan.project,
        title,
        phases: [{ title, body, workflow: workflow.id, harness: plan.account.harness, account: plan.account.id, model: plan.pins.model, effort: plan.pins.effort, after: null }],
        sourceTask: null,
        gateId: null,
        workflow: workflow.id,
        harness: plan.account.harness,
        blockedBy,
        override: plan.override,
        filedBy: ctx.caller.role,
        state: "approved",
        now,
      });
      const taskId = filed.phases[0]!.task_id;
      for (const watch of watches) setWaiter(ctx.db, watch, taskId, "cli", now);
      if (!auto) ctx.db.query("UPDATE task_policy SET auto = 0 WHERE task_id = ?1").run(taskId);
      if (boolArg(args, "sensitive")) ctx.db.query("UPDATE task_policy SET sensitive = 1 WHERE task_id = ?1").run(taskId);
      if (plan.baseBranch) ctx.db.query("UPDATE task_policy SET base_branch = ?2 WHERE task_id = ?1").run(taskId, plan.baseBranch);
      applyModeOverride(ctx.db, taskId, plan.override);
      if ((plan.project.yolo === 0 || boolArg(args, "sensitive")) && decisionsConfig(config).reserved_classes.includes("merge")) reserveBlockingDecisions(ctx.db, plan.blockedBy, now);
      const hints = auto && plan.project.autonomy === "plan" ? [`flowryn show ${taskId}`] : [`flowryn dispatch ${plan.project.id} --task ${taskId} (once its blockers land${auto ? `; project ${plan.project.id}'s autonomy is manual` : ""})`];
      return {
        data: {
          task: taskId,
          plan: filed.id,
          state: "queued",
          blocked_by: plan.blockedBy,
          ...(watches.length > 0 ? { waits_for: watches.map((w) => `${watchLabel(w)} (${w.task_id})`) } : {}),
          ...(plan.baseBranch ? { base: plan.baseBranch } : {}),
          auto: auto ? "on" : "off",
        },
        hints: plan.prHint ? [plan.prHint, ...hints] : hints,
      };
    }
    const taskId = mintTaskId(title, takenIds(ctx.db));
    const runId = createRun(ctx.db, config, { taskId, title, body, project: plan.project, kind, account: plan.account, pins: plan.pins, version: plan.version, base: plan.base, baseBranch: plan.baseBranch, workflow, sensitive: boolArg(args, "sensitive"), existing: false, by: ctx.caller.role, override: plan.override, now });
    applyModeOverride(ctx.db, taskId, plan.override);
    return {
      data: { task: taskId, run: runId, harness: `${plan.account.harness} ${plan.version}`, account: plan.account.id, ...choiceOf(ctx.db, runId), mode: plan.override?.mode ?? plan.project.delivery_mode, yolo: plan.project.yolo ? "on" : "off", ...(plan.baseBranch ? { base: plan.baseBranch } : {}), workflow: workflow.id, state: "launching" },
      hints: [`flowryn show ${taskId}`, "flowryn fleet"],
    };
  },
  async settle(ctx, result) {
    // A watch on a PR that already merged fires on the delivery watcher's next pass: look now.
    if (result.data.waits_for) ctx.delivery.watch();
    await ctx.sched.passNow();
    return withAskState(ctx, withStartState(ctx, result));
  },
};

/** The model and effort a new run will start with, and where each came from, for the reply. */
function choiceOf(db: Db, runId: string): { model: string; effort: string } {
  const run = db.query("SELECT id, model, effort FROM runs WHERE id = ?1").get(runId) as { id: string; model: string | null; effort: string | null };
  return modelView(db, run);
}

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
  positionals: [{ name: "project", required: true, help: "project id", complete: "project" }],
  flags: {
    "body-file": { type: "string", help: "the plan: an optional # title, then one ## section per phase", fileFor: "body" },
    title: { type: "string", help: "the plan's title (default: its # heading)", placeholder: "text" },
    workflow: { type: "string", help: "the phases' workflow (default: the project's; a phase's workflow: line wins)", placeholder: "id", complete: "workflow" },
    harness: { type: "string", help: "claude or pi (default: the project's; a phase's harness: line wins)", placeholder: "harness", values: HARNESS_IDS },
    account: { type: "string", help: "the phases' account (default: the project's, else its scope's; a phase's account: line wins)", placeholder: "id", complete: "account" },
    model: { type: "string", help: "the phases' model (a phase's model: line wins; default: the workflow's, else the account's)", placeholder: "model" },
    effort: { type: "string", help: "the phases' effort (a phase's effort: line wins; default: the workflow's, else the account's)", placeholder: "level", values: EFFORT_CHOICES },
  },
  kind: "mutation",
  roles: ["leader", "human"],
  scope: { kind: "project", arg: "project" },
  apply(ctx, args) {
    const projectId = stringArg(args, "project")!;
    const project = getProject(ctx.db, projectId);
    if (!project) throw new FlowrynError("not_found", `no project ${projectId}`, "flowryn project list");
    const parsed = parsePlan(stringArg(args, "body") ?? "");
    const config = ctx.config();
    const workflow = stringArg(args, "workflow") ?? project.workflow;
    const harness = accountFor(config, project, args).harness;
    const account = stringArg(args, "account") ?? null;
    const { model, effort } = pinsOf(args.model, args.effort);
    checkPhaseAccounts(config, project, parsed.phases, { account, harness, model, effort });
    for (const phase of parsed.phases) workflowFor(config, phase.workflow ?? workflow, "ship");
    workflowFor(config, workflow, "ship");
    const now = ctx.now();
    const title = stringArg(args, "title") ?? parsed.title ?? parsed.phases[0]!.title;
    const filed = recordPlan(ctx.db, { project, title, phases: parsed.phases, sourceTask: null, gateId: null, workflow, harness, account, model, effort, filedBy: ctx.caller.role, state: "approved", now });
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

/** `flowryn show <plan>`: the plan's phases and where each is; with --full (`bodies`), each phase's body too. */
export function planView(db: Db, planId: string, bodies = false): Record<string, unknown> | null {
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
        at: run ? `${run.state} · ${run.stage} ${run.stage_state}` : plan.state !== "approved" ? plan.state : waiting.length > 0 ? `queued, waits for ${waiting.map((dep) => blockerLabel(db, dep)).join(", ")}` : "queued, ready",
        ...(bodies ? { body: sanitizeBlock(p.body) } : {}),
      };
    }),
  };
}
