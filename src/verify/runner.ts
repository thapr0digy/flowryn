import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, rmSync, statSync, symlinkSync } from "node:fs";
import { constants } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import type { Db } from "../db/db.ts";
import { tx } from "../db/db.ts";
import type { GitRunner } from "../policy/landed.ts";
import { finishVerification, recordSteps, runningVerifications, type Verification, type VerificationOutcome, type VerifyStep } from "./store.ts";
import { parseBunSummary, type TestCounts } from "./summary.ts";

/**
 * One `flowryn verify` job, run by the daemon (outside every sandbox): make
 * sure the PR head is in the project's object store, add a detached worktree
 * at it, run the configured steps in order through /bin/sh with a scrubbed
 * environment, parse bun's test summary from each step's output, copy the
 * built binary out, record the outcome, and remove the worktree. One job per
 * daemon at a time (the verb refuses a second).
 */

export interface VerifyDeps {
  db: Db;
  git: GitRunner;
  now(): number;
  log(message: string): void;
  /** Where verification directories live: <state_dir>/verify. */
  root: string;
}

export interface VerifyPlan {
  prNumber: number;
  headRef: string;
  binary: string | null;
  timeoutMs: number;
  /** The PATH of whoever ran `flowryn verify` (launchd's is short: it has no ~/.bun/bin); the daemon's when none came. */
  path: string | null;
}

/** Finished verification directories kept per project (binary and logs); older ones are removed. */
export const KEEP_PER_PROJECT = 3;
/** How much of a step's output the summary parser and the failure tail read. */
const TAIL_BYTES = 256 * 1024;
const KILL_GRACE_MS = 5_000;

interface Job {
  aborted: boolean;
  child: ChildProcess | null;
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

export function initialSteps(steps: string[]): VerifyStep[] {
  return steps.map((name, i) => ({ name, state: "waiting", exit: null, ms: null, log: logName(i, name), tests: null, detail: null }));
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

/** Bring the head into the object store: already there (a worker's commit), the PR ref, or the head branch. Writes no ref. */
async function ensureHead(deps: VerifyDeps, v: Verification, plan: VerifyPlan): Promise<string | null> {
  if (await hasCommit(deps.git, v.project_path, v.head_sha)) return null;
  const tried: string[] = [];
  for (const ref of [`refs/pull/${plan.prNumber}/head`, `refs/heads/${plan.headRef}`]) {
    // An empty --refmap keeps the fetch from updating origin's remote-tracking branches as a side effect.
    const fetched = await deps.git(["fetch", "--no-tags", "--quiet", "--refmap=", "origin", ref], v.project_path);
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
  timedOut: boolean;
}

/** Run one step in its own process group, its output to its log; the whole group is killed at the deadline. */
function runStep(job: Job, command: string, cwd: string, logPath: string, deadline: number, env: Record<string, string>): Promise<StepResult> {
  return new Promise((resolve) => {
    const fd = openSync(logPath, "w", 0o600);
    let child: ChildProcess;
    try {
      child = spawn("/bin/sh", ["-c", command], { cwd, env, stdio: ["ignore", fd, fd], detached: true });
    } catch {
      closeSync(fd);
      resolve({ exit: 127, timedOut: false });
      return;
    }
    job.child = child;
    let timedOut = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      grace = setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS);
    }, Math.max(0, deadline - Date.now()));
    const done = (exit: number) => {
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      // A step's leftovers (a server it started) go with it.
      killGroup(child, "SIGKILL");
      closeSync(fd);
      job.child = null;
      resolve({ exit, timedOut });
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

/** Run a verification to its end. Never throws: whatever happens is recorded on its row. */
export async function runVerification(deps: VerifyDeps, v: Verification, plan: VerifyPlan, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (active.has(v.id)) return;
  const job: Job = { aborted: false, child: null };
  active.set(v.id, job);
  const steps = v.steps.map((s) => ({ ...s }));
  const finish = (outcome: Omit<VerificationOutcome, "steps" | "tests">) => {
    try {
      tx(deps.db, () => finishVerification(deps.db, v, { ...outcome, steps, tests: lastTests(steps) }, deps.now()));
    } catch (error) {
      deps.log(`verify ${v.id}: could not record the outcome: ${(error as Error).message}`);
    }
  };
  let worktreeAdded = false;
  try {
    mkdirSync(v.dir, { recursive: true, mode: 0o700 });
    const missing = await ensureHead(deps, v, plan);
    if (missing) return finish({ state: "error", detail: missing, binary: null });
    const added = await deps.git(["worktree", "add", "--detach", v.worktree_path, v.head_sha], v.project_path);
    if (added.code !== 0) return finish({ state: "error", detail: `git worktree add failed: ${added.stderr.trim() || added.stdout.trim()}`, binary: null });
    worktreeAdded = true;
    const deadline = v.started_at + plan.timeoutMs;
    const childEnv = stepEnv(env, plan.path);
    for (const step of steps) {
      if (job.aborted) return finish({ state: "error", detail: "the daemon stopped mid-run", binary: null });
      step.state = "running";
      tx(deps.db, () => recordSteps(deps.db, v, steps, null, deps.now()));
      const began = Date.now();
      const result = await runStep(job, step.name, v.worktree_path, join(v.dir, step.log), deadline, childEnv);
      step.ms = Date.now() - began;
      step.exit = result.exit;
      step.tests = parseBunSummary(readTail(join(v.dir, step.log)));
      step.state = result.exit === 0 && !result.timedOut ? "passed" : "failed";
      if (result.timedOut) step.detail = `timed out: the run's ${Math.round(plan.timeoutMs / 60_000)} min were up`;
      tx(deps.db, () => recordSteps(deps.db, v, steps, step, deps.now()));
      if (job.aborted) return finish({ state: "error", detail: "the daemon stopped mid-run", binary: null });
      if (step.state === "failed") return finish({ state: "failed", detail: step.detail ?? `${step.name} exited ${step.exit}`, binary: null });
    }
    let binary: string | null = null;
    if (plan.binary) {
      try {
        binary = keepBinary(v.worktree_path, plan.binary, v.dir);
      } catch (error) {
        return finish({ state: "failed", detail: (error as Error).message, binary: null });
      }
    }
    return finish({ state: "passed", detail: null, binary });
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
    active.delete(v.id);
  }
}

/** Daemon shutdown: stop every running step; each job records itself as stopped. */
export function stopVerifications(): void {
  for (const job of active.values()) {
    job.aborted = true;
    if (job.child) killGroup(job.child, "SIGKILL");
  }
}

/**
 * Daemon startup: a verification still running belongs to a daemon that is
 * gone. It is recorded as an error and its worktree removed.
 */
export async function recoverVerifications(deps: VerifyDeps): Promise<number> {
  const stale = runningVerifications(deps.db).filter((v) => !active.has(v.id));
  for (const v of stale) {
    tx(deps.db, () => finishVerification(deps.db, v, { state: "error", steps: v.steps, tests: lastTests(v.steps), detail: "the daemon stopped mid-run", binary: null }, deps.now()));
    await removeWorktree(deps, v).catch((error: unknown) => deps.log(`verify ${v.id}: cleanup failed: ${(error as Error).message}`));
  }
  return stale.length;
}
