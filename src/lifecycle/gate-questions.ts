import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, sep } from "node:path";
import { FlowrynError } from "../api/errors.ts";
import { openItem, resolveDecisionItems } from "../attention/items.ts";
import type { Db } from "../db/db.ts";
import { appendEvent, type EventSource } from "../db/events.ts";
import type { GateQuestions } from "../lavish/questions.ts";
import { MOUNT_SNIPPET, pageMountsWidget, type WidgetState } from "../lavish/widget.ts";
import { sanitizeLine } from "../util/sanitize.ts";
import { nextRunDecisionId, type DecisionRow } from "./decisions.ts";
import { taskTitle, type RunRow } from "./runs.ts";

/**
 * A review gate's questions (design: "A design's open questions become
 * Flowryn decisions"). `stage done --questions-file` opens one run-scoped
 * decision per question, reserved for the user and bound to the gate, in the
 * transaction that opens the gate, so the leader sees and relays them even
 * when the user cannot open the review page. The page asks them too, through
 * the widget Flowryn writes beside it, and the daemon's lavish-axi poll
 * records the answers (src/lavish/poller.ts). The first answer counts, from
 * either side. Answers are held while the gate is open and reach the worker
 * with the verdict; a gate passes only once every question is answered, and
 * changes close the ones still open.
 */

export const GATE_QUESTION_RESERVED = "a review question for the user";
const MAX_PAGE_BYTES = 5 * 1024 * 1024;

export interface GateRef {
  id: string;
  stage: string;
  review_url: string | null;
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Check a gate's review page: a regular .html file (no symlink) under the
 * run's report directory, mounting the widget when the gate carries
 * questions. Returns its real path, which the daemon polls and beside which
 * it writes the widget.
 */
export function checkReviewPage(page: string, reportDir: string, opts: { widget: boolean } = { widget: true }): string {
  let real: string;
  let root: string;
  try {
    if (lstatSync(page).isSymbolicLink()) throw new FlowrynError("bad_args", `--page ${page} is a symlink; name the page itself`);
    real = realpathSync(page);
    root = realpathSync(reportDir);
  } catch (error) {
    if (error instanceof FlowrynError) throw error;
    throw new FlowrynError("bad_args", `cannot read --page ${page}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
  }
  if (!isInside(real, root)) throw new FlowrynError("bad_args", `--page ${page} is outside $FLOWRYN_REPORT_DIR`, `write it under ${reportDir}`);
  if (extname(real).toLowerCase() !== ".html") throw new FlowrynError("bad_args", "--page must be the review page's .html file");
  const st = statSync(real);
  if (!st.isFile() || st.size > MAX_PAGE_BYTES) throw new FlowrynError("bad_args", `--page ${page} is not a regular file of at most 5 MB`);
  if (opts.widget && !pageMountsWidget(readFileSync(real, "utf8"))) throw new FlowrynError("bad_args", "the review page does not mount the question widget", `add ${MOUNT_SNIPPET}`);
  return real;
}

/** Open a gate's questions as reserved decisions. Call inside the transaction that opens the gate. */
export function openGateQuestions(db: Db, run: RunRow, gate: GateRef, page: string, parsed: GateQuestions, now: number): string[] {
  db.query("UPDATE gates SET page_path = ?2, decided = ?3 WHERE id = ?1").run(gate.id, page, JSON.stringify(parsed.decided));
  const title = taskTitle(db, run.task_id);
  const ids: string[] = [];
  for (const q of parsed.questions) {
    const id = nextRunDecisionId(db);
    db.query(
      `INSERT INTO decisions (id, task_id, run_id, question, options, blocking, state, origin, key, recommendation, reserved_reason, created_at, kind, gate_id, note, blocks)
       VALUES (?1, ?2, ?3, ?4, ?5, 0, 'open', ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
    ).run(id, run.task_id, run.id, q.question, JSON.stringify(q.options), `gate:${gate.id}`, q.key, q.recommend.join(", "), GATE_QUESTION_RESERVED, now, q.kind, gate.id, q.why, q.blocks);
    const event = appendEvent(db, { source: "cli", kind: "decision.opened", runId: run.id, taskId: run.task_id, payload: { decision: id, gate: gate.id, key: q.key, kind: q.kind, options: q.options, blocks: q.blocks }, ts: now });
    const choices = q.kind === "text" ? "free answer" : q.options.join(" | ");
    const item = openItem(db, {
      kind: "worker_question",
      eventSeq: event.seq,
      taskId: run.task_id,
      runId: run.id,
      line: `Review question ${id} on ${title} (${gate.stage} gate ${gate.id}): "${sanitizeLine(q.question, 120)}" [${choices}] recommends ${q.recommend.join(", ")}; answer on the review page or relay: flowryn decide ${id} <choice> --by captain`,
      now,
    });
    db.query("UPDATE items SET decision_id = ?2 WHERE id = ?1").run(item, id);
    ids.push(id);
  }
  return ids;
}

export function gateQuestions(db: Db, gateId: string): DecisionRow[] {
  return db.query("SELECT * FROM decisions WHERE gate_id = ?1 ORDER BY created_at, CAST(substr(id, 2) AS INTEGER)").all(gateId) as DecisionRow[];
}

function openIds(db: Db, gateId: string): string[] {
  return gateQuestions(db, gateId)
    .filter((d) => d.state === "open")
    .map((d) => d.id);
}

/** A review gate passes only once its questions are answered (the user's answer to q3: refuse). */
export function requireGateAnswered(db: Db, gate: { id: string; stage: string }): void {
  const open = openIds(db, gate.id);
  if (open.length === 0) return;
  throw new FlowrynError(
    "questions_open",
    `the ${gate.stage} review still has ${open.length} open question${open.length === 1 ? "" : "s"} (${open.join(", ")}); the gate passes once each is answered`,
    `answer on the review page, or relay the user's words: flowryn decide ${open[0]} <choice> --by captain`,
  );
}

/** The gate's questions for an approval prompt: the answers it carries, or what still blocks it. */
export function gateQuestionsLine(db: Db, gateId: string): string | null {
  const all = gateQuestions(db, gateId);
  if (all.length === 0) return null;
  const open = all.filter((d) => d.state === "open").map((d) => d.id);
  if (open.length > 0) return `${open.length} question${open.length === 1 ? "" : "s"} still open (${open.join(", ")}); it will be refused`;
  return `answers ${all.map((d) => `${d.id} = ${sanitizeLine(d.answer ?? "-", 60)}`).join("; ")}`;
}

/** The answers the verdict steer carries to the worker (held while the gate was open). */
export function gateAnswersNote(db: Db, gateId: string): string | null {
  const all = gateQuestions(db, gateId);
  const notes = (db.query("SELECT notes_path FROM gates WHERE id = ?1").get(gateId) as { notes_path: string | null } | null)?.notes_path ?? null;
  const parts: string[] = [];
  const answered = all.filter((d) => d.state === "answered");
  if (answered.length > 0) {
    const list = answered.map((d) => `${d.id} (${d.key ?? "-"}) = ${sanitizeLine(d.answer ?? "-", 1_000)}${d.rationale ? ` [their note: ${sanitizeLine(d.rationale, 2_000)}]` : ""}`);
    parts.push(`The user's answers to your review questions: ${list.join("; ")}.`);
  }
  const dismissed = all.filter((d) => d.state === "dismissed").map((d) => d.id);
  if (dismissed.length > 0) parts.push(`Closed unanswered: ${dismissed.join(", ")}.`);
  if (notes) parts.push(`The user also left notes on the review page: read ${notes}.`);
  return parts.length > 0 ? parts.join(" ") : null;
}

/** What closes a gate's questions unanswered: the review sent back, the run cancelled or ended for good, or the scout promoted. */
export type GateQuestionsCloser = "gate changes" | "run cancelled" | "run ended" | "promoted";

const CLOSERS: Record<GateQuestionsCloser, { why: string; resolvedBy: string }> = {
  "gate changes": { why: "the review was sent back", resolvedBy: "gate.changes" },
  "run cancelled": { why: "the run was cancelled", resolvedBy: "run.cancelled" },
  "run ended": { why: "the run ended for good", resolvedBy: "run.ended" },
  promoted: { why: "the scout was promoted to a ship", resolvedBy: "run.promoted" },
};

/** The gate closed without them: the questions still open close unanswered. Call inside a transaction. */
export function dismissGateQuestions(db: Db, run: RunRow, gateId: string, now: number, by: GateQuestionsCloser, source: EventSource): string[] {
  const { why, resolvedBy } = CLOSERS[by];
  const open = openIds(db, gateId);
  for (const id of open) {
    db.query("UPDATE decisions SET state = 'dismissed', answered_at = ?2, answered_via = ?3 WHERE id = ?1").run(id, now, by);
    appendEvent(db, { source, kind: "decision.dismissed", runId: run.id, taskId: run.task_id, payload: { decision: id, gate: gateId, why }, ts: now });
    resolveDecisionItems(db, id, `${resolvedBy} ${gateId}`, now);
  }
  return open;
}

/**
 * The run was cancelled, or ended for good (cleaned up, or replaced by a new
 * run of its task): its open review questions close unanswered. A failed run
 * keeps them open until then, since a resume brings its gate back and the
 * gate still refuses a pass until the user answers. Call inside a transaction.
 */
export function dismissRunQuestions(db: Db, run: RunRow, now: number, by: "run cancelled" | "run ended", source: EventSource): string[] {
  const gates = db.query("SELECT DISTINCT gate_id FROM decisions WHERE run_id = ?1 AND gate_id IS NOT NULL AND state = 'open'").all(run.id) as { gate_id: string }[];
  return gates.flatMap((g) => dismissGateQuestions(db, run, g.gate_id, now, by, source));
}

/** A new run of the task replaces its earlier ones: their open review questions close unanswered. Call inside a transaction. */
export function dismissEarlierRunsQuestions(db: Db, taskId: string, newRunId: string, now: number, source: EventSource): string[] {
  const runs = db.query("SELECT DISTINCT r.* FROM runs r JOIN decisions d ON d.run_id = r.id WHERE r.task_id = ?1 AND r.id != ?2 AND d.gate_id IS NOT NULL AND d.state = 'open'").all(taskId, newRunId) as RunRow[];
  return runs.flatMap((run) => dismissRunQuestions(db, run, now, "run ended", source));
}

/** Record where the notes a poll took from the review page went. Call inside a transaction. */
export function recordGateNotes(db: Db, gateId: string, path: string, prompts: number, now: number): void {
  const gate = db.query("SELECT run_id FROM gates WHERE id = ?1").get(gateId) as { run_id: string } | null;
  if (!gate) return;
  db.query("UPDATE gates SET notes_path = ?2 WHERE id = ?1").run(gateId, path);
  appendEvent(db, { source: "daemon", kind: "gate.notes", runId: gate.run_id, payload: { gate: gateId, prompts, path }, ts: now });
}

/** The user ended the review page's Lavish session: stop polling it. Call inside a transaction. */
export function recordLavishEnded(db: Db, gateId: string, now: number): void {
  const gate = db.query("SELECT run_id, lavish_ended FROM gates WHERE id = ?1").get(gateId) as { run_id: string; lavish_ended: number } | null;
  if (!gate || gate.lavish_ended === 1) return;
  db.query("UPDATE gates SET lavish_ended = 1 WHERE id = ?1").run(gateId);
  appendEvent(db, { source: "daemon", kind: "gate.lavish_ended", runId: gate.run_id, payload: { gate: gateId }, ts: now });
}

interface GateWidgetRow {
  id: string;
  run_id: string;
  stage: string;
  state: "open" | "passed" | "changes";
  page_path: string;
  decided: string | null;
  task_id: string;
}

/** A gate's widget state, or null when it carries no questions. */
export function widgetState(db: Db, gateId: string): { page: string; state: WidgetState } | null {
  const gate = db.query("SELECT g.id, g.run_id, g.stage, g.state, g.page_path, g.decided, r.task_id FROM gates g JOIN runs r ON r.id = g.run_id WHERE g.id = ?1 AND g.page_path IS NOT NULL").get(gateId) as GateWidgetRow | null;
  if (!gate) return null;
  const questions = gateQuestions(db, gateId).map((d) => ({
    id: d.id,
    key: d.key ?? d.id,
    kind: d.kind ?? "single",
    question: d.question,
    options: JSON.parse(d.options) as string[],
    recommend: d.kind === "text" ? [d.recommendation ?? ""] : (d.recommendation ?? "").split(", ").filter((r) => r.length > 0),
    blocks: d.blocks ?? "-",
    why: d.note,
    state: d.state,
    answer: d.answer,
    via: d.answered_via === "lavish" ? "the review page" : d.answered_via ? "your leader" : null,
  }));
  return { page: gate.page_path, state: { gate: gate.id, task: gate.task_id, stage: gate.stage, gateState: gate.state, decided: gate.decided ? JSON.parse(gate.decided) : [], questions } };
}

export interface PolledGate {
  id: string;
  page_path: string;
}

const LIVE_RUN = "r.state NOT IN ('cleaned','failed','cancelled')";

/**
 * Gates whose page the daemon polls: open on a live run with a known page,
 * and the user has not ended the session. Every review page is listened to
 * while its gate is open, with or without questions, so Lavish never shows
 * the page's agent as not listening while the review waits.
 */
export function gatesToPoll(db: Db): PolledGate[] {
  return db
    .query(
      `SELECT g.id, g.page_path FROM gates g JOIN runs r ON r.id = g.run_id
       WHERE g.state = 'open' AND ${LIVE_RUN} AND g.page_path IS NOT NULL AND g.lavish_ended = 0 ORDER BY g.opened_at`,
    )
    .all() as PolledGate[];
}

/** Feedback that opens with one of these words may read as the user passing the review; it is surfaced, never acted on. */
const PASS_WORDS = /^\s*(pass(ed)?|approved?|lgtm|looks good|ship it|go ahead)\b/i;
/** A clause after the pass word that still asks for changes makes the feedback changes, not a pass. */
const CHANGES_CLAUSE = /\b(but|once|except|until|after)\b/i;

export function readsAsPass(text: string): boolean {
  return PASS_WORDS.test(text) && !CHANGES_CLAUSE.test(text);
}

export interface GateFeedback {
  /** Answers the poll recorded, as decision ids. */
  recorded: string[];
  /** The user's own words from the page, one per prompt that is not an answer. */
  feedback: string[];
  /** Where the raw feedback was kept, if it was. */
  notes: string | null;
}

/**
 * What the user sent from a gate's review page, as one item for the leader
 * (review_feedback, batched with worker questions so it wakes the leader).
 * A pass in their words is named as one, for the leader to put to them; the
 * gate still passes only through a human channel. Call inside a transaction.
 */
export function openGateFeedback(db: Db, gateId: string, input: GateFeedback, now: number): string | null {
  if (input.recorded.length === 0 && input.feedback.length === 0 && input.notes === null) return null;
  const gate = db.query("SELECT g.stage, r.id AS run_id, r.task_id FROM gates g JOIN runs r ON r.id = g.run_id WHERE g.id = ?1").get(gateId) as { stage: string; run_id: string; task_id: string } | null;
  if (!gate) return null;
  const parts: string[] = [];
  if (input.recorded.length > 0) {
    const answers = input.recorded.map((id) => {
      const answer = (db.query("SELECT answer FROM decisions WHERE id = ?1").get(id) as { answer: string | null } | null)?.answer ?? "-";
      return `${id} = ${sanitizeLine(answer, 40)}`;
    });
    parts.push(`answered ${answers.join(", ")}`);
  }
  if (input.feedback.length > 0) {
    const more = input.feedback.length > 1 ? ` (+${input.feedback.length - 1} more)` : "";
    parts.push(`wrote "${sanitizeLine(input.feedback[0]!, 60)}"${more}`);
  }
  // An item line is one short line: the task id, not its title, and the pass first, so a long quote is what gets cut.
  const pass = input.feedback.some(readsAsPass) ? " may read as a pass (ask the user; only flowryn gate pass passes it)" : "";
  const notes = input.notes ? (parts.length > 0 ? "; notes beside the page" : "") : "";
  if (parts.length === 0) parts.push("left notes beside the page");
  const line = `Review feedback on ${gate.task_id} (${gate.stage} gate ${gateId})${pass}: the user ${parts.join(" and ")}${notes}`;
  const event = appendEvent(db, { source: "daemon", kind: "gate.feedback", runId: gate.run_id, taskId: gate.task_id, payload: { gate: gateId, recorded: input.recorded, prompts: input.feedback.length, pass: pass.length > 0 }, ts: now });
  return openItem(db, { kind: "review_feedback", eventSeq: event.seq, taskId: gate.task_id, runId: gate.run_id, line, now });
}

/** Gates with a widget (a page carrying questions) whose state may still change, for the widget writer. */
export function gatesWithWidget(db: Db, alsoIds: Iterable<string>): string[] {
  const open = (
    db
      .query(`SELECT g.id FROM gates g JOIN runs r ON r.id = g.run_id WHERE g.state = 'open' AND ${LIVE_RUN} AND g.page_path IS NOT NULL AND EXISTS (SELECT 1 FROM decisions d WHERE d.gate_id = g.id)`)
      .all() as { id: string }[]
  ).map((g) => g.id);
  return [...new Set([...open, ...alsoIds])];
}
