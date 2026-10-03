import { FlowrynError } from "../api/errors.ts";
import type { Db } from "../db/db.ts";
import { getMeta, setMeta } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { recordIntent } from "../journal/journal.ts";
import { sanitizeBlock, sanitizeLine } from "../util/sanitize.ts";
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
const MAX_QUESTION = 2_000;
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
  defer_until: string | null;
  answered_by: "captain" | "leader" | null;
  rationale: string | null;
  created_at: number | null;
}

export function getDecision(db: Db, id: string): DecisionRow | null {
  return db.query("SELECT * FROM decisions WHERE id = ?1").get(id) as DecisionRow | null;
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
  const question = sanitizeBlock(d.question).trim().slice(0, MAX_QUESTION);
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
