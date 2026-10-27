import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FlowrynError } from "../api/errors.ts";
import { stringArg, type HandlerCtx, type ReadCtx, type VerbSpec } from "../api/verbs.ts";
import { openItem, resolveRunItems } from "../attention/items.ts";
import { resolveTool, type FlowrynConfig } from "../config/config.ts";
import { reviewConfig } from "../config/leader.ts";
import { capacityConfig, DEFAULT_WORKFLOWS, WORKER_POOL, type StageDef, type WorkflowDef } from "../config/workflows.ts";
import type { Db } from "../db/db.ts";
import { getMeta, setMeta, tx } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { deliveryLines, type ContractDelivery } from "../harness/contract-text.ts";
import { grantLeases, holdsLease, releaseLeases, runLeases } from "../sched/pools.ts";
import { DESIGN_TEMPLATE_FILE, designPageProblems } from "../skills/design-template.ts";
import { QA_PAGE_MAX_BYTES, QA_TEMPLATE_FILE, qaPageProblems } from "../skills/qa-template.ts";
import { skillPath } from "../skills/stages.ts";
import { sanitizeBlock, sanitizeLine } from "../util/sanitize.ts";
import type { GateOpenState } from "../lavish/opener.ts";
import { parseGateQuestions } from "../lavish/questions.ts";
import { findPageForKey, lavishSessionKey, lavishUrlKey } from "../lavish/session-key.ts";
import { checkReviewPage, dismissGateQuestions, gateAnswersNote, openGateQuestions } from "./gate-questions.ts";
import { reportDirFor } from "./launcher.ts";
import { approvePlan, discardPlansOfGate, fileWorkerPlan, parsePlan } from "./plans.ts";
import { getProject } from "./projects.ts";
import { getRunWithPolicy, isTerminal, taskTitle, type PendingLaunch, type RunRow, type RunWithPolicy } from "./runs.ts";
import { summarizeReview } from "./review-chat.ts";
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

function usable(def: WorkflowDef | undefined | null): def is WorkflowDef {
  return Boolean(def && Array.isArray(def.stages) && def.stages.length > 0);
}

/**
 * The workflow a run was dispatched with, frozen then, so a later config edit
 * never reshapes a running run. A run open before M5 has its workflow frozen
 * by the migration instead (runs.workflow_def).
 */
export function runWorkflow(db: Db, run: Pick<RunRow, "id" | "workflow">, kind?: "ship" | "scout"): WorkflowDef {
  const migrated = db.query("SELECT workflow_def FROM runs WHERE id = ?1").get(run.id) as { workflow_def: string | null } | null;
  const carried = migrated?.workflow_def ? (JSON.parse(migrated.workflow_def) as WorkflowDef) : null;
  if (usable(carried)) return carried;
  const row = db.query("SELECT payload FROM events WHERE run_id = ?1 AND kind = 'run.dispatched' ORDER BY seq LIMIT 1").get(run.id) as { payload: string } | null;
  const frozen = row ? (JSON.parse(row.payload) as DispatchedPayload).workflow_def : undefined;
  if (usable(frozen)) return frozen;
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
  if (pos.last) {
    parts.push(`This is the last stage. ${deliveryLines({ ...ctx.delivery, inLastStage: true }).map((l) => l.replace(/^-\s*/, "").trim()).join(" ")}`);
    return parts.join(" ");
  }
  if (ctx.delivery.kind === "ship" && ctx.delivery.mode === "no-mistakes") parts.push(`Do not run the no-mistakes pipeline yet: it runs in stage ${def.stages[def.stages.length - 1]!.id}, once that stage has started.`);
  if (stage.gate === "review") {
    parts.push("When it is ready for review: $FLOWRYN_BIN stage done --review <lavish url> --page <its .html file>, then end your turn; a steer brings the verdict. Flowryn listens on the page itself and opens it in the user's browser: do not hold a lavish-axi poll open, and never say the page is open in their browser.");
    parts.push("Only a question you cannot proceed without goes to the user: add --questions-file <json> (the flowryn-design skill has the shape); decide the rest yourself and record it.");
  }
  else parts.push("When it is done: $FLOWRYN_BIN stage done, then end your turn; a steer starts the next stage.");
  return parts.join(" ");
}

/** The stage a run's delivery ends, as its contract names it. */
export function lastStageOf(db: Db, run: Pick<RunRow, "id" | "workflow"> & { kind: "ship" | "scout" }): { id: string; pools: string[] } {
  const stages = runWorkflow(db, run, run.kind).stages;
  const last = stages[stages.length - 1]!;
  return { id: last.id, pools: last.pools };
}

/** The text context for a run's stages: its delivery lines follow the task kind and the project's mode. */
export function stageTextContext(db: Db, config: FlowrynConfig, run: RunWithPolicy): StageTextContext {
  const project = getProject(db, run.project_id);
  return {
    stateDir: config.state_dir,
    delivery: { kind: run.kind, mode: run.delivery_mode as ContractDelivery["mode"], defaultBranch: project?.default_branch ?? "main", base: run.base_branch, lastStage: lastStageOf(db, run), harness: run.harness },
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
 * a live worker carries on, steer it with the stage's instructions (unless
 * `steer: false`: the worker is waiting on the reply that says it started). A
 * launch the grant starts gets the instructions in its task file instead. Throws
 * OverCapacity (taking nothing) when a pool filled meanwhile. Call inside a
 * transaction.
 */
export function activateStage(db: Db, config: FlowrynConfig, run: RunWithPolicy, now: number, opts: { steer?: boolean } = {}): Activated {
  const pos = positionOf(db, run, run.kind);
  const caps = capacityConfig(config).pools;
  grantLeases(db, run.id, run.task_id, pos.stage.id, neededPools(db, run, pos), caps, now);
  const launch = run.pending_launch;
  const starting = run.stage_state === "waiting";
  // A fresh launch reads its stage from the task file, and a fresh stage worker or a relaunched one its note too: the launcher clears it.
  const noteInFile = launch === "fresh" || launch === "stage" || launch === "relaunch";
  let steer: string | null = null;
  if (starting && opts.steer !== false && run.stage_note !== null && !noteInFile) {
    const text = [run.stage_note, stageInstructions(pos, stageTextContext(db, config, run))].filter((t) => t.length > 0).join(" ");
    steer = createSteer(db, run, text, now).id;
  }
  db.query(
    `UPDATE runs SET stage_state = CASE WHEN stage_state = 'waiting' THEN 'active' ELSE stage_state END,
       stage_started_at = CASE WHEN stage_state = 'waiting' THEN ?2 ELSE stage_started_at END,
       waiting_since = NULL, pending_launch = CASE WHEN ?3 IN ('stage','relaunch') THEN ?3 ELSE NULL END,
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
  /** The review page's .html file (`stage done --page`), which Flowryn listens on. */
  page_path?: string | null;
  state: "open" | "passed" | "changes";
  /** Opening the review page in your browser (src/lavish/opener.ts); null for a merge gate. */
  open_state?: GateOpenState | null;
  open_detail?: string | null;
  open_at?: number | null;
  /** The daemon's Lavish poll of the page (src/lavish/channel.ts). */
  channel_ok_at?: number | null;
  channel_failing_since?: number | null;
  channel_failures?: number | null;
  channel_reason?: string | null;
  channel_retry_at?: number | null;
  channel_item?: string | null;
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

/** What a review gate's close resolves: its own items, and what its page raised. */
export const REVIEW_ITEMS = ["gate_ready", "review_feedback", "review_summary", "review_worker_gone", "pass_requested", "review_channel"] as const;

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
  resolveRunItems(db, run.id, REVIEW_ITEMS, `gate.passed ${gate.id}`, now);
  summarizeReview(db, gate.id, "passed", now);
  const plan = db.query("SELECT id FROM plans WHERE gate_id = ?1 AND state = 'pending'").get(gate.id) as { id: string } | null;
  // Approving the design approves the plan it carried (design section 11): its phases reach the backlog now.
  if (plan) approvePlan(db, plan.id, `gate ${gate.id} (${approval.channel})`, now);
  const nextIndex = Math.min(pos.index + 1, pos.def.stages.length - 1);
  const answers = gateAnswersNote(db, gate.id);
  requestStage(db, run, pos.def, nextIndex, `The ${gate.stage} review passed (${approval.channel}).${plan ? ` Its plan ${plan.id} is approved; its phases start by themselves once this task lands.` : ""}${answers ? ` ${answers}` : ""}`, now);
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
  resolveRunItems(db, run.id, REVIEW_ITEMS, `gate.changes ${gate.id}`, now);
  summarizeReview(db, gate.id, "changes", now);
  discardPlansOfGate(db, gate.id, now);
  dismissGateQuestions(db, run, gate.id, now, "gate changes", "cli");
  const answers = gateAnswersNote(db, gate.id);
  requestStage(db, run, pos.def, target, `Changes requested at the ${gate.stage} review: ${text}${answers ? ` ${answers}` : ""} Back to stage ${pos.def.stages[target]!.id}.`, now);
  return pos.def.stages[target]!.id;
}

// --- delivery ------------------------------------------------------------------------------------

/**
 * May the run deliver now? From its last stage, once that stage runs; from an
 * earlier stage only when every stage after it lacks a review gate. A stage it
 * would skip that holds pools is never finished for free (the caps are the
 * contract): startPooledStages requests it through the scheduler first, and
 * the delivery waits for its grant. The rest the delivery finishes at once.
 * Returns the stages it finishes that way; refuses while a pooled one remains.
 */
export function deliveryStages(db: Db, run: RunWithPolicy): string[] {
  const pos = positionOf(db, run, run.kind);
  if (run.stage_state === "waiting") throw new FlowrynError("wrong_stage", `stage ${pos.stage.id} has not started; it waits for capacity`, "end your turn; a steer says when it starts");
  if (run.stage_state === "review") throw new FlowrynError("wrong_stage", `the ${pos.stage.id} review gate is open`, "end your turn; a steer brings the verdict");
  if (pos.last) return [];
  const later = pos.def.stages.slice(pos.index + 1);
  const gated = [pos.stage, ...later.slice(0, -1)].find((s) => s.gate === "review");
  if (gated) throw new FlowrynError("wrong_stage", `stage ${pos.stage.id} comes before the ${gated.id} review; you cannot deliver yet`, stageDoneHelp(pos));
  const pooled = later.find((s) => s.pools.length > 0);
  if (pooled) throw stageWaiting(pooled);
  return later.map((s) => s.id);
}

function stageWaiting(stage: StageDef): FlowrynError {
  return new FlowrynError(
    "stage_waiting",
    `your delivery needs stage ${stage.id}, which holds a slot of ${stage.pools.join(" and ")}; it waits for capacity`,
    `end your turn; a steer starts stage ${stage.id}, then deliver again`,
  );
}

function beginWaiting(stage: StageDef): FlowrynError {
  return new FlowrynError(
    "stage_waiting",
    `stage ${stage.id} waits for a slot of ${stage.pools.join(" and ")}`,
    `end your turn; a steer says when stage ${stage.id} has started; do not run the pipeline before`,
  );
}

/**
 * Must this run hold its last stage before its no-mistakes pipeline runs? A
 * no-mistakes ship does, except one open before M5 (legacy_m4): its worker
 * was given M4's contract, so its slot is granted at delivery time instead.
 */
export function pipelineNeedsLastStage(db: Db, run: RunWithPolicy): boolean {
  return run.kind === "ship" && run.delivery_mode === "no-mistakes" && runWorkflow(db, run, run.kind).legacy_m4 !== true;
}

/**
 * A no-mistakes ship runs its pipeline under its last stage's slots, so it
 * delivers only once that stage was active before the call (`stage begin`
 * starts it). The pipeline start itself is the worker's contract; this is the
 * backstop: a delivery from an earlier stage is refused, never granted at once.
 */
export function requireLastStageStarted(db: Db, run: RunWithPolicy): void {
  const pos = positionOf(db, run, run.kind);
  if (pos.last && run.stage_state === "active") return;
  if (run.stage_state === "review") deliveryStages(db, run);
  const last = pos.def.stages[pos.def.stages.length - 1]!;
  if (pos.last) throw new FlowrynError("stage_waiting", `stage ${last.id} has not started; it waits for capacity`, `end your turn; a steer says when stage ${last.id} has started`);
  throw new FlowrynError(
    "stage_waiting",
    `a no-mistakes ship delivers from stage ${last.id}, which has not started: its pipeline runs under that stage's slot`,
    `$FLOWRYN_BIN stage begin ${last.id}, then run the pipeline and deliver`,
  );
}

/** The first stage after the current one that holds pools, when a delivery from here would skip it. */
function pooledStageAhead(pos: StagePos): number | null {
  if (pos.last) return null;
  const found = pos.def.stages.findIndex((s, i) => i > pos.index && s.pools.length > 0);
  return found >= 0 ? found : null;
}

interface Requested {
  stage: StageDef;
  fresh: boolean;
}

/** End the current stage and request a later one, skipping the ungated stages between. Call inside a transaction. */
function requestLater(ctx: HandlerCtx, run: RunWithPolicy, pos: StagePos, index: number, note: string, reason: "deliver" | "begin"): Requested {
  const stage = pos.def.stages[index]!;
  const now = ctx.now();
  releaseLeases(ctx.db, run.id, run.task_id, { keepWorker: true }, `stage ${pos.stage.id} done`, now);
  appendEvent(ctx.db, { source: "cli", kind: "stage.done", runId: run.id, taskId: run.task_id, payload: { stage: pos.stage.id, via: ctx.via, for: reason, next: stage.id }, ts: now });
  requestStage(ctx.db, run, pos.def, index, note, now);
  return { stage, fresh: run.pending_launch === "stage" };
}

/**
 * Grant a stage requested under a worker's call, for this run only (the same
 * pools and host check as any grant). A stage that starts a fresh worker is
 * never granted under a call in flight; it and a stage that cannot start now
 * are left to the scheduler, whose steer says when it has started.
 */
async function grantRequested(ctx: HandlerCtx, runId: string, requested: Requested, waiting: () => FlowrynError): Promise<void> {
  if (!requested.fresh && (await ctx.sched.grantNow(runId))) return;
  ctx.sched.kick();
  throw waiting();
}

/**
 * A local-only or direct-PR delivery from an earlier stage whose skipped
 * stages hold pools: the current stage ends and the pooled stage is
 * requested and granted for this run. When the grant comes at once the
 * delivery goes on from that stage; otherwise it is refused (stage_waiting)
 * and the run waits: the steer that starts the stage tells the worker to
 * deliver again.
 */
export async function startPooledStages(ctx: HandlerCtx, runId: string): Promise<void> {
  for (;;) {
    const requested = tx(ctx.db, () => {
      const run = getRunWithPolicy(ctx.db, runId);
      if (!run || isTerminal(run.state) || run.state === "ready" || run.stage_state === "done") return null;
      const pos = positionOf(ctx.db, run, run.kind);
      const index = pooledStageAhead(pos);
      if (index === null) return null;
      try {
        deliveryStages(ctx.db, run);
      } catch (error) {
        if (!(error instanceof FlowrynError && error.code === "stage_waiting")) throw error;
      }
      const stage = pos.def.stages[index]!;
      return requestLater(ctx, run, pos, index, `Your delivery waited for stage ${stage.id}, which holds a slot of ${stage.pools.join(" and ")}; it has started now: deliver again.`, "deliver");
    });
    if (!requested) return;
    await grantRequested(ctx, runId, requested, () => stageWaiting(requested.stage));
  }
}

/**
 * `stage begin <last stage>`: start the stage the delivery ends now, from an
 * earlier stage with no review gate and no pooled stage between (a
 * no-mistakes ship calls it before its pipeline). Already started: nothing to
 * do. Refused with stage_waiting while it waits for its slots.
 */
export async function beginLastStage(ctx: HandlerCtx, runId: string, target: string): Promise<void> {
  const requested = tx(ctx.db, () => {
    const run = getRunWithPolicy(ctx.db, runId);
    if (!run || isTerminal(run.state)) throw new FlowrynError("run_not_active", `run ${runId} is ${run?.state ?? "gone"}`);
    if (run.state === "ready" || run.stage_state === "done") throw new FlowrynError("wrong_stage", "you delivered already");
    const pos = positionOf(ctx.db, run, run.kind);
    const lastIndex = pos.def.stages.length - 1;
    const last = pos.def.stages[lastIndex]!;
    if (target !== last.id) throw new FlowrynError("bad_args", `stage begin starts your last stage, ${last.id}; the others start with stage done`, stageDoneHelp(pos));
    if (pos.last) {
      if (run.stage_state === "waiting") throw beginWaiting(last);
      return null;
    }
    if (run.stage_state === "waiting") throw new FlowrynError("wrong_stage", `stage ${pos.stage.id} has not started; it waits for capacity`, "end your turn; a steer says when it starts");
    if (run.stage_state === "review") throw new FlowrynError("wrong_stage", `the ${pos.stage.id} review gate is open`, "end your turn; a steer brings the verdict");
    const before = pos.def.stages.slice(pos.index, lastIndex);
    const gated = before.find((s) => s.gate === "review");
    if (gated) throw new FlowrynError("wrong_stage", `stage ${pos.stage.id} comes before the ${gated.id} review; you cannot begin ${last.id} yet`, stageDoneHelp(pos));
    const pooled = before.slice(1).find((s) => s.pools.length > 0);
    if (pooled) throw new FlowrynError("wrong_stage", `stage ${pooled.id} comes first and holds a slot of ${pooled.pools.join(" and ")}`, stageDoneHelp(pos));
    return requestLater(ctx, run, pos, lastIndex, `Stage ${last.id} has started; go on from where you stopped.`, "begin");
  });
  if (!requested) return;
  await grantRequested(ctx, runId, requested, () => (requested.stage.pools.length > 0 ? beginWaiting(requested.stage) : new FlowrynError("stage_waiting", `stage ${requested.stage.id} has not started yet`, `end your turn; a steer says when stage ${requested.stage.id} has started`)));
}

function stageDoneHelp(pos: StagePos): string {
  return pos.stage.gate === "review" ? "$FLOWRYN_BIN stage done --review <lavish url> --page <its .html file>" : "$FLOWRYN_BIN stage done";
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

const MAX_REVIEW_URL = 512;

interface ReviewTarget {
  /** The page the gate is for: --page, or the QA stage's own evidence page. */
  page: string | null;
  reportDir: string;
  /** lavish-axi is installed, so a file:// review is not accepted. */
  lavishInstalled: boolean;
}

/**
 * The review URL of a gate and the page Flowryn listens on (the toolkit
 * report's Q3). It must be lavish's URL for a page under the report
 * directory: its session key is that page's realpath hash (session-key.ts),
 * so the check needs no network and gives the same verdict when a spooled
 * stage done is replayed. With --page (or the QA page) the key must be that
 * page's; without, the page under the report directory with that key is the
 * one. A file:// URL is the fallback only while lavish-axi is not installed.
 */
function hostHint(page: string | null): string {
  return `host it: lavish-axi --no-open ${page ?? "<the page under $FLOWRYN_REPORT_DIR>"} prints its URL; pass it with --page <that page>`;
}

function checkReviewUrl(review: string, target: ReviewTarget): { url: string; page: string } {
  if (review.length > MAX_REVIEW_URL) throw new FlowrynError("review_invalid", `--review is over ${MAX_REVIEW_URL} characters`);
  const key = lavishUrlKey(review);
  if (key !== null) {
    if (target.page !== null) {
      const expected = lavishSessionKey(target.page);
      if (key !== expected) throw new FlowrynError("review_invalid", `--review names lavish session ${key}, but ${target.page} is session ${expected}`, hostHint(target.page));
      return { url: review, page: target.page };
    }
    const found = findPageForKey(realReportDir(target.reportDir), key);
    if (!found) throw new FlowrynError("review_invalid", `no page under $FLOWRYN_REPORT_DIR is lavish session ${key}`, hostHint(null));
    return { url: review, page: checkReviewPage(found, target.reportDir, { widget: false }) };
  }
  if (review.startsWith("file://")) {
    if (target.lavishInstalled) throw new FlowrynError("review_invalid", "lavish-axi is installed, so a review is its URL, not a file:// one", hostHint(target.page));
    const page = reviewFilePage(review, target.reportDir);
    if (!page) throw new FlowrynError("review_invalid", "a file:// review must name an .html page under $FLOWRYN_REPORT_DIR");
    if (target.page !== null && page !== target.page) throw new FlowrynError("review_invalid", `--review names ${page}, but the review page is ${target.page}`);
    return { url: review, page };
  }
  throw new FlowrynError("review_invalid", "--review must be lavish's URL for the review page (http://<host>:<port>/session/<16 hex>)", hostHint(target.page));
}

function realReportDir(reportDir: string): string {
  try {
    return realpathSync(reportDir);
  } catch {
    throw new FlowrynError("review_invalid", "$FLOWRYN_REPORT_DIR does not exist, so it holds no review page");
  }
}

function workerRun(ctx: { db: Db; caller: HandlerCtx["caller"] }): RunWithPolicy {
  const run = ctx.caller.runId ? getRunWithPolicy(ctx.db, ctx.caller.runId) : null;
  if (!run) throw new FlowrynError("not_found", "this worker's run is gone");
  if (isTerminal(run.state)) throw new FlowrynError("run_not_active", `run ${run.id} is ${run.state}`);
  return run;
}

/** A file:// review URL that names a page the daemon may poll, or null. */
function reviewFilePage(review: string, reportDir: string): string | null {
  if (!review.startsWith("file://")) return null;
  try {
    return checkReviewPage(fileURLToPath(review), reportDir, { widget: false });
  } catch {
    return null;
  }
}

const QA_SKILL = "flowryn-visual-qa";

/**
 * A QA stage's review page must open with its filled plain-language card
 * (src/skills/qa-template.ts). It lives at `$FLOWRYN_REPORT_DIR/qa/evidence.html`,
 * as the skill says; a symlink there is refused rather than followed.
 */
export function checkQaPage(reportDir: string): string {
  const path = join(reportDir, "qa", "evidence.html");
  const hint = `copy ${QA_TEMPLATE_FILE} from the flowryn-visual-qa skill to ${path} and fill it`;
  let st;
  try {
    st = lstatSync(path);
  } catch {
    throw new FlowrynError("qa_page_invalid", `no QA page at ${path}`, hint);
  }
  if (!st.isFile()) throw new FlowrynError("qa_page_invalid", `${path} is not a regular file`, hint);
  if (st.size > QA_PAGE_MAX_BYTES) throw new FlowrynError("qa_page_invalid", `${path} is over ${QA_PAGE_MAX_BYTES / 1024 / 1024} MB`);
  const problems = qaPageProblems(readFileSync(path, "utf8"));
  if (problems.length > 0) throw new FlowrynError("qa_page_invalid", `${path}: ${problems.join("; ")}`, "fix the page, host it again, then run stage done");
  try {
    return checkReviewPage(path, reportDir, { widget: false });
  } catch (error) {
    if (error instanceof FlowrynError) throw new FlowrynError("qa_page_invalid", error.message, error.help);
    throw error;
  }
}

const DESIGN_SKILL = "flowryn-design";

/**
 * A design stage's review page must follow the design outline, budget and
 * plain-language rule (src/skills/design-template.ts). The page is the one
 * the review names, already checked to be a regular .html file under the
 * report directory; `widget`: it carries questions for the user.
 */
export function checkDesignPage(page: string, opts: { widget: boolean }): void {
  const problems = designPageProblems(readFileSync(page, "utf8"), opts);
  if (problems.length > 0) {
    throw new FlowrynError("design_page_invalid", `${page}: ${problems.join("; ")}`, `start from ${DESIGN_TEMPLATE_FILE} beside the flowryn-design skill; fix the page, host it again, then run stage done`);
  }
}

/**
 * `flowryn stage done [--review <url>] [--plan-file <path>] [--page <html>
 * [--questions-file <json>]]`: the worker finished its stage. A review gate
 * opens (a P1 with the link) and waits for a human channel; the daemon
 * listens on its page, and its questions open as decisions reserved for the
 * user (gate-questions.ts); otherwise
 * the next stage is requested and a steer starts it. Either way the worker
 * ends its turn.
 */
const stageDone: VerbSpec = {
  name: "stage done",
  summary: "Finish your current stage: --review <lavish url> for a stage with a review gate; then end your turn",
  positionals: [],
  flags: {
    review: { type: "string", help: "the Lavish page to review (a review gate stage)", placeholder: "url" },
    "plan-file": { type: "string", help: "a phase plan for the later phases, approved with the design", fileFor: "plan" },
    page: { type: "string", help: "the review page's .html file: Flowryn listens on it for the user's feedback, and it mounts the question widget with --questions-file", placeholder: "path" },
    "questions-file": { type: "string", help: "what only the user can answer, as JSON (with --page); each becomes a decision reserved for them", fileFor: "questions" },
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
    const page = stringArg(args, "page");
    const questionsText = stringArg(args, "questions");
    if (questionsText !== undefined && page === undefined) throw new FlowrynError("bad_args", "--questions-file needs --page: the questions go on that page");
    if (questionsText !== undefined && pos.stage.gate !== "review") throw new FlowrynError("bad_args", `questions ride with a review gate; stage ${pos.stage.id} has none: decide them yourself and record your choices`);
    if (page !== undefined && pos.stage.gate !== "review") throw new FlowrynError("bad_args", `--page rides with a review gate; stage ${pos.stage.id} has none`);
    const questions = questionsText !== undefined ? parseGateQuestions(questionsText) : null;
    const reportDir = reportDirFor(ctx.config(), run.task_id);
    const pagePath = page !== undefined ? checkReviewPage(page, reportDir, { widget: questions !== null }) : null;
    const title = taskTitle(ctx.db, run.task_id);
    let gateReview: string | null = null;
    let listened: string | null = null;
    if (pos.stage.gate === "review") {
      if (!review) throw new FlowrynError("bad_args", `stage ${pos.stage.id} has a review gate: pass --review <lavish url>`);
      const qaPage = pos.stage.skill === QA_SKILL ? checkQaPage(reportDir) : null;
      if (qaPage !== null && pagePath !== null && pagePath !== qaPage) throw new FlowrynError("bad_args", `the QA review page is ${qaPage}; --page names another`);
      const lavish = resolveTool(ctx.config(), "lavish_axi");
      const checked = checkReviewUrl(review, { page: qaPage ?? pagePath, reportDir, lavishInstalled: lavish !== null && existsSync(lavish) });
      if (pos.stage.skill === DESIGN_SKILL) checkDesignPage(checked.page, { widget: questions !== null });
      gateReview = checked.url;
      listened = checked.page;
    }
    releaseLeases(ctx.db, run.id, run.task_id, { keepWorker: true }, `stage ${pos.stage.id} done`, now);
    if (gateReview !== null) {
      const gateId = nextGateId(ctx.db);
      // The daemon opens the page in your browser once its poll listens (src/lavish/opener.ts), unless [review] turns that off.
      const browser = reviewConfig(ctx.config()).open_browser ? { state: "pending", detail: null } : { state: "off", detail: "[review] open_browser = false" };
      ctx.db
        .query("INSERT INTO gates (id, run_id, stage, kind, review_url, state, opened_at, open_state, open_detail) VALUES (?1, ?2, ?3, 'review', ?4, 'open', ?5, ?6, ?7)")
        .run(gateId, run.id, pos.stage.id, gateReview, now, browser.state, browser.detail);
      ctx.db.query("UPDATE runs SET stage_state = 'review', updated_at = ?2 WHERE id = ?1").run(run.id, now);
      // The daemon listens on the page itself (src/lavish/poller.ts): the one the review URL names.
      if (listened) ctx.db.query("UPDATE gates SET page_path = ?2 WHERE id = ?1").run(gateId, listened);
      const asked = questions && pagePath ? openGateQuestions(ctx.db, run, { id: gateId, stage: pos.stage.id, review_url: gateReview }, pagePath, questions, now) : [];
      let plan: string | null = null;
      if (planText !== undefined) {
        const project = getProject(ctx.db, run.project_id);
        if (!project) throw new FlowrynError("not_found", `project ${run.project_id} is gone`);
        plan = fileWorkerPlan(ctx.db, ctx.config(), { project, sourceTask: run.task_id, gateId, phases: parsePlan(planText), workflow: project.workflow, now });
      }
      const event = appendEvent(ctx.db, { source: "cli", kind: "stage.done", runId: run.id, taskId: run.task_id, payload: { stage: pos.stage.id, gate: gateId, review: gateReview, plan, questions: asked, via: ctx.via }, ts: now });
      appendEvent(ctx.db, { source: "cli", kind: "gate.opened", runId: run.id, taskId: run.task_id, payload: { gate: gateId, stage: pos.stage.id, kind: "review", review: gateReview, browser: browser.state }, ts: now });
      resolveRunItems(ctx.db, run.id, ["worker_idle"], "stage.done", now);
      const asking = asked.length > 0 ? ` with ${asked.length} question${asked.length === 1 ? "" : "s"} for you (${asked.join(", ")})` : "";
      openItem(ctx.db, { kind: "gate_ready", eventSeq: event.seq, taskId: run.task_id, runId: run.id, line: `${pos.stage.id} ready for review (${gateId})${asking}: ${title} (${run.project_id}) ${sanitizeLine(gateReview, 120)}`, now });
      const hints = ["end your turn; a steer brings the verdict and the user's answers"];
      return { data: { stage: pos.stage.id, gate: gateId, state: "review", plan: plan ?? "-", questions: asked }, hints };
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
    ctx.lavish.kick();
    return result;
  },
};

/**
 * `flowryn stage begin <stage>`: start your last stage now, before the work
 * that must run under its slots (a no-mistakes ship's pipeline). It returns
 * once the stage has started, or stage_waiting: end your turn, and a steer
 * says when it has.
 */
const stageBegin: VerbSpec = {
  name: "stage begin",
  summary: "Start your last stage now (a no-mistakes ship: before its pipeline); stage_waiting means end your turn",
  positionals: [{ name: "stage", required: true, help: "your workflow's last stage (ship)" }],
  flags: {},
  kind: "mutation",
  roles: ["worker"],
  replyMs: 30_000,
  async prepare(ctx, args) {
    await beginLastStage(ctx, workerRun(ctx).id, stringArg(args, "stage")!);
    return null;
  },
  apply(ctx) {
    const run = workerRun(ctx);
    return { data: { stage: run.stage, state: run.stage_state, pools: runLeases(ctx.db, run.id).map((l) => l.pool) }, hints: ["go on: the stage has started"] };
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

export const STAGE_VERBS: VerbSpec[] = [stageDone, stageBegin, stageShow];
