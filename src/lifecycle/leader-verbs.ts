import { FlowrynError } from "../api/errors.ts";
import { awayLine, getAway } from "../attention/away.ts";
import { boolArg, stringArg, type ReadCtx, type VerbSpec } from "../api/verbs.ts";
import { resolveRunItems } from "../attention/items.ts";
import { appendEvent } from "../db/events.ts";
import { recordIntent } from "../journal/journal.ts";
import { sanitizeBlock, sanitizeLine } from "../util/sanitize.ts";
import { answerDecision, captainChannel, decisionView } from "./decision-verbs.ts";
import { getGrant, grantLines, grantView } from "../policy/grants.ts";
import { getDecision } from "./decisions.ts";
import { cancelRun, findRun, getRun, isTerminal, taskTitle, type RunRow } from "./runs.ts";
import { createSteer, recentSteers, steerBrief, steerStatus } from "./steers.ts";
import { openActionable } from "../attention/router.ts";
import { leaderTiming } from "../config/leader.ts";
import { deliveredOf, prEvidence } from "./delivery.ts";
import { capacityConfig, WORKER_POOL } from "../config/workflows.ts";
import { holdsLease, liveCounts, runLeases } from "../sched/pools.ts";
import { phaseOfTask } from "./plans.ts";
import { planView } from "./dispatch.ts";
import { flowLine, gatesOf, runWorkflow } from "./stages.ts";
import { gateHarness, harnessRefusal } from "./harness-gate.ts";
import { divergenceView, getDivergence, resolveCommand } from "../reconcile/divergence.ts";
import { latestMerge } from "../policy/merge.ts";
import { queuedAge, queuedTask, queuedWork, waitsCell, type QueuedTask } from "./queue-view.ts";
import { ShowText } from "./show-text.ts";

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
  positionals: [{ name: "target", required: true, help: "task or run id" }],
  flags: {
    "body-file": { type: "string", help: "the steer, from a file or - for stdin", fileFor: "body" },
    urgent: { type: "boolean", help: "block the worker's next tool call with it, and cut a tool running over 3s (its work is lost)" },
    "end-turn": { type: "boolean", help: "the steer tells the worker to end its turn (wait, or just informs): no turn-end reminder follows" },
  },
  kind: "mutation",
  roles: ["leader", "human"],
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
    { name: "decision", required: true, help: "decision id, such as q3" },
    { name: "choice", required: true, help: "one of the question's options" },
  ],
  flags: { "body-file": { type: "string", help: "anything to add, from a file or - for stdin", fileFor: "body" } },
  kind: "mutation",
  roles: ["leader", "human"],
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
 * cleanup guard's job (M4).
 */
const cancel: VerbSpec = {
  name: "cancel",
  summary: "Stop a worker and park its task (the worktree is kept)",
  positionals: [{ name: "target", required: true, help: "task or run id" }],
  flags: { reason: { type: "string", help: "one line, for the backlog hold", placeholder: "text" } },
  kind: "mutation",
  roles: ["leader", "human"],
  async prepare(ctx, args) {
    const run = activeRunFor(ctx.db, stringArg(args, "target")!);
    const exited = await ctx.fleet.exitRun(run.id);
    if (!exited.ok) throw new FlowrynError("internal", `the worker for ${run.task_id} did not exit (${exited.detail ?? exited.evidence}); nothing was cancelled`);
    return { exited };
  },
  apply(ctx, args, prepared) {
    const run = activeRunFor(ctx.db, stringArg(args, "target")!);
    const reason = stringArg(args, "reason") ?? `by ${ctx.caller.role}`;
    cancelRun(ctx.db, run, reason, "cli", ctx.now());
    return { data: { run: run.id, task: run.task_id, state: "cancelled", exited: (prepared as { exited: { evidence: string } }).exited.evidence } };
  },
  async settle(ctx, result) {
    const runId = String(result.data.run);
    ctx.fleet.bus.forget(runId);
    ctx.sched.kick();
    const run = getRun(ctx.db, runId);
    const runtime = ctx.fleet.runtime();
    if (run?.workspace_id && runtime) await runtime.closeWorkspace(run.workspace_id).catch(() => undefined);
    return result;
  },
};

/** A run whose dead worker can be resumed from its stored session. */
function resumable(db: ReadCtx["db"], target: string): RunRow {
  const run = findRun(db, target);
  if (!run) throw new FlowrynError("not_found", `no run or task ${target}`);
  if (run.state === "cancelled" || run.state === "cleaned") throw new FlowrynError("run_not_active", `the run for ${run.task_id} is ${run.state}`);
  if (run.cleanup === "done") throw new FlowrynError("run_not_active", `the run for ${run.task_id} is cleaned up: its worktree is gone`, `dispatch ${run.task_id} again`);
  if (run.liveness !== "dead" && run.liveness !== "orphaned") throw new FlowrynError("bad_args", `the worker is ${run.liveness}, not dead`);
  if (!run.agent_session) throw new FlowrynError("bad_args", "the run has no stored session to resume");
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
  positionals: [{ name: "target", required: true, help: "task or run id" }],
  flags: {},
  kind: "mutation",
  roles: ["leader", "human"],
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
    ctx.db
      .query("UPDATE runs SET state = CASE WHEN state = 'failed' THEN 'running' ELSE state END, liveness = 'starting', resume_count = resume_count + 1, ended_at = NULL, updated_at = ?2 WHERE id = ?1")
      .run(run.id, now);
    // A dead worker holds no slot (design section 11): the scheduler grants its worker slot, and its stage's pools, first.
    const viaScheduler = !holdsLease(ctx.db, run.id, WORKER_POOL);
    if (viaScheduler) ctx.db.query("UPDATE runs SET pending_launch = 'resume', waiting_since = ?2 WHERE id = ?1").run(run.id, now);
    if (run.state === "failed") {
      // failRun parked the task; take it back to In flight.
      recordIntent(ctx.db, { file: "backlog", verb: "unhold", taskId: run.task_id, positional: [run.task_id], now });
      recordIntent(ctx.db, { file: "backlog", verb: "start", taskId: run.task_id, positional: [run.task_id], now });
    }
    resolveRunItems(ctx.db, run.id, ["failure_needs_you"], "run.resume_requested", now);
    appendEvent(ctx.db, { source: "cli", kind: "run.resume_requested", runId: run.id, taskId: run.task_id, payload: { by: ctx.caller.role, resume: run.resume_count + 1, via_scheduler: viaScheduler } });
    return { data: { run: run.id, task: run.task_id, state: "resuming" }, hints: [`flowryn show ${run.task_id}`] };
  },
  async settle(ctx, result) {
    const row = ctx.db.query("SELECT pending_launch FROM runs WHERE id = ?1").get(String(result.data.run)) as { pending_launch: string | null } | null;
    if (row?.pending_launch === "resume") {
      await ctx.sched.passNow();
      const after = ctx.db.query("SELECT pending_launch FROM runs WHERE id = ?1").get(String(result.data.run)) as { pending_launch: string | null } | null;
      return after?.pending_launch === "resume" ? { data: { ...result.data, state: "waiting for capacity" }, hints: ["flowryn capacity"] } : result;
    }
    ctx.fleet.launch(String(result.data.run), "resume");
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
  positionals: [{ name: "target", required: true, help: "task or run id" }],
  flags: {},
  kind: "mutation",
  roles: ["leader", "human"],
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
  }
  const pr = prEvidence(ctx.db, run.id);
  if (pr) {
    view.pr_state = pr.draft ? `${pr.state} (draft)` : pr.state;
    view.head_now = pr.head.slice(0, 12);
    view.checks = pr.checks?.line ?? "unknown";
    view.seen = `${age(ctx.now, pr.observed_at)} ago`;
  }
  const merge = latestMerge(ctx.db, run.task_id);
  if (merge) {
    const approval = ctx.db.query("SELECT channel, actor FROM approvals WHERE id = ?1").get(merge.approval_id) as { channel: string; actor: string } | null;
    view.merge = `${merge.id} ${merge.state}${merge.merge_sha ? ` at ${merge.merge_sha.slice(0, 12)}` : ""} via ${approval?.channel ?? "?"}${merge.detail ? ` (${sanitizeLine(merge.detail, 100)})` : ""}`;
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
  return gates.slice(-5).map((g) => `${g.id} ${g.kind} ${g.stage}: ${g.state}${g.review_url ? ` ${sanitizeLine(g.review_url, 100)}` : ""}${g.page_path && g.state === "open" ? ` page ${sanitizeLine(g.page_path, 200)}` : ""}${g.feedback ? ` ("${sanitizeLine(g.feedback, 60)}")` : ""}`);
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
  read(ctx) {
    const rows = ctx.db
      .query(
        `SELECT r.*, p.project_id, p.kind FROM runs r JOIN task_policy p ON p.task_id = r.task_id
         WHERE r.state NOT IN ('cleaned','failed','cancelled') OR r.updated_at > ?1
         ORDER BY r.started_at DESC`,
      )
      .all(ctx.now - 86_400_000) as FleetRow[];
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
    const lanes = ctx.db.query("SELECT lane, COUNT(*) AS n FROM items WHERE state IN ('open','presented') GROUP BY lane").all() as { lane: string; n: number }[];
    const count = (lane: string) => lanes.find((l) => l.lane === lane)?.n ?? 0;
    const data: Record<string, unknown> = { fleet: list, open: `P0 ${count("P0")} · P1 ${count("P1")}`, capacity: capacityLine(ctx) };
    if (rows.length > MAX_FLEET_ROWS) data.more = `${rows.length - MAX_FLEET_ROWS} older rows not shown`;
    const away = getAway(ctx.db, ctx.now);
    if (away) data.away = awayLine(away, ctx.now);
    const queued = queuedWork(ctx.db);
    if (queued.length > 0) {
      data.queued = queued.slice(0, MAX_QUEUED_ROWS).map((q) => queuedRow(ctx, q));
      if (queued.length > MAX_QUEUED_ROWS) data.queued_more = `${queued.length - MAX_QUEUED_ROWS} more queued: backlog.md`;
    }
    // Every open actionable item, P0 first: fleet lists what needs you, like every briefing (design section 9).
    const waiting = openActionable(ctx.db, ctx.now, leaderTiming(ctx.config).age_ms);
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
      waits: q.waits,
      hold: text.line(hold, 120),
      ...(q.plan ? { plan: `${q.plan.id} phase ${q.plan.phase} of ${q.plan.of}: ${text.line(q.plan.title, 80)}` } : {}),
      filed: filedLine(ctx, q),
      body: text.block(q.body, QUEUED_BODY_LINES, 120),
      runs,
      events,
      ...text.pointer(q.id),
    },
    hints: queuedHints(q),
  };
}

/** A worker_report item in `show`: the report itself, with the whole body its event keeps. */
function workerReportView(
  ctx: ReadCtx,
  id: string,
  item: { event_seq: number; task_id: string | null; run_id: string | null; lane: string; state: string; opened_at: number },
): { data: Record<string, unknown>; hints: string[] } {
  const event = ctx.db.query("SELECT payload FROM events WHERE seq = ?1").get(item.event_seq) as { payload: string } | null;
  const payload = event ? (JSON.parse(event.payload) as { status?: string; body?: string }) : {};
  const open = item.state === "open" || item.state === "presented";
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
  };
}

/** The chat-answer grants of an item or a task (its gates and merges), when there are any. */
function grantsField(ctx: ReadCtx, where: { item?: string; task?: string }): { grants?: string[] } {
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

/** `flowryn show <task|run>`: one run in detail, at most about 40 lines; --full prints every title, line and body whole. */
const show: VerbSpec = {
  name: "show",
  summary: "One task, run, item, decision, plan, divergence, review gate or chat-answer grant in detail; --full for untruncated text",
  positionals: [{ name: "target", required: true, help: "task, run, item, decision, plan, divergence, gate (g<N>) or grant (c<N>) id" }],
  flags: { full: { type: "boolean", help: "untruncated titles, lines and bodies" } },
  kind: "read",
  roles: ["leader", "reader", "human"],
  read(ctx, args) {
    const asked = stringArg(args, "target")!;
    let target = asked;
    const text = new ShowText(boolArg(args, "full"));
    if (/^[kq]\d+$/.test(target)) {
      const d = getDecision(ctx.db, target);
      if (d) return { data: { ...decisionView(d, text), ...grantsField(ctx, { item: d.id }), ...text.pointer(asked) }, hints: d.state === "open" ? [`flowryn decide ${d.id} <choice> --rationale <why>`] : ["flowryn decision list"] };
    }
    const grant = /^c\d+$/.test(target) ? getGrant(ctx.db, target) : null;
    if (grant) return { data: grantView(grant, ctx.now), hints: [`flowryn show ${grant.item.replace(/^merge:/, "")}`] };
    // A review gate shows as its task, whose gates and grants it lists.
    const gateRun = /^g\d+$/.test(target) ? (ctx.db.query("SELECT run_id FROM gates WHERE id = ?1").get(target) as { run_id: string } | null) : null;
    if (gateRun) target = gateRun.run_id;
    const plan = /^p\d+$/.test(target) ? planView(ctx.db, target, text.full) : null;
    if (plan) return { data: plan, hints: text.full ? ["flowryn fleet"] : ["flowryn fleet", `flowryn show ${target} --full`] };
    const divergence = /^d\d+$/.test(target) ? getDivergence(ctx.db, target) : null;
    if (divergence) return { data: { ...divergenceView(divergence), ...grantsField(ctx, { item: divergence.id }) }, hints: divergence.resolved_at === null ? [resolveCommand(divergence)] : ["flowryn fleet"] };
    const item = ctx.db.query("SELECT * FROM items WHERE id = ?1").get(target) as {
      kind: string;
      event_seq: number;
      task_id: string | null;
      run_id: string | null;
      line: string;
      full_line: string | null;
      lane: string;
      state: string;
      opened_at: number;
    } | null;
    if (item?.kind === "worker_report") return workerReportView(ctx, target, item);
    if (item) target = item.run_id ?? item.task_id ?? target;
    const run = findRun(ctx.db, target) as FleetRow | null;
    if (!run) {
      if (item) return { data: { item: target, lane: item.lane, state: item.state, line: text.stored(item.line, item.full_line, Number.POSITIVE_INFINITY), ...text.pointer(asked) } };
      const queued = queuedTask(ctx.db, target);
      if (queued) return queuedView(ctx, queued, text);
      const phase = phaseOfTask(ctx.db, target);
      if (phase) return { data: { task: target, title: phase.title, plan: `${phase.plan_id} phase ${phase.phase_no} of ${phase.phases}`, ...planView(ctx.db, phase.plan_id, text.full) }, hints: [`flowryn show ${phase.plan_id}`] };
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
    return {
      data: {
        task: run.task_id,
        title: text.line(taskTitle(ctx.db, run.task_id), 120),
        run: run.id,
        kind: policy.kind,
        project: policy.project_id,
        mode: policy.mode_reason ? `${policy.delivery_mode} (${policy.mode_reason})` : policy.delivery_mode,
        harness: `${run.harness} ${run.harness_version}`,
        state: run.state,
        liveness: run.liveness,
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
        artifacts,
        ...(deliveryView(ctx, run) ? { delivery: deliveryView(ctx, run) } : {}),
        steers,
        decisions,
        ...(report ? { report } : {}),
        items,
        events,
        ...text.pointer(asked),
      },
      hints: run.state === "ready" && policy.kind === "ship" ? [`flowryn merge ${run.task_id}`, `flowryn decline ${run.task_id} --body-file -`] : [`flowryn steer ${run.task_id} --body-file -`, `flowryn cancel ${run.task_id}`],
    };
  },
};

export const LEADER_RUN_VERBS: VerbSpec[] = [steer, answer, interrupt, cancel, resume, fleet, show];
