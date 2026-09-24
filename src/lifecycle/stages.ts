import { FlowrynError } from "../api/errors.ts";
import { stringArg, type HandlerCtx, type ReadCtx, type VerbSpec } from "../api/verbs.ts";
import { openItem, resolveRunItems } from "../attention/items.ts";
import type { FlowrynConfig } from "../config/config.ts";
import { capacityConfig, DEFAULT_WORKFLOWS, WORKER_POOL, type StageDef, type WorkflowDef } from "../config/workflows.ts";
import type { Db } from "../db/db.ts";
import { getMeta, setMeta } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { deliveryLines, type ContractDelivery } from "../harness/contract-text.ts";
import { grantLeases, holdsLease, releaseLeases, runLeases } from "../sched/pools.ts";
import { skillPath } from "../skills/stages.ts";
import { sanitizeBlock, sanitizeLine } from "../util/sanitize.ts";
import { approvePlan, discardPlansOfGate, fileWorkerPlan, parsePlan } from "./plans.ts";
import { getProject } from "./projects.ts";
import { getRunWithPolicy, isTerminal, taskTitle, type PendingLaunch, type RunRow, type RunWithPolicy } from "./runs.ts";
import { createSteer } from "./steers.ts";

/**
 * Workflow stages and gates (design section 11). A run moves through its
 * workflow's stages in order; the lifecycle engine owns runs.stage and
 * runs.stage_state. A stage is requested (waiting), granted by the scheduler
 * against the capacity pools and the host check (active), and ends with the
 * worker's `stage done`: a review gate then opens (review) for a human
 * channel to pass or send back; otherwise the next stage is requested. The
 * last stage ends in the delivery (done), and a ship's delivery waits at the
 * merge gate (section 7).
 *
 * One worker and one worktree carry the whole run by default, so each stage
 * start reaches the worker as a steer; a stage with fresh = true gets a new
 * worker session in the same worktree instead, with the stage in its task file.
 */

export interface StagePos {
  def: WorkflowDef;
  index: number;
  stage: StageDef;
  last: boolean;
}

interface DispatchedPayload {
  workflow_def?: WorkflowDef;
}

/** The workflow a run was dispatched with, frozen then, so a later config edit never reshapes a running run. */
export function runWorkflow(db: Db, run: Pick<RunRow, "id" | "workflow">, kind?: "ship" | "scout"): WorkflowDef {
  const row = db.query("SELECT payload FROM events WHERE run_id = ?1 AND kind = 'run.dispatched' ORDER BY seq LIMIT 1").get(run.id) as { payload: string } | null;
  const frozen = row ? (JSON.parse(row.payload) as DispatchedPayload).workflow_def : undefined;
  if (frozen && Array.isArray(frozen.stages) && frozen.stages.length > 0) return frozen;
  return DEFAULT_WORKFLOWS[run.workflow] ?? (kind === "scout" ? DEFAULT_WORKFLOWS.scout! : DEFAULT_WORKFLOWS.fix!);
}

export function positionOf(db: Db, run: Pick<RunRow, "id" | "workflow" | "stage">, kind?: "ship" | "scout"): StagePos {
  const def = runWorkflow(db, run, kind);
  const found = def.stages.findIndex((s) => s.id === run.stage);
  const index = found >= 0 ? found : 0;
  return { def, index, stage: def.stages[index]!, last: index === def.stages.length - 1 };
}

/** "design (review) → build → qa (review) → ship (merge)". */
export function flowLine(def: WorkflowDef): string {
  return def.stages.map((s) => (s.gate === "none" ? s.id : `${s.id} (${s.gate})`)).join(" → ");
}

export interface StageTextContext {
  stateDir: string;
  delivery: ContractDelivery;
}

/** What the worker needs to run a stage: where it is, the skill to follow, and what ends it. One paragraph. */
export function stageInstructions(pos: StagePos, ctx: StageTextContext): string {
  const { def, index, stage } = pos;
  const parts = [`Flowryn stage ${stage.id} (${index + 1} of ${def.stages.length}; workflow ${def.id}: ${flowLine(def)}).`];
  const path = skillPath(ctx.stateDir, stage.skill);
  if (stage.skill) parts.push(path ? `Follow the ${stage.skill} skill: read ${path} first.` : `Follow the ${stage.skill} skill.`);
  if (stage.pools.length > 0) parts.push(`You hold a slot of ${stage.pools.join(" and ")} until this stage ends.`);
  if (pos.last) parts.push(`This is the last stage. ${deliveryLines(ctx.delivery).map((l) => l.replace(/^-\s*/, "").trim()).join(" ")}`);
  else if (stage.gate === "review") parts.push("When it is ready for review: $FLOWRYN_BIN stage done --review <lavish url>, then end your turn; a steer brings the verdict.");
  else parts.push("When it is done: $FLOWRYN_BIN stage done, then end your turn; a steer starts the next stage.");
  return parts.join(" ");
}

/** The text context for a run's stages: its delivery lines follow the task kind and the project's mode. */
export function stageTextContext(db: Db, config: FlowrynConfig, run: RunWithPolicy): StageTextContext {
  const project = getProject(db, run.project_id);
  return {
    stateDir: config.state_dir,
    delivery: { kind: run.kind, mode: run.delivery_mode as ContractDelivery["mode"], defaultBranch: project?.default_branch ?? "main" },
  };
}

// --- transitions ------------------------------------------------------------------------------

/**
 * Ask for a stage: the run waits for its grant, and the scheduler starts it.
 * `note` leads the steer the start carries (null: nothing to say, as when a
 * dead worker's stage waits to be granted again). Call inside a transaction.
 */
export function requestStage(db: Db, run: RunRow, def: WorkflowDef, index: number, note: string | null, now: number): void {
  const stage = def.stages[index]!;
  const launch: PendingLaunch | null = run.pending_launch ?? (stage.fresh && run.stage !== stage.id ? "stage" : null);
  db.query(
    `UPDATE runs SET stage = ?2, stage_state = 'waiting', waiting_since = ?3, stage_note = ?4, stage_started_at = NULL,
       pending_launch = ?5, updated_at = ?3 WHERE id = ?1`,
  ).run(run.id, stage.id, now, note, launch);
  appendEvent(db, { source: "daemon", kind: "stage.requested", runId: run.id, taskId: run.task_id, payload: { stage: stage.id, index, from: run.stage, pools: stage.pools, fresh: launch === "stage" }, ts: now });
  run.stage = stage.id;
  run.stage_state = "waiting";
  run.waiting_since = now;
  run.stage_note = note;
  run.pending_launch = launch;
}

/** The pools a run needs granted now: its stage's (while the stage waits), and a worker slot for a launch it has none for. */
export function neededPools(db: Db, run: RunRow, pos: StagePos): string[] {
  const needs = run.stage_state === "waiting" ? [...pos.stage.pools] : [];
  if (run.pending_launch && !holdsLease(db, run.id, WORKER_POOL)) needs.unshift(WORKER_POOL);
  return needs;
}

export interface Activated {
  /** The launch the grant starts, if any. */
  launch: PendingLaunch | null;
  /** The steer the stage start carries, when the worker is alive to take it. */
  steer: string | null;
}

/**
 * The scheduler granted the run: take the leases, start the stage and, when
 * a live worker carries on, steer it with the stage's instructions. A launch
 * the grant starts gets the instructions in its task file instead. Throws
 * OverCapacity (taking nothing) when a pool filled meanwhile. Call inside a
 * transaction.
 */
export function activateStage(db: Db, config: FlowrynConfig, run: RunWithPolicy, now: number): Activated {
  const pos = positionOf(db, run, run.kind);
  const caps = capacityConfig(config).pools;
  grantLeases(db, run.id, run.task_id, pos.stage.id, neededPools(db, run, pos), caps, now);
  const launch = run.pending_launch;
  const starting = run.stage_state === "waiting";
  // A fresh launch reads its stage from the task file, and a fresh stage worker its note too: the launcher clears it.
  const noteInFile = launch === "fresh" || launch === "stage";
  let steer: string | null = null;
  if (starting && run.stage_note !== null && !noteInFile) {
    const text = [run.stage_note, stageInstructions(pos, stageTextContext(db, config, run))].filter((t) => t.length > 0).join(" ");
    steer = createSteer(db, run, text, now).id;
  }
  db.query(
    `UPDATE runs SET stage_state = CASE WHEN stage_state = 'waiting' THEN 'active' ELSE stage_state END,
       stage_started_at = CASE WHEN stage_state = 'waiting' THEN ?2 ELSE stage_started_at END,
       waiting_since = NULL, pending_launch = CASE WHEN ?3 = 'stage' THEN 'stage' ELSE NULL END,
       stage_note = CASE WHEN ?4 = 1 THEN stage_note ELSE NULL END, updated_at = ?2 WHERE id = ?1`,
  ).run(run.id, now, launch ?? "", noteInFile ? 1 : 0);
  if (starting) appendEvent(db, { source: "daemon", kind: "stage.started", runId: run.id, taskId: run.task_id, payload: { stage: pos.stage.id, index: pos.index, pools: pos.stage.pools, steer, launch }, ts: now });
  return { launch, steer };
}

// --- gates -----------------------------------------------------------------------------------

export interface GateRow {
  id: string;
  run_id: string;
  stage: string;
  kind: "review" | "merge";
  review_url: string | null;
  state: "open" | "passed" | "changes";
  approval_id: string | null;
  feedback: string | null;
  opened_at: number;
  closed_at: number | null;
}

function nextGateId(db: Db): string {
  const next = Number(getMeta(db, "next_gate_no") ?? "1");
  setMeta(db, "next_gate_no", String(next + 1));
  return `g${next}`;
}

export function openGate(db: Db, runId: string, kind?: "review" | "merge"): GateRow | null {
  const filter = kind ? "AND kind = ?2" : "";
  return db.query(`SELECT * FROM gates WHERE run_id = ?1 AND state = 'open' ${filter} ORDER BY opened_at DESC LIMIT 1`).get(...(kind ? [runId, kind] : [runId])) as GateRow | null;
}

export function gatesOf(db: Db, runId: string): GateRow[] {
  return db.query("SELECT * FROM gates WHERE run_id = ?1 ORDER BY opened_at, id").all(runId) as GateRow[];
}

/** The merge gate record of a delivered ship (section 7 still decides the merge itself). Call inside a transaction. */
export function openMergeGate(db: Db, run: RunRow, now: number): void {
  if (openGate(db, run.id, "merge")) return;
  const id = nextGateId(db);
  db.query("INSERT INTO gates (id, run_id, stage, kind, state, opened_at) VALUES (?1, ?2, ?3, 'merge', 'open', ?4)").run(id, run.id, run.stage, now);
  appendEvent(db, { source: "daemon", kind: "gate.opened", runId: run.id, taskId: run.task_id, payload: { gate: id, stage: run.stage, kind: "merge" }, ts: now });
}

/** Close the merge gate: passed by a proven merge, or sent back by a decline. Call inside a transaction. */
export function closeMergeGate(db: Db, run: RunRow, outcome: { passed: true; approvalId: string | null } | { passed: false; feedback: string }, now: number): void {
  const gate = openGate(db, run.id, "merge");
  if (!gate) return;
  if (outcome.passed) db.query("UPDATE gates SET state = 'passed', approval_id = ?2, closed_at = ?3 WHERE id = ?1").run(gate.id, outcome.approvalId, now);
  else db.query("UPDATE gates SET state = 'changes', feedback = ?2, closed_at = ?3 WHERE id = ?1").run(gate.id, outcome.feedback, now);
  appendEvent(db, { source: "daemon", kind: outcome.passed ? "gate.passed" : "gate.changes", runId: run.id, taskId: run.task_id, payload: { gate: gate.id, kind: "merge" }, ts: now });
}

/**
 * Pass an open review gate with the approval a human channel created (design
 * section 11: gates are human-bound like merges). The pending plan the gate
 * carried is approved with it, and the next stage is requested. Call inside a
 * transaction.
 */
export function passReviewGate(db: Db, run: RunWithPolicy, gate: GateRow, approval: { id: string; channel: string }, now: number): { next: string; plan: string | null } {
  const pos = positionOf(db, run, run.kind);
  db.query("UPDATE gates SET state = 'passed', approval_id = ?2, closed_at = ?3 WHERE id = ?1").run(gate.id, approval.id, now);
  appendEvent(db, { source: "cli", kind: "gate.passed", runId: run.id, taskId: run.task_id, payload: { gate: gate.id, stage: gate.stage, approval: approval.id, channel: approval.channel }, ts: now });
  resolveRunItems(db, run.id, ["gate_ready"], `gate.passed ${gate.id}`, now);
  const plan = db.query("SELECT id FROM plans WHERE gate_id = ?1 AND state = 'pending'").get(gate.id) as { id: string } | null;
  // Approving the design approves the plan it carried (design section 11): its phases reach the backlog now.
  if (plan) approvePlan(db, plan.id, `gate ${gate.id} (${approval.channel})`, now);
  const nextIndex = Math.min(pos.index + 1, pos.def.stages.length - 1);
  requestStage(db, run, pos.def, nextIndex, `The ${gate.stage} review passed (${approval.channel}).${plan ? ` Its plan ${plan.id} is approved; its phases start by themselves once this task lands.` : ""}`, now);
  return { next: pos.def.stages[nextIndex]!.id, plan: plan?.id ?? null };
}

/** Where `gate changes` sends a run by default: the nearest earlier stage without a review gate, else the gated stage itself. */
export function changesTarget(def: WorkflowDef, index: number): number {
  for (let i = index - 1; i >= 0; i--) if (def.stages[i]!.gate === "none") return i;
  return index;
}

/** Send a run back from its open review gate with your words. Call inside a transaction. */
export function sendBack(db: Db, run: RunWithPolicy, gate: GateRow, words: string, target: number, by: string, now: number): string {
  const pos = positionOf(db, run, run.kind);
  const text = sanitizeBlock(words).trim();
  db.query("UPDATE gates SET state = 'changes', feedback = ?2, closed_at = ?3 WHERE id = ?1").run(gate.id, text, now);
  appendEvent(db, { source: "cli", kind: "gate.changes", runId: run.id, taskId: run.task_id, payload: { gate: gate.id, stage: gate.stage, to: pos.def.stages[target]!.id, by }, ts: now });
  resolveRunItems(db, run.id, ["gate_ready"], `gate.changes ${gate.id}`, now);
  discardPlansOfGate(db, gate.id, now);
  requestStage(db, run, pos.def, target, `Changes requested at the ${gate.stage} review: ${text} Back to stage ${pos.def.stages[target]!.id}.`, now);
  return pos.def.stages[target]!.id;
}

// --- delivery ------------------------------------------------------------------------------------

/**
 * May the run deliver now? From its last stage, once that stage runs; from an
 * earlier stage only when every stage after it lacks a review gate: the
 * delivery then finishes them at once and holds nothing, since nothing of
 * them remains to run. Returns the stages it finishes that way.
 */
export function deliveryStages(db: Db, run: RunWithPolicy): string[] {
  const pos = positionOf(db, run, run.kind);
  if (run.stage_state === "waiting") throw new FlowrynError("wrong_stage", `stage ${pos.stage.id} has not started; it waits for capacity`, "end your turn; a steer says when it starts");
  if (run.stage_state === "review") throw new FlowrynError("wrong_stage", `the ${pos.stage.id} review gate is open`, "end your turn; a steer brings the verdict");
  if (pos.last) return [];
  const later = pos.def.stages.slice(pos.index + 1);
  const gated = [pos.stage, ...later.slice(0, -1)].find((s) => s.gate === "review");
  if (gated) throw new FlowrynError("wrong_stage", `stage ${pos.stage.id} comes before the ${gated.id} review; you cannot deliver yet`, stageDoneHelp(pos));
  return later.map((s) => s.id);
}

function stageDoneHelp(pos: StagePos): string {
  return pos.stage.gate === "review" ? "$FLOWRYN_BIN stage done --review <lavish url>" : "$FLOWRYN_BIN stage done";
}

/** The delivery ended the last stage: its pools go back and a ship's merge gate opens. Call inside a transaction. */
export function recordStageDelivered(db: Db, run: RunWithPolicy, skipped: string[], now: number): void {
  const def = runWorkflow(db, run, run.kind);
  const last = def.stages[def.stages.length - 1]!;
  releaseLeases(db, run.id, run.task_id, { keepWorker: true }, `stage ${last.id} delivered`, now);
  db.query("UPDATE runs SET stage = ?2, stage_state = 'done', waiting_since = NULL, stage_note = NULL, updated_at = ?3 WHERE id = ?1").run(run.id, last.id, now);
  appendEvent(db, { source: "cli", kind: "stage.delivered", runId: run.id, taskId: run.task_id, payload: { stage: last.id, finished_at_delivery: skipped }, ts: now });
  run.stage = last.id;
  run.stage_state = "done";
  if (run.kind === "ship" && last.gate === "merge") openMergeGate(db, run, now);
}

// --- the worker's verbs ----------------------------------------------------------------------------

const REVIEW_URL = /^(?:https?|file):\/\/\S{1,480}$/;

function workerRun(ctx: { db: Db; caller: HandlerCtx["caller"] }): RunWithPolicy {
  const run = ctx.caller.runId ? getRunWithPolicy(ctx.db, ctx.caller.runId) : null;
  if (!run) throw new FlowrynError("not_found", "this worker's run is gone");
  if (isTerminal(run.state)) throw new FlowrynError("run_not_active", `run ${run.id} is ${run.state}`);
  return run;
}

/**
 * `flowryn stage done [--review <url>] [--plan-file <path>]`: the worker
 * finished its stage. A review gate opens (a P1 with the link) and waits for
 * a human channel; otherwise the next stage is requested and a steer starts
 * it. Either way the worker ends its turn.
 */
const stageDone: VerbSpec = {
  name: "stage done",
  summary: "Finish your current stage: --review <lavish url> for a stage with a review gate; then end your turn",
  positionals: [],
  flags: {
    review: { type: "string", help: "the Lavish page to review (a review gate stage)", placeholder: "url" },
    "plan-file": { type: "string", help: "a phase plan for the later phases, approved with the design", fileFor: "plan" },
  },
  kind: "mutation",
  roles: ["worker"],
  spool: true,
  apply(ctx, args) {
    const run = workerRun(ctx);
    const pos = positionOf(ctx.db, run, run.kind);
    const now = ctx.now();
    if (run.stage_state === "waiting") throw new FlowrynError("wrong_stage", `stage ${pos.stage.id} has not started yet; it waits for capacity`, "end your turn; a steer says when it starts");
    if (run.stage_state === "review") throw new FlowrynError("wrong_stage", `stage ${pos.stage.id} is already waiting for its review`, "end your turn; a steer brings the verdict");
    if (run.stage_state === "done") throw new FlowrynError("wrong_stage", "you delivered already");
    if (pos.last) throw new FlowrynError("wrong_stage", `${pos.stage.id} is the last stage; it ends with your delivery`, run.kind === "scout" ? "$FLOWRYN_BIN deliver --report <path>" : "$FLOWRYN_BIN deliver");
    const review = stringArg(args, "review");
    const planText = stringArg(args, "plan");
    const title = taskTitle(ctx.db, run.task_id);
    releaseLeases(ctx.db, run.id, run.task_id, { keepWorker: true }, `stage ${pos.stage.id} done`, now);
    if (pos.stage.gate === "review") {
      if (!review) throw new FlowrynError("bad_args", `stage ${pos.stage.id} has a review gate: pass --review <lavish url>`);
      if (!REVIEW_URL.test(review)) throw new FlowrynError("bad_args", "--review must be an http(s) or file:// URL");
      const gateId = nextGateId(ctx.db);
      ctx.db.query("INSERT INTO gates (id, run_id, stage, kind, review_url, state, opened_at) VALUES (?1, ?2, ?3, 'review', ?4, 'open', ?5)").run(gateId, run.id, pos.stage.id, review, now);
      ctx.db.query("UPDATE runs SET stage_state = 'review', updated_at = ?2 WHERE id = ?1").run(run.id, now);
      let plan: string | null = null;
      if (planText !== undefined) {
        const project = getProject(ctx.db, run.project_id);
        if (!project) throw new FlowrynError("not_found", `project ${run.project_id} is gone`);
        plan = fileWorkerPlan(ctx.db, { project, sourceTask: run.task_id, gateId, phases: parsePlan(planText), workflow: project.workflow, now });
      }
      const event = appendEvent(ctx.db, { source: "cli", kind: "stage.done", runId: run.id, taskId: run.task_id, payload: { stage: pos.stage.id, gate: gateId, review, plan, via: ctx.via }, ts: now });
      appendEvent(ctx.db, { source: "cli", kind: "gate.opened", runId: run.id, taskId: run.task_id, payload: { gate: gateId, stage: pos.stage.id, kind: "review", review }, ts: now });
      resolveRunItems(ctx.db, run.id, ["worker_idle"], "stage.done", now);
      openItem(ctx.db, { kind: "gate_ready", eventSeq: event.seq, taskId: run.task_id, runId: run.id, line: `${pos.stage.id} ready for review (${gateId}): ${title} (${run.project_id}) ${sanitizeLine(review, 120)}`, now });
      return { data: { stage: pos.stage.id, gate: gateId, state: "review", plan: plan ?? "-" }, hints: ["end your turn; a steer brings the verdict"] };
    }
    if (planText !== undefined) throw new FlowrynError("bad_args", "a plan rides with a review gate (approving the design approves the plan); this stage has none");
    if (review) throw new FlowrynError("bad_args", `stage ${pos.stage.id} has no review gate; drop --review`);
    appendEvent(ctx.db, { source: "cli", kind: "stage.done", runId: run.id, taskId: run.task_id, payload: { stage: pos.stage.id, via: ctx.via }, ts: now });
    requestStage(ctx.db, run, pos.def, pos.index + 1, `Stage ${pos.stage.id} is done.`, now);
    resolveRunItems(ctx.db, run.id, ["worker_idle"], "stage.done", now);
    return { data: { stage: pos.stage.id, next: pos.def.stages[pos.index + 1]!.id, state: "requested" }, hints: ["end your turn; a steer starts the next stage"] };
  },
  async settle(ctx, result) {
    ctx.sched.kick();
    ctx.journal.kick();
    return result;
  },
};

/** `flowryn stage show`: your run's workflow, current stage, its skill, and what ends it. */
const stageShow: VerbSpec = {
  name: "stage show",
  summary: "Your workflow and current stage: its skill, its state, and what ends it",
  positionals: [],
  flags: {},
  kind: "read",
  roles: ["worker"],
  read(ctx: ReadCtx) {
    const run = workerRun(ctx);
    const pos = positionOf(ctx.db, run, run.kind);
    const gate = openGate(ctx.db, run.id, "review");
    return {
      data: {
        workflow: `${pos.def.id}: ${flowLine(pos.def)}`,
        stage: pos.stage.id,
        state: run.stage_state,
        pools: runLeases(ctx.db, run.id).map((l) => l.pool),
        instructions: stageInstructions(pos, stageTextContext(ctx.db, ctx.config, run)),
        ...(gate ? { gate: `${gate.id} open${gate.review_url ? `: ${gate.review_url}` : ""}` } : {}),
      },
    };
  },
};

export const STAGE_VERBS: VerbSpec[] = [stageDone, stageShow];
