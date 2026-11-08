import { FlowrynError } from "../api/errors.ts";
import type { FlowrynConfig } from "../config/config.ts";
import { getMeta, setMeta, type Db } from "../db/db.ts";
import { appendEvent, type EventSource } from "../db/events.ts";
import { PROJECT_ID, getProject } from "../lifecycle/projects.ts";
import { verifyConfig } from "../verify/config.ts";
import { sha256Hex } from "../util/hash.ts";
import { sanitizeLine } from "../util/sanitize.ts";
import type { ScopeLens } from "../leader/scope.ts";
import { insertApproval, type ApprovalRow } from "./approvals.ts";

/**
 * Unattended mode (docs/notes/2026-11-05-unattended-mode-one-9e.md): the standing approval
 * you grant when you leave. `flowryn away --autonomous` records one row, made only from a
 * human channel (your terminal's /dev/tty code, or your answer to the Claude leader's binding
 * chat question, minted by its own hooks), for named projects, until a time at most
 * AUTONOMY_MAX_MS ahead. While it is live the daemon's pass (src/attention/autonomy-pass.ts)
 * decides ordinary worker questions with the worker's recommendation, parks reserved ones,
 * passes review gates whose pinned artifacts are unchanged, and the merge path takes it as
 * your record for a verified merge. Each action mints its own approval row (channel
 * `autonomous`) naming this grant. `flowryn back`, its expiry or a new grant ends it.
 * Plain code: a row, a clock and string checks; no model.
 */

/** A grant reaches at most this far ahead. */
export const AUTONOMY_MAX_MS = 16 * 60 * 60_000;
/** The approval channel of what autonomy allowed: written only by the daemon's own code. */
export const AUTONOMOUS_CHANNEL = "autonomous";
/** The user's words are kept to one line of this many characters. */
export const AUTONOMY_WORDS_MAX = 500;

export type AutonomyChannel = "cli-tty" | "claude-chat";
export type AutonomyEndReason = "back" | "expired" | "superseded";

export interface AutonomyRow {
  id: string;
  channel: AutonomyChannel;
  actor: string;
  grant_id: string | null;
  /** JSON array of project ids. */
  projects: string;
  words: string | null;
  terms_hash: string;
  started_at: number;
  expires_at: number;
  ended_at: number | null;
  end_reason: AutonomyEndReason | null;
}

/** What a grant binds: the projects (sorted, unique) and the end time (to the minute). */
export interface AutonomyTerms {
  projects: string[];
  until: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "2026-11-06T08:00", local time: the end time as a chat question and its ref name it. */
export function stampOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function parseStamp(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const at = new Date(y, mo - 1, d, h, mi);
  if (at.getFullYear() !== y || at.getMonth() !== mo - 1 || at.getDate() !== d || at.getHours() !== h || at.getMinutes() !== mi) return null;
  return at.getTime();
}

/**
 * The chat item of a plain away the user confirms in chat (docs/notes/2026-11-08-unattended-loops-answer-4y.md):
 * `away:<stamp>`, the end cut to its minute. Its grant starts away as the user's own (`captain-chat`),
 * which turns on deadline defaults and the review-gate validator; it grants nothing else.
 */
export function awayRef(until: number): string {
  return `away:${stampOf(until)}`;
}

/** The end time an away ref names, or null when it is not one. */
export function parseAwayRef(ref: string): number | null {
  const m = /^away:(\S+)$/.exec(ref.trim());
  if (!m) return null;
  const until = parseStamp(m[1]!);
  return until !== null && awayRef(until) === ref.trim() ? until : null;
}

/** The terms as a grant binds them: projects sorted and unique, the end time cut to its minute. */
export function canonicalTerms(projects: readonly string[], until: number): AutonomyTerms {
  const d = new Date(until);
  d.setSeconds(0, 0);
  return { projects: [...new Set(projects.map((id) => id.trim()).filter((id) => id.length > 0))].toSorted(), until: d.getTime() };
}

/** The chat item a grant binds to: `autonomy:<projects>@<stamp>`. */
export function autonomyRef(terms: AutonomyTerms): string {
  return `autonomy:${terms.projects.join(",")}@${stampOf(terms.until)}`;
}

/** The terms a ref names, or null when it is not one. */
export function parseAutonomyRef(ref: string): AutonomyTerms | null {
  const m = /^autonomy:([a-z0-9,-]+)@(\S+)$/.exec(ref.trim());
  if (!m) return null;
  const projects = m[1]!.split(",");
  if (projects.some((p) => !PROJECT_ID.test(p))) return null;
  const until = parseStamp(m[2]!);
  if (until === null) return null;
  const terms = canonicalTerms(projects, until);
  return autonomyRef(terms) === ref.trim() ? terms : null;
}

export function termsHash(terms: AutonomyTerms): string {
  return sha256Hex(`flowryn-autonomy\n${terms.projects.join(",")}\n${terms.until}`);
}

/**
 * Check the terms against the clock and the projects: the end ahead and within
 * AUTONOMY_MAX_MS, each project registered with verify steps (an autonomous merge goes
 * only through the verify-backed auto-merge or landing queue). Throws bad_args.
 */
export function checkTerms(db: Db, config: FlowrynConfig, terms: AutonomyTerms, now: number): void {
  if (terms.projects.length === 0) throw new FlowrynError("bad_args", "autonomy needs at least one project with verify steps", "--projects <id>[,<id>]");
  if (terms.until <= now) throw new FlowrynError("bad_args", `autonomy until ${stampOf(terms.until)} is not ahead`);
  if (terms.until - now > AUTONOMY_MAX_MS) throw new FlowrynError("bad_args", `autonomy until ${stampOf(terms.until)} is more than 16 hours away`, "--until at most 16h from now");
  for (const id of terms.projects) {
    if (!PROJECT_ID.test(id) || !getProject(db, id)) throw new FlowrynError("bad_args", `no project ${sanitizeLine(id, 40)}`, "flowryn project list");
    let steps: ReturnType<typeof verifyConfig> = null;
    try {
      steps = verifyConfig(config, id);
    } catch {
      steps = null;
    }
    if (!steps) throw new FlowrynError("bad_args", `project ${id} has no verify steps; autonomy merges only verified work`, `add [projects.${id}] verify steps, or leave ${id} out of --projects`);
  }
}

export function getAutonomy(db: Db, id: string): AutonomyRow | null {
  return db.query("SELECT * FROM autonomy_grants WHERE id = ?1").get(id) as AutonomyRow | null;
}

export function latestAutonomy(db: Db): AutonomyRow | null {
  return db.query("SELECT * FROM autonomy_grants ORDER BY started_at DESC, rowid DESC LIMIT 1").get() as AutonomyRow | null;
}

export function projectsOf(row: Pick<AutonomyRow, "projects">): string[] {
  try {
    const list = JSON.parse(row.projects) as unknown;
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** The grant in force now: not ended, not expired. An expired one is ended by the next expireAutonomy. */
export function liveAutonomy(db: Db, now: number): AutonomyRow | null {
  return db.query("SELECT * FROM autonomy_grants WHERE ended_at IS NULL AND expires_at > ?1 LIMIT 1").get(now) as AutonomyRow | null;
}

/** The grant in force now that covers this project, or null. Checked at every use. */
export function autonomyFor(db: Db, projectId: string, now: number): AutonomyRow | null {
  const live = liveAutonomy(db, now);
  return live && projectsOf(live).includes(projectId) ? live : null;
}

/** Was this run started under the autonomy migration? Older runs finish as they began. */
export function startedUnderAutonomy(db: Db, startedAt: number): boolean {
  const row = db.query("SELECT applied_at FROM schema_migrations WHERE name = 'autonomy'").get() as { applied_at: number | null } | null;
  return row?.applied_at != null && startedAt >= row.applied_at;
}

/** The grant in force now that covers this run: its project is named and the run started after the migration. */
export function autonomyForRun(db: Db, run: { project_id: string; started_at: number }, now: number): AutonomyRow | null {
  return startedUnderAutonomy(db, run.started_at) ? autonomyFor(db, run.project_id, now) : null;
}

function nextId(db: Db): string {
  const next = Number(getMeta(db, "next_autonomy_no") ?? "1");
  setMeta(db, "next_autonomy_no", String(next + 1));
  return `u${next}`;
}

export interface NewAutonomy {
  terms: AutonomyTerms;
  channel: AutonomyChannel;
  actor: string;
  grantId: string | null;
  words: string | null;
  now: number;
}

/** Record a grant; a live one is ended as superseded. Call inside a transaction, after checkTerms. */
export function startAutonomy(db: Db, a: NewAutonomy): AutonomyRow {
  const live = db.query("SELECT * FROM autonomy_grants WHERE ended_at IS NULL").get() as AutonomyRow | null;
  if (live) closeRow(db, live, live.expires_at <= a.now ? "expired" : "superseded", a.now, "cli");
  const id = nextId(db);
  const words = a.words === null ? null : sanitizeLine(a.words, AUTONOMY_WORDS_MAX) || null;
  const actor = sanitizeLine(a.actor, 120) || "you";
  db.query(
    `INSERT INTO autonomy_grants (id, channel, actor, grant_id, projects, words, terms_hash, started_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).run(id, a.channel, actor, a.grantId, JSON.stringify(a.terms.projects), words, termsHash(a.terms), a.now, a.terms.until);
  // The words are the user's and may hold anything: the row keeps them, the event does not.
  appendEvent(db, { source: "cli", kind: "autonomy.started", payload: { autonomy: id, channel: a.channel, projects: a.terms.projects, until: a.terms.until, grant: a.grantId, ...(live ? { superseded: live.id } : {}) }, ts: a.now });
  return getAutonomy(db, id)!;
}

function closeRow(db: Db, row: AutonomyRow, reason: AutonomyEndReason, now: number, source: EventSource): AutonomyRow {
  const at = reason === "expired" ? Math.min(row.expires_at, now) : now;
  db.query("UPDATE autonomy_grants SET ended_at = ?2, end_reason = ?3 WHERE id = ?1 AND ended_at IS NULL").run(row.id, at, reason);
  // What it minted and nothing used yet ends with it: an ended grant allows nothing more.
  const voided = db.query("UPDATE approvals SET expires_at = ?2 WHERE channel = 'autonomous' AND consumed_at IS NULL AND expires_at > ?2 AND actor LIKE ?3").run(at, at, `${autonomyActorPrefix(row.id)}%`).changes;
  appendEvent(db, { source, kind: "autonomy.ended", payload: { autonomy: row.id, reason, ended_at: at, approvals_voided: voided }, ts: now });
  return getAutonomy(db, row.id)!;
}

/** End the grant that is not yet ended (`flowryn back`): an expired one ends at its expiry. Call inside a transaction. */
export function endAutonomy(db: Db, now: number): AutonomyRow | null {
  const row = db.query("SELECT * FROM autonomy_grants WHERE ended_at IS NULL").get() as AutonomyRow | null;
  if (!row) return null;
  return closeRow(db, row, row.expires_at <= now ? "expired" : "back", now, "cli");
}

/** End the grant if its expiry has passed (the daemon's tick, and any away verb). Call inside a transaction. */
export function expireAutonomy(db: Db, now: number): AutonomyRow | null {
  const row = db.query("SELECT * FROM autonomy_grants WHERE ended_at IS NULL AND expires_at <= ?1").get(now) as AutonomyRow | null;
  return row ? closeRow(db, row, "expired", now, "daemon") : null;
}

function autonomyActorPrefix(id: string): string {
  return `standing approval ${id} (`;
}

/** Who allowed an action: this grant, and who made it. */
export function autonomyActor(row: AutonomyRow): string {
  return `${autonomyActorPrefix(row.id)}${row.channel}, ${row.actor})`;
}

/**
 * The approval row an autonomous merge or gate pass records: bound to the ref and head as
 * every approval is, channel `autonomous`, naming the grant. Call inside a transaction.
 */
export function mintAutonomyApproval(db: Db, row: AutonomyRow, a: { task: string; ref: string; head: string; action: "merge" | "gate"; runId?: string | null }, now: number): ApprovalRow {
  const approval = insertApproval(db, { task: a.task, ref: a.ref, head: a.head, channel: AUTONOMOUS_CHANNEL, actor: autonomyActor(row), action: a.action, now });
  // A grant never outlives itself through the rows it mints.
  db.query("UPDATE approvals SET expires_at = MIN(expires_at, ?2) WHERE id = ?1").run(approval.id, row.expires_at);
  if (a.action === "merge") appendEvent(db, { source: "daemon", kind: "autonomy.merge_approved", runId: a.runId ?? null, taskId: a.task, payload: { autonomy: row.id, approval: approval.id, ref: a.ref, head: a.head }, ts: now });
  return db.query("SELECT * FROM approvals WHERE id = ?1").get(approval.id) as ApprovalRow;
}

/** The grant's projects as this caller may see them: other scopes' projects only counted. */
export function projectsShown(row: AutonomyRow, lens: Pick<ScopeLens, "project">): string {
  const all = projectsOf(row);
  const mine = all.filter((p) => lens.project(p));
  const hidden = all.length - mine.length;
  return [...mine, ...(hidden > 0 ? [`+${hidden} other project${hidden === 1 ? "" : "s"}`] : [])].join(", ");
}

/** The one line the briefing and `show autonomy` carry for a grant; a scoped leader never sees the user's words. */
export function autonomyLine(row: AutonomyRow, now: number, lens: Pick<ScopeLens, "project" | "restricted">): string {
  const state = row.ended_at !== null ? `ended (${row.end_reason ?? "?"})` : row.expires_at <= now ? "expired" : "live";
  const words = row.words && !lens.restricted ? `; the user's words: "${sanitizeLine(row.words, 120)}"` : "";
  return `${row.id}: ${state}, projects ${projectsShown(row, lens)}, until ${stampOf(row.expires_at)}, from ${row.channel}${words}`;
}
