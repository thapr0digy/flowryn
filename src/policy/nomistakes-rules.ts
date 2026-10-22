import { isAbsolute, relative } from "node:path";
import { irreversibleText, NM_FLOOR, type FileClass, type NmRule, type RuleAnswer } from "../attention/decisions-policy.ts";
import type { GitRunner } from "./landed.ts";
import { ownParkedRun, parseNmStatus, readNmStatus, type NmFinding } from "./nomistakes.ts";

/**
 * Settling a no-mistakes ask-user finding by rule (docs/notes/2026-10-22-settle-routine-no-2r.md).
 * Plain lookup, no model: the gate's step and findings come from no-mistakes'
 * own status, and each finding's file class from git, never from the
 * worker's wording. A gate is settled only when every ask-user finding
 * matches a rule; anything else is the user's, with the reason why.
 */

/** The branch's diff against its base: files it added, and for each other file it changed, the new-side line ranges. */
export interface BranchDiff {
  added: Set<string>;
  changed: Map<string, [number, number][]>;
}

/** What the daemon read for a `--nomistakes` ask: the parked gate and the diff, or why it could not tell. */
export type RuleFacts = { ok: true; step: string; findings: NmFinding[]; diff: BranchDiff } | { ok: false; reason: string };

export interface ClassifiedFinding {
  id: string;
  severity: string;
  file: string;
  cls: FileClass;
}

export type RuleVerdict = { settled: true; answer: RuleAnswer; rules: string[]; findings: ClassifiedFinding[]; words: string } | { settled: false; reason: string };

/** `git diff --name-status -M` lines: A is added; M, T, and the new path of a rename or copy are changed. */
export function parseNameStatus(text: string): { added: Set<string>; changed: Set<string> } {
  const added = new Set<string>();
  const changed = new Set<string>();
  for (const line of text.split("\n")) {
    const parts = line.split("\t");
    const status = parts[0] ?? "";
    if (status === "A" && parts[1]) added.add(parts[1]);
    else if ((status === "M" || status === "T") && parts[1]) changed.add(parts[1]);
    else if (/^[RC]\d*$/.test(status) && parts[2]) changed.add(parts[2]);
  }
  return { added, changed };
}

/** The new-side line ranges of each file in `git diff -U0` output; a pure deletion hunk (`+c,0`) adds none. */
export function parseHunks(text: string): Map<string, [number, number][]> {
  const ranges = new Map<string, [number, number][]>();
  let file: string | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      // A quoted path (unusual characters) is left unread: its findings then fall outside the diff, the user's.
      file = path.startsWith("b/") ? path.slice(2) : null;
      if (file !== null && !ranges.has(file)) ranges.set(file, []);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && file !== null) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (count > 0) ranges.get(file)!.push([start, start + count - 1]);
    }
  }
  return ranges;
}

/** A finding's path as the diff names it: repo-relative, no leading `./`; an absolute one inside the worktree is made relative. */
export function findingPath(file: string, worktree: string): string {
  const trimmed = file.trim();
  if (trimmed === "") return "";
  if (isAbsolute(trimmed)) {
    const rel = relative(worktree, trimmed);
    return rel.startsWith("..") || isAbsolute(rel) ? trimmed : rel;
  }
  return trimmed.replace(/^(\.\/)+/, "");
}

/** Where the finding sits against the branch's diff. A line that does not read as a number counts as no line. */
export function fileClass(path: string, line: string, diff: BranchDiff): FileClass {
  if (path === "") return "none";
  if (diff.added.has(path)) return "added";
  const ranges = diff.changed.get(path);
  if (ranges === undefined) return "outside";
  const at = /^\s*(\d+)/.exec(line);
  if (!at) return "touched";
  const n = Number(at[1]);
  return ranges.some(([a, b]) => n >= a && n <= b) ? "diff-line" : "touched";
}

/** The gate's ask-user findings against the table, all or nothing. Pure: the facts were read before. */
export function matchRules(input: { step: string; findings: NmFinding[]; diff: BranchDiff; worktree: string; options: string[]; sensitive: boolean }, rules: readonly NmRule[]): RuleVerdict {
  const asks = input.findings.filter((f) => f.action === "ask-user");
  if (asks.length === 0) return { settled: false, reason: `no ask-user finding at the ${input.step || "parked"} gate` };
  if (input.sensitive) return { settled: false, reason: "sensitive task" };
  if ((NM_FLOOR.steps as readonly string[]).includes(input.step)) return { settled: false, reason: `${input.step} gate` };
  const classified: ClassifiedFinding[] = [];
  const matched: NmRule[] = [];
  for (const f of asks) {
    const path = findingPath(f.file, input.worktree);
    const cls = fileClass(path, f.line, input.diff);
    if ((NM_FLOOR.severities as readonly string[]).includes(f.severity)) return { settled: false, reason: `${f.severity} finding ${f.id}` };
    if (NM_FLOOR.files.includes(cls)) return { settled: false, reason: cls === "none" ? `${f.id} names no file` : `${f.id} is outside the diff` };
    if (irreversibleText(f.description)) return { settled: false, reason: `${f.id} names an irreversible step` };
    const rule = rules.find((r) => r.step === input.step && r.severity === f.severity && r.file.includes(cls));
    if (!rule) return { settled: false, reason: `no rule for ${f.id} (${input.step} ${f.severity || "-"}, ${cls})` };
    classified.push({ id: f.id, severity: f.severity, file: path, cls });
    matched.push(rule);
  }
  const answers = [...new Set(matched.map((r) => r.answer))];
  if (answers.length > 1) return { settled: false, reason: `the rules disagree (${answers.join(", ")})` };
  const answer = answers[0]!;
  if (!input.options.includes(answer)) return { settled: false, reason: `the rules' answer ${answer} is not one of the options` };
  const ids = [...new Set(matched.map((r) => r.id))];
  const list = classified.map((f) => `${f.id} (${f.severity}, ${f.file}, ${f.cls})`).join("; ");
  const findingIds = classified.map((f) => f.id).join(",");
  const respond = answer === "fix" ? `no-mistakes axi respond --action fix --findings ${findingIds}` : `no-mistakes axi respond --action ${answer}`;
  return { settled: true, answer, rules: ids, findings: classified, words: `Settled by rule ${ids.join(", ")}: ${list}. Run ${respond}.` };
}

export interface RuleFactDeps {
  noMistakes: string | null;
  git: GitRunner;
  timeoutMs: number;
}

/**
 * Read the facts for a `--nomistakes` ask: the worktree's own run parked at a
 * gate (ownParkedRun: its branch, a head at or past the worktree's HEAD), and
 * the branch's diff from its merge base with origin/<default branch> to that
 * head. Any read that fails says why; the ask is then the user's.
 */
export async function readRuleFacts(deps: RuleFactDeps, worktree: string, defaultBranch: string): Promise<RuleFacts> {
  if (!deps.noMistakes) return { ok: false, reason: "no-mistakes is not installed" };
  const status = await readNmStatus(deps.noMistakes, worktree, deps.timeoutMs);
  if (status.code !== 0) return { ok: false, reason: "no-mistakes status unreadable" };
  const run = parseNmStatus(status.text);
  if (!run || !(await ownParkedRun(deps.git, worktree, run))) return { ok: false, reason: "no parked gate of this worktree's run" };
  if (run.findings === null) return { ok: false, reason: "the gate's findings do not read" };
  const head = run.headSha || run.head;
  const base = await deps.git(["merge-base", head, `refs/remotes/origin/${defaultBranch}`], worktree);
  if (base.code !== 0 || base.stdout.trim() === "") return { ok: false, reason: `no merge base with origin/${defaultBranch}` };
  const range = [base.stdout.trim(), head];
  const names = await deps.git(["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-M", ...range], worktree);
  const hunks = await deps.git(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "-U0", "-M", ...range], worktree);
  if (names.code !== 0 || hunks.code !== 0) return { ok: false, reason: "the branch's diff does not read" };
  const files = parseNameStatus(names.stdout);
  const ranges = parseHunks(hunks.stdout);
  const changed = new Map<string, [number, number][]>();
  for (const path of files.changed) changed.set(path, ranges.get(path) ?? []);
  return { ok: true, step: run.gateStep, findings: run.findings, diff: { added: files.added, changed } };
}
