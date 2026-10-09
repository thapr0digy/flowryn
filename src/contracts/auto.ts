import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DaemonInfo } from "../api/verbs.ts";
import { openItem, resolveItems } from "../attention/items.ts";
import type { FlowrynConfig } from "../config/config.ts";
import { policyMode } from "../config/policy.ts";
import { binDir } from "../daemon/caller-binary.ts";
import { smokeEnv } from "../daemon/restart.ts";
import { getMeta, setMeta, tx, type Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { HARNESS_IDS, type HarnessId } from "../harness/types.ts";
import {
  AUTO_BUILD_KEY,
  autoAttempt,
  contractsCommand,
  gateHarness,
  harnessItemKey,
  openUnverifiedItem,
  saveAutoAttempt,
  unverifiedItemOpened,
  unverifiedVersion,
  type AutoAttempt,
  type VersionOf,
} from "../lifecycle/harness-gate.ts";
import { usageGate } from "../sched/usage.ts";
import { autoRecordLine, reportProblem } from "./grant.ts";
import { recordPass } from "./verbs.ts";

/**
 * The automatic contract check (spec 3, phase 2): under `[policy] mode =
 * "relaxed"`, when the harness gate flags an untested Claude or Pi version,
 * the daemon runs the recording check itself, from its own running build,
 * instead of opening the P1 that asks you to. Plain code throughout: a state
 * per harness in meta, a child process, a report check; no model decides
 * anything (the suite's worker is the harness under test).
 *
 * - Level-triggered: every tick asks, per harness with a flagged untested
 *   version, whether to run a check, wait, or show the P1.
 * - One at a time; never while a restart is pending or under way (and while
 *   one runs, the restart waits on its `contract_check` guard); not while
 *   Herdr is unreachable or Claude is usage-paused, since a failure is final.
 * - Once per version: a failed check opens one P1 with its report path and
 *   is never retried for that version. A check cut off by a daemon stop
 *   runs again at the next start: it never finished, so it never failed. A
 *   pass that ends after a reload to strict is not recorded (`unrecorded`)
 *   and runs again once relaxed is back.
 * - From the running build: the child is the pinned copy of this daemon's own
 *   binary (`<state>/bin/flowryn-<build>`), never the installed one, which
 *   may already be newer. It runs `doctor --contracts --for-daemon`, writes a
 *   recording report and records nothing; the daemon checks the report
 *   (passing, recording, its own build) and records it here.
 */

/** A check that has not finished after this long is killed and counts as failed; each step has its own, shorter timeout. */
export const AUTO_MAX_RUN_MS = 2 * 60 * 60_000;
/** How often the checker looks again. */
export const AUTO_POLL_MS = 5_000;
/** How long a stopping daemon waits for the child to clean up after SIGTERM. */
const STOP_GRACE_MS = 10_000;

export interface AutoJob {
  harness: HarnessId;
  version: string;
  /** The pinned binary of the running build. */
  binary: string;
  /** Where the child's stderr goes. */
  logPath: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface AutoOutcome {
  exitCode: number | null;
  stdout: string;
  timedOut: boolean;
}

export interface AutoProcess {
  done: Promise<AutoOutcome>;
  /** SIGTERM, so the runner cleans up its scratch home and Herdr workspace. */
  terminate(): void;
  kill(): void;
}

export type AutoRunner = (job: AutoJob) => AutoProcess;

/** The default runner: the pinned binary's `doctor --contracts --for-daemon`, stderr to the log. */
export function spawnAutoCheck(job: AutoJob): AutoProcess {
  const fd = openSync(job.logPath, "a", 0o600);
  let proc;
  try {
    proc = Bun.spawn([job.binary, "doctor", "--contracts", "--for-daemon", "--harness", job.harness, "--json"], { env: job.env, stdin: "ignore", stdout: "pipe", stderr: fd });
  } finally {
    closeSync(fd);
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, job.timeoutMs);
  const done = Promise.all([new Response(proc.stdout).text(), proc.exited]).then(([stdout, exitCode]) => {
    clearTimeout(timer);
    return { exitCode, stdout, timedOut };
  });
  return { done, terminate: () => proc.kill("SIGTERM"), kill: () => proc.kill("SIGKILL") };
}

export interface AutoCheckDeps {
  db: Db;
  config(): FlowrynConfig;
  env: NodeJS.ProcessEnv;
  now(): number;
  log(message: string): void;
  info(): DaemonInfo;
  harnessVersion: VersionOf;
  /** A restart is pending or under way: a check now would be killed by it, or vouch for a build about to go. */
  restartBusy(): boolean;
  /** Why Herdr cannot run a check now, or null. */
  herdrDown(): string | null;
  /** After a record: launches and resumes that waited for this version can go. */
  afterPass(): void;
  run?: AutoRunner;
  pollMs?: number;
  maxRunMs?: number;
}

interface Current {
  harness: HarnessId;
  version: string;
  startedAt: number;
  process: AutoProcess | null;
}

function relaxed(config: FlowrynConfig): boolean {
  try {
    return policyMode(config) === "relaxed";
  } catch {
    return false;
  }
}

/** The report path and version a `--for-daemon` run prints; nulls when it printed none. */
export function parseHandoff(stdout: string): { report: string | null; version: string | null; detail: string | null } {
  try {
    const reply = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as { data?: { report?: unknown; version?: unknown; checks?: { status?: unknown; detail?: unknown }[] } };
    const data = reply.data ?? {};
    const report = typeof data.report === "string" && data.report !== "-" ? data.report : null;
    const version = typeof data.version === "string" && data.version !== "-" ? data.version : null;
    const failed = (data.checks ?? []).find((c) => c.status === "fail");
    return { report, version, detail: failed && typeof failed.detail === "string" ? failed.detail : null };
  } catch {
    return { report: null, version: null, detail: null };
  }
}

/**
 * The failure P1: the report (or, with none, the log) and the command. An
 * item line is cut at 200 characters, so the reason stays in the
 * contract.auto_failed event and the home directory is written as ~.
 */
export function autoFailureLine(harness: HarnessId, version: string, path: string, home: string): string {
  return `${harness} ${version} failed its automatic contract check: ${homeShort(path, home)}; rerun: ${contractsCommand(harness)}`;
}

/** The P1 for a pass that ended after a reload to strict: not recorded, with its report and the command that records one. Fits 200 characters, as the failure line does. */
export function autoUnrecordedLine(harness: HarnessId, version: string, report: string, home: string): string {
  return `${harness} ${version} passed, not recorded as [policy] is strict now: ${homeShort(report, home)}; record it: ${contractsCommand(harness)}`;
}

function homeShort(path: string, home: string): string {
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Is this attempt final for the version: passed or failed, or a pass strict left unrecorded while strict lasts? */
function settled(attempt: AutoAttempt | null, version: string, relaxedNow: boolean): boolean {
  if (attempt?.version !== version) return false;
  return attempt.state === "passed" || attempt.state === "failed" || (attempt.state === "unrecorded" && !relaxedNow);
}

export class AutoContractChecker {
  private readonly deps: AutoCheckDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private current: Current | null = null;
  private stopping = false;

  constructor(deps: AutoCheckDeps) {
    this.deps = deps;
  }

  /** The pinned binary of the running build, or null when this daemon cannot run a check from it (a development command, or no pinned copy). */
  pinnedBinary(): string | null {
    const build = this.deps.info().build;
    if (!build) return null;
    const path = join(binDir(this.deps.info().stateDir), `flowryn-${build}`);
    return existsSync(path) ? path : null;
  }

  /** What the restart guard shows while a check runs. */
  running(): { harness: string; version: string; startedAt: number }[] {
    return this.current ? [{ harness: this.current.harness, version: this.current.version, startedAt: this.current.startedAt }] : [];
  }

  /**
   * At daemon start: say whether this daemon can run checks (the gate reads
   * it), and put back in line a check a stopped daemon cut off.
   */
  init(): void {
    const { db } = this.deps;
    const now = this.deps.now();
    const binary = this.pinnedBinary();
    const build = binary ? this.deps.info().build! : "";
    tx(db, () => {
      if ((getMeta(db, AUTO_BUILD_KEY) ?? "") !== build) {
        setMeta(db, AUTO_BUILD_KEY, build);
        appendEvent(db, { source: "daemon", kind: "contract.auto_ready", payload: { build: build || null, eligible: Boolean(binary) }, ts: now });
      }
      for (const harness of HARNESS_IDS) {
        const attempt = autoAttempt(db, harness);
        if (attempt?.state !== "running") continue;
        saveAutoAttempt(db, harness, { version: attempt.version, state: "waiting", wait: "a rerun (the daemon stopped mid-check)" });
        appendEvent(db, { source: "daemon", kind: "contract.auto_interrupted", payload: { harness, version: attempt.version, started_at: attempt.started_at ?? null }, ts: now });
      }
    });
  }

  start(): void {
    this.init();
    this.kick();
    this.timer = setInterval(() => this.kick(), this.deps.pollMs ?? AUTO_POLL_MS);
  }

  kick(): void {
    void this.tick().catch((error: unknown) => this.deps.log(`contracts: automatic check pass failed: ${(error as Error).stack ?? String(error)}`));
  }

  /** Stop looking, and end a running check: SIGTERM so it cleans up, SIGKILL after the grace. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const proc = this.current?.process;
    if (!proc) return;
    proc.terminate();
    const ended = await Promise.race([proc.done.then(() => true), Bun.sleep(STOP_GRACE_MS).then(() => false)]);
    if (!ended) proc.kill();
  }

  /** One pass: start at most one check. Resolves once a started check has finished and been recorded. */
  async tick(): Promise<void> {
    if (this.ticking || this.current || this.stopping) return;
    this.ticking = true;
    try {
      for (const harness of HARNESS_IDS) {
        const flagged = unverifiedVersion(this.deps.db, harness);
        if (!flagged) continue;
        const relaxedNow = relaxed(this.deps.config());
        if (settled(autoAttempt(this.deps.db, harness), flagged, relaxedNow)) continue;
        const binary = this.pinnedBinary();
        if (!relaxedNow || !binary) {
          this.ensureItem(harness, flagged);
          continue;
        }
        if (this.holdFor(harness, flagged)) continue;
        // The probe counts as the check: a restart that starts meanwhile waits on its guard, and a stop sees it.
        this.current = { harness, version: flagged, startedAt: this.deps.now(), process: null };
        try {
          // The installed version now: a harness updated again since it was flagged is judged afresh (and a verified one settles).
          const check = await gateHarness(this.deps.db, this.deps.config(), harness, this.deps.harnessVersion, "daemon", "auto-check", this.deps.now);
          if (this.stopping) return;
          if (check.state !== "unverified") continue;
          if (!relaxed(this.deps.config())) {
            this.ensureItem(harness, check.version);
            continue;
          }
          if (settled(autoAttempt(this.deps.db, harness), check.version, true)) continue;
          if (this.holdFor(harness, check.version)) continue;
          await this.runCheck(harness, check.version, binary);
          return;
        } finally {
          this.current = null;
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Note the check waiting, if it must; true when it does. */
  private holdFor(harness: HarnessId, version: string): boolean {
    const wait = this.waitReason(harness);
    if (wait) this.noteWaiting(harness, version, wait);
    return wait !== null;
  }

  private waitReason(harness: HarnessId): string | null {
    if (this.deps.restartBusy()) return "a daemon restart";
    const herdr = this.deps.herdrDown();
    if (herdr) return `Herdr (${herdr})`;
    if (harness === "claude" && usageGate(this.deps.db, this.deps.now(), null) === "paused") return "the Claude usage pause";
    return null;
  }

  private noteWaiting(harness: HarnessId, version: string, wait: string): void {
    const { db } = this.deps;
    const attempt = autoAttempt(db, harness);
    if (attempt?.version === version && attempt.state === "waiting" && attempt.wait === wait) return;
    const now = this.deps.now();
    tx(db, () => {
      saveAutoAttempt(db, harness, { version, state: "waiting", wait });
      appendEvent(db, { source: "daemon", kind: "contract.auto_waiting", payload: { harness, version, wait }, ts: now });
    });
  }

  /** Strict mode, or a daemon that cannot run the check: the P1 as the gate opens it, once per version. */
  private ensureItem(harness: HarnessId, version: string): void {
    const { db } = this.deps;
    if (unverifiedItemOpened(db, harness, version)) return;
    const now = this.deps.now();
    tx(db, () => {
      if (unverifiedItemOpened(db, harness, version)) return;
      const event = appendEvent(db, { source: "daemon", kind: "harness.unverified", payload: { harness, version, where: "auto-check" }, ts: now });
      openUnverifiedItem(db, harness, version, event.seq, now);
    });
  }

  private async runCheck(harness: HarnessId, version: string, binary: string): Promise<void> {
    const { db, log } = this.deps;
    const startedAt = this.deps.now();
    const build = this.deps.info().build!;
    const dir = join(this.deps.config().data_dir, "contracts");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const logPath = join(dir, `auto-${harness}-${version}-${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}.log`);
    this.current = { harness, version, startedAt, process: null };
    try {
      tx(db, () => {
        saveAutoAttempt(db, harness, { version, state: "running", started_at: startedAt, build, log: logPath });
        appendEvent(db, { source: "daemon", kind: "contract.auto_started", payload: { harness, version, build, log: logPath }, ts: startedAt });
      });
      log(`contracts: automatic check of ${harness} ${version} from build ${build}; log ${logPath}`);
      const job: AutoJob = { harness, version, binary, logPath, env: smokeEnv(this.deps.env), timeoutMs: this.deps.maxRunMs ?? AUTO_MAX_RUN_MS };
      let outcome: AutoOutcome;
      try {
        this.current.process = (this.deps.run ?? spawnAutoCheck)(job);
        outcome = await this.current.process.done;
      } catch (error) {
        outcome = { exitCode: null, stdout: "", timedOut: false };
        log(`contracts: the automatic check of ${harness} ${version} could not run: ${(error as Error).message}`);
      }
      // A stopping daemon cut it off: the next start runs it again (init), so nothing is final here.
      if (this.stopping) return;
      this.finish(harness, version, build, logPath, startedAt, outcome);
    } finally {
      this.current = null;
    }
  }

  private finish(harness: HarnessId, version: string, build: string, logPath: string, startedAt: number, outcome: AutoOutcome): void {
    const { db, log } = this.deps;
    const now = this.deps.now();
    const handed = parseHandoff(outcome.stdout);
    const tested = handed.version ?? version;
    const problem = outcome.timedOut
      ? `it did not finish within ${Math.round((this.deps.maxRunMs ?? AUTO_MAX_RUN_MS) / 60_000)} min`
      : !handed.report
        ? `it wrote no report (exit ${outcome.exitCode ?? "on a signal"}${handed.detail ? `: ${handed.detail}` : ""})`
        : reportProblem(this.deps.config().data_dir, handed.report, { harness, version: tested, build });
    const strict = !relaxed(this.deps.config());
    if (!problem && strict) {
      this.leaveUnrecorded(harness, tested, build, logPath, startedAt, handed.report!);
      return;
    }
    if (!problem) {
      tx(db, () => {
        const seq = recordPass(db, { harness, version: tested, report: handed.report, by: "daemon", build, session: null, source: "daemon" }, now);
        openItem(db, { kind: "contract_recorded", eventSeq: seq, line: `${autoRecordLine(harness, tested, build)}; report ${handed.report}`, now });
        saveAutoAttempt(db, harness, { version: tested, state: "passed", started_at: startedAt, ended_at: now, build, report: handed.report, log: logPath });
      });
      log(`contracts: ${harness} ${tested} passed its automatic check and is recorded; report ${handed.report}`);
      this.deps.afterPass();
      return;
    }
    // The report's own path is in the line already: say "the report" in the reason.
    const why = problem!.replace(`${handed.report} `, "the report ");
    const where = handed.report ? `report ${handed.report}` : `log ${logPath}`;
    tx(db, () => {
      const event = appendEvent(db, { source: "daemon", kind: "contract.auto_failed", payload: { harness, version: tested, build, report: handed.report, log: logPath, detail: why }, ts: now });
      saveAutoAttempt(db, harness, { version: tested, state: "failed", started_at: startedAt, ended_at: now, build, report: handed.report, log: logPath, detail: why });
      resolveItems(db, "harness_unverified", harnessItemKey(harness), `automatic contract check of ${tested} failed`, now);
      openUnverifiedItem(db, harness, tested, event.seq, now, autoFailureLine(harness, tested, handed.report ?? logPath, homedir()));
    });
    log(`contracts: the automatic check of ${harness} ${tested} did not pass: ${why}; ${where}`);
  }

  /** A pass that ended after a reload to strict: never recorded while strict; a P1 says so, and a reload to relaxed runs the check again. */
  private leaveUnrecorded(harness: HarnessId, version: string, build: string, logPath: string, startedAt: number, report: string): void {
    const { db, log } = this.deps;
    const now = this.deps.now();
    const detail = "[policy] mode is strict now, so the daemon did not record its pass";
    tx(db, () => {
      const event = appendEvent(db, { source: "daemon", kind: "contract.auto_unrecorded", payload: { harness, version, build, report, log: logPath, detail }, ts: now });
      saveAutoAttempt(db, harness, { version, state: "unrecorded", started_at: startedAt, ended_at: now, build, report, log: logPath, detail });
      resolveItems(db, "harness_unverified", harnessItemKey(harness), `automatic contract check of ${version} passed unrecorded`, now);
      openUnverifiedItem(db, harness, version, event.seq, now, autoUnrecordedLine(harness, version, report, homedir()));
    });
    log(`contracts: ${harness} ${version} passed its automatic check, but ${detail}; report ${report}`);
  }
}
