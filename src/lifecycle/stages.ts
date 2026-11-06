import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { FlowrynError } from "../api/errors.ts";
import { stringArg, type HandlerCtx, type ReadCtx, type VerbSpec } from "../api/verbs.ts";
import { openItem, resolveRunItems, settleAutonomyParked } from "../attention/items.ts";
import { resolveTool, type FlowrynConfig } from "../config/config.ts";
import { reviewConfig } from "../config/leader.ts";
import { capacityConfig, DEFAULT_WORKFLOWS, projectMaxWorkers, WORKER_POOL, type StageDef, type WorkflowDef } from "../config/workflows.ts";
import type { Db } from "../db/db.ts";
import { getMeta, setMeta, tx } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { deliveryLines, type ContractDelivery } from "../harness/contract-text.ts";
import { grantLeases, holdsLease, releaseLeases, runLeases, type ProjectLimit } from "../sched/pools.ts";
import { DESIGN_TEMPLATE_FILE, designPageProblems } from "../skills/design-template.ts";
import { QA_CHECKLIST, QA_CHECKLIST_MAX_BYTES, QA_PAGE_MAX_BYTES, QA_TEMPLATE_FILE, qaChecklistProblems, qaNothingVisible, qaPageProblems } from "../skills/qa-template.ts";
import { skillPath } from "../skills/stages.ts";
import { sanitizeBlock, sanitizeLine } from "../util/sanitize.ts";
import type { GateOpenState } from "../lavish/opener.ts";
import { parseGateQuestions } from "../lavish/questions.ts";
import { MOUNT_SNIPPET, pageMountsWidget } from "../lavish/widget.ts";
import { findPageForKey, lavishSessionKey, lavishUrlKey } from "../lavish/session-key.ts";
import { REFUSAL_HINT, refusalText, snapshotPathFor, snapshotUrl, takeSnapshot } from "../lavish/snapshot.ts";
import { checkReviewPage, dismissGateQuestions, gateAnswersNote, openGateQuestions } from "./gate-questions.ts";
import { reportDirFor, rewriteTaskFile } from "./launcher.ts";
import { approvePlan, discardPlansOfGate, fileWorkerPlan, parsePlan } from "./plans.ts";
import { getProject } from "./projects.ts";
import { getRunWithPolicy, isTerminal, taskTitle, type PendingLaunch, type RunRow, type RunWithPolicy } from "./runs.ts";
import { summarizeReview } from "./review-chat.ts";
import { createSteer } from "./steers.ts";
import { checkDraftPage, DRAFT_SKILL, draftPageDigest, type DraftFile } from "./draft.ts";
import { briefsConfig } from "../config/briefs.ts";
import { pinDesign, readDesignSpec, requireSpecLinked, specAsShown, type DesignSpec } from "./design-spec.ts";
import { checkHandoff, HANDOFF_REQUIRED_SKILL, handoffNote, recordHandoff, startedUnderRichBriefs } from "./handoffs.ts";

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

/**
 * What ends a stage with a review gate, said once here rather than in each
 * stage skill (the skills say how to build the page, never how the gate runs).
 */
export const REVIEW_GATE_TEXT = [
  "When it is ready for review: $FLOWRYN_BIN stage done --review <lavish url> --page <its .html file>, then end your turn; a steer brings the verdict.",
  "Keep the page's Flowryn widget mount (it shows the user's Approve button; stage done refuses a page without it).",
  "Flowryn listens on the page itself and opens it in the user's browser: do not hold a lavish-axi poll open; lavish-axi's status: opened is its session, not a browser tab, so never say the page is open in their browser.",
  "lavish-axi failing: run it once more, then report blocked with its output.",
  "While it waits, a steer may bring the user's words from the page: answer with $FLOWRYN_BIN review reply --body-file - (never lavish-axi poll or reply yourself), revise the page if asked, then end your turn.",
  "Only a question you cannot proceed without goes to the user: add --questions-file <json> (the flowryn-design skill has the shape); decide the rest yourself and record it.",
].join(" ");

/** An ungated stage goes straight on to the next one in the same turn (`stage begin`); only a stage that waits for its slots ends the turn. */
function beginNextText(next: StageDef, stage: StageDef): string {
  const handoff = stage.skill === HANDOFF_REQUIRED_SKILL ? " --handoff-file <your handoff>" : "";
  return `When it is done: $FLOWRYN_BIN stage begin ${next.id}${handoff} and go on at once with the steps its reply gives; end your turn only on stage_waiting (a steer then starts it).`;
}

/** The steer line that replaces the stage's whole text when the worker's stage has not changed: its task file already holds the steps. */
export function stagePointer(stage: string): string {
  return `Then: follow the stage ${stage} steps in $FLOWRYN_TASK_FILE.`;
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
  if (stage.gate === "review") {
    parts.push(REVIEW_GATE_TEXT);
    return parts.join(" ");
  }
  if (ctx.delivery.kind === "ship" && ctx.delivery.mode === "no-mistakes") parts.push(`Do not run the no-mistakes pipeline yet: it runs in stage ${def.stages[def.stages.length - 1]!.id}, once that stage has started.`);
  parts.push(beginNextText(def.stages[index + 1]!, stage));
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

/** The project's worker limit, `[projects.<id>] max_workers`, or null when it has none. */
export function projectLimit(config: FlowrynConfig, projectId: string): ProjectLimit | null {
  const max = projectMaxWorkers(config, projectId);
  return max === null ? null : { project: projectId, max };
}

/** The pools a run needs granted now: its stage's (while the stage waits), and a worker slot for a launch it has none for. */
export function neededPools(db: Db, run: RunRow, pos: StagePos): string[] {
  const needs = run.stage_state === "waiting" ? [...pos.stage.pools] : [];
  if (run.pending_launch && !holdsLease(db, run.id, WORKER_POOL)) needs.unshift(WORKER_POOL);
  return needs;
}

/** Was this stage requested again from itself (a send-back, review changes, a nudge)? Then the worker's task file already holds its steps. */
function stageUnchanged(db: Db, runId: string, stage: string): boolean {
  const row = db.query("SELECT payload FROM events WHERE run_id = ?1 AND kind = 'stage.requested' ORDER BY seq DESC LIMIT 1").get(runId) as { payload: string } | null;
  if (!row) return false;
  const payload = JSON.parse(row.payload) as { stage?: string; from?: string | null };
  return payload.stage === stage && payload.from === stage;
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
 * OverCapacity (taking nothing) when a pool filled meanwhile, or ProjectAtLimit
 * when the project's worker limit did. Call inside a
 * transaction.
 */
export function activateStage(db: Db, config: FlowrynConfig, run: RunWithPolicy, now: number, opts: { steer?: boolean } = {}): Activated {
  const pos = positionOf(db, run, run.kind);
  const caps = capacityConfig(config).pools;
  grantLeases(db, run.id, run.task_id, pos.stage.id, neededPools(db, run, pos), caps, now, projectLimit(config, run.project_id));
  const launch = run.pending_launch;
  const starting = run.stage_state === "waiting";
  // A fresh launch reads its stage from the task file, and a fresh stage worker or a relaunched one its note too: the launcher clears it.
  const noteInFile = launch === "fresh" || launch === "stage" || launch === "relaunch";
  let steer: string | null = null;
  // A live worker carries on: its task file now names this stage, so rereading it after a compaction finds the stage's steps.
  let taskFileError: string | undefined;
  if (starting && !noteInFile) {
    try {
      rewriteTaskFile(db, run, config, stageTextContext(db, config, run).delivery);
    } catch (error) {
      taskFileError = (error as Error).message;
    }
  }
  if (starting && opts.steer !== false && run.stage_note !== null && !noteInFile) {
    // The stage's whole text only on a stage change; a send-back to the same stage points at the task file, which holds it.
    const steps = stageUnchanged(db, run.id, pos.stage.id) ? stagePointer(pos.stage.id) : stageInstructions(pos, stageTextContext(db, config, run));
    const text = [run.stage_note, steps].filter((t) => t.length > 0).join(" ");
    steer = createSteer(db, run, text, now).id;
  }
  db.query(
    `UPDATE runs SET stage_state = CASE WHEN stage_state = 'waiting' THEN 'active' ELSE stage_state END,
       stage_started_at = CASE WHEN stage_state = 'waiting' THEN ?2 ELSE stage_started_at END,
       waiting_since = NULL, pending_launch = CASE WHEN ?3 IN ('stage','relaunch') THEN ?3 ELSE NULL END,
       stage_note = CASE WHEN ?4 = 1 THEN stage_note ELSE NULL END, updated_at = ?2 WHERE id = ?1`,
  ).run(run.id, now, launch ?? "", noteInFile ? 1 : 0);
  if (starting) appendEvent(db, { source: "daemon", kind: "stage.started", runId: run.id, taskId: run.task_id, payload: { stage: pos.stage.id, index: pos.index, pools: pos.stage.pools, steer, launch, ...(taskFileError ? { taskFileError } : {}) }, ts: now });
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
  /** The run that carried this review on after its own run ended for good (src/lifecycle/review-revival.ts). */
  replaced_by?: string | null;
  /** A draft review's page digest at `stage done` (src/lifecycle/draft.ts): it passes only while the page still shows that. */
  draft_page?: string | null;
  /** A design review's pinned build spec and page (src/lifecycle/design-spec.ts). */
  spec_path?: string | null;
  spec_text?: string | null;
  spec_digest?: string | null;
  page_digest?: string | null;
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
  settleAutonomyParked(db, run.id, `gate.passed ${gate.id}`, now);
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
  settleAutonomyParked(db, run.id, `gate.changes ${gate.id}`, now);
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
  const why = stage.pools.length > 0 ? `waits for a slot of ${stage.pools.join(" and ")}` : "has not started yet";
  return new FlowrynError("stage_waiting", `stage ${stage.id} ${why}`, `end your turn; a steer says when stage ${stage.id} has started; do not run the pipeline before`);
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
    `$FLOWRYN_BIN stage begin ${last.id}${pos.stage.skill === HANDOFF_REQUIRED_SKILL ? " --handoff-file <your handoff>" : ""}, then run the pipeline and deliver`,
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
function requestLater(ctx: HandlerCtx, run: RunWithPolicy, pos: StagePos, index: number, note: string, reason: "deliver" | "begin", handoff: { stage: string; text: string } | null = null): Requested {
  const stage = pos.def.stages[index]!;
  const now = ctx.now();
  releaseLeases(ctx.db, run.id, run.task_id, { keepWorker: true }, `stage ${pos.stage.id} done`, now);
  const handoffId = handoff !== null ? recordHandoff(ctx.db, run, handoff.stage, handoff.text, now) : null;
  appendEvent(ctx.db, { source: "cli", kind: "stage.done", runId: run.id, taskId: run.task_id, payload: { stage: pos.stage.id, via: ctx.via, for: reason, next: stage.id, ...(handoffId !== null ? { handoff: handoffId } : {}) }, ts: now });
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
export async function startPooledStages(ctx: HandlerCtx, runId: string, handoffText?: string): Promise<{ handoffKept: boolean }> {
  let handoff = handoffText;
  let handoffKept = false;
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
      return requestLater(ctx, run, pos, index, `Your delivery waited for stage ${stage.id}, which holds a slot of ${stage.pools.join(" and ")}; it has started now: deliver again.`, "deliver", deliveryHandoff(ctx, run, handoff));
    });
    if (!requested) return { handoffKept };
    handoffKept ||= handoff !== undefined;
    handoff = undefined;
    await grantRequested(ctx, runId, requested, () => stageWaiting(requested.stage));
  }
}

/**
 * The stage `stage begin` may start: the next one (an ungated stage goes
 * straight on) or the last one (a no-mistakes ship, before its pipeline), or
 * the current one once it has started or while it waits (a repeat call).
 */
function beginTarget(pos: StagePos, target: string): number {
  const lastIndex = pos.def.stages.length - 1;
  if (pos.stage.id === target) return pos.index;
  if (pos.def.stages[pos.index + 1]?.id === target) return pos.index + 1;
  if (pos.def.stages[lastIndex]!.id === target) return lastIndex;
  const next = pos.def.stages[pos.index + 1];
  const names = [...new Set([next?.id, pos.def.stages[lastIndex]!.id].filter((id): id is string => id !== undefined))].join(" or ");
  throw new FlowrynError("bad_args", `stage begin starts your next or last stage (${names}), not ${target}`, stageDoneHelp(pos));
}

/**
 * `stage begin <next or last stage>`: end an ungated stage and start the next
 * one in the same turn, or start the stage the delivery ends now, from an
 * earlier stage with no review gate and no pooled stage between (a
 * no-mistakes ship calls it before its pipeline). Already started: nothing to
 * do. Refused with stage_waiting while it waits for its slots.
 */
export async function beginLastStage(ctx: HandlerCtx, runId: string, target: string, handoffText?: string): Promise<{ handoffIgnored: boolean }> {
  const requested = tx(ctx.db, () => {
    const run = getRunWithPolicy(ctx.db, runId);
    if (!run || isTerminal(run.state)) throw new FlowrynError("run_not_active", `run ${runId} is ${run?.state ?? "gone"}`);
    if (run.state === "ready" || run.stage_state === "done") throw new FlowrynError("wrong_stage", "you delivered already");
    const pos = positionOf(ctx.db, run, run.kind);
    const targetIndex = beginTarget(pos, target);
    const begun = pos.def.stages[targetIndex]!;
    if (targetIndex === pos.index && run.stage_state !== "review") {
      if (run.stage_state === "waiting") throw beginWaiting(begun);
      // A repeat call once the stage has started: the handoff was kept when the earlier stage ended.
      if (handoffText !== undefined) checkHandoff(handoffText);
      return null;
    }
    if (run.stage_state === "waiting") throw new FlowrynError("wrong_stage", `stage ${pos.stage.id} has not started; it waits for capacity`, "end your turn; a steer says when it starts");
    if (run.stage_state === "review") throw new FlowrynError("wrong_stage", `the ${pos.stage.id} review gate is open`, "end your turn; a steer brings the verdict");
    const before = pos.def.stages.slice(pos.index, targetIndex);
    const gated = before.find((s) => s.gate === "review");
    if (gated) throw new FlowrynError("wrong_stage", `stage ${pos.stage.id} comes before the ${gated.id} review; you cannot begin ${begun.id} yet`, stageDoneHelp(pos));
    const pooled = before.slice(1).find((s) => s.pools.length > 0);
    if (pooled) throw new FlowrynError("wrong_stage", `stage ${pooled.id} comes first and holds a slot of ${pooled.pools.join(" and ")}`, stageDoneHelp(pos));
    const owed = handoffOwedBy(ctx, run, before);
    const handoff = takeHandoff(handoffText, owed, `$FLOWRYN_BIN stage begin ${begun.id} --handoff-file "$TMPDIR/handoff.md"`);
    const handoffStage = owed?.id ?? pos.stage.id;
    return requestLater(ctx, run, pos, targetIndex, `Stage ${begun.id} has started; go on from where you stopped.`, "begin", handoff !== null ? { stage: handoffStage, text: handoff } : null);
  });
  if (!requested) return { handoffIgnored: handoffText !== undefined };
  await grantRequested(ctx, runId, requested, () => beginWaiting(requested.stage));
  return { handoffIgnored: false };
}

/**
 * The handoff a delivery owes when it ends a build stage (local-only and
 * direct-PR deliver straight from build): checked like stage done's, kept
 * under that stage. Null when none is owed nor given, from the last stage
 * (a given one is checked, not kept), or once the stages are over (a redelivery).
 */
export function deliveryHandoff(ctx: { db: Db; config: () => FlowrynConfig }, run: RunWithPolicy, text: string | undefined): { stage: string; text: string } | null {
  if (run.state === "ready" || run.stage_state === "done") return null;
  const pos = positionOf(ctx.db, run, run.kind);
  // From the last stage, the stage before it has ended already and kept its handoff then.
  if (pos.last) {
    if (text !== undefined) checkHandoff(text);
    return null;
  }
  const owed = handoffOwedBy(ctx, run, pos.def.stages.slice(pos.index));
  const command = run.delivery_mode === "local-only" ? "$FLOWRYN_BIN deliver --local" : "$FLOWRYN_BIN deliver --pr <url>";
  const handoff = takeHandoff(text, owed, `${command} --handoff-file "$TMPDIR/handoff.md"`);
  return handoff !== null ? { stage: owed?.id ?? pos.stage.id, text: handoff } : null;
}

/**
 * The stage among those a call ends or skips whose handoff is owed (the last
 * build stage), or null: none is, [briefs] enforce is off, or the run started
 * before the rich-briefs migration and finishes as it began.
 */
function handoffOwedBy(ctx: { db: Db; config: () => FlowrynConfig }, run: RunWithPolicy, ending: readonly StageDef[]): StageDef | null {
  if (!briefsConfig(ctx.config()).enforce || !startedUnderRichBriefs(ctx.db, run.started_at)) return null;
  return ending.findLast((s) => s.skill === HANDOFF_REQUIRED_SKILL) ?? null;
}

/** The handoff a call carries, cleaned and checked; refused when one is owed and missing. One rule for stage done and stage begin. */
function takeHandoff(text: string | undefined, owed: StageDef | null, command: string): string | null {
  if (text === undefined && owed !== null) {
    throw new FlowrynError("handoff_invalid", `stage ${owed.id} ends with a handoff to the next stage: what you did, deviations from the spec and why, open risks`, `$FLOWRYN_BIN template handoff > "$TMPDIR/handoff.md", fill it, then ${command}`);
  }
  return text !== undefined ? checkHandoff(text) : null;
}

function stageDoneHelp(pos: StagePos): string {
  return pos.stage.gate === "review" ? "$FLOWRYN_BIN stage done --review <lavish url> --page <its .html file>" : "$FLOWRYN_BIN stage done";
}

/** The delivery ended the last stage: its pools go back and a ship's merge gate opens. Call inside a transaction. */
export function recordStageDelivered(db: Db, run: RunWithPolicy, skipped: string[], now: number, handoff: { stage: string; text: string } | null = null): void {
  const def = runWorkflow(db, run, run.kind);
  const last = def.stages[def.stages.length - 1]!;
  releaseLeases(db, run.id, run.task_id, { keepWorker: true }, `stage ${last.id} delivered`, now);
  const handoffId = handoff !== null ? recordHandoff(db, run, handoff.stage, handoff.text, now) : null;
  db.query("UPDATE runs SET stage = ?2, stage_state = 'done', waiting_since = NULL, stage_note = NULL, updated_at = ?3 WHERE id = ?1").run(run.id, last.id, now);
  appendEvent(db, { source: "cli", kind: "stage.delivered", runId: run.id, taskId: run.task_id, payload: { stage: last.id, finished_at_delivery: skipped, ...(handoffId !== null ? { handoff: handoffId } : {}) }, ts: now });
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
 * as the skill says; a symlink there is refused rather than followed. Unless
 * the card says "Nothing visible.", the checklist the page was checked
 * against must sit beside it (`qa/checklist.md`), with at least one item.
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
  const html = readFileSync(path, "utf8");
  const problems = qaPageProblems(html);
  if (problems.length > 0) throw new FlowrynError("qa_page_invalid", `${path}: ${problems.join("; ")}`, "fix the page, host it again, then run stage done");
  let page: string;
  try {
    page = checkReviewPage(path, reportDir, { widget: false });
  } catch (error) {
    if (error instanceof FlowrynError) throw new FlowrynError("qa_page_invalid", error.message, error.help);
    throw error;
  }
  if (!qaNothingVisible(html)) checkQaChecklist(reportDir);
  return page;
}

/** The QA checklist: a regular file inside the report dir (a symlink is refused), at most 256 KB, with at least one item. */
function checkQaChecklist(reportDir: string): void {
  const path = join(reportDir, QA_CHECKLIST);
  const hint = `step 0 of the flowryn-visual-qa skill: write ${path} from DESIGN.md, the design page and its mockups, one numbered item per expectation ending "(source: …)"; a change with nothing to see says "Nothing visible." in the card instead`;
  let st;
  try {
    st = lstatSync(path);
  } catch {
    throw new FlowrynError("qa_page_invalid", `no QA checklist at ${path}`, hint);
  }
  if (!st.isFile()) throw new FlowrynError("qa_page_invalid", `${path} is not a regular file`, hint);
  if (st.size > QA_CHECKLIST_MAX_BYTES) throw new FlowrynError("qa_page_invalid", `${path} is over ${QA_CHECKLIST_MAX_BYTES / 1024} KB`, hint);
  const rel = relative(realpathSync(reportDir), realpathSync(path));
  if (rel.startsWith("..") || isAbsolute(rel)) throw new FlowrynError("qa_page_invalid", `${path} resolves outside $FLOWRYN_REPORT_DIR`, hint);
  const problems = qaChecklistProblems(readFileSync(path, "utf8"));
  if (problems.length > 0) throw new FlowrynError("qa_page_invalid", problems.join("; "), hint);
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
/** What stage done read before its transaction: the draft checked, and the HEAD the review opens at. */
interface StageDonePrepared {
  draft: DraftFile | null;
  head: string;
}

const stageDone: VerbSpec = {
  name: "stage done",
  summary: "Finish your current stage: --review <lavish url> for a stage with a review gate; then end your turn",
  positionals: [],
  flags: {
    review: { type: "string", help: "the Lavish page to review (a review gate stage)", placeholder: "url" },
    "plan-file": { type: "string", help: "a phase plan for the later phases, approved with the design", fileFor: "plan" },
    page: { type: "string", help: "the review page's .html file: Flowryn listens on it for the user's feedback, and it mounts the question widget with --questions-file", placeholder: "path" },
    "questions-file": { type: "string", help: "what only the user can answer, as JSON (with --page); each becomes a decision reserved for them", fileFor: "questions" },
    "handoff-file": { type: "string", help: "your handoff to the next stage (## Done, ## Deviations, ## Risks; $FLOWRYN_BIN template handoff); required after build", fileFor: "handoff" },
  },
  kind: "mutation",
  roles: ["worker"],
  spool: true,
  // A review gate records the HEAD it opened at (a one-click pass is bound to it), and a draft
  // stage's page must be its file rendered as the worktree holds it now; both ask git.
  async prepare(ctx, args) {
    const run = workerRun(ctx);
    const pos = positionOf(ctx.db, run, run.kind);
    if (pos.stage.gate !== "review" || run.stage_state !== "active") return null;
    // As src/policy/gates.ts reviewedHead reads it ("none" before the first commit).
    const read = await ctx.delivery.git(["rev-parse", "HEAD"], run.worktree_path);
    const head = read.code === 0 ? read.stdout.trim() : "none";
    if (pos.stage.skill !== DRAFT_SKILL) return { draft: null, head } satisfies StageDonePrepared;
    const page = stringArg(args, "page");
    if (page === undefined) throw new FlowrynError("draft_page_invalid", "a draft stage's review needs --page: the page $FLOWRYN_BIN draft render wrote", "$FLOWRYN_BIN draft render <file>");
    const reportDir = reportDirFor(ctx.config(), run.task_id);
    const draft = await checkDraftPage(ctx.delivery.git, run.worktree_path, checkReviewPage(page, reportDir, { widget: false }), reportDir);
    return { draft, head } satisfies StageDonePrepared;
  },
  apply(ctx, args, prepared) {
    const run = workerRun(ctx);
    const pos = positionOf(ctx.db, run, run.kind);
    const now = ctx.now();
    const { draft, head: reviewHead } = (prepared as StageDonePrepared | null) ?? { draft: null, head: null };
    if (run.stage_state === "waiting") throw new FlowrynError("wrong_stage", `stage ${pos.stage.id} has not started yet; it waits for capacity`, "end your turn; a steer says when it starts");
    if (run.stage_state === "review") throw new FlowrynError("wrong_stage", `stage ${pos.stage.id} is already waiting for its review`, "end your turn; a steer brings the verdict");
    if (run.stage_state === "done") throw new FlowrynError("wrong_stage", "you delivered already");
    if (pos.last) throw new FlowrynError("wrong_stage", `${pos.stage.id} is the last stage; it ends with your delivery`, run.kind === "scout" ? "$FLOWRYN_BIN deliver --report <path>" : "$FLOWRYN_BIN deliver");
    if (pos.stage.skill === DRAFT_SKILL && pos.stage.gate === "review" && !draft) throw new FlowrynError("wrong_stage", "your stage changed while its draft was checked", "run stage done again");
    const review = stringArg(args, "review");
    const planText = stringArg(args, "plan");
    const page = stringArg(args, "page");
    const questionsText = stringArg(args, "questions");
    const enforce = briefsConfig(ctx.config()).enforce && startedUnderRichBriefs(ctx.db, run.started_at);
    const handoff = takeHandoff(stringArg(args, "handoff"), handoffOwedBy(ctx, run, [pos.stage]), '$FLOWRYN_BIN stage done --handoff-file "$TMPDIR/handoff.md"');
    if (questionsText !== undefined && page === undefined) throw new FlowrynError("bad_args", "--questions-file needs --page: the questions go on that page");
    if (questionsText !== undefined && pos.stage.gate !== "review") throw new FlowrynError("bad_args", `questions ride with a review gate; stage ${pos.stage.id} has none: decide them yourself and record your choices`);
    if (page !== undefined && pos.stage.gate !== "review") throw new FlowrynError("bad_args", `--page rides with a review gate; stage ${pos.stage.id} has none`);
    const questions = questionsText !== undefined ? parseGateQuestions(questionsText) : null;
    const reportDir = reportDirFor(ctx.config(), run.task_id);
    // Every review page mounts the widget: its Approve button, and its questions when it has any.
    const pagePath = page !== undefined ? checkReviewPage(page, reportDir, { widget: true }) : null;
    const title = taskTitle(ctx.db, run.task_id);
    let gateReview: string | null = null;
    let listened: string | null = null;
    let source: string | null = null;
    let spec: DesignSpec | null = null;
    if (pos.stage.gate === "review") {
      if (!review) throw new FlowrynError("bad_args", `stage ${pos.stage.id} has a review gate: pass --review <lavish url>`);
      const qaPage = pos.stage.skill === QA_SKILL ? checkQaPage(reportDir) : null;
      if (qaPage !== null && pagePath !== null && pagePath !== qaPage) throw new FlowrynError("bad_args", `the QA review page is ${qaPage}; --page names another`);
      const lavish = resolveTool(ctx.config(), "lavish_axi");
      const checked = checkReviewUrl(review, { page: qaPage ?? pagePath, reportDir, lavishInstalled: lavish !== null && existsSync(lavish) });
      if (pos.stage.skill === DESIGN_SKILL) {
        checkDesignPage(checked.page, { widget: true });
        spec = readDesignSpec(reportDir, { required: enforce });
        if (spec) requireSpecLinked(checked.page, spec);
      }
      // Every Lavish review page carries the widget, its Approve button (one click, src/policy/pass-key.ts).
      if (lavishUrlKey(checked.url) && !pageMountsWidget(readFileSync(checked.page, "utf8"))) throw new FlowrynError("bad_args", "the review page does not mount Flowryn's widget (its Approve button, and any questions)", `add ${MOUNT_SNIPPET}`);
      gateReview = checked.url;
      listened = checked.page;
      // The user reviews the daemon's checked copy of a Lavish page, never the worker's file (src/lavish/snapshot.ts).
      if (lavishUrlKey(checked.url)) {
        const taken = takeSnapshot(checked.page, snapshotPathFor(ctx.config().state_dir, run.id, reportDir, checked.page));
        if (!taken.ok) throw new FlowrynError("review_invalid", `${checked.page}: ${refusalText(taken.problems)}`, `${REFUSAL_HINT}; fix the page, then run stage done again`);
        source = checked.page;
        listened = taken.page;
        gateReview = snapshotUrl(checked.url, taken.page);
      }
      if (spec) {
        const shown = specAsShown(spec, { page_path: listened, source_page: source });
        if (!shown) throw new FlowrynError("spec_invalid", "the review page's copy does not carry the build spec the page links", "keep the spec in the design page's folder, at most 3 folders down, then run stage done again");
        spec = shown;
      }
    }
    releaseLeases(ctx.db, run.id, run.task_id, { keepWorker: true }, `stage ${pos.stage.id} done`, now);
    if (gateReview !== null) {
      const gateId = nextGateId(ctx.db);
      // The daemon opens the page in your browser once its poll listens (src/lavish/opener.ts), unless [review] turns that off.
      const browser = reviewConfig(ctx.config()).open_browser ? { state: "pending", detail: null } : { state: "off", detail: "[review] open_browser = false" };
      ctx.db
        .query("INSERT INTO gates (id, run_id, stage, kind, review_url, state, opened_at, open_state, open_detail, pass_head) VALUES (?1, ?2, ?3, 'review', ?4, 'open', ?5, ?6, ?7, ?8)")
        .run(gateId, run.id, pos.stage.id, gateReview, now, browser.state, browser.detail, reviewHead);
      ctx.db.query("UPDATE runs SET stage_state = 'review', updated_at = ?2 WHERE id = ?1").run(run.id, now);
      // The daemon listens on the page itself (src/lavish/poller.ts): the one the review URL names.
      if (listened) ctx.db.query("UPDATE gates SET page_path = ?2, source_page = ?3 WHERE id = ?1").run(gateId, listened, source);
      // A design review approves its page and build spec together, pinned by digest; later stages read the gate's copy.
      if (spec && listened) pinDesign(ctx.db, gateId, listened, spec);
      const handoffId = handoff !== null ? recordHandoff(ctx.db, run, pos.stage.id, handoff, now) : null;
      // A draft review approves this file's exact bytes: the delivery must carry them (src/lifecycle/draft.ts).
      if (draft) ctx.db.query("UPDATE gates SET draft_path = ?2, draft_blob = ?3, draft_page = ?4 WHERE id = ?1").run(gateId, draft.path, draft.blob, draftPageDigest(draft));
      const asked = questions && pagePath ? openGateQuestions(ctx.db, run, { id: gateId, stage: pos.stage.id, review_url: gateReview }, listened ?? pagePath, questions, now) : [];
      let plan: string | null = null;
      if (planText !== undefined) {
        const project = getProject(ctx.db, run.project_id);
        if (!project) throw new FlowrynError("not_found", `project ${run.project_id} is gone`);
        plan = fileWorkerPlan(ctx.db, ctx.config(), { project, sourceTask: run.task_id, gateId, phases: parsePlan(planText), workflow: project.workflow, now });
      }
      const event = appendEvent(ctx.db, { source: "cli", kind: "stage.done", runId: run.id, taskId: run.task_id, payload: { stage: pos.stage.id, gate: gateId, review: gateReview, plan, questions: asked, via: ctx.via, ...(draft ? { draft: draft.path, blob: draft.blob } : {}), ...(spec ? { spec_digest: spec.digest } : {}), ...(handoffId !== null ? { handoff: handoffId } : {}) }, ts: now });
      appendEvent(ctx.db, { source: "cli", kind: "gate.opened", runId: run.id, taskId: run.task_id, payload: { gate: gateId, stage: pos.stage.id, kind: "review", review: gateReview, browser: browser.state }, ts: now });
      resolveRunItems(ctx.db, run.id, ["worker_idle"], "stage.done", now);
      const asking = asked.length > 0 ? ` with ${asked.length} question${asked.length === 1 ? "" : "s"} for you (${asked.join(", ")})` : "";
      openItem(ctx.db, { kind: "gate_ready", eventSeq: event.seq, taskId: run.task_id, runId: run.id, line: `${pos.stage.id} ready for review (${gateId})${asking}: ${title} (${run.project_id}) ${sanitizeLine(gateReview, 120)}`, now });
      const hints = ["end your turn; a steer brings the verdict and the user's answers"];
      return { data: { stage: pos.stage.id, gate: gateId, state: "review", plan: plan ?? "-", questions: asked }, hints };
    }
    if (planText !== undefined) throw new FlowrynError("bad_args", "a plan rides with a review gate (approving the design approves the plan); this stage has none");
    if (review) throw new FlowrynError("bad_args", `stage ${pos.stage.id} has no review gate; drop --review`);
    const handoffId = handoff !== null ? recordHandoff(ctx.db, run, pos.stage.id, handoff, now) : null;
    appendEvent(ctx.db, { source: "cli", kind: "stage.done", runId: run.id, taskId: run.task_id, payload: { stage: pos.stage.id, via: ctx.via, ...(handoffId !== null ? { handoff: handoffId } : {}) }, ts: now });
    requestStage(ctx.db, run, pos.def, pos.index + 1, handoffNote(pos.stage.id, handoff), now);
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
 * `flowryn stage begin <stage>`: end an ungated stage and start the next one
 * in the same turn, or start your last stage now, before the work that must
 * run under its slots (a no-mistakes ship's pipeline). It returns once the
 * stage has started, with that stage's steps, or stage_waiting: end your
 * turn, and a steer says when it has.
 */
const stageBegin: VerbSpec = {
  name: "stage begin",
  summary: "End this stage and start the next (or your last) now, then go on with its steps; stage_waiting means end your turn",
  positionals: [{ name: "stage", required: true, help: "your workflow's next stage, or its last (ship)", complete: "stage" }],
  flags: {
    "handoff-file": { type: "string", help: "your handoff from the stage this skips (## Done, ## Deviations, ## Risks; $FLOWRYN_BIN template handoff); required when it skips build", fileFor: "handoff" },
  },
  kind: "mutation",
  roles: ["worker"],
  replyMs: 30_000,
  async prepare(ctx, args) {
    return beginLastStage(ctx, workerRun(ctx).id, stringArg(args, "stage")!, stringArg(args, "handoff"));
  },
  apply(ctx, _args, prepared) {
    const run = workerRun(ctx);
    const ignored = (prepared as { handoffIgnored: boolean } | null)?.handoffIgnored === true;
    const hints = ignored ? [`stage ${run.stage} had started already, so this handoff was not kept; a handoff is kept when the stage before ends`, "go on"] : ["go on at once with the steps below: the stage has started"];
    const steps = stageInstructions(positionOf(ctx.db, run, run.kind), stageTextContext(ctx.db, ctx.config(), run));
    return { data: { stage: run.stage, state: run.stage_state, pools: runLeases(ctx.db, run.id).map((l) => l.pool), steps }, hints };
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
