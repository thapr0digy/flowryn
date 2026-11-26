import { FlowrynError } from "../api/errors.ts";
import type { Db } from "../db/db.ts";
import { getMeta, setMeta } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { recordIntent } from "../journal/journal.ts";
import { capStoredText, sanitizeBlock, sanitizeLine } from "../util/sanitize.ts";
import { localDate } from "./dates.ts";
import { mintTaskId } from "./ids.ts";
import { takenIds } from "./plans.ts";
import { holdReason } from "./runs.ts";

/**
 * Decisions (cutover C1). A run-scoped question (q<N>, `flowryn ask`) lives
 * with its run; a standalone decision (k<N>) owns a backlog task of kind
 * decision, held for the user, that other tasks may wait on. The database
 * owns the content; the backlog owns the task, the hold and the dependency.
 */

export const DECISION_KEY = /^[a-z0-9][a-z0-9-]{0,47}$/;
/** A choice as a decision lists it: short, so it fits a prompt line and a CLI argument. */
export const DECISION_OPTION = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/;
const MAX_CONTEXT = 4_000;

export interface DecisionRow {
  id: string;
  task_id: string;
  run_id: string | null;
  question: string;
  options: string;
  blocking: number;
  state: "open" | "answered" | "dismissed";
  answer: string | null;
  answered_via: string | null;
  answered_at: number | null;
  origin: string | null;
  key: string | null;
  context: string | null;
  recommendation: string | null;
  reserved_reason: string | null;
  /** The reserved question's kind, recorded when it opened: a keyword class, ci-wait, nomistakes, or nomistakes-floor / nomistakes-unread (never eligible); null for a source's own words and older rows. */
  reserved_class: string | null;
  defer_until: string | null;
  /** policy: a `[decisions] nomistakes_rules` rule settled it (answered_via names the rule), or a deadline default took the recommendation (answered_via `deadline`). */
  /** worker: unattended mode took the worker's own recommendation (answered_via autonomous). */
  answered_by: "captain" | "leader" | "policy" | "worker" | null;
  rationale: string | null;
  created_at: number | null;
  /** single (NULL), multi or text: a review gate's question may take more than one choice, or free text. */
  kind: "single" | "multi" | "text" | null;
  /** The review gate a question was handed in with. */
  gate_id: string | null;
  /** The worker's why for a review gate's question. */
  note: string | null;
  /** The choice in the worker's work that waits on the answer. */
  blocks: string | null;
  /** Unattended mode (src/attention/autonomy-pass.ts): the grant that decided or parked it, and which. */
  autonomy_id?: string | null;
  autonomy_state?: "decided" | "parked" | null;
  /** The daemon's own no-mistakes read for an `ask --nomistakes` (src/attention/real-actions.ts NmRecord); never from the question. */
  nm_record?: string | null;
  /** A worker question's option costs: each option's consequence, as JSON keyed by option; null on older rows. */
  consequences?: string | null;
  /** The recommended choice's main downside, as the worker wrote it. */
  downside?: string | null;
}

/**
 * Option costs (docs/notes/2026-11-15-worker-questions-carry-gn.md): a worker question names, for
 * each option, what happens if it is picked, what waits or is blocked, what breaks if it is wrong;
 * and for its recommendation the main downside. The user weighs the options on those lines.
 */
export const MAX_COST_CHARS = 200;

export interface OptionCosts {
  consequences: Record<string, string>;
  downside: string | null;
}

/** One cost as stored: one clean line, or why it cannot be. */
function costLine(raw: string): string | { problem: string } {
  const line = sanitizeLine(raw, Number.MAX_SAFE_INTEGER);
  if (line.length === 0) return { problem: "is empty" };
  if (line.length > MAX_COST_CHARS) return { problem: `is longer than ${MAX_COST_CHARS} characters` };
  return line;
}

/**
 * Check a worker question's costs against its options: every option has a consequence, none names
 * an unknown option, and a recommendation brings its downside. Returns the costs as stored, or the
 * first problem in words the caller frames with its own example.
 */
export function checkOptionCosts(options: string[], given: Map<string, string>, recommended: string[], downside: string | null): OptionCosts | { problem: string } {
  const stray = [...given.keys()].find((o) => !options.includes(o));
  if (stray !== undefined) return { problem: `a consequence names "${sanitizeLine(stray, 40)}", which is not one of the options (${options.join(", ")})` };
  const lines: [string, string][] = [];
  for (const option of options) {
    const raw = given.get(option);
    if (raw === undefined) return { problem: `option "${option}" has no consequence: say what happens if it is picked, what waits or is blocked, and what breaks if it is wrong` };
    const line = costLine(raw);
    if (typeof line !== "string") return { problem: `the consequence of "${option}" ${line.problem}` };
    lines.push([option, line]);
  }
  const consequences = Object.fromEntries(lines);
  if (downside === null) {
    if (recommended.length === 0) return { consequences, downside: null };
    return { problem: `the recommendation (${recommended.join(", ")}) has no downside: name its main cost, so the user sees what they accept` };
  }
  const line = costLine(downside);
  if (typeof line !== "string") return { problem: `the recommendation's downside ${line.problem}` };
  return { consequences, downside: line };
}

/** The choices a decision recommends: a multi choice's list, else the one recommendation. */
export function recommendedChoices(d: Pick<DecisionRow, "kind" | "recommendation">): string[] {
  if (!d.recommendation) return [];
  return d.kind === "multi" ? d.recommendation.split(", ").filter((r) => r.length > 0) : [d.recommendation];
}

/** A decision's option costs as stored, each a clean capped line; empty for older rows and standalone decisions. */
export function optionCostsOf(d: Pick<DecisionRow, "consequences" | "downside">): OptionCosts {
  const lines: [string, string][] = [];
  try {
    const parsed: unknown = d.consequences ? JSON.parse(d.consequences) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [option, text] of Object.entries(parsed)) if (typeof text === "string" && text.trim()) lines.push([option, sanitizeLine(text, MAX_COST_CHARS)]);
    }
  } catch {
    // A row the daemon wrote is JSON; an unreadable one shows the fallback text, never an error.
  }
  const downside = d.downside ? sanitizeLine(d.downside, MAX_COST_CHARS) : "";
  return { consequences: Object.fromEntries(lines), downside: downside || null };
}

/** answered_via of a deadline default (src/attention/deadline-defaults.ts): a policy answer the user may undo. */
export const DEADLINE_VIA = "deadline";
/** answered_via of a review-gate question the validator took as the worker recommended (src/attention/gate-validator.ts): a policy answer the user may undo. */
export const VALIDATOR_VIA = "validator";

/**
 * answered_via of a reserved question the leader answered under a live autonomy grant
 * (docs/notes/2026-11-23-while-the-user-67.md): the leader's answer, which the user may undo.
 */
export const LEADER_AWAY_VIA = "leader-away";

/** A rule's answer the user may still undo (decide --by captain on an answered_by policy decision). */
export function isRuleAnswer(d: Pick<DecisionRow, "state" | "answered_by" | "answered_via">): boolean {
  if (d.state !== "answered") return false;
  // A deadline default (DEADLINE_VIA) is a policy answer too, undone the same way; so is unattended mode's take of
  // the worker's recommendation, and the leader's answer to a reserved question while the user was away.
  return d.answered_by === "policy" || d.answered_by === "worker" || (d.answered_by === "leader" && d.answered_via === LEADER_AWAY_VIA);
}

/** The user may answer it: open, or a rule's answer to undo. */
export function captainAnswerable(d: Pick<DecisionRow, "state" | "answered_by" | "answered_via">): boolean {
  return d.state === "open" || isRuleAnswer(d);
}

/** Left out of the briefing until a later local day (`flowryn decision defer`). */
export function isDeferred<T extends Pick<DecisionRow, "defer_until">>(d: T, now: number): d is T & { defer_until: string } {
  return d.defer_until !== null && d.defer_until > localDate(new Date(now));
}

export function getDecision(db: Db, id: string): DecisionRow | null {
  return db.query("SELECT * FROM decisions WHERE id = ?1").get(id) as DecisionRow | null;
}

/** The next run-scoped question id (q<N>), shared by `flowryn ask` and a review gate's questions. */
export function nextRunDecisionId(db: Db): string {
  const next = Number(getMeta(db, "next_decision_no") ?? "1");
  setMeta(db, "next_decision_no", String(next + 1));
  return `q${next}`;
}

function nextStandaloneId(db: Db): string {
  const next = Number(getMeta(db, "next_standalone_decision_no") ?? "1");
  setMeta(db, "next_standalone_decision_no", String(next + 1));
  return `k${next}`;
}

/**
 * Reserve an open decision for the user, upgrade-only: a decision that already
 * has a reason keeps it. Call inside a transaction. Returns the row's reason.
 */
export function reserveDecision(db: Db, d: { id: string; task_id: string; reserved_reason: string | null }, reason: string, now: number): string {
  if (d.reserved_reason !== null) return d.reserved_reason;
  db.query("UPDATE decisions SET reserved_reason = ?2 WHERE id = ?1").run(d.id, reason);
  appendEvent(db, { source: "cli", kind: "decision.reserved", taskId: d.task_id, payload: { decision: d.id, reserved: reason }, ts: now });
  return reason;
}

export interface NewStandalone {
  key: string;
  question: string;
  options: string[];
  recommendation?: string | null;
  context?: string | null;
  origin: string;
  reservedReason?: string | null;
  blocks?: string[];
  project?: string | null;
  now: number;
}

/** Create a standalone decision and its held task. Call inside a transaction. */
export function createStandaloneDecision(db: Db, d: NewStandalone): { id: string; taskId: string; created: boolean; reservedReason: string | null } {
  if (!DECISION_KEY.test(d.key)) throw new FlowrynError("bad_args", `decision key ${d.key} must be lowercase letters, digits and dashes`);
  const existing = db.query("SELECT id, task_id, run_id, reserved_reason FROM decisions WHERE origin = ?1 AND key = ?2").get(d.origin, d.key) as { id: string; task_id: string; run_id: string | null; reserved_reason: string | null } | null;
  if (existing && existing.run_id !== null) throw new FlowrynError("already_exists", `key ${d.key} from ${d.origin} is already the run's question ${existing.id}`, "use another key");
  if (existing) {
    // A repeat decision add names no new question, but block is idempotent: a --blocks target
    // given this time still gets its blocked-by edge, even though the decision itself is not new.
    for (const blocked of d.blocks ?? []) recordIntent(db, { file: "backlog", verb: "block", taskId: blocked, positional: [blocked], flags: { by: existing.task_id }, now: d.now });
    // The leader may add a reserved reason later (a --blocks target that turns out to be a
    // non-yolo merge, a --reserved this time) but never remove or replace one already recorded.
    const reservedReason = d.reservedReason ? reserveDecision(db, existing, d.reservedReason, d.now) : existing.reserved_reason;
    return { id: existing.id, taskId: existing.task_id, created: false, reservedReason };
  }
  const question = capStoredText(sanitizeBlock(d.question).trim());
  if (question.length === 0) throw new FlowrynError("bad_args", "a decision needs a question");
  const context = d.context ? sanitizeBlock(d.context).trim().slice(0, MAX_CONTEXT) : null;
  const id = nextStandaloneId(db);
  const taskId = mintTaskId(`decision ${d.key}`, takenIds(db));
  const reservedReason = d.reservedReason ?? null;
  db.query(
    `INSERT INTO decisions (id, task_id, run_id, question, options, blocking, state, origin, key, context, recommendation, reserved_reason, created_at)
     VALUES (?1, ?2, NULL, ?3, ?4, 1, 'open', ?5, ?6, ?7, ?8, ?9, ?10)`,
  ).run(id, taskId, question, JSON.stringify(d.options), d.origin, d.key, context, d.recommendation ?? null, reservedReason, d.now);
  const flags: Record<string, string> = { kind: "decision", body: context ?? question };
  if (d.project) flags.repo = d.project;
  recordIntent(db, { file: "backlog", verb: "add", taskId, positional: [taskId, sanitizeLine(question, 120)], flags, now: d.now });
  recordIntent(db, { file: "backlog", verb: "hold", taskId, positional: [taskId], flags: { reason: holdReason(`decision ${id}`), kind: "captain" }, now: d.now });
  for (const blocked of d.blocks ?? []) recordIntent(db, { file: "backlog", verb: "block", taskId: blocked, positional: [blocked], flags: { by: taskId }, now: d.now });
  appendEvent(db, { source: "cli", kind: "decision.opened", taskId, payload: { decision: id, origin: d.origin, key: d.key, reserved: reservedReason, blocks: d.blocks ?? [] }, ts: d.now });
  return { id, taskId, created: true, reservedReason };
}
