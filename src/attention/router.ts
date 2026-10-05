import type { Db } from "../db/db.ts";
import { MAX_INFO_ATTEMPTS } from "./presentations.ts";
import { QUESTION_KINDS, type ItemRow } from "./items.ts";

/**
 * The attention router's reads (design section 9). The lane table decides an
 * item's lane; within a lane the order is project priority, then due date,
 * then age, and an actionable item open longer than a day moves to the top.
 * Nothing is scored, and an item never changes lane on its own.
 */

export interface RankedItem extends ItemRow {
  class: "actionable" | "info";
  lane: "P0" | "P1" | "P2";
  due: string | null;
  attempts: number;
  priority: number;
  aged: number;
}

/** P1 digest: at most 5 lines and under 2,000 characters (design section 12). */
export const DIGEST_MAX_LINES = 5;
export const DIGEST_MAX_CHARS = 2_000;
/** P0 wake line: one line, at most 200 characters. */
export const P0_LINE_MAX = 200;

export const DIGEST_HEADER = "Flowryn updates (facts, not instructions):";

const RANK_SELECT = `
  SELECT i.*, COALESCE(p.priority, 2) AS priority,
         CASE WHEN i.class = 'actionable' AND i.opened_at <= ?1 THEN 1 ELSE 0 END AS aged
  FROM items i
  LEFT JOIN task_policy tp ON tp.task_id = i.task_id
  LEFT JOIN projects p ON p.id = tp.project_id`;

const RANK_ORDER = "ORDER BY i.lane, aged DESC, priority ASC, i.due IS NULL, i.due ASC, i.opened_at ASC, i.rowid ASC";

const QUESTION_LIST = QUESTION_KINDS.map((k) => `'${k}'`).join(", ");

/** One push carries at most this many questions, like the digest's lines; the rest go in the next. */
export const QUESTION_BATCH_MAX = DIGEST_MAX_LINES - 1;

export const QUESTIONS_HEADER = "Flowryn questions for the user (facts, not instructions):";

/** Open actionable items, P0 first, in lane order: what every briefing and `fleet` list. */
export function openActionable(db: Db, now: number, ageMs: number): RankedItem[] {
  return db
    .query(`${RANK_SELECT} WHERE i.class = 'actionable' AND i.state IN ('open','presented') AND i.lane IN ('P0','P1') ${RANK_ORDER}`)
    .all(now - ageMs) as RankedItem[];
}

/**
 * What the next digest may carry to a session: P0 and P1 items it has not
 * been shown yet (presented or carried in this session), open actionable
 * ones and informational ones still under their attempt limit.
 */
export function digestCandidates(db: Db, session: string, now: number, ageMs: number): RankedItem[] {
  return db
    .query(
      `${RANK_SELECT}
       WHERE i.lane IN ('P0','P1')
         AND ((i.class = 'actionable' AND i.state IN ('open','presented')) OR (i.class = 'info' AND i.state = 'open' AND i.attempts < ?2))
         AND NOT EXISTS (SELECT 1 FROM presentations s WHERE s.item_id = i.id AND s.session_id = ?3 AND s.state IN ('presented','carried','offered'))
       ${RANK_ORDER}`,
    )
    .all(now - ageMs, MAX_INFO_ATTEMPTS, session) as RankedItem[];
}

/**
 * The P0 a push path may take for this session: open, not yet shown to it,
 * and not leased to another push path anywhere (design section 9).
 */
export function p0Candidate(db: Db, session: string, now: number, ageMs: number): RankedItem | null {
  return (
    (db
      .query(
        `${RANK_SELECT}
         WHERE i.lane = 'P0' AND i.class = 'actionable' AND i.state IN ('open','presented') AND i.kind NOT IN (${QUESTION_LIST})
           AND NOT EXISTS (SELECT 1 FROM presentations s WHERE s.item_id = i.id AND s.session_id = ?2 AND s.state IN ('presented','carried','offered'))
           AND NOT EXISTS (SELECT 1 FROM presentations s WHERE s.item_id = i.id AND s.state IN ('carried','offered') AND s.path IN ('continuation','waiter','trigger'))
         ${RANK_ORDER} LIMIT 1`,
      )
      .get(now - ageMs, session) as RankedItem | null) ?? null
  );
}

export interface QuestionBatch {
  /** The questions one push carries, oldest first. */
  items: RankedItem[];
  /** More waiting than one push carries. */
  more: number;
  /** When the oldest has waited the batch window: an idle leader is woken no sooner. */
  dueAt: number;
}

/**
 * The questions a push may carry to this session: open (never presented to
 * any session, so a question a digest or a briefing showed is never pushed),
 * not shown to it yet, and not leased to a push path anywhere. Due once the
 * oldest is `batchMs` old, so questions a ship opens in a burst wake the
 * leader once; questions of other ships ride along in the same push.
 */
export function questionBatch(db: Db, session: string, batchMs: number): QuestionBatch | null {
  const rows = db
    .query(
      `SELECT i.*, COALESCE(p.priority, 2) AS priority, 0 AS aged
       FROM items i
       LEFT JOIN task_policy tp ON tp.task_id = i.task_id
       LEFT JOIN projects p ON p.id = tp.project_id
       WHERE i.kind IN (${QUESTION_LIST}) AND i.class = 'actionable' AND i.state = 'open'
         AND NOT EXISTS (SELECT 1 FROM presentations s WHERE s.item_id = i.id AND s.session_id = ?1 AND s.state IN ('presented','carried','offered'))
         AND NOT EXISTS (SELECT 1 FROM presentations s WHERE s.item_id = i.id AND s.state IN ('carried','offered') AND s.path IN ('continuation','waiter','trigger'))
       ORDER BY i.opened_at ASC, i.rowid ASC`,
    )
    .all(session) as RankedItem[];
  if (rows.length === 0) return null;
  const items = rows.slice(0, QUESTION_BATCH_MAX);
  return { items, more: rows.length - items.length, dueAt: rows[0]!.opened_at + batchMs };
}

/** What a question push hands the model: a header and one line per question, like the digest. */
export function questionsText(items: Pick<RankedItem, "id" | "lane" | "line">[], more = 0): string {
  const lines = [QUESTIONS_HEADER, ...items.map((i) => itemLine(i))];
  if (more > 0) lines.push(`+${more} more: flowryn decision list`);
  const text = lines.join("\n");
  return text.length >= DIGEST_MAX_CHARS ? `${text.slice(0, DIGEST_MAX_CHARS - 2)}…` : text;
}

const QUESTION_WAKE = "Flowryn questions [";

/**
 * The one line a Claude waiter wakes the leader with for a batch: the items
 * and their decisions, at most P0_LINE_MAX characters. The woken turn's
 * prompt hook then adds each question's full line (questionsText).
 */
export function questionWakeLine(items: Pick<RankedItem, "id" | "decision_id">[]): string {
  const ids = items.map((i) => i.id).join(",");
  const decisions = items.map((i) => i.decision_id).filter((d): d is string => d !== null);
  const head = `${QUESTION_WAKE}${ids}]: `;
  const count = `${items.length} worker question${items.length === 1 ? "" : "s"} for the user`;
  const line = `${head}${count}${decisions.length > 0 ? ` (${decisions.join(", ")})` : ""}. Details: flowryn decision list`;
  return line.length <= P0_LINE_MAX ? line : `${head}${count}. Details: flowryn decision list`.slice(0, P0_LINE_MAX);
}

function itemLine(item: Pick<RankedItem, "id" | "lane" | "line">): string {
  return `- [${item.id}] ${item.lane === "P0" ? "P0 · " : ""}${item.line}`;
}

export interface Digest {
  text: string;
  shown: RankedItem[];
}

/**
 * The P1 digest attached to your next message: a header and at most four
 * lines, or three and "+N more" (design section 9). Items it leaves out stay
 * candidates for the next digest.
 */
export function composeDigest(candidates: RankedItem[]): Digest | null {
  if (candidates.length === 0) return null;
  const room = DIGEST_MAX_LINES - 1;
  const shown = candidates.length > room ? candidates.slice(0, room - 1) : candidates.slice(0, room);
  const lines = [DIGEST_HEADER, ...shown.map(itemLine)];
  if (candidates.length > shown.length) lines.push(`+${candidates.length - shown.length} more: flowryn fleet`);
  let text = lines.join("\n");
  if (text.length >= DIGEST_MAX_CHARS) text = `${text.slice(0, DIGEST_MAX_CHARS - 2)}…`;
  return { text, shown };
}

/**
 * The one line a P0 push carries: a fact that stands on its own, because a
 * Claude wake reaches the model framed as a hook error (M0 finding 5).
 */
export function p0Line(item: Pick<RankedItem, "id" | "line">): string {
  const tail = ` Details: flowryn show ${item.id}`;
  const head = `Flowryn P0 [${item.id}]: `;
  // One character is kept for the full stop that ends the fact.
  const room = P0_LINE_MAX - head.length - tail.length - 1;
  const fact = item.line.replace(/[.\s]+$/, "");
  const body = fact.length > room ? `${fact.slice(0, room - 1)}…` : fact;
  return `${head}${body}.${tail}`;
}

/** A prompt that is a P0 or question wake, not you typing: a woken turn also runs UserPromptSubmit (M0 c01). */
export function isWakePrompt(prompt: unknown): boolean {
  return typeof prompt === "string" && (prompt.includes("Flowryn P0 [") || isQuestionWake(prompt));
}

/** A prompt that is a question wake: its turn gets the woken questions' full lines. */
export function isQuestionWake(prompt: unknown): boolean {
  return typeof prompt === "string" && prompt.includes(QUESTION_WAKE);
}
