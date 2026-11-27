import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, chmodSync, closeSync, constants as fsConstants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { constants } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import type { Db } from "../db/db.ts";
import { tx } from "../db/db.ts";
import type { GitRunner } from "../policy/landed.ts";
import { runBounded } from "../runtime/bounded.ts";
import { scrubbedEnv } from "../runtime/child-env.ts";
import { readIdentity, terminate, type ProcIdentity, type PsRunner, type TerminateOptions, type TerminateResult } from "../runtime/proc.ts";
import { withRepoLock } from "../runtime/repo-lock.ts";
import { leaseProcesses, liveJobLeases, recordJobProcess, releaseJobLeases, type JobRef } from "../sched/pools.ts";
import { appendEvent } from "../db/events.ts";
import { PROJECT_ID } from "../lifecycle/projects.ts";
import { failedReleases, projectRelease, runRelease } from "../lifecycle/release.ts";
import type { FlowrynConfig } from "../config/config.ts";
import { anyMatches, baseKey, changedSinceBase, commitTree, type ChangedFiles } from "./changed.ts";
import { LAWS_STEP, REVIEW_STEP, type ReviewConfig, type VerifyItem } from "./config.ts";
import { checkLaws, lawsSummary, type LawResult } from "./laws.ts";
import { deadlineLine, duration, stepDeadlines, type StepDeadline } from "./deadline.ts";
import { reviewLog, runReview, type ReviewInput } from "./review.ts";
import { autoVerifyPath, insertRequest, RECOVERED_RANK, requestOf, requeuedFrom } from "./queue.ts";
import { finishVerification, getVerification, passedAtTree, recordSlotState, recordSteps, runningVerifications, slotState, STOPPED_MID_RUN, type ReuseKey, type Verification, type VerificationOutcome, type VerifyStep } from "./store.ts";
import { parseBunSummary, type TestCounts } from "./summary.ts";

/**
 * One `flowryn verify` job, run by the daemon (outside every sandbox): make
 * sure the PR head is in the project's object store, reset its slot checkout
 * to exactly that head (a reused detached worktree at a stable path:
 * docs/notes/2026-11-24-verifies-reuse-one-a6.md), run the configured steps in
 * order through /bin/sh with a scrubbed environment (the steps of a parallel
 * group at once), parse bun's test summary from each step's output, copy the
 * built binary out, record the outcome, and clean the checkout. As many jobs run at once as the
 * validation pool allows (src/verify/start.ts); their worktree adds and removals in one
 * repository take turns (src/runtime/repo-lock.ts). Besides the run's deadline, each step has
 * its own (src/verify/deadline.ts): at either, the step's process group is
 * listed into its log and killed, and a step killed at its own deadline runs
 * once more (docs/notes/2026-10-22-verify-reliability-per-xe.md). The job
 * holds a validation slot (a job lease the verb took with the row), released
 * only once its steps' process groups are gone and its checkout cleaned (or removed).
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
  /** The daemon's config: the review step reads its harness, account and tools there; without it a review step fails with no verdict. */
  config?(): FlowrynConfig;
  /** Tests: the review step's model call (default: runBounded). */
  reviewCall?: ReviewInput["call"];
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
  /** The review step's settings, when the steps have one (REVIEW_STEP). */
  review?: ReviewConfig | null;
  /** The PR's base branch, which when_changed diffs against; null or absent: origin's default branch. */
  base?: string | null;
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
  /** A review step's model call, ended with the job. */
  calls: Set<AbortController>;
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

/** The environment a step runs with: the daemon's, scrubbed (src/runtime/child-env.ts), with the caller's PATH when one came. */
export function stepEnv(base: NodeJS.ProcessEnv, path: string | null = null): Record<string, string> {
  const env = scrubbedEnv(base);
  if (path) {
    const dirs = absolutePath(path);
    if (dirs) env.PATH = dirs;
  }
  env.NO_COLOR = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

/** The environment a release command runs with (src/lifecycle/release.ts): a daemon-made verify's, so it finds the tools `make test` does. */
export function releaseEnv(db: Db, projectId: string): Record<string, string> {
  return stepEnv(process.env, autoVerifyPath(db, projectId));
}

/** "bun install --frozen-lockfile" -> "1-bun-install-frozen-lockfile.log". */
export function logName(index: number, step: string): string {
  const slug = step.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "step";
  return `${index + 1}-${slug}.log`;
}


/**
 * One waiting row per step, groups flattened in order; `group` is the entry of `verify` it came from, `when_changed` its globs by flattened place.
 * With `laws`, the laws step (LAWS_STEP) follows as a group of its own.
 */
export function initialSteps(items: readonly VerifyItem[], whenChanged: readonly (readonly string[] | null)[] = [], laws = false): VerifyStep[] {
  const steps: VerifyStep[] = [];
  const all = laws ? [...items, LAWS_STEP] : items;
  all.forEach((item, group) => {
    for (const name of typeof item === "string" ? [item] : item) {
      const when = whenChanged[steps.length] ?? null;
      steps.push({ name, state: "waiting", exit: null, ms: null, log: logName(steps.length, name), tests: null, detail: null, group, ...(when ? { when_changed: [...when] } : {}) });
    }
  });
  return steps;
}

/** A conditioned step's fate once the changed files are known: skip it (with why), or run it (with a note when the files are unknown). */
export function changeGate(step: Pick<VerifyStep, "when_changed">, changed: ChangedFiles | null): { skip: string } | { note: string | null } {
  if (!step.when_changed || step.when_changed.length === 0 || changed === null) return { note: null };
  if ("error" in changed) return { note: `ran: the changed files are unknown (${changed.error})` };
  if (anyMatches(step.when_changed, changed.files)) return { note: null };
  const globs = step.when_changed.join(", ");
  return { skip: `skipped: none of the ${changed.files.length} file${changed.files.length === 1 ? "" : "s"} changed against ${changed.base} matches its when_changed (${globs})` };
}

/**
 * A flake rerun's shell: `command` `passes` times in a row, each run marked in the log, stopping
 * at the first that fails with its exit code (src/verify/flake.ts).
 */
export function repeatedCommand(command: string, passes: number): string {
  const runs = Array.from({ length: passes }, (_, i) => i + 1).join(" ");
  return `for n in ${runs}; do echo "--- flowryn: flake rerun $n of ${passes}"; ( ${command}\n ) || exit $?; done`;
}

/** What a flake rerun's step says it ran instead of its own command; null for any other step. */
function rerunNote(step: VerifyStep): string | null {
  if (!step.rerun) return null;
  const { of, command, passes, tests } = step.rerun;
  return `flake rerun of ${of}: ${tests.length} failing test${tests.length === 1 ? "" : "s"}, ${passes} times, with \`${command}\`${step.state === "passed" ? `: passed ${passes} of ${passes}` : ""}`;
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
  /** A review step with no verdict: why. */
  note?: string;
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

/**
 * The review step (src/verify/review.ts): one capped model call instead of a shell command,
 * its reply written to the step's log. A verdict is exit 0 (pass) or 1 (fail: the findings go
 * back to the worker as a failed step's tail does); no verdict is exit REVIEW_NO_VERDICT, and at
 * its deadline a step timeout, so the auto-merge holds it for the leader instead of sending it back.
 */
async function reviewStep(deps: VerifyDeps, job: Job, v: Verification, plan: VerifyPlan, logPath: string, runDeadline: number): Promise<StepResult> {
  const write = (text: string) => {
    const fd = openSync(logPath, LOG_FLAGS, 0o600);
    try {
      appendFileSync(fd, text);
    } finally {
      closeSync(fd);
    }
  };
  if (!plan.review || !deps.config) {
    const note = plan.review ? "this verify has no daemon config to run it with" : "the plan carries no review settings";
    write(`flowryn review: no verdict: ${note}\n`);
    return { exit: REVIEW_NO_VERDICT, timedOut: null, stopped: false, note };
  }
  const left = runDeadline - Date.now();
  const timeoutMs = Math.max(1, Math.min(plan.review.timeout_ms, left));
  const controller = new AbortController();
  job.calls.add(controller);
  try {
    const result = await runReview({ db: deps.db, git: deps.git, config: deps.config(), review: plan.review, projectId: v.project_id, taskId: v.task_id, worktree: v.worktree_path, dir: v.dir, timeoutMs, signal: controller.signal, call: deps.reviewCall });
    write(reviewLog(result, plan.review));
    if (result.verdict !== null) return { exit: result.verdict === "pass" ? 0 : 1, timedOut: null, stopped: false };
    const which = !result.timedOut ? null : timeoutMs < plan.review.timeout_ms ? "run" : "step";
    return { exit: REVIEW_NO_VERDICT, timedOut: which, stopped: false, note: result.reason };
  } finally {
    job.calls.delete(controller);
  }
}

/**
 * The laws step (src/verify/laws.ts): the AGENTS.md laws table checked in-process, each test
 * enforcer run through runBounded (argv, never a shell) by the step's deadline. Exit 0 when every
 * law holds or there is no table, 1 when one fails; the run's deadline is a run timeout as for any step.
 */
async function lawsStep(deps: VerifyDeps, job: Job, v: Verification, plan: VerifyPlan, logPath: string, env: Record<string, string>, deadline: number, runDeadline: number): Promise<StepResult & { laws: LawResult[]; summary: string | null }> {
  const controller = new AbortController();
  job.calls.add(controller);
  try {
    const outcome = await checkLaws({
      git: deps.git,
      run: (argv, opts) => runBounded(argv, opts),
      worktree: v.worktree_path,
      base: plan.base ?? null,
      steps: v.steps.map((s) => s.name),
      env,
      deadline: Math.min(deadline, runDeadline),
      now: Date.now,
      signal: controller.signal,
    });
    const fd = openSync(logPath, LOG_FLAGS, 0o600);
    try {
      appendFileSync(fd, outcome.log);
    } finally {
      closeSync(fd);
    }
    const failed = outcome.error !== null || outcome.laws.some((l) => l.state === "failed");
    const timedOut = failed && Date.now() >= runDeadline ? "run" : null;
    return { exit: failed ? 1 : 0, timedOut, stopped: false, laws: outcome.laws, summary: lawsSummary(outcome) };
  } finally {
    job.calls.delete(controller);
  }
}

/** A review step that ended with no verdict: not the worker's to fix (src/verify/auto-merge.ts holds it). */
export const REVIEW_NO_VERDICT = 3;

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

/**
 * A project's reusable verify checkouts (docs/notes/2026-11-24-verifies-reuse-one-a6.md):
 * <root>/slots/<project>/<k>. The same absolute path from one verify to the next, so caches keyed
 * on it (Go's compile cache without -trimpath) hit; each use resets it to exactly its head.
 */
export function slotPath(root: string, projectId: string, k: number): string {
  return join(root, "slots", projectId, String(k));
}

/** <root>-relative "slots/<project>/<k>", by its parts: no "..", a valid project id, digits only. */
function slotRelative(rel: string): boolean {
  const parts = rel.split("/");
  return parts.length === 3 && parts[0] === "slots" && PROJECT_ID.test(parts[1]!) && /^\d+$/.test(parts[2]!);
}

/** Whether `path` names a slot checkout under `root` (by its spelling alone). */
export function isSlotPath(root: string, path: string): boolean {
  return path.startsWith(root + sep) && slotRelative(path.slice(root.length + 1));
}

/** Every component of `rel` below `root` that exists is a real directory, never a symlink (a missing one ends the walk). */
function noLinkBelow(root: string, rel: string): boolean {
  let at = root;
  for (const part of rel.split("/")) {
    at = join(at, part);
    let stat;
    try {
      stat = lstatSync(at);
    } catch {
      return true;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
  }
  return true;
}

/**
 * Only ever remove or clean a verification's own directory (<root>/v<n>) or checkout
 * (<root>/v<n>/wt, or a slot <root>/slots/<project>/<k>), and never through a symlink.
 */
export function ownPath(root: string, path: string, leaf: "dir" | "wt"): boolean {
  if (!path.startsWith(root + sep)) return false;
  const rel = path.slice(root.length + 1);
  const named = leaf === "dir" ? /^v\d+$/.test(rel) : /^v\d+\/wt$/.test(rel) || slotRelative(rel);
  return named && noLinkBelow(root, rel);
}

type RemoveDeps = Pick<VerifyDeps, "db" | "git" | "root" | "log" | "now" | "config">;
type Removed = Pick<Verification, "id" | "worktree_path" | "project_path" | "project_id" | "task_id">;

/**
 * The end of a verification's use of its checkout: a slot's services are released (recorded) and its
 * untracked and ignored files removed, so it waits holding only the tracked tree; a verification's
 * own checkout (v<n>/wt: a fallback, or an older row) is removed. A slot whose release failed keeps
 * its tree and its `may_run` state, so the next use's start release runs where the services started.
 */
export async function endCheckout(deps: RemoveDeps, v: Removed): Promise<void> {
  if (!isSlotPath(deps.root, v.worktree_path)) return removeWorktree(deps, v);
  if (!existsSync(v.worktree_path)) return;
  if (!ownPath(deps.root, v.worktree_path, "wt")) {
    deps.log(`verify ${v.id}: not cleaning ${v.worktree_path}: it is not a verification checkout`);
    return;
  }
  if (!(await release(deps, v))) {
    deps.log(`verify ${v.id}: release failed; slot ${v.worktree_path} keeps its tree for the next use's release`);
    return;
  }
  recordSlotState(deps.db, v, "released", deps.now());
  const cleaned = await deps.git(["clean", "-ffdxq"], v.worktree_path);
  if (cleaned.code !== 0) deps.log(`verify ${v.id}: cleaning slot ${v.worktree_path} failed (${cleaned.stderr.trim() || `exit ${cleaned.code}`}); its next use resets it`);
}

/**
 * Under the repository's worktree lock (src/runtime/repo-lock.ts), like the add. The project's release
 * commands run first, outside the lock (they may take a minute each), so the steps' services go with it.
 */
async function removeWorktree(deps: RemoveDeps, v: Removed): Promise<void> {
  if (existsSync(v.worktree_path) && ownPath(deps.root, v.worktree_path, "wt")) await release(deps, v);
  await withRepoLock(v.project_path, () => removeWorktreeLocked(deps, v));
}

/** Free the checkout's own services; a failure appends verify.release_failed (the caller goes on). True when none failed. */
async function release(deps: RemoveDeps, v: Removed): Promise<boolean> {
  const label = `verify ${v.id}`;
  const commands = projectRelease(deps.config?.() ?? null, v.project_id, (line) => deps.log(`${label}: ${line}`));
  if (commands.length === 0) return true;
  const failed = failedReleases(await runRelease(commands, { cwd: v.worktree_path, env: releaseEnv(deps.db, v.project_id), label, log: deps.log }));
  if (failed.length === 0) return true;
  try {
    tx(deps.db, () => appendEvent(deps.db, { source: "daemon", kind: "verify.release_failed", taskId: v.task_id, payload: { verification: v.id, worktree: v.worktree_path, failed }, ts: deps.now() }));
  } catch (error) {
    deps.log(`${label}: could not record the failed release: ${(error as Error).message}`);
  }
  return false;
}

/** The checkout is git's top level at `path` and shares the project's repository (its common dir). */
async function checkoutOf(git: GitRunner, path: string, projectPath: string): Promise<boolean> {
  const args = ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"];
  const [own, project] = await Promise.all([git(args, path), git(["rev-parse", "--path-format=absolute", "--git-common-dir"], projectPath)]);
  if (own.code !== 0 || project.code !== 0) return false;
  const [top, common] = own.stdout.trim().split("\n");
  try {
    return realpathSync(top!) === realpathSync(path) && realpathSync(common!) === realpathSync(project.stdout.trim());
  } catch {
    return false;
  }
}

/** Exactly a fresh checkout of `head`: HEAD there, and git sees no change, no untracked and no ignored file. */
async function cleanAt(git: GitRunner, path: string, head: string): Promise<boolean> {
  const [at, status] = await Promise.all([git(["rev-parse", "HEAD"], path), git(["status", "--porcelain", "--ignored", "--untracked-files=all"], path)]);
  return at.code === 0 && at.stdout.trim() === head && status.code === 0 && status.stdout.trim() === "";
}

/** Make a tree writable for its removal (a read-only directory defeats both git clean and rm), never following a symlink. */
function makeWritable(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if ((stat.mode & 0o200) === 0) chmodSync(path, (stat.mode & 0o777) | 0o200);
  if (stat.isDirectory()) for (const entry of readdirSync(path)) makeWritable(join(path, entry));
}

/** Remove whatever is at the slot and check the head out there afresh, under the repository's worktree lock. Null when added; else why not. */
async function recreateSlot(deps: RemoveDeps, v: Removed & { head_sha: string }): Promise<string | null> {
  const slot = v.worktree_path;
  return withRepoLock(v.project_path, async () => {
    if (existsSync(slot)) {
      await deps.git(["worktree", "remove", "--force", slot], v.project_path);
      if (existsSync(slot)) {
        try {
          makeWritable(slot);
          rmSync(slot, { recursive: true, force: true });
        } catch (error) {
          return `removing it failed: ${(error as Error).message}`;
        }
      }
    }
    await deps.git(["worktree", "prune"], v.project_path);
    mkdirSync(dirname(slot), { recursive: true, mode: 0o700 });
    const added = await deps.git(["worktree", "add", "--detach", slot, v.head_sha], v.project_path);
    return added.code === 0 ? null : `git worktree add failed: ${added.stderr.trim() || added.stdout.trim()}`;
  });
}

/**
 * Whether a verification ending now leaves its slot as it is: a stop cut it off (kept for a resume),
 * or it never touched the slot (its last recorded user is another, whose state stays in force).
 */
function leavesSlot(deps: Pick<VerifyDeps, "db" | "root">, v: Pick<Verification, "id" | "worktree_path">, interrupted: boolean): boolean {
  return isSlotPath(deps.root, v.worktree_path) && (interrupted || slotState(deps.db, v.worktree_path)?.verification !== v.id);
}

/**
 * Make the verification's slot exactly a fresh checkout of its head. A slot of this project:
 * unless its recorded state says its services were released, they are released (by the commands of
 * the tree that started them); then this verification records the slot released, as its user, and
 * resets it: a forced checkout of the head and `git clean -ffdx`; anything else there, or a reset that
 * does not come out clean, is recreated once. Null when the slot is ready and proven clean; else why
 * the verification must not use it.
 */
async function prepareSlot(deps: VerifyDeps, v: Verification): Promise<string | null> {
  const slot = v.worktree_path;
  if (!ownPath(deps.root, slot, "wt")) return `${slot} is not a verification checkout (a symlink in its path?)`;
  const checkout = existsSync(slot) && (await checkoutOf(deps.git, slot, v.project_path));
  if (checkout && slotState(deps.db, slot)?.services !== "released" && !(await release(deps, v))) return "its release commands failed, so the previous verify's services may still run";
  recordSlotState(deps.db, v, "released", deps.now());
  if (checkout) {
    const checkedOut = await deps.git(["checkout", "--quiet", "--force", "--detach", v.head_sha], slot);
    if (checkedOut.code === 0) await deps.git(["clean", "-ffdxq"], slot);
    if (checkedOut.code === 0 && (await cleanAt(deps.git, slot, v.head_sha))) return null;
  }
  const failed = await recreateSlot(deps, v);
  if (failed) return failed;
  return (await cleanAt(deps.git, slot, v.head_sha)) ? null : "a fresh checkout there is not clean";
}

/** A slot that cannot be made clean: this verification checks out into its own directory (v<n>/wt), as before slots, with an event saying why. */
function fallBack(deps: VerifyDeps, v: Verification, why: string): Verification {
  const own = join(v.dir, "wt");
  deps.log(`verify ${v.id}: not using slot ${v.worktree_path}: ${why}; checking out into ${own}`);
  tx(deps.db, () => {
    deps.db.query("UPDATE verifications SET worktree_path = ?2 WHERE id = ?1").run(v.id, own);
    appendEvent(deps.db, { source: "daemon", kind: "verify.slot_fallback", taskId: v.task_id, payload: { verification: v.id, slot: v.worktree_path, why }, ts: deps.now() });
  });
  return { ...v, worktree_path: own };
}

async function removeWorktreeLocked(deps: RemoveDeps, v: Removed): Promise<void> {
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

const RUN_OUT = "timed out: the run's";

/** Whether a finished step's last attempt was killed at a deadline: its own (each attempt hung) or the run's. */
export function endedAtDeadline(step: Pick<VerifyStep, "attempts" | "hangs" | "detail">): boolean {
  const hangs = step.hangs ?? 0;
  return (hangs > 0 && hangs >= (step.attempts ?? 1)) || (step.detail?.includes(RUN_OUT) ?? false);
}

/**
 * Why a finished step ended as it did beyond its exit code, or null. `firstLog` is its first
 * attempt's log; `step.log` its last.
 */
function stepDetail(step: VerifyStep, result: StepResult, deadline: StepDeadline | null, plan: VerifyPlan, firstLog: string, stoppedBy: string | null): string | null {
  const runOut = `${RUN_OUT} ${duration(plan.timeoutMs)} were up`;
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

/** A step this verification kept from the one it resumes: not run again. */
function kept(step: VerifyStep): boolean {
  return step.resumed_from !== undefined && (step.state === "passed" || step.state === "skipped");
}

/** The logs of the passed steps, copied from `from`'s directory into this one's (a missing one is noted on its step). */
function copyLogs(from: Verification, v: Verification, steps: VerifyStep[]): void {
  for (const step of steps.filter((s) => s.state === "passed")) {
    const logs = (step.attempts ?? 1) > 1 ? [step.log.replace(/\.retry\.log$/, ".log"), step.log] : [step.log];
    for (const log of logs) {
      try {
        copyFileSync(join(from.dir, log), join(v.dir, log));
      } catch {
        step.detail = `${step.detail ?? ""}; its log ${log} was not kept`;
      }
    }
  }
}

/** Back to a fresh run: the kept steps wait again, with an event saying why. */
function dropResume(deps: VerifyDeps, v: Verification, steps: VerifyStep[], from: string, why: string): void {
  steps.forEach((step, i) => {
    if (!step.resumed_from) return;
    const fresh: VerifyStep = { name: step.name, state: "waiting", exit: null, ms: null, log: logName(i, step.name), tests: null, detail: null };
    if (step.group !== undefined) fresh.group = step.group;
    if (step.when_changed) fresh.when_changed = step.when_changed;
    steps[i] = fresh;
  });
  tx(deps.db, () => {
    deps.db.query("UPDATE verifications SET steps = ?2 WHERE id = ?1 AND state = 'running'").run(v.id, JSON.stringify(steps));
    appendEvent(deps.db, { source: "daemon", kind: "pr.verify_resume_dropped", taskId: v.task_id, payload: { verification: v.id, from, why }, ts: deps.now() });
  });
}

/**
 * A resumed verification runs in the slot of the one it resumes (admission gave it that slot, and
 * only while nothing used it since: src/verify/start.ts resumableFrom), untouched, so the steps it
 * keeps keep what they built, and copies their logs. True when it does; false (the kept steps reset,
 * an event saying why) when that checkout is gone or not at the head: then the slot is prepared afresh.
 */
async function resumeInSlot(deps: VerifyDeps, v: Verification, steps: VerifyStep[]): Promise<boolean> {
  const fromId = steps.find((s) => s.resumed_from)?.resumed_from;
  if (!fromId) return false;
  const from = getVerification(deps.db, fromId);
  const usable = from !== null && from.worktree_path === v.worktree_path && ownPath(deps.root, v.worktree_path, "wt") && existsSync(v.worktree_path);
  if (!usable || !(await checkoutOf(deps.git, v.worktree_path, v.project_path))) {
    dropResume(deps, v, steps, fromId, `the worktree of ${fromId} is gone`);
    return false;
  }
  const head = await deps.git(["rev-parse", "HEAD"], v.worktree_path);
  if (head.code !== 0 || head.stdout.trim() !== v.head_sha) {
    dropResume(deps, v, steps, fromId, `the worktree of ${fromId} is at ${head.stdout.trim().slice(0, 8) || "an unknown head"}, not ${v.head_sha.slice(0, 8)}`);
    return false;
  }
  copyLogs(from, v, steps.filter(kept));
  return true;
}

/** The head's tree and what its steps can read of the base, from the project's repository; null when git cannot say. */
async function reuseKey(deps: VerifyDeps, v: Verification, plan: VerifyPlan): Promise<ReuseKey | null> {
  const tree = await commitTree(deps.git, v.project_path, v.head_sha);
  if (tree === null) return null;
  const base = await baseKey(deps.git, v.project_path, v.head_sha, plan.base ?? null);
  return base === null ? null : { tree, base };
}

function sameKey(a: ReuseKey | null, b: ReuseKey | null): boolean {
  return a !== null && b !== null && a.tree === b.tree && a.base === b.base;
}

/**
 * A pass this verification may take instead of running its steps (docs/notes/2026-11-25-skip-a-batch-z7.md):
 * one of the same project under the same policy at the same tree and base that ran every step.
 * Its steps, logs and binary are copied here and the outcome names the verification that ran them;
 * null (run the steps) when there is none, this one is a flake rerun, it has a review step (the
 * reviewer reads the task's brief, which is not in the tree), or its binary is gone.
 */
function reusedPass(deps: VerifyDeps, v: Verification, steps: VerifyStep[], plan: VerifyPlan, key: ReuseKey): Omit<VerificationOutcome, "steps" | "tests"> | null {
  if (v.policy_id === null || steps.some((s) => s.rerun || s.name === REVIEW_STEP)) return null;
  const source = passedAtTree(deps.db, v.project_id, v.policy_id, key, v.id);
  if (!source) return null;
  // A pass from before the laws step checked no laws (the step is not part of the policy).
  if (steps.some((s) => s.name === LAWS_STEP) && !source.steps.some((s) => s.name === LAWS_STEP)) return null;
  const ran = source.reused_from ?? source.id;
  let binary: string | null = null;
  if (plan.binary) {
    if (!source.binary_path) return null;
    try {
      binary = keepBinary(dirname(source.binary_path), basename(source.binary_path), v.dir);
    } catch (error) {
      deps.log(`verify ${v.id}: not reusing ${ran}: ${(error as Error).message}`);
      return null;
    }
  }
  // A reused source's steps say so already.
  const taken = source.reused_from ? source.steps.map((s) => ({ ...s })) : source.steps.map((s) => ({ ...s, detail: `reused from ${ran}${s.detail ? `; ${s.detail}` : ""}` }));
  copyLogs(source, v, taken);
  steps.splice(0, steps.length, ...taken);
  deps.log(`verify ${v.id}: tree ${key.tree.slice(0, 8)} passed in ${ran} under the same steps and base; reusing it`);
  return { state: "passed", detail: `reused ${ran}: it passed the same tree ${key.tree.slice(0, 8)} with the same steps and base`, binary, key, reused_from: ran };
}

/** Run a verification to its end. Never throws: whatever happens is recorded on its row. */
export async function runVerification(deps: VerifyDeps, admitted: Verification, plan: VerifyPlan, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (active.has(admitted.id)) return;
  // Its checkout moves to its own directory when its slot cannot be made clean (fallBack).
  let v = admitted;
  const job: Job = { aborted: false, children: new Set(), calls: new Set() };
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
  // Its worktree stays for a resume (src/verify/start.ts resumableFrom): the steps that passed keep what they built.
  let interrupted = false;
  const stoppedMidRun = () => {
    interrupted = true;
    finish({ state: "error", detail: STOPPED_MID_RUN, binary: null }, true);
  };
  let worktreeAdded = false;
  try {
    mkdirSync(v.dir, { recursive: true, mode: 0o700 });
    const missing = await ensureHead(deps, v, plan);
    // Shutdown kills the setup's git (its fetch or worktree add): that failure is the stop, not the head's.
    if (job.aborted) return stoppedMidRun();
    if (missing) return finish({ state: "error", detail: missing, binary: null });
    // Before the slot is touched: a reused pass runs nothing there.
    const key = await reuseKey(deps, v, plan);
    if (job.aborted) return stoppedMidRun();
    const reused = key ? reusedPass(deps, v, steps, plan, key) : null;
    if (reused) return finish(reused);
    worktreeAdded = await resumeInSlot(deps, v, steps);
    if (job.aborted) return stoppedMidRun();
    if (!worktreeAdded && isSlotPath(deps.root, v.worktree_path)) {
      const unusable = await prepareSlot(deps, v);
      if (job.aborted) return stoppedMidRun();
      if (unusable === null) worktreeAdded = true;
      else v = fallBack(deps, v, unusable);
    }
    if (!worktreeAdded) {
      // One worktree change at a time per repository: concurrent adds collide in git itself.
      const added = await withRepoLock(v.project_path, () => deps.git(["worktree", "add", "--detach", v.worktree_path, v.head_sha], v.project_path));
      worktreeAdded = added.code === 0;
      if (job.aborted) return stoppedMidRun();
      if (!worktreeAdded) return finish({ state: "error", detail: `git worktree add failed: ${added.stderr.trim() || added.stdout.trim()}`, binary: null });
    }
    const childEnv = stepEnv(env, plan.path);
    const deadlines = stepDeadlines(deps.db, v.project_id, steps.map((s) => s.name), plan.stepTimeoutMs ?? null);
    steps.forEach((s, i) => (s.deadline_ms = deadlines[i]?.ms ?? null));
    // Read once per verification, and only when a step has when_changed globs.
    const changed = steps.some((s) => (s.when_changed?.length ?? 0) > 0) ? await changedSinceBase(deps.git, v.worktree_path, plan.base ?? null) : null;
    if (job.aborted) return stoppedMidRun();

    /** One step to its end: run, and once more when its own deadline killed it and the run has time left. */
    const runOne = async (i: number, handle: StepHandle, stoppedBy: () => string | null): Promise<void> => {
      const step = steps[i]!;
      if (kept(step)) return;
      const gate = changeGate(step, changed);
      if ("skip" in gate) {
        Object.assign(step, { state: "skipped", ms: 0, detail: gate.skip });
        record(step);
        return;
      }
      const deadline = deadlines[i] ?? null;
      const firstLog = step.log;
      const began = Date.now();
      let result: StepResult = { exit: 127, timedOut: null, stopped: false };
      let lawsNote: string | null = null;
      step.hangs = 0;
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (stoppedBy() !== null) {
          result = { ...result, stopped: true };
          break;
        }
        step.attempts = attempt;
        step.log = attempt === 1 ? firstLog : retryLogName(firstLog);
        step.state = "running";
        step.started_at = deps.now();
        record(step);
        if (step.name === REVIEW_STEP) {
          result = await reviewStep(deps, job, v, plan, join(v.dir, step.log), runDeadline);
          if (result.timedOut === "step") step.hangs++;
          break;
        }
        if (step.name === LAWS_STEP) {
          const laws = await lawsStep(deps, job, v, plan, join(v.dir, step.log), childEnv, deadline ? Date.now() + deadline.ms : runDeadline, runDeadline);
          ({ laws: step.laws, summary: lawsNote } = laws);
          result = laws;
          break;
        }
        result = await runStep(
          job,
          {
            command: step.rerun ? repeatedCommand(step.rerun.command, step.rerun.passes) : step.name,
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
      // The laws step's log holds only the tails of failing enforcers: never the suite's counts.
      step.tests = step.name === LAWS_STEP ? null : parseBunSummary(readTail(join(v.dir, step.log)));
      step.state = result.stopped ? "stopped" : result.exit === 0 && result.timedOut === null ? "passed" : "failed";
      step.detail = [gate.note, rerunNote(step), lawsNote, stepDetail(step, result, deadline, plan, firstLog, stoppedBy())].filter((d) => d !== null).join("; ") || null;
      if (result.note !== undefined && result.timedOut !== "run") step.detail = `${result.timedOut === "step" ? "the review timed out" : "the review gave no verdict"}: ${result.note}`;
      record(step);
    };

    if (isSlotPath(deps.root, v.worktree_path)) recordSlotState(deps.db, v, "may_run", deps.now());
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
    // Reusable later only when every step ran here and the base its steps read did not move under them.
    const after = key && !steps.some(kept) ? await reuseKey(deps, v, plan) : null;
    return finish({ state: "passed", detail: recovered.length > 0 ? recovered.join("; ") : null, binary, key: sameKey(key, after) ? key : null });
  } catch (error) {
    deps.log(`verify ${v.id}: ${(error as Error).stack ?? String(error)}`);
    finish({ state: "error", detail: `verify failed: ${(error as Error).message}`, binary: null });
  } finally {
    try {
      if (leavesSlot(deps, v, interrupted)) deps.log(`verify ${v.id}: slot ${v.worktree_path} stays as it is, for a resume or as its last user left it`);
      else if (worktreeAdded || existsSync(v.worktree_path)) await endCheckout(deps, v);
      pruneDirs(deps, v.project_id);
    } catch (error) {
      deps.log(`verify ${v.id}: cleanup failed: ${(error as Error).message}`);
    }
    // After the steps' groups are killed (runStep) and the checkout is cleaned or gone: a failure is logged above,
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
    for (const call of job.calls) call.abort();
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
    const detail = stepGone ? STOPPED_MID_RUN : `${STOPPED_MID_RUN}; its step${left.length > 1 ? "s" : ""} (pid ${left.join(", ")}) did not exit`;
    recorded = tx(deps.db, () => {
      const finished = finishVerification(deps.db, v, { state: "error", steps: v.steps, tests: lastTests(v.steps), detail, binary: null }, deps.now());
      if (finished) requeueInterrupted(deps, v);
      return finished;
    });
  }
  if (!stepGone) return recorded;
  if (v && !leavesSlot(deps, v, recorded)) await endCheckout(deps, v).catch((error: unknown) => deps.log(`verify ${id}: cleanup failed: ${(error as Error).message}`));
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
 * recorded as an error (and requeued once, at the front; a slot's checkout kept
 * for a resume), any other's checkout cleaned or removed, and then its slot released
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
