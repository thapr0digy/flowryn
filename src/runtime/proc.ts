import { runBounded, type BoundedResult } from "./bounded.ts";

/**
 * Process identity from the process table (design sections 5 and 6, M0 h02):
 * Herdr's pane.process_info gives the pid and executable but no start time,
 * so the start time comes from `ps`. A pid alone is never enough to act on,
 * because pids are reused; every signal here is sent only after the pid's
 * start time and executable still match what was recorded.
 */
export interface ProcIdentity {
  pid: number;
  /** Start time in Unix ms (ps lstart has one-second resolution). */
  start: number;
  /** The executable as the process table names it (ps comm). */
  exe: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Parse `ps -o lstart=` in the C locale: "Wed Sep 23 22:53:49 2026" (local time). */
export function parseLstart(text: string): number | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [, mon, day, time, year] = parts as [string, string, string, string, string];
  const month = MONTHS.indexOf(mon);
  const hms = time.split(":").map(Number);
  if (month < 0 || hms.length !== 3 || hms.some((n) => !Number.isInteger(n))) return null;
  const date = new Date(Number(year), month, Number(day), hms[0]!, hms[1]!, hms[2]!);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

const LSTART_WIDTH = 24;

/** Parse one `ps -o pid=,lstart=,comm=` line. lstart is fixed width, comm may contain spaces. */
export function parsePsLine(line: string): ProcIdentity | null {
  const match = /^\s*(\d+)\s+(.*)$/.exec(line);
  if (!match) return null;
  const rest = match[2]!;
  const start = parseLstart(rest.slice(0, LSTART_WIDTH));
  const exe = rest.slice(LSTART_WIDTH).trim();
  if (start === null || exe.length === 0) return null;
  return { pid: Number(match[1]), start, exe };
}

/**
 * Reads `ps -o pid=,lstart=,comm=` rows for the given pids: the rows of those
 * alive, or "" when none is. Throws PsUnavailable when ps cannot answer, so a
 * failed or hung ps never reads as "every process gone".
 */
export type PsRunner = (pids: number[]) => Promise<string>;

/** ps could not answer: whether the processes asked about are alive is unknown, never "gone". */
export class PsUnavailable extends Error {
  override name = "PsUnavailable";
}

/** A local ps answers in milliseconds; this is for one that hangs. */
export const PS_TIMEOUT_MS = 5_000;

/**
 * What a bounded ps call says: its output when it exited 0, "" when it exited
 * 1 having printed nothing (macOS and procps both mean "none of these pids"),
 * and PsUnavailable otherwise (cannot spawn, timed out, overflowed, an error).
 */
export function psAnswer(ps: string, result: BoundedResult): string {
  if (result.code === 0) return result.stdout;
  if (result.code === 1 && result.stdout.trim() === "" && result.stderr.trim() === "") return "";
  throw new PsUnavailable(`${ps} exited ${result.code}: ${result.stderr.trim() || "no stderr"}`);
}

/**
 * The pids a ps refused as above the system's pid limit, or null. macOS ps
 * exits 1 with one "ps: process id too large: <pid>" line per such pid and
 * then reads none of the others asked about. No process can hold such a pid,
 * so it is gone, not unknown. Only an answer made of nothing but those lines counts.
 */
export function pidsTooLarge(result: BoundedResult): number[] | null {
  if (result.code !== 1 || result.stdout.trim() !== "" || result.stderr.trim() === "") return null;
  const pids: number[] = [];
  for (const line of result.stderr.trim().split("\n")) {
    const match = /^(?:\S*ps: )?process id too large: (\d+)$/.exec(line.trim());
    if (!match) return null;
    pids.push(Number(match[1]));
  }
  return pids;
}

/**
 * A process table read through the given ps, bounded by `timeoutMs`. LC_ALL=C keeps lstart parseable.
 * Pids ps refuses as too large are dropped as gone and the rest are asked again.
 */
export function psRunnerAt(ps: string, timeoutMs = PS_TIMEOUT_MS): PsRunner {
  return async (pids) => {
    let remaining = [...new Set(pids)];
    while (remaining.length > 0) {
      const result = await runBounded([ps, "-o", "pid=,lstart=,comm=", "-p", remaining.join(",")], { label: "ps", timeoutMs, env: { ...process.env, LC_ALL: "C" } });
      const tooLarge = pidsTooLarge(result);
      if (tooLarge === null || !tooLarge.every((pid) => remaining.includes(pid))) return psAnswer(ps, result);
      remaining = remaining.filter((pid) => !tooLarge.includes(pid));
    }
    return "";
  };
}

/** The real process table. */
export const psRunner: PsRunner = psRunnerAt("/bin/ps");

/** Identities of the given pids that are alive now (missing pids are simply absent). Throws PsUnavailable when ps cannot say. */
export async function readIdentities(pids: number[], ps: PsRunner = psRunner): Promise<Map<number, ProcIdentity>> {
  const found = new Map<number, ProcIdentity>();
  const wanted = pids.filter((p) => Number.isInteger(p) && p > 0);
  if (wanted.length === 0) return found;
  for (const line of (await ps(wanted)).split("\n")) {
    if (line.trim() === "") continue;
    const identity = parsePsLine(line);
    // A row that does not read could be any of the pids asked about: none of them may read as gone.
    if (!identity) throw new PsUnavailable(`ps printed a row that does not parse: ${JSON.stringify(line)}`);
    found.set(identity.pid, identity);
  }
  return found;
}

/** The pid's identity, or null when it is not running. Throws PsUnavailable when ps cannot say. */
export async function readIdentity(pid: number, ps: PsRunner = psRunner): Promise<ProcIdentity | null> {
  return (await readIdentities([pid], ps)).get(pid) ?? null;
}

/** Same process: same pid, same start time (to the second) and same executable. */
export function sameProcess(a: ProcIdentity, b: ProcIdentity): boolean {
  return a.pid === b.pid && Math.abs(a.start - b.start) < 1_000 && a.exe === b.exe;
}

/**
 * Is the recorded process still the one running under its pid? `execs`: it may
 * have exec'd since, so its executable is not compared. Throws PsUnavailable
 * when ps cannot say.
 */
export async function isAlive(identity: ProcIdentity, ps: PsRunner = psRunner, execs = false): Promise<boolean> {
  const now = await readIdentity(identity.pid, ps);
  return now !== null && sameProcess(now, execs ? { ...identity, exe: now.exe } : identity);
}

/** isAlive, with null for "ps cannot say". */
export async function aliveOrUnknown(identity: ProcIdentity, ps: PsRunner = psRunner, execs = false): Promise<boolean | null> {
  try {
    return await isAlive(identity, ps, execs);
  } catch (error) {
    if (error instanceof PsUnavailable) return null;
    throw error;
  }
}

export interface TerminateResult {
  ok: boolean;
  /**
   * "process": verified gone; "timeout": still alive after SIGKILL; "absent": was not running;
   * "unknown": ps could not say, so it was not signalled further (a pid is never signalled unverified).
   */
  evidence: "process" | "timeout" | "absent" | "unknown";
  signal: "none" | "SIGTERM" | "SIGKILL";
}

export interface TerminateOptions {
  graceMs?: number;
  pollMs?: number;
  ps?: PsRunner;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /**
   * Signal the whole process group the recorded process leads (the harness and
   * the tools it runs in the foreground). Only used for a group leader, whose
   * pid is the group id; the identity check still guards against reuse.
   */
  group?: boolean;
  /**
   * The recorded process is a `sh -c` that may since have exec'd its command
   * (one simple command does), so its executable is not compared; the pid
   * and start time, which an exec keeps, still guard against reuse.
   */
  execs?: boolean;
}

/**
 * SIGTERM the process if it is still the recorded one, wait `graceMs` (10 s by
 * design), then SIGKILL, and verify it is gone. A reused pid is never
 * signalled, and neither is a pid ps cannot vouch for: when ps fails before a
 * signal the result is "unknown", and while waiting a failed read just waits on.
 */
export async function terminate(identity: ProcIdentity, options: TerminateOptions = {}): Promise<TerminateResult> {
  const ps = options.ps ?? psRunner;
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const graceMs = options.graceMs ?? 10_000;
  const pollMs = options.pollMs ?? 100;
  const alive = () => aliveOrUnknown(identity, ps, options.execs);
  const first = await alive();
  if (first === null) return { ok: false, evidence: "unknown", signal: "none" };
  if (!first) return { ok: true, evidence: "absent", signal: "none" };
  const target = options.group ? -identity.pid : identity.pid;
  const send = (signal: NodeJS.Signals) => {
    try {
      kill(target, signal);
    } catch {
      // raced with its exit
    }
  };
  send("SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await Bun.sleep(pollMs);
    if ((await alive()) === false) return { ok: true, evidence: "process", signal: "SIGTERM" };
  }
  // Re-check right before escalating, so SIGKILL never reaches a pid that exited and was reused.
  const before = await alive();
  if (before === false) return { ok: true, evidence: "process", signal: "SIGTERM" };
  if (before === null) return { ok: false, evidence: "unknown", signal: "SIGTERM" };
  send("SIGKILL");
  let known = true;
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(pollMs);
    const now = await alive();
    if (now === false) return { ok: true, evidence: "process", signal: "SIGKILL" };
    known = now !== null;
  }
  return { ok: false, evidence: known ? "timeout" : "unknown", signal: "SIGKILL" };
}

/** One row of `ps -A -o pid=,ppid=,command=`: the command is its argv joined by spaces. */
export interface ProcRow {
  pid: number;
  ppid: number;
  command: string;
}

export function parseProcessTable(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]!.trim() });
  }
  return rows;
}

/** The command lines of every process under `root` (children, grandchildren, ...), not root's own. */
export function descendantCommands(rows: ProcRow[], root: number): string[] {
  const children = new Map<number, ProcRow[]>();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const commands: string[] = [];
  const seen = new Set<number>([root]);
  const queue = [root];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      commands.push(child.command);
      queue.push(child.pid);
    }
  }
  return commands;
}

/** The whole process table, read through the given ps; throws PsUnavailable when ps cannot answer. */
export async function readProcessTable(ps = "/bin/ps", timeoutMs = PS_TIMEOUT_MS): Promise<ProcRow[]> {
  const result = await runBounded([ps, "-A", "-o", "pid=,ppid=,command="], { label: "ps", timeoutMs, env: { ...process.env, LC_ALL: "C" } });
  if (result.code !== 0) throw new PsUnavailable(`${ps} exited ${result.code} reading the process table: ${result.stderr.trim() || "no stderr"}`);
  return parseProcessTable(result.stdout);
}
