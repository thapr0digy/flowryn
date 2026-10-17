import { spawn } from "node:child_process";
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
  attemptRevision,
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
import { quotaHolds } from "../sched/quota.ts";
import { usageGate } from "../sched/usage.ts";
import { autoRecordLine, reportProblem } from "./grant.ts";
import { MANIFEST_ENV, readManifest, recoverOwned, type CleanupOutcome } from "./owned.ts";
import { CONTRACT_CLEANUP_BUDGET_MS, removeScratchHome } from "./runner.ts";
import { reportFacts } from "./report.ts";
import { contractRevision } from "./revision.ts";
import { openContractRecorded, recordPass } from "./verbs.ts";

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
 * - One owner, one budget (docs/notes/2026-10-12-next-steps-md-e7.md): the
 *   checker owns the child, which runs in its own process group and keeps an
 *   ownership manifest of what it creates. Past its deadline the child gets
 *   SIGTERM and the runner's whole cleanup budget before its group is killed;
 *   a child that ended without cleaning up (killed, or its cleanup failed)
 *   has its manifest's resources released by the checker. Whether the suite
 *   passed and whether everything was released are recorded apart.
 * - Per contract revision (docs/notes/2026-10-12-next-steps-md-ez.md): an
 *   attempt names the revision it checks (one from before revisions is at the
 *   baseline), and one at another revision settles nothing for the daemon's
 *   own, so a pass or failure there never stops the check of a revision bump.
 */

/** A check that has not finished after this long is stopped and counts as failed; each step has its own, shorter timeout. */
export const AUTO_MAX_RUN_MS = 2 * 60 * 60_000;
/** How often the checker looks again. */
export const AUTO_POLL_MS = 5_000;
/** After SIGTERM at the deadline: the runner's whole cleanup budget, and a margin, before its group is killed. */
export const AUTO_STOP_GRACE_MS = CONTRACT_CLEANUP_BUDGET_MS + 10_000;
/** After SIGKILL: how long the checker waits for the child to be reaped before it releases the manifest's resources anyway. */
const KILL_WAIT_MS = 5_000;
/**
 * How long a stopping daemon waits for the child after SIGTERM: inside
 * launchd's 20 s exit timeout. A child still cleaning up is left to finish
 * (its own group outlives the daemon, and its cleanup bounds itself); the
 * next start releases whatever it left.
 */
const DAEMON_STOP_WAIT_MS = 10_000;

export interface AutoJob {
  harness: HarnessId;
  version: string;
  /** The pinned binary of the running build. */
  binary: string;
  /** Where the child's stderr goes. */
  logPath: string;
  /** Where the child keeps its ownership manifest (src/contracts/owned.ts). */
  manifest: string;
  env: NodeJS.ProcessEnv;
}

export interface AutoOutcome {
  exitCode: number | null;
  stdout: string;
  timedOut: boolean;
}

export interface AutoProcess {
  done: Promise<AutoOutcome>;
  /** SIGTERM to the runner, so it cleans up its scratch home, daemon and Herdr workspace. */
  terminate(): void;
  /** SIGKILL to the runner's whole process group (its scratch daemon too), never the Flowryn daemon's. */
  kill(): void;
}

export type AutoRunner = (job: AutoJob) => AutoProcess;

/** Signal a pid (or, negative, a process group) that may be gone already. */
function signal(target: number | undefined, sig: NodeJS.Signals): void {
  if (target === undefined) return;
  try {
    process.kill(target, sig);
  } catch {
    // gone already
  }
}

/**
 * The default runner: the pinned binary's `doctor --contracts --for-daemon`
 * in a process group of its own (detached), stdout piped, stderr to the log,
 * with the manifest path in its environment.
 */
export function spawnAutoCheck(job: AutoJob): AutoProcess {
  const fd = openSync(job.logPath, "a", 0o600);
  let child;
  try {
    child = spawn(job.binary, ["doctor", "--contracts", "--for-daemon", "--harness", job.harness, "--json"], {
      env: { ...job.env, [MANIFEST_ENV]: job.manifest },
      stdio: ["ignore", "pipe", fd],
      detached: true,
    });
  } finally {
    closeSync(fd);
  }
  const chunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<AutoOutcome>((resolve) => {
    let exited = false;
    const settle = (exitCode: number | null) => {
      if (exited) return;
      exited = true;
      resolve({ exitCode, stdout: Buffer.concat(chunks).toString("utf8"), timedOut: false });
    };
    child.once("error", () => settle(null));
    child.once("close", (code) => settle(code));
  });
  return { done, terminate: () => signal(child.pid, "SIGTERM"), kill: () => signal(child.pid === undefined ? undefined : -child.pid, "SIGKILL") };
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
  /** Release what a run's manifest names (recoverOwned by default). */
  recover?: (manifest: string) => Promise<CleanupOutcome>;
  pollMs?: number;
  maxRunMs?: number;
  /** After SIGTERM at the deadline, before SIGKILL (AUTO_STOP_GRACE_MS). */
  stopGraceMs?: number;
  /** After SIGTERM on a daemon stop, before the child is left to finish its own cleanup. */
  daemonStopWaitMs?: number;
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

/** A path under your home written with `~`, so an item line keeps more of what follows within its 200 characters. */
export function homeShort(path: string, home: string): string {
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * The P1 for a check that left something behind: what, and the manifest that
 * names it. The full list stays in the contract.auto_cleanup_failed event.
 */
export function autoLeftoverLine(harness: HarnessId, version: string, problems: string[], manifest: string, home: string): string {
  return `${harness} ${version}'s automatic contract check left resources behind (${problems.join("; ")}); manifest ${homeShort(manifest, home)}`;
}

/** An attempt's cleanup fields, apart from its result. */
function cleanupFields(cleanup: CleanupOutcome | null): Pick<AutoAttempt, "cleanup" | "cleanup_detail"> {
  if (!cleanup) return { cleanup: "none" };
  return cleanup.ok ? { cleanup: "ok" } : { cleanup: "failed", cleanup_detail: cleanup.problems.join("; ") };
}

/** Is this attempt final for the version at this revision: passed or failed, or a pass strict left unrecorded while strict lasts? */
function settled(attempt: AutoAttempt | null, version: string, revision: number, relaxedNow: boolean): boolean {
  if (attempt?.version !== version || attemptRevision(attempt) !== revision) return false;
  return attempt.state === "passed" || attempt.state === "failed" || (attempt.state === "unrecorded" && !relaxedNow);
}

export class AutoContractChecker {
  private readonly deps: AutoCheckDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private current: Current | null = null;
  private stopping = false;
  /** Checks a stopped daemon cut off, whose manifests are released before any new check starts. */
  private interrupted: { harness: HarnessId; version: string; manifest: string }[] = [];

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
        if (!attempt) continue;
        if (attempt.state !== "running") {
          if (attempt.state === "waiting" && attempt.manifest) this.interrupted.push({ harness, version: attempt.version, manifest: attempt.manifest });
          continue;
        }
        // The manifest stays on the attempt until its resources are settled, so a crash mid-release finds it again.
        const revision = attemptRevision(attempt);
        saveAutoAttempt(db, harness, { version: attempt.version, revision, state: "waiting", wait: "a rerun (the daemon stopped mid-check)", ...(attempt.manifest ? { manifest: attempt.manifest } : {}) });
        appendEvent(db, { source: "daemon", kind: "contract.auto_interrupted", payload: { harness, version: attempt.version, revision, started_at: attempt.started_at ?? null, manifest: attempt.manifest ?? null }, ts: now });
        if (attempt.manifest) this.interrupted.push({ harness, version: attempt.version, manifest: attempt.manifest });
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

  /**
   * Stop looking, and end a running check: SIGTERM so it cleans up. A child
   * still cleaning after the wait is left to finish (it bounds itself, in a
   * process group of its own); its attempt stays `running`, so the next start
   * releases what its manifest says it left.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const proc = this.current?.process;
    if (!proc) return;
    proc.terminate();
    const ended = await Promise.race([proc.done.then(() => true), Bun.sleep(this.deps.daemonStopWaitMs ?? DAEMON_STOP_WAIT_MS).then(() => false)]);
    if (!ended) this.deps.log(`contracts: the automatic check of ${this.current?.harness} ${this.current?.version} is still cleaning up; the next start releases what it leaves`);
  }

  /** One pass: start at most one check. Resolves once a started check has finished and been recorded. */
  async tick(): Promise<void> {
    if (this.ticking || this.current || this.stopping) return;
    this.ticking = true;
    try {
      await this.releaseInterrupted();
      if (this.stopping) return;
      for (const harness of HARNESS_IDS) {
        const flagged = unverifiedVersion(this.deps.db, harness);
        if (!flagged) continue;
        const revision = contractRevision(harness);
        const relaxedNow = relaxed(this.deps.config());
        if (settled(autoAttempt(this.deps.db, harness), flagged, revision, relaxedNow)) continue;
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
          if (settled(autoAttempt(this.deps.db, harness), check.version, revision, true)) continue;
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
    if (harness === "claude" && quotaHolds(this.deps.db)) return "the Claude quota floor";
    return null;
  }

  private noteWaiting(harness: HarnessId, version: string, wait: string): void {
    const { db } = this.deps;
    const revision = contractRevision(harness);
    const attempt = autoAttempt(db, harness);
    if (attempt?.version === version && attemptRevision(attempt) === revision && attempt.state === "waiting" && attempt.wait === wait) return;
    const now = this.deps.now();
    tx(db, () => {
      saveAutoAttempt(db, harness, { version, revision, state: "waiting", wait });
      appendEvent(db, { source: "daemon", kind: "contract.auto_waiting", payload: { harness, version, revision, wait }, ts: now });
    });
  }

  /** Strict mode, or a daemon that cannot run the check: the P1 as the gate opens it, once per version and revision. */
  private ensureItem(harness: HarnessId, version: string): void {
    const { db } = this.deps;
    const revision = contractRevision(harness);
    if (unverifiedItemOpened(db, harness, version, revision)) return;
    const now = this.deps.now();
    tx(db, () => {
      if (unverifiedItemOpened(db, harness, version, revision)) return;
      const event = appendEvent(db, { source: "daemon", kind: "harness.unverified", payload: { harness, version, revision, where: "auto-check" }, ts: now });
      openUnverifiedItem(db, harness, version, event.seq, now);
    });
  }

  private async runCheck(harness: HarnessId, version: string, binary: string): Promise<void> {
    const { db, log } = this.deps;
    const startedAt = this.deps.now();
    const build = this.deps.info().build!;
    const revision = contractRevision(harness);
    const dir = join(this.deps.config().data_dir, "contracts");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stem = join(dir, `auto-${harness}-${version}-${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}`);
    const logPath = `${stem}.log`;
    const manifest = `${stem}.owned.json`;
    this.current = { harness, version, startedAt, process: null };
    try {
      tx(db, () => {
        saveAutoAttempt(db, harness, { version, revision, state: "running", started_at: startedAt, build, log: logPath, manifest });
        appendEvent(db, { source: "daemon", kind: "contract.auto_started", payload: { harness, version, revision, build, log: logPath, manifest }, ts: startedAt });
      });
      log(`contracts: automatic check of ${harness} ${version} from build ${build}; log ${logPath}`);
      const job: AutoJob = { harness, version, binary, logPath, manifest, env: smokeEnv(this.deps.env) };
      let outcome: AutoOutcome;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const proc = (this.deps.run ?? spawnAutoCheck)(job);
        this.current.process = proc;
        // Past the deadline the check counts as failed however it then ends; a child that will not be reaped does not hold the checker.
        let deadlinePassed = false;
        const stopped = new Promise<AutoOutcome>((resolve) => {
          deadline = setTimeout(() => {
            deadlinePassed = true;
            log(`contracts: the automatic check of ${harness} ${version} passed its deadline; stopping it`);
            void this.escalate(proc).then(() => resolve({ exitCode: null, stdout: "", timedOut: true }));
          }, this.deps.maxRunMs ?? AUTO_MAX_RUN_MS);
        });
        outcome = await Promise.race([proc.done, stopped]);
        outcome = { ...outcome, timedOut: outcome.timedOut || deadlinePassed };
      } catch (error) {
        outcome = { exitCode: null, stdout: "", timedOut: false };
        log(`contracts: the automatic check of ${harness} ${version} could not run: ${(error as Error).message}`);
      } finally {
        clearTimeout(deadline);
      }
      // A stopping daemon cut it off: the next start runs it again and releases what it left (init), so nothing is final here.
      if (this.stopping) return;
      const cleanup = await this.settleCleanup(manifest);
      this.finish(harness, version, build, logPath, startedAt, outcome, { manifest, ...cleanupFields(cleanup) });
      this.recordCleanup(harness, version, manifest, cleanup);
    } finally {
      this.current = null;
    }
  }

  /** Past the deadline: SIGTERM, the runner's whole cleanup budget, then SIGKILL to its group and a short wait for it to be reaped. */
  private async escalate(proc: AutoProcess): Promise<void> {
    const ended = (ms: number) => Promise.race([proc.done.then(() => true), Bun.sleep(ms).then(() => false)]);
    proc.terminate();
    if (await ended(this.deps.stopGraceMs ?? AUTO_STOP_GRACE_MS)) return;
    this.deps.log("contracts: the automatic check did not stop after SIGTERM and its cleanup budget; killing its process group");
    proc.kill();
    await ended(KILL_WAIT_MS);
  }

  /**
   * Whether the run released what it created: the runner's own word when it
   * recorded a clean cleanup; otherwise the checker releases the manifest's
   * resources itself. Null when the run kept no manifest (it recorded
   * nothing it owned).
   */
  private async settleCleanup(manifest: string): Promise<CleanupOutcome | null> {
    const read = readManifest(manifest);
    if (!read.owned && !read.problem) return null;
    if (read.owned?.cleanup?.ok) return read.owned.cleanup;
    const recover =
      this.deps.recover ??
      ((path: string) => recoverOwned(path, { log: this.deps.log, removeHome: (home) => removeScratchHome(home, this.deps.log), now: this.deps.now }));
    try {
      return await recover(manifest);
    } catch (error) {
      return { ok: false, problems: [`releasing ${manifest} failed: ${(error as Error).message}`], by: "daemon", at: this.deps.now() };
    }
  }

  /** The cleanup's own record, apart from the check's result: an event, and one P1 when something was left. */
  private recordCleanup(harness: HarnessId, version: string, manifest: string, cleanup: CleanupOutcome | null): void {
    const { db, log } = this.deps;
    const now = this.deps.now();
    tx(db, () => {
      if (!cleanup || cleanup.ok) {
        appendEvent(db, {
          source: "daemon",
          kind: "contract.auto_cleanup",
          payload: { harness, version, ok: cleanup ? true : null, by: cleanup?.by ?? null, manifest, detail: cleanup ? null : "no manifest: the run recorded nothing it owned" },
          ts: now,
        });
        return;
      }
      const event = appendEvent(db, { source: "daemon", kind: "contract.auto_cleanup_failed", payload: { harness, version, by: cleanup.by, problems: cleanup.problems, manifest }, ts: now });
      openItem(db, { kind: "contract_leftover", eventSeq: event.seq, line: autoLeftoverLine(harness, version, cleanup.problems, manifest, homedir()), now });
    });
    if (cleanup && !cleanup.ok) log(`contracts: the automatic check of ${harness} ${version} left resources behind: ${cleanup.problems.join("; ")}; manifest ${manifest}`);
  }

  /** At the first pass after a start: release what checks a stopped daemon cut off left, before any new check starts. */
  private async releaseInterrupted(): Promise<void> {
    for (const cut of this.interrupted.splice(0)) {
      const cleanup = await this.settleCleanup(cut.manifest);
      const { db } = this.deps;
      tx(db, () => {
        const attempt = autoAttempt(db, cut.harness);
        if (attempt?.version === cut.version && attempt.manifest === cut.manifest) {
          const { manifest: _settled, ...rest } = attempt;
          saveAutoAttempt(db, cut.harness, { ...rest, ...cleanupFields(cleanup) });
        }
      });
      this.recordCleanup(cut.harness, cut.version, cut.manifest, cleanup);
    }
  }

  private finish(harness: HarnessId, version: string, build: string, logPath: string, startedAt: number, outcome: AutoOutcome, extra: Partial<AutoAttempt>): void {
    const { db, log } = this.deps;
    const now = this.deps.now();
    const handed = parseHandoff(outcome.stdout);
    const tested = handed.version ?? version;
    const revision = contractRevision(harness);
    const problem = outcome.timedOut
      ? `it did not finish within ${Math.round((this.deps.maxRunMs ?? AUTO_MAX_RUN_MS) / 60_000)} min`
      : !handed.report
        ? `it wrote no report (exit ${outcome.exitCode ?? "on a signal"}${handed.detail ? `: ${handed.detail}` : ""})`
        : reportProblem(this.deps.config().data_dir, handed.report, { harness, version: tested, build, revision });
    const strict = !relaxed(this.deps.config());
    if (!problem && strict) {
      this.leaveUnrecorded(harness, tested, revision, build, logPath, startedAt, handed.report!, extra);
      return;
    }
    if (!problem) {
      tx(db, () => {
        // reportProblem held the report to this daemon's revision, so the facts carry it.
        const facts = reportFacts(handed.report, harness, tested);
        const seq = recordPass(db, { harness, version: tested, report: handed.report, by: "daemon", build, session: null, source: "daemon", ...facts }, now);
        openContractRecorded(db, harness, seq, `${autoRecordLine(harness, tested, build)}; report ${handed.report}`, now);
        saveAutoAttempt(db, harness, { version: tested, revision, state: "passed", started_at: startedAt, ended_at: now, build, report: handed.report, log: logPath, ...extra });
      });
      log(`contracts: ${harness} ${tested} passed its automatic check and is recorded; report ${handed.report}`);
      this.deps.afterPass();
      return;
    }
    // The report's own path is in the line already: say "the report" in the reason.
    const why = problem!.replace(`${handed.report} `, "the report ");
    const where = handed.report ? `report ${handed.report}` : `log ${logPath}`;
    tx(db, () => {
      const event = appendEvent(db, { source: "daemon", kind: "contract.auto_failed", payload: { harness, version: tested, revision, build, report: handed.report, log: logPath, detail: why }, ts: now });
      saveAutoAttempt(db, harness, { version: tested, revision, state: "failed", started_at: startedAt, ended_at: now, build, report: handed.report, log: logPath, detail: why, ...extra });
      resolveItems(db, "harness_unverified", harnessItemKey(harness), `automatic contract check of ${tested} failed`, now);
      openUnverifiedItem(db, harness, tested, event.seq, now, autoFailureLine(harness, tested, handed.report ?? logPath, homedir()));
    });
    log(`contracts: the automatic check of ${harness} ${tested} did not pass: ${why}; ${where}`);
  }

  /** A pass that ended after a reload to strict: never recorded while strict; a P1 says so, and a reload to relaxed runs the check again. */
  private leaveUnrecorded(harness: HarnessId, version: string, revision: number, build: string, logPath: string, startedAt: number, report: string, extra: Partial<AutoAttempt>): void {
    const { db, log } = this.deps;
    const now = this.deps.now();
    const detail = "[policy] mode is strict now, so the daemon did not record its pass";
    tx(db, () => {
      const event = appendEvent(db, { source: "daemon", kind: "contract.auto_unrecorded", payload: { harness, version, revision, build, report, log: logPath, detail }, ts: now });
      saveAutoAttempt(db, harness, { version, revision, state: "unrecorded", started_at: startedAt, ended_at: now, build, report, log: logPath, detail, ...extra });
      resolveItems(db, "harness_unverified", harnessItemKey(harness), `automatic contract check of ${version} passed unrecorded`, now);
      openUnverifiedItem(db, harness, version, event.seq, now, autoUnrecordedLine(harness, version, report, homedir()));
    });
    log(`contracts: ${harness} ${version} passed its automatic check, but ${detail}; report ${report}`);
  }
}
