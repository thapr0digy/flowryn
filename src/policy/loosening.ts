import { basename } from "node:path";

/**
 * Gate loosening in a fix's diff (docs/notes/2026-11-22-phase-countersign-gate-7e.md): plain
 * pattern rules over `git diff --unified=0`, no model. A fix may make a red check green by
 * moving the check instead of the code; these are the moves the merge gate holds for a
 * countersign (src/policy/countersign.ts). Detection is deliberately narrow, to keep false
 * positives on ordinary numeric edits away:
 *
 * - raised: a number raised on a changed line of a file named *budget*, or of a test runner's
 *   config or package manifest (VERIFY_CONFIG) on a line naming a timeout, deadline, threshold,
 *   limit, retries or budget.
 * - skip: an added line that skips a test (SKIP_MARKERS), in any file but Markdown.
 * - allowlist: a new entry in a file named *allowlist* (or allow-list, allow_list).
 */

export interface Loosening {
  file: string;
  kind: "raised" | "skip" | "allowlist";
  /** The added line, trimmed and cut to MAX_LINE characters. */
  line: string;
  /** raised: the old and new number as written. */
  from?: string;
  to?: string;
}

const MAX_LINE = 160;
const BUDGET_FILE = /budget/i;
const ALLOWLIST_FILE = /allow[-_]?list/i;
/** Test runner config: what a project's verify steps run under, scripts and tool sections of package manifests among it. */
const VERIFY_CONFIG = /^(?:bunfig\.toml|package\.json|makefile|gnumakefile|.+\.mk|(?:vitest|jest|playwright)\.config\.[cm]?[jt]s|jest\.config\.json|pytest\.ini|tox\.ini|pyproject\.toml|setup\.cfg|\.golangci\.ya?ml)$/i;
const GATE_WORD = /timeout|deadline|threshold|limit|retr(?:y|ies)|budget/i;
/** A test skipped: JS/TS, Go, Python and Rust spellings. A platform-only skipIf (AGENTS.md's darwin rule) is not one. */
const SKIP_MARKERS = [/\b(?:test|it|describe|suite|context)\.(?:skip|todo)\s*\(/, /\b(?:xit|xdescribe|xtest)\s*\(/, /\.skipIf\s*\(/, /\b[tb]\.Skip(?:f|Now)?\s*\(/, /@pytest\.mark\.(?:skip|skipif|xfail)\b/, /\bpytest\.skip\s*\(/, /@unittest\.skip/, /#\[ignore\]/];
const PLATFORM_SKIP = /\.skipIf\s*\(\s*process\.platform\b/;
/** Markdown only talks about skips. */
const PROSE_FILE = /\.md$/i;
/** A number with an optional unit; units of one dimension compare after scaling. */
const NUMBER = /(\d+(?:\.\d+)?)(ms|s|m|h|kb|mb|gb|k)?(?![\w.])/gi;
const SCALE: Record<string, { dim: string; factor: number }> = {
  ms: { dim: "time", factor: 1 },
  s: { dim: "time", factor: 1_000 },
  m: { dim: "time", factor: 60_000 },
  h: { dim: "time", factor: 3_600_000 },
  k: { dim: "size", factor: 1_000 },
  kb: { dim: "size", factor: 1_000 },
  mb: { dim: "size", factor: 1_000_000 },
  gb: { dim: "size", factor: 1_000_000_000 },
};

interface Hunk {
  file: string;
  removed: string[];
  added: string[];
}

/** The diff's hunks with their file; a deleted file's hunks are dropped (nothing it says can loosen a gate). */
function hunks(diff: string): Hunk[] {
  const out: Hunk[] = [];
  let file: string | null = null;
  let current: Hunk | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = null;
      current = null;
    } else if (line.startsWith("+++ ")) {
      const path = line.slice(4).trim();
      file = path === "/dev/null" ? null : path.replace(/^b\//, "");
    } else if (line.startsWith("@@")) {
      current = file ? { file, removed: [], added: [] } : null;
      if (current) out.push(current);
    } else if (current && line.startsWith("-") && !line.startsWith("--- ")) {
      current.removed.push(line.slice(1));
    } else if (current && line.startsWith("+")) {
      current.added.push(line.slice(1));
    }
  }
  return out;
}

/** A line as it is compared for a move: trimmed, without a list's trailing comma. */
function entry(line: string): string {
  return line.trim().replace(/,$/, "");
}

function cut(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > MAX_LINE ? `${trimmed.slice(0, MAX_LINE - 1)}…` : trimmed;
}

function value(n: string, unit: string | undefined): { v: number; dim: string } {
  const scale = unit ? SCALE[unit.toLowerCase()] : undefined;
  return scale ? { v: Number(n) * scale.factor, dim: scale.dim } : { v: Number(n), dim: "plain" };
}

/** The first number `after` raises over `before`, when the two lines differ only in their numbers. */
export function raisedNumber(before: string, after: string): { from: string; to: string } | null {
  const skeleton = (s: string) => s.replace(NUMBER, "#").replace(/\s+/g, " ").trim();
  if (skeleton(before) !== skeleton(after)) return null;
  const old = [...before.matchAll(NUMBER)];
  const now = [...after.matchAll(NUMBER)];
  for (let i = 0; i < Math.min(old.length, now.length); i++) {
    const a = value(old[i]![1]!, old[i]![2]);
    const b = value(now[i]![1]!, now[i]![2]);
    if (a.dim === b.dim && b.v > a.v) return { from: old[i]![0], to: now[i]![0] };
  }
  return null;
}

function isSkip(line: string): boolean {
  return !PLATFORM_SKIP.test(line) && SKIP_MARKERS.some((m) => m.test(line));
}

/** Every gate loosening in a unified diff (any context size; `--unified=0` pairs lines best). */
export function findLoosenings(diff: string): Loosening[] {
  const found: Loosening[] = [];
  for (const h of hunks(diff)) {
    const name = basename(h.file);
    const budget = BUDGET_FILE.test(name);
    const verifyConfig = VERIFY_CONFIG.test(name);
    // A line moved within the hunk is not new, nor one that only gained or lost a list's trailing comma.
    const removed = new Set(h.removed.map(entry));
    if (budget || verifyConfig) {
      h.added.forEach((after, i) => {
        const before = h.removed[i];
        if (before === undefined || (!budget && !GATE_WORD.test(after))) return;
        const raised = raisedNumber(before, after);
        if (raised) found.push({ file: h.file, kind: "raised", line: cut(after), ...raised });
      });
    }
    for (const added of h.added) {
      const trimmed = added.trim();
      if (trimmed.length === 0 || removed.has(entry(added))) continue;
      if (!PROSE_FILE.test(name) && isSkip(added)) found.push({ file: h.file, kind: "skip", line: cut(added) });
      else if (ALLOWLIST_FILE.test(name) && !/^(?:#|\/\/)/.test(trimmed)) found.push({ file: h.file, kind: "allowlist", line: cut(added) });
    }
  }
  return found;
}

/** One loosening as a line: "ui/budget.json: raised 233 → 234". */
export function looseningLine(l: Loosening): string {
  if (l.kind === "raised") return `${l.file}: raised ${l.from} → ${l.to}: ${l.line}`;
  if (l.kind === "skip") return `${l.file}: adds a test skip: ${l.line}`;
  return `${l.file}: widens the allowlist: ${l.line}`;
}
