import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The test suite's process guard (docs/notes/2026-11-21-stop-the-test-8a.md).
 * Every bun test process gets a reaper sidecar (test/helpers/reaper.ts) that
 * samples the process table and remembers each process ever seen under the
 * test process, by pid and start time. When the test process dies, however it
 * dies (a clean end, Ctrl-C, a verify deadline's SIGKILL), the reaper ends what
 * it remembered that is still alive, even after launchd adopted it. After each
 * file (each run, without --parallel) the preload fails the run on any of them
 * still alive, and ends them.
 *
 * Only remembered processes are ever signalled, and only while the pid still
 * carries the start time it was seen with: never a match on names over the
 * whole system, so a reused pid or the user's own Claude sessions are safe.
 */

/** One row of `ps -axo pid=,ppid=,lstart=,command=`. */
export interface PsRow {
  pid: number;
  ppid: number;
  /** ps lstart, whitespace folded: with the pid, the identity (pids are reused, start times are not, to the second). */
  start: string;
  command: string;
}

/** A process seen under the test process. */
export interface Tracked {
  pid: number;
  start: string;
  command: string;
}

/** The sidecar's file: who the reaper is and what it remembers. */
export interface GuardState {
  /** The test process it watches. */
  parent: number;
  reaper: number;
  tracked: Tracked[];
}

const ROW = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;

export function parsePsTable(text: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of text.split("\n")) {
    const match = ROW.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), start: match[3]!.replace(/\s+/g, " "), command: match[4]!.trim() });
  }
  return rows;
}

/** The whole process table, or null when ps cannot answer (a failed read never reads as "nothing alive"). */
export function readPsTable(): PsRow[] | null {
  const read = Bun.spawnSync(["/bin/ps", "-axo", "pid=,ppid=,lstart=,command="], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...process.env, LC_ALL: "C" }, timeout: 5_000 });
  if (read.exitCode !== 0) return null;
  // ps lists itself, a child of this process: never a leak.
  const rows = parsePsTable(read.stdout.toString()).filter((row) => row.pid !== read.pid);
  return rows.length > 0 ? rows : null;
}

export function key(p: { pid: number; start: string }): string {
  return `${p.pid}@${p.start}`;
}

/** Every process under `root` (not root itself), leaving out each excluded pid and everything under it. */
export function descendants(rows: PsRow[], root: number, exclude: ReadonlySet<number> = new Set()): PsRow[] {
  const children = new Map<number, PsRow[]>();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const found: PsRow[] = [];
  const seen = new Set<number>([root]);
  const queue = [root];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (seen.has(child.pid) || exclude.has(child.pid)) continue;
      seen.add(child.pid);
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

/**
 * One sample: remember what is under `root` now, forget what has exited (its
 * pid gone, or carrying another start time). Returns whether the set changed.
 */
export function track(tracked: Map<string, Tracked>, rows: PsRow[], root: number, exclude: ReadonlySet<number>): boolean {
  let changed = false;
  const alive = new Set(rows.map(key));
  for (const k of tracked.keys()) {
    if (!alive.has(k)) {
      tracked.delete(k);
      changed = true;
    }
  }
  for (const row of descendants(rows, root, exclude)) {
    const k = key(row);
    if (tracked.has(k)) continue;
    tracked.set(k, { pid: row.pid, start: row.start, command: row.command });
    changed = true;
  }
  return changed;
}

/** The remembered processes still alive as themselves: the same pid with the same start time. Nothing else is ever returned. */
export function survivors(tracked: Iterable<Tracked>, rows: PsRow[]): PsRow[] {
  const byKey = new Map(rows.map((row) => [key(row), row]));
  const found: PsRow[] = [];
  for (const t of tracked) {
    const row = byKey.get(key(t));
    if (row) found.push(row);
  }
  return found;
}

/**
 * Signal each target still alive as itself, checked against a fresh read just
 * before: a pid that exited and was reused in between is left alone.
 */
export function signalIfSame(targets: Tracked[], signal: NodeJS.Signals, kill: (pid: number, signal: NodeJS.Signals) => void = (pid, s) => process.kill(pid, s)): number[] {
  const rows = readPsTable();
  if (!rows) return [];
  const sent: number[] = [];
  for (const row of survivors(targets, rows)) {
    try {
      kill(row.pid, signal);
      sent.push(row.pid);
    } catch {
      // exited in between
    }
  }
  return sent;
}

/** SIGTERM (a daemon then ends its own children), wait up to `graceMs`, SIGKILL what is left. Returns what outlived SIGKILL. */
export async function endTracked(targets: Tracked[], graceMs: number): Promise<PsRow[]> {
  const left = (): PsRow[] => {
    const rows = readPsTable();
    return rows ? survivors(targets, rows) : targets.map((t) => ({ ...t, ppid: 0 }));
  };
  if (left().length === 0) return [];
  signalIfSame(targets, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (left().length === 0) return [];
    await Bun.sleep(100);
  }
  signalIfSame(targets, "SIGKILL");
  await Bun.sleep(200);
  return left();
}

export function stateDir(): string {
  return join(tmpdir(), "flowryn-process-guard");
}

export function stateFile(parent: number): string {
  return join(stateDir(), `${parent}.json`);
}

export function readState(parent: number): GuardState | null {
  const path = stateFile(parent);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as GuardState;
    return value.parent === parent && Number.isInteger(value.reaper) && Array.isArray(value.tracked) ? value : null;
  } catch {
    return null;
  }
}

export function writeState(state: GuardState): void {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const path = stateFile(state.parent);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, path);
}

export function removeState(parent: number): void {
  rmSync(stateFile(parent), { force: true });
}

/** Does any process have this pid? Only "no such process" says no: a process another sandbox hides answers EPERM. */
export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Remove the guard's state files (and torn `.tmp` writes) of test processes no
 * longer running: a reaper that was itself killed leaves its file behind. Only
 * files in the guard's own directory, named `<pid>.json` or `<pid>.json.<pid>.tmp`.
 */
export function sweepStaleStates(exists: (pid: number) => boolean = pidExists, dir = stateDir()): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const match = /^(\d+)\.json(?:\.(\d+)\.tmp)?$/.exec(name);
    if (!match) continue;
    const writer = match[2] === undefined ? null : Number(match[2]);
    if (exists(Number(match[1])) && (writer === null || exists(writer))) continue;
    rmSync(join(dir, name), { force: true });
    removed.push(name);
  }
  return removed;
}

export const REAPER = join(import.meta.dir, "reaper.ts");

/** Is the recorded reaper alive, this process's child, and running the reaper? */
export function reaperRunning(rows: PsRow[], state: GuardState): boolean {
  const row = rows.find((r) => r.pid === state.reaper);
  return row !== undefined && row.ppid === state.parent && row.command.includes(REAPER);
}

/** A row as one line of a report. */
export function describeRow(row: PsRow): string {
  return `pid ${row.pid} (ppid ${row.ppid}, started ${row.start}): ${row.command}`;
}
