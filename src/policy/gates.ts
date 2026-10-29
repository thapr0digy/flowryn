import { FlowrynError } from "../api/errors.ts";
import { hashToken } from "../api/auth.ts";
import { stringArg, type HandlerCtx, type HandlerResult, type VerbSpec } from "../api/verbs.ts";
import type { Db } from "../db/db.ts";
import { getSession, leaseOfSession } from "../lease/lease.ts";
import type { Account } from "../config/accounts.ts";
import { runAccount } from "../config/accounts.ts";
import { checkStart, startDepsOf } from "../lifecycle/dispatch.ts";
import { requireGateAnswered } from "../lifecycle/gate-questions.ts";
import { getProject } from "../lifecycle/projects.ts";
import { goneForGood } from "../lifecycle/review-chat.ts";
import { revivalTarget, reviveReview } from "../lifecycle/review-revival.ts";
import { getRunWithPolicy, taskTitle, type RunWithPolicy } from "../lifecycle/runs.ts";
import { openUserActed } from "../attention/follow-up.ts";
import { changesTarget, openGate, passReviewGate, positionOf, sendBack, type GateRow } from "../lifecycle/stages.ts";
import { consumeApproval, findAttempt, insertApproval, matchAttempt, type Channel } from "./approvals.ts";
import { grantActor, prepareCaptainGrant, takeGrant, voidItemGrants } from "./grants.ts";
import { runAndProject } from "./verbs.ts";

/**
 * Review gates (design section 11): human-bound like merges (section 7). A
 * gate passes only with an approval record (action gate) from a human
 * channel: `flowryn approve <task> --gate <stage>` in your shell or the
 * board's approve key (both pass it as they record it), Claude's own prompt
 * for the leader's `flowryn gate pass` (its ask rule and PreToolUse hook), or
 * the Pi leader's flowryn_gate_pass confirm. A worker saying "you approved it
 * in Lavish" is never a pass, and yolo never passes a review gate.
 * `flowryn gate changes` sends the run back with your words; it needs no
 * approval, since it only holds work back. On a run gone for good (failed, its
 * worktree cleaned up) a new run of the task carries the review on with your
 * words (src/lifecycle/review-revival.ts); a cancelled run's review is refused. A gate that carries the worker's
 * questions passes only once each is answered (gate-questions.ts); changes
 * close the ones still open.
 */

/** What an approval for a gate binds to. */
export function gateRef(gate: Pick<GateRow, "id">): string {
  return `gate:${gate.id}`;
}

/** The worktree's HEAD, which a gate approval records as what was reviewed ("none" before the first commit). */
export async function reviewedHead(ctx: HandlerCtx, run: RunWithPolicy): Promise<string> {
  const head = await ctx.delivery.git(["rev-parse", "HEAD"], run.worktree_path);
  return head.code === 0 ? head.stdout.trim() : "none";
}

/** The open review gate of a task, or a refusal naming where the run is. */
export function openReviewGate(db: Db, target: string): { run: RunWithPolicy; gate: GateRow } {
  const { run } = runAndProject(db, target);
  const gate = openGate(db, run.id, "review");
  if (!gate) throw new FlowrynError("not_ready", `no review gate is open for ${run.task_id} (stage ${run.stage}, ${run.stage_state})`, `flowryn show ${run.task_id}`);
  return { run, gate };
}

/** A gate stage named on the command line must be the open one. */
export function checkStage(gate: GateRow, stage: string | undefined): void {
  if (stage && stage !== gate.stage) throw new FlowrynError("not_ready", `the open review gate is ${gate.stage}, not ${stage}`);
}

/** A gate id named on the command line (the one you were shown) must be the open one. */
export function checkGateId(gate: GateRow, id: string | undefined): void {
  if (id && id !== gate.id) throw new FlowrynError("not_ready", `gate ${id} is no longer open; the open ${gate.stage} review is gate ${gate.id}`, "look at the new review, then pass it");
}

export interface GatePassed {
  task: string;
  gate: string;
  stage: string;
  approval: string;
  channel: Channel;
  next: string;
  plan: string;
}

/** Record the approval and pass the gate, in the caller's transaction. */
export function recordGatePass(db: Db, run: RunWithPolicy, gate: GateRow, approval: { channel: Channel; actor: string; head: string }, now: number): GatePassed {
  // The user answered "refuse" (q3): a gate with an open question of its own never passes.
  requireGateAnswered(db, gate);
  const row = insertApproval(db, { task: run.task_id, ref: gateRef(gate), head: approval.head, channel: approval.channel, actor: approval.actor, action: "gate", now });
  consumeApproval(db, row.id, now, `gate ${gate.id} of ${run.task_id}`);
  const passed = passReviewGate(db, run, gate, { id: row.id, channel: approval.channel }, now);
  return { task: run.task_id, gate: gate.id, stage: gate.stage, approval: row.id, channel: approval.channel, next: passed.next, plan: passed.plan ?? "-" };
}

function user(): string {
  return process.env.USER || process.env.LOGNAME || "you";
}

interface PassPrepared {
  runId: string;
  gateId: string;
  head: string;
  /** A chat answer that passes this gate (docs/notes/2026-10-10-chat-answers-authorise-5g.md). */
  grant: string | null;
}

const gatePass: VerbSpec = {
  name: "gate pass",
  summary: "Pass a task's open review gate: Claude asks the user first; Pi uses the flowryn_gate_pass tool; in your shell use flowryn approve --gate",
  positionals: [{ name: "task", required: true, help: "task or run id", complete: "task" }],
  flags: {
    stage: { type: "string", help: "the gate's stage, as a check (design, qa, ...)", placeholder: "stage", complete: "stage" },
    "gate-id": { type: "string", help: "the gate you were shown (g<n>), as a check: refused when another gate is open", placeholder: "id" },
    "key-file": { type: "string", help: "Pi leader extension only: its approval key, from stdin", fileFor: "approval_key" },
  },
  kind: "mutation",
  roles: ["leader", "human"],
  scope: { kind: "ref", arg: "task" },
  async prepare(ctx, args): Promise<PassPrepared> {
    const { run, gate } = openReviewGate(ctx.db, stringArg(args, "task")!);
    checkStage(gate, stringArg(args, "stage"));
    checkGateId(gate, stringArg(args, "gate-id"));
    requireGateAnswered(ctx.db, gate);
    const grant = prepareCaptainGrant(ctx, args, { item: gate.id, choice: "pass" }, { action: "gate", task: stringArg(args, "task")! });
    return { runId: run.id, gateId: gate.id, head: await reviewedHead(ctx, run), grant };
  },
  apply(ctx, args, prepared) {
    const { runId, gateId, head, grant } = prepared as PassPrepared;
    const typed = stringArg(args, "task")!;
    const run = getRunWithPolicy(ctx.db, runId)!;
    const gate = openGate(ctx.db, run.id, "review");
    if (!gate || gate.id !== gateId) throw new FlowrynError("not_ready", `gate ${gateId} of ${run.task_id} is no longer open`, `flowryn show ${run.task_id}`);
    const now = ctx.now();
    const help = `in your shell: flowryn approve ${run.task_id} --gate ${gate.stage}`;
    const session = ctx.caller.role === "leader" && ctx.caller.session ? getSession(ctx.db, ctx.caller.session) : null;
    let approval: { channel: Channel; actor: string; head: string } | null = null;
    if (session?.harness === "claude" && grant) {
      const used = takeGrant(ctx.db, grant, `gate pass ${gate.id}`, now);
      approval = { channel: "claude-chat", actor: grantActor(used), head };
    } else if (session?.harness === "claude") {
      // The attempt Claude's PreToolUse hook recorded when it asked you, matched by the task as typed.
      const attempt = findAttempt(ctx.db, { session: session.session_id, action: "gate", task: typed, now });
      if (!attempt) throw new FlowrynError("approval_required", "no confirmed Claude prompt or chat answer for this gate pass (under bypassPermissions there is no prompt to trust)", `${help}; or ask in chat: flowryn chat-question ${gate.id}, then flowryn grant use <grant>`);
      if (attempt.pr_url !== gateRef(gate)) {
        throw new FlowrynError("approval_required", `the prompt you confirmed showed ${attempt.pr_url?.replace(/^gate:/, "gate ") ?? "no open gate"}, but the open ${gate.stage} review is gate ${gate.id}`, "run the gate pass again, so Claude shows you this gate");
      }
      matchAttempt(ctx.db, attempt.id, now);
      voidItemGrants(ctx.db, gate.id, "a confirmed prompt passed it", now);
      approval = { channel: "claude-ask", actor: `${user()} (Claude prompt, leader ${session.session_id})`, head };
    } else if (session?.harness === "pi") {
      const key = stringArg(args, "approval_key")?.trim();
      const lease = leaseOfSession(ctx.db, session.session_id);
      if (!key) throw new FlowrynError("approval_required", "no approval key: pass the gate through the flowryn_gate_pass tool, which asks you first", help);
      if (!lease || lease.session_id !== session.session_id || !lease.approval_key_hash || hashToken(key) !== lease.approval_key_hash) throw new FlowrynError("approval_required", "the approval key is not this lease's", help);
      approval = { channel: "pi-confirm", actor: `${user()} (Pi confirm, leader ${session.session_id})`, head };
    }
    if (!approval) throw new FlowrynError("approval_required", "a review gate passes only with your word from a human channel", help);
    const passed = recordGatePass(ctx.db, run, gate, approval, now);
    return { data: { ...passed }, hints: [`flowryn show ${run.task_id}`] };
  },
  async settle(ctx, result) {
    ctx.journal.kick();
    ctx.lavish.kick();
    return stageStartedReply(ctx, result);
  },
};

/** After the scheduler looked: whether the next stage started (its steer sent) or waits for capacity. */
export async function stageStartedReply(ctx: HandlerCtx, result: HandlerResult): Promise<HandlerResult> {
  await ctx.sched.passNow();
  const run = ctx.db.query("SELECT r.id, r.stage, r.stage_state FROM runs r WHERE r.task_id = ?1 ORDER BY r.started_at DESC LIMIT 1").get(String(result.data.task)) as { id: string; stage: string; stage_state: string } | null;
  if (!run) return result;
  return { ...result, data: { ...result.data, stage_now: `${run.stage} ${run.stage_state === "waiting" ? "waits for capacity" : run.stage_state}` } };
}

const gateChanges: VerbSpec = {
  name: "gate changes",
  summary: "Send a task back from its open review gate with your words (default: to the stage before it, e.g. qa back to build)",
  positionals: [{ name: "task", required: true, help: "task or run id", complete: "task" }],
  flags: {
    "body-file": { type: "string", help: "what to change, from a file or - for stdin", fileFor: "body" },
    to: { type: "string", help: "the stage to go back to (default: the nearest earlier stage without a review gate, else the gated stage)", placeholder: "stage", complete: "stage" },
  },
  kind: "mutation",
  roles: ["leader", "human"],
  scope: { kind: "ref", arg: "task" },
  async prepare(ctx, args): Promise<ChangesPrepared> {
    // Changes need no word from you; a chat answer is still taken (and a "Pass" answer refuses them).
    const { run, gate } = openReviewGate(ctx.db, stringArg(args, "task")!);
    if (run.state === "cancelled" || goneForGood(run)) revivalTarget(ctx.db, gate.id);
    const grant = prepareCaptainGrant(ctx, args, { item: gate.id, choice: "changes" }, null);
    if (!goneForGood(run)) return { grant, revival: null };
    // Its run ended for good: a new run carries the review on, checked as a dispatch is.
    const project = getProject(ctx.db, run.project_id);
    if (!project) throw new FlowrynError("not_found", `project ${run.project_id} is gone`);
    const account = runAccount(ctx.config(), project, run.account, run.harness);
    return { grant, revival: { gate: gate.id, account, start: await checkStart(startDepsOf(ctx), project, account) } };
  },
  apply(ctx, args, prepared) {
    const { run, gate } = openReviewGate(ctx.db, stringArg(args, "task")!);
    const ready = prepared as ChangesPrepared | undefined;
    if (run.state === "cancelled" || goneForGood(run)) revivalTarget(ctx.db, gate.id);
    if (goneForGood(run) && ready?.revival?.gate !== gate.id) throw new FlowrynError("not_ready", `${run.task_id} changed meanwhile`, "send the changes again");
    const grantId = ready?.grant ?? null;
    const used = grantId ? takeGrant(ctx.db, grantId, `gate changes ${gate.id}`, ctx.now()) : null;
    const leaderWords = (stringArg(args, "body") ?? "").trim();
    // Free text the user typed as their answer is their words; the leader's relay comes after it.
    const theirs = used?.words?.trim() ?? "";
    const words = [theirs, leaderWords].filter((w) => w.length > 0).join("\n");
    if (words.length === 0) throw new FlowrynError("bad_args", "say what to change in --body-file -");
    const pos = positionOf(ctx.db, run, run.kind);
    const gateIndex = pos.def.stages.findIndex((s) => s.id === gate.stage);
    const to = stringArg(args, "to");
    let target = changesTarget(pos.def, gateIndex);
    if (to) {
      target = pos.def.stages.findIndex((s) => s.id === to);
      if (target < 0 || target > gateIndex) throw new FlowrynError("bad_args", `--to must name ${gate.stage} or a stage before it: ${pos.def.stages.slice(0, gateIndex + 1).map((s) => s.id).join(", ")}`);
    }
    const by = used ? grantActor(used) : ctx.caller.role;
    if (ready?.revival) {
      // The new run starts at the gated stage unless --to names another.
      const revived = reviveReview(ctx.db, ctx.config(), { gateId: gate.id, by, words, account: ready.revival.account, start: ready.revival.start, stage: to ? pos.def.stages[target]!.id : gate.stage, now: ctx.now() });
      openUserActed(ctx.db, ctx.caller.role, { action: "gate_changes", taskId: run.task_id, runId: revived.run, line: `The user sent ${taskTitle(ctx.db, run.task_id)} (${run.task_id}) back from its ${gate.stage} review outside this session; its run had ended for good, so a new run ${revived.run} started at ${revived.stage} with their words`, now: ctx.now() });
      return { data: { task: run.task_id, title: taskTitle(ctx.db, run.task_id), gate: gate.id, state: "replaced", to: revived.stage, run: revived.run, replaced: revived.oldRun, ...(used ? { grant: used.id } : {}) }, hints: [`flowryn show ${run.task_id}`] };
    }
    const stage = sendBack(ctx.db, run, gate, words, target, by, ctx.now());
    openUserActed(ctx.db, ctx.caller.role, { action: "gate_changes", taskId: run.task_id, runId: run.id, line: `The user sent ${taskTitle(ctx.db, run.task_id)} (${run.task_id}) back from its ${gate.stage} review to ${stage} outside this session; the worker got their words`, now: ctx.now() });
    return { data: { task: run.task_id, title: taskTitle(ctx.db, run.task_id), gate: gate.id, state: "changes", to: stage, ...(used ? { grant: used.id } : {}) }, hints: [`flowryn show ${run.task_id}`] };
  },
  async settle(ctx, result) {
    ctx.journal.kick();
    ctx.lavish.kick();
    return stageStartedReply(ctx, result);
  },
};

interface ChangesPrepared {
  grant: string | null;
  /** The new run's start, when the gate's run ended for good (src/lifecycle/review-revival.ts). */
  revival: { gate: string; account: Account; start: { version: string; base: string } } | null;
}

export const GATE_VERBS: VerbSpec[] = [gatePass, gateChanges];
