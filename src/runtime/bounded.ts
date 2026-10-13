import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { basename, join } from "node:path";
import { readIdentity, terminate, type PsRunner } from "./proc.ts";

/**
 * One external command with a deadline and a termination owner
 * (docs/notes/2026-10-13-next-steps-md-xm.md). In the daemon each child leads
 * its own process group, so the deadline's SIGTERM, grace and SIGKILL reach
 * the descendants that inherited its pipes (git's remote helper, a forked
 * node), and an ownership ledger file names it until it settles, so the next
 * daemon can end a group a force-kill left behind. A leader that exits on its
 * own is never followed by a group kill, and keeps its code: a process it
 * started that still holds the pipe (a daemon it launched, git's credential
 * helper) is left running and the output read so far is the answer. Output
 * over the cap is reported as incomplete, never as a clean read.
 */

/** A call cut off at its deadline (as `timeout(1)` and `gitWithin` report it). */
export const TIMED_OUT = 124;
/** The output overflowed the cap: what was read is not the whole of it. */
export const INCOMPLETE = 125;
export const SPAWN_FAILED = 127;
export const DEFAULT_GRACE_MS = 2_000;
export const DEFAULT_DRAIN_MS = 1_000;
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** How long a SIGKILLed group gets to disappear before it is a leftover. */
const GONE_CONFIRM_MS = 1_000;
const POLL_MS = 25;
/** A recorded leader started within this window of its spawn (ps etime has one-second resolution). */
const START_SLACK_BEFORE_MS = 2_000;
const START_SLACK_AFTER_MS = 2_000;

export interface BoundedOptions {
  /** What the call is for, in the ledger and logs ("git fetch", "no-mistakes"). */
  label: string;
  timeoutMs: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: string;
  /** Send both streams to this file descriptor instead of capturing them. */
  outputFd?: number;
  /** Discard stderr for a caller that never reads it, so its size or a holder of it cannot change the result. */
  stderr?: "pipe" | "ignore";
  graceMs?: number;
  drainMs?: number;
  maxOutputBytes?: number;
}

export interface BoundedResult {
  /** The leader's exit code; TIMED_OUT, INCOMPLETE or SPAWN_FAILED when the call did not finish cleanly; 128 + n for a signal. */
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Why the output is not the whole of it (over the cap), or null. */
  incomplete: string | null;
  /** The leader exited on its own while a process it started still held its output: left running, read so far. */
  lingering: boolean;
  spawnError: string | null;
  /** The group outlived its SIGKILL: its ledger entry is kept for the next daemon to end. */
  leftover: boolean;
}

interface OwnedConfig {
  /** `<state_dir>/owned`: one `<pid>.json` per live child. */
  dir: string;
  log(message: string): void;
}

interface LiveChild {
  pid: number;
  group: boolean;
  entry: string | null;
  /** The daemon's stop could not end its group: the entry stays for the next start. */
  keep: boolean;
}

let owned: OwnedConfig | null = null;
const live = new Map<number, LiveChild>();

/** The daemon owns its children from here on: process groups and the ledger. Null returns to the CLI's behaviour. */
export function configureOwnedProcesses(config: OwnedConfig | null): void {
  owned = config;
}

export function ownedLedgerDir(): string | null {
  return owned?.dir ?? null;
}

interface LedgerEntry {
  pid: number;
  spawned_at: number;
  argv0: string;
  label: string;
}

function record(config: OwnedConfig, entry: LedgerEntry): string | null {
  const path = join(config.dir, `${entry.pid}.json`);
  try {
    mkdirSync(config.dir, { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
    renameSync(tmp, path);
    return path;
  } catch (error) {
    config.log(`could not record ${entry.label} (pid ${entry.pid}) as owned: ${(error as Error).message}`);
    return null;
  }
}

function forget(path: string | null): void {
  if (path) rmSync(path, { force: true });
}

function send(target: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(target, signal);
    return true;
  } catch {
    return false;
  }
}

/** Does the process group still have a member? */
export function groupAlive(pgid: number): boolean {
  return send(-pgid, 0);
}

async function waitGroupGone(pgid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(POLL_MS);
  }
  return true;
}

interface Collector {
  done: Promise<void>;
  cancel(): void;
  text(): string;
  overflowed(): boolean;
}

/** Read a stream to its end, keeping at most `max` bytes and draining the rest so the child never blocks on a full pipe. */
function collect(stream: ReadableStream<Uint8Array>, max: number): Collector {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let over = false;
  const done = (async () => {
    try {
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) return;
        if (size >= max) {
          over = true;
          continue;
        }
        const take = value.subarray(0, max - size);
        chunks.push(take);
        size += take.length;
        if (take.length < value.length) over = true;
      }
    } catch {
      // cancelled after the drain, or the pipe broke
    }
  })();
  return {
    done,
    cancel: () => void reader.cancel().catch(() => undefined),
    text: () => Buffer.concat(chunks).toString("utf8"),
    overflowed: () => over,
  };
}

function signalCode(signal: NodeJS.Signals | null | undefined): number {
  const n = signal ? (constants.signals as Record<string, number>)[signal] : undefined;
  return 128 + (n ?? 0);
}

/** Run one external command to its end or its deadline. Never throws. */
export async function runBounded(argv: string[], opts: BoundedOptions): Promise<BoundedResult> {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const drainMs = opts.drainMs ?? DEFAULT_DRAIN_MS;
  const max = opts.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  const config = owned;
  const group = config !== null;
  const spawnedAt = Date.now();
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      env: opts.env,
      stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
      stdout: opts.outputFd ?? "pipe",
      stderr: opts.outputFd ?? opts.stderr ?? "pipe",
      detached: group,
    });
  } catch (error) {
    const message = (error as Error).message;
    return { code: SPAWN_FAILED, stdout: "", stderr: message, timedOut: false, incomplete: null, lingering: false, spawnError: message, leftover: false };
  }
  const pid = proc.pid;
  const child: LiveChild = { pid, group, entry: config ? record(config, { pid, spawned_at: spawnedAt, argv0: basename(argv[0] ?? ""), label: opts.label }) : null, keep: false };
  live.set(pid, child);
  const target = group ? -pid : pid;
  const out = opts.outputFd === undefined ? collect(proc.stdout as ReadableStream<Uint8Array>, max) : null;
  const err = opts.outputFd === undefined && opts.stderr !== "ignore" ? collect(proc.stderr as ReadableStream<Uint8Array>, max) : null;

  let timedOut = false;
  let killAt = Infinity;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    send(target, "SIGTERM");
    killAt = Date.now() + graceMs;
    graceTimer = setTimeout(() => send(target, "SIGKILL"), graceMs);
  }, opts.timeoutMs);
  await proc.exited;
  clearTimeout(timer);

  let leftover = false;
  if (timedOut && group) {
    // The leader is gone; its descendants get the rest of the grace, then SIGKILL, then must be gone.
    if (!(await waitGroupGone(pid, Math.max(0, killAt - Date.now())))) {
      send(-pid, "SIGKILL");
      leftover = !(await waitGroupGone(pid, GONE_CONFIRM_MS));
    }
  }
  clearTimeout(graceTimer);

  let incomplete: string | null = null;
  let lingering = false;
  const streams = [out, err].filter((c): c is Collector => c !== null);
  if (streams.length > 0) {
    const drained = await Promise.race([Promise.all(streams.map((c) => c.done)).then(() => true), Bun.sleep(drainMs).then(() => false)]);
    if (!drained) {
      for (const c of streams) c.cancel();
      // A timed-out call is 124 already; a leader that finished keeps its code and the output it wrote.
      lingering = !timedOut;
    }
    if (streams.some((c) => c.overflowed())) incomplete = `its output went over ${max} bytes`;
  }

  live.delete(pid);
  if (leftover && config) config.log(`${opts.label} (pid ${pid}): its process group outlived SIGKILL; recorded in ${child.entry ?? "nothing (no ledger entry)"} for the next start`);
  else if (!child.keep) forget(child.entry);
  if (lingering) config?.log(`${opts.label} (pid ${pid}) exited ${proc.exitCode ?? "on a signal"}; a process it started still holds its output and is left running`);

  const stdout = out?.text() ?? "";
  let stderr = err?.text() ?? "";
  const leaderCode = proc.exitCode ?? signalCode(proc.signalCode as NodeJS.Signals | null);
  let code = leaderCode;
  if (timedOut) {
    code = TIMED_OUT;
    stderr = `${stderr}${stderr && !stderr.endsWith("\n") ? "\n" : ""}${opts.label} did not finish within ${opts.timeoutMs} ms\n`;
  } else if (incomplete) {
    code = INCOMPLETE;
    stderr = `${stderr}${stderr && !stderr.endsWith("\n") ? "\n" : ""}${opts.label} exited ${leaderCode} but ${incomplete}\n`;
  }
  return { code, stdout, stderr, timedOut, incomplete, lingering, spawnError: null, leftover };
}

export interface OwnedStop {
  ended: number[];
  left: number[];
}

/** Daemon shutdown: SIGTERM every live child's group, SIGKILL what is left after the grace, and drop the entries of those gone. */
export async function stopOwnedProcesses(graceMs = 3_000): Promise<OwnedStop> {
  const children = [...live.values()].filter((c) => c.group);
  for (const c of children) send(-c.pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (children.some((c) => groupAlive(c.pid)) && Date.now() < deadline) await Bun.sleep(POLL_MS);
  const result: OwnedStop = { ended: [], left: [] };
  for (const c of children) {
    if (groupAlive(c.pid)) {
      send(-c.pid, "SIGKILL");
      if (!(await waitGroupGone(c.pid, GONE_CONFIRM_MS))) {
        c.keep = true;
        result.left.push(c.pid);
        continue;
      }
    }
    forget(c.entry);
    result.ended.push(c.pid);
  }
  return result;
}

export interface OwnedRecovery {
  /** Recorded groups found alive and ended. */
  ended: { pid: number; label: string }[];
  /** Entries whose leader was gone, or whose pid is another process now: removed, nothing signalled. */
  gone: { pid: number; label: string }[];
  /** Recorded groups that would not die: their entries stay for the next start. */
  failed: { pid: number; label: string; detail: string }[];
  /** Entries that cannot be read: kept, since they may name a process still running. */
  unreadable: string[];
  /** Torn `.json.tmp` writes (the daemon died between write and rename): removed, since nothing in them names a process. */
  discarded: string[];
}

function parseEntry(text: string): LedgerEntry | null {
  try {
    const value = JSON.parse(text) as Partial<LedgerEntry>;
    if (!Number.isInteger(value.pid) || (value.pid ?? 0) <= 0 || typeof value.spawned_at !== "number" || !Number.isFinite(value.spawned_at)) return null;
    return { pid: value.pid!, spawned_at: value.spawned_at, argv0: typeof value.argv0 === "string" ? value.argv0 : "", label: typeof value.label === "string" ? value.label : "" };
  } catch {
    return null;
  }
}

/** "[[dd-]hh:]mm:ss" (ps etime) in ms; null when it does not read. */
export function parseEtime(text: string): number | null {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return (((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
}

interface GroupFacts {
  pgid: number;
  /** When it started, from its elapsed time: free of the time zone ps and this process each read lstart in. */
  startedAt: number;
}

/** The process group a pid ps has just seen alive leads, and when it started; throws when ps cannot say. */
async function groupFacts(pid: number, ps: string): Promise<GroupFacts> {
  const read = await runBounded([ps, "-o", "pgid=,etime=", "-p", String(pid)], { label: "ps", timeoutMs: 5_000, env: { ...process.env, LC_ALL: "C" } });
  if (read.code !== 0) throw new Error(`${ps} exited ${read.code} reading its group: ${read.stderr.trim() || "no stderr"}`);
  const [pgid, etime] = read.stdout.trim().split(/\s+/);
  const elapsed = parseEtime(etime ?? "");
  if (!pgid || !Number.isInteger(Number(pgid)) || elapsed === null) throw new Error(`${ps} printed an unreadable group: ${JSON.stringify(read.stdout.trim())}`);
  return { pgid: Number(pgid), startedAt: Date.now() - elapsed };
}

/** Is this live process the leader an entry recorded: its own group's leader, started when the entry says it was spawned? */
export function matchesEntry(pid: number, facts: GroupFacts, entry: Pick<LedgerEntry, "pid" | "spawned_at">): boolean {
  if (pid !== entry.pid || facts.pgid !== entry.pid) return false;
  return facts.startedAt >= entry.spawned_at - START_SLACK_BEFORE_MS && facts.startedAt <= entry.spawned_at + START_SLACK_AFTER_MS;
}

export interface RecoverOptions {
  graceMs?: number;
  ps?: PsRunner;
  /** The ps that reads a live leader's group and start (default /bin/ps). */
  groupPs?: string;
}

/**
 * Daemon startup: end every group a previous daemon recorded and did not
 * settle (it was force-killed mid-call). Only a leader that still matches its
 * entry's identity is signalled; its whole group then goes.
 */
export async function recoverOwnedProcesses(dir: string, options: RecoverOptions = {}): Promise<OwnedRecovery> {
  const result: OwnedRecovery = { ended: [], gone: [], failed: [], unreadable: [], discarded: [] };
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json") || n.endsWith(".json.tmp"));
  } catch {
    return result;
  }
  for (const name of names.toSorted()) {
    const path = join(dir, name);
    let entry: LedgerEntry | null = null;
    try {
      entry = parseEntry(readFileSync(path, "utf8"));
    } catch {
      entry = null;
    }
    if (!entry) {
      if (name.endsWith(".tmp")) {
        forget(path);
        result.discarded.push(path);
      } else {
        result.unreadable.push(path);
      }
      continue;
    }
    if (live.has(entry.pid)) continue;
    const label = entry.label || entry.argv0;
    try {
      await recoverEntry(path, entry, label, options, result);
    } catch (error) {
      // ps could not say for this one: keep its entry and go on with the rest.
      result.failed.push({ pid: entry.pid, label, detail: `cannot check it: ${(error as Error).message}` });
    }
  }
  return result;
}

async function recoverEntry(path: string, entry: LedgerEntry, label: string, options: RecoverOptions, result: OwnedRecovery): Promise<void> {
  const identity = await readIdentity(entry.pid, options.ps);
  if (!identity || !matchesEntry(entry.pid, await groupFacts(entry.pid, options.groupPs ?? "/bin/ps"), entry)) {
    forget(path);
    result.gone.push({ pid: entry.pid, label });
    return;
  }
  const ended = await terminate(identity, { group: true, graceMs: options.graceMs ?? 3_000, ps: options.ps });
  if (ended.ok) {
    // Members that ignored SIGTERM after their leader went: the group cannot be reused while they live.
    send(-entry.pid, "SIGKILL");
    if (await waitGroupGone(entry.pid, GONE_CONFIRM_MS)) {
      forget(path);
      result.ended.push({ pid: entry.pid, label });
      return;
    }
  }
  result.failed.push({ pid: entry.pid, label, detail: ended.ok ? "members of its group outlived SIGKILL" : `its leader did not exit (${ended.evidence})` });
}
