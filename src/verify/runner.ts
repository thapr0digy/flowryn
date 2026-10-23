import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, chmodSync, closeSync, constants as fsConstants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, rmSync, statSync, symlinkSync } from "node:fs";
import { constants } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import type { Db } from "../db/db.ts";
import { tx } from "../db/db.ts";
import type { GitRunner } from "../policy/landed.ts";
import { runBounded } from "../runtime/bounded.ts";
import { readIdentity, terminate, type ProcIdentity, type PsRunner, type TerminateOptions, type TerminateResult } from "../runtime/proc.ts";
import { leaseProcesses, liveJobLeases, recordJobProcess, releaseJobLeases, type JobRef } from "../sched/pools.ts";
import { appendEvent } from "../db/events.ts";
import type { VerifyItem } from "./config.ts";
import { deadlineLine, duration, stepDeadlines, type StepDeadline } from "./deadline.ts";
import { insertRequest, RECOVERED_RANK, requestOf, requeuedFrom } from "./queue.ts";
import { finishVerification, getVerification, recordSteps, runningVerifications, type Verification, type VerificationOutcome, type VerifyStep } from "./store.ts";
import { parseBunSummary, type TestCounts } from "./summary.ts";

/**
 * One `flowryn verify` job, run by the daemon (outside every sandbox): make
 * sure the PR head is in the project's object store, add a detached worktree
 * at it, run the configured steps in order through /bin/sh with a scrubbed
 * environment (the steps of a parallel group at once), parse bun's test
 * summary from each step's output, copy the built binary out, record the
 * outcome, and remove the worktree. As many jobs run at once as the
 * validation pool allows (src/verify/start.ts). Besides the run's deadline, each step has
 * its own (src/verify/deadline.ts): at either, the step's process group is
 * listed into its log and killed, and a step killed at its own deadline runs
 * once more (docs/notes/2026-10-22-verify-reliability-per-xe.md). The job
 * holds a validation slot (a job lease the verb took with the row), released
 * only once its steps' process groups are gone and its worktree removed.
 */

export interface VerifyDeps {
  db: Db;
  git: GitRunner;
  now(): number;
  log(message: string): void;
  /** Where verification directories live: <state_dir>/verify. */
  root: string;
  /** The job's slot was released: the scheduler may grant it. */
  released?(): void;
  /** The process table (tests); by default /bin/ps. */
  ps?: PsRunner;
  /** End a step left by the last daemon (tests); by default `terminate` by identity, its whole group. */
  terminate?(proc: ProcIdentity, options: TerminateOptions): Promise<TerminateResult>;
  /** A step's process group as ps lists it, for its log at a deadline (tests); by default ps through runBounded. */
  groupTable?(pgid: number): Promise<string>;
}

export interface VerifyPlan {
  /** The PR, or null for local-only work (its head is a worker's commit, already in the repository). */
  prNumber: number | null;
  headRef: string | null;
  binary: string | null;
  timeoutMs: number;
  /** Every step's own deadline (verify_step_timeout_min); null or absent: each step's comes from its history. */
  stepTimeoutMs?: number | null;
  /** The PATH of whoever ran `flowryn verify` (launchd's is short: it has no ~/.bun/bin); the daemon's when none came. */
  path: string | null;
}

/** Finished verification directories kept per project (binary and logs); older ones are removed. */
export const KEEP_PER_PROJECT = 3;
/** How much of a step's output the summary parser and the failure tail read. */
const TAIL_BYTES = 256 * 1024;
const KILL_GRACE_MS = 5_000;
/** How long startup recovery waits for a step left by the last daemon to exit on SIGTERM before SIGKILL. */
const RECOVER_GRACE_MS = 5_000;
/** How long the ps of a step's group at a deadline may take. */
const GROUP_TABLE_TIMEOUT_MS = 5_000;
/** Opened for appending, so the process table written at a deadline is never overwritten by the step's own output. */
const LOG_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_APPEND;

interface Job {
  aborted: boolean;
  /** Every step process running now: several while a parallel group runs. */
  children: Set<ChildProcess>;
}

const active = new Map<string, Job>();

export function isVerifying(id: string): boolean {
  return active.has(id);
}

/** A caller's PATH, absolute entries only, so nothing resolves inside the worktree under test. */
export function absolutePath(path: string): string {
  return path
    .split(":")
    .filter((dir) => dir.startsWith("/"))
    .filter((dir, i, all) => all.indexOf(dir) === i)
    .join(":");
}

/**
 * The environment a step runs with: the daemon's, minus anything that would
 * point it at this Flowryn (FLOWRYN_*), make it a child of a Claude session,
 * or hand it a GitHub token; with the caller's PATH when one came.
 */
export function stepEnv(base: NodeJS.ProcessEnv, path: string | null = null): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (key.startsWith("FLOWRYN_") || key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_") || key === "GH_TOKEN" || key === "GITHUB_TOKEN") continue;
    env[key] = value;
  }
  if (path) {
    const dirs = absolutePath(path);
    if (dirs) env.PATH = dirs;
  }
  env.NO_COLOR = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

/** "bun install --frozen-lockfile" -> "1-bun-install-frozen-lockfile.log". */
export function logName(index: number, step: string): string {
  const slug = step.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "step";
  return `${index + 1}-${slug}.log`;
}


/** One waiting row per step, groups flattened in order; `group` is the entry of `verify` it came from. */
export function initialSteps(items: readonly VerifyItem[]): VerifyStep[] {
  const steps: VerifyStep[] = [];
  items.forEach((item, group) => {
    for (const name of typeof item === "string" ? [item] : item) steps.push({ name, state: "waiting", exit: null, ms: null, log: logName(steps.length, name), tests: null, detail: null, group });
  });
  return steps;
}

/** "2-bun-run-typecheck.log" -> "2-bun-run-typecheck.retry.log". */
export function retryLogName(log: string): string {
  return log.replace(/\.log$/, ".retry.log");
}

/** Step indexes by group, groups in order; on a row from before groups each step is its own. */
export function stepGroups(steps: readonly VerifyStep[]): number[][] {
  const groups: number[][] = [];
  let current: number | null = null;
  steps.forEach((step, i) => {
    const group = step.group ?? i;
    if (groups.length === 0 || group !== current) groups.push([]);
    current = group;
    groups.at(-1)!.push(i);
  });
  return groups;
}

/** The header and the rows of a `ps -o pid,ppid,pgid,...` table whose process group is `pgid`. */
export function groupRows(table: string, pgid: number): string {
  const lines = table.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return "";
  const rows = lines.slice(1).filter((line) => Number(line.trim().split(/\s+/)[2]) === pgid);
  return [lines[0]!, ...rows].join("\n");
}

/** The step's process group as ps lists it, through runBounded; why not, when ps fails. */
async function psGroupTable(pgid: number): Promise<string> {
  const ps = await runBounded(["/bin/ps", "-A", "-o", "pid,ppid,pgid,stat,etime,time,rss,command"], { label: "verify ps", timeoutMs: GROUP_TABLE_TIMEOUT_MS });
  if (ps.code !== 0) return `(ps failed: ${ps.stderr.trim() || `exit ${ps.code}`})`;
  return groupRows(ps.stdout, pgid);
}

/** The last `bytes` of a file, or "" when it cannot be read. */
export function readTail(path: string, bytes = TAIL_BYTES): string {
  try {
    const size = statSync(path).size;
    if (size <= bytes) return readFileSync(path, "utf8");
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(bytes);
      readSync(fd, buffer, 0, bytes, size - bytes);
      return buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

async function hasCommit(git: GitRunner, cwd: string, sha: string): Promise<boolean> {
  return (await git(["cat-file", "-e", `${sha}^{commit}`], cwd)).code === 0;
}

/** Bring the head into the object store: already there (a worker's commit; always so for local-only work), the PR ref, or the head branch. Writes no ref. */
async function ensureHead(deps: VerifyDeps, v: Verification, plan: VerifyPlan): Promise<string | null> {
  if (await hasCommit(deps.git, v.project_path, v.head_sha)) return null;
  const tried: string[] = [];
  const refs = [plan.prNumber === null ? null : `refs/pull/${plan.prNumber}/head`, plan.headRef === null ? null : `refs/heads/${plan.headRef}`].filter((ref): ref is string => ref !== null);
  for (const ref of refs) {
    // An empty --refmap keeps the fetch from updating origin's remote-tracking branches as a side effect, and
    // --no-write-fetch-head leaves FETCH_HEAD alone, so two jobs in one repository can fetch at once.
    const fetched = await deps.git(["fetch", "--no-tags", "--quiet", "--no-write-fetch-head", "--refmap=", "origin", ref], v.project_path);
    if (fetched.code !== 0) tried.push(`${ref}: ${fetched.stderr.trim().split("\n").at(-1) ?? `exit ${fetched.code}`}`);
    if (await hasCommit(deps.git, v.project_path, v.head_sha)) return null;
  }
  return `the head ${v.head_sha.slice(0, 8)} is not in ${v.project_path} and fetching it from origin did not bring it${tried.length > 0 ? ` (${tried.join("; ")})` : ""}`;
}


function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // the group is gone already
  }
}

interface StepResult {
  exit: number;
  /** Which deadline killed it: the step's own, the run's, or none. */
  timedOut: "step" | "run" | null;
  /** Killed because another step of its group failed. */
  stopped: boolean;
}

interface Attempt {
  command: string;
  cwd: string;
  logPath: string;
  env: Record<string, string>;
  /** When the step's own deadline falls (epoch ms), or null when it has none. */
  stepDeadline: number | null;
  runDeadline: number;
  /** What is appended to the log at a deadline, before the kill. */
  atDeadline(pgid: number, which: "step" | "run"): Promise<string>;
  /** Hears of the group leader's pid; the step resolves only after its promise settles too. */
  spawned(pid: number): Promise<void>;
}

/** How a parallel group stops a running sibling once one of its steps failed. */
interface StepHandle {
  stop(): void;
}

/**
 * Run one step in its own process group, its output to its log. At the earlier of its own
 * deadline and the run's, the group's process table is appended to the log, then the whole
 * group is killed (SIGTERM, SIGKILL after a grace).
 */
function runStep(job: Job, a: Attempt, handle: StepHandle): Promise<StepResult> {
  return new Promise((resolve) => {
    const fd = openSync(a.logPath, LOG_FLAGS, 0o600);
    let child: ChildProcess;
    try {
      child = spawn("/bin/sh", ["-c", a.command], { cwd: a.cwd, env: a.env, stdio: ["ignore", fd, fd], detached: true });
    } catch {
      closeSync(fd);
      resolve({ exit: 127, timedOut: null, stopped: false });
      return;
    }
    job.children.add(child);
    const noted = child.pid === undefined ? Promise.resolve() : a.spawned(child.pid);
    let timedOut: StepResult["timedOut"] = null;
    let stopped = false;
    let finished = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const which = a.stepDeadline !== null && a.stepDeadline < a.runDeadline ? "step" : "run";
    const expire = async () => {
      timedOut = which;
      if (child.pid !== undefined) {
        const text = await a.atDeadline(child.pid, which).catch((error: unknown) => `\n(listing the process group failed: ${(error as Error).message})\n`);
        try {
          appendFileSync(a.logPath, text);
        } catch {
          // the listing is diagnostics only; the kill goes ahead without it
        }
      }
      // It exited while ps ran: its group is killed already, and a later signal could reach a reused group id.
      if (finished) return;
      killGroup(child, "SIGTERM");
      grace = setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => void expire(), Math.max(0, (which === "step" ? a.stepDeadline! : a.runDeadline) - Date.now()));
    handle.stop = () => {
      if (finished || timedOut !== null) return;
      stopped = true;
      killGroup(child, "SIGKILL");
    };
    const done = (exit: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      // A step's leftovers (a server it started) go with it.
      killGroup(child, "SIGKILL");
      closeSync(fd);
      job.children.delete(child);
      void noted.then(() => resolve({ exit, timedOut, stopped }));
    };
    child.once("error", () => done(127));
    child.once("exit", (code, signal) => done(code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0)));
  });
}

/** Copy the built binary (and the symlinks beside it that name it, such as flowrynd) out of the worktree. */
export function keepBinary(worktree: string, binary: string, dir: string): string {
  const source = join(worktree, binary);
  if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`the steps passed but ${binary} was not built`);
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const name = basename(source);
  const dest = join(binDir, name);
  copyFileSync(source, dest);
  chmodSync(dest, statSync(source).mode & 0o777);
  for (const entry of readdirSync(dirname(source))) {
    const path = join(dirname(source), entry);
    if (entry !== name && lstatSync(path).isSymbolicLink() && readlinkSync(path) === name) symlinkSync(name, join(binDir, entry));
  }
  return dest;
}

/** Only ever remove a verification's own worktree or directory: <root>/v<n>[/wt]. */
function ownPath(root: string, path: string, leaf: "dir" | "wt"): boolean {
  const pattern = leaf === "dir" ? /^v\d+$/ : /^v\d+\/wt$/;
  return path.startsWith(root + sep) && pattern.test(path.slice(root.length + 1));
}

export async function removeWorktree(deps: Pick<VerifyDeps, "git" | "root" | "log">, v: Pick<Verification, "id" | "worktree_path" | "project_path">): Promise<void> {
  if (!existsSync(v.worktree_path)) {
    await deps.git(["worktree", "prune"], v.project_path);
    return;
  }
  const removed = await deps.git(["worktree", "remove", "--force", v.worktree_path], v.project_path);
  if (existsSync(v.worktree_path)) {
    if (!ownPath(deps.root, v.worktree_path, "wt")) {
      deps.log(`verify ${v.id}: not removing ${v.worktree_path}: it is not a verification worktree`);
      return;
    }
    rmSync(v.worktree_path, { recursive: true, force: true });
    if (removed.code !== 0) deps.log(`verify ${v.id}: git worktree remove failed (${removed.stderr.trim()}); removed the directory`);
  }
  await deps.git(["worktree", "prune"], v.project_path);
}

/** Keep the newest finished verification directories of a project; remove the rest (their rows stay). */
export function pruneDirs(deps: Pick<VerifyDeps, "db" | "root" | "log">, projectId: string, keep = KEEP_PER_PROJECT): void {
  const rows = deps.db.query("SELECT id, dir FROM verifications WHERE project_id = ?1 AND state <> 'running' ORDER BY started_at DESC, rowid DESC").all(projectId) as { id: string; dir: string }[];
  for (const row of rows.slice(keep)) {
    if (!existsSync(row.dir)) continue;
    if (!ownPath(deps.root, row.dir, "dir")) {
      deps.log(`verify ${row.id}: not pruning ${row.dir}: it is not a verification directory`);
      continue;
    }
    rmSync(row.dir, { recursive: true, force: true });
  }
}

function lastTests(steps: VerifyStep[]): TestCounts | null {
  return steps.findLast((s) => s.tests !== null)?.tests ?? null;
}

function jobOf(v: Pick<Verification, "id" | "task_id">): JobRef {
  return { kind: "verify", id: v.id, taskId: v.task_id };
}

/** Release the job's slot (once; a second call records nothing) and tell the scheduler. A failure is logged: startup recovery releases it then. */
function releaseSlot(deps: VerifyDeps, v: Verification, reason: string): void {
  try {
    const pools = tx(deps.db, () => releaseJobLeases(deps.db, jobOf(v), reason, deps.now()));
    if (pools.length > 0) deps.released?.();
  } catch (error) {
    deps.log(`verify ${v.id}: could not release its slot: ${(error as Error).message}`);
  }
}

const EXEC_SETTLE_MS = 2_000;
const EXEC_POLL_MS = 20;

/** macOS ps names a process it cannot read the arguments of, such as one still being exec'd, in parentheses: "(sh)". */
function midExec(identity: ProcIdentity): boolean {
  return identity.exe.startsWith("(") && identity.exe.endsWith(")");
}

/** The step leader's identity once its exec has settled; null when it is gone or never settles. */
async function settledIdentity(pid: number, ps: PsRunner | undefined): Promise<ProcIdentity | null> {
  const deadline = Date.now() + EXEC_SETTLE_MS;
  for (;;) {
    const identity = await readIdentity(pid, ps);
    if (!identity || !midExec(identity)) return identity;
    if (Date.now() > deadline) throw new Error(`its executable never settled (ps reads ${identity.exe})`);
    await Bun.sleep(EXEC_POLL_MS);
  }
}

/** Record a step's process group leader on the job's lease, so a later daemon can end it by identity. */
async function noteStepProcess(deps: VerifyDeps, v: Verification, pid: number): Promise<void> {
  try {
    // Gone already (a quick step): nothing outlives it, since its group is killed when it exits.
    // A mid-exec name would never match the running step again, so recovery would read it as absent.
    const identity = await settledIdentity(pid, deps.ps);
    if (identity) tx(deps.db, () => recordJobProcess(deps.db, jobOf(v), identity, deps.now()));
  } catch (error) {
    deps.log(`verify ${v.id}: could not record step pid ${pid}: ${(error as Error).message}`);
  }
}

/** The block appended to a step's log at a deadline: why, and its process group as it stood. */
async function deadlineBlock(deps: VerifyDeps, pgid: number, why: string): Promise<string> {
  const table = await (deps.groupTable ?? psGroupTable)(pgid);
  return `\n--- flowryn verify: killed at ${why}; its process group ${pgid} at that moment ---\n${table}\n---\n`;
}

/**
 * Why a finished step ended as it did beyond its exit code, or null. `firstLog` is its first
 * attempt's log; `step.log` its last.
 */
function stepDetail(step: VerifyStep, result: StepResult, deadline: StepDeadline | null, plan: VerifyPlan, firstLog: string, stoppedBy: string | null): string | null {
  const runOut = `timed out: the run's ${duration(plan.timeoutMs)} were up`;
  const hangs = step.hangs ?? 0;
  const at = deadline ? deadlineLine(deadline) : "its deadline";
  if (hangs === 2) return `hung twice: killed at ${at} both times; process groups in ${firstLog} and ${step.log}`;
  const hung = hangs === 1 ? `hung once: killed at ${at}, process group in ${firstLog}` : null;
  let outcome: string | null;
  if (result.stopped) outcome = `stopped: ${stoppedBy ?? "another step of its group"} failed`;
  else if (result.timedOut === "run") outcome = runOut;
  else if (hung === null) outcome = null;
  else if ((step.attempts ?? 1) === 1) outcome = "no time left in the run to retry it";
  else outcome = result.exit === 0 ? "passed on its retry" : `its retry exited ${result.exit}`;
  if (hung === null) return outcome;
  return outcome === null ? hung : `${hung}; ${outcome}`;
}

/** Run a verification to its end. Never throws: whatever happens is recorded on its row. */
export async function runVerification(deps: VerifyDeps, v: Verification, plan: VerifyPlan, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (active.has(v.id)) return;
  const job: Job = { aborted: false, children: new Set() };
  active.set(v.id, job);
  const runDeadline = Date.now() + plan.timeoutMs;
  const steps = v.steps.map((s) => ({ ...s }));
  const finish = (outcome: Omit<VerificationOutcome, "steps" | "tests">, stopped = false) => {
    try {
      tx(deps.db, () => {
        // Stopped with the daemon: it runs again from the front of the queue once the next daemon is up.
        if (finishVerification(deps.db, v, { ...outcome, steps, tests: lastTests(steps) }, deps.now()) && stopped) requeueInterrupted(deps, v);
      });
    } catch (error) {
      deps.log(`verify ${v.id}: could not record the outcome: ${(error as Error).message}`);
    }
  };
  const record = (changed: VerifyStep) => tx(deps.db, () => recordSteps(deps.db, v, steps, changed, deps.now()));
  const stoppedMidRun = () => finish({ state: "error", detail: "the daemon stopped mid-run", binary: null }, true);
  let worktreeAdded = false;
  try {
    mkdirSync(v.dir, { recursive: true, mode: 0o700 });
    const missing = await ensureHead(deps, v, plan);
    // Shutdown kills the setup's git (its fetch or worktree add): that failure is the stop, not the head's.
    if (job.aborted) return stoppedMidRun();
    if (missing) return finish({ state: "error", detail: missing, binary: null });
    const added = await deps.git(["worktree", "add", "--detach", v.worktree_path, v.head_sha], v.project_path);
    worktreeAdded = added.code === 0;
    if (job.aborted) return stoppedMidRun();
    if (!worktreeAdded) return finish({ state: "error", detail: `git worktree add failed: ${added.stderr.trim() || added.stdout.trim()}`, binary: null });
    const childEnv = stepEnv(env, plan.path);
    const deadlines = stepDeadlines(deps.db, v.project_id, steps.map((s) => s.name), plan.stepTimeoutMs ?? null);
    steps.forEach((s, i) => (s.deadline_ms = deadlines[i]?.ms ?? null));

    /** One step to its end: run, and once more when its own deadline killed it and the run has time left. */
    const runOne = async (i: number, handle: StepHandle, stoppedBy: () => string | null): Promise<void> => {
      const step = steps[i]!;
      const deadline = deadlines[i] ?? null;
      const firstLog = step.log;
      const began = Date.now();
      let result: StepResult = { exit: 127, timedOut: null, stopped: false };
      step.hangs = 0;
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (stoppedBy() !== null) {
          result = { ...result, stopped: true };
          break;
        }
        step.attempts = attempt;
        step.log = attempt === 1 ? firstLog : retryLogName(firstLog);
        step.state = "running";
        record(step);
        result = await runStep(
          job,
          {
            command: step.name,
            cwd: v.worktree_path,
            logPath: join(v.dir, step.log),
            env: childEnv,
            stepDeadline: deadline ? Date.now() + deadline.ms : null,
            runDeadline,
            atDeadline: (pgid, which) => deadlineBlock(deps, pgid, which === "step" && deadline ? deadlineLine(deadline) : `the run's ${duration(plan.timeoutMs)} deadline`),
            spawned: (pid) => noteStepProcess(deps, v, pid),
          },
          handle,
        );
        if (result.timedOut !== "step") break;
        step.hangs++;
        if (job.aborted || Date.now() >= runDeadline) break;
      }
      step.ms = Date.now() - began;
      step.exit = result.exit;
      step.tests = parseBunSummary(readTail(join(v.dir, step.log)));
      step.state = result.stopped ? "stopped" : result.exit === 0 && result.timedOut === null ? "passed" : "failed";
      step.detail = stepDetail(step, result, deadline, plan, firstLog, stoppedBy());
      record(step);
    };

    for (const group of stepGroups(steps)) {
      if (job.aborted) return stoppedMidRun();
      let failedBy: string | null = null;
      const handles: StepHandle[] = group.map(() => ({ stop() {} }));
      const stopSiblings = (k: number) => handles.forEach((h, j) => j !== k && h.stop());
      const settled = await Promise.allSettled(
        group.map(async (i, k) => {
          try {
            await runOne(i, handles[k]!, () => failedBy);
          } catch (error) {
            failedBy ??= steps[i]!.name;
            stopSiblings(k);
            throw error;
          }
          if (steps[i]!.state !== "failed" || failedBy !== null) return;
          failedBy = steps[i]!.name;
          stopSiblings(k);
        }),
      );
      const thrown = settled.find((r) => r.status === "rejected");
      if (thrown) throw thrown.reason;
      if (job.aborted) return stoppedMidRun();
      const failed = steps.find((s) => s.name === failedBy && s.state === "failed");
      if (failed) return finish({ state: "failed", detail: failed.detail ?? `${failed.name} exited ${failed.exit}`, binary: null });
    }
    let binary: string | null = null;
    if (plan.binary) {
      try {
        binary = keepBinary(v.worktree_path, plan.binary, v.dir);
      } catch (error) {
        return finish({ state: "failed", detail: (error as Error).message, binary: null });
      }
    }
    // A pass that needed a retry says so: the hang is worth knowing about even when it cleared.
    const recovered = steps.filter((s) => (s.hangs ?? 0) > 0).map((s) => `${s.name}: ${s.detail}`);
    return finish({ state: "passed", detail: recovered.length > 0 ? recovered.join("; ") : null, binary });
  } catch (error) {
    deps.log(`verify ${v.id}: ${(error as Error).stack ?? String(error)}`);
    finish({ state: "error", detail: `verify failed: ${(error as Error).message}`, binary: null });
  } finally {
    try {
      if (worktreeAdded || existsSync(v.worktree_path)) await removeWorktree(deps, v);
      pruneDirs(deps, v.project_id);
    } catch (error) {
      deps.log(`verify ${v.id}: cleanup failed: ${(error as Error).message}`);
    }
    // After the steps' groups are killed (runStep) and the worktree is gone: a failed removal is logged above,
    // and the slot still freed, since nothing of the job runs any more.
    releaseSlot(deps, v, `verification ${v.id} ended`);
    active.delete(v.id);
  }
}

/** Daemon shutdown: stop every running step; each job records itself as stopped. */
export function stopVerifications(): void {
  for (const job of active.values()) {
    job.aborted = true;
    for (const child of job.children) killGroup(child, "SIGKILL");
  }
}

/** SIGKILL what is left of a group whose leader the recovery just ended (a member that ignored SIGTERM). */
function killLeftovers(pgid: number): void {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // the group is gone already
  }
}

/**
 * An interrupted verification runs again from the front of the queue, once:
 * one that was itself a rerun is left as an error (an event says why), and
 * a verification started before the queue existed has no request to copy.
 * Call inside a transaction.
 */
function requeueInterrupted(deps: VerifyDeps, v: Verification): void {
  const request = requestOf(deps.db, v.id);
  if (!request || requeuedFrom(deps.db, v.id)) return;
  const now = deps.now();
  if (request.source === "recovered") {
    appendEvent(deps.db, { source: "daemon", kind: "verify.not_requeued", taskId: v.task_id, payload: { verification: v.id, request: request.id, reason: `${v.id} was already a rerun of ${request.recovered_from ?? "an interrupted verification"}` }, ts: now });
    return;
  }
  insertRequest(deps.db, {
    project_id: request.project_id,
    pr_url: request.pr_url,
    task_id: request.task_id,
    head_sha: request.head_sha,
    policy_id: request.policy_id,
    pr_number: request.pr_number,
    head_ref: request.head_ref,
    worktree: request.worktree,
    source: "recovered",
    path: request.path,
    rank: RECOVERED_RANK,
    recovered_from: v.id,
    now,
  });
}

/** Recover one job; true when a running row was recorded as an error. */
async function recoverOne(deps: VerifyDeps, end: NonNullable<VerifyDeps["terminate"]>, id: string, leases: ReturnType<typeof liveJobLeases>): Promise<boolean> {
  const v = getVerification(deps.db, id);
  const lease = leases.find((l) => l.job_id === id) ?? null;
  // Every step process the job recorded: several when a parallel group was running. One that is gone or reused is left alone.
  const left: number[] = [];
  for (const proc of lease ? leaseProcesses(deps.db, lease) : []) {
    const ended = await end(proc, { group: true, execs: true, graceMs: RECOVER_GRACE_MS, ps: deps.ps });
    if (ended.ok && ended.evidence === "process") killLeftovers(proc.pid);
    if (!ended.ok) {
      left.push(proc.pid);
      deps.log(`verify ${id}: the step left by the last daemon (pid ${proc.pid}) did not exit (${ended.evidence}); its slot stays held`);
    }
  }
  const stepGone = left.length === 0;
  let recorded = false;
  if (v && v.state === "running") {
    const detail = stepGone ? "the daemon stopped mid-run" : `the daemon stopped mid-run; its step${left.length > 1 ? "s" : ""} (pid ${left.join(", ")}) did not exit`;
    recorded = tx(deps.db, () => {
      const finished = finishVerification(deps.db, v, { state: "error", steps: v.steps, tests: lastTests(v.steps), detail, binary: null }, deps.now());
      if (finished) requeueInterrupted(deps, v);
      return finished;
    });
  }
  if (!stepGone) return recorded;
  if (v) await removeWorktree(deps, v).catch((error: unknown) => deps.log(`verify ${id}: cleanup failed: ${(error as Error).message}`));
  if (lease) {
    const job = { kind: "verify" as const, id, taskId: lease.task_id };
    tx(deps.db, () => releaseJobLeases(deps.db, job, "recovered at startup", deps.now()));
  }
  return recorded;
}

/**
 * Daemon startup: a verification still running, or a verify slot still held,
 * belongs to a daemon that is gone. Its recorded steps are ended by identity
 * (its whole group; a reused pid is never signalled), a running row is
 * recorded as an error (and requeued once, at the front), its worktree
 * removed, and then its slot released
 * (a member of the group that outlived its leader is SIGKILLed first). A
 * step that will not exit keeps its slot (the next startup tries again): the
 * slot is not free while its work still runs. Returns the rows recorded as errors.
 */
export async function recoverVerifications(deps: VerifyDeps): Promise<number> {
  const end = deps.terminate ?? ((proc, options) => terminate(proc, options));
  const leases = liveJobLeases(deps.db, "verify").filter((l) => !active.has(l.job_id));
  const ids = [...new Set([...runningVerifications(deps.db).map((v) => v.id), ...leases.map((l) => l.job_id)])].filter((id) => !active.has(id));
  let recorded = 0;
  for (const id of ids) {
    try {
      if (await recoverOne(deps, end, id, leases)) recorded++;
    } catch (error) {
      const message = (error as Error).message;
      deps.log(`verify ${id}: recovery failed: ${message}`);
      try {
        const v = getVerification(deps.db, id);
        if (v && v.state === "running" && tx(deps.db, () => finishVerification(deps.db, v, { state: "error", steps: v.steps, tests: lastTests(v.steps), detail: `the daemon stopped mid-run; recovering it failed (${message})`, binary: null }, deps.now()))) recorded++;
      } catch (recordError) {
        deps.log(`verify ${id}: recording the failed recovery failed: ${(recordError as Error).message}`);
      }
    }
  }
  return recorded;
}
