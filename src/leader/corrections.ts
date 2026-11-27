import { tx, type Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { recordPlan, type PlanPhase } from "../lifecycle/plans.ts";
import { isDropped } from "../lifecycle/drop.ts";
import type { ProjectRow } from "../lifecycle/projects.ts";
import { TERMINAL_STATES, type RunState } from "../lifecycle/runs.ts";
import { CHECKS_HEADING, CORRECT_SKILL_NAME, STALE_HEADING } from "../skills/correct.ts";
import { redactSecrets } from "../util/redact.ts";
import { sanitizeLine } from "../util/sanitize.ts";
import { parseEnforcers, provenCommits, splitRow } from "../verify/laws.ts";

/**
 * Corrections become checks (docs/notes/2026-11-22-phase-corrections-become-7t.md; plan p104,
 * proposal 9). Once a week the upkeep pass reads, per project, the corrections people made: the
 * user's answers to questions (`answered_by = captain`), the leader's and your own steers, the
 * user's words on review pages, review gates sent back with changes, and the lessons the leader
 * recorded from the user's chat corrections (`flowryn learn --correction`, new or confirmed again). A project
 * with at least CORRECTIONS_MIN of them gets one scout: a one-phase plan of workflow `corrections`
 * whose shared brief is that list. Its stage carries the correct skill. Grouping words into
 * mistake classes is judgement, so a model does that; everything else is plain code: the
 * gathering, the weekly timer, and the filing of the report's `## Checks to ship` entries as ships,
 * each of which must cite at least two ids from the list it was given and propose its laws row.
 *
 * Between weekly passes (docs/notes/2026-11-27-phase-corrections-become-jx.md), `classPass` files
 * the scout as soon as two corrections look like one class (repeatedClass: plain word overlap, or
 * a lesson confirmed again, which counts as two). Each scout's list starts where the project's
 * last scout's ended, with any older correction of the week a new one repeats. The
 * weekly pass also files, once per project, a sweep of its lessons into law, fact or stale.
 */

export const CORRECTIONS_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** A mistake class needs two corrections, so a project with fewer has nothing to group. */
export const CORRECTIONS_MIN = 2;
/** At most this many ships from one scout's report. */
export const CORRECTIONS_MAX_SHIPS = 5;
/** The plans' filed_by: only a scout of such a plan may file ships from its report. */
export const CORRECTIONS_FILER = "daemon (weekly corrections scout)";
/** The one-time learnings sweep's plans: each project's lessons sorted into law, fact or stale. */
export const SWEEP_FILER = "daemon (learnings sweep)";
export const CORRECTIONS_WORKFLOW = "corrections";
export const CORRECTIONS_PASS_KIND = "corrections.pass";
/** A scout filed between weekly passes because a class reached two corrections. */
export const CORRECTIONS_CLASS_KIND = "corrections.class";
export const CORRECTIONS_SHIPS_KIND = "corrections.ships_filed";
/** A sweep scout's report: each listed lesson's bucket, recorded once. */
export const LEARNINGS_SWEPT_KIND = "learnings.swept";
/** One correction's words in the list, after sanitising. */
const TEXT_MAX = 600;
/** The newest this many per project; a busier week is cut from the oldest end, and the list says so. */
const LIST_MAX = 150;
const TITLE_MAX = 120;
/** A ship's own words from the report: generous, under the backlog's body cap with the footer. */
const SHIP_BODY_MAX = 3_000;
/** An evidence id as the list prints it: a decision, a steer, a lesson, a send-back gate, or a review-page message (gate.seq). */
const EVIDENCE_ID = /^(?:[qk]\d+|m\d+|l\d+|g\d+(?:\.\d+)?)$/;
const LIST_LINE = /^- ([a-z]\d+(?:\.\d+)?) · ([^·]+) · /;
/** An entry's labelled lines; an entry must say more than these. */
const FIELD_LINE = /^(?:evidence|enforcer|past mistake|law):/i;

export type CorrectionSource = "answer" | "steer" | "page" | "send-back" | "lesson";

export interface Correction {
  id: string;
  source: CorrectionSource;
  at: number;
  task: string | null;
  text: string;
  /** A lesson learned again in the window: one correction made twice, a class by itself. */
  again?: true;
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
       WHERE project = ?1 AND correction = 1 AND (archive_reason IS NULL OR archive_reason NOT IN ('unlearned', 'replaced'))
         AND ((created_at >= ?2 AND created_at < ?3) OR (reinforced_at > created_at AND reinforced_at >= ?2 AND reinforced_at < ?3))`,
    )
    .all(project, since, until) as { id: number; text: string; created_at: number; reinforced_at: number }[];
  for (const l of lessons) {
    const again = l.reinforced_at > l.created_at && l.reinforced_at >= since;
    const text = clean(l.text);
    out.push(again ? { id: `l${l.id}`, source: "lesson", at: l.reinforced_at, task: null, text, again: true } : { id: `l${l.id}`, source: "lesson", at: l.created_at, task: null, text });
  }
  return out.toSorted((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

const SOURCE_LABEL: Record<CorrectionSource, string> = { answer: "user's answer", steer: "steer", page: "review page", "send-back": "sent back", lesson: "lesson" };
/** The list's source for a lesson learned again: one id that stands for two corrections. */
const AGAIN_LABEL = "lesson learned again";

/** How many corrections a list holds: a lesson learned again counts twice. */
function timesCorrected(all: readonly Correction[]): number {
  return all.reduce((n, c) => n + (c.again ? 2 : 1), 0);
}

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
    `${all.length} corrections${cut > 0 ? ` (the oldest ${cut} left out)` : ""}: the user's answers to questions, steers from the leader or the user, the user's review-page words, review gates sent back, and lessons recorded from the user's chat corrections (a lesson learned again is one correction made twice and counts as two). Each line: id · source · date · task · words. A check to ship cites these ids.`,
    "",
    ...kept.map((c) => `- ${c.id} · ${c.again ? AGAIN_LABEL : SOURCE_LABEL[c.source]} · ${day(c.at)} · ${c.task ?? "-"} · ${c.text}`),
  ];
  return lines.join("\n");
}

function scoutBody(project: string, since: number, until: number, count: number, repeat: readonly string[] | null): string {
  return [
    `Corrections become checks: ${project}, ${day(since)} to ${day(until)}.`,
    "",
    `The plan's shared brief lists the ${count} corrections people made in ${project} since its last corrections scout (at most a week), with any older one in the week that a new one repeats. ${repeat ? `Filed early: ${repeat.length === 1 ? `${repeat[0]} was learned again` : `${repeat.join(" and ")} look like one class`}; start there. ` : ""}Follow the correct skill your stage names: group them into mistake classes (two corrections or more), skip classes the project's checks already enforce, and pick each class's highest enforcer (architecture, type or lint, test, doc). Read the code and find a commit that made the mistake, so its ship can prove the check fails there and passes on HEAD.`,
    "",
    `Report with ## Short answer (at most 15 lines), then ## ${CHECKS_HEADING} (at most ${CORRECTIONS_MAX_SHIPS} entries, each with an Evidence: line citing two or more ids from the list and a Law: line, the laws row its ship adds), then ## Classes not filed. Flowryn files each valid entry as a ship of ${project}. Change no code.`,
  ].join("\n");
}

/** When the project's last corrections scout was filed: its list ended there, so the next one starts there. */
function coveredUntil(db: Db, project: string): number {
  const row = db.query("SELECT MAX(created_at) AS at FROM plans WHERE project_id = ?1 AND filed_by = ?2").get(project, CORRECTIONS_FILER) as { at: number | null };
  return row.at ?? 0;
}

/**
 * A project's next scout list: its corrections since its last scout (at most a week back), plus an
 * older correction of the week that a new one repeats, so a class split by a scout's filing is
 * still seen; and the repeat, or null.
 */
function nextList(db: Db, project: string, now: number): { since: number; all: Correction[]; repeat: string[] | null } {
  const lookback = now - CORRECTIONS_WINDOW_MS;
  const since = Math.max(lookback, coveredUntil(db, project));
  const week = correctionsOf(db, project, lookback, now);
  const repeat = repeatedClass(week, since);
  return { since, all: week.filter((c) => c.at >= since || repeat?.includes(c.id)), repeat };
}

/** File one corrections scout: a one-phase approved plan whose shared brief is the list. */
function fileScout(db: Db, project: ProjectRow, since: number, now: number, all: Correction[], repeat: readonly string[] | null): { plan: string; task: string } {
  const title = repeat ? `Corrections become checks (${project.id}, a repeat on ${day(now)})` : `Corrections become checks (${project.id}, week to ${day(now)})`;
  const phase: PlanPhase = { title, body: scoutBody(project.id, since, now, all.length, repeat), workflow: CORRECTIONS_WORKFLOW, harness: null, after: null };
  const plan = recordPlan(db, { project, title, phases: [phase], sourceTask: null, gateId: null, workflow: CORRECTIONS_WORKFLOW, filedBy: CORRECTIONS_FILER, state: "approved", now });
  db.query("UPDATE plans SET preamble = ?2 WHERE id = ?1").run(plan.id, correctionsList(project.id, since, now, all));
  return { plan: plan.id, task: plan.phases[0]!.task_id };
}

/** Words that say nothing about the mistake, left out when corrections are compared. */
const STOPWORDS = new Set(
  "the and for that this with not but are was were has have had you your its from into onto one all any can could should must will would just also than then them they their what when where which who why how been being does did done only user again please dont isnt there here more less like very some such each other about over under same still back want need make keep take use".split(" "),
);
/** Two corrections are one class when they share this many content words... */
const CLASS_SHARED_MIN = 3;
/** ...and the shared words are at least this share of the shorter one's. */
const CLASS_SHARE_MIN = 0.5;

/** A correction's content words: lower case, three letters or more, no stopword or id, a plural's s cut. */
export function contentWords(text: string): Set<string> {
  const words = new Set<string>();
  const plain = text.toLowerCase().replace(/['’]s\b/g, "").replace(/['’]/g, "");
  for (const [raw] of plain.matchAll(/[a-z][a-z0-9-]{2,}/g)) {
    if (STOPWORDS.has(raw) || /^[a-z]\d+$/.test(raw)) continue;
    words.add(raw.length > 3 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return words;
}

/**
 * Two corrections of one class, at least one made at or after `since`, found by plain code, or
 * null: a lesson learned again (one correction made twice), else the first two corrections from
 * different tasks whose content words overlap (CLASS_SHARED_MIN shared, CLASS_SHARE_MIN of the
 * shorter). Two corrections in one
 * task are one incident relayed (an answer and the steer that passes it on), not a repeat. This
 * only decides when the scout starts: a false match costs one scout run, whose model groups the
 * list; a missed one waits for the weekly pass.
 */
export function repeatedClass(all: readonly Correction[], since: number): string[] | null {
  const again = all.find((c) => c.again && c.at >= since);
  if (again) return [again.id];
  const words = all.map((c) => contentWords(c.text));
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      if (all[i]!.at < since && all[j]!.at < since) continue;
      if (all[i]!.task !== null && all[i]!.task === all[j]!.task) continue;
      const [a, b] = [words[i]!, words[j]!];
      const shared = [...a].filter((w) => b.has(w)).length;
      if (shared >= CLASS_SHARED_MIN && shared >= CLASS_SHARE_MIN * Math.min(a.size, b.size)) return [all[i]!.id, all[j]!.id];
    }
  }
  return null;
}

/** A scout's run has ended once it has delivered its report (landed) or stopped. */
const SCOUT_ENDED: readonly RunState[] = ["landed", ...TERMINAL_STATES];

/** The latest corrections scout of a project that has not ended, or null. */
function openScout(db: Db, project: string): string | null {
  const tasks = db
    .query(`SELECT ph.task_id FROM plan_phases ph JOIN plans pl ON pl.id = ph.plan_id WHERE pl.project_id = ?1 AND pl.filed_by = ?2 AND pl.state = 'approved' ORDER BY pl.created_at DESC`)
    .all(project, CORRECTIONS_FILER) as { task_id: string }[];
  for (const { task_id } of tasks) {
    if (isDropped(db, task_id)) continue;
    const latest = db.query("SELECT state FROM runs WHERE task_id = ?1 ORDER BY started_at DESC, rowid DESC LIMIT 1").get(task_id) as { state: string } | null;
    if (!latest || !(SCOUT_ENDED as readonly string[]).includes(latest.state)) return task_id;
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
  /** Learnings sweeps filed this pass: once per project, ever. */
  swept: { project: string; plan: string; task: string; lessons: number }[];
}

/**
 * The weekly pass: due once CORRECTIONS_WINDOW_MS has passed since the last one (the first pass
 * runs at once), it files a corrections scout for each project with enough corrections since its
 * last scout (at most a week back) and none still open, and a learnings sweep for each project not
 * swept before. One transaction and one event, whatever it filed. Null when not due.
 */
export function correctionsPass(db: Db, projects: readonly ProjectRow[], now: number): CorrectionsPass | null {
  if (now < correctionsDueAt(db)) return null;
  return tx(db, () => {
    const pass: CorrectionsPass = { since: now - CORRECTIONS_WINDOW_MS, until: now, filed: [], skipped: [], swept: [] };
    for (const project of projects) {
      if (project.removed_at != null) continue;
      const sweep = fileSweep(db, project, now);
      if (sweep) pass.swept.push({ project: project.id, ...sweep });
      const { since, all } = nextList(db, project.id, now);
      if (all.length === 0) continue;
      if (timesCorrected(all) < CORRECTIONS_MIN) {
        pass.skipped.push({ project: project.id, why: `${all.length} correction, fewer than ${CORRECTIONS_MIN}` });
        continue;
      }
      const open = openScout(db, project.id);
      if (open) {
        pass.skipped.push({ project: project.id, why: `${open}, the last corrections scout, has not reported` });
        continue;
      }
      pass.filed.push({ project: project.id, ...fileScout(db, project, since, now, all, null), corrections: all.length });
    }
    appendEvent(db, { source: "daemon", kind: CORRECTIONS_PASS_KIND, payload: { ...pass }, ts: now });
    return pass;
  });
}

export interface ClassPass {
  filed: { project: string; plan: string; task: string; corrections: number; repeat: string[] }[];
}

/**
 * Between weekly passes: a project with no corrections scout open whose corrections since its last
 * scout (at most a week back) hold a repeated class (repeatedClass) gets its scout now. One event
 * when it filed any; nothing recorded otherwise, so it can run often. Never moves the weekly pass.
 */
export function classPass(db: Db, projects: readonly ProjectRow[], now: number): ClassPass {
  const pass: ClassPass = { filed: [] };
  // The reads run outside a write transaction: most hours nothing repeats and nothing is written.
  const found = projects.flatMap((project) => {
    if (project.removed_at != null || openScout(db, project.id)) return [];
    const { since, all, repeat } = nextList(db, project.id, now);
    return repeat ? [{ project, since, all, repeat }] : [];
  });
  if (found.length === 0) return pass;
  return tx(db, () => {
    for (const { project, since, all, repeat } of found) {
      if (openScout(db, project.id) || coveredUntil(db, project.id) > since) continue;
      pass.filed.push({ project: project.id, ...fileScout(db, project, since, now, all, repeat), corrections: all.length, repeat });
    }
    if (pass.filed.length > 0) appendEvent(db, { source: "daemon", kind: CORRECTIONS_CLASS_KIND, payload: { ...pass }, ts: now });
    return pass;
  });
}

// --- the learnings sweep --------------------------------------------------------------------

/** A project's lessons in use (not set aside), oldest first. */
function lessonsOf(db: Db, project: string): { id: number; text: string; created_at: number; correction: number }[] {
  return db.query("SELECT id, text, created_at, correction FROM learnings WHERE project = ?1 AND archived_at IS NULL ORDER BY id").all(project) as { id: number; text: string; created_at: number; correction: number }[];
}

/** The list a sweep sorts: one line per lesson, in the corrections list's shape so its ids are read the same way. */
export function sweepList(project: string, lessons: readonly { id: number; text: string; created_at: number; correction: number }[]): string {
  const kept = lessons.slice(-LIST_MAX);
  const cut = lessons.length - kept.length;
  return [
    `# Lessons of ${project}`,
    "",
    `${lessons.length} lessons in use${cut > 0 ? ` (the oldest ${cut} left out)` : ""}, from \`flowryn learnings\`. Each line: id · lesson or correction · date learned · - · words. A law to ship cites these ids.`,
    "",
    ...kept.map((l) => `- l${l.id} · ${l.correction ? "correction" : "lesson"} · ${day(l.created_at)} · - · ${clean(l.text)}`),
  ].join("\n");
}

function sweepBody(project: string, count: number): string {
  return [
    `Sort ${project}'s lessons: law, fact or stale. This sweep runs once per project.`,
    "",
    `The plan's shared brief lists its ${count} lessons. Follow the correct skill your stage names ("As the learnings sweep"): a lesson that is a rule a check could enforce is a law; one that is still true but no rule is a fact; one the code no longer bears out is stale. Read the code and the project's AGENTS.md laws table before you decide: a rule already in the table is a fact here.`,
    "",
    `Report with ## Short answer (at most 15 lines), then ## ${CHECKS_HEADING} (at most ${CORRECTIONS_MAX_SHIPS} entries, each citing the lessons it enforces on its Evidence: line and its laws row on a Law: line), then ## ${STALE_HEADING} (one line each: - l<N>: why). Every other lesson stays as a fact. Change no code.`,
  ].join("\n");
}

/** File a project's learnings sweep, unless one was ever filed or it has no lesson. */
function fileSweep(db: Db, project: ProjectRow, now: number): { plan: string; task: string; lessons: number } | null {
  if (db.query("SELECT 1 FROM plans WHERE project_id = ?1 AND filed_by = ?2 LIMIT 1").get(project.id, SWEEP_FILER)) return null;
  const lessons = lessonsOf(db, project.id);
  if (lessons.length === 0) return null;
  const title = `Sort ${project.id}'s lessons: law, fact or stale`;
  const phase: PlanPhase = { title, body: sweepBody(project.id, lessons.length), workflow: CORRECTIONS_WORKFLOW, harness: null, after: null };
  const plan = recordPlan(db, { project, title, phases: [phase], sourceTask: null, gateId: null, workflow: CORRECTIONS_WORKFLOW, filedBy: SWEEP_FILER, state: "approved", now });
  db.query("UPDATE plans SET preamble = ?2 WHERE id = ?1").run(plan.id, sweepList(project.id, lessons));
  return { plan: plan.id, task: plan.phases[0]!.task_id, lessons: lessons.length };
}

// --- the scout's report ---------------------------------------------------------------------

export interface CheckEntry {
  title: string;
  evidence: string[];
  /** The `Law:` line's table row, its cells split as the laws step splits them; null when it has none. */
  law: string[] | null;
  body: string;
}

/** A report's `## <heading>` section: its lines up to the next `##`, or null when it has none. */
function section(report: string, heading: string): string[] | null {
  const lines = report.split("\n");
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading.toLowerCase()}`);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  return end < 0 ? rest : rest.slice(0, end);
}

/** The `## Checks to ship` entries of a report: `### <title>`, then `Evidence:` and `Law:` lines and the words. */
export function parseChecks(report: string): CheckEntry[] {
  const entries: string[][] = [];
  for (const line of section(report, CHECKS_HEADING) ?? []) {
    if (/^###\s/.test(line)) entries.push([line]);
    else if (entries.length > 0) entries[entries.length - 1]!.push(line);
  }
  return entries.map((entry) => {
    const evidenceLine = entry.find((l) => /^evidence:/i.test(l.trim()));
    const evidence = evidenceLine ? [...new Set(evidenceLine.trim().slice("evidence:".length).split(/[,\s]+/).map((id) => id.trim()).filter(Boolean))] : [];
    const lawLine = entry.find((l) => /^law:/i.test(l.trim()))?.trim().slice("law:".length).trim();
    const law = lawLine?.startsWith("|") ? splitRow(lawLine) : null;
    return { title: sanitizeLine(entry[0]!.replace(/^###\s*/, ""), TITLE_MAX), evidence, law, body: entry.slice(1).join("\n").trim() };
  });
}

/** The sweep report's `## Stale lessons` lines: `- l<N>: why`, each id once, in order. */
export function parseStale(report: string): { id: string; why: string }[] {
  const out = new Map<string, string>();
  for (const line of section(report, STALE_HEADING) ?? []) {
    const m = /^\s*[-*]\s*`?(l\d+)`?\s*[:·—-]?\s*(.*)$/.exec(line);
    if (m && !out.has(m[1]!)) out.set(m[1]!, sanitizeLine(m[2]!, TITLE_MAX));
  }
  return [...out].map(([id, why]) => ({ id, why }));
}

/** The ids a scout was given, from the lines of its plan's shared brief, each with the corrections it stands for (a lesson learned again, two). */
export function listedIds(list: string): Map<string, number> {
  const ids = new Map<string, number>();
  for (const line of list.split("\n")) {
    const m = LIST_LINE.exec(line);
    if (m) ids.set(m[1]!, m[2]!.trim() === AGAIN_LABEL ? 2 : 1);
  }
  return ids;
}

/** The corrections scout or learnings sweep a task is, with its list, or null for any other task. */
export function correctionsPlanOf(db: Db, taskId: string): { preamble: string; sweep: boolean } | null {
  const row = db
    .query("SELECT pl.preamble, pl.filed_by FROM plan_phases ph JOIN plans pl ON pl.id = ph.plan_id WHERE ph.task_id = ?1 AND pl.filed_by IN (?2, ?3)")
    .get(taskId, CORRECTIONS_FILER, SWEEP_FILER) as { preamble: string | null; filed_by: string } | null;
  return row ? { preamble: row.preamble ?? "", sweep: row.filed_by === SWEEP_FILER } : null;
}

export interface FiledChecks {
  plan: string | null;
  ships: string[];
  refused: { title: string; why: string }[];
  /** A sweep's buckets: each listed lesson in exactly one. */
  swept?: LessonBuckets;
}

export interface LessonBuckets {
  /** Lessons a filed ship enforces. */
  law: string[];
  /** Lessons proposed for `flowryn unlearn`, with why. */
  stale: { id: string; why: string }[];
  /** Every other listed lesson: left as it is. */
  fact: string[];
}

/** Why an entry's `Law:` row is not one the laws step could check once its ship lands, or null. */
function lawRefusal(law: string[] | null): string | null {
  if (law === null) return "no Law: line (| rule | enforced by | proven on |)";
  if (law.length !== 3 || law.some((cell) => cell.length === 0)) return "its Law: row needs three cells: rule, enforced by, proven on";
  const parsed = parseEnforcers(law[1]!);
  if ("error" in parsed) return `its Law: row's Enforced by: ${parsed.error}`;
  if (parsed.enforcers.length === 0) return "its Law: row's Enforced by names nothing verify can run or confirm";
  if (provenCommits(law[2]!).length === 0) return "its Law: row's Proven on names no commit the check fails at";
  return null;
}

function refusal(entry: CheckEntry, listed: Map<string, number>, min: number): string | null {
  if (entry.title.length === 0) return "no title";
  if (!entry.body.split("\n").some((l) => l.trim().length > 0 && !FIELD_LINE.test(l.trim()))) return "no words under the title";
  const bad = entry.evidence.filter((id) => !EVIDENCE_ID.test(id) || !listed.has(id));
  if (bad.length > 0) return `cites ids not in its list: ${bad.slice(0, 5).join(", ")}`;
  const cited = entry.evidence.reduce((n, id) => n + listed.get(id)!, 0);
  if (cited < min) return min === 1 ? "cites no lesson from its list" : `cites ${cited} correction${cited === 1 ? "" : "s"}; a class needs ${min}`;
  return lawRefusal(entry.law);
}

/** Each listed lesson's bucket: law when a filed ship cites it, else stale when the report says so, else fact. */
function bucketsOf(listed: ReadonlyMap<string, number>, cited: Set<string>, stale: readonly { id: string; why: string }[]): LessonBuckets {
  const staleKept = stale.filter((s) => listed.has(s.id) && !cited.has(s.id));
  const staleIds = new Set(staleKept.map((s) => s.id));
  const ids = [...listed.keys()];
  return { law: ids.filter((id) => cited.has(id)), stale: staleKept, fact: ids.filter((id) => !cited.has(id) && !staleIds.has(id)) };
}

/**
 * File a corrections scout's checks as ships of its project: one approved plan, its phases
 * independent of each other, its shared brief the scout's list (so each ship reads the words it
 * cites). An entry citing fewer than two listed ids (one lesson, for a sweep), with no checkable
 * `Law:` row, or past CORRECTIONS_MAX_SHIPS, is refused. Records CORRECTIONS_SHIPS_KIND whenever
 * the report had entries. A sweep's report also sorts every listed lesson into one bucket, recorded
 * once as LEARNINGS_SWEPT_KIND (a run delivers once). Call inside the delivery's transaction.
 */
export function fileChecks(
  db: Db,
  input: { project: ProjectRow; scoutTask: string; runId: string; plan: { preamble: string; sweep: boolean }; report: string; skillPath: string | null; now: number },
): FiledChecks | null {
  const entries = parseChecks(input.report);
  if (entries.length === 0 && !input.plan.sweep) return null;
  const listed = listedIds(input.plan.preamble);
  const refused: FiledChecks["refused"] = [];
  const phases: PlanPhase[] = [];
  const cited = new Set<string>();
  for (const entry of entries) {
    const why = refusal(entry, listed, input.plan.sweep ? 1 : CORRECTIONS_MIN);
    if (why) refused.push({ title: entry.title || "(untitled)", why });
    else if (phases.length >= CORRECTIONS_MAX_SHIPS) refused.push({ title: entry.title, why: `over ${CORRECTIONS_MAX_SHIPS} checks from one report` });
    else {
      phases.push({ title: entry.title, body: shipBody(entry, input.scoutTask, input.skillPath, input.plan.sweep), workflow: input.project.workflow, harness: null, after: [] });
      for (const id of entry.evidence) cited.add(id);
    }
  }
  let plan: { id: string; phases: { task_id: string }[] } | null = null;
  if (phases.length > 0) {
    plan = recordPlan(db, { project: input.project, title: `Checks from ${input.scoutTask}`, phases, sourceTask: null, gateId: null, workflow: input.project.workflow, filedBy: `corrections scout (${input.scoutTask})`, state: "approved", now: input.now });
    db.query("UPDATE plans SET preamble = ?2 WHERE id = ?1").run(plan.id, input.plan.preamble);
  }
  const filed: FiledChecks = { plan: plan?.id ?? null, ships: plan?.phases.map((p) => p.task_id) ?? [], refused };
  if (entries.length > 0) appendEvent(db, { source: "cli", kind: CORRECTIONS_SHIPS_KIND, runId: input.runId, taskId: input.scoutTask, payload: { ...filed, project: input.project.id }, ts: input.now });
  if (input.plan.sweep) {
    filed.swept = bucketsOf(listed, cited, parseStale(input.report));
    appendEvent(db, { source: "cli", kind: LEARNINGS_SWEPT_KIND, runId: input.runId, taskId: input.scoutTask, payload: { project: input.project.id, plan: filed.plan, ...filed.swept }, ts: input.now });
  }
  return filed;
}

function shipBody(entry: CheckEntry, scoutTask: string, skillPath: string | null, sweep: boolean): string {
  const words = entry.body.length > SHIP_BODY_MAX ? `${entry.body.slice(0, SHIP_BODY_MAX)}\n[cut at ${SHIP_BODY_MAX} characters]` : entry.body;
  const skill = skillPath ? `the ${CORRECT_SKILL_NAME} skill (${skillPath})` : `the ${CORRECT_SKILL_NAME} skill`;
  const by = sweep ? `the learnings sweep ${scoutTask}; the lessons it cites` : `the weekly corrections scout ${scoutTask}; the corrections it cites`;
  return [
    words,
    "",
    `Filed by ${by} are in this plan's shared brief. Build this check with ${skill}: prove it fails on the past mistake's commit and passes on HEAD, and add its Law: row to the project's AGENTS.md rule↔enforcer table (Enforced by as you built it, Proven on the commit you proved it on), in this change.`,
  ].join("\n");
}

/** The report-ready item's words for what a corrections scout or sweep filed. */
export function filedNote(filed: FiledChecks | null): string {
  if (!filed) return "";
  const ships = `${filed.ships.length} check${filed.ships.length === 1 ? "" : "s"} filed as ships${filed.plan ? ` (${filed.plan})` : ""}${filed.refused.length > 0 ? `, ${filed.refused.length} refused` : ""}`;
  const stale = filed.swept && filed.swept.stale.length > 0 ? `; ${filed.swept.stale.length} stale lesson${filed.swept.stale.length === 1 ? "" : "s"} proposed for flowryn unlearn: ${filed.swept.stale.map((s) => s.id).join(", ")}` : "";
  return `; ${ships}${stale}`;
}
