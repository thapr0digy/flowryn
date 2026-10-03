import { constants, copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { FlowrynError } from "../api/errors.ts";
import { appendEvent } from "../db/events.ts";
import { getMeta, setMeta } from "../db/db.ts";
import { openItem, resolveRunItems } from "../attention/items.ts";
import { boolArg, stringArg, type HandlerCtx, type VerbSpec } from "../api/verbs.ts";
import { decisionsConfig, reservedReason } from "../attention/decisions-policy.ts";
import { recordIntent } from "../journal/journal.ts";
import { sanitizeBlock, sanitizeLine } from "../util/sanitize.ts";
import { steerLine } from "../harness/contract-text.ts";
import { createStandaloneDecision, DECISION_KEY } from "./decisions.ts";
import { parseOpenDecisions } from "./report-decisions.ts";
import { reportDirFor, reportLink } from "./launcher.ts";
import { getProject } from "./projects.ts";
import { recordDelivery, verifyLocalDelivery, verifyPrDelivery, type VerifiedLocal, type VerifiedPr } from "./delivery.ts";
import { getRunWithPolicy, holdReason, isTerminal, taskTitle, type RunWithPolicy } from "./runs.ts";
import { ackSteer, getMessage, unackedSteers } from "./steers.ts";
import { deliveryStages, pipelineNeedsLastStage, recordStageDelivered, requireLastStageStarted, startPooledStages } from "./stages.ts";
import { landScout } from "./landing.ts";

const STATUS = /^[a-z][a-z-]{0,23}$/;
const MAX_REPORT_CHARS = 4_000;
const MAX_QUESTION_CHARS = 2_000;
const MAX_REPORT_BYTES = 1024 * 1024;
const OPTION = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/;

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
 * `flowryn report <status>`: a worker's own account of a change a supervisor
 * would act on. Rank-4 evidence (design section 6): recorded, never trusted
 * over what the process table, hooks or systems of record show.
 */
const report: VerbSpec = {
  name: "report",
  summary: "Report a change your supervisor would act on (workers only)",
  positionals: [{ name: "status", required: true, help: "one word, such as blocked or progress" }],
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
    const event = appendEvent(ctx.db, {
      source: "cli",
      kind: "worker.report",
      runId: ctx.caller.runId,
      taskId: ctx.caller.taskId,
      payload: { status, summary: sanitizeLine(body), body, via: ctx.via },
    });
    return { data: { run: ctx.caller.runId, status, event: event.seq } };
  },
};

function nextDecisionId(ctx: HandlerCtx): string {
  const next = Number(getMeta(ctx.db, "next_decision_no") ?? "1");
  setMeta(ctx.db, "next_decision_no", String(next + 1));
  return `q${next}`;
}

/**
 * `flowryn ask --options a,b [--blocking] --body-file -`: a question for you.
 * It never holds the call open (design section 12): it returns a decision id,
 * the worker ends its turn, and the answer arrives as a steer. A blocking
 * question is a P0 and puts a captain hold on the task.
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
    "body-file": { type: "string", help: "the question, from a file or - for stdin", fileFor: "body" },
  },
  kind: "mutation",
  roles: ["worker"],
  spool: true,
  apply(ctx, args) {
    const run = activeRun(ctx);
    const question = sanitizeBlock(stringArg(args, "body") ?? "").trim().slice(0, MAX_QUESTION_CHARS);
    if (question.length === 0) throw new FlowrynError("bad_args", "the question goes in --body-file -");
    const options = (stringArg(args, "options") ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
    if (options.length < 2) throw new FlowrynError("bad_args", "--options needs at least two choices, such as yes,no");
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
    const id = nextDecisionId(ctx);
    const reserved = reservedReason({ question, context: null, sourceReason: stringArg(args, "reserved") ?? null, blocksYoloOff: false }, decisionsConfig(ctx.config()));
    ctx.db
      .query("INSERT INTO decisions (id, task_id, run_id, question, options, blocking, state, origin, key, recommendation, reserved_reason, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7, ?8, ?9, ?10, ?11)")
      .run(id, run.task_id, run.id, question, JSON.stringify(options), blocking ? 1 : 0, key ? run.task_id : null, key, stringArg(args, "recommend") ?? null, reserved, now);
    const event = appendEvent(ctx.db, { source: "cli", kind: "decision.opened", runId: run.id, taskId: run.task_id, payload: { decision: id, blocking, options, via: ctx.via } });
    const item = openItem(ctx.db, {
      kind: blocking ? "worker_question_blocking" : "worker_question",
      eventSeq: event.seq,
      taskId: run.task_id,
      runId: run.id,
      line: `Worker question ${id} on ${taskTitle(ctx.db, run.task_id)}${blocking ? ", blocking" : ""}: "${sanitizeLine(question, 120)}" [${options.join(" | ")}]`,
      now,
    });
    ctx.db.query("UPDATE items SET decision_id = ?2 WHERE id = ?1").run(item, id);
    if (blocking) {
      recordIntent(ctx.db, { file: "backlog", verb: "hold", taskId: run.task_id, positional: [run.task_id], flags: { reason: holdReason(`question ${id}`), kind: "captain" }, now });
    }
    return { data: { decision: id, blocking, options }, hints: ["end your turn; the answer arrives as a steer"] };
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
    if (asked.kind === "local") return { ship: await verifyLocalDelivery(deps, run, project) };
    return { ship: await verifyPrDelivery(deps, run, project, asked.url) };
  },
  apply(ctx, _args, prepared) {
    const run = activeRun(ctx);
    const now = ctx.now();
    const outcome = prepared as { report?: DeliveredReport; ship?: VerifiedPr | VerifiedLocal };
    if (run.state !== "ready" && pipelineNeedsLastStage(ctx.db, run)) requireLastStageStarted(ctx.db, run);
    const finished = run.state === "ready" ? [] : deliveryStages(ctx.db, run);
    if (outcome.ship) {
      const data = recordDelivery(ctx.db, run, outcome.ship, ctx.via, now);
      if (run.stage_state !== "done") recordStageDelivered(ctx.db, run, finished, now);
      return { data, hints: ["end your turn"] };
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
      line: `Report ready: ${taskTitle(ctx.db, run.task_id)} (${run.project_id}); flowryn show ${run.task_id}${opened.length > 0 ? `; ${opened.length} open decision${opened.length === 1 ? "" : "s"}` : ""}`,
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
