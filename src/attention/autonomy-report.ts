import type { Db } from "../db/db.ts";
import type { ScopeLens } from "../leader/scope.ts";
import { taskTitle } from "../lifecycle/runs.ts";
import { autonomyLine, type AutonomyRow } from "../policy/autonomy.ts";
import { sanitizeLine } from "../util/sanitize.ts";

/**
 * The morning report of unattended mode (docs/notes/2026-11-05-unattended-mode-one-9e.md): the
 * return brief's "Autonomous" section and `flowryn show autonomy`, one fixed template from the
 * event log and the records it points at: each review gate passed (page and spec), each
 * decision taken (question, choice, the worker's why), each merge (PR and commit) and each
 * parked task (why, and the command that moves it). Everything printed is sanitised.
 */

/** Lines per group; the rest is counted. */
export const MAX_AUTONOMY_LINES = 20;

interface Ev {
  task_id: string | null;
  payload: string;
  ts: number;
}

function events(db: Db, kind: string, since: number, until: number): Ev[] {
  return db.query("SELECT task_id, payload, ts FROM events WHERE kind = ?1 AND ts > ?2 AND ts <= ?3 ORDER BY seq").all(kind, since, until) as Ev[];
}

function payload(e: Ev): Record<string, unknown> {
  return JSON.parse(e.payload) as Record<string, unknown>;
}

function named(db: Db, taskId: string | null): string {
  if (!taskId) return "?";
  const title = taskTitle(db, taskId);
  return `${sanitizeLine(title, 60)}${title === taskId ? "" : ` (${taskId})`}`;
}

function group(heading: string, lines: string[]): string[] {
  if (lines.length === 0) return [`${heading}: none.`];
  const shown = lines.slice(0, MAX_AUTONOMY_LINES);
  return [`${heading} (${lines.length}):`, ...shown, ...(lines.length > shown.length ? [`+${lines.length - shown.length} more: flowryn show autonomy`] : [])];
}

/** The grants that were live at some point in the window. */
export function grantsIn(db: Db, since: number, until: number): AutonomyRow[] {
  return db.query("SELECT * FROM autonomy_grants WHERE started_at <= ?2 AND (ended_at IS NULL OR ended_at > ?1) ORDER BY started_at").all(since, until) as AutonomyRow[];
}

/**
 * The section for the window, or nothing when no grant was live in it. `lens` filters what a
 * scoped leader sees, as the rest of the brief does.
 */
export function autonomyLines(db: Db, input: { since: number; until: number; now: number; lens: ScopeLens }): string[] {
  const { since, until, lens } = input;
  const grants = grantsIn(db, since, until);
  if (grants.length === 0) return [];
  const mine = (e: Ev) => lens.task(e.task_id);
  const gates = events(db, "autonomy.gate_passed", since, until)
    .filter(mine)
    .map((e) => {
      const p = payload(e);
      const page = typeof p.review_url === "string" ? p.review_url : typeof p.page === "string" ? p.page : "no page";
      const spec = typeof p.spec_path === "string" ? `; spec ${sanitizeLine(p.spec_path, 200)}` : "";
      return `- ${named(db, e.task_id)}: ${sanitizeLine(String(p.stage ?? "?"), 30)} review ${sanitizeLine(String(p.gate ?? "?"), 12)} passed; page ${sanitizeLine(page, 200)}${spec}`;
    });
  const decided = events(db, "autonomy.decided", since, until)
    .filter(mine)
    .map((e) => {
      const p = payload(e);
      const d = db.query("SELECT id, question, answer, rationale, state, answered_by FROM decisions WHERE id = ?1").get(String(p.decision ?? "")) as { id: string; question: string; answer: string | null; rationale: string | null; state: string; answered_by: string | null } | null;
      if (!d) return `- [${sanitizeLine(String(p.decision ?? "?"), 12)}] ${named(db, e.task_id)} → ${sanitizeLine(String(p.choice ?? "?"), 60)}`;
      const changed = d.answered_by === "captain" ? `; the user changed it to ${sanitizeLine(d.answer ?? "?", 60)}` : `; undo: flowryn decide ${d.id} <choice> --by captain`;
      const why = (d.rationale ?? "").replace(/^Decided under unattended mode \(u\d+\) as the worker recommended: /, "");
      return `- [${d.id}] ${named(db, e.task_id)}: "${sanitizeLine(d.question, 100)}" → ${sanitizeLine(String(p.choice ?? "?"), 60)}; why: ${sanitizeLine(why, 120)}${changed}`;
    });
  const merges = (
    db
      .query(
        `SELECT m.task_id, m.pr_url, m.head_sha, m.state, m.merge_sha FROM merges m JOIN approvals a ON a.id = m.approval_id
         WHERE a.channel = 'autonomous' AND m.requested_at > ?1 AND m.requested_at <= ?2 ORDER BY m.requested_at`,
      )
      .all(since, until) as { task_id: string; pr_url: string; head_sha: string; state: string; merge_sha: string | null }[]
  )
    .filter((m) => lens.task(m.task_id))
    .map((m) => `- ${named(db, m.task_id)}: ${sanitizeLine(m.pr_url, 200)} ${m.merge_sha ? `merged as ${m.merge_sha.slice(0, 12)}` : `${m.state} at ${m.head_sha.slice(0, 12)}`}`);
  const parked = events(db, "autonomy.parked", since, until)
    .filter(mine)
    .map((e) => {
      const p = payload(e);
      const what = typeof p.decision === "string" ? p.decision : typeof p.gate === "string" ? p.gate : "?";
      const d = typeof p.decision === "string" ? (db.query("SELECT state FROM decisions WHERE id = ?1").get(p.decision) as { state: string } | null) : null;
      const next = typeof p.decision === "string" ? (d?.state === "open" ? `; answer: flowryn decide ${p.decision} <choice> --by captain` : "; answered since") : `; pass or send back: flowryn approve ${e.task_id ?? "<task>"} --gate <stage>`;
      return `- ${named(db, e.task_id)} on ${sanitizeLine(what, 12)}: ${sanitizeLine(String(p.why ?? "?"), 160)}${next}`;
    });
  return [
    `Autonomous (${grants.map((g) => autonomyLine(g, input.now)).join("; ")}):`,
    ...group("Gates passed", gates),
    ...group("Decided", decided),
    ...group("Merged", merges),
    ...group("Parked", parked),
  ];
}
