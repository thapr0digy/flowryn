import { FlowrynError } from "../api/errors.ts";
import { askLines, askView } from "../ask/view.ts";
import { ASK_ID, getAsk } from "../ask/store.ts";
import { latestVerification, verificationLine } from "../verify/store.ts";
import { autoMergeLine, latestAutoMerge } from "../verify/auto-merge.ts";
import { awayLine, getAway } from "../attention/away.ts";
import { boolArg, stringArg, type HandlerResult, type ReadCtx, type VerbSpec } from "../api/verbs.ts";
import { resolveRunItems } from "../attention/items.ts";
import { explanationDetail, openExplanations, taskExplanations, timelineEntry, waitingField, waitingPointer, waitingRuns } from "../attention/explanations.ts";
import { appendEvent } from "../db/events.ts";
import { recordIntent } from "../journal/journal.ts";
import { MAX_LINE_CHARS, sanitizeBlock, sanitizeLine } from "../util/sanitize.ts";
import { answerDecision, captainChannel, decisionView } from "./decision-verbs.ts";
import { getGrant, grantLines, grantView } from "../policy/grants.ts";
import { getSession, isHolder, UNCONFIRMED_SCOPE } from "../lease/lease.ts";
import { wakeLineFor } from "../leader/wake-state.ts";
import { lensFor } from "../leader/scope.ts";
import { pinHistory } from "../lease/repin.ts";
import { getDecision } from "./decisions.ts";
import { findRun, isTerminal, modelView, taskTitle, type RunRow } from "./runs.ts";
import { createSteer, recentSteers, steerBrief, steerStatus } from "./steers.ts";
import { openActionable } from "../attention/router.ts";
import { leaderTiming } from "../config/leader.ts";
import { approvalRef, deliveredOf, prEvidence } from "./delivery.ts";
import { capacityConfig, WORKER_POOL } from "../config/workflows.ts";
import { holdsLease, liveCounts, runLeases } from "../sched/pools.ts";
import { phaseOfTask } from "./plans.ts";
import { dropRecord } from "./drop.ts";
import { watchById, watchLabel, watchOfTask, type WatchRow } from "./watches.ts";
import { planView, storedBase } from "./dispatch.ts";
import { flowLine, gatesOf, runWorkflow, type GateRow } from "./stages.ts";
import { gateHarness, harnessRefusal } from "./harness-gate.ts";
import { divergenceView, getDivergence, resolveCommand } from "../reconcile/divergence.ts";
import { latestMerge } from "../policy/merge.ts";
import { queuedAge, queuedTask, queuedWork, waitsCell, type QueuedTask } from "./queue-view.ts";
import { ShowText } from "./show-text.ts";
import { LANDED_BEFORE_CANCEL } from "./landing.ts";
import { getOperation, heldByEscalation, latestOperation, launchKind, openOperation, operationLine, requestCancel, requestOperation } from "./operations.ts";
import { channelView } from "../lavish/channel.ts";
import { closeReadItems, type ReportRead } from "../attention/read-close.ts";
import { readFileSync, statSync } from "node:fs";
import type { Db } from "../db/db.ts";

function activeRunFor(db: ReadCtx["db"], ref: string): RunRow {
  const run = findRun(db, ref);
  if (!run) throw new FlowrynError("not_found", `no run or task ${ref}`, "flowryn fleet");
  if (isTerminal(run.state)) throw new FlowrynError("run_not_active", `the run for ${run.task_id} is ${run.state}`);
  return run;
}

/**
 * `flowryn steer <task|run> [--urgent] --body-file -`: words for a worker.
 * Delivered by its hooks or extension, mid-turn or on the next idle wake, and
 * re-rung until the worker acknowledges it (design section 6). An urgent one
 * also blocks the worker's next tool call and cuts a tool that has run past
 * steer_preempt_after_ms (never while a dialog may be open): the cut tool's
 * work is lost, so keep it for "stop doing that now". With --end-turn the
 * steer tells the worker to end its turn (to wait, or because it only
 * informs): the turn-end guard sends no reminder for that turn end.
 */
const steer: VerbSpec = {
  name: "steer",
  summary: "Send a worker a steer; it is delivered at its next tool call or idle wake (--urgent: sooner, may cut a running tool)",
  positionals: [{ name: "target", required: true, help: "task or run id", complete: "task" }],
  flags: {
    "body-file": { type: "string", help: "the steer, from a file or - for stdin", fileFor: "body" },
    urgent: { type: "boolean", help: "block the worker's next tool call with it, and cut a tool running over 3s (its work is lost)" },
    "end-turn": { type: "boolean", help: "the steer tells the worker to end its turn (wait, or just informs): no turn-end reminder follows" },
  },
  kind: "mutation",
  roles: ["leader", "human"],
  scope: { kind: "ref", arg: "target" },
  apply(ctx, args) {
    const run = activeRunFor(ctx.db, stringArg(args, "target")!);
    const body = sanitizeBlock(stringArg(args, "body") ?? "").trim();
    if (body.length === 0) throw new FlowrynError("bad_args", "the steer goes in --body-file -");
    const urgent = boolArg(args, "urgent");
    const endTurn = boolArg(args, "end-turn");
    const message = createSteer(ctx.db, run, body, ctx.now(), null, urgent, endTurn);
    return { data: { steer: message.id, run: run.id, task: run.task_id, liveness: run.liveness, urgent, ...(endTurn ? { end_turn: true } : {}) }, hints: [`flowryn show ${run.task_id}`] };
  },
  async settle(ctx, result) {
    const runId = String(result.data.run);
    ctx.fleet.bus.notify(runId);
    if (result.data.urgent === true) ctx.fleet.urgent.kick(runId);
    return result;
  },
};

/** `flowryn answer <decision> <choice>`: the answer reaches the worker as a steer. */
const answer: VerbSpec = {
  name: "answer",
  summary: "Answer a worker's question; the answer reaches it as a steer",
  positionals: [
    { name: "decision", required: true, help: "decision id, such as q3", complete: "decision" },
    { name: "choice", required: true, help: "one of the question's options" },
  ],
  flags: { "body-file": { type: "string", help: "anything to add, from a file or - for stdin", fileFor: "body" } },
  kind: "mutation",
  roles: ["leader", "human"],
  scope: { kind: "ref", arg: "decision" },
  apply(ctx, args) {
    const id = stringArg(args, "decision")!;
    const choice = stringArg(args, "choice")!;
    const d = getDecision(ctx.db, id);
    if (!d) throw new FlowrynError("not_found", `no decision ${id}`, "flowryn fleet");
    if (d.state !== "open") throw new FlowrynError("bad_args", `decision ${id} is already ${d.state}`);
    const options = JSON.parse(d.options) as string[];
    if (options.length > 0 && !options.includes(choice)) throw new FlowrynError("bad_args", `choice must be one of: ${options.join(", ")}`);
    const note = sanitizeBlock(stringArg(args, "body") ?? "").trim() || null;
    const human = ctx.caller.role === "human";
    // answer stays a plain alias for a run-scoped question; a standalone decision carries no run to
    // steer, and the leader's rationale rule (decide --rationale) must not be skippable through it.
    if (!human && d.run_id === null) throw new FlowrynError("bad_args", `a standalone decision needs: flowryn decide ${id} ${choice} --rationale <why>`, `flowryn decide ${id} ${choice} --rationale <why>`);
    if (!human && d.reserved_reason) throw new FlowrynError("reserved_decision", `${id} is reserved for the user (${d.reserved_reason})`, `ask the user, then: flowryn decide ${id} <choice> --by captain --body-file -`);
    const done = answerDecision(ctx, d, { choice, words: note, by: human ? "captain" : "leader", via: human ? captainChannel(ctx, d, id, args) : "leader" });
    return { data: { decision: id, answer: choice, steer: done.steer ?? "-", run: done.run ?? "-" } };
  },
  async settle(ctx, result) {
    if (result.data.run !== "-") ctx.fleet.bus.notify(String(result.data.run));
    return result;
  },
};

/**
 * `flowryn cancel <task|run>`: stop the worker (verified exit) and return the
 * task to Queued with a parked hold. The worktree stays; removing it is the
 * cleanup guard's job (M4). The intent is committed first, as a cancel
 * operation, and the stop follows it, so a daemon that dies between them
 * finishes the cancel on its restart and never resumes the worker
 * (docs/notes/2026-10-13-next-steps-md-rz.md).
 */
const cancel: VerbSpec = {
  name: "cancel",
  summary: "Stop a worker and park its task (the worktree is kept)",
  positionals: [{ name: "target", required: true, help: "task or run id", complete: "task" }],
  flags: { reason: { type: "string", help: "one line, for the backlog hold", placeholder: "text" } },
  kind: "mutation",
  roles: ["leader", "human"],
  scope: { kind: "ref", arg: "target" },
  apply(ctx, args) {
    const run = activeRunFor(ctx.db, stringArg(args, "target")!);
    if (run.state === "landed") throw new FlowrynError("run_not_active", `${run.task_id} landed: its merge is proven and stands; nothing was cancelled`, `flowryn cleanup ${run.task_id}`);
    const reason = stringArg(args, "reason") ?? `by ${ctx.caller.role}`;
    const op = requestCancel(ctx.db, run, { id: ctx.ulid, by: ctx.caller.role, reason, source: "cli", now: ctx.now() });
    return { data: { run: run.id, task: run.task_id, operation: op.id } };
  },
  // Also a replay's settlement: it drives the recorded operation by its phase, so a stored cancel finishes and is never stopped twice.
  async settle(ctx, result) {
    // A reply stored before operations existed: its apply already cancelled the run.
    if (typeof result.data.operation !== "string") return result;
    const outcome = await ctx.fleet.driveCancel(result.data.operation);
    if (!outcome.ok && outcome.detail?.startsWith(LANDED_BEFORE_CANCEL)) {
      throw new FlowrynError("run_not_active", `${String(result.data.task)}: ${outcome.detail}; nothing was cancelled`, `flowryn show ${String(result.data.task)}`);
    }
    if (!outcome.ok) throw new FlowrynError("internal", `the worker for ${String(result.data.task)} did not exit (${outcome.detail ?? outcome.evidence}); nothing was cancelled`);
    return { data: { ...result.data, state: "cancelled", exited: outcome.evidence } };
  },
};

/** A resume the grant has not started yet, with the reason its open wait explanation gives. */
function waitingReply(db: Db, result: HandlerResult): HandlerResult {
  const why = db
    .query("SELECT rule, reason FROM explanations WHERE run_id = ?1 AND kind IN ('capacity','resume') AND closed_at IS NULL ORDER BY id DESC LIMIT 1")
    .get(String(result.data.run)) as { rule: string; reason: string } | null;
  const state = why ? `waiting: ${why.reason}` : "waiting for its grant";
  const hints = why?.rule.startsWith("capacity.") ? ["flowryn capacity"] : [`flowryn show ${String(result.data.task)}`];
  return { data: { ...result.data, state, ...(why ? { rule: why.rule } : {}) }, hints };
}

/** A run whose dead worker can be resumed from its stored session. */
function resumable(db: ReadCtx["db"], target: string): RunRow {
  const run = findRun(db, target);
  if (!run) throw new FlowrynError("not_found", `no run or task ${target}`);
  if (run.state === "cancelled" || run.state === "cleaned") throw new FlowrynError("run_not_active", `the run for ${run.task_id} is ${run.state}`);
  if (run.cleanup === "done") throw new FlowrynError("run_not_active", `the run for ${run.task_id} is cleaned up: its worktree is gone`, `dispatch ${run.task_id} again`);
  // An escalated launch or resume is yours to settle: after looking at its pane, `flowryn resume` is one way out (cancel the other).
  const held = heldByEscalation(db, run.id);
  const escalatedStart = held !== null && held.kind !== "cancel";
  if (!escalatedStart && run.liveness !== "dead" && run.liveness !== "orphaned") throw new FlowrynError("bad_args", `the worker is ${run.liveness}, not dead`);
  if (!run.agent_session) throw new FlowrynError("bad_args", "the run has no stored session to resume");
  const open = openOperation(db, run.id);
  if (open?.kind === "cancel") throw new FlowrynError("run_not_active", `the run for ${run.task_id} is being cancelled (${open.id})`, `flowryn show ${run.task_id}`);
  if (open && open.phase !== "requested") throw new FlowrynError("bad_args", `a ${open.kind} of ${run.task_id} is already under way (${open.id})`, `flowryn show ${run.task_id}`);
  // A requested launch of another mode (a fresh stage worker waiting for its grant) starts the run when granted: no resume beside it.
  if (open && open.kind !== "resume") throw new FlowrynError("bad_args", `a ${open.mode ?? open.kind} launch of ${run.task_id} is already requested (${open.id}); it starts when granted`, "flowryn capacity");
  return run;
}

/**
 * `flowryn resume <task|run>`: start a dead worker again from its stored
 * session, in the same worktree. The reconciler does this once by itself;
 * after a second death it is yours to call (design section 6). A harness
 * version with no passing contract refuses it (section 5).
 */
const resume: VerbSpec = {
  name: "resume",
  summary: "Resume a dead worker from its stored session, in the same worktree",
  positionals: [{ name: "target", required: true, help: "task or run id", complete: "task" }],
  flags: {},
  kind: "mutation",
  roles: ["leader", "human"],
  scope: { kind: "ref", arg: "target" },
  async prepare(ctx, args) {
    const run = resumable(ctx.db, stringArg(args, "target")!);
    // Design section 5: the installed version is checked before a resume, as at dispatch.
    const check = await gateHarness(ctx.db, ctx.config(), run.harness, ctx.fleet.harnessVersion, "cli", "resume", ctx.now);
    if (check.state !== "verified") throw harnessRefusal(check, ctx.db, ctx.config());
    return null;
  },
  apply(ctx, args) {
    const run = resumable(ctx.db, stringArg(args, "target")!);
    const now = ctx.now();
    const open = openOperation(ctx.db, run.id);
    const held = heldByEscalation(ctx.db, run.id);
    const replacement = held && held.kind !== "cancel" && run.pending_launch && run.pending_launch !== "resume" ? run.pending_launch : null;
    const mode = replacement ?? "resume";
    // A resume already asked for (the automatic one waiting for its harness) is the same operation: no second one.
    const op = open ?? requestOperation(ctx.db, { id: ctx.ulid, run, kind: launchKind(mode), mode, requestedBy: ctx.caller.role, source: "cli", now });
    ctx.db
      .query("UPDATE runs SET state = CASE WHEN state = 'failed' THEN 'running' ELSE state END, liveness = 'starting', resume_count = resume_count + 1, ended_at = NULL, updated_at = ?2 WHERE id = ?1")
      .run(run.id, now);
    // A dead worker holds no slot (design section 11): the scheduler grants its worker slot, and its stage's pools, first.
    const viaScheduler = replacement !== null || !holdsLease(ctx.db, run.id, WORKER_POOL);
    if (replacement) ctx.db.query("UPDATE runs SET waiting_since = ?2 WHERE id = ?1").run(run.id, now);
    else if (viaScheduler) ctx.db.query("UPDATE runs SET pending_launch = 'resume', waiting_since = ?2 WHERE id = ?1").run(run.id, now);
    if (run.state === "failed") {
      // failRun parked the task; take it back to In flight.
      recordIntent(ctx.db, { file: "backlog", verb: "unhold", taskId: run.task_id, positional: [run.task_id], now });
      recordIntent(ctx.db, { file: "backlog", verb: "start", taskId: run.task_id, positional: [run.task_id], now });
    }
    resolveRunItems(ctx.db, run.id, ["failure_needs_you", "operation_escalated", "review_worker_gone"], "run.resume_requested", now);
    appendEvent(ctx.db, { source: "cli", kind: "run.resume_requested", runId: run.id, taskId: run.task_id, payload: { by: ctx.caller.role, resume: run.resume_count + 1, via_scheduler: viaScheduler } });
    return { data: { run: run.id, task: run.task_id, state: "resuming", operation: op.id }, hints: [`flowryn show ${run.task_id}`] };
  },
  async settle(ctx, result) {
    const row = ctx.db.query("SELECT pending_launch FROM runs WHERE id = ?1").get(String(result.data.run)) as { pending_launch: string | null } | null;
    const op = typeof result.data.operation === "string" ? getOperation(ctx.db, result.data.operation) : null;
    if (row?.pending_launch === "resume") {
      await ctx.sched.passNow();
      const after = ctx.db.query("SELECT pending_launch FROM runs WHERE id = ?1").get(String(result.data.run)) as { pending_launch: string | null } | null;
      return after?.pending_launch === "resume" ? waitingReply(ctx.db, result) : result;
    }
    if (op?.mode && op.mode !== "resume") {
      await ctx.sched.passNow();
      const after = ctx.db.query("SELECT waiting_since FROM runs WHERE id = ?1").get(String(result.data.run)) as { waiting_since: number | null } | null;
      return after?.waiting_since != null ? waitingReply(ctx.db, result) : result;
    }
    // The launcher issues the resume only from `requested`: a replayed settlement finds it issued and starts nothing.
    // A reply stored before operations existed names none: its resume was launched then.
    if (typeof result.data.operation === "string") ctx.fleet.launch(String(result.data.run), "resume", result.data.operation);
    return result;
  },
};

/**
 * `flowryn interrupt <task|run>`: stop the worker's current turn, verified
 * (design section 5): Claude by the interrupt marker in its transcript, Pi by
 * the extension's abort and the agent_settled that follows.
 */
const interrupt: VerbSpec = {
  name: "interrupt",
  summary: "Interrupt a worker's current turn (verified); it stays alive and idle",
  positionals: [{ name: "target", required: true, help: "task or run id", complete: "task" }],
  flags: {},
  kind: "mutation",
  roles: ["leader", "human"],
  scope: { kind: "ref", arg: "target" },
  async prepare(ctx, args) {
    const run = activeRunFor(ctx.db, stringArg(args, "target")!);
    return { run: run.id, task: run.task_id, verified: await ctx.fleet.interruptRun(run.id) };
  },
  apply(_ctx, _args, prepared) {
    const { run, task, verified } = prepared as { run: string; task: string; verified: { ok: boolean; evidence: string; detail?: string } };
    if (verified.evidence === "refused") throw new FlowrynError("interrupt_refused", `interrupt refused: ${verified.detail ?? "unsafe now"}`, `flowryn show ${task}`);
    if (!verified.ok) throw new FlowrynError("internal", `the interrupt was not verified (${verified.detail ?? verified.evidence})`, `flowryn show ${task}`);
    return { data: { run, task, interrupted: true, evidence: verified.evidence } };
  },
};

// --- reads ------------------------------------------------------------------------------------

function age(now: number, since: number): string {
  const s = Math.max(0, Math.round((now - since) / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172_800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

interface FleetRow extends RunRow {
  project_id: string;
  kind: string;
}

function needs(ctx: ReadCtx, run: FleetRow): string {
  if (ctx.db.query("SELECT 1 FROM decisions WHERE run_id = ?1 AND state = 'open'").get(run.id)) return "answer";
  if (ctx.db.query("SELECT 1 FROM items WHERE run_id = ?1 AND lane = 'P0' AND state IN ('open','presented')").get(run.id)) return "you";
  if (ctx.db.query("SELECT 1 FROM items WHERE run_id = ?1 AND kind = 'worker_report' AND state IN ('open','presented')").get(run.id)) return "report";
  if (run.stage_state === "review") return "review";
  // A scout's report stays to be read after its run landed and was cleaned.
  if (run.kind === "scout" && ctx.db.query("SELECT 1 FROM items WHERE run_id = ?1 AND kind = 'report_ready' AND state IN ('open','presented')").get(run.id)) return "read";
  if (run.state === "ready") return run.kind === "scout" ? "read" : "merge";
  if (run.state === "merging") return "proof";
  if (run.state === "landed") return run.cleanup === "refused" ? "cleanup" : "-";
  return "-";
}

/** A ship's delivery in `show`: what was delivered, what GitHub says now, the merge and the cleanup. */
function deliveryView(ctx: ReadCtx, run: FleetRow): Record<string, unknown> | undefined {
  const delivered = deliveredOf(ctx.db, run.task_id);
  if (!delivered && run.cleanup === null) return undefined;
  const view: Record<string, unknown> = {};
  if (delivered) {
    view[delivered.kind === "pr" ? "pr" : "branch"] = delivered.ref;
    view.delivered_head = delivered.head.slice(0, 12);
    if (delivered.carriedFrom) view.carried_from = `${delivered.carriedFrom.slice(0, 12)} (the new head adds only a clean merge of main)`;
  }
  const pr = prEvidence(ctx.db, run.id);
  if (pr) {
    view.pr_state = pr.draft ? `${pr.state} (draft)` : pr.state;
    view.head_now = pr.head.slice(0, 12);
    view.checks = pr.checks?.line ?? "unknown";
    view.seen = `${age(ctx.now, pr.observed_at)} ago`;
  }
  const verified = delivered ? latestVerification(ctx.db, approvalRef(delivered)) : null;
  if (verified) view.verified = verificationLine(verified);
  const auto = latestAutoMerge(ctx.db, run.id);
  if (auto) view.auto_merge = autoMergeLine(ctx.db, auto);
  const merge = latestMerge(ctx.db, run.task_id);
  if (merge) {
    const approval = ctx.db.query("SELECT channel, actor FROM approvals WHERE id = ?1").get(merge.approval_id) as { channel: string; actor: string } | null;
    const green = merge.local_green ? `, local green ${merge.local_green}` : "";
    view.merge = `${merge.id} ${merge.state}${merge.merge_sha ? ` at ${merge.merge_sha.slice(0, 12)}` : ""} via ${approval?.channel ?? "?"}${green}${merge.detail ? ` (${sanitizeLine(merge.detail, 100)})` : ""}`;
  }
  const standing = ctx.db.query("SELECT id, channel, head_sha, allow_red_check FROM approvals WHERE task_id = ?1 AND consumed_at IS NULL AND expires_at > ?2 ORDER BY created_at DESC LIMIT 1").get(run.task_id, ctx.now) as {
    id: string;
    channel: string;
    head_sha: string;
    allow_red_check: string | null;
  } | null;
  if (standing) view.approval = `${standing.id} ${standing.channel} for ${standing.head_sha.slice(0, 12)}${standing.allow_red_check ? `, waives ${standing.allow_red_check}` : ""}`;
  if (run.cleanup) view.cleanup = `${run.cleanup}${run.cleanup_detail ? `: ${sanitizeLine(run.cleanup_detail, 100)}` : ""}`;
  return view;
}

function gatesView(ctx: ReadCtx, runId: string): string[] | null {
  const gates = gatesOf(ctx.db, runId);
  if (gates.length === 0) return null;
  return gates.slice(-5).map((g) => `${g.id} ${g.kind} ${g.stage}: ${g.replaced_by ? `replaced by ${g.replaced_by}` : g.state}${g.review_url ? ` ${sanitizeLine(g.review_url, 100)}` : ""}${g.page_path && g.state === "open" ? ` page ${sanitizeLine(g.page_path, 200)}` : ""}${g.feedback ? ` ("${sanitizeLine(g.feedback, 60)}")` : ""}${g.state === "open" ? browserView(g) : ""}${g.state === "open" && g.page_path ? channelView(g, (item) => itemIsOpen(ctx.db, item)) : ""}`);
}

function itemIsOpen(db: Db, itemId: string): boolean {
  return db.query("SELECT 1 FROM items WHERE id = ?1 AND state IN ('open','presented')").get(itemId) !== null;
}

/** An open review gate's browser state; unless it opened, the URL to open by hand (docs/notes/2026-10-10-review-pages-open-4b.md). */
function browserView(g: GateRow): string {
  if (!g.open_state || !g.review_url) return "";
  const at = g.open_at ? ` ${new Date(g.open_at).toTimeString().slice(0, 5)}` : "";
  const detail = g.open_detail ? ` (${sanitizeLine(g.open_detail, 160)})` : "";
  const byHand = `; open by hand: ${sanitizeLine(g.review_url, 200)}`;
  switch (g.open_state) {
    case "opened":
      return `; browser: opened${at}${detail}`;
    case "pending":
      return `; browser: waits for Flowryn's Lavish poll to listen${byHand}`;
    case "opening":
      return `; browser: opening, or the daemon stopped while opening${at}${byHand}`;
    default:
      return `; browser: ${g.open_state}${at}${detail}${byHand}`;
  }
}

function planLine(ctx: ReadCtx, taskId: string, text: ShowText): string {
  const phase = phaseOfTask(ctx.db, taskId)!;
  return `${phase.plan_id} phase ${phase.phase_no} of ${phase.phases}: ${text.line(phase.plan_title, 80)}`;
}

const MAX_FLEET_ROWS = 20;
const MAX_NEEDS_ROWS = 10;
const MAX_QUEUED_ROWS = 10;

function queuedRow(ctx: ReadCtx, q: QueuedTask): Record<string, unknown> {
  return {
    id: q.id,
    kind: q.kind,
    project: q.project,
    status: q.status,
    auto: q.auto,
    waits: sanitizeLine(waitsCell(q), 80),
    next: q.next,
    age: queuedAge(ctx.now, q, age),
  };
}

/**
 * `flowryn fleet`: every open run and today's finished ones, at most 20 rows
 * (design section 12), then the queued work no run has started yet, ready
 * first, at most 10 rows.
 */
const fleet: VerbSpec = {
  name: "fleet",
  summary: "Every worker: task, kind, project, state, liveness, age and what it needs",
  positionals: [],
  flags: {},
  kind: "read",
  roles: ["leader", "reader", "human"],
  scope: { kind: "list" },
  read(ctx) {
    const lens = lensFor(ctx.db, ctx.config, ctx.caller.scope);
    const rows = (
      ctx.db
        .query(
          `SELECT r.*, p.project_id, p.kind FROM runs r JOIN task_policy p ON p.task_id = r.task_id
           WHERE r.state NOT IN ('cleaned','failed','cancelled') OR r.updated_at > ?1
           ORDER BY r.started_at DESC`,
        )
        .all(ctx.now - 86_400_000) as FleetRow[]
    ).filter((r) => lens.task(r.task_id));
    const list = rows.slice(0, MAX_FLEET_ROWS).map((r) => ({
      id: r.task_id,
      kind: r.kind,
      project: r.project_id,
      state: r.state,
      stage: stageLabel(r),
      live: r.liveness,
      age: age(ctx.now, r.started_at),
      steer: steerBrief(ctx.db, r.id, ctx.now),
      needs: needs(ctx, r),
    }));
    // Only what needs you counts, as in the briefing's "Needs you": informational items are on the board.
    const lanes = (ctx.db.query("SELECT lane, task_id, run_id FROM items WHERE class = 'actionable' AND state IN ('open','presented')").all() as { lane: string; task_id: string | null; run_id: string | null }[]).filter(
      (i) => lens.item(i),
    );
    const count = (lane: string) => lanes.filter((l) => l.lane === lane).length;
    const data: Record<string, unknown> = { fleet: list, open: `P0 ${count("P0")} · P1 ${count("P1")}`, capacity: capacityLine(ctx) };
    if (rows.length > MAX_FLEET_ROWS) data.more = `${rows.length - MAX_FLEET_ROWS} older rows not shown`;
    const away = getAway(ctx.db, ctx.now);
    if (away) data.away = awayLine(away, ctx.now);
    const wake = wakeLineFor(ctx.db, ctx.caller.session ?? null, ctx.now);
    if (wake) data.wake = wake;
    const queued = queuedWork(ctx.db).filter((q) => lens.task(q.id));
    // Why each waiting run waits, from its recorded explanation (docs/notes/2026-10-13-next-steps-md-wq.md); detail is show --why.
    const held = waitingRuns(ctx.db).filter((w) => lens.task(w.task_id));
    if (held.length > 0) data.waiting = held.map((w) => ({ task: w.task_id, ...waitingPointer(w) }));
    // Asks (src/ask/) still queued or running: one line each, since an ask has no run to list.
    const asks = askLines(ctx.db, ctx.now, (projectId) => lens.project(projectId));
    if (asks.length > 0) data.asks = asks;
    if (queued.length > 0) {
      data.queued = queued.slice(0, MAX_QUEUED_ROWS).map((q) => queuedRow(ctx, q));
      if (queued.length > MAX_QUEUED_ROWS) data.queued_more = `${queued.length - MAX_QUEUED_ROWS} more queued: backlog.md`;
    }
    // Every open actionable item, P0 first: fleet lists what needs you, like every briefing (design section 9).
    const waiting = openActionable(ctx.db, ctx.now, leaderTiming(ctx.config).age_ms)
      .filter((i) => lens.item(i))
      .map((i) => lens.redact(i));
    if (waiting.length > 0) {
      data.needs = waiting.slice(0, MAX_NEEDS_ROWS).map((i) => ({ id: i.id, lane: i.lane, line: sanitizeLine(i.line, 120) }));
      if (waiting.length > MAX_NEEDS_ROWS) data.needs_more = `${waiting.length - MAX_NEEDS_ROWS} more: flowryn board`;
    }
    if (list.length > 0) return { data, hints: ["flowryn show <id>", "flowryn steer <id> --body-file -"] };
    if (queued.length > 0) return { data, hints: ["flowryn show <id>", "flowryn dispatch <project> --task <id>"] };
    return { data, hints: ["flowryn dispatch <project> --kind scout --body-file -"] };
  },
};

/** "build", "qa review", "ship waiting": the stage, with its state when it is not simply running. */
export function stageLabel(run: Pick<RunRow, "stage" | "stage_state" | "pending_launch">): string {
  if (run.pending_launch === "fresh" || run.pending_launch === "resume") return `${run.stage} waiting`;
  return run.stage_state === "active" ? run.stage : `${run.stage} ${run.stage_state}`;
}

/** One line of capacity: each pool's live leases over its cap, and how many runs wait. */
export function capacityLine(ctx: ReadCtx): string {
  const caps = capacityConfig(ctx.config).pools;
  const counts = liveCounts(ctx.db);
  const waiting = (ctx.db.query("SELECT COUNT(*) AS n FROM runs WHERE state NOT IN ('cleaned','failed','cancelled') AND (stage_state = 'waiting' OR pending_launch IS NOT NULL) AND (pending_launch IS NOT NULL OR liveness != 'dead')").get() as { n: number }).n;
  return `${Object.entries(caps).map(([pool, cap]) => `${pool} ${counts[pool] ?? 0}/${cap}`).join(" · ")}${waiting > 0 ? ` · waiting ${waiting}` : ""}`;
}

const QUEUED_BODY_LINES = 6;

/** What `show` hints for a queued task: the command that starts it, or its first blocker. */
function queuedHints(q: QueuedTask): string[] {
  if (q.next.startsWith("flowryn ")) return [q.next];
  if (q.status === "waiting" && q.waits[0]) return [`flowryn show ${q.waits[0]}`];
  if (q.status === "ready" && q.plan) return [`flowryn show ${q.plan.id}`];
  return [];
}

function filedLine(ctx: ReadCtx, q: QueuedTask): string {
  if (q.filed === "backlog") return `by hand in backlog.md${q.createdDay ? ` on ${q.createdDay}` : ""}`;
  const when = q.createdAt === null ? "" : `${age(ctx.now, q.createdAt)} ago, `;
  return q.filed === "imported" ? `${when}imported (${q.importSource})` : `${when}by flowryn`;
}

/** `show` for a Queued task no run has started: what it is, what it waits for, and what starts it. */
/** A task `flowryn drop` removed: gone from the backlog, so its drop record says what it was and why. */
/** A `dispatch --after` watch: what it waits for, for which task, and where it is. */
function watchView(w: WatchRow, now: number): { data: Record<string, unknown>; hints: string[] } {
  const ended = w.ended_at === null ? "" : ` ${new Date(w.ended_at).toISOString()}`;
  return {
    data: {
      watch: w.id,
      task: w.task_id,
      waits_for: watchLabel(w),
      waiter: w.waiter_task || "-",
      state: `${w.state}${ended}`,
      detail: w.detail ?? "-",
      opened: `${age(now, w.created_at)} ago`,
      checked: w.checked_at === null ? "-" : `${age(now, w.checked_at)} ago`,
    },
    hints: w.waiter_task ? [`flowryn show ${w.waiter_task}`] : ["flowryn fleet"],
  };
}

function droppedView(ctx: ReadCtx, d: NonNullable<ReturnType<typeof dropRecord>>, text: ShowText): { data: Record<string, unknown>; hints: string[] } {
  const runs = (ctx.db.query("SELECT id, state FROM runs WHERE task_id = ?1 ORDER BY started_at").all(d.task_id) as { id: string; state: string }[]).map((r) => `${r.id} ${r.state}`);
  const unblocked = JSON.parse(d.unblocked) as string[];
  return {
    data: {
      task: d.task_id,
      title: text.line(d.title, 120),
      state: "dropped",
      dropped: `${age(ctx.now, d.dropped_at)} ago by ${d.dropped_by}`,
      reason: text.full ? d.reason : text.line(d.reason, 200),
      ...(d.plan_id ? { plan: d.plan_id } : {}),
      ...(unblocked.length > 0 ? { unblocked } : {}),
      runs,
    },
    hints: d.plan_id ? [`flowryn show ${d.plan_id}`] : ["flowryn fleet"],
  };
}

function queuedView(ctx: ReadCtx, q: QueuedTask, text: ShowText): { data: Record<string, unknown>; hints: string[] } {
  const policy = q.policy;
  const runs = (ctx.db.query("SELECT id, state, started_at FROM runs WHERE task_id = ?1 ORDER BY started_at").all(q.id) as { id: string; state: string; started_at: number }[]).map(
    (r) => `${r.id} ${r.state} ${age(ctx.now, r.started_at)} ago`,
  );
  const events = (ctx.db.query("SELECT ts, kind FROM events WHERE task_id = ?1 ORDER BY seq DESC LIMIT 8").all(q.id) as { ts: number; kind: string }[])
    .toReversed()
    .map((e) => `${age(ctx.now, e.ts)} ago ${e.kind}`);
  const hold = q.hold ? [q.hold.kind, q.hold.reason, q.hold.until ? `until ${q.hold.until}` : null].filter((s) => s).join(" · ") : "-";
  return {
    data: {
      task: q.id,
      title: text.line(q.title, 120),
      state: "queued",
      status: q.status,
      next: q.next,
      kind: q.kind,
      project: q.project,
      ...(policy ? { mode: policy.mode_reason ? `${policy.delivery_mode} (${policy.mode_reason})` : policy.delivery_mode, workflow: policy.workflow } : {}),
      priority: q.priority ?? "-",
      auto: q.auto,
      blocked_by: q.blockedBy,
      waits: q.waits.map((id, i) => (q.waitLabels[i] === id ? id : `${q.waitLabels[i]} (${id})`)),
      hold: text.line(hold, 120),
      ...(q.plan ? { plan: `${q.plan.id} phase ${q.plan.phase} of ${q.plan.of}: ${text.line(q.plan.title, 80)}` } : {}),
      ...(policy?.base_branch ? { base: policy.base_branch } : {}),
      filed: filedLine(ctx, q),
      body: text.block(q.body, QUEUED_BODY_LINES, 120),
      runs,
      events,
      ...text.pointer(q.id),
    },
    hints: queuedHints(q),
  };
}

interface ItemRow {
  kind: string;
  event_seq: number;
  task_id: string | null;
  run_id: string | null;
  line: string;
  full_line: string | null;
  lane: string;
  state: string;
  opened_at: number;
}

function isOpen(state: string): boolean {
  return state === "open" || state === "presented";
}

/**
 * A worker_report item in `show`: the report itself, with the whole body its
 * event keeps (never cut), so the view reads it whole and closes it for the
 * leader when its status allows (src/attention/read-close.ts).
 */
function workerReportView(ctx: ReadCtx, id: string, item: ItemRow, full: boolean): HandlerResult {
  const event = ctx.db.query("SELECT payload FROM events WHERE seq = ?1").get(item.event_seq) as { payload: string } | null;
  const payload = event ? (JSON.parse(event.payload) as { status?: string; body?: string }) : {};
  const open = isOpen(item.state);
  return {
    data: {
      item: id,
      kind: "worker_report",
      lane: item.lane,
      state: item.state,
      status: payload.status ?? "-",
      task: item.task_id ?? "-",
      title: item.task_id ? taskTitle(ctx.db, item.task_id) : "-",
      run: item.run_id ?? "-",
      reported: `${age(ctx.now, item.opened_at)} ago`,
      body: payload.body || "-",
    },
    hints: open && item.task_id ? [`flowryn dismiss ${id}`, `flowryn steer ${item.task_id} --body-file -`] : ["flowryn fleet"],
    ...(open ? { reportsRead: [{ item: id, form: full ? "item-full" : "item" }] } : {}),
  };
}

/** The most of a scout's report file `show` reads: what deliver accepts. */
const REPORT_FILE_MAX_BYTES = 1024 * 1024;
/** A scout's report in a report_ready item's view, unless --full: its first lines, each cut. */
const REPORT_BODY_LINES = 60;

/** The scout's delivered report file: its path, and its text or why it cannot be read. */
function scoutReport(db: Db, taskId: string): { path: string; text: string | null; problem?: string } | null {
  const row = db.query("SELECT ref FROM artifacts WHERE task_id = ?1 AND kind = 'report' ORDER BY created_at DESC LIMIT 1").get(taskId) as { ref: string } | null;
  if (!row) return null;
  try {
    const size = statSync(row.ref).size;
    if (size > REPORT_FILE_MAX_BYTES) return { path: row.ref, text: null, problem: `over ${REPORT_FILE_MAX_BYTES} bytes` };
    return { path: row.ref, text: readFileSync(row.ref, "utf8") };
  } catch (error) {
    return { path: row.ref, text: null, problem: (error as NodeJS.ErrnoException).code ?? (error as Error).message };
  }
}

/**
 * A report_ready item in `show`: the scout's report itself. Its first lines
 * by default, the whole report with --full; the leader's read closes the item
 * only when nothing of the report was cut.
 */
function scoutReportView(ctx: ReadCtx, id: string, item: ItemRow, full: boolean): HandlerResult {
  const report = item.task_id ? scoutReport(ctx.db, item.task_id) : null;
  const bodyText = new ShowText(full);
  const readable = report !== null && report.text !== null;
  const body = readable ? bodyText.block(report.text!, REPORT_BODY_LINES, MAX_LINE_CHARS) : `- (${report ? `cannot read ${report.path}: ${report.problem}` : "no report recorded"})`;
  const decisions = item.task_id
    ? (ctx.db.query("SELECT id FROM decisions WHERE origin = ?1 AND state = 'open' ORDER BY id").all(item.task_id) as { id: string }[]).map((d) => d.id)
    : [];
  const open = isOpen(item.state);
  const whole = readable && !bodyText.cut;
  return {
    data: {
      item: id,
      kind: "report_ready",
      lane: item.lane,
      state: item.state,
      task: item.task_id ?? "-",
      title: item.task_id ? taskTitle(ctx.db, item.task_id) : "-",
      run: item.run_id ?? "-",
      reported: `${age(ctx.now, item.opened_at)} ago`,
      report: report?.path ?? "-",
      decisions,
      body,
      ...bodyText.pointer(id),
    },
    hints: [...(bodyText.cut ? [`flowryn show ${id} --full`] : []), ...(open ? [`flowryn dismiss ${id}`] : ["flowryn fleet"])],
    ...(open && whole ? { reportsRead: [{ item: id, form: full ? "item-full" : "item" }] } : {}),
  };
}

/**
 * `show <task|run> --full`: the run's open reports whole, so reading the view
 * reads them: each open worker_report's body and, for a scout, its report.
 */
function fullReportsView(ctx: ReadCtx, runId: string, taskId: string, scout: boolean): { fields: Record<string, unknown>; reads: ReportRead[] } {
  const open = ctx.db
    .query("SELECT i.id, i.kind, e.payload FROM items i LEFT JOIN events e ON e.seq = i.event_seq WHERE i.run_id = ?1 AND i.kind IN ('worker_report','report_ready') AND i.state IN ('open','presented') ORDER BY i.opened_at")
    .all(runId) as { id: string; kind: string; payload: string | null }[];
  const reads: ReportRead[] = [];
  const reports = open
    .filter((i) => i.kind === "worker_report")
    .map((i) => {
      reads.push({ item: i.id, form: "run-full" });
      const payload = i.payload ? (JSON.parse(i.payload) as { status?: string; body?: string }) : {};
      return { item: i.id, status: payload.status ?? "-", body: payload.body || "-" };
    });
  const fields: Record<string, unknown> = reports.length > 0 ? { reports } : {};
  const report = scout ? scoutReport(ctx.db, taskId) : null;
  if (report) {
    fields.report_body = report.text !== null ? sanitizeBlock(report.text) : `- (cannot read ${report.path}: ${report.problem})`;
    if (report.text !== null) for (const i of open.filter((o) => o.kind === "report_ready")) reads.push({ item: i.id, form: "run-full" });
  }
  return { fields, reads };
}

/** The chat-answer grants of an item or a task (its gates and merges), when there are any. */
function grantsField(ctx: ReadCtx, where: { item?: string; task?: string; session?: string }): { grants?: string[] } {
  const lines = grantLines(ctx.db, where, ctx.now);
  return lines.length > 0 ? { grants: lines } : {};
}

/** A run's latest `flowryn report` of any status, as one line for `show`. */
function latestReport(ctx: ReadCtx, runId: string, text: ShowText): string | null {
  const row = ctx.db.query("SELECT ts, payload FROM events WHERE run_id = ?1 AND kind = 'worker.report' ORDER BY seq DESC LIMIT 1").get(runId) as { ts: number; payload: string } | null;
  if (!row) return null;
  const payload = JSON.parse(row.payload) as { status?: string; summary?: string };
  const summary = payload.summary ? ` · ${text.line(payload.summary, 80)}` : "";
  return `${payload.status ?? "-"} · ${age(ctx.now, row.ts)} ago${summary}`;
}

/** The run's open wait explanations: one terse line by default, each whole with --why (docs/notes/2026-10-12-next-steps-md-wz.md). */
function waitingView(ctx: ReadCtx, runId: string, why: boolean): { waiting?: unknown } {
  const rows = openExplanations(ctx.db, runId);
  if (rows.length === 0) return {};
  const describe = (id: string) => {
    const op = getOperation(ctx.db, id);
    return op ? `${op.id} ${op.kind} ${op.phase}` : id;
  };
  return { waiting: why ? rows.map((row) => explanationDetail(row, ctx.now, describe)) : waitingField(rows) };
}

/** The run's open operation, or its newest one while it is escalated: what Flowryn is doing to the worker, or waits on you for. */
function operationView(ctx: ReadCtx, runId: string): { operation?: string } {
  const op = openOperation(ctx.db, runId) ?? latestOperation(ctx.db, runId);
  if (!op || (op.phase !== "requested" && op.phase !== "effect_issued" && op.phase !== "escalated")) return {};
  if (op.phase === "escalated" && !heldByEscalation(ctx.db, runId)) return {};
  return { operation: operationLine(op) };
}

/** `flowryn show <task|run> --timeline`: the task's recorded explanations across its runs, oldest first. */
function timelineView(ctx: ReadCtx, target: string, full: boolean): { data: Record<string, unknown>; hints: string[] } {
  const taskId = (findRun(ctx.db, target) as RunRow | null)?.task_id ?? target;
  const rows = taskExplanations(ctx.db, taskId);
  const known = rows.length > 0 || ctx.db.query("SELECT 1 FROM task_policy WHERE task_id = ?1").get(taskId) !== null || queuedTask(ctx.db, taskId) !== null;
  if (!known) throw new FlowrynError("not_found", `no task or run ${target}`, "flowryn fleet");
  return {
    data: { task: taskId, timeline: rows.length > 0 ? rows.map((row) => timelineEntry(row, ctx.now, full)) : "no wait explanations recorded" },
    hints: [`flowryn show ${taskId}`, ...(full || rows.length === 0 ? [] : [`flowryn show ${taskId} --timeline --full`])],
  };
}

/** `flowryn show <task|run>`: one run in detail, at most about 40 lines; --full prints every title, line and body whole. */
const show: VerbSpec = {
  name: "show",
  summary: "One task, run, item, decision, plan, divergence, review gate, chat-answer grant or leader session in detail; --full for untruncated text",
  positionals: [{ name: "target", required: true, help: "task, run, item, decision, plan, divergence, gate (g<N>), grant (c<N>) or leader session (L<N>) id", complete: "task" }],
  flags: {
    full: { type: "boolean", help: "untruncated titles, lines and bodies" },
    why: { type: "boolean", help: "each recorded reason the run waits, whole: its rule, facts with their observation times, and who can end it" },
    timeline: { type: "boolean", help: "only the task's recorded wait explanations, in order (with --full, each one's facts too)" },
  },
  kind: "read",
  roles: ["leader", "reader", "human"],
  scope: { kind: "ref", arg: "target" },
  read(ctx, args) {
    const asked = stringArg(args, "target")!;
    let target = asked;
    const text = new ShowText(boolArg(args, "full"));
    if (boolArg(args, "timeline")) return timelineView(ctx, target, text.full);
    if (/^[kq]\d+$/.test(target)) {
      const d = getDecision(ctx.db, target);
      if (d) return { data: { ...decisionView(d, text), ...grantsField(ctx, { item: d.id }), ...text.pointer(asked) }, hints: d.state === "open" ? [`flowryn decide ${d.id} <choice> --rationale <why>`] : ["flowryn decision list"] };
    }
    const grant = /^c\d+$/.test(target) ? getGrant(ctx.db, target) : null;
    if (grant) return { data: grantView(grant, ctx.now), hints: [`flowryn show ${grant.item.replace(/^merge:/, "")}`] };
    const leader = /^L\d+$/.test(target) ? getSession(ctx.db, target) : null;
    if (leader) {
      return {
        data: {
          session: leader.session_id,
          harness: leader.harness,
          pane: leader.pane_id ?? "-",
          account: leader.account ?? "-",
          scope: leader.scope === UNCONFIRMED_SCOPE ? "unconfirmed" : leader.scope,
          lease: isHolder(ctx.db, leader.session_id) ? "holder" : "read-only",
          state: leader.ended_at === null ? "open" : `ended ${new Date(leader.ended_at).toISOString()}`,
          cwd: leader.cwd ?? "-",
          transcript: leader.transcript_path ?? "-",
          pin: pinHistory(ctx.db, leader.session_id, { cwd: leader.cwd, startedAt: leader.started_at }),
          ...grantsField(ctx, { session: leader.session_id }),
        },
        hints: ["flowryn leader status"],
      };
    }
    // A review gate shows as its task, whose gates and grants it lists.
    const gateRun = /^g\d+$/.test(target) ? (ctx.db.query("SELECT run_id FROM gates WHERE id = ?1").get(target) as { run_id: string } | null) : null;
    if (gateRun) target = gateRun.run_id;
    const ask = ASK_ID.test(target) ? getAsk(ctx.db, target) : null;
    if (ask) return askView(ctx, ask, text.full);
    const plan = /^p\d+$/.test(target) ? planView(ctx.db, target, text.full) : null;
    if (plan) return { data: plan, hints: text.full ? ["flowryn fleet"] : ["flowryn fleet", `flowryn show ${target} --full`] };
    const divergence = /^d\d+$/.test(target) ? getDivergence(ctx.db, target) : null;
    if (divergence) return { data: { ...divergenceView(divergence), ...grantsField(ctx, { item: divergence.id }) }, hints: divergence.resolved_at === null ? [resolveCommand(divergence)] : ["flowryn fleet"] };
    const item = ctx.db.query("SELECT * FROM items WHERE id = ?1").get(target) as ItemRow | null;
    if (item?.kind === "worker_report") return workerReportView(ctx, target, item, text.full);
    if (item?.kind === "report_ready") return scoutReportView(ctx, target, item, text.full);
    const itemAsk = (item?.kind === "answer_ready" || item?.kind === "ask_failed") && item.task_id ? getAsk(ctx.db, item.task_id) : null;
    if (itemAsk) return askView(ctx, itemAsk, text.full);
    if (item) target = item.run_id ?? item.task_id ?? target;
    const dropped = item ? null : dropRecord(ctx.db, target);
    if (dropped) return droppedView(ctx, dropped, text);
    const run = findRun(ctx.db, target) as FleetRow | null;
    if (!run) {
      if (item) {
        // A task-less item may name other scopes' tasks: a scoped leader sees its neutral line (src/leader/scope.ts).
        const shown = lensFor(ctx.db, ctx.config, ctx.caller.scope).redact({ ...item, id: target });
        return { data: { item: target, lane: shown.lane, state: shown.state, line: text.stored(shown.line, shown.full_line, Number.POSITIVE_INFINITY), ...text.pointer(asked) } };
      }
      const watch = /^w\d+$/.test(target) ? watchById(ctx.db, target) : watchOfTask(ctx.db, target);
      if (watch) return watchView(watch, ctx.now);
      const queued = queuedTask(ctx.db, target);
      if (queued) return queuedView(ctx, queued, text);
      const phase = phaseOfTask(ctx.db, target);
      if (phase) {
        const base = storedBase(ctx.db, target);
        return { data: { task: target, title: phase.title, plan: `${phase.plan_id} phase ${phase.phase_no} of ${phase.phases}`, ...(base ? { base } : {}), ...planView(ctx.db, phase.plan_id, text.full) }, hints: [`flowryn show ${phase.plan_id}`] };
      }
      throw new FlowrynError("not_found", `no task, run, item or plan ${target}`, "flowryn fleet");
    }
    const policy = ctx.db.query("SELECT project_id, kind, delivery_mode, mode_reason FROM task_policy WHERE task_id = ?1").get(run.task_id) as {
      project_id: string;
      kind: string;
      delivery_mode: string;
      mode_reason: string | null;
    };
    // A task Queued again after its run failed or was cancelled: the run's evidence, and what starts it again.
    const requeued = isTerminal(run.state) ? queuedTask(ctx.db, run.task_id) : null;
    // Delivery is "seen" (in a model request); the ack is compliance. Times are after the steer was created.
    const steers = recentSteers(ctx.db, run.id, 5).map((m) => ({ id: m.id, rings: m.rings, delivery: steerStatus(m, ctx.now), body: text.line(m.body, 60) }));
    const decisions = (ctx.db.query("SELECT id, state, question, answer FROM decisions WHERE run_id = ?1 ORDER BY id").all(run.id) as {
      id: string;
      state: string;
      question: string;
      answer: string | null;
    }[]).map((d) => ({ id: d.id, state: d.state, question: text.line(d.question, 80), answer: d.answer ?? "-" }));
    const items = (ctx.db.query("SELECT id, lane, line, full_line FROM items WHERE run_id = ?1 AND state IN ('open','presented') ORDER BY opened_at").all(run.id) as {
      id: string;
      lane: string;
      line: string;
      full_line: string | null;
    }[]).map((i) => ({ id: i.id, lane: i.lane, line: text.stored(i.line, i.full_line, 100) }));
    const artifacts = (ctx.db.query("SELECT kind, ref FROM artifacts WHERE task_id = ?1 ORDER BY created_at").all(run.task_id) as { kind: string; ref: string }[]).map(
      (a) => `${a.kind}: ${a.ref}`,
    );
    const events = (ctx.db.query("SELECT ts, kind FROM events WHERE run_id = ?1 ORDER BY seq DESC LIMIT 8").all(run.id) as { ts: number; kind: string }[])
      .toReversed()
      .map((e) => `${age(ctx.now, e.ts)} ago ${e.kind}`);
    const report = latestReport(ctx, run.id, text);
    const whole = text.full ? fullReportsView(ctx, run.id, run.task_id, policy.kind === "scout") : null;
    return {
      data: {
        task: run.task_id,
        title: text.line(taskTitle(ctx.db, run.task_id), 120),
        run: run.id,
        kind: policy.kind,
        project: policy.project_id,
        mode: policy.mode_reason ? `${policy.delivery_mode} (${policy.mode_reason})` : policy.delivery_mode,
        harness: `${run.harness} ${run.harness_version}`,
        ...modelView(ctx.db, run),
        // Only a declared account: the implicit one is named after its harness, already shown.
        ...(run.account && run.account !== run.harness ? { account: run.account } : {}),
        state: run.state,
        liveness: run.liveness,
        ...waitingView(ctx, run.id, boolArg(args, "why")),
        ...operationView(ctx, run.id),
        workflow: `${run.workflow}: ${flowLine(runWorkflow(ctx.db, run, policy.kind as "ship" | "scout"))}`,
        stage: stageLabel(run),
        ...(requeued ? { queued: `${requeued.status} · ${requeued.next}` } : {}),
        ...(gatesView(ctx, run.id) ? { gates: gatesView(ctx, run.id) } : {}),
        ...grantsField(ctx, { task: run.task_id }),
        leases: runLeases(ctx.db, run.id).map((l) => l.pool).join(" ") || "-",
        ...(phaseOfTask(ctx.db, run.task_id) ? { plan: planLine(ctx, run.task_id, text) } : {}),
        pane: run.pane_id ?? "-",
        pid: run.proc_pid ?? "-",
        resumes: run.resume_count,
        worktree: run.worktree_path,
        branch: run.branch,
        ...(run.base_branch ? { base: run.base_branch } : {}),
        ...(run.stacked_on ? { stacked_on: `${run.stacked_on} (merges after it lands)` } : {}),
        artifacts,
        ...(deliveryView(ctx, run) ? { delivery: deliveryView(ctx, run) } : {}),
        steers,
        decisions,
        ...(report ? { report } : {}),
        ...whole?.fields,
        items,
        events,
        ...text.pointer(asked),
      },
      hints: run.state === "ready" && policy.kind === "ship" ? [`flowryn merge ${run.task_id}`, `flowryn decline ${run.task_id} --body-file -`] : [`flowryn steer ${run.task_id} --body-file -`, `flowryn cancel ${run.task_id}`],
      ...(whole && whole.reads.length > 0 ? { reportsRead: whole.reads } : {}),
    };
  },
  // The leader's read of a whole report closes its item (docs/notes/2026-10-14-auto-close-a-xn.md); nobody else's does.
  afterRead(ctx, result) {
    const reads = result.reportsRead ?? [];
    if (ctx.caller.role !== "leader" || reads.length === 0) return result;
    const closed = closeReadItems(ctx.db, ctx.caller, reads, ctx.now());
    if (closed.length === 0) return result;
    const data: Record<string, unknown> = { ...result.data, read: `closed ${closed.join(" ")}` };
    if (closed.includes(String(result.data.item))) data.state = "resolved";
    const hints = (result.hints ?? []).filter((h) => !closed.some((id) => h === `flowryn dismiss ${id}`));
    return { data, hints: hints.length > 0 ? hints : ["flowryn fleet"] };
  },
};

export const LEADER_RUN_VERBS: VerbSpec[] = [steer, answer, interrupt, cancel, resume, fleet, show];
