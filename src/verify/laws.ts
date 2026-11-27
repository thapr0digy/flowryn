import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import { BUILT_IN_LAWS, BUILT_IN_PROOF } from "../policy/global-laws.ts";
import type { GitRunner } from "../policy/landed.ts";
import { TOOLKIT_RULES } from "../policy/toolkit.ts";
import type { BoundedResult } from "../runtime/bounded.ts";
import { mergeBaseOf } from "./changed.ts";
import { normalizeStep } from "./policy.ts";

/**
 * A project's laws (docs/notes/2026-11-27-phase-the-laws-ib.md): the `## Rules and their checks`
 * table of its AGENTS.md, read by code. Each row names a rule, what enforces it and the commit
 * its enforcer fails at. The verify step `flowryn:laws` (src/verify/runner.ts) refuses a head
 * whose table has a row with no enforcer, an enforcer that is not there, a test enforcer that
 * fails, or a row added without its commit. Commands are built here from checked paths and
 * names, as argument lists: no text from the table ever reaches a shell.
 *
 * Global laws (docs/notes/2026-11-27-phase-global-laws-iq.md) hold for every project: Flowryn's
 * built-in rows (src/policy/global-laws.ts) and the user's own in `<home>/laws.md`. Each names a
 * hook rule or a verify step, and every project's laws step checks them before its own.
 */

export const LAWS_FILE = "AGENTS.md";
export const LAWS_HEADING = "## Rules and their checks";
/** What "Proven on" says for a row recorded before laws were checked: allowed only on a row the base already had. */
export const NOT_RECORDED = "-";

export interface Law {
  rule: string;
  enforced_by: string;
  proven_on: string;
  /** 1-based line in the file. */
  line: number;
}

/** No heading: the project has no laws. A heading whose table cannot be read is an error. */
export type LawsTable = { laws: Law[] } | { error: string } | null;

/** One enforcer of a row: a file or directory in the repository (with names it must hold), one of the project's verify steps, or a hook rule. */
export type Enforcer = { kind: "path"; path: string; names: string[] } | { kind: "verify"; step: string } | { kind: "hook"; rule: string };

export interface LawResult {
  rule: string;
  state: "passed" | "failed";
  /** What was run or confirmed, or why it failed. */
  detail: string;
  /** A global law's result, not the project's. */
  global?: true;
}

/** Split a table row on its unescaped pipes outside code spans. */
export function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  let code = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "\\" && body[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (ch === "`") {
      code = !code;
      cell += ch;
    } else if (ch === "|" && !code) {
      cells.push(cell.trim());
      cell = "";
    } else cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

const COLUMNS = ["rule", "enforced by", "proven on"] as const;

/** The laws table of an AGENTS.md text: null when it has no laws heading. */
export function parseLaws(text: string): LawsTable {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.trim() === LAWS_HEADING);
  if (at === -1) return null;
  let i = at + 1;
  while (i < lines.length && !lines[i]!.trim().startsWith("|")) {
    if (/^#{1,2} /.test(lines[i]!)) return { error: `${LAWS_HEADING} (line ${at + 1}) has no table before the next heading` };
    i++;
  }
  if (i >= lines.length) return { error: `${LAWS_HEADING} (line ${at + 1}) has no table` };
  const header = splitRow(lines[i]!).map((cell) => cell.toLowerCase());
  const index = COLUMNS.map((name) => header.indexOf(name));
  if (index.some((n) => n === -1)) return { error: `the table under ${LAWS_HEADING} (line ${i + 1}) needs the columns Rule | Enforced by | Proven on` };
  if (!/^\|?\s*:?-{3,}/.test(lines[i + 1]?.trim() ?? "")) return { error: `the table under ${LAWS_HEADING} (line ${i + 1}) has no |---| line under its header` };
  const laws: Law[] = [];
  for (let n = i + 2; n < lines.length && lines[n]!.trim().startsWith("|"); n++) {
    const cells = splitRow(lines[n]!);
    const [rule, enforced_by, proven_on] = index.map((k) => cells[k] ?? "");
    laws.push({ rule: rule!, enforced_by: enforced_by!, proven_on: proven_on!, line: n + 1 });
  }
  return { laws };
}

/** A rule's identity across commits: its words, whitespace collapsed. */
export function ruleKey(rule: string): string {
  return rule.replace(/\s+/g, " ").trim();
}

const PATH = /^[\w@.+-]+(?:\/[\w@.+-]+)*\/?$/;
const EXTENSION = /\.[A-Za-z0-9]+$/;

/**
 * The enforcers a row's "Enforced by" names. Parts are separated by `;`. In a part, a path is a
 * code span shaped like one (`internal/sqlcheck`, `AGENTS.md`) or a bare word with a `/` and a file
 * extension (test/unit/db.test.ts); every code span after a path in its part names something that
 * file must hold (a test, a lint rule, a doc's words); `verify: <step>` names one of the project's verify steps;
 * `hook: <rule>` names a rule the tool-call hook refuses with (src/policy/toolkit.ts). Other
 * words are prose. A code span that fits none of these is an error, so a law never looks
 * enforced by text nothing reads.
 */
export function parseEnforcers(cell: string): { enforcers: Enforcer[] } | { error: string } {
  const enforcers: Enforcer[] = [];
  for (const part of cell.split(";")) {
    let current: Extract<Enforcer, { kind: "path" }> | null = null;
    for (const match of part.matchAll(/`([^`]+)`|(\S+)/g)) {
      const code = match[1]?.trim();
      if (code !== undefined) {
        const step = /^verify:\s*(.+)$/.exec(code);
        const hook = /^hook:\s*(.+)$/.exec(code);
        if (step) {
          enforcers.push({ kind: "verify", step: step[1]!.trim() });
          current = null;
        } else if (hook) {
          enforcers.push({ kind: "hook", rule: hook[1]!.trim() });
          current = null;
        } else if (current === null && PATH.test(code) && (code.includes("/") || EXTENSION.test(code))) {
          current = { kind: "path", path: code.replace(/\/$/, ""), names: [] };
          enforcers.push(current);
        } else if (current !== null) current.names.push(code);
        else return { error: `\`${code}\` is not a path, a name in the path before it, verify: <step> or hook: <rule>` };
        continue;
      }
      const word = match[2]!.replace(/^[("']+/, "").replace(/[)"',.:;]+$/, "");
      if (word.includes("/") && EXTENSION.test(word) && PATH.test(word)) {
        current = { kind: "path", path: word, names: [] };
        enforcers.push(current);
      }
    }
  }
  return { enforcers };
}

const COMMIT = /\b[0-9a-f]{7,40}(?:\^+|~\d+)?(?![\w^~])/g;

/** The commits a "Proven on" cell names (sha prefixes, with an optional ^ or ~N). */
export function provenCommits(cell: string): string[] {
  return [...cell.replace(/`/g, " ").matchAll(COMMIT)].map((m) => m[0]);
}

/** A row recorded before laws were checked: its "Proven on" is "-" or empty. */
export function notRecorded(law: Pick<Law, "proven_on">): boolean {
  const cell = law.proven_on.trim();
  return cell === "" || cell === NOT_RECORDED;
}

export type CommandRunner = (argv: string[], opts: { cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal; label: string }) => Promise<Pick<BoundedResult, "code" | "stdout" | "stderr">>;

export interface LawsDeps {
  git: GitRunner;
  run: CommandRunner;
  /** The checkout under verify. */
  worktree: string;
  /** The PR's base branch; null: origin's default. */
  base: string | null;
  /** The project's verify steps, which `verify:` enforcers must name. */
  steps: readonly string[];
  /** The global laws, checked before the project's; absent: none. */
  global?: GlobalLaws;
  env: Record<string, string>;
  /** Epoch ms by which every enforcer must be done. */
  deadline: number;
  now(): number;
  signal?: AbortSignal;
}

export interface LawsOutcome {
  /** Why nothing was checked (no table), or null. */
  note: string | null;
  laws: LawResult[];
  /** A table-level failure (unreadable table), or null. */
  error: string | null;
  /** The step's log. */
  log: string;
  /** Whether the signal stopped the check before every law was checked: never a pass. */
  aborted: boolean;
}

/** A repository-relative path, resolved inside the worktree (no symlink out); why not, when it is not there. */
function resolveIn(worktree: string, path: string): { full: string } | { error: string } {
  if (isAbsolute(path) || normalize(path).split("/").includes("..")) return { error: `${path} is not a path inside the repository` };
  const full = join(worktree, normalize(path));
  if (!existsSync(full)) return { error: `${path} does not exist` };
  try {
    const root = realpathSync(worktree);
    const real = realpathSync(full);
    if (real !== root && !real.startsWith(root + sep)) return { error: `${path} leads outside the repository` };
  } catch (error) {
    return { error: `${path} cannot be read: ${(error as Error).message}` };
  }
  return { full };
}

const BUN_TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** The Go test files of a directory. */
function goTests(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith("_test.go"));
  } catch {
    return [];
  }
}

/** How one path enforcer is checked: a command to run, or confirmed by reading; why not, when it fails before running. */
function planPath(worktree: string, e: Extract<Enforcer, { kind: "path" }>): { argv: string[]; what: string } | { confirmed: string } | { error: string } {
  const at = resolveIn(worktree, e.path);
  if ("error" in at) return at;
  const isDir = statSync(at.full).isDirectory();
  const goDir = isDir ? at.full : e.path.endsWith("_test.go") ? join(at.full, "..") : null;
  const goFiles = goDir ? goTests(goDir) : [];
  const texts = isDir ? goFiles.map((f) => readFileSync(join(at.full, f), "utf8")) : [readFileSync(at.full, "utf8")];
  for (const name of e.names) {
    const found = goFiles.length > 0 ? texts.some((t) => t.includes(`func ${name}(`)) : texts.some((t) => t.includes(name));
    if (!found) return { error: `${e.path} has no ${goFiles.length > 0 ? `test func ${name}` : name}` };
  }
  if (goFiles.length > 0 && goDir) {
    const pkg = `./${normalize(isDir ? e.path : join(e.path, ".."))}`;
    const run = e.names.length > 0 ? ["-run", `^(${e.names.join("|")})$`] : [];
    return { argv: ["go", "test", "-count=1", ...run, pkg], what: `go test ${pkg}${e.names.length > 0 ? ` -run ${e.names.join(",")}` : ""}` };
  }
  if (!isDir && BUN_TEST.test(e.path)) return { argv: ["bun", "test", `./${normalize(e.path)}`], what: `bun test ${e.path}` };
  return { confirmed: `${e.path} is there${e.names.length > 0 ? ` and names ${e.names.join(", ")}` : ""}` };
}

function tail(text: string, lines = 30): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

/** A `hook:` or `verify:` enforcer: confirmed when the rule or step exists; why not, when it does not. */
function confirmNamed(e: Exclude<Enforcer, { kind: "path" }>, steps: readonly string[]): { done: string } | { error: string } {
  if (e.kind === "hook") return (TOOLKIT_RULES as readonly string[]).includes(e.rule) ? { done: `hook rule ${e.rule}` } : { error: `hook: ${e.rule} is not a rule of Flowryn's tool-call hook (${TOOLKIT_RULES.join(", ")})` };
  return new Set(steps.map(normalizeStep)).has(normalizeStep(e.step)) ? { done: `verify step ${e.step}` } : { error: `verify: ${e.step} is not one of the project's verify steps` };
}

/** Check one row: its enforcers, then its commit. */
async function checkLaw(deps: LawsDeps, law: Law, known: Set<string> | null, log: string[]): Promise<LawResult> {
  const fail = (detail: string): LawResult => ({ rule: law.rule, state: "failed", detail });
  const parsed = parseEnforcers(law.enforced_by);
  if ("error" in parsed) return fail(`Enforced by: ${parsed.error}`);
  if (parsed.enforcers.length === 0) return fail("Enforced by names nothing verify can run or confirm: a test file, a file holding the rule (`path` `name`), or `verify: <step>`");
  if (notRecorded(law)) {
    if (known === null) return fail("Proven on is not recorded and the base's table cannot be read, so this row cannot be told apart from a new one");
    if (!known.has(ruleKey(law.rule))) return fail("a new law needs Proven on: the commit its enforcer fails at");
  } else {
    const commits = provenCommits(law.proven_on);
    if (commits.length === 0) return fail("Proven on names no commit: write the commit the enforcer fails at, such as `fails at 2f31e53`");
    for (const commit of commits) {
      const found = await deps.git(["rev-parse", "--verify", "--quiet", `${commit}^{commit}`], deps.worktree);
      if (found.code !== 0) return fail(`Proven on names ${commit}, which is not a commit of this repository`);
    }
  }
  const done: string[] = [];
  for (const e of parsed.enforcers) {
    if (e.kind !== "path") {
      const named = confirmNamed(e, deps.steps);
      if ("error" in named) return fail(named.error);
      done.push(named.done);
      continue;
    }
    const plan = planPath(deps.worktree, e);
    if ("error" in plan) return fail(plan.error);
    if ("confirmed" in plan) {
      done.push(plan.confirmed);
      continue;
    }
    const left = deps.deadline - deps.now();
    if (left <= 0) return fail(`no time left to run ${plan.what}`);
    const bin = Bun.which(plan.argv[0]!, { PATH: deps.env.PATH ?? "" });
    if (!bin) return fail(`${plan.argv[0]} is not on the verify PATH, so ${plan.what} cannot run`);
    const out = await deps.run([bin, ...plan.argv.slice(1)], { cwd: deps.worktree, env: deps.env, timeoutMs: left, signal: deps.signal, label: `laws ${plan.what}` });
    if (out.code !== 0) {
      log.push(`--- ${plan.what} exited ${out.code}`, tail(`${out.stdout}\n${out.stderr}`));
      return fail(out.code === 124 ? `${plan.what} timed out` : `${plan.what} exited ${out.code}`);
    }
    done.push(`${plan.what} passed`);
  }
  return { rule: law.rule, state: "passed", detail: done.join("; ") };
}

/** The rules of the base's table, or null when the base cannot be read. A base with no file or no table has none. */
async function baseRules(deps: Pick<LawsDeps, "git" | "worktree" | "base">): Promise<Set<string> | null> {
  const base = await mergeBaseOf(deps.git, deps.worktree, deps.base);
  if ("error" in base) return null;
  const listed = await deps.git(["ls-tree", "--name-only", base.sha, "--", LAWS_FILE], deps.worktree);
  if (listed.code !== 0) return null;
  if (listed.stdout.trim() === "") return new Set();
  const shown = await deps.git(["show", `${base.sha}:${LAWS_FILE}`], deps.worktree);
  if (shown.code !== 0) return null;
  const table = parseLaws(shown.stdout);
  return new Set(table && "laws" in table ? table.laws.map((l) => ruleKey(l.rule)) : []);
}

/** The global laws: Flowryn's built-in rows, then the rows of the user's file. */
export interface GlobalLaws {
  /** `<home>/laws.md`. */
  file: string;
  /** Each with `file` set to where it is written. */
  laws: (Law & { file: string })[];
  /** The user's file has a heading whose table cannot be read. */
  error: string | null;
}

export const BUILT_IN = "built in";

/** The global laws of a Flowryn home: the built-in rows, and the user's `laws.md` when it has the laws table. */
export function readGlobalLaws(file: string): GlobalLaws {
  const builtIn = BUILT_IN_LAWS.map((l) => ({ rule: l.rule, enforced_by: `\`hook: ${l.hook}\``, proven_on: BUILT_IN_PROOF, line: 0, file: BUILT_IN }));
  let table: LawsTable = null;
  try {
    table = existsSync(file) ? parseLaws(readFileSync(file, "utf8")) : null;
  } catch (error) {
    table = { error: `cannot be read: ${(error as Error).message}` };
  }
  if (table !== null && "error" in table) return { file, laws: builtIn, error: `${file}: ${table.error}` };
  return { file, laws: [...builtIn, ...(table?.laws ?? []).map((l) => ({ ...l, file }))], error: null };
}

/**
 * Check one global row. It names hook rules or verify steps only: a file belongs to one project's
 * table. Its "Proven on" is shown, never checked: the proof is in Flowryn's tests or another repository.
 */
function checkGlobalLaw(law: Law, steps: readonly string[]): LawResult {
  const fail = (detail: string): LawResult => ({ rule: law.rule, state: "failed", detail, global: true });
  const parsed = parseEnforcers(law.enforced_by);
  if ("error" in parsed) return fail(`Enforced by: ${parsed.error}`);
  if (parsed.enforcers.length === 0) return fail("Enforced by names nothing: a global law names `hook: <rule>` or `verify: <step>`");
  const done: string[] = [];
  for (const e of parsed.enforcers) {
    if (e.kind === "path") return fail(`${e.path}: a global law names \`hook: <rule>\` or \`verify: <step>\`; a file belongs in one project's ${LAWS_FILE} table`);
    const named = confirmNamed(e, steps);
    if ("error" in named) return fail(named.error);
    done.push(named.done);
  }
  return { rule: law.rule, state: "passed", detail: done.join("; "), global: true };
}

/** Check the global laws, then every law of the worktree's AGENTS.md. Never throws on a project's content: what is wrong is a failed law. */
export async function checkLaws(deps: LawsDeps): Promise<LawsOutcome> {
  const log: string[] = [];
  const laws: LawResult[] = [];
  const global = deps.global;
  if (global?.error) {
    laws.push({ rule: global.file, state: "failed", detail: global.error, global: true });
    log.push(`FAIL ${global.error}`);
  }
  for (const law of global?.laws ?? []) {
    const result = checkGlobalLaw(law, deps.steps);
    laws.push(result);
    log.push(`${result.state === "passed" ? "ok  " : "FAIL"} global ${law.file === BUILT_IN ? BUILT_IN : `${law.file}:${law.line}`} ${law.rule}`, `     ${result.detail}`);
  }
  const path = join(deps.worktree, LAWS_FILE);
  const table = existsSync(path) ? parseLaws(readFileSync(path, "utf8")) : null;
  if (table === null) {
    const note = `no laws: ${LAWS_FILE} has no ${LAWS_HEADING} table`;
    return { note, laws, error: null, log: `${[...log, note].join("\n")}\n`, aborted: false };
  }
  if ("error" in table) return { note: null, laws, error: table.error, log: `${[...log, `FAIL ${table.error}`].join("\n")}\n`, aborted: false };
  const base = table.laws.some(notRecorded) ? await baseRules(deps) : new Set<string>();
  const globals = laws.length;
  for (const law of table.laws) {
    if (deps.signal?.aborted) break;
    const result = await checkLaw(deps, law, base, log);
    laws.push(result);
    log.push(`${result.state === "passed" ? "ok  " : "FAIL"} ${LAWS_FILE}:${law.line} ${law.rule}`, `     ${result.detail}`);
  }
  const failed = laws.filter((l) => l.state === "failed").length;
  const aborted = deps.signal?.aborted === true;
  log.push(`${laws.length - failed} of ${globals + table.laws.length} laws hold${failed > 0 ? `; ${failed} failed` : ""}${aborted ? "; the check was stopped" : ""}`);
  return { note: null, laws, error: null, log: `${log.join("\n")}\n`, aborted };
}

/** One line for the step's detail. */
export function lawsSummary(outcome: LawsOutcome): string | null {
  const failed = outcome.laws.filter((l) => l.state === "failed");
  const first = failed[0];
  const firstFailed = first ? `${failed.length} of ${outcome.laws.length} laws failed; first: ${first.global ? "global: " : ""}${first.rule.slice(0, 120)}: ${first.detail}` : null;
  if (outcome.note) return [firstFailed ?? (outcome.laws.length > 0 ? `${outcome.laws.length} global law${outcome.laws.length === 1 ? " holds" : "s hold"}` : null), outcome.note].filter((p) => p !== null).join("; ");
  if (outcome.error) return `laws: ${outcome.error}`;
  if (outcome.aborted) return `laws: stopped after ${outcome.laws.length} law${outcome.laws.length === 1 ? "" : "s"} checked`;
  return firstFailed ?? `${outcome.laws.length} law${outcome.laws.length === 1 ? " holds" : "s hold"}`;
}
