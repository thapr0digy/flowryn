import { decode as decodeToon } from "@toon-format/toon";
import type { GitRunner } from "./landed.ts";
import { runCommand } from "./command.ts";

/**
 * The no-mistakes side of cleanup and the read-only status watcher (design
 * section 14, "no-mistakes run ownership"): flowrynd only reads status, and
 * the one thing cleanup may do is abort the task's own run parked at a gate,
 * before the worker that would answer it is removed, and only when the run is
 * proven its own: the worktree's branch, a head that is the worktree's HEAD or
 * a descendant of it (pipeline fix rounds), no outcome, and a parked status.
 * Another branch's run, or one still executing, is never touched. The abort is
 * confirmed by re-reading that exact run: a terminal outcome, or the CLI's
 * exact "not found", confirms it; anything else refuses the cleanup. Ported
 * from the previous orchestrator's conclude_task_no_mistakes_run (bin/fm-teardown.sh,
 * a09090d1) without its runs-ledger fallback: a head this copy cannot resolve
 * is never aborted.
 */

export interface NmRun {
  id: string;
  branch: string;
  status: string;
  head: string;
  outcome: string;
  pr: string;
  awaiting: boolean;
  gate: boolean;
  /** The steps running now (`active_steps`); null when the status has no such table (an older no-mistakes). */
  activeSteps: NmActiveStep[] | null;
}

/**
 * One row of `active_steps`: the step, how long it has run (no-mistakes' own
 * "2h17m"), its last activity ("9m24s ago: log: ...", empty before the first),
 * and its local agent's pid, if any.
 */
export interface NmActiveStep {
  step: string;
  status: string;
  activeFor: string;
  lastActivity: string;
  agentPid: string;
}

function stripQuotes(value: string): string {
  const v = value.trim();
  return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
}

function field(text: string, name: string): string {
  const match = new RegExp(`^\\s*${name}:[ \\t]*(.*)$`, "m").exec(text);
  return match ? stripQuotes(match[1]!) : "";
}

function cell(row: Record<string, unknown>, name: string): string {
  return row[name] === undefined || row[name] === null ? "" : String(row[name]);
}

/**
 * The `active_steps` table of `run`, read with the TOON decoder by column
 * name, so a column a later no-mistakes adds or moves still reads. Null when
 * the status does not decode or has no such table: the caller then knows
 * nothing about what runs locally.
 */
export function parseActiveSteps(text: string): NmActiveStep[] | null {
  let doc: unknown;
  try {
    doc = decodeToon(text);
  } catch {
    return null;
  }
  const rows = (doc as { run?: { active_steps?: unknown } } | null)?.run?.active_steps;
  if (!Array.isArray(rows)) return null;
  if (!rows.every((r) => r !== null && typeof r === "object" && typeof (r as Record<string, unknown>).step === "string")) return null;
  return (rows as Record<string, unknown>[]).map((r) => ({ step: cell(r, "step"), status: cell(r, "status"), activeFor: cell(r, "active_for"), lastActivity: cell(r, "last_activity"), agentPid: cell(r, "agent_pid") }));
}

/** Parse `no-mistakes axi status` TOON; null when it names no run. */
export function parseNmStatus(text: string): NmRun | null {
  const id = field(text, "id");
  if (!id) return null;
  return {
    id,
    branch: field(text, "branch"),
    status: field(text, "status"),
    head: field(text, "head"),
    outcome: field(text, "outcome"),
    pr: field(text, "pr"),
    awaiting: /^\s*awaiting_agent:/m.test(text),
    gate: /^\s*gate:/m.test(text),
    activeSteps: parseActiveSteps(text),
  };
}

/**
 * The run only waits on external CI: it is active, and every step running
 * now is `ci` with no local agent process (no `agent_pid`), so nothing on
 * this machine is working for it. A status without the table never counts.
 */
export function waitsOnlyOnCi(run: Pick<NmRun, "outcome" | "activeSteps">): boolean {
  const steps = run.activeSteps;
  return run.outcome === "" && steps !== null && steps.length > 0 && steps.every((s) => s.step === "ci" && s.agentPid === "");
}

/** "2h17m", "9m24s", "35s" (no-mistakes' own durations) in seconds; unreadable reads as 0. */
export function durationSeconds(text: string): number {
  let total = 0;
  for (const [, n, unit] of text.matchAll(/(\d+)\s*(h|m(?!s)|s)/g)) total += Number(n) * (unit === "h" ? 3600 : unit === "m" ? 60 : 1);
  return total;
}

/** The step that has run longest: the one a stalled pipeline is stuck in. */
export function oldestStep(steps: readonly NmActiveStep[]): NmActiveStep | null {
  if (steps.length === 0) return null;
  return steps.reduce((a, b) => (durationSeconds(b.activeFor) > durationSeconds(a.activeFor) ? b : a));
}

const ACTIVITY_AGE = /^((?:\d+(?:ms|h|m|s))+)\s+ago\b/;

/**
 * How long a step has shown no activity, in seconds: its last activity's age
 * ("9m24s ago: ..."), or its whole run when it has none yet. Null when
 * neither reads (a shape this copy does not know): the caller then judges
 * nothing rather than raise a false alarm.
 */
export function quietSeconds(step: Pick<NmActiveStep, "activeFor" | "lastActivity">): number | null {
  const last = step.lastActivity.trim();
  if (last === "") return step.activeFor.trim() === "" ? null : durationSeconds(step.activeFor);
  const age = ACTIVITY_AGE.exec(last);
  return age ? durationSeconds(age[1]!) : null;
}

const NOT_PARKED = new Set(["completed", "failed", "cancelled", "passed", "checks-passed", "running", "fixing", "ci"]);
const TERMINAL_OUTCOMES = new Set(["cancelled", "failed", "passed", "checks-passed"]);
/** Statuses of a run that is still going (executing or parked). */
export const ACTIVE_STATUSES = new Set(["pending", "running", "fixing", "ci", "awaiting_approval", "fix_review"]);

/** The run is active: no outcome yet, and a live status (or a parked gate). */
export function isActive(run: NmRun): boolean {
  return run.outcome === "" && (ACTIVE_STATUSES.has(run.status) || run.awaiting || run.gate);
}

/** Does the run's head bind to the worktree: equal, or a descendant of the worktree's HEAD, in this copy's objects? */
async function headMatches(git: GitRunner, worktree: string, runHead: string): Promise<boolean> {
  if (!runHead) return false;
  const local = await git(["rev-parse", "HEAD"], worktree);
  const run = await git(["rev-parse", "--verify", "--quiet", `${runHead}^{commit}`], worktree);
  if (local.code !== 0 || run.code !== 0 || !run.stdout.trim()) return false;
  if (run.stdout.trim() === local.stdout.trim()) return true;
  return (await git(["merge-base", "--is-ancestor", local.stdout.trim(), run.stdout.trim()], worktree)).code === 0;
}

/** Is this status the worktree's own run, parked at a gate? */
export async function ownParkedRun(git: GitRunner, worktree: string, run: NmRun | null): Promise<boolean> {
  if (!run || run.outcome !== "" || !run.status || NOT_PARKED.has(run.status)) return false;
  const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], worktree);
  if (branch.code !== 0 || branch.stdout.trim() !== run.branch) return false;
  if (!(await headMatches(git, worktree, run.head))) return false;
  return run.status === "awaiting_approval" || run.status === "fix_review" || run.awaiting || run.gate;
}

export interface NmDeps {
  noMistakes: string | null;
  git: GitRunner;
  timeoutMs: number;
  log(line: string): void;
}

export type ConcludeResult = { ok: true; aborted: string | null } | { ok: false; aborted: string; detail: string };

/** Read the worktree's run; a failing query reads as no run (a no-mistakes outage must not block every ship's cleanup). */
export async function readNmStatus(noMistakes: string, worktree: string, timeoutMs: number, runId?: string): Promise<{ code: number; text: string }> {
  const result = await runCommand([noMistakes, "axi", "status", ...(runId ? ["--run", runId] : [])], { cwd: worktree, timeoutMs });
  return { code: result.code, text: result.code === 0 ? result.stdout : `${result.stdout}${result.stderr}` };
}

/** Abort the worktree's own parked run, and confirm it stopped. */
export async function concludeParkedRun(deps: NmDeps, worktree: string): Promise<ConcludeResult> {
  if (!deps.noMistakes) return { ok: true, aborted: null };
  const status = await readNmStatus(deps.noMistakes, worktree, deps.timeoutMs);
  if (status.code !== 0) return { ok: true, aborted: null };
  const run = parseNmStatus(status.text);
  if (!(await ownParkedRun(deps.git, worktree, run))) return { ok: true, aborted: null };
  const id = run!.id;
  deps.log(`no-mistakes run ${id} for this worktree is parked at a gate; aborting before the worker is removed`);
  await runCommand([deps.noMistakes, "axi", "abort", "--run", id], { cwd: worktree, timeoutMs: deps.timeoutMs });
  const after = await readNmStatus(deps.noMistakes, worktree, deps.timeoutMs, id);
  if (after.code === 0) {
    const read = parseNmStatus(after.text);
    if (read && read.id === id && TERMINAL_OUTCOMES.has(read.outcome)) return { ok: true, aborted: id };
  } else if (after.text.trim() === `error: "run \\"${id}\\" not found"`) {
    return { ok: true, aborted: id };
  }
  return { ok: false, aborted: id, detail: `no-mistakes run ${id} is still parked after axi abort; confirm it stopped (no-mistakes axi status) or abort it (no-mistakes axi abort --run ${id})` };
}
