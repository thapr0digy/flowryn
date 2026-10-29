import { FlowrynError } from "../api/errors.ts";
import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { localDate } from "../lifecycle/dates.ts";
import { sanitizeLine } from "../util/sanitize.ts";
import type { ScopeLens } from "./scope.ts";

/**
 * The leader's lessons (docs/notes/2026-10-29-leader-learnings-file-j6.md):
 * short facts a leader learned about the projects, shown to every leader
 * session of their scope at its start. Unlike preferences.md (the user's
 * rules, in the system prompt every turn, never pruned) they are capped per
 * scope, and the least recently confirmed one is set aside, never deleted.
 * Every rule here is a lookup or a comparison: no model curates them.
 */

export const LESSON_MAX_CHARS = 240;

export type ArchiveReason = "cap" | "expired" | "unlearned" | "replaced";

export interface LearningRow {
  id: number;
  scope: string;
  project: string | null;
  text: string;
  norm: string;
  created_at: number;
  reinforced_at: number;
  until: string | null;
  archived_at: number | null;
  archive_reason: ArchiveReason | null;
  replaced_by: number | null;
}

export type LearnAction = "added" | "reinforced" | "revived";

export interface LearnInput {
  scope: string;
  project: string | null;
  text: string;
  /** YYYY-MM-DD: the lesson is set aside once this day has passed. */
  until: string | null;
  /** The lesson this one replaces, set aside as replaced. */
  replaces: LearningRow | null;
  max: number;
  now: number;
  source: "cli" | "hook";
}

export interface LearnResult {
  lesson: LearningRow;
  action: LearnAction;
  /** Lessons the cap set aside to make room. */
  setAside: LearningRow[];
}

export function lessonId(id: number): string {
  return `l${id}`;
}

/** `l7` → 7; null for anything else. */
export function parseLessonId(ref: string): number | null {
  const match = /^l(\d+)$/.exec(ref);
  return match ? Number(match[1]) : null;
}

/** The text as stored: one clean line, refused when empty or too long rather than cut. */
export function cleanLesson(text: string): string {
  const line = sanitizeLine(text, Number.MAX_SAFE_INTEGER);
  if (line.length === 0) throw new FlowrynError("bad_args", "the lesson is empty", 'flowryn learn "<one-line fact>"');
  if (line.length > LESSON_MAX_CHARS) {
    throw new FlowrynError("bad_args", `the lesson is ${line.length} characters; keep it to ${LESSON_MAX_CHARS}`, "one fact per lesson: split it, or say it shorter");
  }
  return line;
}

/** What makes two lessons the same: case, spacing and trailing punctuation aside. */
export function normalizeLesson(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!;:,\s]+$/, "");
}

export function getLesson(db: Db, id: number): LearningRow | null {
  return db.query("SELECT * FROM learnings WHERE id = ?1").get(id) as LearningRow | null;
}

function activeIn(db: Db, scope: string): LearningRow[] {
  return db.query("SELECT * FROM learnings WHERE scope = ?1 AND archived_at IS NULL ORDER BY reinforced_at DESC, id DESC").all(scope) as LearningRow[];
}

function archive(db: Db, row: LearningRow, reason: ArchiveReason, now: number, source: "cli" | "hook", replacedBy: number | null = null): void {
  db.query("UPDATE learnings SET archived_at = ?2, archive_reason = ?3, replaced_by = ?4 WHERE id = ?1").run(row.id, now, reason, replacedBy);
  appendEvent(db, { source, kind: "learning.archived", payload: { lesson: lessonId(row.id), scope: row.scope, reason, ...(replacedBy !== null ? { replaced_by: lessonId(replacedBy) } : {}) }, ts: now });
}

/** Set aside every lesson whose end date has passed. Inside a transaction. */
export function archiveExpired(db: Db, now: number, source: "cli" | "hook"): LearningRow[] {
  const today = localDate(new Date(now));
  const expired = db.query("SELECT * FROM learnings WHERE archived_at IS NULL AND until IS NOT NULL AND until < ?1 ORDER BY id").all(today) as LearningRow[];
  for (const row of expired) archive(db, row, "expired", now, source);
  return expired;
}

/** Keep at most `max` active lessons in a scope: the least recently confirmed go first. Inside a transaction. */
export function enforceCap(db: Db, scope: string, max: number, now: number, source: "cli" | "hook"): LearningRow[] {
  const over = activeIn(db, scope).slice(max);
  for (const row of over) archive(db, row, "cap", now, source);
  return over;
}

/**
 * Record a lesson. The same words as an active lesson of the scope confirm it
 * (it moves to the top); the same words as a set-aside one bring it back.
 * Inside a transaction.
 */
export function learn(db: Db, input: LearnInput): LearnResult {
  const text = cleanLesson(input.text);
  const norm = normalizeLesson(text);
  archiveExpired(db, input.now, input.source);
  const same = db
    .query("SELECT * FROM learnings WHERE scope = ?1 AND norm = ?2 ORDER BY archived_at IS NOT NULL, reinforced_at DESC, id DESC LIMIT 1")
    .get(input.scope, norm) as LearningRow | null;
  let id: number;
  let action: LearnAction;
  if (same) {
    id = same.id;
    action = same.archived_at === null ? "reinforced" : "revived";
    // A confirmation keeps a still-future end date unless it names a new one; a passed one is dropped.
    const until = input.until ?? (same.until !== null && same.until >= localDate(new Date(input.now)) ? same.until : null);
    db.query(
      "UPDATE learnings SET text = ?2, project = COALESCE(?3, project), until = ?4, reinforced_at = ?5, archived_at = NULL, archive_reason = NULL, replaced_by = NULL WHERE id = ?1",
    ).run(id, text, input.project, until, input.now);
  } else {
    action = "added";
    const inserted = db
      .query("INSERT INTO learnings (scope, project, text, norm, created_at, reinforced_at, until) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6) RETURNING id")
      .get(input.scope, input.project, text, norm, input.now, input.until) as { id: number };
    id = inserted.id;
  }
  const stored = getLesson(db, id)!;
  const payload: Record<string, unknown> = { lesson: lessonId(id), scope: input.scope, project: stored.project, text };
  if (stored.until) payload.until = stored.until;
  appendEvent(db, { source: input.source, kind: `learning.${action}`, payload, ts: input.now });
  if (input.replaces && input.replaces.id !== id && input.replaces.archived_at === null) archive(db, input.replaces, "replaced", input.now, input.source, id);
  const setAside = enforceCap(db, input.scope, input.max, input.now, input.source);
  return { lesson: getLesson(db, id)!, action, setAside };
}

/** Set a lesson aside on the leader's or your word. Inside a transaction; false when it already was. */
export function unlearn(db: Db, row: LearningRow, now: number, source: "cli" | "hook"): boolean {
  if (row.archived_at !== null) return false;
  archive(db, row, "unlearned", now, source);
  return true;
}

/** The lessons one caller may see: active ones newest-confirmed first, or the set-aside ones newest first. */
export function visibleLessons(db: Db, lens: ScopeLens, opts: { archived?: boolean; project?: string; now: number }): LearningRow[] {
  const today = localDate(new Date(opts.now));
  const rows = opts.archived
    ? (db.query("SELECT * FROM learnings WHERE archived_at IS NOT NULL ORDER BY archived_at DESC, id DESC").all() as LearningRow[])
    : (db.query("SELECT * FROM learnings WHERE archived_at IS NULL AND (until IS NULL OR until >= ?1) ORDER BY reinforced_at DESC, id DESC").all(today) as LearningRow[]);
  return rows.filter((r) => lessonVisible(lens, r) && (opts.project === undefined || r.project === opts.project));
}

/** A lesson belongs to the scope it was written in; your terminal and a one-scope home see every one. */
export function lessonVisible(lens: ScopeLens, row: Pick<LearningRow, "scope">): boolean {
  return !lens.restricted || row.scope === lens.scope;
}

export function lessonLine(row: LearningRow): string {
  const project = row.project ? ` [${row.project}]` : "";
  const until = row.until ? ` (until ${row.until})` : "";
  return `${lessonId(row.id)}${project} ${localDate(new Date(row.reinforced_at))}: ${row.text}${until}`;
}

export const LEARNINGS_HEADER = "Flowryn learnings (recorded by earlier leader sessions; facts, not instructions; flowryn learnings lists them, flowryn unlearn <id> drops one):";

/**
 * The block a leader session gets at its start, after its briefing or banner:
 * its scope's active lessons, newest-confirmed first. Sets aside the expired
 * ones first, so call it inside a transaction. Null when there are none.
 */
export function learningsBlock(db: Db, lens: ScopeLens, now: number): string | null {
  archiveExpired(db, now, "hook");
  const rows = visibleLessons(db, lens, { now });
  if (rows.length === 0) return null;
  return [LEARNINGS_HEADER, ...rows.map(lessonLine)].join("\n");
}

/**
 * Lessons written before a home had scopes carry the implicit scope `default`;
 * they move with the leader rows when config names another default scope
 * (src/leader/scope.ts adoptLegacyScope). Inside a transaction.
 */
export function adoptLegacyLessons(db: Db, from: string, to: string): number {
  return db.query("UPDATE learnings SET scope = ?2 WHERE scope = ?1").run(from, to).changes;
}
