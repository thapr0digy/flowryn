import { FlowrynError } from "../api/errors.ts";
import { boolArg, stringArg, type HandlerCtx, type HandlerResult, type VerbSpec } from "../api/verbs.ts";
import { checksLine } from "../forge/types.ts";
import { deliveredOf } from "../lifecycle/delivery.ts";
import { deliveryBasis } from "../lifecycle/observed.ts";
import type { ProjectRow } from "../lifecycle/projects.ts";
import { findRun, isTerminal, taskTitle, type RunWithPolicy } from "../lifecycle/runs.ts";
import type { DiscardAttempt } from "../lifecycle/landing.ts";
import { discardRef, findAttempt, findHumanApproval, insertApproval } from "./approvals.ts";
import { prepareCaptainGrant } from "./grants.ts";
import { checkStage, gateRef, openReviewGate, recordGatePass, reviewedHead, stageStartedReply } from "./gates.ts";
import { pendingPlanLine } from "../lifecycle/plans.ts";
import { verificationLine } from "../verify/store.ts";
import { sendBack } from "../lifecycle/send-back.ts";
import { gateQuestionsLine, requireGateAnswered } from "../lifecycle/gate-questions.ts";
import { openUserActed } from "../attention/follow-up.ts";
import { channelOf, checkGate, chooseApproval, gatherFacts, standingApproval, type MergeFacts } from "./merge.ts";
import { requireDeliveryBasis } from "../lifecycle/observed.ts";
import { getRunWithPolicy } from "../lifecycle/runs.ts";
import { landingQueued } from "../verify/config.ts";
import { enqueueLanding, placeOf, queueable } from "../verify/landing-queue.ts";
import { applyMerge, mergeable, mergeContext, runAndProject, settleMerge, type MergePrepared } from "./merge-path.ts";

/**
 * The M4 verbs (design sections 7 and 12): `merge` through the merge gate,
 * `decline` a delivery, `cleanup` a worktree through the cleanup guard, and
 * the two internal verbs behind `flowryn approve` and the board's approve
 * key, which bind a /dev/tty challenge to exactly what you were shown.
 */

export { mergeContext, runAndProject };

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
    verify: verifyLine(facts),
  };
}

/** The local verify the gate will ask for, as the approver sees it: "v4 passed at fc2f76d7", "required, none at this head", or "none configured". */
export function verifyLine(facts: MergeFacts): string {
  const local = facts.local;
  if (!local || local.policy === null) return "none configured";
  if (local.atHead) return verificationLine(local.atHead);
  if (local.otherPolicyAtHead) return `required; ${local.otherPolicyAtHead.id} at this head ran under another verify policy`;
  return `required; none at ${facts.head.slice(0, 8)}${local.lastPassed ? ` (${local.lastPassed.id} passed at ${local.lastPassed.head_sha.slice(0, 8)})` : ""}`;
}

// --- merge ----------------------------------------------------------------------------------

const merge: VerbSpec = {
  name: "merge",
  summary: "Merge a delivered ship through the merge gate; it counts only once the merge is proven",
  positionals: [{ name: "task", required: true, help: "task or run id", complete: "task" }],
  flags: {
    head: { type: "string", help: "Pi leader extension: the head its confirm showed you", placeholder: "sha" },
    "key-file": { type: "string", help: "Pi leader extension only: its approval key, from stdin", fileFor: "approval_key" },
    "allow-red": { type: "string", help: "waive exactly this one failing check (quote it as one word); needs your word: Claude's prompt, Pi's confirm or flowryn approve --allow-red", placeholder: "check", once: true },
  },
  kind: "mutation",
  roles: ["leader", "human"],
  scope: { kind: "ref", arg: "task" },
  // The gate reads GitHub, the merge asks it and reads the proof back.
  replyMs: 120_000,
  async prepare(ctx, args): Promise<MergePrepared | QueuedMerge> {
    const task = stringArg(args, "task")!;
    const allowRed = stringArg(args, "allow-red");
    if (allowRed !== undefined && allowRed.length === 0) throw new FlowrynError("bad_args", "--allow-red needs the name of the one failing check to waive");
    const { run, project } = mergeable(ctx.db, ctx.delivery, task);
    const seen = deliveryBasis(ctx.db, run.id);
    const facts = await gatherFacts(mergeContext(ctx), run, project);
    // A chat answer never waives a red check: with --allow-red only the prompt, Pi's confirm or your shell count.
    const grant = allowRed === undefined ? prepareCaptainGrant(ctx, args, { item: `merge:${run.task_id}`, choice: "merge", head: facts.head }, { action: "merge", task }) : null;
    const chosen = chooseApproval(ctx.db, facts, { caller: ctx.caller, approvalKey: stringArg(args, "approval_key")?.trim(), head: stringArg(args, "head"), allowRed, grant }, "merge", ctx.now());
    // The attempt the Claude hook recorded is matched by the task as you typed it.
    if (!chosen.choice && ctx.caller.role === "leader" && ctx.caller.session && task !== run.task_id) {
      const attempt = findAttempt(ctx.db, { session: ctx.caller.session, action: "merge", task, now: ctx.now(), allowRed: allowRed ?? null });
      if (attempt && (!attempt.head_sha || attempt.head_sha === facts.head)) chosen.choice = { kind: "attempt", attempt, session: ctx.caller.session };
    }
    // A landing-queue project (src/verify/landing-queue.ts): your word puts the open PR in line; the queue brings it up to date, verifies and merges it.
    if (facts.pr?.state === "open" && landingQueued(ctx.config(), run.project_id) && queueable(ctx.db, run)) {
      if (!chosen.choice) throw new FlowrynError("approval_required", `no approval to queue ${run.task_id} for landing: ${chosen.why}`, `the leader runs flowryn merge ${run.task_id} and asks you, or in your shell: flowryn approve ${run.task_id}`);
      if (run.sensitive && chosen.choice.kind === "yolo") throw new FlowrynError("approval_required", `no approval to queue ${run.task_id} for landing: sensitive work needs a human approval even under yolo`, `approve in your shell: flowryn approve ${run.task_id}`);
      return { facts, gate: { waived: null, alreadyMerged: false, localGreen: null }, chosen, seen, queue: true } satisfies QueuedMerge;
    }
    const gate = checkGate(facts, chosen);
    return { facts, gate, chosen, seen };
  },
  apply(ctx, _args, prepared) {
    if ((prepared as QueuedMerge).queue) return queueMerge(ctx, prepared as QueuedMerge);
    return applyMerge(ctx, prepared as MergePrepared, ctx.caller);
  },
  async settle(ctx, result) {
    if (result.data.landing) {
      ctx.delivery.watch(String(result.data.run));
      return result;
    }
    return settleMerge(ctx, result, ctx.caller);
  },
};

interface QueuedMerge extends MergePrepared {
  queue: true;
}

/** The parts a queued merge reads, as a merge does: a redelivery, cancel or merge in between refuses it. */
const QUEUE_PARTS = ["state", "stage", "stage_state", "delivered", "merge", "operation"] as const;

/** Put the approved PR in its project's landing queue, its approval left standing for the queue's own merge. Call inside a transaction. */
function queueMerge(ctx: HandlerCtx, prepared: QueuedMerge): HandlerResult {
  const now = ctx.now();
  const { facts, chosen, seen } = prepared;
  requireDeliveryBasis(ctx.db, seen, [...QUEUE_PARTS], "merge", "cli", now, `flowryn merge ${facts.run.task_id} again`);
  const run = getRunWithPolicy(ctx.db, facts.run.id)!;
  const delivered = deliveredOf(ctx.db, run.task_id)!;
  const approval = standingApproval(ctx.db, facts, chosen.choice!, now);
  const entry = enqueueLanding(ctx.db, run, delivered, approval, now, "cli");
  const place = placeOf(ctx.db, entry);
  return {
    data: { task: run.task_id, run: run.id, landing: entry.id, position: place ? `${place.position} of ${place.of}` : "-", head: facts.head, approval: approval ?? "-", channel: channelOf(chosen.choice!), state: "queued" },
    hints: [`the landing queue merges origin/${facts.pr?.baseRef ?? "main"} into it, verifies and merges it in turn: flowryn show ${run.task_id}`],
  };
}

// --- decline ------------------------------------------------------------------------------------

const decline: VerbSpec = {
  name: "decline",
  summary: "Decline a delivered ship: the worker gets your words as a steer and delivers again",
  positionals: [{ name: "task", required: true, help: "task or run id", complete: "task" }],
  flags: { "body-file": { type: "string", help: "what to change, from a file or - for stdin", fileFor: "body" } },
  kind: "mutation",
  roles: ["leader", "human"],
  scope: { kind: "ref", arg: "task" },
  apply(ctx, args) {
    const { run } = runAndProject(ctx.db, stringArg(args, "task")!);
    if (run.state !== "ready") throw new FlowrynError("not_ready", `${run.task_id} is ${run.state}; only a delivered, unmerged ship can be declined`);
    const now = ctx.now();
    const note = (stringArg(args, "body") ?? "").trim();
    const delivered = deliveredOf(ctx.db, run.task_id);
    const text = `Your delivery ${delivered ? `(${delivered.ref} at ${delivered.head.slice(0, 8)}) ` : ""}was declined.${note ? ` ${note}` : " Ask your leader what to change."} Change it, then deliver again.`;
    const { stage } = sendBack(
      ctx.db,
      run,
      { text, feedback: note || "declined", why: "the delivery was declined", event: { source: "cli", kind: "run.declined", payload: { by: ctx.caller.role } } },
      now,
    );
    openUserActed(ctx.db, ctx.caller.role, { action: "declined", taskId: run.task_id, runId: run.id, line: `The user declined ${taskTitle(ctx.db, run.task_id)} (${run.task_id}) outside this session; the worker got their words and delivers again`, now });
    return { data: { task: run.task_id, run: run.id, state: "running", stage } };
  },
  async settle(ctx, result) {
    await ctx.sched.passNow();
    const steer = ctx.db.query("SELECT id FROM messages WHERE run_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1").get(String(result.data.run)) as { id: string } | null;
    const row = ctx.db.query("SELECT stage_state FROM runs WHERE id = ?1").get(String(result.data.run)) as { stage_state: string } | null;
    return { data: { ...result.data, steer: row?.stage_state === "waiting" ? "waits for capacity" : (steer?.id ?? "-") } };
  },
};

// --- cleanup --------------------------------------------------------------------------------------

/** The worktree's HEAD; once the worktree is gone, the tip of its branch in the primary checkout. */
async function worktreeHead(ctx: HandlerCtx, run: RunWithPolicy, project: ProjectRow): Promise<string> {
  const head = await ctx.delivery.git(["rev-parse", "HEAD"], run.worktree_path);
  if (head.code === 0) return head.stdout.trim();
  const branch = await ctx.delivery.git(["rev-parse", "--verify", "--quiet", `refs/heads/${run.branch}`], project.path);
  return branch.code === 0 ? branch.stdout.trim() : "none";
}

const cleanup: VerbSpec = {
  name: "cleanup",
  summary: "Remove a landed, cancelled or failed task's worktree, through the cleanup guard (--discard needs your approval)",
  positionals: [{ name: "task", required: true, help: "task or run id", complete: "task" }],
  flags: { discard: { type: "boolean", help: "discard unlanded work (needs a human discard approval: flowryn approve <task> --discard)" } },
  kind: "mutation",
  roles: ["leader", "human"],
  scope: { kind: "ref", arg: "task" },
  replyMs: 120_000,
  async prepare(ctx, args) {
    const task = stringArg(args, "task")!;
    const { run, project } = runAndProject(ctx.db, task);
    if (run.cleanup === "done") throw new FlowrynError("not_ready", `${run.task_id}'s worktree was already removed`);
    if (!isTerminal(run.state) && run.state !== "landed") {
      throw new FlowrynError("not_ready", `${run.task_id} is ${run.state}; merge it or cancel it first`, `flowryn cancel ${run.task_id}`);
    }
    // The approval is only found here; the cleanup uses it up when it removes the worktree, so a refusal leaves it for a retry.
    let discardApproval: string | null = null;
    let discardAttempt: DiscardAttempt | null = null;
    if (boolArg(args, "discard")) {
      const head = await worktreeHead(ctx, run, project);
      const now = ctx.now();
      discardApproval = findHumanApproval(ctx.db, { task: run.task_id, action: "discard", ref: discardRef(run), head, now })?.id ?? null;
      const session = ctx.caller.role === "leader" ? ctx.caller.session : null;
      if (!discardApproval && session) {
        const attempt = findAttempt(ctx.db, { session, action: "discard", task, now });
        if (attempt) discardAttempt = { attempt: attempt.id, session, head };
      }
      if (!discardApproval && !discardAttempt) throw new FlowrynError("approval_required", `discarding ${run.task_id}'s work needs your approval for head ${head.slice(0, 8)}`, `in your shell: flowryn approve ${run.task_id} --discard`);
    }
    const report = await ctx.delivery.cleanup(run.id, { discardApproval, discardAttempt, auto: false });
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
  positionals: [{ name: "task", required: true, help: "task or run id", complete: "task" }],
  flags: {
    "allow-red": { type: "string", help: "waive exactly this one failing check" },
    discard: { type: "boolean", help: "approve discarding unlanded work" },
    gate: { type: "string", help: "pass the open review gate of this stage" },
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
    const gateStage = stringArg(args, "gate");
    if (gateStage !== undefined) {
      if (boolArg(args, "discard") || stringArg(args, "allow-red")) throw new FlowrynError("bad_args", "--gate approves a review gate; it takes no --discard or --allow-red");
      const { gate } = openReviewGate(ctx.db, run.id);
      checkStage(gate, gateStage || undefined);
      requireGateAnswered(ctx.db, gate);
      const head = await reviewedHead(ctx, run);
      const challenge = ctx.delivery.challenges.create({ task: run.task_id, action: "gate", ref: gateRef(gate), head, allowRed: null, channel }, now);
      return {
        challenge: { id: challenge.id, code: challenge.code },
        summary: { action: "gate", task: run.task_id, title: taskTitle(ctx.db, run.task_id), project: run.project_id, stage: gate.stage, gate: gate.id, review: gate.review_url ?? "-", head, plan: pendingPlanLine(ctx.db, gate.id) ?? "-", questions: gateQuestionsLine(ctx.db, gate.id) ?? "-" },
      };
    }
    if (boolArg(args, "discard")) {
      if (stringArg(args, "allow-red")) throw new FlowrynError("bad_args", "--allow-red belongs to a merge approval, not a discard");
      const head = await worktreeHead(ctx, run, project);
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
    if (taken.action === "repin") throw new FlowrynError("challenge_failed", "that challenge is a repin, not an approval; nothing was approved", "run flowryn approve again");
    const actor = (stringArg(args, "actor") ?? "").replace(/[^A-Za-z0-9._@-]/g, "").slice(0, 64) || "you";
    if (taken.action === "gate") {
      // Your word on a review gate passes it as it is recorded (design section 11).
      const { run, gate } = openReviewGate(ctx.db, taken.task);
      if (gateRef(gate) !== taken.ref) throw new FlowrynError("challenge_failed", `the review gate of ${taken.task} changed since you were shown it`, `flowryn approve ${taken.task} --gate ${gate.stage}`);
      const passed = recordGatePass(ctx.db, run, gate, { channel: taken.channel, actor, head: taken.head }, ctx.now());
      openUserActed(ctx.db, ctx.caller.role, { action: "gate_passed", taskId: run.task_id, runId: run.id, line: `The user passed the ${gate.stage} review of ${taskTitle(ctx.db, run.task_id)} (${run.task_id}) from ${taken.channel}; the ${passed.next} stage starts next; tell the user (flowryn show ${run.task_id})`, now: ctx.now() });
      return { data: { ...passed, passed: true }, hints: [`flowryn show ${passed.task}`] };
    }
    const row = insertApproval(ctx.db, { task: taken.task, ref: taken.ref, head: taken.head, channel: taken.channel, actor, action: taken.action, allowRed: taken.allowRed, now: ctx.now() });
    const run = findRun(ctx.db, row.task_id);
    const title = taskTitle(ctx.db, row.task_id);
    const line =
      row.action === "merge"
        ? `The user approved merging ${title} (${row.task_id}) at ${row.head_sha.slice(0, 8)} from ${row.channel}${row.allow_red_check ? `, waiving ${row.allow_red_check}` : ""}; merge it: flowryn merge ${row.task_id}`
        : `The user approved discarding the unlanded work of ${title} (${row.task_id}) from ${row.channel}; discard it: flowryn cleanup ${row.task_id} --discard`;
    openUserActed(ctx.db, ctx.caller.role, { action: row.action === "merge" ? "merge_approved" : "discard_approved", taskId: row.task_id, runId: run?.id ?? null, line, now: ctx.now() });
    return {
      data: { approval: row.id, task: row.task_id, action: row.action, head: row.head_sha, channel: row.channel, waived: row.allow_red_check ?? "-", expires: new Date(row.expires_at).toISOString() },
      hints: row.action === "merge" ? [`flowryn merge ${row.task_id}`] : [`flowryn cleanup ${row.task_id} --discard`],
    };
  },
  async settle(ctx, result) {
    if (result.data.passed !== true) return result;
    ctx.journal.kick();
    ctx.lavish.kick();
    return stageStartedReply(ctx, result);
  },
};

export const POLICY_VERBS: VerbSpec[] = [merge, decline, cleanup, approveBegin, approveConfirm];
