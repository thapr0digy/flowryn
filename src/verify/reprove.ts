import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { openItem, resolveItem } from "../attention/items.ts";
import { tx, type Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import type { ProjectRow } from "../lifecycle/projects.ts";
import type { GitRunner } from "../policy/landed.ts";
import type { FlowrynConfig } from "../config/config.ts";
import { projectRelease, runRelease } from "../lifecycle/release.ts";
import { runBounded } from "../runtime/bounded.ts";
import { withRepoLock } from "../runtime/repo-lock.ts";
import { DEFAULT_VERIFY_TIMEOUT_MIN, REVIEW_STEP, verifyConfig, type VerifyConfig } from "./config.ts";
import { autoVerifyPath } from "./queue.ts";
import { initialSteps, stepEnv } from "./runner.ts";
import { confirmNamed, LAWS_FILE, LAWS_HEADING, notRecorded, parseEnforcers, parseLaws, planPath, provenCommits, ranNoTests, type CommandRunner, type Enforcer, type Law } from "./laws.ts";

/**
 * Laws re-proved on a schedule (docs/notes/2026-11-27-phase-corrections-become-jx.md). A law's row
 * says its enforcer fails at a commit and passes at HEAD; verify checks only the HEAD half, so a
 * test emptied or weakened later still passes and the law looks enforced. Once a week the upkeep
 * loop re-proves each project's laws at the head of its origin default branch, in a throwaway
 * checkout under the state dir: the enforcer must still be there and pass at HEAD, and, run
 * against its "Proven on" commit (that commit's tree with the enforcer's files from HEAD laid
 * over it), must still fail. A law that no longer does is reported as an item for the leader.
 * Commands are the laws step's own argument lists (planPath), run through runBounded by the
 * project's verify step deadline; no text from the table reaches a shell.
 *
 * The laws run where verify's laws step runs them: after the project's verify steps, run first
 * at HEAD in the checkout (its setup: a test database, built assets, installed packages), and
 * before its `release` commands (the teardown). When that setup fails, a law with a command to
 * run "could not run", with why; it is never reported as no longer proven.
 */

export const REPROVE_KIND = "laws.reproved";
export const REPROVE_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** proven: fails at its commit and passes at HEAD; holds: passes at HEAD, with nothing to run at a commit; unproven: reported; unrun: could not run, its environment not set up. */
export type ReproofState = "proven" | "holds" | "unproven" | "unrun";

export interface LawReproof {
  rule: string;
  state: ReproofState;
  detail: string;
}

export interface ProjectReproof {
  project: string;
  /** The head re-proved at, or null when skipped before reading it. */
  head: string | null;
  /** Why the project was not re-proved, or null. */
  skipped: string | null;
  laws: LawReproof[];
}

export interface ReproveDeps {
  git: GitRunner;
  run: CommandRunner;
  /** Each project's checkout goes at `<dir>/<project>`, removed when its re-prove ends. */
  dir: string;
  env: Record<string, string>;
  /** The project's verify steps, which `verify:` enforcers must name. */
  steps: readonly string[];
  /** The verify steps run at HEAD before the laws, as verify runs them (setupSteps). */
  setup: readonly string[];
  /** The project's `release` commands, run in the checkout after the laws. */
  teardown: readonly string[][];
  log(line: string): void;
  /** Each command's deadline. */
  timeoutMs: number;
  signal?: AbortSignal;
}

const COULD_NOT_RUN = "could not run: ";

type Runnable = { argv: string[]; what: string; overlay: string };

/** The files of HEAD a runnable path enforcer brings to an old commit: a Go package's test files, or the file. Call with the checkout at HEAD. */
function overlayOf(checkout: string, e: Extract<Enforcer, { kind: "path" }>): string {
  const path = normalize(e.path);
  return statSync(join(checkout, path)).isDirectory() ? `:(glob)${path}/*_test.go` : path;
}

/**
 * The verify steps a re-prove runs first, at HEAD: every configured step but the review (a model's
 * reading of a diff) and the steps with `when_changed`, which a verify of HEAD against itself skips.
 */
export function setupSteps(verify: Pick<VerifyConfig, "steps" | "when_changed"> | null): string[] {
  if (!verify) return [];
  return initialSteps(verify.steps, verify.when_changed ?? [])
    .filter((s) => s.name !== REVIEW_STEP && !s.when_changed?.length)
    .map((s) => s.name);
}

/** Make the checkout exactly `ref`, keeping ignored files (the setup's products); why not, or null. */
async function reset(deps: ReproveDeps, checkout: string, ref: string): Promise<string | null> {
  const out = await deps.git(["checkout", "--quiet", "--force", "--detach", ref], checkout);
  if (out.code !== 0) return `${ref.slice(0, 12)} cannot be checked out: ${(out.stderr || out.stdout).trim().split("\n")[0]}`;
  const cleaned = await deps.git(["clean", "-ffdq"], checkout);
  if (cleaned.code !== 0) return `the checkout cannot be cleaned at ${ref.slice(0, 12)}`;
  return null;
}

/** Run the setup steps at HEAD, each a verify step's shell command under the step deadline; why one failed, or null. */
async function setUp(deps: ReproveDeps, checkout: string): Promise<string | null> {
  for (const step of deps.setup) {
    if (deps.signal?.aborted) return "the re-prove was stopped";
    const out = await deps.run(["/bin/sh", "-c", step], { cwd: checkout, env: deps.env, timeoutMs: deps.timeoutMs, signal: deps.signal, label: `reprove setup ${step}` });
    if (out.code === 124 || out.code === 125) return `verify step ${step} timed out`;
    if (out.code !== 0) {
      const last = `${out.stdout}\n${out.stderr}`.trim().split("\n").at(-1);
      return `verify step ${step} failed (exit ${out.code})${last ? `: ${last}` : ""}`;
    }
  }
  return null;
}

/** One command's outcome: passed, failed with tests run, or why it proves nothing either way. */
async function runOne(deps: ReproveDeps, checkout: string, r: Runnable): Promise<{ result: "passed" | "failed" } | { result: "void"; why: string }> {
  const bin = Bun.which(r.argv[0]!, { PATH: deps.env.PATH ?? "" });
  if (!bin) return { result: "void", why: `${r.argv[0]} is not on the verify PATH` };
  const out = await deps.run([bin, ...r.argv.slice(1)], { cwd: checkout, env: deps.env, timeoutMs: deps.timeoutMs, signal: deps.signal, label: `reprove ${r.what}` });
  if (out.code === 124 || out.code === 125) return { result: "void", why: `${r.what} timed out` };
  if (ranNoTests(`${out.stdout}\n${out.stderr}`)) return { result: "void", why: `${r.what} ran no tests` };
  return { result: out.code === 0 ? "passed" : "failed" };
}

/** Re-prove one law in the checkout: at HEAD, then at each commit its row names. `unready`: why the setup failed, or null. */
async function reproveLaw(deps: ReproveDeps, checkout: string, head: string, law: Law, unready: string | null): Promise<LawReproof> {
  const unproven = (detail: string): LawReproof => ({ rule: law.rule, state: "unproven", detail });
  const parsed = parseEnforcers(law.enforced_by);
  if ("error" in parsed) return unproven(`Enforced by: ${parsed.error}`);
  if (parsed.enforcers.length === 0) return unproven("Enforced by names nothing that can be run or confirmed");
  const atHead = await reset(deps, checkout, head);
  if (atHead) return unproven(atHead);
  const runnable: Runnable[] = [];
  const confirmed: string[] = [];
  for (const e of parsed.enforcers) {
    if (e.kind !== "path") {
      const named = confirmNamed(e, deps.steps);
      if ("error" in named) return unproven(`at HEAD: ${named.error}`);
      confirmed.push(named.done);
      continue;
    }
    const plan = planPath(checkout, e);
    if ("error" in plan) return unproven(`at HEAD: ${plan.error}`);
    if ("confirmed" in plan) confirmed.push(plan.confirmed);
    else runnable.push({ ...plan, overlay: overlayOf(checkout, e) });
  }
  if (runnable.length > 0 && unready) return { rule: law.rule, state: "unrun", detail: `${COULD_NOT_RUN}${unready}` };
  for (const r of runnable) {
    const out = await runOne(deps, checkout, r);
    if (out.result !== "passed") return unproven(`at HEAD: ${out.result === "void" ? out.why : `${r.what} fails`}`);
  }
  const commits = notRecorded(law) ? [] : provenCommits(law.proven_on);
  if (runnable.length === 0) return { rule: law.rule, state: "holds", detail: `${confirmed.join("; ")} at HEAD; nothing runs to re-prove at a commit` };
  if (commits.length === 0) return { rule: law.rule, state: "holds", detail: "passes at HEAD; no commit recorded to re-prove it on" };
  for (const commit of commits) {
    const at = await reset(deps, checkout, commit);
    if (at) return unproven(at);
    const laid = await deps.git(["checkout", head, "--", ...runnable.map((r) => r.overlay)], checkout);
    if (laid.code !== 0) return unproven(`HEAD's enforcer files cannot be laid over ${commit}: ${(laid.stderr || laid.stdout).trim().split("\n")[0]}`);
    const outcomes = [];
    for (const r of runnable) outcomes.push({ r, out: await runOne(deps, checkout, r) });
    if (outcomes.some((o) => o.out.result === "failed")) continue;
    const blank = outcomes.find((o) => o.out.result === "void");
    return unproven(blank && blank.out.result === "void" ? `at ${commit}: ${blank.out.why}` : `${outcomes.map((o) => o.r.what).join(", ")} passes at ${commit}: it no longer fails where the mistake was`);
  }
  return { rule: law.rule, state: "proven", detail: `fails at ${commits.join(", ")}, passes at HEAD` };
}

/** A fresh detached checkout of `sha` at `checkout`; why not, or null. Under the repository's worktree lock. */
async function addCheckout(git: GitRunner, repo: string, checkout: string, sha: string): Promise<string | null> {
  if (existsSync(checkout)) await git(["worktree", "remove", "--force", checkout], repo);
  await git(["worktree", "prune"], repo);
  if (existsSync(checkout)) return `${checkout} is in the way and is not a checkout of ${repo}`;
  mkdirSync(dirname(checkout), { recursive: true });
  const added = await git(["worktree", "add", "--detach", checkout, sha], repo);
  return added.code === 0 ? null : `git worktree add failed: ${(added.stderr || added.stdout).trim()}`;
}

/** Re-prove a project's laws at the head of its origin default branch. Never throws on the project's content. */
export async function reproveProject(deps: ReproveDeps, project: ProjectRow): Promise<ProjectReproof> {
  const skip = (why: string, head: string | null = null): ProjectReproof => ({ project: project.id, head, skipped: why, laws: [] });
  const ref = `origin/${project.default_branch}`;
  const resolved = await deps.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], project.path);
  if (resolved.code !== 0) return skip(`${ref} cannot be read in ${project.path}`);
  const head = resolved.stdout.trim();
  const listed = await deps.git(["ls-tree", "--name-only", head, "--", LAWS_FILE], project.path);
  if (listed.code !== 0) return skip(`${ref} cannot be read in ${project.path}`, head);
  if (listed.stdout.trim() === "") return skip(`no ${LAWS_FILE}`, head);
  const shown = await deps.git(["show", `${head}:${LAWS_FILE}`], project.path);
  if (shown.code !== 0) return skip(`${LAWS_FILE} cannot be read at ${head.slice(0, 12)}`, head);
  const table = parseLaws(shown.stdout);
  if (table === null) return skip(`no ${LAWS_HEADING} table`, head);
  if ("error" in table) return { project: project.id, head, skipped: null, laws: [{ rule: LAWS_FILE, state: "unproven", detail: table.error }] };
  const checkout = join(deps.dir, project.id);
  const added = await withRepoLock(project.path, () => addCheckout(deps.git, project.path, checkout, head));
  if (added) return skip(added, head);
  try {
    const unready = await setUp(deps, checkout);
    const laws: LawReproof[] = [];
    for (const law of table.laws) {
      if (deps.signal?.aborted) break;
      laws.push(await reproveLaw(deps, checkout, head, law, unready));
    }
    return { project: project.id, head, skipped: null, laws };
  } finally {
    // Never throws: a failed release is logged, and the checkout goes regardless.
    await runRelease([...deps.teardown], { cwd: checkout, env: deps.env, label: `reprove ${project.id}`, log: deps.log });
    await withRepoLock(project.path, async () => {
      await deps.git(["worktree", "remove", "--force", checkout], project.path);
      await deps.git(["worktree", "prune"], project.path);
    });
  }
}

/**
 * The daemon's re-prove of one project: the checkout under `<state_dir>/reprove`, each command with
 * the project's verify PATH and the step deadline its verify uses (`verify_step_timeout_min`, else
 * its whole run's), its verify steps for `verify:` enforcers and as the setup, and its `release`
 * commands as the teardown.
 */
export function projectReprover(input: { config: FlowrynConfig; db: Db; git: GitRunner; log(line: string): void }): (project: ProjectRow, signal: AbortSignal) => Promise<ProjectReproof> {
  return async (project, signal) => {
    let verify: VerifyConfig | null;
    try {
      verify = verifyConfig(input.config, project.id);
    } catch (error) {
      return { project: project.id, head: null, skipped: `its verify config cannot be read: ${(error as Error).message}`, laws: [] };
    }
    return reproveProject(
      {
        git: input.git,
        run: (argv, opts) => runBounded(argv, opts),
        dir: join(input.config.state_dir, "reprove"),
        env: stepEnv(process.env, autoVerifyPath(input.db, project.id)),
        steps: verify ? initialSteps(verify.steps).map((s) => s.name) : [],
        setup: setupSteps(verify),
        teardown: projectRelease(input.config, project.id, input.log),
        log: input.log,
        timeoutMs: verify?.step_timeout_ms ?? verify?.timeout_ms ?? DEFAULT_VERIFY_TIMEOUT_MIN * 60_000,
        signal,
      },
      project,
    );
  };
}

/**
 * When each project's laws were last re-proved: its newest `laws.reproved` event. An event holds one
 * project's result; one from before results were recorded per project lists them all under `projects`.
 */
export function lastReproved(db: Db): Map<string, number> {
  const rows = db.query("SELECT ts, payload FROM events WHERE kind = ?1 ORDER BY seq").all(REPROVE_KIND) as { ts: number; payload: string }[];
  const last = new Map<string, number>();
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as { project?: unknown; projects?: { project?: unknown }[] };
    const named = typeof payload.project === "string" ? [payload.project] : Array.isArray(payload.projects) ? payload.projects.map((r) => r?.project) : [];
    for (const project of named) if (typeof project === "string") last.set(project, row.ts);
  }
  return last;
}

/** Whether a project's last re-prove is a week old or it has none. */
export function reproveDue(last: ReadonlyMap<string, number>, project: string, now: number): boolean {
  const at = last.get(project);
  return at === undefined || at + REPROVE_WINDOW_MS <= now;
}

/** When the next re-prove is due: a week after the oldest of these projects' last re-proves, now when one has none, or a week from now with no projects. */
export function reproveDueAt(db: Db, projects: readonly string[], now: number): number {
  const last = lastReproved(db);
  let due = now + REPROVE_WINDOW_MS;
  for (const project of projects) due = Math.min(due, (last.get(project) ?? now - REPROVE_WINDOW_MS) + REPROVE_WINDOW_MS);
  return due;
}

/** How a project's unproven-laws item starts, so its next re-prove can find it. */
function unprovenPrefix(project: string): string {
  return `Laws no longer proven in ${project} (`;
}

/** The item's words for a project's unproven laws. */
export function unprovenLine(r: ProjectReproof): string | null {
  const bad = r.laws.filter((l) => l.state === "unproven");
  if (bad.length === 0) return null;
  return `${unprovenPrefix(r.project)}${bad.length} of ${r.laws.length}, re-proved at ${r.head?.slice(0, 8) ?? "?"}): ${bad.map((l) => `${l.rule}: ${l.detail}`).join("; ")}; flowryn laws ${r.project}`;
}

/** How a project's could-not-run item starts, so its next re-prove can find it. */
function unrunPrefix(project: string): string {
  return `Laws could not be re-proved in ${project} (`;
}

/** The item's words for a project whose setup failed: how many laws could not run, and why. */
export function unrunLine(r: ProjectReproof): string | null {
  const unrun = r.laws.filter((l) => l.state === "unrun");
  if (unrun.length === 0) return null;
  return `${unrunPrefix(r.project)}${unrun.length} of ${r.laws.length}, at ${r.head?.slice(0, 8) ?? "?"}): ${unrun[0]!.detail.slice(COULD_NOT_RUN.length)}; flowryn laws ${r.project}`;
}

/** Resolve a project's open laws items that start with `prefix`: its newest re-prove replaces them. */
function resolveLawsItems(db: Db, prefix: string, now: number): void {
  const open = db
    .query("SELECT id FROM items WHERE kind = 'laws_unproven' AND state IN ('open','presented') AND substr(line, 1, length(?1)) = ?1")
    .all(prefix) as { id: string }[];
  for (const { id } of open) resolveItem(db, id, "laws re-proved again", now);
}

/**
 * Record one project's re-prove as it finishes: its event, and its laws item replaced. When its setup
 * failed, nothing ran, so its unproven-laws item stays and its could-not-run item is replaced; otherwise
 * both are resolved and an unproven-laws item opens when a law is no longer proven. Returns the item opened, or null.
 */
export function recordReproof(db: Db, result: ProjectReproof, now: number): string | null {
  return tx(db, () => {
    const event = appendEvent(db, { source: "daemon", kind: REPROVE_KIND, payload: result, ts: now });
    if (result.skipped !== null) return null;
    resolveLawsItems(db, unrunPrefix(result.project), now);
    const unrun = unrunLine(result);
    if (unrun) return openItem(db, { kind: "laws_unproven", eventSeq: event.seq, line: unrun, now });
    resolveLawsItems(db, unprovenPrefix(result.project), now);
    const line = unprovenLine(result);
    return line ? openItem(db, { kind: "laws_unproven", eventSeq: event.seq, line, now }) : null;
  });
}
