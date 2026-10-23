import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HarnessId } from "../harness/types.ts";
import { writeFileAtomic } from "../util/fsx.ts";

/**
 * Every run's private temp directory (docs/notes/2026-10-22-give-every-worker-73.md):
 * `<[workers] tmp_root>/<last 12 of the run id>`, made by the launcher, its
 * path in the worker's TMPDIR, removed when the run's cleanup removes its
 * worktree. A worker's commands see the same TMPDIR inside Claude's Bash
 * sandbox and outside it, so a file one writes is the file the other reads,
 * and no two runs share one.
 *
 * Claude's sandbox ignores an inherited TMPDIR: it sets
 * `$CLAUDE_CODE_TMPDIR/claude-<uid>`, but only while that path is at most
 * CLAUDE_TMP_MAX_BYTES, falling back to the shared `/tmp/claude-<uid>` past
 * it (read in Claude 2.1.309). So a Claude worker's TMPDIR is that subdir,
 * the root lives under /tmp (a state-dir path is far too long), and a launch
 * whose path would not fit is refused rather than left to share.
 */

/** Claude's limit on its per-uid temp dir (2.1.309); longer, and its sandbox uses the shared `/tmp/claude-<uid>`. */
export const CLAUDE_TMP_MAX_BYTES = 44;

/** Run ids are ULIDs: their last 12 characters are 60 random bits, so unique among runs in practice. */
const NAME_LENGTH = 12;

/** Names the run and Flowryn home that own a run temp dir; nothing is removed without it. */
const OWNER_FILE = ".flowryn-run";

interface Owner {
  run: string;
  state_dir: string;
}

function uid(): number {
  return process.getuid?.() ?? 0;
}

/** `[workers] tmp_root` when unset: per user, and short enough for Claude's limit. */
export function defaultTmpRoot(): string {
  return `/tmp/fw-${uid()}`;
}

export function runTmpDir(root: string, runId: string): string {
  return join(root, runId.slice(-NAME_LENGTH));
}

/** The TMPDIR a worker sees: Claude's per-uid subdir of its CLAUDE_CODE_TMPDIR, or the run dir itself. */
export function workerTmpDir(harness: HarnessId, dir: string): string {
  return harness === "claude" ? join(dir, `claude-${uid()}`) : dir;
}

/** The variables a worker's pane gets, so its temp files land in the run's directory in and out of the sandbox. */
export function workerTmpEnv(harness: HarnessId, dir: string): Record<string, string> {
  const tmp = workerTmpDir(harness, dir);
  return harness === "claude" ? { CLAUDE_CODE_TMPDIR: dir, TMPDIR: tmp } : { TMPDIR: tmp };
}

/**
 * Make `path` a directory only this user can enter, or refuse it. /tmp is
 * shared, so an existing one proves nothing: it must be a plain directory
 * (not a symlink), owned by this user, closed to group and others.
 */
function privateDir(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${path} is not a plain directory`);
  if (st.uid !== uid()) throw new Error(`${path} is owned by uid ${st.uid}, not this user (${uid()})`);
  if ((st.mode & 0o077) !== 0) throw new Error(`${path} is open to other users (mode ${(st.mode & 0o777).toString(8)}); it must be 700`);
}

function readOwner(dir: string): Owner | null {
  try {
    const owner = JSON.parse(readFileSync(join(dir, OWNER_FILE), "utf8")) as Partial<Owner>;
    return typeof owner.run === "string" && typeof owner.state_dir === "string" ? { run: owner.run, state_dir: owner.state_dir } : null;
  } catch {
    return null;
  }
}

export interface RunTmp {
  /** The run's directory (Claude's CLAUDE_CODE_TMPDIR). */
  dir: string;
  /** The worker's TMPDIR. */
  workerTmp: string;
  /** The paths the worker's sandbox may write: the directory, and its realpath when that differs (/tmp is /private/tmp on macOS). */
  writable: string[];
}

/**
 * The run's temp directory, made (or found again, on a resume) and checked.
 * Throws, failing the launch, when a path is not private, another run or
 * Flowryn home owns the directory, or a Claude path is too long.
 */
export function ensureRunTmp(opts: { root: string; runId: string; stateDir: string; harness: HarnessId }): RunTmp {
  const dir = runTmpDir(opts.root, opts.runId);
  const workerTmp = workerTmpDir(opts.harness, dir);
  const bytes = Buffer.byteLength(workerTmp);
  if (opts.harness === "claude" && bytes > CLAUDE_TMP_MAX_BYTES) {
    throw new Error(
      `the worker temp dir ${workerTmp} is ${bytes} bytes, over the ${CLAUDE_TMP_MAX_BYTES} Claude's sandbox keeps (it would fall back to the shared /tmp/claude-${uid()}); set a shorter [workers] tmp_root`,
    );
  }
  mkdirSync(dirname(opts.root), { recursive: true, mode: 0o700 });
  privateDir(opts.root);
  privateDir(dir);
  const owner = readOwner(dir);
  if (owner && (owner.run !== opts.runId || owner.state_dir !== opts.stateDir)) {
    throw new Error(`${dir} belongs to run ${owner.run} of ${owner.state_dir}, not ${opts.runId}`);
  }
  if (!owner) writeFileAtomic(join(dir, OWNER_FILE), JSON.stringify({ run: opts.runId, state_dir: opts.stateDir } satisfies Owner) + "\n", 0o600);
  if (workerTmp !== dir) privateDir(workerTmp);
  return { dir, workerTmp, writable: [...new Set([dir, realpathSync(dir)])] };
}

/** Whether `dir` is a plain directory whose owner file names this run of this home. */
function owned(dir: string, owner: Owner): boolean {
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== uid()) return false;
  } catch {
    return false;
  }
  const found = readOwner(dir);
  return found !== null && found.run === owner.run && found.state_dir === owner.state_dir;
}

/** Remove a run's temp directory: "absent" when there is none, "not_ours" when its owner file names another run or home (left alone). */
export function removeRunTmp(opts: { root: string; runId: string; stateDir: string }): "removed" | "absent" | "not_ours" {
  const dir = runTmpDir(opts.root, opts.runId);
  if (!existsSync(dir)) return "absent";
  if (!owned(dir, { run: opts.runId, state_dir: opts.stateDir })) return "not_ours";
  rmSync(dir, { recursive: true, force: true });
  return "removed";
}

export interface SweepResult {
  removed: string[];
  failed: { dir: string; error: string }[];
}

/**
 * At daemon start: remove the run temp dirs this home owns whose run `keep`
 * no longer wants (gone, or cleaned up), and any whose owning home is gone
 * (a deleted contract scratch home). Another live home's dirs are never
 * touched; nor is a root that is not this user's private directory.
 */
export function sweepRunTmp(opts: { root: string; stateDir: string; keep(runId: string): boolean }): SweepResult {
  const result: SweepResult = { removed: [], failed: [] };
  try {
    const st = lstatSync(opts.root);
    if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== uid()) return result;
  } catch {
    return result;
  }
  for (const name of readdirSync(opts.root)) {
    const dir = join(opts.root, name);
    const owner = readOwner(dir);
    if (!owner || !owned(dir, owner)) continue;
    const orphan = owner.state_dir === opts.stateDir ? !opts.keep(owner.run) : !existsSync(owner.state_dir);
    if (!orphan) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
      result.removed.push(dir);
    } catch (error) {
      result.failed.push({ dir, error: (error as Error).message });
    }
  }
  return result;
}
