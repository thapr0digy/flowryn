import { FlowrynError } from "../api/errors.ts";
import { hashToken } from "../api/auth.ts";
import { stringArg, type HandlerCtx, type HandlerResult, type VerbSpec } from "../api/verbs.ts";
import type { Db } from "../db/db.ts";
import { getLease, getSession } from "../lease/lease.ts";
import { getRunWithPolicy, taskTitle, type RunWithPolicy } from "../lifecycle/runs.ts";
import { changesTarget, openGate, passReviewGate, positionOf, sendBack, type GateRow } from "../lifecycle/stages.ts";
import { consumeApproval, findAttempt, insertApproval, matchAttempt, type Channel } from "./approvals.ts";
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
 * approval, since it only holds work back.
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
}

const gatePass: VerbSpec = {
  name: "gate pass",
  summary: "Pass a task's open review gate: Claude asks the user first; Pi uses the flowryn_gate_pass tool; in your shell use flowryn approve --gate",
  positionals: [{ name: "task", required: true, help: "task or run id" }],
  flags: {
    stage: { type: "string", help: "the gate's stage, as a check (design, qa, ...)", placeholder: "stage" },
    "gate-id": { type: "string", help: "the gate you were shown (g<n>), as a check: refused when another gate is open", placeholder: "id" },
    "key-file": { type: "string", help: "Pi leader extension only: its approval key, from stdin", fileFor: "approval_key" },
  },
  kind: "mutation",
  roles: ["leader", "human"],
  async prepare(ctx, args): Promise<PassPrepared> {
    const { run, gate } = openReviewGate(ctx.db, stringArg(args, "task")!);
    checkStage(gate, stringArg(args, "stage"));
    checkGateId(gate, stringArg(args, "gate-id"));
    return { runId: run.id, gateId: gate.id, head: await reviewedHead(ctx, run) };
  },
  apply(ctx, args, prepared) {
    const { runId, gateId, head } = prepared as PassPrepared;
    const typed = stringArg(args, "task")!;
    const run = getRunWithPolicy(ctx.db, runId)!;
    const gate = openGate(ctx.db, run.id, "review");
    if (!gate || gate.id !== gateId) throw new FlowrynError("not_ready", `gate ${gateId} of ${run.task_id} is no longer open`, `flowryn show ${run.task_id}`);
    const now = ctx.now();
    const help = `in your shell: flowryn approve ${run.task_id} --gate ${gate.stage}`;
    const session = ctx.caller.role === "leader" && ctx.caller.session ? getSession(ctx.db, ctx.caller.session) : null;
    let approval: { channel: Channel; actor: string; head: string } | null = null;
    if (session?.harness === "claude") {
      // The attempt Claude's PreToolUse hook recorded when it asked you, matched by the task as typed.
      const attempt = findAttempt(ctx.db, { session: session.session_id, action: "gate", task: typed, now });
      if (!attempt) throw new FlowrynError("approval_required", "no confirmed Claude prompt for this gate pass (under bypassPermissions there is none to trust)", help);
      if (attempt.pr_url !== gateRef(gate)) {
        throw new FlowrynError("approval_required", `the prompt you confirmed showed ${attempt.pr_url?.replace(/^gate:/, "gate ") ?? "no open gate"}, but the open ${gate.stage} review is gate ${gate.id}`, "run the gate pass again, so Claude shows you this gate");
      }
      matchAttempt(ctx.db, attempt.id, now);
      approval = { channel: "claude-ask", actor: `${user()} (Claude prompt, leader ${session.session_id})`, head };
    } else if (session?.harness === "pi") {
      const key = stringArg(args, "approval_key")?.trim();
      const lease = getLease(ctx.db);
      if (!key) throw new FlowrynError("approval_required", "no approval key: pass the gate through the flowryn_gate_pass tool, which asks you first", help);
      if (lease.session_id !== session.session_id || !lease.approval_key_hash || hashToken(key) !== lease.approval_key_hash) throw new FlowrynError("approval_required", "the approval key is not this lease's", help);
      approval = { channel: "pi-confirm", actor: `${user()} (Pi confirm, leader ${session.session_id})`, head };
    }
    if (!approval) throw new FlowrynError("approval_required", "a review gate passes only with your word from a human channel", help);
    const passed = recordGatePass(ctx.db, run, gate, approval, now);
    return { data: { ...passed }, hints: [`flowryn show ${run.task_id}`] };
  },
  async settle(ctx, result) {
    ctx.journal.kick();
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
  positionals: [{ name: "task", required: true, help: "task or run id" }],
  flags: {
    "body-file": { type: "string", help: "what to change, from a file or - for stdin", fileFor: "body" },
    to: { type: "string", help: "the stage to go back to (default: the nearest earlier stage without a review gate, else the gated stage)", placeholder: "stage" },
  },
  kind: "mutation",
  roles: ["leader", "human"],
  apply(ctx, args) {
    const { run, gate } = openReviewGate(ctx.db, stringArg(args, "task")!);
    const words = (stringArg(args, "body") ?? "").trim();
    if (words.length === 0) throw new FlowrynError("bad_args", "say what to change in --body-file -");
    const pos = positionOf(ctx.db, run, run.kind);
    const gateIndex = pos.def.stages.findIndex((s) => s.id === gate.stage);
    const to = stringArg(args, "to");
    let target = changesTarget(pos.def, gateIndex);
    if (to) {
      target = pos.def.stages.findIndex((s) => s.id === to);
      if (target < 0 || target > gateIndex) throw new FlowrynError("bad_args", `--to must name ${gate.stage} or a stage before it: ${pos.def.stages.slice(0, gateIndex + 1).map((s) => s.id).join(", ")}`);
    }
    const stage = sendBack(ctx.db, run, gate, words, target, ctx.caller.role, ctx.now());
    return { data: { task: run.task_id, title: taskTitle(ctx.db, run.task_id), gate: gate.id, state: "changes", to: stage }, hints: [`flowryn show ${run.task_id}`] };
  },
  async settle(ctx, result) {
    return stageStartedReply(ctx, result);
  },
};

export const GATE_VERBS: VerbSpec[] = [gatePass, gateChanges];
