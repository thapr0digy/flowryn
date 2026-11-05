/**
 * Structured briefs (docs/notes/2026-11-05-workers-get-rich-hx.md). A ship's
 * or a scout's dispatched body, a stage handoff and a design stage's build
 * spec are Markdown documents with fixed `## ` sections. This is the plain
 * parser that checks them: no model, only headings, bodies and placeholders.
 */

export type DocKind = "ship" | "scout" | "handoff" | "spec";

interface SectionDef {
  /** The heading as the template writes it. */
  title: string;
  /** Other headings accepted for it, normalized. */
  aliases?: string[];
  /** "None: <reason>" is a valid body (a docs-only change has no threat surface). */
  noneOk?: boolean;
}

const SHIP: SectionDef[] = [
  { title: "Intent", aliases: ["user's intent", "users intent", "the user's intent", "captain's intent"] },
  { title: "Context", aliases: ["context and sources"] },
  { title: "Requirements" },
  { title: "Constraints" },
  { title: "Security", aliases: ["security bar"], noneOk: true },
  { title: "Out of scope", aliases: ["non-goals"], noneOk: true },
  { title: "Verification", aliases: ["definition of done"] },
];

const SCOUT: SectionDef[] = [
  { title: "Intent", aliases: ["user's intent", "users intent", "the user's intent", "captain's intent"] },
  { title: "Context", aliases: ["context and sources"] },
  { title: "Questions", aliases: ["what the report must answer"] },
  { title: "Out of scope", aliases: ["non-goals"], noneOk: true },
];

const HANDOFF: SectionDef[] = [
  { title: "Done", aliases: ["what was done"], noneOk: true },
  { title: "Deviations", aliases: ["deviations from the spec"], noneOk: true },
  { title: "Risks", aliases: ["open risks"], noneOk: true },
];

const SPEC: SectionDef[] = [
  { title: "Approach" },
  { title: "Files and interfaces" },
  { title: "Data and schema", noneOk: true },
  { title: "Error handling" },
  { title: "Security", noneOk: true },
  { title: "Test plan" },
  { title: "Rejected alternatives", noneOk: true },
];

export const DOC_SECTIONS: Readonly<Record<DocKind, readonly SectionDef[]>> = { ship: SHIP, scout: SCOUT, handoff: HANDOFF, spec: SPEC };

/** A brief may also carry these, unchecked: the leader's build instructions (firstmate's "spec" half). */
export const OPTIONAL_SHIP_SECTIONS = ["Spec"] as const;

export interface Section {
  heading: string;
  body: string;
}

export function normalizeHeading(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[*_:]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The `## ` sections of a Markdown document, in order; a heading inside a fenced code block is text. */
export function parseSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  let fence: string | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const fenceMark = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fenceMark) {
      if (fence === null) fence = fenceMark[0]!;
      else if (fenceMark[0] === fence) fence = null;
    }
    const heading = fence === null && !fenceMark ? /^##\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (heading) {
      current = { heading: heading[1]!, body: "" };
      sections.push(current);
      continue;
    }
    if (current) current.body += `${line}\n`;
  }
  return sections.map((s) => ({ heading: s.heading, body: s.body.trim() }));
}

/** A template slot left as it was: a line that is wholly `{{...}}` (code with braces inside a line is text). */
const PLACEHOLDER = /^\s*\{\{[^\n]*\}\}\s*$/m;
const ONLY_TODO = /^(?:todo|tbd|tba|fixme|\.\.\.|…|-)\.?$/i;
const NONE_WITH_REASON = /^none\s*[:.—-]\s*\S/i;

function sectionFor(def: SectionDef, sections: Section[]): Section | undefined {
  const names = new Set([normalizeHeading(def.title), ...(def.aliases ?? []).map(normalizeHeading)]);
  return sections.find((s) => names.has(normalizeHeading(s.heading)));
}

/** Text in a section once its sub-headings and list markers are set aside. */
function substance(body: string): string {
  return body
    .split("\n")
    .filter((l) => !/^\s*#{3,}\s/.test(l))
    .join(" ")
    .replace(/^[\s>*+-]+/gm, "")
    .trim();
}

/**
 * Every problem with a document of this kind, one line each, in section order;
 * empty when it passes. A missing, empty or placeholder section is a problem;
 * a section that may be none must still say why ("None: docs only").
 */
export function docProblems(kind: DocKind, markdown: string): string[] {
  const sections = parseSections(markdown);
  const problems: string[] = [];
  const missing: string[] = [];
  for (const def of DOC_SECTIONS[kind]) {
    const found = sectionFor(def, sections);
    if (!found) {
      missing.push(def.title);
      continue;
    }
    const text = substance(found.body);
    if (text.length === 0) problems.push(`section "${def.title}" is empty`);
    else if (PLACEHOLDER.test(found.body)) problems.push(`section "${def.title}" still holds a template placeholder`);
    else if (ONLY_TODO.test(text)) problems.push(`section "${def.title}" says only "${text}"; write it`);
    else if (/^none\.?$/i.test(text)) {
      if (!def.noneOk || kind !== "handoff") problems.push(def.noneOk ? `section "${def.title}" says none: say why ("None: <reason>")` : `section "${def.title}" cannot be none`);
    } else if (NONE_WITH_REASON.test(text) && !def.noneOk) problems.push(`section "${def.title}" cannot be none`);
  }
  const required = new Set(DOC_SECTIONS[kind].flatMap((d) => [d.title, ...(d.aliases ?? [])].map(normalizeHeading)));
  for (const extra of sections) {
    if (!required.has(normalizeHeading(extra.heading)) && PLACEHOLDER.test(extra.body)) problems.push(`section "${extra.heading}" still holds a template placeholder: fill it or drop the section`);
  }
  if (missing.length > 0) problems.unshift(`missing section${missing.length === 1 ? "" : "s"}: ${missing.map((m) => `## ${m}`).join(", ")}`);
  return problems;
}

/** The kind of brief a dispatch of this task kind must carry, or null when none is checked. */
export function briefKindFor(kind: string): DocKind | null {
  return kind === "ship" ? "ship" : kind === "scout" ? "scout" : null;
}
