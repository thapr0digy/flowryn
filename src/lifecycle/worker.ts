import { constants, copyFileSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { FlowrynError } from "../api/errors.ts";
import { appendEvent } from "../db/events.ts";
import { getMeta, setMeta } from "../db/db.ts";
import { openItem, resolveRunItems } from "../attention/items.ts";
import { boolArg, stringArg, type HandlerCtx, type VerbSpec } from "../api/verbs.ts";
import { recordIntent } from "../journal/journal.ts";
import { sanitizeBlock, sanitizeLine } from "../util/sanitize.ts";
import { steerLine } from "../harness/contract-text.ts";
import { reportDirFor, reportLink } from "./launcher.ts";
import { getRunWithPolicy, holdReason, isTerminal, taskTitle, type RunWithPolicy } from "./runs.ts";
import { ackSteer, getMessage, unackedSteers } from "./steers.ts";

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
    const id = nextDecisionId(ctx);
    ctx.db
      .query("INSERT INTO decisions (id, task_id, run_id, question, options, blocking, state) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open')")
      .run(id, run.task_id, run.id, question, JSON.stringify(options), blocking ? 1 : 0);
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
  return { source: real, artifact, bytes: st.size };
}

/**
 * `flowryn deliver --report <path>` (scout): verified and recorded; the run is
 * ready and the backlog task gets the report link. The task kind decides the
 * outcome: a scout delivers only a report, a ship only a PR. A ship's `--pr`
 * is verified by the named-head gate (design section 14), which arrives with
 * delivery in M4.
 */
const deliver: VerbSpec = {
  name: "deliver",
  summary: "Deliver your outcome: --report <path> (scout) or --pr <url> (ship); it is verified",
  positionals: [],
  flags: {
    report: { type: "string", help: "the scout report file", placeholder: "path" },
    pr: { type: "string", help: "the pull request URL (ship)", placeholder: "url" },
  },
  kind: "mutation",
  roles: ["worker"],
  spool: true,
  async prepare(ctx, args) {
    const run = activeRun(ctx);
    const pr = stringArg(args, "pr");
    const path = stringArg(args, "report");
    if (pr && path) throw new FlowrynError("bad_args", "deliver one outcome: --report or --pr");
    if (run.kind === "ship") {
      if (path) throw new FlowrynError("bad_args", "a ship task delivers a pull request, not a report", "flowryn deliver --pr <url>");
      if (!pr) throw new FlowrynError("bad_args", "deliver needs --pr <url>");
      throw new FlowrynError("not_supported", "deliver --pr is verified by the named-head gate, which arrives in M4");
    }
    if (pr) throw new FlowrynError("bad_args", "a scout task delivers a report, not a pull request", "flowryn deliver --report <path>");
    if (!path) throw new FlowrynError("bad_args", "deliver needs --report <path>");
    return collectReport(ctx, run, path);
  },
  apply(ctx, _args, prepared) {
    const run = activeRun(ctx);
    const delivered = prepared as DeliveredReport;
    const now = ctx.now();
    if (run.state === "ready") {
      const existing = ctx.db.query("SELECT id FROM artifacts WHERE task_id = ?1 AND kind = 'report' AND ref = ?2").get(run.task_id, delivered.artifact);
      if (existing) return { data: { run: run.id, state: run.state, report: delivered.artifact, already: true } };
    }
    const artifactId = `a${now.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    ctx.db.query("INSERT INTO artifacts (id, task_id, kind, ref, created_at) VALUES (?1, ?2, 'report', ?3, ?4)").run(artifactId, run.task_id, delivered.artifact, now);
    ctx.db.query("UPDATE runs SET state = 'ready', updated_at = ?2 WHERE id = ?1").run(run.id, now);
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
    openItem(ctx.db, {
      kind: "report_ready",
      eventSeq: event.seq,
      taskId: run.task_id,
      runId: run.id,
      line: `Report ready: ${taskTitle(ctx.db, run.task_id)} (${run.project_id})`,
      now,
    });
    return { data: { run: run.id, state: "ready", report: delivered.artifact }, hints: ["end your turn"] };
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
