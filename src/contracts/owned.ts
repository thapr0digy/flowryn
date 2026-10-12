import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { stateFiles } from "../config/paths.ts";
import { openDb } from "../db/db.ts";
import { HerdrClient } from "../runtime/herdr/client.ts";
import { HerdrRuntime } from "../runtime/herdr/runtime.ts";
import { terminate, type ProcIdentity, type TerminateResult } from "../runtime/proc.ts";
import { createdWorktrees, removeOwnWorktrees, type GitRun } from "./cleanup.ts";

/**
 * What a contract run owns, written where its owner can read it after the
 * run is gone (docs/notes/2026-10-12-next-steps-md-e7.md). The runner
 * (`runContract`) writes the manifest as it creates things and records its own
 * cleanup at the end; the daemon's automatic check gives it the path and,
 * when the runner was killed or its cleanup failed, releases the same exact
 * ids itself (`recoverOwned`). Nothing is found by label: a workspace by its
 * id, a process by pid, start time and executable, a worktree by the run's
 * branch prefix, the scratch home by its path, and only a `fwc-*` one.
 */

export interface CleanupOutcome {
  ok: boolean;
  /** What was left, one line each; empty when ok. */
  problems: string[];
  /** Who released the resources: the runner itself, or the daemon after it. */
  by: "runner" | "daemon";
  at: number;
}

export interface OwnedResources {
  /** The runner, so its owner can tell whether it still runs (and stop its group). */
  runner: ProcIdentity | null;
  /** The scratch Flowryn home: its daemon's database names the workspaces and harnesses below. */
  home: string;
  herdr_socket: string;
  /** The run's own branch prefix (`flowryn/contract-<id>-`). */
  branch_prefix: string;
  /** The caller's checkout its worktrees were made in; null for the scratch repository, which goes with the home. */
  project: string | null;
  /** The scratch daemon, once spawned. */
  daemon: ProcIdentity | null;
  /** Copied in from the scratch database when cleanup starts; the database is read again on recovery. */
  workspaces: string[];
  harnesses: ProcIdentity[];
  /** The runner's cleanup outcome; null while it runs, or when it never finished. */
  cleanup: CleanupOutcome | null;
}

/** The environment variable that names the manifest of a `doctor --contracts --for-daemon` run. */
export const MANIFEST_ENV = "FLOWRYN_CONTRACT_MANIFEST";

/** Write the manifest whole: a reader never sees half of one. */
export function writeManifest(path: string, owned: OwnedResources): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(owned, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, path);
}

function identity(value: unknown): ProcIdentity | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return typeof v.pid === "number" && Number.isInteger(v.pid) && v.pid > 0 && typeof v.start === "number" && typeof v.exe === "string" && v.exe !== ""
    ? { pid: v.pid, start: v.start, exe: v.exe }
    : null;
}

/** The manifest at `path`, or why it cannot be read; null when there is none. */
export function readManifest(path: string): { owned: OwnedResources | null; problem: string | null } {
  if (!existsSync(path)) return { owned: null, problem: null };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    return { owned: null, problem: `its manifest ${path} is unreadable: ${(error as Error).message}` };
  }
  if (typeof raw.home !== "string" || typeof raw.herdr_socket !== "string" || typeof raw.branch_prefix !== "string") {
    return { owned: null, problem: `its manifest ${path} lacks the scratch home, Herdr socket or branch prefix` };
  }
  const cleanup = raw.cleanup as CleanupOutcome | null | undefined;
  return {
    owned: {
      runner: identity(raw.runner),
      home: raw.home,
      herdr_socket: raw.herdr_socket,
      branch_prefix: raw.branch_prefix,
      project: typeof raw.project === "string" ? raw.project : null,
      daemon: identity(raw.daemon),
      workspaces: Array.isArray(raw.workspaces) ? raw.workspaces.filter((w): w is string => typeof w === "string") : [],
      harnesses: Array.isArray(raw.harnesses) ? raw.harnesses.map(identity).filter((p): p is ProcIdentity => p !== null) : [],
      cleanup: cleanup && typeof cleanup === "object" && typeof cleanup.ok === "boolean" ? cleanup : null,
    },
    problem: null,
  };
}

function scratchDb<T>(home: string, read: (db: ReturnType<typeof openDb>) => T, fallback: T): T {
  const path = stateFiles(join(home, "state")).db;
  if (!existsSync(path)) return fallback;
  const db = openDb(path, { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** The Herdr workspaces the scratch daemon opened. */
export function createdWorkspaces(home: string): string[] {
  return scratchDb(home, (db) => (db.query("SELECT workspace_id FROM runs WHERE workspace_id IS NOT NULL").all() as { workspace_id: string }[]).map((r) => r.workspace_id), []);
}

/** The harness processes the scratch daemon recorded. */
export function harnessProcesses(home: string): ProcIdentity[] {
  return scratchDb(
    home,
    (db) =>
      (
        db.query("SELECT proc_pid, proc_start, proc_exe FROM runs WHERE proc_pid IS NOT NULL AND proc_start IS NOT NULL AND proc_exe IS NOT NULL").all() as {
          proc_pid: number;
          proc_start: number;
          proc_exe: string;
        }[]
      ).map((r) => ({ pid: r.proc_pid, start: r.proc_start, exe: r.proc_exe })),
    [],
  );
}

/** Merge the ids the manifest copied with those the scratch database still names. */
export function withScratchIds(owned: OwnedResources): OwnedResources {
  const workspaces = [...new Set([...owned.workspaces, ...createdWorkspaces(owned.home)])];
  const harnesses = [...owned.harnesses];
  for (const proc of harnessProcesses(owned.home)) if (!harnesses.some((h) => h.pid === proc.pid && h.start === proc.start)) harnesses.push(proc);
  return { ...owned, workspaces, harnesses };
}

/** Each bounded step of releasing what a contract run owns; the runner's cleanup budget is their sum (src/contracts/runner.ts). */
export const RELEASE_LIMITS = {
  /** Each workspace close: a request with this deadline. */
  workspaceCloseMs: 5_000,
  /** Each process: SIGTERM, this grace, then SIGKILL and up to 2 s more (terminate in src/runtime/proc.ts). */
  processGraceMs: 10_000,
  processKillMs: 2_000,
  /** git worktree remove and branch -D on the caller's checkout. */
  worktreesMs: 5_000,
};

export interface ReleaseDeps {
  git: GitRun;
  log(line: string): void;
  /** Remove the scratch home; false when it would not go (src/contracts/runner.ts removeScratchHome). */
  removeHome(home: string): Promise<boolean>;
  terminate?: (proc: ProcIdentity, options: { group: boolean; graceMs: number }) => Promise<TerminateResult>;
  closeWorkspace?: (socket: string, workspaceId: string, timeoutMs: number) => Promise<void>;
}

async function closeInHerdr(socket: string, workspaceId: string, timeoutMs: number): Promise<void> {
  const runtime = new HerdrRuntime(new HerdrClient(socket));
  await runtime.closeWorkspace(workspaceId, timeoutMs);
}

/** A scratch home the release may remove: an absolute, real `fwc-*` directory (never a symlink, never anything else). */
export function removableHome(home: string): string | null {
  if (!isAbsolute(home) || !basename(home).startsWith("fwc-")) return `${home} is not a contract scratch home`;
  if (!existsSync(home)) return null;
  const stat = lstatSync(home);
  return stat.isDirectory() && !stat.isSymbolicLink() ? null : `${home} is not a directory`;
}

/**
 * Release what a run owns once its scratch daemon is down: close each
 * workspace by id, end each harness by identity (its group), remove the
 * run's own worktrees from the caller's checkout, then the scratch home.
 * Returns what was left, one line each; nothing else is touched.
 */
export async function releaseOwned(owned: OwnedResources, deps: ReleaseDeps): Promise<string[]> {
  const problems: string[] = [];
  const end = deps.terminate ?? ((proc, options) => terminate(proc, options));
  const close = deps.closeWorkspace ?? closeInHerdr;
  for (const ws of owned.workspaces) {
    try {
      await close(owned.herdr_socket, ws, RELEASE_LIMITS.workspaceCloseMs);
    } catch (error) {
      problems.push(`Herdr workspace ${ws} not closed: ${(error as Error).message}`);
    }
  }
  // Nothing that writes into the scratch home may outlive it: a worker still exiting would spool its hooks there.
  for (const proc of owned.harnesses) {
    const ended = await end(proc, { group: true, graceMs: RELEASE_LIMITS.processGraceMs });
    if (!ended.ok) problems.push(`harness pid ${proc.pid} did not exit (${ended.signal}, ${ended.evidence})`);
  }
  // Only a caller's own checkout has git state to undo; a scratch repository goes with the scratch home.
  if (owned.project) {
    try {
      const created = createdWorktrees(stateFiles(join(owned.home, "state")).db);
      problems.push(...removeOwnWorktrees(owned.project, created, owned.branch_prefix, join(owned.home, "wt"), deps.git, deps.log));
    } catch (error) {
      problems.push(`worktrees in ${owned.project} not removed: ${(error as Error).message}`);
    }
  }
  const refused = removableHome(owned.home);
  if (refused) problems.push(`scratch home left alone: ${refused}`);
  else if (existsSync(owned.home) && !(await deps.removeHome(owned.home))) problems.push(`scratch home ${owned.home} not removed`);
  return problems;
}

export interface RecoverDeps extends ReleaseDeps {
  now(): number;
}

/**
 * The daemon's recovery after a contract run it owned ended without a clean
 * cleanup of its own (killed, or its cleanup failed): stop the runner if it
 * still runs (by identity, its whole group), then the scratch daemon, then
 * release every id the manifest and the scratch database name. A failure is
 * returned, never thrown: the caller records it as an explicit cleanup failure.
 */
export async function recoverOwned(manifestPath: string, deps: RecoverDeps): Promise<CleanupOutcome> {
  const outcome = (problems: string[]): CleanupOutcome => ({ ok: problems.length === 0, problems, by: "daemon", at: deps.now() });
  const read = readManifest(manifestPath);
  if (read.problem) return outcome([read.problem]);
  if (!read.owned) return outcome([`no manifest at ${manifestPath}: what the run owned is unknown`]);
  const end = deps.terminate ?? ((proc, options) => terminate(proc, options));
  const problems: string[] = [];
  // The runner leads its own process group (the daemon spawns it detached), so its group goes with it; the
  // scratch daemon is in that group, not a leader, so it is ended by its own pid. A gone or reused pid is left alone.
  for (const [what, proc, group] of [
    ["the runner", read.owned.runner, true],
    ["the scratch daemon", read.owned.daemon, false],
  ] as const) {
    if (!proc) continue;
    const ended = await end(proc, { group, graceMs: RELEASE_LIMITS.processGraceMs });
    if (!ended.ok) problems.push(`${what} (pid ${proc.pid}) did not exit (${ended.signal}, ${ended.evidence})`);
  }
  let owned: OwnedResources;
  try {
    owned = withScratchIds(read.owned);
  } catch (error) {
    problems.push(`the scratch database in ${read.owned.home} is unreadable: ${(error as Error).message}`);
    owned = read.owned;
  }
  problems.push(...(await releaseOwned(owned, deps)));
  const result = outcome(problems);
  try {
    writeManifest(manifestPath, { ...owned, cleanup: result });
  } catch (error) {
    deps.log(`contracts: could not record the recovery in ${manifestPath}: ${(error as Error).message}`);
  }
  return result;
}
