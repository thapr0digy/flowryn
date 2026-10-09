import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { getMeta, setMeta, tx, type Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { FlowrynError } from "../api/errors.ts";
import type { Caller, DaemonInfo } from "../api/verbs.ts";
import { findOpenItem, openItem, resolveItems } from "../attention/items.ts";
import { taskTitle } from "../lifecycle/runs.ts";
import { waitsOnlyOnCi, type NmActiveStep } from "../policy/nomistakes.ts";
import { sha256Hex } from "../util/hash.ts";

/**
 * `flowryn daemon restart` (leader-safe restart): the leader, or you, applies
 * a new build without your terminal. Everything here is plain code: the
 * guards are queries over the database and the daemon's memory, the binary
 * check runs the launchd target's `version --json`, and the restart itself is
 * launchd's `kickstart -k`, asked by this daemon (it runs outside any Bash
 * sandbox, so the leader's shell never needs launchctl).
 */

/** No second restart this soon after the last one: a plain timer against a restart loop. */
export const RESTART_COOLDOWN_MS = 60_000;
/** How long `--when-idle` waits by default, and at most. */
export const DEFAULT_WAIT_MIN = 30;
export const MAX_WAIT_MIN = 240;
/** The binary smoke check's time limit. */
export const SMOKE_TIMEOUT_MS = 10_000;
/** How often a parked `--when-idle` request re-reads the guards. */
export const PENDING_POLL_MS = 5_000;

const PENDING_KEY = "restart_pending";
const HANDOFF_KEY = "restart_handoff";
/** The pool the ship stage's no-mistakes pipeline runs under (src/config/workflows.ts). */
const VALIDATION_POOL = "validation";
/**
 * A validation that only waits on external CI does not block a restart, read
 * from a no-mistakes status at most this old: twice the watcher's default
 * poll, and the controller asks for a fresh read before it decides.
 */
export const VALIDATION_STATUS_FRESH_MS = 2 * 60_000;

export type GuardKind = "merging" | "blocked_prompt" | "validation" | "cleanup" | "launching" | "approval" | "verifying" | "contract_check";

/** One thing a restart now would break. */
export interface Guard {
  kind: GuardKind;
  task: string | null;
  /** The task's title, when the backlog has one other than its id. */
  title?: string;
  detail: string;
}

/** The daemon's in-memory work that a restart would throw away. */
export interface InMemoryWork {
  mergesInFlight: Iterable<string>;
  cleanups: Iterable<string>;
  launching: Iterable<string>;
  approvalTasks: Iterable<string>;
  /** The daemon's automatic contract check (src/contracts/auto.ts): launchd's restart kills its process group, the check with it. */
  contractChecks?: Iterable<{ harness: string; version: string; startedAt: number }>;
}

function taskOfRun(db: Db, runId: string): string | null {
  return (db.query("SELECT task_id FROM runs WHERE id = ?1").get(runId) as { task_id: string } | null)?.task_id ?? null;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 120 ? `${s} s` : `${Math.round(s / 60)} min`;
}

/**
 * Everything a restart now would break, in a fixed order. Empty means a
 * restart is safe. Pending intents are not a guard: they replay at startup,
 * and the shutdown path already waits for the journal.
 */
export function restartGuards(db: Db, work: InMemoryWork, now: number): Guard[] {
  const guards: Guard[] = [];
  const merges = db.query("SELECT id, task_id, requested_at FROM merges WHERE state = 'requested' ORDER BY requested_at").all() as { id: string; task_id: string; requested_at: number }[];
  const seen = new Set<string>();
  for (const m of merges) {
    seen.add(m.id);
    guards.push({ kind: "merging", task: m.task_id, detail: `merge ${m.id} requested ${ago(now - m.requested_at)} ago` });
  }
  for (const id of work.mergesInFlight) {
    if (seen.has(id)) continue;
    const row = db.query("SELECT task_id FROM merges WHERE id = ?1").get(id) as { task_id: string } | null;
    guards.push({ kind: "merging", task: row?.task_id ?? null, detail: `merge ${id} is being asked of GitHub` });
  }
  const prompts = db
    .query(
      `SELECT r.id, r.task_id, i.id AS item, i.line FROM runs r
       LEFT JOIN items i ON i.run_id = r.id AND i.kind = 'blocked_prompt' AND i.state IN ('open','presented')
       WHERE r.state NOT IN ('cleaned','failed','cancelled') AND (r.liveness = 'blocked_dialog' OR i.id IS NOT NULL)
       ORDER BY r.started_at`,
    )
    .all() as { id: string; task_id: string; item: string | null; line: string | null }[];
  const prompted = new Set<string>();
  for (const p of prompts) {
    if (prompted.has(p.id)) continue;
    prompted.add(p.id);
    guards.push({ kind: "blocked_prompt", task: p.task_id, detail: p.item ? `${p.item}: ${p.line ?? "a confirmation prompt"}` : "the worker shows a confirmation dialog" });
  }
  const validating = db
    .query(
      `SELECT r.task_id, r.branch, l.granted_at, e.value AS status, e.observed_at FROM pool_leases l JOIN runs r ON r.id = l.run_id
       LEFT JOIN run_evidence e ON e.run_id = r.id AND e.source = 'nomistakes'
       WHERE l.pool = ?1 AND l.released_at IS NULL ORDER BY l.granted_at`,
    )
    .all(VALIDATION_POOL) as ValidationRow[];
  for (const v of validating) {
    const read = freshStatus(v, now);
    if ("status" in read && waitsOnlyOnCi(read.status)) continue;
    guards.push({ kind: "validation", task: v.task_id, detail: validationDetail(v, read, now) });
  }
  for (const runId of work.cleanups) guards.push({ kind: "cleanup", task: taskOfRun(db, runId), detail: "cleanup is running" });
  for (const runId of work.launching) guards.push({ kind: "launching", task: taskOfRun(db, runId), detail: "its worker is being launched" });
  for (const task of work.approvalTasks) guards.push({ kind: "approval", task, detail: "flowryn approve is waiting for its code" });
  for (const c of work.contractChecks ?? []) guards.push({ kind: "contract_check", task: null, detail: `automatic contract check ${c.harness} ${c.version} running for ${ago(now - c.startedAt)}` });
  const verifying = db.query("SELECT id, task_id, pr_url, started_at FROM verifications WHERE state = 'running' ORDER BY started_at").all() as { id: string; task_id: string | null; pr_url: string; started_at: number }[];
  for (const v of verifying) guards.push({ kind: "verifying", task: v.task_id, detail: `flowryn verify ${v.id} of ${v.pr_url} has run for ${ago(now - v.started_at)}` });
  for (const g of guards) {
    const title = g.task ? taskTitle(db, g.task) : null;
    if (title && title !== g.task) g.title = title;
  }
  return guards;
}

interface ValidationRow {
  task_id: string;
  branch: string;
  granted_at: number;
  status: string | null;
  observed_at: number | null;
}

type NmStatusRead = { status: { outcome: string; activeSteps: NmActiveStep[] | null } } | { unusable: string };

/** The run's own no-mistakes status (src/reconcile/delivery.ts records it) when read recently enough to decide on, or why there is none. */
function freshStatus(v: ValidationRow, now: number): NmStatusRead {
  if (v.status === null || v.observed_at === null || now - v.observed_at > VALIDATION_STATUS_FRESH_MS) {
    return { unusable: `no no-mistakes status read in the last ${VALIDATION_STATUS_FRESH_MS / 60_000} min` };
  }
  const read = JSON.parse(v.status) as { branch?: unknown; outcome?: unknown; active_steps?: unknown };
  if (read.branch === undefined) return { unusable: "the latest no-mistakes status names no run" };
  if (read.branch !== v.branch) return { unusable: `the latest no-mistakes status is a run on branch ${String(read.branch)}, not ${v.branch}` };
  if (typeof read.outcome !== "string") return { unusable: "the latest no-mistakes status has no readable outcome" };
  return { status: { outcome: read.outcome, activeSteps: Array.isArray(read.active_steps) ? (read.active_steps as NmActiveStep[]) : null } };
}

/** "2h17m", "9m24s", "35s" (no-mistakes' own durations) in seconds; unreadable reads as 0. */
export function durationSeconds(text: string): number {
  let total = 0;
  for (const [, n, unit] of text.matchAll(/(\d+)\s*(h|m(?!s)|s)/g)) total += Number(n) * (unit === "h" ? 3600 : unit === "m" ? 60 : 1);
  return total;
}

/** Why a validation blocks: its longest-running step and that step's local agent, or why no status says. */
function validationDetail(v: ValidationRow, read: NmStatusRead, now: number): string {
  const held = `validating for ${ago(now - v.granted_at)}`;
  if ("unusable" in read) return `${held}; ${read.unusable}`;
  const steps = read.status.activeSteps ?? [];
  if (steps.length === 0) return held;
  const oldest = steps.reduce((a, b) => (durationSeconds(b.activeFor) > durationSeconds(a.activeFor) ? b : a));
  const agent = oldest.agentPid ? `, agent pid ${oldest.agentPid}` : "";
  return `no-mistakes step ${oldest.step}${oldest.activeFor ? `, running ${oldest.activeFor}` : ""}${agent}; ${held}`;
}

/** "2026-10-05 14:32" in local time, for a person reading a deadline. */
function two(n: number): string {
  return String(n).padStart(2, "0");
}

export function localStamp(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** One line per guard, for a refusal or a status. */
export function guardLines(guards: readonly Guard[]): string[] {
  return guards.map((g) => `${g.kind}: ${g.task ?? "-"}${g.title ? ` "${g.title}"` : ""} (${g.detail})`);
}

// ---------------------------------------------------------------------------
// The binary check

/** The launchd target as a command: the program arguments without the trailing `daemon run`. */
export function commandOf(program: readonly string[]): string[] {
  const n = program.length;
  return n >= 2 && program[n - 2] === "daemon" && program[n - 1] === "run" ? program.slice(0, n - 2) : [...program];
}

/**
 * A build's identity: the first 12 hex digits of the compiled binary's
 * sha256. The version string stays the same across builds, so this is what
 * tells two builds apart. A development command (bun plus a script) has none.
 */
export function buildIdOf(command: readonly string[]): string | null {
  if (command.length !== 1) return null;
  try {
    return buildIdOfBytes(readFileSync(command[0]!));
  } catch {
    return null;
  }
}

export function buildIdOfBytes(bytes: Uint8Array): string {
  return sha256Hex(bytes).slice(0, 12);
}

export interface SmokeResult {
  version: string;
  proto: number;
  build: string | null;
  /** The newest schema migration the binary knows; null from a binary older than the build stamp. */
  schema: number | null;
  /** The build stamp (src/build-stamp.ts); all null for a development command or an unstamped binary. */
  commit: string | null;
  dirty: boolean | null;
  source: string | null;
}

export interface ProcResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type RunProc = (argv: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<ProcResult>;

export async function runProc(argv: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ProcResult> {
  let proc;
  try {
    proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
  } catch (error) {
    return { exitCode: null, stdout: "", stderr: (error as Error).message, timedOut: false };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr, timedOut };
}

/** The environment the smoke check runs in: no agent identity, so the binary answers as your own shell would. */
export function smokeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === "FLOWRYN_TOKEN" || key === "FLOWRYN_RUN" || key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_")) continue;
    out[key] = value;
  }
  return out;
}

function broken(command: readonly string[], why: string): FlowrynError {
  return new FlowrynError("binary_broken", `${command.join(" ")} failed its smoke check: ${why}; the running daemon stays`, "rebuild it (bun run build), then try again");
}

/**
 * The binary check: the launchd target must answer `version --json` with a
 * version and a protocol, and a compiled binary must pass `codesign --verify
 * --strict` (an unsigned Bun binary is killed at exec on macOS), so a broken
 * build never replaces a working daemon. Throws `binary_broken`.
 */
export async function smokeCheck(command: readonly string[], env: NodeJS.ProcessEnv, run: RunProc = runProc): Promise<SmokeResult> {
  if (command.length === 0) throw broken(command, "no program");
  if (!existsSync(command[command.length === 1 ? 0 : 1]!)) throw broken(command, "the file does not exist");
  const result = await run([...command, "version", "--json"], smokeEnv(env), SMOKE_TIMEOUT_MS);
  if (result.timedOut) throw broken(command, `version did not answer within ${SMOKE_TIMEOUT_MS / 1000} s`);
  if (result.exitCode !== 0) throw broken(command, `version exited ${result.exitCode ?? "on a signal"}${result.stderr.trim() ? `: ${result.stderr.trim().split("\n")[0]}` : ""}`);
  let reply: { ok?: unknown; data?: { flowryn?: unknown; proto?: unknown; schema?: unknown; commit?: unknown; dirty?: unknown; source?: unknown } };
  try {
    reply = JSON.parse(result.stdout) as typeof reply;
  } catch {
    throw broken(command, "version --json did not print JSON");
  }
  const version = reply.data?.flowryn;
  const proto = reply.data?.proto;
  if (reply.ok !== true || typeof version !== "string" || typeof proto !== "number" || !Number.isInteger(proto)) throw broken(command, "version --json has no version or protocol");
  if (command.length === 1 && process.platform === "darwin") {
    const signed = await run(["/usr/bin/codesign", "--verify", "--strict", command[0]!], smokeEnv(env), SMOKE_TIMEOUT_MS);
    if (signed.exitCode !== 0) throw broken(command, `codesign --verify --strict failed: ${(signed.stderr || signed.stdout).trim().split("\n")[0] ?? ""}`);
  }
  const data = reply.data!;
  return {
    version,
    proto,
    build: buildIdOf(command),
    schema: typeof data.schema === "number" && Number.isInteger(data.schema) ? data.schema : null,
    commit: typeof data.commit === "string" && data.commit.length > 0 ? data.commit : null,
    dirty: typeof data.dirty === "boolean" ? data.dirty : null,
    source: typeof data.source === "string" && data.source.length > 0 ? data.source : null,
  };
}

// ---------------------------------------------------------------------------
// The supervisor: who starts the daemon again

/** What the next daemon will run, or why a restart cannot use it. */
export type Target = { program: string[] } | { refusal: FlowrynError };

export interface Supervisor {
  /** "launchd", or "script" for tests and the lab. */
  name: string;
  /** Null when this very process is the supervised daemon; otherwise why not. */
  supervised(): Promise<string | null>;
  /** The program the supervisor starts next (launchd: the installed plist's ProgramArguments). */
  target(): Promise<Target>;
  /** Ask for the restart; resolves with the helper's outcome, or never if this process is stopped first. */
  restart(): Promise<{ ok: boolean; detail: string }>;
}

function nonEmptyStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((x) => typeof x === "string");
}

/**
 * The script supervisor (FLOWRYN_SUPERVISOR, a JSON file): tests and the lab
 * stand in for launchd with it, the way FLOWRYN_NOTIFIER stands in for the
 * macOS channel. `program` is what it starts next; `restart` is a command it
 * runs detached, with FLOWRYN_DAEMON_PID set, that stops this daemon and
 * starts the next one.
 */
export function scriptSupervisor(file: string, env: NodeJS.ProcessEnv): Supervisor {
  const read = (): { program: string[]; restart: string[] } => {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { program?: unknown; restart?: unknown };
    if (!nonEmptyStrings(raw.program) || !nonEmptyStrings(raw.restart)) throw new Error(`${file}: program and restart must be non-empty string lists`);
    return { program: raw.program, restart: raw.restart };
  };
  return {
    name: "script",
    async supervised() {
      try {
        read();
        return null;
      } catch (error) {
        return `FLOWRYN_SUPERVISOR is unreadable: ${(error as Error).message}`;
      }
    },
    async target() {
      return { program: read().program };
    },
    restart() {
      const [bin, ...args] = read().restart;
      return detached(bin!, args, { ...env, FLOWRYN_DAEMON_PID: String(process.pid) });
    },
  };
}

/** Run a helper in its own process group, so stopping this daemon never takes it down with it. */
export function detached(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { detached: true, stdio: ["ignore", "ignore", "pipe"], env });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => resolve({ ok: false, detail: error.message }));
    child.on("exit", (code, signal) => resolve(code === 0 ? { ok: true, detail: "" } : { ok: false, detail: `${bin} exited ${code ?? signal}: ${stderr.trim().split("\n")[0] ?? ""}` }));
    child.unref();
  });
}

// ---------------------------------------------------------------------------
// The request, the parked request and the handoff

export interface DaemonSnapshot {
  pid: number;
  version: string;
  proto: number;
  build: string | null;
  /** The commit the build was stamped with; absent before the build stamp, null for an unstamped build. */
  commit?: string | null;
  uptime_s: number;
}

/** A `--when-idle` request the daemon holds until the guards clear (meta.restart_pending). */
export interface PendingRestart {
  by: string;
  session: string | null;
  requested_at: number;
  expires_at: number;
  force: boolean;
  /** An automatic request (by "auto", src/daemon/build-watch.ts): the build it is for, and its commit. */
  build?: string;
  commit?: string | null;
}

/** Who asks for an automatic restart, as events, status and the briefing show it. */
export const AUTO_REQUESTER = "auto";

/** What the old daemon leaves the new one (meta.restart_handoff), so it can record who asked. */
export interface Handoff {
  by: string;
  session: string | null;
  requested_at: number;
  old: DaemonSnapshot;
}

/** Is a handoff waiting for the next daemon? The old daemon clears it when its supervisor refuses. */
export function handoffPending(db: Db): boolean {
  return getMeta(db, HANDOFF_KEY) !== null;
}

/** The newest restart that will not happen: why, and when. */
export function lastDropped(db: Db): { reason: string; ts: number } | null {
  const row = db.query("SELECT ts, payload FROM events WHERE kind IN ('daemon.restart_dropped','daemon.restart_expired') ORDER BY seq DESC LIMIT 1").get() as { ts: number; payload: string } | null;
  return row ? { reason: String((JSON.parse(row.payload) as { reason?: unknown }).reason ?? ""), ts: row.ts } : null;
}

export function readPending(db: Db): PendingRestart | null {
  const raw = getMeta(db, PENDING_KEY);
  return raw ? (JSON.parse(raw) as PendingRestart) : null;
}

function clearMeta(db: Db, key: string): void {
  db.query("DELETE FROM meta WHERE key = ?1").run(key);
}

/** Who asked, as the event records it. */
export function requester(caller: Caller): { by: string; session: string | null } {
  return { by: caller.role, session: caller.session ?? null };
}

export function snapshotOf(info: DaemonInfo, now: number): DaemonSnapshot {
  return { pid: info.pid, version: info.version, proto: info.proto, build: info.build ?? null, commit: info.commit ?? null, uptime_s: Math.round((now - info.startedAt) / 1000) };
}

/**
 * At startup, inside the daemon.started transaction: a handoff means the old
 * daemon asked for this restart, so record `daemon.restarted` with who asked
 * and close any dropped-restart item. Returns the event's payload, or null.
 */
export function recordRestarted(db: Db, current: Omit<DaemonSnapshot, "uptime_s">, now: number): Record<string, unknown> | null {
  const raw = getMeta(db, HANDOFF_KEY);
  if (!raw) return null;
  clearMeta(db, HANDOFF_KEY);
  const handoff = JSON.parse(raw) as Handoff;
  if (handoff.old.pid === current.pid) return null;
  const payload = {
    by: handoff.by,
    session: handoff.session,
    old: handoff.old,
    new: current,
    downtime_ms: Math.max(0, now - handoff.requested_at),
  };
  appendEvent(db, { source: "daemon", kind: "daemon.restarted", payload, ts: now });
  resolveItems(db, "restart_dropped", null, "daemon.restarted", now);
  return payload;
}

/** Restarts since a moment, for the briefing: who asked, and the build before and after. */
export function restartsSince(db: Db, since: number): { ts: number; by: string; session: string | null; old: DaemonSnapshot; new: Omit<DaemonSnapshot, "uptime_s"> }[] {
  const rows = db.query("SELECT ts, payload FROM events WHERE kind = 'daemon.restarted' AND ts > ?1 ORDER BY seq").all(since) as { ts: number; payload: string }[];
  return rows.map((r) => ({ ts: r.ts, ...(JSON.parse(r.payload) as { by: string; session: string | null; old: DaemonSnapshot; new: Omit<DaemonSnapshot, "uptime_s"> }) }));
}

export interface RestartDeps {
  db: Db;
  env: NodeJS.ProcessEnv;
  now(): number;
  log(message: string): void;
  info(): DaemonInfo;
  work(): InMemoryWork;
  supervisor(): Supervisor;
  smoke?: (command: readonly string[], env: NodeJS.ProcessEnv) => Promise<SmokeResult>;
  /** Read every validating run's no-mistakes status now (the delivery watcher), so the validation guard decides on a fresh read. */
  readValidations?: () => Promise<void>;
}

export interface Preflight {
  supervisor: string;
  target: SmokeResult & { program: string[] };
}

export type RequestOutcome =
  | { restart: "restarting"; supervisor: string; old: DaemonSnapshot; target: Preflight["target"] }
  | { restart: "pending"; waiting_on: string[]; expires_at: number; expires: string; kept?: string }
  | { restart: "cancelled"; had_pending: boolean };

/**
 * The daemon's side of a restart. `preflight` runs the checks that need no
 * transaction (supervisor, plist, binary); `request` decides inside the
 * verb's transaction; `kick` asks the supervisor once the reply is sent.
 */
export class RestartController {
  private readonly deps: RestartDeps;
  private kicked = false;
  private polling = false;

  constructor(deps: RestartDeps) {
    this.deps = deps;
  }

  get inProgress(): boolean {
    return this.kicked;
  }

  guards(): Guard[] {
    return restartGuards(this.deps.db, this.deps.work(), this.deps.now());
  }

  /** Fresh no-mistakes reads for the validation guard, when anything validates; call before deciding. */
  async refreshValidations(): Promise<void> {
    const live = this.deps.db.query("SELECT 1 FROM pool_leases WHERE pool = ?1 AND released_at IS NULL LIMIT 1").get(VALIDATION_POOL);
    if (live && this.deps.readValidations) await this.deps.readValidations();
  }

  /** Supervised, the target unchanged since install, its binary sound, and (unless forced) a different build. Throws a FlowrynError. */
  async preflight(force: boolean): Promise<Preflight> {
    if (this.kicked) throw new FlowrynError("restart_in_progress", "a restart is already under way", "flowryn daemon status");
    const supervisor = this.deps.supervisor();
    const why = await supervisor.supervised();
    if (why) throw new FlowrynError("not_supervised", `flowrynd is not running under ${supervisor.name === "launchd" ? "its launchd agent" : "a supervisor"}: ${why}`, "ask the user to run flowryn daemon stop, then flowryn daemon start, in their terminal");
    const target = await supervisor.target();
    if ("refusal" in target) throw target.refusal;
    const command = commandOf(target.program);
    const smoked = await (this.deps.smoke ?? smokeCheck)(command, this.deps.env);
    const running = this.deps.info().build ?? null;
    if (!force && smoked.build !== null && running !== null && smoked.build === running) {
      throw new FlowrynError("no_change", `${command.join(" ")} is the build this daemon already runs (${running})`, "build first, or pass --force to restart anyway");
    }
    return { supervisor: supervisor.name, target: { ...smoked, program: target.program } };
  }

  /** Decide, inside the verb's transaction. Throws restart_blocked or restart_cooldown. */
  request(caller: Caller, opts: { whenIdle: boolean; waitMin?: number; force: boolean; preflight: Preflight | null; cancel: boolean }): RequestOutcome {
    const { db } = this.deps;
    const now = this.deps.now();
    const who = requester(caller);
    if (opts.cancel) {
      const pending = readPending(db);
      if (pending) clearMeta(db, PENDING_KEY);
      appendEvent(db, { source: "daemon", kind: "daemon.restart_cancelled", payload: { ...who, had_pending: pending !== null }, ts: now });
      return { restart: "cancelled", had_pending: pending !== null };
    }
    const last = db.query("SELECT ts FROM events WHERE kind = 'daemon.restarted' ORDER BY seq DESC LIMIT 1").get() as { ts: number } | null;
    if (last && now - last.ts < RESTART_COOLDOWN_MS) {
      throw new FlowrynError("restart_cooldown", `flowrynd restarted ${Math.round((now - last.ts) / 1000)} s ago; a second restart waits ${RESTART_COOLDOWN_MS / 1000} s`, "do not retry in a loop; flowryn daemon status");
    }
    const guards = this.guards();
    // --when-idle never gets restart_blocked: guards that cleared after the check skipped the binary check, so park it and let tryPending run it.
    if (guards.length > 0 || (opts.whenIdle && !opts.preflight)) {
      if (!opts.whenIdle) {
        throw new FlowrynError(
          "restart_blocked",
          `a restart now would break ${guards.length === 1 ? "1 thing" : `${guards.length} things`}: ${guardLines(guards).join("; ")}`,
          "flowryn daemon restart --when-idle (restarts once these clear)",
        );
      }
      const earlier = readPending(db);
      const expires = earlier ? earlier.expires_at : now + (opts.waitMin ?? DEFAULT_WAIT_MIN) * 60_000;
      const pending: PendingRestart = { ...who, requested_at: earlier ? earlier.requested_at : now, expires_at: expires, force: opts.force };
      setMeta(db, PENDING_KEY, JSON.stringify(pending));
      appendEvent(db, { source: "daemon", kind: "daemon.restart_requested", payload: { ...who, when_idle: true, waiting_on: guardLines(guards), expires_at: expires }, ts: now });
      const outcome = { restart: "pending" as const, waiting_on: guardLines(guards), expires_at: expires, expires: localStamp(expires) };
      if (!earlier) return outcome;
      return { ...outcome, kept: `the earlier request's deadline (${localStamp(expires)})${opts.waitMin === undefined ? "" : "; --wait-min was ignored"}` };
    }
    // The guards cleared between the check and this transaction: the binary check has not run yet.
    if (!opts.preflight) throw new FlowrynError("restart_blocked", "what blocked the restart cleared a moment ago", "run flowryn daemon restart again");
    clearMeta(db, PENDING_KEY);
    return this.handoff(who, opts.preflight, opts.whenIdle);
  }

  /**
   * The build watcher's request (src/daemon/build-watch.ts): park an automatic
   * restart onto this build, waiting as long as a `--when-idle` may. A request
   * the leader or you already parked is kept, since it restarts onto the same
   * installed binary; an earlier automatic one is replaced. Call inside a
   * transaction.
   */
  requestAuto(trigger: { build: string; commit: string | null }): "parked" | "kept" {
    const { db } = this.deps;
    const now = this.deps.now();
    const earlier = readPending(db);
    if (earlier && earlier.by !== AUTO_REQUESTER) return "kept";
    const expires = now + MAX_WAIT_MIN * 60_000;
    const pending: PendingRestart = { by: AUTO_REQUESTER, session: null, requested_at: now, expires_at: expires, force: false, build: trigger.build, commit: trigger.commit };
    setMeta(db, PENDING_KEY, JSON.stringify(pending));
    appendEvent(db, {
      source: "daemon",
      kind: "daemon.restart_requested",
      payload: { by: AUTO_REQUESTER, session: null, when_idle: true, build: trigger.build, commit: trigger.commit, waiting_on: guardLines(this.guards()), expires_at: expires },
      ts: now,
    });
    return "parked";
  }

  /** Drop a parked automatic request without a P1: the build it was for is no longer the one to apply. Call inside a transaction. */
  private withdrawAuto(reason: string): void {
    const { db } = this.deps;
    clearMeta(db, PENDING_KEY);
    appendEvent(db, { source: "daemon", kind: "daemon.restart_withdrawn", payload: { by: AUTO_REQUESTER, reason }, ts: this.deps.now() });
  }

  private handoff(who: { by: string; session: string | null }, preflight: Preflight, whenIdle: boolean): RequestOutcome {
    const { db } = this.deps;
    const now = this.deps.now();
    const old = snapshotOf(this.deps.info(), now);
    const handoff: Handoff = { ...who, requested_at: now, old };
    setMeta(db, HANDOFF_KEY, JSON.stringify(handoff));
    appendEvent(db, {
      source: "daemon",
      kind: "daemon.restart_requested",
      payload: { ...who, when_idle: whenIdle, supervisor: preflight.supervisor, old, target: { version: preflight.target.version, proto: preflight.target.proto, build: preflight.target.build } },
      ts: now,
    });
    return { restart: "restarting", supervisor: preflight.supervisor, old, target: preflight.target };
  }

  /**
   * Ask the supervisor, once, after the reply has gone out. If the helper
   * fails while this daemon is still alive, the handoff is withdrawn and a
   * P1 says so; on success the supervisor stops this process.
   */
  kick(): void {
    if (this.kicked) return;
    this.kicked = true;
    const { log } = this.deps;
    setTimeout(() => {
      log("restart: asking the supervisor");
      let asked: Promise<{ ok: boolean; detail: string }>;
      try {
        asked = this.deps.supervisor().restart();
      } catch (error) {
        this.withdraw(`the supervisor could not be asked: ${(error as Error).message}`);
        return;
      }
      void asked.then(
        (outcome) => {
          if (!outcome.ok) this.withdraw(`the supervisor refused the restart: ${outcome.detail}`);
        },
        (error: unknown) => this.withdraw(`the supervisor could not be asked: ${error instanceof Error ? error.message : String(error)}`),
      );
    }, 50);
  }

  /** The kick failed while this daemon is still alive: take the handoff back and say so; never throws. */
  private withdraw(reason: string): void {
    const { db, log } = this.deps;
    log(`restart: ${reason}`);
    this.kicked = false;
    try {
      tx(db, () => {
        clearMeta(db, HANDOFF_KEY);
        this.drop(reason);
      });
    } catch (error) {
      log(`restart: could not record the dropped restart: ${(error as Error).message}`);
    }
  }

  /** Record a restart that will not happen, and tell the leader once. Call inside a transaction. */
  private drop(reason: string, kind = "daemon.restart_dropped"): void {
    const { db } = this.deps;
    const now = this.deps.now();
    const { seq } = appendEvent(db, { source: "daemon", kind, payload: { reason }, ts: now });
    if (!findOpenItem(db, "restart_dropped", null)) openItem(db, { kind: "restart_dropped", eventSeq: seq, line: `Daemon restart dropped: ${reason}`, now });
  }

  /** A parked `--when-idle` request: expire it, or run it once the guards clear. */
  async tryPending(): Promise<void> {
    if (this.polling || this.kicked) return;
    const { db } = this.deps;
    const pending = readPending(db);
    if (!pending) return;
    this.polling = true;
    try {
      const now = this.deps.now();
      if (now >= pending.expires_at) {
        const waited = guardLines(this.guards());
        tx(db, () => {
          clearMeta(db, PENDING_KEY);
          this.drop(`still waiting on ${waited.join("; ") || "nothing"} after ${Math.round((pending.expires_at - pending.requested_at) / 60_000)} min`, "daemon.restart_expired");
        });
        return;
      }
      await this.refreshValidations();
      if (this.guards().length > 0) return;
      const auto = pending.by === AUTO_REQUESTER;
      let preflight: Preflight;
      try {
        preflight = await this.preflight(pending.force);
      } catch (error) {
        const reason = error instanceof FlowrynError ? error.message : String(error);
        tx(db, () => {
          // Someone restarted onto this build already: nothing is left to do, and nothing to tell.
          if (auto && error instanceof FlowrynError && error.code === "no_change") this.withdrawAuto(reason);
          else {
            clearMeta(db, PENDING_KEY);
            this.drop(reason);
          }
        });
        return;
      }
      if (auto && pending.build && preflight.target.build !== pending.build) {
        // A newer build landed after the watcher parked this one; the watcher judges that one afresh.
        tx(db, () => {
          if (readPending(db)?.build === pending.build) this.withdrawAuto(`the installed build is now ${preflight.target.build ?? "unknown"}, not ${pending.build}`);
        });
        return;
      }
      const started = tx(db, () => {
        const current = readPending(db);
        if (!current || this.guards().length > 0) return false;
        if (auto && current.build !== pending.build) return false;
        clearMeta(db, PENDING_KEY);
        this.handoff({ by: pending.by, session: pending.session }, preflight, true);
        return true;
      });
      if (started) this.kick();
    } finally {
      this.polling = false;
    }
  }
}

/** A controller for tests and tools that build services without a daemon: never supervised. */
export function inertRestart(db: Db, info: () => DaemonInfo): RestartController {
  return new RestartController({
    db,
    env: {},
    now: Date.now,
    log: () => {},
    info,
    work: () => ({ mergesInFlight: [], cleanups: [], launching: [], approvalTasks: [] }),
    supervisor: () => ({
      name: "none",
      supervised: async () => "no supervisor in this process",
      target: async () => ({ refusal: new FlowrynError("not_supervised", "no supervisor") }),
      restart: async () => ({ ok: false, detail: "no supervisor" }),
    }),
  });
}
