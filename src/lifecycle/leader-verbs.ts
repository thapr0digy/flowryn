import { FlowrynError } from "../api/errors.ts";
import { stringArg, type ReadCtx, type VerbSpec } from "../api/verbs.ts";
import { resolveItems, resolveRunItems } from "../attention/items.ts";
import { appendEvent } from "../db/events.ts";
import { recordIntent } from "../journal/journal.ts";
import { sanitizeBlock, sanitizeLine } from "../util/sanitize.ts";
import { cancelRun, findRun, getRun, isTerminal, taskTitle, type RunRow } from "./runs.ts";
import { createSteer, unackedSteers } from "./steers.ts";
import { openActionable } from "../attention/router.ts";
import { leaderTiming } from "../config/leader.ts";

function activeRunFor(db: ReadCtx["db"], ref: string): RunRow {
  const run = findRun(db, ref);
  if (!run) throw new FlowrynError("not_found", `no run or task ${ref}`, "flowryn fleet");
  if (isTerminal(run.state)) throw new FlowrynError("run_not_active", `the run for ${run.task_id} is ${run.state}`);
  return run;
}

/**
 * `flowryn steer <task|run> --body-file -`: words for a worker. Delivered by
 * its hooks or extension, mid-turn or on the next idle wake, and re-rung until
 * the worker acknowledges it (design section 6).
 */
const steer: VerbSpec = {
  name: "steer",
  summary: "Send a worker a steer; it is delivered at its next tool call or idle wake",
  positionals: [{ name: "target", required: true, help: "task or run id" }],
  flags: { "body-file": { type: "string", help: "the steer, from a file or - for stdin", fileFor: "body" } },
  kind: "mutation",
  roles: ["leader", "human"],
  apply(ctx, args) {
    const run = activeRunFor(ctx.db, stringArg(args, "target")!);
    const body = sanitizeBlock(stringArg(args, "body") ?? "").trim();
    if (body.length === 0) throw new FlowrynError("bad_args", "the steer goes in --body-file -");
    const message = createSteer(ctx.db, run, body, ctx.now());
    return { data: { steer: message.id, run: run.id, task: run.task_id, liveness: run.liveness }, hints: [`flowryn show ${run.task_id}`] };
  },
  async settle(ctx, result) {
    ctx.fleet.bus.notify(String(result.data.run));
    return result;
  },
};

interface DecisionRow {
  id: string;
  task_id: string;
  run_id: string | null;
  question: string;
  options: string;
  blocking: number;
  state: string;
}

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
    const decision = ctx.db.query("SELECT * FROM decisions WHERE id = ?1").get(id) as DecisionRow | null;
    if (!decision) throw new FlowrynError("not_found", `no decision ${id}`, "flowryn fleet");
    if (decision.state !== "open") throw new FlowrynError("bad_args", `decision ${id} is already ${decision.state}`);
    const options = JSON.parse(decision.options) as string[];
    if (!options.includes(choice)) throw new FlowrynError("bad_args", `choice must be one of: ${options.join(", ")}`);
    const now = ctx.now();
    const note = sanitizeBlock(stringArg(args, "body") ?? "").trim();
    ctx.db.query("UPDATE decisions SET state = 'answered', answer = ?2, answered_via = ?3, answered_at = ?4 WHERE id = ?1").run(id, choice, ctx.caller.role, now);
    appendEvent(ctx.db, { source: "cli", kind: "decision.answered", runId: decision.run_id, taskId: decision.task_id, payload: { decision: id, choice, by: ctx.caller.role } });
    resolveItems(ctx.db, decision.blocking ? "worker_question_blocking" : "worker_question", decision.task_id, `decision.answered ${id}`, now);
    if (decision.blocking) recordIntent(ctx.db, { file: "backlog", verb: "unhold", taskId: decision.task_id, positional: [decision.task_id], now });
    const run = decision.run_id ? getRun(ctx.db, decision.run_id) : null;
    let steerId: string | null = null;
    if (run && !isTerminal(run.state)) {
      const text = `Answer to your question ${id} ("${sanitizeLine(decision.question, 100)}"): ${choice}.${note ? ` ${note}` : ""}`;
      steerId = createSteer(ctx.db, run, text, now, id).id;
    }
    return { data: { decision: id, answer: choice, steer: steerId ?? "-", run: run?.id ?? "-" } };
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
    const run = getRun(ctx.db, runId);
    const runtime = ctx.fleet.runtime();
    if (run?.workspace_id && runtime) await runtime.closeWorkspace(run.workspace_id).catch(() => undefined);
    return result;
  },
};

/**
 * `flowryn resume <task|run>`: start a dead worker again from its stored
 * session, in the same worktree. The reconciler does this once by itself;
 * after a second death it is yours to call (design section 6).
 */
const resume: VerbSpec = {
  name: "resume",
  summary: "Resume a dead worker from its stored session, in the same worktree",
  positionals: [{ name: "target", required: true, help: "task or run id" }],
  flags: {},
  kind: "mutation",
  roles: ["leader", "human"],
  apply(ctx, args) {
    const run = findRun(ctx.db, stringArg(args, "target")!);
    if (!run) throw new FlowrynError("not_found", `no run or task ${stringArg(args, "target")}`);
    if (run.state === "cancelled" || run.state === "cleaned") throw new FlowrynError("run_not_active", `the run for ${run.task_id} is ${run.state}`);
    if (run.liveness !== "dead" && run.liveness !== "orphaned") throw new FlowrynError("bad_args", `the worker is ${run.liveness}, not dead`);
    if (!run.agent_session) throw new FlowrynError("bad_args", "the run has no stored session to resume");
    const now = ctx.now();
    ctx.db
      .query("UPDATE runs SET state = CASE WHEN state = 'failed' THEN 'running' ELSE state END, liveness = 'starting', resume_count = resume_count + 1, ended_at = NULL, updated_at = ?2 WHERE id = ?1")
      .run(run.id, now);
    if (run.state === "failed") {
      // failRun parked the task; take it back to In flight.
      recordIntent(ctx.db, { file: "backlog", verb: "unhold", taskId: run.task_id, positional: [run.task_id], now });
      recordIntent(ctx.db, { file: "backlog", verb: "start", taskId: run.task_id, positional: [run.task_id], now });
    }
    resolveRunItems(ctx.db, run.id, ["failure_needs_you"], "run.resume_requested", now);
    appendEvent(ctx.db, { source: "cli", kind: "run.resume_requested", runId: run.id, taskId: run.task_id, payload: { by: ctx.caller.role, resume: run.resume_count + 1 } });
    return { data: { run: run.id, task: run.task_id, state: "resuming" }, hints: [`flowryn show ${run.task_id}`] };
  },
  async settle(ctx, result) {
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
  if (run.state === "ready") return run.kind === "scout" ? "read" : "merge";
  return "-";
}

const MAX_FLEET_ROWS = 20;
const MAX_NEEDS_ROWS = 10;

/** `flowryn fleet`: every open run and today's finished ones, at most 20 rows (design section 12). */
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
      live: r.liveness,
      age: age(ctx.now, r.started_at),
      needs: needs(ctx, r),
    }));
    const lanes = ctx.db.query("SELECT lane, COUNT(*) AS n FROM items WHERE state IN ('open','presented') GROUP BY lane").all() as { lane: string; n: number }[];
    const count = (lane: string) => lanes.find((l) => l.lane === lane)?.n ?? 0;
    const data: Record<string, unknown> = { fleet: list, open: `P0 ${count("P0")} · P1 ${count("P1")}` };
    if (rows.length > MAX_FLEET_ROWS) data.more = `${rows.length - MAX_FLEET_ROWS} older rows not shown`;
    // Every open actionable item, P0 first: fleet lists what needs you, like every briefing (design section 9).
    const waiting = openActionable(ctx.db, ctx.now, leaderTiming(ctx.config).age_ms);
    if (waiting.length > 0) {
      data.needs = waiting.slice(0, MAX_NEEDS_ROWS).map((i) => ({ id: i.id, lane: i.lane, line: sanitizeLine(i.line, 120) }));
      if (waiting.length > MAX_NEEDS_ROWS) data.needs_more = `${waiting.length - MAX_NEEDS_ROWS} more: flowryn board`;
    }
    return { data, hints: list.length > 0 ? ["flowryn show <id>", "flowryn steer <id> --body-file -"] : ["flowryn dispatch <project> --kind scout --body-file -"] };
  },
};

/** `flowryn show <task|run>`: one run in detail, at most about 40 lines. */
const show: VerbSpec = {
  name: "show",
  summary: "One task or run in detail: state, evidence, steers, questions, recent events",
  positionals: [{ name: "target", required: true, help: "task, run or item id" }],
  flags: {},
  kind: "read",
  roles: ["leader", "reader", "human"],
  read(ctx, args) {
    let target = stringArg(args, "target")!;
    const item = ctx.db.query("SELECT * FROM items WHERE id = ?1").get(target) as { task_id: string | null; run_id: string | null; line: string; lane: string; state: string } | null;
    if (item) target = item.run_id ?? item.task_id ?? target;
    const run = findRun(ctx.db, target) as FleetRow | null;
    if (!run) {
      if (item) return { data: { item: target, lane: item.lane, state: item.state, line: item.line } };
      throw new FlowrynError("not_found", `no task, run or item ${target}`, "flowryn fleet");
    }
    const policy = ctx.db.query("SELECT project_id, kind FROM task_policy WHERE task_id = ?1").get(run.task_id) as { project_id: string; kind: string };
    const steers = unackedSteers(ctx.db, run.id).map((m) => ({ id: m.id, rings: m.rings, body: sanitizeLine(m.body, 80) }));
    const decisions = (ctx.db.query("SELECT id, state, question, answer FROM decisions WHERE run_id = ?1 ORDER BY id").all(run.id) as {
      id: string;
      state: string;
      question: string;
      answer: string | null;
    }[]).map((d) => ({ id: d.id, state: d.state, question: sanitizeLine(d.question, 80), answer: d.answer ?? "-" }));
    const items = (ctx.db.query("SELECT id, lane, line FROM items WHERE run_id = ?1 AND state IN ('open','presented') ORDER BY opened_at").all(run.id) as {
      id: string;
      lane: string;
      line: string;
    }[]).map((i) => ({ id: i.id, lane: i.lane, line: sanitizeLine(i.line, 100) }));
    const artifacts = (ctx.db.query("SELECT kind, ref FROM artifacts WHERE task_id = ?1 ORDER BY created_at").all(run.task_id) as { kind: string; ref: string }[]).map(
      (a) => `${a.kind}: ${a.ref}`,
    );
    const events = (ctx.db.query("SELECT ts, kind FROM events WHERE run_id = ?1 ORDER BY seq DESC LIMIT 8").all(run.id) as { ts: number; kind: string }[])
      .toReversed()
      .map((e) => `${age(ctx.now, e.ts)} ago ${e.kind}`);
    return {
      data: {
        task: run.task_id,
        title: taskTitle(ctx.db, run.task_id),
        run: run.id,
        kind: policy.kind,
        project: policy.project_id,
        harness: `${run.harness} ${run.harness_version}`,
        state: run.state,
        liveness: run.liveness,
        pane: run.pane_id ?? "-",
        pid: run.proc_pid ?? "-",
        resumes: run.resume_count,
        worktree: run.worktree_path,
        branch: run.branch,
        artifacts,
        steers,
        decisions,
        items,
        events,
      },
      hints: [`flowryn steer ${run.task_id} --body-file -`, `flowryn cancel ${run.task_id}`],
    };
  },
};

export const LEADER_RUN_VERBS: VerbSpec[] = [steer, answer, interrupt, cancel, resume, fleet, show];
