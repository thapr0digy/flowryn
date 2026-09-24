import { FlowrynError } from "../api/errors.ts";
import { boolArg, stringArg, type HandlerCtx, type HandlerResult, type VerbSpec } from "../api/verbs.ts";
import { resolveRunItems } from "../attention/items.ts";
import { tx, type Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { checksLine } from "../forge/types.ts";
import { deliveredOf } from "../lifecycle/delivery.ts";
import { landRun } from "../lifecycle/landing.ts";
import { getProject, type ProjectRow } from "../lifecycle/projects.ts";
import { findRun, getRunWithPolicy, isTerminal, taskTitle, type RunWithPolicy } from "../lifecycle/runs.ts";
import { createSteer } from "../lifecycle/steers.ts";
import { consumeApproval, findAttempt, findHumanApproval, insertApproval, matchAttempt, voidApprovals, type ApprovalRow } from "./approvals.ts";
import {
  checkGate,
  chooseApproval,
  executeMerge,
  gatherFacts,
  latestMerge,
  recordMergeRequest,
  recordMergeResult,
  rememberFacts,
  takeApproval,
  targetOf,
  type ChoiceResult,
  type GateResult,
  type MergeContext,
  type MergeFacts,
  type MergeRow,
} from "./merge.ts";

/**
 * The M4 verbs (design sections 7 and 12): `merge` through the merge gate,
 * `decline` a delivery, `cleanup` a worktree through the cleanup guard, and
 * the two internal verbs behind `flowryn approve` and the board's approve
 * key, which bind a /dev/tty challenge to exactly what you were shown.
 */

export function mergeContext(ctx: HandlerCtx): MergeContext {
  return { db: ctx.db, forge: ctx.delivery.forge(), git: ctx.delivery.git, github: ctx.delivery.github(), now: ctx.now };
}

/** The run a task (or run id) names, with its project; any state. */
export function runAndProject(db: Db, target: string): { run: RunWithPolicy; project: ProjectRow } {
  const found = findRun(db, target);
  const run = found ? getRunWithPolicy(db, found.id) : null;
  if (!run) throw new FlowrynError("not_found", `no task or run ${target}`, "flowryn fleet");
  const project = getProject(db, run.project_id);
  if (!project) throw new FlowrynError("not_found", `project ${run.project_id} is gone`);
  return { run, project };
}

/** What a merge would land, in a few lines: for your confirm, your prompt and `approve`. */
export function mergeSummary(facts: MergeFacts): Record<string, unknown> {
  const pr = facts.pr;
  const checks = facts.checks;
  return {
    task: facts.run.task_id,
    title: facts.title,
    project: facts.project.id,
    kind: facts.delivered.kind,
    target: facts.delivered.kind === "pr" ? facts.delivered.ref : `${facts.run.branch} into local ${facts.project.default_branch}`,
    head: facts.head,
    state: pr ? pr.state : facts.run.state,
    checks: checks ? checksLine(checks) : facts.delivered.kind === "local" ? "none (local-only)" : "unknown",
    red: checks ? checks.checks.filter((c) => c.state === "red").map((c) => c.name) : [],
    sensitive: facts.run.sensitive === 1,
  };
}

// --- merge ----------------------------------------------------------------------------------

/** Merges whose settle is asking GitHub now, so a replayed call never asks twice. */
const executing = new Set<string>();

interface MergePrepared {
  facts: MergeFacts;
  gate: GateResult;
  chosen: ChoiceResult;
}

async function mergeable(ctx: HandlerCtx, target: string): Promise<{ run: RunWithPolicy; project: ProjectRow }> {
  const { run, project } = runAndProject(ctx.db, target);
  if (run.kind !== "ship") throw new FlowrynError("not_ready", `${run.task_id} is a scout; scouts deliver a report, not a merge`);
  if (run.state === "merging") {
    const last = latestMerge(ctx.db, run.task_id);
    if (last && (last.state === "requested" || ctx.delivery.inFlight.has(last.id))) throw new FlowrynError("merge_in_flight", `merge ${last.id} of ${run.task_id} is in flight`, `flowryn show ${run.task_id}`);
  } else if (run.state === "landed" || run.state === "cleaned") {
    throw new FlowrynError("not_ready", `${run.task_id} is already ${run.state}`, `flowryn show ${run.task_id}`);
  } else if (run.state !== "ready") {
    throw new FlowrynError("not_ready", `${run.task_id} is ${run.state}, not ready to merge`, `flowryn show ${run.task_id}`);
  }
  return { run, project };
}

const merge: VerbSpec = {
  name: "merge",
  summary: "Merge a delivered ship through the merge gate; it counts only once the merge is proven",
  positionals: [{ name: "task", required: true, help: "task or run id" }],
  flags: {
    head: { type: "string", help: "Pi leader extension: the head its confirm showed you", placeholder: "sha" },
    "key-file": { type: "string", help: "Pi leader extension only: its approval key, from stdin", fileFor: "approval_key" },
  },
  kind: "mutation",
  roles: ["leader", "human"],
  // The gate reads GitHub, the merge asks it and reads the proof back.
  replyMs: 120_000,
  async prepare(ctx, args): Promise<MergePrepared> {
    const task = stringArg(args, "task")!;
    const { run, project } = await mergeable(ctx, task);
    const facts = await gatherFacts(mergeContext(ctx), run, project);
    const chosen = chooseApproval(ctx.db, facts, { caller: ctx.caller, approvalKey: stringArg(args, "approval_key")?.trim(), head: stringArg(args, "head") }, "merge", ctx.now());
    // The attempt the Claude hook recorded is matched by the task as you typed it.
    if (!chosen.choice && ctx.caller.role === "leader" && ctx.caller.session && task !== run.task_id) {
      const attempt = findAttempt(ctx.db, { session: ctx.caller.session, action: "merge", task, now: ctx.now() });
      if (attempt && (!attempt.head_sha || attempt.head_sha === facts.head)) chosen.choice = { kind: "attempt", attempt, session: ctx.caller.session };
    }
    const gate = checkGate(facts, chosen);
    return { facts, gate, chosen };
  },
  apply(ctx, _args, prepared) {
    const { facts, gate, chosen } = prepared as MergePrepared;
    const now = ctx.now();
    const run = getRunWithPolicy(ctx.db, facts.run.id)!;
    rememberFacts(ctx.db, facts, now);
    if (gate.alreadyMerged) {
      landRun(ctx.db, run, { mergeSha: facts.pr!.mergeSha ?? facts.head, how: "merged_elsewhere" }, now);
      return { data: { task: run.task_id, run: run.id, state: "landed", merged: "already", sha: facts.pr!.mergeSha ?? "-" }, hints: [`flowryn show ${run.task_id}`] };
    }
    if (run.state !== "ready" && run.state !== "merging") throw new FlowrynError("not_ready", `${run.task_id} is ${run.state}`);
    const channel = chosen.choice!.kind === "row" ? chosen.choice!.row.channel : chosen.choice!.kind === "attempt" ? "claude-ask" : chosen.choice!.kind === "key" ? "pi-confirm" : "yolo";
    const approval = takeApproval(ctx.db, facts, chosen.choice!, "merge", now);
    const mergeId = recordMergeRequest(ctx.db, facts, approval, channel, gate.waived, ctx.delivery.github().merge_method, now);
    // In flight from here: the watcher leaves a requested merge alone until this daemon has asked GitHub.
    ctx.delivery.inFlight.add(mergeId);
    return { data: { task: run.task_id, run: run.id, merge: mergeId, head: facts.head, approval, channel, waived: gate.waived ?? "-", state: "merging" } };
  },
  async settle(ctx, result) {
    const runId = String(result.data.run ?? "");
    if (result.data.merged === "already") {
      void ctx.delivery.cleanup(runId, { discardApproval: null, auto: true }).catch((error: unknown) => ctx.log(`cleanup ${runId}: ${(error as Error).message}`));
      return result;
    }
    const mergeId = String(result.data.merge ?? "");
    let row = ctx.db.query("SELECT * FROM merges WHERE id = ?1").get(mergeId) as MergeRow | null;
    if (!row) throw new FlowrynError("internal", `merge ${mergeId} is gone`);
    if (row.state === "requested" && ctx.delivery.inFlight.has(mergeId) && !executing.has(mergeId)) {
      executing.add(mergeId);
      try {
        const { run, project } = runAndProject(ctx.db, runId);
        const outcome = await executeMerge(mergeContext(ctx), targetOf(row, project, `${taskTitle(ctx.db, run.task_id)} (${run.task_id})`));
        tx(ctx.db, () => recordMergeResult(ctx.db, getRunWithPolicy(ctx.db, runId)!, mergeId, outcome, ctx.now()));
      } finally {
        executing.delete(mergeId);
        ctx.delivery.inFlight.delete(mergeId);
      }
      row = ctx.db.query("SELECT * FROM merges WHERE id = ?1").get(mergeId) as MergeRow;
      if (row.state === "merged") void ctx.delivery.cleanup(runId, { discardApproval: null, auto: true }).catch((error: unknown) => ctx.log(`cleanup ${runId}: ${(error as Error).message}`));
    }
    ctx.delivery.watch(runId);
    const data = { ...result.data, state: row.state, sha: row.merge_sha ?? "-", detail: row.detail ?? "-" };
    if (row.state === "refused") throw new FlowrynError("merge_refused", `merge ${mergeId} refused: ${row.detail ?? "no detail"}`, `flowryn show ${result.data.task}`);
    if (row.state === "unproven" || row.state === "requested") {
      throw new FlowrynError("not_landed", `merge ${mergeId} was requested but is not proven (${row.detail ?? "no answer yet"}); the task is not landed and flowrynd keeps checking`, `flowryn show ${result.data.task}`);
    }
    return { data: { ...data, cleanup: "running" }, hints: [`flowryn show ${result.data.task}`] };
  },
};

// --- decline ------------------------------------------------------------------------------------

const decline: VerbSpec = {
  name: "decline",
  summary: "Decline a delivered ship: the worker gets your words as a steer and delivers again",
  positionals: [{ name: "task", required: true, help: "task or run id" }],
  flags: { "body-file": { type: "string", help: "what to change, from a file or - for stdin", fileFor: "body" } },
  kind: "mutation",
  roles: ["leader", "human"],
  apply(ctx, args) {
    const { run } = runAndProject(ctx.db, stringArg(args, "task")!);
    if (run.state !== "ready") throw new FlowrynError("not_ready", `${run.task_id} is ${run.state}; only a delivered, unmerged ship can be declined`);
    const now = ctx.now();
    const note = (stringArg(args, "body") ?? "").trim();
    const delivered = deliveredOf(ctx.db, run.task_id);
    ctx.db.query("UPDATE runs SET state = 'running', updated_at = ?2 WHERE id = ?1").run(run.id, now);
    voidApprovals(ctx.db, run.task_id, now, "the delivery was declined");
    resolveRunItems(ctx.db, run.id, ["pr_ready", "sensitive_action_waiting", "checks_red", "pr_closed"], "run.declined", now);
    appendEvent(ctx.db, { source: "cli", kind: "run.declined", runId: run.id, taskId: run.task_id, payload: { by: ctx.caller.role, ref: delivered?.ref ?? null, head: delivered?.head ?? null }, ts: now });
    const text = `Your delivery ${delivered ? `(${delivered.ref} at ${delivered.head.slice(0, 8)}) ` : ""}was declined.${note ? ` ${note}` : " Ask your leader what to change."} Change it, then deliver again.`;
    const steer = createSteer(ctx.db, run, text, now);
    return { data: { task: run.task_id, run: run.id, state: "running", steer: steer.id } };
  },
  async settle(ctx, result) {
    ctx.fleet.bus.notify(String(result.data.run));
    return result;
  },
};

// --- cleanup --------------------------------------------------------------------------------------

/** What a discard approval binds to: the worktree's branch and its HEAD when you approved. */
export function discardRef(run: RunWithPolicy): string {
  return `discard:${run.branch}`;
}

async function worktreeHead(ctx: HandlerCtx, run: RunWithPolicy): Promise<string> {
  const head = await ctx.delivery.git(["rev-parse", "HEAD"], run.worktree_path);
  return head.code === 0 ? head.stdout.trim() : "none";
}

const cleanup: VerbSpec = {
  name: "cleanup",
  summary: "Remove a landed, cancelled or failed task's worktree, through the cleanup guard (--discard needs your approval)",
  positionals: [{ name: "task", required: true, help: "task or run id" }],
  flags: { discard: { type: "boolean", help: "discard unlanded work (needs a human discard approval: flowryn approve <task> --discard)" } },
  kind: "mutation",
  roles: ["leader", "human"],
  replyMs: 120_000,
  async prepare(ctx, args) {
    const task = stringArg(args, "task")!;
    const { run } = runAndProject(ctx.db, task);
    if (run.cleanup === "done") throw new FlowrynError("not_ready", `${run.task_id}'s worktree was already removed`);
    if (!isTerminal(run.state) && run.state !== "landed") {
      throw new FlowrynError("not_ready", `${run.task_id} is ${run.state}; merge it or cancel it first`, `flowryn cancel ${run.task_id}`);
    }
    let discardApproval: string | null = null;
    if (boolArg(args, "discard")) {
      const head = await worktreeHead(ctx, run);
      const now = ctx.now();
      discardApproval = tx(ctx.db, () => {
        const row: ApprovalRow | null = findHumanApproval(ctx.db, { task: run.task_id, action: "discard", ref: discardRef(run), head, now });
        if (row) {
          consumeApproval(ctx.db, row.id, now, `discard ${run.task_id}`);
          return row.id;
        }
        const session = ctx.caller.role === "leader" ? ctx.caller.session : null;
        const attempt = session ? findAttempt(ctx.db, { session, action: "discard", task, now }) : null;
        if (!attempt || !session) return null;
        matchAttempt(ctx.db, attempt.id, now);
        const made = insertApproval(ctx.db, { task: run.task_id, ref: discardRef(run), head, channel: "claude-ask", actor: `${process.env.USER ?? "you"} (Claude prompt, leader ${session})`, action: "discard", now });
        consumeApproval(ctx.db, made.id, now, `discard ${run.task_id}`);
        return made.id;
      });
      if (!discardApproval) throw new FlowrynError("approval_required", `discarding ${run.task_id}'s work needs your approval for head ${head.slice(0, 8)}`, `in your shell: flowryn approve ${run.task_id} --discard`);
    }
    const report = await ctx.delivery.cleanup(run.id, { discardApproval, auto: false });
    if (report.outcome === "refused") throw new FlowrynError("cleanup_refused", `cleanup refused (${report.reason}): ${report.detail}`, report.reason === "dirty" || report.reason === "unlanded" || report.reason === "unpushed" ? `discard only with your approval: flowryn approve ${run.task_id} --discard` : `flowryn show ${run.task_id}`);
    return report;
  },
  apply(_ctx, _args, prepared) {
    const report = prepared as Awaited<ReturnType<HandlerCtx["delivery"]["cleanup"]>>;
    return {
      data: { task: report.task, run: report.run, state: report.state, removed: report.outcome === "removed", reason: report.reason, branch_deleted: report.branchDeleted, discarded_head: report.discardedHead ?? "-" },
    };
  },
};

// --- approve (behind `flowryn approve` and the board) -----------------------------------------------

interface BeginPrepared {
  challenge: { id: string; code: string };
  summary: Record<string, unknown>;
}

const approveBegin: VerbSpec = {
  name: "approve.begin",
  summary: "Start a /dev/tty approval: what you would approve, and the code to type back",
  positionals: [{ name: "task", required: true, help: "task or run id" }],
  flags: {
    "allow-red": { type: "string", help: "waive exactly this one failing check" },
    discard: { type: "boolean", help: "approve discarding unlanded work" },
    channel: { type: "string", help: "cli-tty or board" },
  },
  kind: "mutation",
  roles: ["human"],
  // The reply carries the challenge code: never kept in the reply table.
  ephemeral: true,
  async prepare(ctx, args): Promise<BeginPrepared> {
    const channel = stringArg(args, "channel") === "board" ? "board" : "cli-tty";
    const { run, project } = runAndProject(ctx.db, stringArg(args, "task")!);
    const now = ctx.now();
    if (boolArg(args, "discard")) {
      if (stringArg(args, "allow-red")) throw new FlowrynError("bad_args", "--allow-red belongs to a merge approval, not a discard");
      const head = await worktreeHead(ctx, run);
      const status = await ctx.delivery.git(["status", "--porcelain"], run.worktree_path);
      const dirty = status.code === 0 ? status.stdout.split("\n").filter(Boolean).length : -1;
      const challenge = ctx.delivery.challenges.create({ task: run.task_id, action: "discard", ref: discardRef(run), head, allowRed: null, channel }, now);
      return {
        challenge: { id: challenge.id, code: challenge.code },
        summary: { action: "discard", task: run.task_id, title: taskTitle(ctx.db, run.task_id), worktree: run.worktree_path, branch: run.branch, head, uncommitted: dirty < 0 ? "unknown" : dirty, state: run.state },
      };
    }
    if (run.kind !== "ship") throw new FlowrynError("not_ready", `${run.task_id} is a scout; there is nothing to merge`);
    if (run.state !== "ready" && run.state !== "merging") throw new FlowrynError("not_ready", `${run.task_id} is ${run.state}, not ready to merge`);
    const facts = await gatherFacts(mergeContext(ctx), run, project);
    if (facts.pr && facts.pr.state !== "open") throw new FlowrynError("pr_closed", `${facts.delivered.ref} is ${facts.pr.state}`);
    if (facts.head !== facts.delivered.head) throw new FlowrynError("head_moved", `the head moved from ${facts.delivered.head.slice(0, 8)} (delivered) to ${facts.head.slice(0, 8)}; nothing to approve until the worker delivers again`);
    const summary = mergeSummary(facts);
    const allowRed = stringArg(args, "allow-red") ?? null;
    if (allowRed) {
      const red = summary.red as string[];
      if (!red.includes(allowRed)) throw new FlowrynError("bad_args", `${allowRed} is not a failing check${red.length > 0 ? `; failing: ${red.join(", ")}` : "; no check is failing"}`);
      if (red.length > 1) throw new FlowrynError("red_checks", `${red.length} checks are failing (${red.join(", ")}); only one can be waived`);
    }
    const challenge = ctx.delivery.challenges.create({ task: run.task_id, action: "merge", ref: facts.ref, head: facts.head, allowRed, channel }, now);
    return { challenge: { id: challenge.id, code: challenge.code }, summary: { action: "merge", ...summary, waive: allowRed ?? "-" } };
  },
  apply(_ctx, _args, prepared) {
    const { challenge, summary } = prepared as BeginPrepared;
    return { data: { challenge: challenge.id, code: challenge.code, ...summary } };
  },
};

const approveConfirm: VerbSpec = {
  name: "approve.confirm",
  summary: "Finish a /dev/tty approval: the code you typed back",
  positionals: [],
  flags: {
    challenge: { type: "string", help: "the challenge id" },
    code: { type: "string", help: "the code you typed" },
    actor: { type: "string", help: "who you are ($USER)" },
  },
  kind: "mutation",
  roles: ["human"],
  apply(ctx, args): HandlerResult {
    const id = stringArg(args, "challenge") ?? "";
    const taken = ctx.delivery.challenges.take(id, stringArg(args, "code") ?? "", ctx.now());
    if (taken === "unknown") throw new FlowrynError("challenge_failed", "no such approval challenge (a daemon restart forgets them)", "run flowryn approve again");
    if (taken === "expired") throw new FlowrynError("challenge_failed", "the approval challenge expired", "run flowryn approve again");
    if (taken === "wrong") throw new FlowrynError("challenge_failed", "the code does not match; nothing was approved", "run flowryn approve again");
    const actor = (stringArg(args, "actor") ?? "").replace(/[^A-Za-z0-9._@-]/g, "").slice(0, 64) || "you";
    const row = insertApproval(ctx.db, { task: taken.task, ref: taken.ref, head: taken.head, channel: taken.channel, actor, action: taken.action, allowRed: taken.allowRed, now: ctx.now() });
    return {
      data: { approval: row.id, task: row.task_id, action: row.action, head: row.head_sha, channel: row.channel, waived: row.allow_red_check ?? "-", expires: new Date(row.expires_at).toISOString() },
      hints: row.action === "merge" ? [`flowryn merge ${row.task_id}`] : [`flowryn cleanup ${row.task_id} --discard`],
    };
  },
};

export const POLICY_VERBS: VerbSpec[] = [merge, decline, cleanup, approveBegin, approveConfirm];
