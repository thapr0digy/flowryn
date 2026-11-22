import { tx, type Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { recordPlan, type PlanPhase } from "../lifecycle/plans.ts";
import { isDropped } from "../lifecycle/drop.ts";
import type { ProjectRow } from "../lifecycle/projects.ts";
import { TERMINAL_STATES } from "../lifecycle/runs.ts";
import { CHECKS_HEADING, CORRECT_SKILL_NAME } from "../skills/correct.ts";
import { redactSecrets } from "../util/redact.ts";
import { sanitizeLine } from "../util/sanitize.ts";

/**
 * Corrections become checks (docs/notes/2026-11-22-phase-corrections-become-7t.md; plan p104,
 * proposal 9). Once a week the upkeep pass reads, per project, the corrections people made: the
 * user's answers to questions (`answered_by = captain`), the leader's and your own steers, the
 * user's words on review pages, review gates sent back with changes, and the lessons the leader
 * recorded from the user's chat corrections (`flowryn learn`, new or confirmed again). A project
 * with at least CORRECTIONS_MIN of them gets one scout: a one-phase plan of workflow `corrections`
 * whose shared brief is that list. Its stage carries the correct skill. Grouping words into
 * mistake classes is judgement, so a model does that; everything else is plain code: the
 * gathering, the weekly timer, and the filing of the report's `## Checks to ship` entries as ships,
 * each of which must cite at least two ids from the list it was given.
 */

export const CORRECTIONS_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** A mistake class needs two corrections, so a project with fewer has nothing to group. */
export const CORRECTIONS_MIN = 2;
/** At most this many ships from one scout's report. */
export const CORRECTIONS_MAX_SHIPS = 5;
/** The plans' filed_by: only a scout of such a plan may file ships from its report. */
export const CORRECTIONS_FILER = "daemon (weekly corrections scout)";
export const CORRECTIONS_WORKFLOW = "corrections";
export const CORRECTIONS_PASS_KIND = "corrections.pass";
export const CORRECTIONS_SHIPS_KIND = "corrections.ships_filed";
/** One correction's words in the list, after sanitising. */
const TEXT_MAX = 600;
/** The newest this many per project; a busier week is cut from the oldest end, and the list says so. */
const LIST_MAX = 150;
const TITLE_MAX = 120;
/** A ship's own words from the report: generous, under the backlog's body cap with the footer. */
const SHIP_BODY_MAX = 3_000;
/** An evidence id as the list prints it: a decision, a steer, a lesson, a send-back gate, or a review-page message (gate.seq). */
const EVIDENCE_ID = /^(?:[qk]\d+|m\d+|l\d+|g\d+(?:\.\d+)?)$/;
const LIST_LINE = /^- ([a-z]\d+(?:\.\d+)?) · /;
/** An entry's labelled lines; an entry must say more than these. */
const FIELD_LINE = /^(?:evidence|enforcer|past mistake):/i;

export type CorrectionSource = "answer" | "steer" | "page" | "send-back" | "lesson";

export interface Correction {
  id: string;
  source: CorrectionSource;
  at: number;
  task: string | null;
  text: string;
}

function clean(text: string): string {
  return sanitizeLine(redactSecrets(text), TEXT_MAX);
}

/** The corrections made in a project in [since, until), oldest first. */
export function correctionsOf(db: Db, project: string, since: number, until: number): Correction[] {
  const out: Correction[] = [];
  const answers = db
    .query(
      `SELECT d.id, d.task_id, d.question, d.answer, d.note, d.answered_at FROM decisions d JOIN task_policy tp ON tp.task_id = d.task_id
       WHERE tp.project_id = ?1 AND d.answered_by = 'captain' AND d.answered_at >= ?2 AND d.answered_at < ?3`,
    )
    .all(project, since, until) as { id: string; task_id: string; question: string; answer: string | null; note: string | null; answered_at: number }[];
  for (const d of answers) {
    const words = `${sanitizeLine(d.question, 200)} → ${d.answer ?? "-"}${d.note ? `: ${d.note}` : ""}`;
    out.push({ id: d.id, source: "answer", at: d.answered_at, task: d.task_id, text: clean(words) });
  }
  const steers = db
    .query(
      `SELECT m.id, m.body, m.created_at, r.task_id FROM events e JOIN messages m ON m.id = json_extract(e.payload, '$.steer')
       JOIN runs r ON r.id = m.run_id JOIN task_policy tp ON tp.task_id = r.task_id
       WHERE e.kind = 'steer.created' AND e.ts >= ?2 AND e.ts < ?3 AND json_extract(e.payload, '$.by') IN ('leader', 'human') AND tp.project_id = ?1`,
    )
    .all(project, since, until) as { id: string; body: string; created_at: number; task_id: string }[];
  for (const s of steers) out.push({ id: s.id, source: "steer", at: s.created_at, task: s.task_id, text: clean(s.body) });
  const pages = db
    .query(
      `SELECT rm.gate_id, rm.seq, rm.body, rm.created_at, r.task_id FROM review_messages rm JOIN gates g ON g.id = rm.gate_id
       JOIN runs r ON r.id = g.run_id JOIN task_policy tp ON tp.task_id = r.task_id
       WHERE rm.author = 'user' AND rm.created_at >= ?2 AND rm.created_at < ?3 AND tp.project_id = ?1`,
    )
    .all(project, since, until) as { gate_id: string; seq: number; body: string; created_at: number; task_id: string }[];
  for (const p of pages) out.push({ id: `${p.gate_id}.${p.seq}`, source: "page", at: p.created_at, task: p.task_id, text: clean(p.body) });
  // A review gate sent back with the user's words; a merge gate's changes are failed checks, already enforced.
  const sendBacks = db
    .query(
      `SELECT g.id, g.feedback, g.closed_at, r.task_id FROM gates g JOIN runs r ON r.id = g.run_id JOIN task_policy tp ON tp.task_id = r.task_id
       WHERE g.kind = 'review' AND g.state = 'changes' AND g.replaced_by IS NULL AND g.feedback IS NOT NULL AND g.feedback <> 'promoted to a ship'
         AND g.closed_at >= ?2 AND g.closed_at < ?3 AND tp.project_id = ?1`,
    )
    .all(project, since, until) as { id: string; feedback: string; closed_at: number; task_id: string }[];
  for (const g of sendBacks) out.push({ id: g.id, source: "send-back", at: g.closed_at, task: g.task_id, text: clean(g.feedback) });
  // A lesson confirmed again is the same correction made once more: the strongest sign of a class.
  const lessons = db
    .query(
      `SELECT id, text, created_at, reinforced_at FROM learnings
       WHERE project = ?1 AND ((created_at >= ?2 AND created_at < ?3) OR (reinforced_at > created_at AND reinforced_at >= ?2 AND reinforced_at < ?3))`,
    )
    .all(project, since, until) as { id: number; text: string; created_at: number; reinforced_at: number }[];
  for (const l of lessons) {
    const again = l.reinforced_at > l.created_at && l.reinforced_at >= since;
    out.push({ id: `l${l.id}`, source: "lesson", at: again ? l.reinforced_at : l.created_at, task: null, text: clean(again ? `${l.text} (confirmed again)` : l.text) });
  }
  return out.toSorted((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

const SOURCE_LABEL: Record<CorrectionSource, string> = { answer: "user's answer", steer: "steer", page: "review page", "send-back": "sent back", lesson: "lesson" };

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The list a corrections scout groups: one line per correction, its id first. */
export function correctionsList(project: string, since: number, until: number, all: Correction[]): string {
  const kept = all.slice(-LIST_MAX);
  const cut = all.length - kept.length;
  const lines = [
    `# Corrections in ${project}, ${day(since)} to ${day(until)}`,
    "",
    `${all.length} corrections${cut > 0 ? ` (the oldest ${cut} left out)` : ""}: the user's answers to questions, steers from the leader or the user, the user's review-page words, review gates sent back, and lessons recorded from the user's chat corrections. Each line: id · source · date · task · words. A check to ship cites these ids.`,
    "",
    ...kept.map((c) => `- ${c.id} · ${SOURCE_LABEL[c.source]} · ${day(c.at)} · ${c.task ?? "-"} · ${c.text}`),
  ];
  return lines.join("\n");
}

function scoutBody(project: string, since: number, until: number, count: number): string {
  return [
    `Corrections become checks: ${project}, ${day(since)} to ${day(until)}.`,
    "",
    `The plan's shared brief lists the ${count} corrections people made in ${project} this week. Follow the correct skill your stage names: group them into mistake classes (two corrections or more), skip classes the project's checks already enforce, and pick each class's highest enforcer (architecture, type or lint, test, doc). Read the code and find a commit that made the mistake, so its ship can prove the check fails there and passes on HEAD.`,
    "",
    `Report with ## Short answer (at most 15 lines), then ## ${CHECKS_HEADING} (at most ${CORRECTIONS_MAX_SHIPS} entries, each with an Evidence: line citing two or more ids from the list), then ## Classes not filed. Flowryn files each valid entry as a ship of ${project}. Change no code.`,
  ].join("\n");
}

/** The latest corrections scout of a project that has not ended, or null. */
function openScout(db: Db, project: string): string | null {
  const tasks = db
    .query(`SELECT ph.task_id FROM plan_phases ph JOIN plans pl ON pl.id = ph.plan_id WHERE pl.project_id = ?1 AND pl.filed_by = ?2 AND pl.state = 'approved' ORDER BY pl.created_at DESC`)
    .all(project, CORRECTIONS_FILER) as { task_id: string }[];
  for (const { task_id } of tasks) {
    if (isDropped(db, task_id)) continue;
    const latest = db.query("SELECT state FROM runs WHERE task_id = ?1 ORDER BY started_at DESC, rowid DESC LIMIT 1").get(task_id) as { state: string } | null;
    if (!latest || !(TERMINAL_STATES as readonly string[]).includes(latest.state)) return task_id;
  }
  return null;
}

/**
 * When the next weekly pass is due: a week after the last pass's event (its only state), or 0 when
 * none ran. No index serves events by kind, so the upkeep loop keeps the answer until it is due.
 */
export function correctionsDueAt(db: Db): number {
  const last = db.query("SELECT ts FROM events WHERE kind = ?1 ORDER BY seq DESC LIMIT 1").get(CORRECTIONS_PASS_KIND) as { ts: number } | null;
  return last ? last.ts + CORRECTIONS_WINDOW_MS : 0;
}

export interface CorrectionsPass {
  since: number;
  until: number;
  filed: { project: string; plan: string; task: string; corrections: number }[];
  skipped: { project: string; why: string }[];
}

/**
 * The weekly pass: due once CORRECTIONS_WINDOW_MS has passed since the last one (the first pass
 * runs at once), it files a corrections scout for each project with enough corrections in the
 * last week and none still open. One transaction and one event, whatever it filed. Null when not due.
 */
export function correctionsPass(db: Db, projects: readonly ProjectRow[], now: number): CorrectionsPass | null {
  if (now < correctionsDueAt(db)) return null;
  const since = now - CORRECTIONS_WINDOW_MS;
  return tx(db, () => {
    const pass: CorrectionsPass = { since, until: now, filed: [], skipped: [] };
    for (const project of projects) {
      if (project.removed_at != null) continue;
      const all = correctionsOf(db, project.id, since, now);
      if (all.length === 0) continue;
      if (all.length < CORRECTIONS_MIN) {
        pass.skipped.push({ project: project.id, why: `${all.length} correction, fewer than ${CORRECTIONS_MIN}` });
        continue;
      }
      const open = openScout(db, project.id);
      if (open) {
        pass.skipped.push({ project: project.id, why: `${open}, the last corrections scout, has not reported` });
        continue;
      }
      const title = `Corrections become checks (${project.id}, week to ${day(now)})`;
      const phase: PlanPhase = { title, body: scoutBody(project.id, since, now, all.length), workflow: CORRECTIONS_WORKFLOW, harness: null, after: null };
      const plan = recordPlan(db, { project, title, phases: [phase], sourceTask: null, gateId: null, workflow: CORRECTIONS_WORKFLOW, filedBy: CORRECTIONS_FILER, state: "approved", now });
      db.query("UPDATE plans SET preamble = ?2 WHERE id = ?1").run(plan.id, correctionsList(project.id, since, now, all));
      pass.filed.push({ project: project.id, plan: plan.id, task: plan.phases[0]!.task_id, corrections: all.length });
    }
    appendEvent(db, { source: "daemon", kind: CORRECTIONS_PASS_KIND, payload: { ...pass }, ts: now });
    return pass;
  });
}

// --- the scout's report ---------------------------------------------------------------------

export interface CheckEntry {
  title: string;
  evidence: string[];
  body: string;
}

/** The `## Checks to ship` entries of a report: `### <title>`, then an `Evidence:` line and the words. */
export function parseChecks(report: string): CheckEntry[] {
  const lines = report.split("\n");
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${CHECKS_HEADING.toLowerCase()}`);
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  const section = end < 0 ? rest : rest.slice(0, end);
  const entries: string[][] = [];
  for (const line of section) {
    if (/^###\s/.test(line)) entries.push([line]);
    else if (entries.length > 0) entries[entries.length - 1]!.push(line);
  }
  return entries.map((entry) => {
    const evidenceLine = entry.find((l) => /^evidence:/i.test(l.trim()));
    const evidence = evidenceLine ? [...new Set(evidenceLine.trim().slice("evidence:".length).split(/[,\s]+/).map((id) => id.trim()).filter(Boolean))] : [];
    return { title: sanitizeLine(entry[0]!.replace(/^###\s*/, ""), TITLE_MAX), evidence, body: entry.slice(1).join("\n").trim() };
  });
}

/** The ids a scout was given: the lines of its plan's shared brief. */
export function listedIds(list: string): Set<string> {
  const ids = new Set<string>();
  for (const line of list.split("\n")) {
    const m = LIST_LINE.exec(line);
    if (m) ids.add(m[1]!);
  }
  return ids;
}

/** The corrections plan a task is the scout of, or null for any other task. */
export function correctionsPlanOf(db: Db, taskId: string): { preamble: string } | null {
  const row = db.query("SELECT pl.preamble FROM plan_phases ph JOIN plans pl ON pl.id = ph.plan_id WHERE ph.task_id = ?1 AND pl.filed_by = ?2").get(taskId, CORRECTIONS_FILER) as { preamble: string | null } | null;
  return row ? { preamble: row.preamble ?? "" } : null;
}

export interface FiledChecks {
  plan: string | null;
  ships: string[];
  refused: { title: string; why: string }[];
}

function refusal(entry: CheckEntry, listed: Set<string>): string | null {
  if (entry.title.length === 0) return "no title";
  if (!entry.body.split("\n").some((l) => l.trim().length > 0 && !FIELD_LINE.test(l.trim()))) return "no words under the title";
  const bad = entry.evidence.filter((id) => !EVIDENCE_ID.test(id) || !listed.has(id));
  if (bad.length > 0) return `cites ids not in its list: ${bad.slice(0, 5).join(", ")}`;
  if (entry.evidence.length < CORRECTIONS_MIN) return `cites ${entry.evidence.length} correction${entry.evidence.length === 1 ? "" : "s"}; a class needs ${CORRECTIONS_MIN}`;
  return null;
}

/**
 * File a corrections scout's checks as ships of its project: one approved plan, its phases
 * independent of each other, its shared brief the scout's list (so each ship reads the words it
 * cites). An entry citing fewer than two listed ids, or past CORRECTIONS_MAX_SHIPS, is refused.
 * Records CORRECTIONS_SHIPS_KIND whenever the report had entries. Call inside the delivery's transaction.
 */
export function fileChecks(
  db: Db,
  input: { project: ProjectRow; scoutTask: string; runId: string; plan: { preamble: string }; report: string; skillPath: string | null; now: number },
): FiledChecks | null {
  const entries = parseChecks(input.report);
  if (entries.length === 0) return null;
  const listed = listedIds(input.plan.preamble);
  const refused: FiledChecks["refused"] = [];
  const phases: PlanPhase[] = [];
  for (const entry of entries) {
    const why = refusal(entry, listed);
    if (why) refused.push({ title: entry.title || "(untitled)", why });
    else if (phases.length >= CORRECTIONS_MAX_SHIPS) refused.push({ title: entry.title, why: `over ${CORRECTIONS_MAX_SHIPS} checks from one report` });
    else phases.push({ title: entry.title, body: shipBody(entry, input.scoutTask, input.skillPath), workflow: input.project.workflow, harness: null, after: [] });
  }
  let plan: { id: string; phases: { task_id: string }[] } | null = null;
  if (phases.length > 0) {
    plan = recordPlan(db, { project: input.project, title: `Checks from ${input.scoutTask}`, phases, sourceTask: null, gateId: null, workflow: input.project.workflow, filedBy: `corrections scout (${input.scoutTask})`, state: "approved", now: input.now });
    db.query("UPDATE plans SET preamble = ?2 WHERE id = ?1").run(plan.id, input.plan.preamble);
  }
  const filed: FiledChecks = { plan: plan?.id ?? null, ships: plan?.phases.map((p) => p.task_id) ?? [], refused };
  appendEvent(db, { source: "cli", kind: CORRECTIONS_SHIPS_KIND, runId: input.runId, taskId: input.scoutTask, payload: { ...filed, project: input.project.id }, ts: input.now });
  return filed;
}

function shipBody(entry: CheckEntry, scoutTask: string, skillPath: string | null): string {
  const words = entry.body.length > SHIP_BODY_MAX ? `${entry.body.slice(0, SHIP_BODY_MAX)}\n[cut at ${SHIP_BODY_MAX} characters]` : entry.body;
  const skill = skillPath ? `the ${CORRECT_SKILL_NAME} skill (${skillPath})` : `the ${CORRECT_SKILL_NAME} skill`;
  return [
    words,
    "",
    `Filed by the weekly corrections scout ${scoutTask}; the corrections it cites are in this plan's shared brief. Build this check with ${skill}: prove it fails on the past mistake's commit and passes on HEAD, and add its row to the project's AGENTS.md rule↔enforcer table, in this change.`,
  ].join("\n");
}
