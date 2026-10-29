import { constants, copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { FlowrynError } from "../api/errors.ts";
import { appendEvent } from "../db/events.ts";
import { openItem, resolveRunItems } from "../attention/items.ts";
import { boolArg, stringArg, type HandlerCtx, type VerbSpec } from "../api/verbs.ts";
import { decisionsConfig, reservedReason } from "../attention/decisions-policy.ts";
import { recordIntent } from "../journal/journal.ts";
import { capStoredText, MAX_LINE_CHARS, sanitizeBlock, sanitizeLine } from "../util/sanitize.ts";
import { steerLine } from "../harness/contract-text.ts";
import { createStandaloneDecision, DECISION_KEY, DECISION_OPTION, getDecision, nextRunDecisionId } from "./decisions.ts";
import { answerDecision } from "./decision-verbs.ts";
import { resolveTool } from "../config/config.ts";
import { cleanupConfig } from "../config/delivery.ts";
import { matchRules, readRuleFacts, type RuleFacts, type RuleVerdict } from "../policy/nomistakes-rules.ts";
import { parseOpenDecisions } from "./report-decisions.ts";
import { reportDirFor, reportLink } from "./launcher.ts";
import { getProject } from "./projects.ts";
import { deliveryBasis, requireDeliveryBasis, type BasisPart, type DeliveryBasis } from "./observed.ts";
import { deliveredOf, recordDelivery, verifyLocalDelivery, verifyPrDelivery, type Carry, type VerifiedLocal, type VerifiedPr } from "./delivery.ts";
import { cleanMainMerge } from "../policy/clean-merge.ts";
import type { GitRunner } from "../policy/landed.ts";
import { verifyConfig } from "../verify/config.ts";
import { verifyPolicyId } from "../verify/policy.ts";
import { getRunWithPolicy, holdReason, isTerminal, taskTitle, type RunWithPolicy } from "./runs.ts";
import { ackSteer, getMessage, unackedSteers } from "./steers.ts";
import { deliveryStages, pipelineNeedsLastStage, recordStageDelivered, requireLastStageStarted, startPooledStages } from "./stages.ts";
import { landScout } from "./landing.ts";
import { startAutoMerge } from "../verify/auto-merge.ts";

const STATUS = /^[a-z][a-z-]{0,23}$/;
const MAX_REPORT_CHARS = 4_000;
const MAX_REPORT_BYTES = 1024 * 1024;
const OPTION = DECISION_OPTION;
const MIN_BLOCKS_CHARS = 10;
const MAX_BLOCKS_CHARS = 200;

/** The caller's run. Worker verbs are bound to one run by the token (design section 12). */
function callerRun(ctx: { db: HandlerCtx["db"]; caller: HandlerCtx["caller"] }): RunWithPolicy {
  const run = ctx.caller.runId ? getRunWithPolicy(ctx.db, ctx.caller.runId) : null;
  if (!run) throw new FlowrynError("not_found", "this worker's run is gone");
  return run;
}

function activeRun(ctx: HandlerCtx): RunWithPolicy {
  const run = callerRun(ctx);
  if (isTerminal(run.state)) throw new FlowrynError("run_not_active", `run ${run.id} is ${run.state}`);
  return run;
}

/**
 * What a report's status word does, by plain lookup: "item" also opens a P1
 * worker_report item for the leader, "record" only appends the event. A word
 * not in the table opens an item: the contract tells workers to report only
 * what a supervisor would act on, so an unknown word is far likelier a finding
 * under another name than chatter, and a missed finding costs more than a
 * dismissable P1.
 */
/** The status words a worker's contract names, offered by shell completion; any word is accepted. */
export const REPORT_STATUSES = ["finding", "blocked", "failed", "progress"] as const;

export const REPORT_EFFECT: Readonly<Record<string, "item" | "record">> = {
  blocked: "item",
  finding: "item",
  failed: "item",
  failing: "item",
  error: "item",
  broken: "item",
  stuck: "item",
  regression: "item",
  risk: "item",
  progress: "record",
  started: "record",
  update: "record",
  note: "record",
  info: "record",
  done: "record",
  ok: "record",
};

export function reportOpensItem(status: string): boolean {
  return (REPORT_EFFECT[status] ?? "item") === "item";
}

const MORE_IN_SHOW = " (flowryn show for the full text)";
/** The run's open worker_report item already carrying this exact status and body, if any. */
function openIdenticalReport(db: HandlerCtx["db"], runId: string, status: string, body: string): string | null {
  const row = db
    .query(
      `SELECT i.id FROM items i JOIN events e ON e.seq = i.event_seq
       WHERE i.kind = 'worker_report' AND i.run_id = ?1 AND i.state IN ('open','presented')
         AND json_extract(e.payload, '$.status') = ?2 AND json_extract(e.payload, '$.body') = ?3
       LIMIT 1`,
    )
    .get(runId, status, body) as { id: string } | null;
  return row?.id ?? null;
}

/**
 * The item's one line: status, task and as much of the body as fits the line
 * limit, with a pointer to `flowryn show` when the body was cut.
 */
export function reportLine(title: string, status: string, body: string): string {
  const head = `Report (${status}) from ${sanitizeLine(title, 60)}`;
  const summary = sanitizeLine(body, MAX_REPORT_CHARS);
  if (summary.length === 0) return head;
  const whole = `${head}: "${summary}"`;
  if (whole.length <= MAX_LINE_CHARS) return whole;
  const room = MAX_LINE_CHARS - head.length - `: ""`.length - MORE_IN_SHOW.length;
  return `${head}: "${sanitizeLine(summary, room)}"${MORE_IN_SHOW}`;
}

/**
 * `flowryn report <status>`: a worker's own account of a change a supervisor
 * would act on. Rank-4 evidence (design section 6): recorded, never trusted
 * over what the process table, hooks or systems of record show. A status that
 * opens an item (REPORT_EFFECT) reaches the leader as a P1: the digest, the
 * briefing and `fleet` needs. An identical report while its item is open adds
 * no second item; dismissing it or the run's end closes it.
 */
const report: VerbSpec = {
  name: "report",
  summary: "Report a change your supervisor would act on (workers only)",
  positionals: [{ name: "status", required: true, help: "one word: finding, blocked or failed open an item for your leader; progress is only recorded", values: REPORT_STATUSES }],
  flags: {
    "body-file": { type: "string", help: "details, read from a file or - for stdin", fileFor: "body" },
  },
  kind: "mutation",
  roles: ["worker"],
  spool: true,
  apply(ctx, args) {
    const status = stringArg(args, "status")!;
    if (!STATUS.test(status)) throw new FlowrynError("bad_args", "status must be one lowercase word, such as blocked or progress");
    const body = sanitizeBlock(stringArg(args, "body") ?? "").trim().slice(0, MAX_REPORT_CHARS);
    const now = ctx.now();
    const event = appendEvent(ctx.db, {
      source: "cli",
      kind: "worker.report",
      runId: ctx.caller.runId,
      taskId: ctx.caller.taskId,
      payload: { status, summary: sanitizeLine(body), body, via: ctx.via },
      ts: now,
    });
    const run = ctx.caller.runId ? getRunWithPolicy(ctx.db, ctx.caller.runId) : null;
    // A run that has ended closed its report items; one opened now would never close.
    if (!run || isTerminal(run.state) || !reportOpensItem(status)) return { data: { run: ctx.caller.runId, status, event: event.seq, item: "-" } };
    const existing = openIdenticalReport(ctx.db, run.id, status, body);
    if (existing) return { data: { run: run.id, status, event: event.seq, item: existing, duplicate: true } };
    const item = openItem(ctx.db, {
      kind: "worker_report",
      eventSeq: event.seq,
      taskId: run.task_id,
      runId: run.id,
      line: reportLine(taskTitle(ctx.db, run.task_id), status, body),
      now,
    });
    return { data: { run: run.id, status, event: event.seq, item } };
  },
};

/**
 * `flowryn ask --options a,b --blocks <what waits> [--blocking] --body-file -`:
 * a question for you, only when the worker cannot proceed without it.
 * It never holds the call open (design section 12): it returns a decision id,
 * the worker ends its turn, and the answer arrives as a steer. A blocking
 * question is a P0 and puts a captain hold on the task. With --nomistakes it
 * is a no-mistakes ask-user finding: the gate is read from no-mistakes and
 * git, and `[decisions] nomistakes_rules` may settle it at once (answered_by
 * policy, its steer sent, no item); otherwise it is reserved for the user
 * (docs/notes/2026-10-22-settle-routine-no-2r.md).
 */
const ask: VerbSpec = {
  name: "ask",
  summary: "Ask your leader a question; returns at once, the answer arrives as a steer",
  positionals: [],
  flags: {
    options: { type: "string", help: "comma-separated choices", placeholder: "a,b" },
    blocking: { type: "boolean", help: "you cannot continue without the answer" },
    key: { type: "string", help: "a short slug for this question, for show", placeholder: "key" },
    recommend: { type: "string", help: "the recommended choice", placeholder: "option" },
    reserved: { type: "string", help: "only the user may answer, and why", placeholder: "reason" },
    blocks: { type: "string", help: "required: the choice in your work that waits on the answer", placeholder: "text" },
    nomistakes: { type: "boolean", help: "a no-mistakes ask-user finding: a rule may settle it ([decisions] nomistakes_rules), else only the user answers" },
    "body-file": { type: "string", help: "the question, from a file or - for stdin", fileFor: "body" },
  },
  kind: "mutation",
  roles: ["worker"],
  spool: true,
  // A --nomistakes ask reads no-mistakes' status and git first; give it time before it spools.
  replyMs: 30_000,
  async prepare(ctx, args): Promise<RuleFacts | null> {
    if (!boolArg(args, "nomistakes")) return null;
    const run = activeRun(ctx);
    if (run.delivery_mode !== "no-mistakes") return { ok: false, reason: "not a no-mistakes ship" };
    const project = getProject(ctx.db, run.project_id);
    if (!project) return { ok: false, reason: `no project ${run.project_id}` };
    const config = ctx.config();
    return readRuleFacts({ noMistakes: resolveTool(config, "no_mistakes"), git: ctx.delivery.git, timeoutMs: cleanupConfig(config).nomistakes_timeout_ms }, run.worktree_path, project.default_branch);
  },
  apply(ctx, args, prepared) {
    const run = activeRun(ctx);
    const question = capStoredText(sanitizeBlock(stringArg(args, "body") ?? "").trim());
    if (question.length === 0) throw new FlowrynError("bad_args", "the question goes in --body-file -");
    const options = (stringArg(args, "options") ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
    if (options.length < 2) throw new FlowrynError("bad_args", "--options needs at least two choices, such as yes,no");
    // Ask only when you cannot proceed (the worker contract): name the choice the answer unblocks.
    const blocks = sanitizeLine(stringArg(args, "blocks") ?? "", MAX_BLOCKS_CHARS);
    if (blocks.length < MIN_BLOCKS_CHARS) throw new FlowrynError("bad_args", "--blocks <what waits on the answer> is required: ask only when you cannot proceed; decide the rest yourself and record it");
    const bad = options.find((o) => !OPTION.test(o));
    if (bad) throw new FlowrynError("bad_args", `option "${bad}" must be short: letters, digits, spaces, _ . -`);
    const blocking = boolArg(args, "blocking");
    const now = ctx.now();
    const key = stringArg(args, "key") ?? null;
    if (key && !DECISION_KEY.test(key)) throw new FlowrynError("bad_args", "--key must be lowercase letters, digits and dashes");
    // A second ask with the same key on the same task would otherwise hit decisions_origin_key's
    // unique index as a raw SQLite error, and a spooled ask would fail on replay. Idempotent: an
    // open decision for the same (origin, key) is returned again; an already-settled one refuses.
    if (key) {
      const existing = ctx.db.query("SELECT id, run_id, state, blocking, options FROM decisions WHERE origin = ?1 AND key = ?2").get(run.task_id, key) as { id: string; run_id: string | null; state: string; blocking: number; options: string } | null;
      if (existing && existing.run_id === null) throw new FlowrynError("bad_args", `key ${key} is already the standalone decision ${existing.id}`, "use another key");
      if (existing) {
        if (existing.state !== "open") throw new FlowrynError("bad_args", `key ${key} already used by ${existing.id}`);
        return { data: { decision: existing.id, blocking: existing.blocking === 1, options: JSON.parse(existing.options) as string[], already: true }, hints: ["end your turn; the answer arrives as a steer"] };
      }
    }
    const id = nextRunDecisionId(ctx.db);
    const cfg = decisionsConfig(ctx.config());
    const facts = prepared as RuleFacts | null;
    const verdict: RuleVerdict | null = facts === null ? null : facts.ok ? matchRules({ ...facts, worktree: run.worktree_path, options, sensitive: run.sensitive === 1 }, cfg.nomistakes_rules) : { settled: false, reason: facts.reason };
    const sourceReason = stringArg(args, "reserved") ?? null;
    // A gate a rule settles is judged on no-mistakes' and git's facts, not on the question's wording
    // (the user's ruling, 2026-10-22); only the worker's own --reserved still keeps it for the user.
    // A no-mistakes ask no rule settles is the user's, with the reason no rule did.
    const reserved = verdict?.settled && !sourceReason?.trim()
      ? null
      : (reservedReason({ question, context: null, sourceReason, blocksYoloOff: false }, cfg) ?? (verdict && !verdict.settled ? sanitizeLine(`nomistakes: ${verdict.reason}`, 200) : null));
    ctx.db
      .query("INSERT INTO decisions (id, task_id, run_id, question, options, blocking, state, origin, key, recommendation, reserved_reason, created_at, blocks) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7, ?8, ?9, ?10, ?11, ?12)")
      .run(id, run.task_id, run.id, question, JSON.stringify(options), blocking ? 1 : 0, key ? run.task_id : null, key, stringArg(args, "recommend") ?? null, reserved, now, blocks);
    const event = appendEvent(ctx.db, { source: "cli", kind: "decision.opened", runId: run.id, taskId: run.task_id, payload: { decision: id, blocking, options, blocks, via: ctx.via, ...(verdict ? { nomistakes: true } : {}) } });
    if (verdict?.settled && reserved === null) {
      appendEvent(ctx.db, { source: "daemon", kind: "decision.settled_by_rule", runId: run.id, taskId: run.task_id, payload: { decision: id, step: facts!.ok ? facts!.step : "", rules: verdict.rules, answer: verdict.answer, findings: verdict.findings } });
      // Never held, so nothing to unhold: answer it as a non-blocking question.
      const done = answerDecision(ctx, { ...getDecision(ctx.db, id)!, blocking: 0 }, { choice: verdict.answer, words: verdict.words, by: "policy", via: `rule:${verdict.rules.join(",")}` });
      return { data: { decision: id, blocking, options, answered: verdict.answer, rule: verdict.rules.join(","), steer: done.steer ?? "-" }, hints: [done.steer ? `settled by rule: act on steer ${done.steer} now, then $FLOWRYN_BIN ack ${done.steer}` : "settled by rule"] };
    }
    const item = openItem(ctx.db, {
      kind: blocking ? "worker_question_blocking" : "worker_question",
      eventSeq: event.seq,
      taskId: run.task_id,
      runId: run.id,
      line: `Worker question ${id} on ${taskTitle(ctx.db, run.task_id)}${blocking ? ", blocking" : ""}: "${sanitizeLine(question, 120)}" [${options.join(" | ")}] blocks: ${sanitizeLine(blocks, 80)}`,
      now,
    });
    ctx.db.query("UPDATE items SET decision_id = ?2 WHERE id = ?1").run(item, id);
    if (blocking) {
      recordIntent(ctx.db, { file: "backlog", verb: "hold", taskId: run.task_id, positional: [run.task_id], flags: { reason: holdReason(`question ${id}`), kind: "captain" }, now });
    }
    return { data: { decision: id, blocking, options, ...(reserved ? { reserved } : {}) }, hints: ["end your turn; the answer arrives as a steer"] };
  },
  async settle(ctx, result) {
    if (result.data.answered !== undefined && ctx.caller.runId) ctx.fleet.bus.notify(ctx.caller.runId);
    return result;
  },
};

/** `flowryn inbox`: the steers you have not acknowledged yet. */
const inbox: VerbSpec = {
  name: "inbox",
  summary: "List steers from your leader you have not acknowledged",
  positionals: [],
  flags: {},
  kind: "read",
  roles: ["worker"],
  read(ctx) {
    const run = callerRun(ctx);
    const steers = unackedSteers(ctx.db, run.id).map((m) => ({ id: m.id, steer: steerLine(m.id, m.body) }));
    return { data: { run: run.id, steers }, hints: steers.length > 0 ? ["act on each, then: $FLOWRYN_BIN ack <id>"] : [] };
  },
};

/** `flowryn ack <id>`: you acted on a steer. The only proof a steer was seen. */
const ack: VerbSpec = {
  name: "ack",
  summary: "Acknowledge a steer after acting on it",
  positionals: [{ name: "id", required: true, help: "steer id, such as m3" }],
  flags: {},
  kind: "mutation",
  roles: ["worker"],
  apply(ctx, args) {
    const run = callerRun(ctx);
    const id = stringArg(args, "id")!;
    const message = getMessage(ctx.db, id);
    if (!message || message.run_id !== run.id) throw new FlowrynError("not_found", `no steer ${id} for this run`, "$FLOWRYN_BIN inbox");
    const result = ackSteer(ctx.db, run, message, ctx.now());
    return { data: { steer: id, acked: true, already: result.already } };
  },
  async settle(ctx, result) {
    if (ctx.caller.runId) ctx.fleet.bus.notify(ctx.caller.runId);
    return result;
  },
};

interface DeliveredReport {
  source: string;
  artifact: string;
  bytes: number;
  text: string;
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Verify a scout's report and copy it to `<data_dir>/<task>/report.md`: a
 * regular file inside the run's worktree or its report directory, no
 * symlink, at most 1 MB. A report elsewhere is refused rather than read, and
 * whatever sits at the destination is replaced, never written through.
 */
function collectReport(ctx: HandlerCtx, run: RunWithPolicy, raw: string): DeliveredReport {
  const reportDir = reportDirFor(ctx.config(), run.task_id);
  let real: string;
  try {
    if (lstatSync(raw).isSymbolicLink()) throw new FlowrynError("invalid_report", `${raw} is a symlink; deliver the file itself`);
    real = realpathSync(raw);
  } catch (error) {
    if (error instanceof FlowrynError) throw error;
    throw new FlowrynError("invalid_report", `cannot read ${raw}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
  }
  const roots = [run.worktree_path, reportDir].flatMap((r) => {
    try {
      return [realpathSync(r)];
    } catch {
      return [];
    }
  });
  if (!roots.some((root) => isInside(real, root))) {
    throw new FlowrynError("invalid_report", `${raw} is outside your worktree and $FLOWRYN_REPORT_DIR`, `write it under ${reportDir}`);
  }
  const st = statSync(real);
  if (!st.isFile()) throw new FlowrynError("invalid_report", `${raw} is not a regular file`);
  if (st.size === 0) throw new FlowrynError("invalid_report", `${raw} is empty`);
  if (st.size > MAX_REPORT_BYTES) throw new FlowrynError("invalid_report", `${raw} is over 1 MB`);
  mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  const artifact = join(realpathSync(reportDir), "report.md");
  if (artifact !== real) {
    try {
      rmSync(artifact, { force: true });
      copyFileSync(real, artifact, constants.COPYFILE_EXCL);
    } catch (error) {
      throw new FlowrynError("invalid_report", `cannot store the report at ${artifact}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
    }
  }
  // Read the stored copy, not the worker-controlled source: the worker's own process could still
  // rewrite `real` between the copy above and a read of it, but nothing writes `artifact` afterward.
  const text = readFileSync(artifact, "utf8");
  return { source: real, artifact, bytes: st.size, text };
}

type DeliveryAsked = { kind: "report"; path: string } | { kind: "local" } | { kind: "pr"; url: string };

/** What the worker asked to deliver, checked against the task before anything changes. */
function deliveryAsked(ctx: HandlerCtx, run: RunWithPolicy, args: Record<string, unknown>): DeliveryAsked {
  const pr = stringArg(args as never, "pr");
  const path = stringArg(args as never, "report");
  const local = boolArg(args as never, "local");
  if ([pr, path, local || undefined].filter((v) => v !== undefined).length > 1) throw new FlowrynError("bad_args", "deliver one outcome: --report, --pr or --local");
  if (run.kind === "scout") {
    if (pr || local) throw new FlowrynError("bad_args", "a scout task delivers a report, not a pull request", "flowryn deliver --report <path>");
    if (!path) throw new FlowrynError("bad_args", "deliver needs --report <path>");
    if (run.state === "landed") throw new FlowrynError("run_not_active", `${run.task_id} is landed: its report was delivered`, "end your turn");
    return { kind: "report", path };
  }
  if (path) throw new FlowrynError("bad_args", "a ship task delivers a pull request or a local branch, not a report");
  if (!getProject(ctx.db, run.project_id)) throw new FlowrynError("not_found", `project ${run.project_id} is gone`);
  if (run.state === "merging" || run.state === "landed") throw new FlowrynError("run_not_active", `${run.task_id} is ${run.state}; it is past delivery`);
  if (run.delivery_mode === "local-only") {
    if (pr) throw new FlowrynError("bad_args", "this is a local-only task: never push; deliver --local");
    if (!local) throw new FlowrynError("bad_args", "deliver needs --local (a local-only task)");
    return { kind: "local" };
  }
  if (local) throw new FlowrynError("bad_args", `this task ships through ${run.delivery_mode}: deliver --pr <url>`);
  if (!pr) throw new FlowrynError("bad_args", "deliver needs --pr <url>");
  return { kind: "pr", url: pr };
}

/**
 * What a ship's delivery depends on: verified at one head, it is recorded only
 * if no newer delivery, send-back, stage change or operation (a cancel asked
 * for, a new worker) landed while GitHub and git were read
 * (docs/notes/2026-10-13-next-steps-md-av.md). Its pipeline starting or
 * ending meanwhile (running ↔ validating) is not one: a worker delivers as its
 * pipeline passes, while the watcher may be reading it end.
 */
const DELIVER_PARTS: readonly BasisPart[] = ["lifecycle", "stage", "stage_state", "delivered", "operation"];

/**
 * A PR redelivered at a head that is the delivered one plus only clean merges
 * of main (docs/notes/2026-10-23-a-clean-merge-fm.md): the proof, asked of
 * git in the run's worktree before the transaction; recordDelivery applies it
 * to routine work only. Null when there is nothing to prove (a first delivery,
 * the same head, another PR) or the proof fails.
 */
async function carryOf(ctx: HandlerCtx, git: GitRunner, run: RunWithPolicy, base: string, ship: VerifiedPr): Promise<Carry | null> {
  const previous = deliveredOf(ctx.db, run.task_id);
  if (!previous || previous.kind !== "pr" || previous.ref !== ship.url || previous.head === ship.pr.headSha || ship.pr.baseRef !== base) return null;
  const proof = await cleanMainMerge(git, run.worktree_path, { from: previous.head, to: ship.pr.headSha, base });
  if (!proof.ok) return null;
  const steps = verifyConfig(ctx.config(), run.project_id);
  return { from: previous.head, steps: proof.steps, verifyPolicy: steps ? verifyPolicyId(steps) : null };
}

/**
 * `flowryn deliver`: the worker's outcome, verified before the run is ready.
 * The task kind decides it: a scout delivers `--report <path>`; a ship
 * delivers `--pr <url>` (no-mistakes, direct-PR), checked by the named-head
 * gate, or `--local` (local-only), a clean branch with commits the default
 * branch lacks (src/lifecycle/delivery.ts).
 */
const deliver: VerbSpec = {
  name: "deliver",
  summary: "Deliver your outcome: --report <path> (scout), --pr <url> or --local (ship); it is verified",
  positionals: [],
  flags: {
    report: { type: "string", help: "the scout report file", placeholder: "path" },
    pr: { type: "string", help: "the pull request URL (ship: no-mistakes, direct-PR)", placeholder: "url" },
    local: { type: "boolean", help: "your committed branch (ship: local-only)" },
  },
  kind: "mutation",
  roles: ["worker"],
  spool: true,
  // The named-head gate asks GitHub and the remote; a slow answer must not turn a refusal into a spool.
  replyMs: 60_000,
  async prepare(ctx, args) {
    const asked = deliveryAsked(ctx, activeRun(ctx), args);
    // A delivery ends the last stage (design section 11); from an earlier one only past stages without a review gate.
    const before = activeRun(ctx);
    if (before.state !== "ready") {
      if (pipelineNeedsLastStage(ctx.db, before)) requireLastStageStarted(ctx.db, before);
      else await startPooledStages(ctx, before.id);
    }
    const run = activeRun(ctx);
    if (run.state !== "ready") deliveryStages(ctx.db, run);
    if (asked.kind === "report") return { report: collectReport(ctx, run, asked.path) };
    const project = getProject(ctx.db, run.project_id)!;
    const deps = { db: ctx.db, git: ctx.delivery.git, forge: ctx.delivery.forge(), webUrl: ctx.delivery.github().web_url, now: ctx.now };
    const seen = deliveryBasis(ctx.db, run.id);
    if (asked.kind === "local") return { ship: await verifyLocalDelivery(deps, run, project), seen };
    const ship = await verifyPrDelivery(deps, run, project, asked.url);
    return { ship, seen, carry: await carryOf(ctx, deps.git, run, project.default_branch, ship) };
  },
  apply(ctx, _args, prepared) {
    const run = activeRun(ctx);
    const now = ctx.now();
    const outcome = prepared as { report?: DeliveredReport; ship?: VerifiedPr | VerifiedLocal; seen?: DeliveryBasis; carry?: Carry | null };
    if (outcome.seen) requireDeliveryBasis(ctx.db, outcome.seen, DELIVER_PARTS, "deliver", "cli", now, "read your steers, then deliver again");
    if (run.state !== "ready" && pipelineNeedsLastStage(ctx.db, run)) requireLastStageStarted(ctx.db, run);
    const finished = run.state === "ready" ? [] : deliveryStages(ctx.db, run);
    if (outcome.ship) {
      const data = recordDelivery(ctx.db, run, outcome.ship, ctx.via, now, outcome.carry ?? null);
      if (run.stage_state !== "done") recordStageDelivered(ctx.db, run, finished, now);
      const ship = outcome.ship;
      // An opted-in yolo project's delivery is verified and merged by the daemon (src/verify/auto-merge.ts).
      const auto = startAutoMerge(
        ctx.db,
        ctx.config(),
        run,
        ship.kind === "pr"
          ? { ref: ship.url, head: ship.pr.headSha, prNumber: ship.pr.number, headRef: ship.pr.headRef, worktree: null }
          : { ref: `local:${run.branch}`, head: ship.head, prNumber: null, headRef: null, worktree: run.worktree_path },
        now,
      );
      return { data: auto ? { ...data, auto_merge: auto.id } : data, hints: ["end your turn"] };
    }
    const delivered = outcome.report!;
    if (run.state === "ready") {
      const existing = ctx.db.query("SELECT id FROM artifacts WHERE task_id = ?1 AND kind = 'report' AND ref = ?2").get(run.task_id, delivered.artifact);
      if (existing) return { data: { run: run.id, state: run.state, report: delivered.artifact, already: true } };
    }
    if (run.stage_state !== "done") recordStageDelivered(ctx.db, run, finished, now);
    const artifactId = `a${now.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    ctx.db.query("INSERT INTO artifacts (id, task_id, kind, ref, created_at) VALUES (?1, ?2, 'report', ?3, ?4)").run(artifactId, run.task_id, delivered.artifact, now);
    recordIntent(ctx.db, { file: "backlog", verb: "update", taskId: run.task_id, positional: [run.task_id], flags: { report: reportLink(run.task_id) }, now });
    const event = appendEvent(ctx.db, {
      source: "cli",
      kind: "run.delivered",
      runId: run.id,
      taskId: run.task_id,
      payload: { outcome: "report", report: delivered.artifact, source: delivered.source, bytes: delivered.bytes, verified: "file", via: ctx.via },
      ts: now,
    });
    resolveRunItems(ctx.db, run.id, ["worker_idle"], "run.delivered", now);
    // A scout's `## Open decisions` become standalone decisions once (cutover C1). A second real
    // delivery is refused above (run_not_active); a spool duplicate replays its stored reply; and
    // createStandaloneDecision returns created: false on any repeat, so nothing opens twice. A
    // malformed entry (spec: an empty question) never blocks landing: it is skipped, with a warning.
    const parsed = parseOpenDecisions(delivered.text);
    const cfg = decisionsConfig(ctx.config());
    const opened: string[] = [];
    const warnings: string[] = [];
    for (const entry of parsed) {
      if (entry.warning) warnings.push(entry.warning);
      const options = entry.options.filter((o) => OPTION.test(o));
      const reserved = reservedReason({ question: entry.question, context: entry.context, sourceReason: entry.reserved, blocksYoloOff: false }, cfg);
      try {
        const made = createStandaloneDecision(ctx.db, { key: entry.key, question: entry.question, options, recommendation: entry.recommendation, context: entry.context, origin: run.task_id, reservedReason: reserved, project: run.project_id, now });
        if (made.created) opened.push(made.id);
      } catch (error) {
        if (!(error instanceof FlowrynError)) throw error;
        warnings.push(`entry ${entry.key}: ${error.message}`);
      }
    }
    openItem(ctx.db, {
      kind: "report_ready",
      eventSeq: event.seq,
      taskId: run.task_id,
      runId: run.id,
      line: `Report ready: ${taskTitle(ctx.db, run.task_id)} (${run.project_id}); flowryn show ${run.task_id} --full${opened.length > 0 ? `; ${opened.length} open decision${opened.length === 1 ? "" : "s"}` : ""}`,
      now,
    });
    // A scout's workflow ends in no gate: the verified report lands it, and the daemon cleans up (design section 8).
    landScout(ctx.db, run, delivered.artifact, now);
    if (parsed.length > 0) {
      appendEvent(ctx.db, { source: "cli", kind: "report.decisions", runId: run.id, taskId: run.task_id, payload: { opened, warnings }, ts: now });
    }
    return { data: { run: run.id, state: "landed", report: delivered.artifact, decisions: opened }, hints: ["end your turn"] };
  },
  async settle(ctx, result) {
    // A PR is watched; a landed report's worktree is cleaned up by the same watcher pass.
    if (result.data.pr || result.data.report) ctx.delivery.watch(String(result.data.run));
    ctx.sched.kick();
    return result;
  },
};

/**
 * `flowryn fail --body-file -`: you cannot finish. The run is not failed on
 * your word (design section 8: failed or cancelled with your consent); it opens
 * a P0 for the leader, who cancels, resumes or steers.
 */
const fail: VerbSpec = {
  name: "fail",
  summary: "Say you cannot finish, and why; your leader decides what happens next",
  positionals: [],
  flags: {
    "body-file": { type: "string", help: "why, from a file or - for stdin", fileFor: "body" },
  },
  kind: "mutation",
  roles: ["worker"],
  spool: true,
  apply(ctx, args) {
    const run = activeRun(ctx);
    const reason = sanitizeBlock(stringArg(args, "body") ?? "").trim().slice(0, MAX_REPORT_CHARS);
    if (reason.length === 0) throw new FlowrynError("bad_args", "say why in --body-file -");
    const now = ctx.now();
    const event = appendEvent(ctx.db, { source: "cli", kind: "worker.failed", runId: run.id, taskId: run.task_id, payload: { reason, via: ctx.via }, ts: now });
    const item = openItem(ctx.db, {
      kind: "failure_needs_you",
      eventSeq: event.seq,
      taskId: run.task_id,
      runId: run.id,
      line: `Worker cannot finish ${taskTitle(ctx.db, run.task_id)}: "${sanitizeLine(reason, 140)}"`,
      now,
    });
    return { data: { run: run.id, item }, hints: ["end your turn; your leader decides"] };
  },
};

export const WORKER_VERBS: VerbSpec[] = [report, ask, inbox, ack, deliver, fail];
