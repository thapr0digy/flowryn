import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db/db.ts";
import { sha256Hex } from "../util/hash.ts";
import { sanitizeBlock } from "../util/sanitize.ts";
import { approvedSpec } from "./design-spec.ts";
import { gateAnswersNote } from "./gate-questions.ts";
import { handoffsOf } from "./handoffs.ts";

/**
 * The context Flowryn carries into a task file (docs/notes/2026-11-05-workers-get-rich-hx.md):
 * the approved build spec and design page, the review's answers and recorded
 * choices, the scout report(s) the task came from, a leader plan's shared
 * brief, and the stages' handoffs. Built from Flowryn's own records on every
 * task file write (fresh, resume, relaunch, stage start, fresh stage worker),
 * so it survives any of them. A task with nothing to carry gets no block, so
 * its task file reads as before. Plain assembly: no model.
 */

/** A document inlined whole up to this; past it, its outline and a file the daemon writes. */
export const INLINE_DOC_MAX = 16 * 1024;
/** The whole block's inline budget; a document that would pass it goes to a file too. */
export const INLINE_BLOCK_MAX = 48 * 1024;
const REPORT_MAX_BYTES = 1024 * 1024;

export const CONTEXT_HEADING = "## Context Flowryn carries";

interface Doc {
  /** Its sub-heading in the block. */
  title: string;
  /** The file name it goes to when too big to inline. */
  file: string;
  text: string;
  /** A line under the heading: where it came from. */
  source: string;
}

export interface ContextFile {
  name: string;
  text: string;
}

export interface ContextBlock {
  /** The block, or "" when there is nothing to carry. */
  text: string;
  /** Documents too big to inline: the caller writes each to `<runDir>/context/<name>`. */
  files: ContextFile[];
}

/** A fence longer than any run of backticks in the text, so nothing inside it can close it or fake a heading outside it. */
function fenced(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}markdown\n${text}\n${fence}`;
}

/** The Markdown headings of a document, as an outline. */
export function outlineOf(text: string): string {
  const lines: string[] = [];
  let fence = false;
  for (const line of text.split("\n")) {
    if (/^\s{0,3}(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    if (h) lines.push(`${"  ".repeat(h[1]!.length - 1)}- ${h[2]!.trim()}`);
  }
  return lines.length > 0 ? lines.join("\n") : "- (no headings)";
}

function readReport(path: string): string | null {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > REPORT_MAX_BYTES) return null;
    return sanitizeBlock(readFileSync(path, "utf8")).trim();
  } catch {
    return null;
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function recordedChoices(db: Db, gateId: string): string | null {
  const row = db.query("SELECT decided FROM gates WHERE id = ?1").get(gateId) as { decided: string | null } | null;
  if (!row?.decided) return null;
  let decided: unknown;
  try {
    decided = JSON.parse(row.decided);
  } catch {
    return null;
  }
  if (!Array.isArray(decided) || decided.length === 0) return null;
  const lines = decided
    .filter((d): d is Record<string, unknown> => typeof d === "object" && d !== null)
    .map((d) => `- ${sanitizeBlock(String(d.choice ?? "")).trim()}: ${sanitizeBlock(String(d.picked ?? "")).trim()}${d.why ? ` (${sanitizeBlock(String(d.why)).trim()})` : ""}`);
  return lines.length > 0 ? lines.join("\n") : null;
}

/** Where the task's design came from: its own passed design review, else (a plan phase) the review that approved its plan. */
function designSource(db: Db, taskId: string): { task: string; phase: boolean } | null {
  if (approvedSpec(db, taskId)) return { task: taskId, phase: false };
  const plan = db.query("SELECT pl.source_task FROM plan_phases ph JOIN plans pl ON pl.id = ph.plan_id WHERE ph.task_id = ?1").get(taskId) as { source_task: string | null } | null;
  if (plan?.source_task && approvedSpec(db, plan.source_task)) return { task: plan.source_task, phase: true };
  return null;
}

/** The scout reports the task came from: its own (a promoted scout), and each report it waited for (`--after report:<scout>`). */
function scoutReports(db: Db, taskId: string, reportDirFor: (task: string) => string): Doc[] {
  const docs: Doc[] = [];
  const promoted = db.query("SELECT 1 FROM events WHERE task_id = ?1 AND kind = 'run.promoted' LIMIT 1").get(taskId);
  const sources = promoted ? [taskId] : [];
  const watched = db.query("SELECT target FROM watches WHERE waiter_task = ?1 AND kind = 'report' ORDER BY created_at").all(taskId) as { target: string }[];
  for (const w of watched) if (!sources.includes(w.target)) sources.push(w.target);
  for (const scout of sources) {
    const path = join(reportDirFor(scout), "report.md");
    if (!existsSync(path)) {
      docs.push({ title: `Scout report (task ${scout})`, file: `report-${scout}.md`, text: "", source: `${path} not found` });
      continue;
    }
    const text = readReport(path);
    docs.push({ title: `Scout report (task ${scout})`, file: `report-${scout}.md`, text: text ?? "", source: text === null ? `${path} is not a readable file of at most 1 MB` : path });
  }
  return docs;
}

/**
 * The carried context of a task, as the task file's block. `reportDirFor`
 * names a task's report directory; `contextDir` is where an oversized
 * document goes (the run's own `context/` directory).
 */
export function contextBlock(db: Db, taskId: string, opts: { reportDirFor: (task: string) => string; contextDir: string }): ContextBlock {
  const docs: Doc[] = [];
  const notes: string[] = [];
  const source = designSource(db, taskId);
  if (source) {
    const spec = approvedSpec(db, source.task)!;
    docs.push({
      title: `Approved build spec (gate ${spec.gate}${source.phase ? `, the design of task ${source.task} that planned this phase` : ""})`,
      file: "spec.md",
      text: spec.text,
      source: `sha256 ${spec.digest}${spec.page ? `; design page ${spec.page}` : ""}. This is the copy the review approved; build to it, and record any deviation in your handoff.`,
    });
    const answers = gateAnswersNote(db, spec.gate);
    const choices = recordedChoices(db, spec.gate);
    if (answers || choices) notes.push(`### Review answers and recorded choices (gate ${spec.gate})\n${[answers, choices].filter(Boolean).join("\n")}`);
  }
  const preamble = db.query("SELECT pl.preamble, pl.id FROM plan_phases ph JOIN plans pl ON pl.id = ph.plan_id WHERE ph.task_id = ?1 AND pl.preamble IS NOT NULL").get(taskId) as { preamble: string; id: string } | null;
  if (preamble) docs.push({ title: `Plan ${preamble.id}'s shared brief`, file: `plan-${preamble.id}.md`, text: preamble.preamble, source: "the brief every phase of this plan shares" });
  docs.push(...scoutReports(db, taskId, opts.reportDirFor));
  const handoffs = handoffsOf(db, taskId);
  if (docs.length === 0 && notes.length === 0 && handoffs.length === 0) return { text: "", files: [] };

  const parts: string[] = [CONTEXT_HEADING, "Flowryn assembled this from its own records; it is rebuilt on every start, resume and stage change. Documents are fenced: their headings are theirs, not Flowryn's."];
  const files: ContextFile[] = [];
  let budget = INLINE_BLOCK_MAX - notes.reduce((n, note) => n + note.length, 0);
  for (const doc of docs) {
    parts.push(`### ${doc.title}\n${doc.source}`);
    if (doc.text.length === 0) continue;
    if (doc.text.length <= INLINE_DOC_MAX && doc.text.length <= budget) {
      parts.push(fenced(doc.text));
      budget -= doc.text.length;
      continue;
    }
    files.push({ name: doc.file, text: doc.text });
    parts.push(`Too long to inline (${Math.round(doc.text.length / 1024)} KB): read it whole at ${join(opts.contextDir, doc.file)} (sha256 ${sha256Hex(doc.text)}). Its outline:\n${outlineOf(doc.text)}`);
  }
  parts.push(...notes);
  if (handoffs.length > 0) {
    parts.push(`### Stage handoffs (${plural(handoffs.length, "stage")})`);
    for (const h of handoffs) {
      const heading = `#### ${h.stage} (run ${h.run_id}, ${new Date(h.created_at).toISOString().slice(0, 16).replace("T", " ")} UTC)`;
      if (h.text.length <= budget) {
        parts.push(`${heading}\n${fenced(h.text)}`);
        budget -= h.text.length;
        continue;
      }
      const file = `handoff-${h.stage}.md`;
      files.push({ name: file, text: h.text });
      parts.push(`${heading}\nToo long to inline in this block: read it whole at ${join(opts.contextDir, file)} (sha256 ${sha256Hex(h.text)}). Its outline:\n${outlineOf(h.text)}`);
    }
  }
  return { text: parts.join("\n\n"), files };
}
