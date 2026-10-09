/**
 * Per-feature notes (docs/notes/README.md): each ship writes its own
 * `docs/notes/<yyyy-mm-dd>-<slug>.md`, so two PRs never touch the same docs
 * file. Nothing commits an index (it would be one more shared file); this
 * script prints it on demand, and `bun test` checks every file's shape.
 *
 *   bun run notes          print the table, newest first
 *   bun run notes --check  only validate; exit 1 naming each bad file
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const NOTES_DIR = "docs/notes";

/** Files frozen on 2026-10-09: fixed in place, never given a new section. */
export const FROZEN_DOCS = ["docs/m1-notes.md", "docs/m2-notes.md", "docs/m3-notes.md", "docs/m4-notes.md", "docs/m5-notes.md", "docs/cutover-notes.md", "docs/v1-status.md"] as const;

export const NOTE_FILE = /^(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
export const STATUSES = ["done", "partial", "not built"] as const;
export type NoteStatus = (typeof STATUSES)[number];

export interface Note {
  file: string;
  date: string;
  slug: string;
  title: string;
  status: NoteStatus;
  open: string | null;
  config: string[];
}

export type ParseResult = { ok: true; note: Note } | { ok: false; file: string; problems: string[] };

const HEADER_LINE = /^- (Status|Open|Config): (.+)$/;

/** Parse one notes file: an H1, then a bullet block of Status (required), Open and Config. */
export function parseNote(file: string, text: string): ParseResult {
  const problems: string[] = [];
  const name = NOTE_FILE.exec(file);
  if (!name) problems.push(`the name must be <yyyy-mm-dd>-<slug>.md in lowercase kebab case`);
  else if (Number.isNaN(Date.parse(`${name[1]}T00:00:00Z`))) problems.push(`${name[1]} is not a date`);

  const lines = text.split("\n");
  let i = lines.findIndex((l) => l.trim() !== "");
  const h1 = i >= 0 ? /^# (.+)$/.exec(lines[i]!) : null;
  if (!h1) problems.push("the first line must be the title, as `# <title>`");

  const header = new Map<string, string>();
  for (i += 1; i < lines.length && lines[i]!.trim() === ""; i++);
  for (; i < lines.length; i++) {
    const m = HEADER_LINE.exec(lines[i]!);
    if (!m) break;
    if (header.has(m[1]!)) problems.push(`the ${m[1]} line appears twice`);
    header.set(m[1]!, m[2]!.trim());
  }

  const status = header.get("Status");
  if (status === undefined) problems.push("a `- Status: done|partial|not built` line must follow the title");
  else if (!(STATUSES as readonly string[]).includes(status)) problems.push(`Status "${status}" is not one of ${STATUSES.join(", ")}`);
  else if (status !== "done" && !header.has("Open")) problems.push(`Status ${status} needs an \`- Open: <what is left>\` line`);

  const configText = header.get("Config");
  const config = configText ? [...configText.matchAll(/`([^`]+)`/g)].map((m) => m[1]!) : [];
  if (configText !== undefined && config.length === 0) problems.push("the Config line lists its keys in backticks");

  if (problems.length > 0) return { ok: false, file, problems };
  return { ok: true, note: { file, date: name![1]!, slug: name![2]!, title: h1![1]!.trim(), status: status as NoteStatus, open: header.get("Open") ?? null, config } };
}

/** Parse every notes file in `dir` (its README.md aside), sorted by name. */
export function readNotes(dir: string): ParseResult[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .toSorted()
    .map((f) => parseNote(f, readFileSync(join(dir, f), "utf8")));
}

/** The `#` headings of a markdown file, outside fenced code blocks. */
export function headings(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && /^#{1,6} /.test(line)) out.push(line.trimEnd());
  }
  return out;
}

/** The PR that added a file, from its squash-merge subject "… (#NN)"; null before it is merged. */
export function prFromGit(repo: string, path: string): number | null {
  const log = Bun.spawnSync(["git", "log", "--diff-filter=A", "--reverse", "--format=%s", "--", path], { cwd: repo });
  if (log.exitCode !== 0) throw new Error(`git log failed for ${path}: ${log.stderr.toString().trim()}`);
  const first = log.stdout.toString().split("\n")[0] ?? "";
  const m = /\(#(\d+)\)\s*$/.exec(first);
  return m ? Number(m[1]) : null;
}

const cell = (s: string) => s.replaceAll("|", "\\|");

/** The markdown index, newest first. Same notes and PRs, same bytes. */
export function renderIndex(notes: Note[], prOf: (note: Note) => number | null): string {
  const rows = notes
    .toSorted((a, b) => (a.file < b.file ? 1 : a.file > b.file ? -1 : 0))
    .map((n) => {
      const pr = prOf(n);
      const status = n.open ? `${n.status}; open: ${n.open}` : n.status;
      const config = n.config.map((k) => `\`${k}\``).join(", ");
      return `| ${n.date} | [${cell(n.title)}](${NOTES_DIR}/${n.file}) | ${cell(status)} | ${pr === null ? "" : `#${pr}`} | ${cell(config)} |`;
    });
  return ["| Date | Feature | Status | PR | Config |", "|---|---|---|---|---|", ...rows].join("\n") + "\n";
}

function main(argv: string[]): number {
  const repo = resolve(import.meta.dir, "../..");
  const results = readNotes(join(repo, NOTES_DIR));
  const bad = results.filter((r) => !r.ok);
  for (const r of bad) if (!r.ok) process.stderr.write(`${NOTES_DIR}/${r.file}: ${r.problems.join("; ")}\n`);
  if (bad.length > 0) return 1;
  if (argv.includes("--check")) return 0;
  const notes = results.flatMap((r) => (r.ok ? [r.note] : []));
  process.stdout.write(renderIndex(notes, (n) => prFromGit(repo, `${NOTES_DIR}/${n.file}`)));
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
