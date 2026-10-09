import { hashToken } from "../api/auth.ts";
import { FlowrynError } from "../api/errors.ts";
import { boolArg, stringArg, type Args, type HandlerCtx, type ReadCtx, type VerbSpec } from "../api/verbs.ts";
import { decisionsConfig, reservedReason } from "../attention/decisions-policy.ts";
import { resolveDecisionItems } from "../attention/items.ts";
import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { normalizeAnswer } from "../lavish/questions.ts";
import { getLease, getSession } from "../lease/lease.ts";
import { recordIntent } from "../journal/journal.ts";
import { readSnapshot } from "../journal/snapshot.ts";
import { findAttempt, matchAttempt } from "../policy/approvals.ts";
import { localDate } from "./dates.ts";
import { sanitizeBlock, sanitizeLine } from "../util/sanitize.ts";
import { createStandaloneDecision, DECISION_OPTION, getDecision, type DecisionRow } from "./decisions.ts";
import { CI_WAIT_ORIGIN, ciWaitSteer } from "./ci-wait.ts";
import { blockersOf } from "./plans.ts";
import { getProject } from "./projects.ts";
import { getRun, isTerminal } from "./runs.ts";
import type { ShowText } from "./show-text.ts";
import { createSteer } from "./steers.ts";

const OPTION = DECISION_OPTION;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function options(raw: string | undefined): string[] {
  const list = (raw ?? "").split(",").map((o) => o.trim()).filter((o) => o.length > 0);
  const bad = list.find((o) => !OPTION.test(o));
  if (bad) throw new FlowrynError("bad_args", `option "${bad}" must be short: letters, digits, spaces, _ . -`);
  return list;
}

type BacklogTasks = NonNullable<ReturnType<typeof readSnapshot>>["tasks"];

function backlogTasks(ctx: { db: HandlerCtx["db"] }): BacklogTasks {
  return readSnapshot(ctx.db, "backlog")?.tasks ?? [];
}

/** Tasks in the backlog that wait on this decision's task. */
function dependentsOf(tasks: BacklogTasks, taskId: string): { id: string; repo: string | null }[] {
  return tasks.filter((t) => blockersOf(t).includes(taskId)).map((t) => ({ id: t.id, repo: t.repo }));
}

/** Does a blocked task merge only with a human record (its project is not yolo, or it is sensitive)? */
function blocksYoloOff(ctx: HandlerCtx, blocks: string[]): boolean {
  for (const id of blocks) {
    const policy = ctx.db.query("SELECT yolo, sensitive FROM task_policy WHERE task_id = ?1").get(id) as { yolo: number; sensitive: number } | null;
    if (policy && (policy.yolo === 0 || policy.sensitive === 1)) return true;
  }
  return false;
}

/** Is this a task `decision add --blocks` can name: a live task_policy row, a plan phase, or one in the backlog snapshot? */
function blockTargetExists(ctx: HandlerCtx, id: string): boolean {
  if (ctx.db.query("SELECT 1 FROM task_policy WHERE task_id = ?1").get(id)) return true;
  if (ctx.db.query("SELECT 1 FROM plan_phases WHERE task_id = ?1").get(id)) return true;
  return (readSnapshot(ctx.db, "backlog")?.tasks ?? []).some((t) => t.id === id);
}

/**
 * Record an answer (call inside the verb's transaction): the decision row,
 * its item, the hold (a blocking question holds its own task; a standalone
 * decision's task is unheld and done, so what waits on it can land), and a
 * steer to the asking worker if its run is still going. A review gate's
 * question is held instead while its gate is open: the verdict steer carries
 * every answer at once (gate-questions.ts).
 */
export function answerDecision(ctx: { db: Db; now(): number }, d: DecisionRow, a: { choice: string; words: string | null; by: "captain" | "leader"; via: string }): { steer: string | null; run: string | null; dependents: string[]; held: boolean } {
  const now = ctx.now();
  ctx.db
    .query("UPDATE decisions SET state = 'answered', answer = ?2, answered_via = ?3, answered_at = ?4, answered_by = ?5, rationale = ?6 WHERE id = ?1")
    .run(d.id, a.choice, a.via, now, a.by, a.words);
  appendEvent(ctx.db, { source: "cli", kind: "decision.answered", runId: d.run_id, taskId: d.task_id, payload: { decision: d.id, choice: a.choice, by: a.by, via: a.via, ...(d.gate_id ? { gate: d.gate_id } : {}) }, ts: now });
  resolveDecisionItems(ctx.db, d.id, `decision.answered ${d.id}`, now);
  if (d.blocking) recordIntent(ctx.db, { file: "backlog", verb: "unhold", taskId: d.task_id, positional: [d.task_id], now });
  if (d.run_id === null) recordIntent(ctx.db, { file: "backlog", verb: "done", taskId: d.task_id, positional: [d.task_id], now });
  const run = d.run_id ? getRun(ctx.db, d.run_id) : null;
  const held = d.gate_id !== null && (ctx.db.query("SELECT state FROM gates WHERE id = ?1").get(d.gate_id) as { state: string } | null)?.state === "open";
  let steer: string | null = null;
  if (run && !isTerminal(run.state) && !held) {
    // The CI-wait watchdog's question was never the worker's: its answer is carried out as an instruction (keep-waiting sends none).
    const text = d.origin === CI_WAIT_ORIGIN ? ciWaitSteer(d.id, a.choice, a.words) : `Answer to your question ${d.id} ("${sanitizeLine(d.question, 100)}"): ${a.choice}.${a.words ? ` ${a.words}` : ""}`;
    if (text !== null) steer = createSteer(ctx.db, run, text, now, d.id).id;
  }
  return { steer, run: run?.id ?? null, dependents: d.run_id === null ? dependentsOf(backlogTasks(ctx), d.task_id).map((t) => t.id) : [], held };
}

/**
 * The review page's answers (src/lavish/poller.ts): the daemon's lavish-axi
 * poll returned what the user submitted on a gate's question widget. Next to
 * captainChannel, this is the only other path that records answered_by =
 * captain (via lavish): the user's own submit on the page Flowryn rendered.
 * An answer counts only for an open question of that gate while the gate is
 * open; anything else (answered meanwhile by the leader's relay, a stale page
 * of an earlier gate, a choice the question does not offer) is recorded as an
 * event and changes nothing. Call inside a transaction.
 */
export function lavishAnswer(ctx: { db: Db; now(): number }, answer: { gate: string; decision: string; choice: string[]; note: string | null }): "recorded" | "late" | "stale" | "invalid" {
  const d = getDecision(ctx.db, answer.decision);
  const gate = ctx.db.query("SELECT state FROM gates WHERE id = ?1").get(answer.gate) as { state: string } | null;
  let outcome: "recorded" | "late" | "stale" | "invalid";
  let detail: string | null = null;
  if (!d || d.gate_id !== answer.gate || !gate) outcome = "stale";
  else if (d.state !== "open" || gate.state !== "open") outcome = "late";
  else {
    try {
      const words = answer.note ? sanitizeBlock(answer.note).trim().slice(0, 2_000) || null : null;
      const choice = normalizeAnswer(d.kind ?? "single", JSON.parse(d.options) as string[], answer.choice, words !== null);
      answerDecision(ctx, d, { choice, words, by: "captain", via: "lavish" });
      return "recorded";
    } catch (error) {
      if (!(error instanceof FlowrynError)) throw error;
      outcome = "invalid";
      detail = error.message;
    }
  }
  appendEvent(ctx.db, { source: "daemon", kind: "decision.lavish_ignored", runId: d?.run_id ?? null, taskId: d?.task_id ?? null, payload: { decision: answer.decision, gate: answer.gate, outcome, detail }, ts: ctx.now() });
  return outcome;
}

export function decisionRef(id: string): string {
  return `decision:${id}`;
}

/**
 * Where a captain answer came from: Claude's own prompt (the attempt its
 * PreToolUse hook recorded for this decision, never under bypassPermissions),
 * the Pi leader's confirm (the lease's approval key), or your own shell.
 * Anything else is refused: the leader cannot record your word by itself.
 */
export function captainChannel(ctx: HandlerCtx, d: DecisionRow, typed: string, args: Args): string {
  if (ctx.caller.role === "human") return "shell";
  const help = `ask the user; Claude shows them flowryn decide ${d.id} … --by captain; on Pi use the flowryn_decide tool; or they run it in their own shell`;
  const session = ctx.caller.role === "leader" && ctx.caller.session ? getSession(ctx.db, ctx.caller.session) : null;
  const now = ctx.now();
  if (session?.harness === "claude") {
    const attempt = findAttempt(ctx.db, { session: session.session_id, action: "decide", task: typed, now });
    if (!attempt || attempt.pr_url !== decisionRef(d.id)) throw new FlowrynError("approval_required", "no confirmed Claude prompt for this answer (under bypassPermissions there is none to trust)", help);
    matchAttempt(ctx.db, attempt.id, now);
    return "claude-ask";
  }
  if (session?.harness === "pi") {
    const key = stringArg(args, "approval_key")?.trim();
    const lease = getLease(ctx.db);
    if (!key || lease.session_id !== session.session_id || !lease.approval_key_hash || hashToken(key) !== lease.approval_key_hash) throw new FlowrynError("approval_required", "no valid approval key: answer through the flowryn_decide tool, which asks the user first", help);
    return "pi-confirm";
  }
  throw new FlowrynError("approval_required", "a captain answer needs the user's word", help);
}

const decisionAdd: VerbSpec = {
  name: "decision add",
  summary: "Open a standalone decision (held for an answer); --blocks makes tasks wait on it",
  positionals: [],
  flags: {
    key: { type: "string", help: "short slug, unique per origin", placeholder: "key" },
    question: { type: "string", help: "the question, one line", placeholder: "text" },
    options: { type: "string", help: "comma-separated choices (optional)", placeholder: "a,b" },
    recommend: { type: "string", help: "the recommended choice", placeholder: "option" },
    blocks: { type: "list", help: "tasks that wait on this decision (repeatable)", placeholder: "task" },
    reserved: { type: "string", help: "only the user may answer, and why", placeholder: "reason" },
    origin: { type: "string", help: "where it came from (default: leader)", placeholder: "task" },
    project: { type: "string", help: "the project it belongs to", placeholder: "id" },
    "body-file": { type: "string", help: "why it matters, what it blocks", fileFor: "body" },
  },
  kind: "mutation",
  roles: ["leader", "human"],
  apply(ctx, args) {
    const key = stringArg(args, "key");
    const question = stringArg(args, "question");
    if (!key || !question) throw new FlowrynError("bad_args", "decision add needs --key and --question");
    const project = stringArg(args, "project");
    if (project && !getProject(ctx.db, project)) throw new FlowrynError("not_found", `no project ${project}`);
    const blocks = (args.blocks as string[] | undefined) ?? [];
    const unknown = blocks.filter((b) => !blockTargetExists(ctx, b));
    if (unknown.length > 0) throw new FlowrynError("not_found", `no task ${unknown.join(", ")}`, "flowryn fleet");
    const opts = options(stringArg(args, "options"));
    const recommend = stringArg(args, "recommend") ?? null;
    if (recommend && opts.length > 0 && !opts.includes(recommend)) throw new FlowrynError("bad_args", `--recommend must be one of: ${opts.join(", ")}`);
    const context = sanitizeBlock(stringArg(args, "body") ?? "").trim() || null;
    const reserved = reservedReason({ question, context, sourceReason: stringArg(args, "reserved") ?? null, blocksYoloOff: blocksYoloOff(ctx, blocks) }, decisionsConfig(ctx.config()));
    const made = createStandaloneDecision(ctx.db, { key, question, options: opts, recommendation: recommend, context, origin: stringArg(args, "origin") ?? "leader", reservedReason: reserved, blocks, project: project ?? null, now: ctx.now() });
    // The row's actual reserved_reason, not the freshly computed one: a repeat add never clears an
    // existing reason, and may only upgrade a null one (createStandaloneDecision's dedup path).
    return { data: { decision: made.id, task: made.taskId, reserved: made.reservedReason ?? "-", already: !made.created }, hints: [`flowryn show ${made.id}`] };
  },
  async settle(ctx, result) {
    ctx.journal.kick();
    return result;
  },
};

const decide: VerbSpec = {
  name: "decide",
  summary: "Answer a decision: the leader with --rationale; a reserved one only with the user's word (--by captain)",
  positionals: [
    { name: "decision", required: true, help: "decision id, such as k3 or q2" },
    { name: "choice", required: true, help: "one of its options (a multi choice: \"a, b\"; a review question also takes \"other\" with the user's words), or the answer when it has none" },
  ],
  flags: {
    rationale: { type: "string", help: "the leader's reason (required for a leader answer); - reads it from stdin", stdin: true, placeholder: "text" },
    by: { type: "string", help: "captain: record the user's own answer (needs their word)", placeholder: "captain" },
    words: { type: "string", help: "the user's words, verbatim (the Pi tool passes them here)", placeholder: "text" },
    "body-file": { type: "string", help: "the user's words, verbatim, or more reasoning", fileFor: "body" },
    "key-file": { type: "string", help: "Pi leader extension only: its approval key, from stdin", fileFor: "approval_key" },
  },
  kind: "mutation",
  roles: ["leader", "human"],
  apply(ctx, args) {
    const id = stringArg(args, "decision")!;
    const typed = stringArg(args, "choice")!;
    const d = getDecision(ctx.db, id);
    if (!d) throw new FlowrynError("not_found", `no decision ${id}`, "flowryn decision list");
    if (d.state !== "open") throw new FlowrynError("bad_args", `decision ${id} is already ${d.state}`);
    const opts = JSON.parse(d.options) as string[];
    const words = sanitizeBlock(stringArg(args, "body") ?? stringArg(args, "words") ?? "").trim() || null;
    const rationale = sanitizeBlock(stringArg(args, "rationale") ?? "").trim() || null;
    // A review gate's question is checked as the page checks it: several choices ("a, b"), free text,
    // or "other" with the user's words. The rest take one short choice.
    const gateKind = d.gate_id !== null ? (d.kind ?? "single") : d.kind;
    const checked = gateKind === "multi" || gateKind === "text" || d.gate_id !== null;
    const choice = checked ? normalizeAnswer(gateKind ?? "single", opts, gateKind === "multi" ? typed.split(",") : [typed], (words ?? rationale) !== null) : typed;
    if (!checked && opts.length > 0 && !opts.includes(choice)) throw new FlowrynError("bad_args", `choice must be one of: ${opts.join(", ")}`);
    if (opts.length === 0 && gateKind !== "text" && !OPTION.test(choice)) throw new FlowrynError("bad_args", "the choice must be short; put the rest in --body-file -");
    const asCaptain = stringArg(args, "by") === "captain" || ctx.caller.role === "human";
    if (stringArg(args, "by") !== undefined && stringArg(args, "by") !== "captain") throw new FlowrynError("bad_args", "--by takes only captain");
    let via: string;
    if (asCaptain) via = captainChannel(ctx, d, id, args);
    else {
      if (d.reserved_reason) throw new FlowrynError("reserved_decision", `${id} is reserved for the user (${d.reserved_reason})`, `ask the user, then: flowryn decide ${id} <choice> --by captain --body-file -`);
      if (!rationale) throw new FlowrynError("bad_args", "a leader answer needs --rationale <why>");
      via = "leader";
      const done = answerDecision(ctx, d, { choice, words: words ? `${rationale}\n${words}` : rationale, by: "leader", via });
      return reply(ctx, d, choice, "leader", done);
    }
    // A human may pass their words as --rationale (the natural flag to reach for) instead of
    // --body-file/--words; --rationale is used only as a fallback, so it is never silently dropped
    // when --body-file/--words was not also given.
    const done = answerDecision(ctx, d, { choice, words: words ?? rationale, by: "captain", via });
    return reply(ctx, d, choice, "captain", done);
  },
  async settle(ctx, result) {
    ctx.journal.kick();
    if (result.data.run !== "-") ctx.fleet.bus.notify(String(result.data.run));
    ctx.sched.kick();
    ctx.lavish.kick();
    return result;
  },
};

function reply(ctx: HandlerCtx, d: DecisionRow, choice: string, by: string, done: ReturnType<typeof answerDecision>) {
  const hints: string[] = [];
  for (const dep of done.dependents) {
    const auto = ctx.db.query("SELECT auto, project_id FROM task_policy WHERE task_id = ?1").get(dep) as { auto: number; project_id: string } | null;
    if (auto && auto.auto === 0) hints.push(`flowryn dispatch ${auto.project_id} --task ${dep}`);
  }
  if (done.held) hints.push("the answer reaches the worker with the review's verdict");
  return { data: { decision: d.id, answer: choice, by, steer: done.steer ?? (done.held ? "held for the verdict" : "-"), run: done.run ?? "-", unblocks: done.dependents }, hints };
}

const decisionDefer: VerbSpec = {
  name: "decision defer",
  summary: "Leave an open decision out of the briefing until a date",
  positionals: [{ name: "decision", required: true, help: "decision id" }],
  flags: { until: { type: "string", help: "YYYY-MM-DD", placeholder: "date" } },
  kind: "mutation",
  roles: ["leader", "human"],
  apply(ctx, args) {
    const id = stringArg(args, "decision")!;
    const until = stringArg(args, "until");
    if (!until || !DATE.test(until)) throw new FlowrynError("bad_args", "--until takes a date, YYYY-MM-DD");
    const d = getDecision(ctx.db, id);
    if (!d || d.state !== "open") throw new FlowrynError("not_found", `no open decision ${id}`);
    ctx.db.query("UPDATE decisions SET defer_until = ?2 WHERE id = ?1").run(id, until);
    appendEvent(ctx.db, { source: "cli", kind: "decision.deferred", taskId: d.task_id, payload: { decision: id, until }, ts: ctx.now() });
    return { data: { decision: id, deferred_until: until } };
  },
};

/** Open decisions in the order to take them: most dependents first, then oldest. */
export function openDecisions(ctx: { db: ReadCtx["db"]; now: number }, filter: "open" | "reserved" | "deferred" | "all"): DecisionRow[] {
  const today = localDate(new Date(ctx.now));
  const rows = ctx.db.query(filter === "all" ? "SELECT * FROM decisions ORDER BY created_at" : "SELECT * FROM decisions WHERE state = 'open' ORDER BY created_at").all() as DecisionRow[];
  const deferred = (d: DecisionRow) => d.defer_until !== null && d.defer_until > today;
  const picked = rows.filter((d) => (filter === "deferred" ? deferred(d) : filter === "all" ? true : !deferred(d) && (filter === "open" || d.reserved_reason !== null)));
  const tasks = backlogTasks(ctx);
  const weight = new Map(picked.map((d) => [d.id, dependentsOf(tasks, d.task_id).length]));
  return picked.toSorted((a, b) => weight.get(b.id)! - weight.get(a.id)! || (a.created_at ?? 0) - (b.created_at ?? 0));
}

/** `flowryn show <decision>`: its question, context and why whole; `text` cuts what it blocks unless --full. */
export function decisionView(d: DecisionRow, text: ShowText): Record<string, unknown> {
  return {
    decision: d.id,
    task: d.task_id,
    state: d.state,
    question: sanitizeBlock(d.question),
    options: (JSON.parse(d.options) as string[]).join(" | ") || "-",
    recommend: d.recommendation ?? "-",
    origin: d.origin ?? "-",
    key: d.key ?? "-",
    reserved: d.reserved_reason ?? "-",
    deferred_until: d.defer_until ?? "-",
    answer: d.answer ?? "-",
    by: d.answered_by ?? "-",
    via: d.answered_via ?? "-",
    rationale: d.rationale ?? "-",
    ...(d.kind ? { kind: d.kind } : {}),
    ...(d.gate_id ? { gate: d.gate_id } : {}),
    ...(d.blocks ? { blocks: text.line(d.blocks, 200) } : {}),
    ...(d.note ? { why: sanitizeBlock(d.note) } : {}),
    ...(d.context ? { context: sanitizeBlock(d.context) } : {}),
  };
}

const decisionList: VerbSpec = {
  name: "decision list",
  summary: "Decisions: open (default), --reserved (only the user may answer), --deferred, --all",
  positionals: [],
  flags: {
    reserved: { type: "boolean", help: "only those reserved for the user" },
    deferred: { type: "boolean", help: "only deferred ones" },
    all: { type: "boolean", help: "every decision, answered too" },
  },
  kind: "read",
  roles: ["leader", "reader", "human"],
  read(ctx, args) {
    const filter = boolArg(args, "all") ? "all" : boolArg(args, "deferred") ? "deferred" : boolArg(args, "reserved") ? "reserved" : "open";
    const decisions = openDecisions(ctx, filter).map((d) => ({ id: d.id, task: d.task_id, reserved: d.reserved_reason ?? "-", gate: d.gate_id ?? "-", question: sanitizeLine(d.question, 100), state: d.state }));
    return { data: { decisions }, hints: decisions.length > 0 ? ["flowryn show <id>", "flowryn decide <id> <choice> --rationale <why>"] : [] };
  },
};

export const DECISION_VERBS: VerbSpec[] = [decisionAdd, decisionList, decisionDefer, decide];
