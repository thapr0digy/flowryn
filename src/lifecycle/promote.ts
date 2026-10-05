import { existsSync } from "node:fs";
import { join } from "node:path";
import { FlowrynError } from "../api/errors.ts";
import { boolArg, stringArg, type HandlerCtx, type HandlerResult, type VerbSpec } from "../api/verbs.ts";
import { resolveRunItems } from "../attention/items.ts";
import { workflowFor, type WorkflowDef } from "../config/workflows.ts";
import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { deliveryLines } from "../harness/contract-text.ts";
import { HARNESS_IDS, type HarnessId } from "../harness/types.ts";
import { recordIntent } from "../journal/journal.ts";
import { readSnapshot } from "../journal/snapshot.ts";
import { releaseLeases } from "../sched/pools.ts";
import { sanitizeBlock } from "../util/sanitize.ts";
import { checkStart, createRun, startDepsOf } from "./dispatch.ts";
import { dispatchedTask, reportDirFor } from "./launcher.ts";
import { getProject, type ProjectRow } from "./projects.ts";
import { findRun, getRunWithPolicy, isTerminal, taskTitle, type RunWithPolicy } from "./runs.ts";
import { dismissGateQuestions } from "./gate-questions.ts";
import { discardPlansOfGate } from "./plans.ts";
import { flowLine, openGate, requestStage } from "./stages.ts";

/**
 * `flowryn promote <task>` (design sections 4 and 12): a scout promoted to a
 * ship in place, rather than a second task that names its report. The task
 * keeps its id, its backlog entry and its report; its policy becomes the
 * project's ship policy (delivery mode, yolo, workflow).
 *
 * - A scout still at work (its report not delivered) is promoted with its
 *   run: the same worker, worktree and branch. Its worker stops and its own
 *   session resumes (a relaunch), so the context it built survives while its
 *   contract, task file and sandbox settings become a ship's; the first stage
 *   of the ship workflow starts through the scheduler, and the task file
 *   carries your words and the ship's delivery.
 * - A scout whose run is over (its report landed and was cleaned, or it was
 *   cancelled or failed) is promoted as a task: it goes back In flight as a
 *   ship and a new run starts on it in a fresh worktree from the default
 *   branch, its task file naming the report.
 *
 * A scout whose report landed but whose worktree is not cleaned yet waits for
 * the cleanup (`flowryn cleanup`), since its worker is being stopped.
 */

type Promotion = { mode: "live"; runId: string } | { mode: "task"; taskId: string; harness: HarnessId; version: string; base: string };

function scoutRun(db: Db, target: string): RunWithPolicy {
  const found = findRun(db, target);
  const run = found ? getRunWithPolicy(db, found.id) : null;
  if (!run) throw new FlowrynError("not_found", `no task or run ${target}`, "flowryn fleet");
  if (run.kind !== "scout") throw new FlowrynError("bad_args", `${run.task_id} is a ${run.kind} already; only a scout is promoted`);
  return run;
}

function projectOf(db: Db, run: RunWithPolicy): ProjectRow {
  const project = getProject(db, run.project_id);
  if (!project) throw new FlowrynError("not_found", `project ${run.project_id} is gone`);
  return project;
}

function harnessArg(args: Record<string, unknown>, fallback: HarnessId): HarnessId {
  const harness = (stringArg(args as never, "harness") ?? fallback) as HarnessId;
  if (!(HARNESS_IDS as readonly string[]).includes(harness)) throw new FlowrynError("bad_args", "--harness must be claude or pi");
  return harness;
}

/** What the promoted worker is told: the task is a ship now, what that asks of its branch, and how it delivers. */
function promotionNote(project: ProjectRow, run: RunWithPolicy, workflow: WorkflowDef, words: string, reportPath: string | null): string {
  const last = workflow.stages[workflow.stages.length - 1]!;
  const delivery = deliveryLines({ kind: "ship", mode: project.delivery_mode, defaultBranch: project.default_branch, lastStage: { id: last.id, pools: last.pools } })
    .map((l) => l.replace(/^-\s*/, "").trim())
    .join(" ");
  return [
    `Your leader promoted this scout to a ship: task ${run.task_id} now ends in a delivery, not a report.`,
    words,
    reportPath ? `The scout's report is ${reportPath}.` : "",
    `Keep on branch ${run.branch} only the change the task needs: leave scratch files, debug output and scratch commits out, and turn a bug you reproduced into a regression test.`,
    `Your workflow is now ${workflow.id}: ${flowLine(workflow)}. ${delivery}`,
  ]
    .filter((part) => part.length > 0)
    .join(" ");
}

/** The ship policy the task takes on: the project's delivery mode and yolo posture, the chosen workflow. Call inside a transaction. */
function becomeShip(db: Db, taskId: string, project: ProjectRow, workflow: WorkflowDef, sensitive: boolean, now: number): void {
  db.query("UPDATE task_policy SET kind = 'ship', delivery_mode = ?2, yolo = ?3, workflow = ?4, sensitive = MAX(sensitive, ?5), reason = 'promoted from a scout' WHERE task_id = ?1").run(
    taskId,
    project.delivery_mode,
    project.yolo,
    workflow.id,
    sensitive ? 1 : 0,
  );
  recordIntent(db, { file: "backlog", verb: "update", taskId, positional: [taskId], flags: { kind: "ship" }, now });
}

function promoteLive(ctx: HandlerCtx, args: Record<string, unknown>, runId: string): HandlerResult {
  const { db } = ctx;
  const run = getRunWithPolicy(db, runId);
  if (!run || run.kind !== "scout" || isTerminal(run.state) || run.state === "landed") throw new FlowrynError("not_ready", `${runId} changed meanwhile`, "flowryn promote again");
  if (ctx.fleet.isLaunching(run.id)) throw new FlowrynError("not_ready", `${run.task_id}'s worker is still launching`, "flowryn promote again once it runs");
  const project = projectOf(db, run);
  const config = ctx.config();
  const workflow = workflowFor(config, stringArg(args as never, "workflow") ?? project.workflow, "ship");
  const now = ctx.now();
  const words = sanitizeBlock(stringArg(args as never, "body") ?? "").trim();
  becomeShip(db, run.task_id, project, workflow, boolArg(args as never, "sensitive"), now);
  db.query("UPDATE runs SET workflow = ?2, workflow_def = ?3, updated_at = ?4 WHERE id = ?1").run(run.id, workflow.id, JSON.stringify(workflow), now);
  releaseLeases(db, run.id, run.task_id, { keepWorker: true }, "promoted to a ship", now);
  // A review the scout's own workflow had open is moot: the ship's workflow starts over.
  const open = openGate(db, run.id, "review");
  if (open) {
    db.query("UPDATE gates SET state = 'changes', feedback = 'promoted to a ship', closed_at = ?2 WHERE id = ?1").run(open.id, now);
    discardPlansOfGate(db, open.id, now);
    dismissGateQuestions(db, run, open.id, now, "promoted", "cli");
    resolveRunItems(db, run.id, ["gate_ready", "review_feedback", "pass_requested"], "run.promoted", now);
  }
  // A worker that runs is stopped and its session resumed under the ship contract; one not launched yet starts as a ship.
  if (run.pending_launch !== "fresh" && run.pending_launch !== "resume") run.pending_launch = "relaunch";
  run.kind = "ship";
  requestStage(db, run, workflow, 0, promotionNote(project, run, workflow, words, null), now);
  resolveRunItems(db, run.id, ["worker_idle"], "run.promoted", now);
  appendEvent(db, { source: "cli", kind: "run.promoted", runId: run.id, taskId: run.task_id, payload: { from: "scout", workflow: workflow.id, mode: project.delivery_mode, in_place: "run", closed_gate: open?.id ?? null, by: ctx.caller.role }, ts: now });
  return {
    data: { task: run.task_id, run: run.id, kind: "ship", workflow: workflow.id, stage: workflow.stages[0]!.id, mode: project.delivery_mode, promoted: "in place: same worker, worktree and branch" },
    hints: [`flowryn show ${run.task_id}`],
  };
}

function promoteTask(ctx: HandlerCtx, args: Record<string, unknown>, p: Extract<Promotion, { mode: "task" }>): HandlerResult {
  const { db } = ctx;
  const last = scoutRun(db, p.taskId);
  if (!isTerminal(last.state)) throw new FlowrynError("not_ready", `${p.taskId} changed meanwhile`, "flowryn promote again");
  const project = projectOf(db, last);
  const config = ctx.config();
  const workflow = workflowFor(config, stringArg(args as never, "workflow") ?? project.workflow, "ship");
  const now = ctx.now();
  const words = sanitizeBlock(stringArg(args as never, "body") ?? "").trim();
  const report = join(reportDirFor(config, p.taskId), "report.md");
  const reportPath = existsSync(report) ? report : null;
  const scout = dispatchedTask(db, last.id);
  const title = taskTitle(db, p.taskId);
  becomeShip(db, p.taskId, project, workflow, boolArg(args as never, "sensitive"), now);
  // A parked scout (cancelled, failed) is held in the backlog; the hold goes with the promotion.
  if (readSnapshot(db, "backlog")?.tasks.find((t) => t.id === p.taskId)?.hold) recordIntent(db, { file: "backlog", verb: "unhold", taskId: p.taskId, positional: [p.taskId], now });
  const body = [
    promotionNote(project, { ...last, kind: "ship" }, workflow, words, reportPath),
    "",
    "The scout's task, as it was dispatched:",
    "",
    scout?.body ?? title,
  ].join("\n");
  const runId = createRun(db, config, { taskId: p.taskId, title, body, project, kind: "ship", harness: p.harness, version: p.version, base: p.base, workflow, sensitive: boolArg(args as never, "sensitive"), existing: true, by: ctx.caller.role, override: null, now });
  resolveRunItems(db, last.id, ["report_ready"], "run.promoted", now);
  appendEvent(db, { source: "cli", kind: "run.promoted", runId, taskId: p.taskId, payload: { from: "scout", scout_run: last.id, workflow: workflow.id, mode: project.delivery_mode, in_place: "task", report: reportPath, by: ctx.caller.role }, ts: now });
  return {
    data: { task: p.taskId, run: runId, kind: "ship", workflow: workflow.id, mode: project.delivery_mode, promoted: "in place: same task, a new run", report: reportPath ?? "-", state: "launching" },
    hints: [`flowryn show ${p.taskId}`],
  };
}

const promote: VerbSpec = {
  name: "promote",
  summary: "Promote a scout to a ship in place: the same task, and while it works, the same worker and worktree",
  positionals: [{ name: "task", required: true, help: "the scout's task or run id" }],
  flags: {
    "body-file": { type: "string", help: "what to ship, from a file or - for stdin", fileFor: "body" },
    workflow: { type: "string", help: "the ship workflow (default: the project's)", placeholder: "id" },
    harness: { type: "string", help: "a scout whose run is over: the new run's harness (default: the scout's)", placeholder: "harness" },
    sensitive: { type: "boolean", help: "security-relevant: merges need a human record even under yolo" },
  },
  kind: "mutation",
  roles: ["leader", "human"],
  async prepare(ctx, args): Promise<Promotion> {
    const run = scoutRun(ctx.db, stringArg(args, "task")!);
    const project = projectOf(ctx.db, run);
    workflowFor(ctx.config(), stringArg(args, "workflow") ?? project.workflow, "ship");
    if (run.state === "landed" || run.state === "ready") {
      throw new FlowrynError("not_ready", `${run.task_id}'s report landed and its worktree is being cleaned up; promote it once it is cleaned`, `flowryn show ${run.task_id}`);
    }
    if (!isTerminal(run.state)) {
      if (stringArg(args, "harness") && stringArg(args, "harness") !== run.harness) throw new FlowrynError("bad_args", `${run.task_id} is promoted with its worker, which runs on ${run.harness}`);
      return { mode: "live", runId: run.id };
    }
    // Over: a new run on the same task, checked as a dispatch is.
    if (existsSync(run.worktree_path)) {
      throw new FlowrynError("not_ready", `the scout's worktree ${run.worktree_path} is still there`, `flowryn cleanup ${run.task_id} (--discard needs your approval), then promote`);
    }
    const harness = harnessArg(args, run.harness);
    return { mode: "task", taskId: run.task_id, harness, ...(await checkStart(startDepsOf(ctx), project, harness)) };
  },
  apply(ctx, args, prepared) {
    const promotion = prepared as Promotion;
    return promotion.mode === "live" ? promoteLive(ctx, args, promotion.runId) : promoteTask(ctx, args, promotion);
  },
  async settle(ctx, result) {
    ctx.journal.kick();
    await ctx.sched.passNow();
    return result;
  },
};

export const PROMOTE_VERBS: VerbSpec[] = [promote];
