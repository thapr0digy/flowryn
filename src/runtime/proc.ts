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

export type PsRunner = (pids: number[]) => Promise<string>;

/** The real process table. LC_ALL=C keeps lstart parseable. */
export const psRunner: PsRunner = async (pids) => {
  const proc = Bun.spawn(["/bin/ps", "-o", "pid=,lstart=,comm=", "-p", pids.join(",")], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, LC_ALL: "C" },
  });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return out;
};

/** Identities of the given pids that are alive now (missing pids are simply absent). */
export async function readIdentities(pids: number[], ps: PsRunner = psRunner): Promise<Map<number, ProcIdentity>> {
  const found = new Map<number, ProcIdentity>();
  const wanted = pids.filter((p) => Number.isInteger(p) && p > 0);
  if (wanted.length === 0) return found;
  for (const line of (await ps(wanted)).split("\n")) {
    const identity = parsePsLine(line);
    if (identity) found.set(identity.pid, identity);
  }
  return found;
}

export async function readIdentity(pid: number, ps: PsRunner = psRunner): Promise<ProcIdentity | null> {
  return (await readIdentities([pid], ps)).get(pid) ?? null;
}

/** Same process: same pid, same start time (to the second) and same executable. */
export function sameProcess(a: ProcIdentity, b: ProcIdentity): boolean {
  return a.pid === b.pid && Math.abs(a.start - b.start) < 1_000 && a.exe === b.exe;
}

/** Is the recorded process still the one running under its pid? */
export async function isAlive(identity: ProcIdentity, ps: PsRunner = psRunner): Promise<boolean> {
  const now = await readIdentity(identity.pid, ps);
  return now !== null && sameProcess(now, identity);
}

export interface TerminateResult {
  ok: boolean;
  /** "process": verified gone; "timeout": still alive after SIGKILL; "absent": was not running. */
  evidence: "process" | "timeout" | "absent";
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
}

/**
 * SIGTERM the process if it is still the recorded one, wait `graceMs` (10 s by
 * design), then SIGKILL, and verify it is gone. A reused pid is never signalled.
 */
export async function terminate(identity: ProcIdentity, options: TerminateOptions = {}): Promise<TerminateResult> {
  const ps = options.ps ?? psRunner;
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const graceMs = options.graceMs ?? 10_000;
  const pollMs = options.pollMs ?? 100;
  if (!(await isAlive(identity, ps))) return { ok: true, evidence: "absent", signal: "none" };
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
    if (!(await isAlive(identity, ps))) return { ok: true, evidence: "process", signal: "SIGTERM" };
  }
  // Re-check right before escalating, so SIGKILL never reaches a pid that exited and was reused.
  if (!(await isAlive(identity, ps))) return { ok: true, evidence: "process", signal: "SIGTERM" };
  send("SIGKILL");
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(pollMs);
    if (!(await isAlive(identity, ps))) return { ok: true, evidence: "process", signal: "SIGKILL" };
  }
  return { ok: false, evidence: "timeout", signal: "SIGKILL" };
}
