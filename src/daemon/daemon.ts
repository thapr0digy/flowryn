import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { BuildWatcher } from "./build-watch.ts";
import { daemonConfig } from "../config/daemon.ts";
import { validationConfig } from "../config/validation.ts";
import { upkeepConfig } from "../config/upkeep.ts";
import { MergeBuilder } from "../upkeep/build.ts";
import { Upkeep } from "../upkeep/upkeep.ts";
import { PolicyFollower } from "../upkeep/policy-follow.ts";
import { getProject, listProjects } from "../lifecycle/projects.ts";
import { pinCallerBinary, unpinForScript } from "./caller-binary.ts";
import { BUILD_STAMP } from "../build-stamp.ts";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { loadConfig, resolveTool, type FlowrynConfig } from "../config/config.ts";
import { assertSocketPathFits, flowrynHome, runDir, socketPath, spoolDir, stateFiles } from "../config/paths.ts";
import { getMeta, integrityProblems, migrate, openDb, setMeta, tx, type Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { backupIfDue } from "../db/backup.ts";
import { Gateway } from "../api/gateway.ts";
import { ingestSpool } from "../api/spool.ts";
import { serverVerb } from "../api/registry.ts";
import type { DaemonInfo, DaemonServices } from "../api/verbs.ts";
import { Journal, pendingIntents } from "../journal/journal.ts";
import { BacklogWatcher } from "../journal/watcher.ts";
import { processRunner, type TasksAxiRunner } from "../journal/tasks-axi.ts";
import { hashFile, readSnapshot, type JournalFile } from "../journal/snapshot.ts";
import { listen, request, type Listener } from "../transport/unix.ts";
import { ensureDir } from "../util/fsx.ts";
import { tryExclusiveLock, type HeldLock } from "../util/flock.ts";
import { ulid } from "../util/ulid.ts";
import { PROTO, VERSION } from "../version.ts";
import { fileLogger, type Log } from "./logger.ts";
import { PING_VERB } from "./system-verbs.ts";
import { herdrConfig, timingConfig, workersConfig } from "../config/workers.ts";
import { configSectionProblems, type ConfigStatus } from "../config/effective.ts";
import { exitRun, interruptRun, type ControlDeps } from "../lifecycle/control.ts";
import { UrgentPreempter } from "../lifecycle/urgent.ts";
import { harnessVersion, workerBinary, type FleetServices } from "../lifecycle/fleet-services.ts";
import { Launcher } from "../lifecycle/launcher.ts";
import { ReviewOpener } from "../lavish/opener.ts";
import { LavishPoller } from "../lavish/poller.ts";
import { SteerBus } from "../lifecycle/steers.ts";
import { Reconciler } from "../reconcile/reconciler.ts";
import { configureOwnedProcesses, recoverOwnedProcesses, runBounded, stopOwnedProcesses } from "../runtime/bounded.ts";
import { Operations } from "../lifecycle/operation-recovery.ts";
import { adapterFor } from "../harness/registry.ts";
import { HerdrClient } from "../runtime/herdr/client.ts";
import { HerdrRuntime } from "../runtime/herdr/runtime.ts";
import { LeaderRewake } from "../leader/rewake.ts";
import { resolveHerdrSocket } from "../runtime/herdr/socket.ts";
import { HerdrWatcher } from "../watch/herdr.ts";
import { awayConfig, leaderTiming, notificationsOff, notifyConfig, openerMode, recordingNotifierPath, reviewConfig } from "../config/leader.ts";
import { autoAway, expireAway } from "../attention/away.ts";
import type { AttentionServices } from "../attention/services.ts";
import { lsofPath } from "../policy/locks.ts";
import { NotifyPump, recordingNotify } from "../attention/notify.ts";
import { lastItemNo } from "../attention/items.ts";
import { syncOverdueTodos } from "../attention/todos-due.ts";
import { cleanupConfig, githubConfig, type GitHubConfig } from "../config/delivery.ts";
import { schedTiming } from "../config/workflows.ts";
import { GitHubForge, tokenSource } from "../forge/github.ts";
import { cleanupRun, type CleanupReport, type LandingDeps } from "../lifecycle/landing.ts";
import { getRun } from "../lifecycle/runs.ts";
import { ChallengeStore } from "../policy/approvals.ts";
import { gitLabel, gitRunner } from "../policy/git.ts";
import { HEAD_FETCH_TIMEOUT_MS } from "../policy/head-history.ts";
import type { DeliveryServices } from "../policy/services.ts";
import { DeliveryWatcher } from "../watch/delivery.ts";
import { Scheduler } from "../sched/scheduler.ts";
import type { SchedServices } from "../sched/services.ts";
import type { StartDeps } from "../lifecycle/dispatch.ts";
import { checkHarnessesAtStartup, gateHarness } from "../lifecycle/harness-gate.ts";
import { alertHerdrIfDue, herdrEpisode, noteHerdrDown, noteHerdrUp } from "../reconcile/herdr-health.ts";
import { PENDING_POLL_MS, RestartController, buildIdOfBytes, commandOf, handoffPending, readPending, recordRestarted, scriptSupervisor } from "./restart.ts";
import { AutoContractChecker } from "../contracts/auto.ts";
import { launchdSupervisor, plistSpecFor, selfCommand } from "../service/launchd.ts";
import { recoverVerifications, stopVerifications } from "../verify/runner.ts";
import { drainVerifyQueue, verifyRoot } from "../verify/start.ts";

export interface DaemonOptions {
  env?: NodeJS.ProcessEnv;
  logToStderr?: boolean;
  /** Maintenance pass: spool ingest, nightly backup, idempotency sweep. */
  passMs?: number;
  watcherIntervalMs?: number;
}

const DEFAULT_PASS_MS = 60_000;
/** The attention pump: notifications, and a nudge to leader waiters when an item opens. */
const ATTENTION_TICK_MS = 1_000;
const TOOL_TIMEOUT_MS = 10_000;
const SHUTDOWN_GRACE_MS = 12_000;
/** The daemon's own external commands still running at its stop get this long after SIGTERM. */
const OWNED_STOP_GRACE_MS = 2_000;

class StartupRefused extends Error {}

function say(message: string): void {
  process.stderr.write(`flowrynd: ${message}\n`);
}

async function runTool(path: string | null, args: string[], cwd?: string) {
  if (!path) return { exitCode: 127, stdout: "", stderr: "tool not found" };
  const result = await runBounded([path, ...args], { label: gitLabel(args), cwd, timeoutMs: TOOL_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
}

function ownedName(p: { pid: number; label: string }): string {
  return `${p.label} (pid ${p.pid})`;
}

/**
 * Startup: end the external commands a force-killed daemon left running (by
 * their recorded identity), and record what was ended, what could not be,
 * and any ledger entry that cannot be read (kept for the next start).
 */
async function recoverOwned(db: Db, dir: string, log: Log): Promise<void> {
  try {
    const found = await recoverOwnedProcesses(dir);
    if (found.ended.length + found.failed.length + found.unreadable.length + found.discarded.length === 0) return;
    if (found.ended.length > 0) log(`owned: ended ${found.ended.map(ownedName).join(", ")}, left running by the last daemon`);
    if (found.failed.length > 0) log(`owned: could not end ${found.failed.map((f) => `${ownedName(f)}: ${f.detail}`).join("; ")}; kept, and checked again at the next start`);
    if (found.unreadable.length > 0) log(`owned: cannot read ${found.unreadable.join(", ")}; kept`);
    if (found.discarded.length > 0) log(`owned: removed torn writes ${found.discarded.join(", ")}`);
    tx(db, () =>
      appendEvent(db, { source: "daemon", kind: "daemon.owned_recovery", payload: { ended: found.ended, failed: found.failed, unreadable: found.unreadable, discarded: found.discarded } }),
    );
  } catch (error) {
    log(`owned: startup recovery failed: ${(error as Error).message}`);
  }
}

/** Is some daemon already answering on this socket? A 300 ms probe, like a hook's. */
async function socketAnswers(path: string): Promise<boolean> {
  try {
    await request(path, { proto: PROTO, ulid: ulid(), verb: PING_VERB, args: {} }, { connectMs: 300, replyMs: 2_000 });
    return true;
  } catch {
    return false;
  }
}

/** The database's instance id, minted on first start; call inside the daemon.started transaction. */
function ensureInstanceId(db: Db): string {
  const existing = getMeta(db, "instance_id");
  if (existing) return existing;
  const id = randomBytes(8).toString("hex");
  setMeta(db, "instance_id", id);
  return id;
}

function missingTools(config: FlowrynConfig): string[] {
  return Object.entries(config.tools)
    .filter(([, path]) => path && !existsSync(path))
    .map(([name, path]) => `${name}=${path}`);
}

/**
 * Run flowrynd in the foreground until SIGTERM, SIGINT or `flowryn daemon
 * stop`. Startup follows design section 6: exclusive flock on the state
 * directory, exclusive socket bind, migrations, intent replay, spool ingest;
 * then the backlog watcher and the steady-state loop. Resolves with the exit
 * code.
 */
/**
 * This daemon's build id, from the bytes it hashes once; a compiled daemon
 * also pins them for its callers (src/daemon/caller-binary.ts). If pinning
 * fails, the link goes, so callers fall back to the installed binary rather
 * than an older pinned build. A development command has no build.
 */
function pinOwnBuild(stateDir: string, command: readonly string[], log: Log): string | null {
  if (command.length !== 1) return null;
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(command[0]!);
  } catch (error) {
    log(`build: cannot read ${command[0]}: ${(error as Error).message}`);
    return null;
  }
  const build = buildIdOfBytes(bytes);
  try {
    pinCallerBinary(stateDir, build, bytes);
  } catch (error) {
    log(`caller binary: not pinned, callers run ${command[0]}: ${(error as Error).message}`);
    try {
      unpinForScript(stateDir);
    } catch {
      // nothing to remove
    }
  }
  return build;
}

export async function runDaemon(options: DaemonOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const home = flowrynHome(env);
  let lock: HeldLock | null = null;
  let db: Db | null = null;
  let listener: Listener | null = null;
  let boundSocket = false;
  let removeSignals: (() => void) | null = null;
  let ownsProcesses = false;
  const sock = socketPath(home, env);

  try {
    let config = loadConfig(home).config;
    const sectionProblems = configSectionProblems(config, env);
    if (sectionProblems.length > 0) throw new StartupRefused(`config.toml: ${sectionProblems.join("; ")}`);
    // What `flowryn config` reports as this daemon's accepted configuration (daemon.config).
    let configStatus: ConfigStatus = { loaded_at: Date.now(), reload: null };
    ensureDir(config.state_dir, 0o700);
    ensureDir(config.data_dir, 0o700);
    ensureDir(runDir(home), 0o700);
    const files = stateFiles(config.state_dir);

    lock = tryExclusiveLock(files.lock);
    if (!lock) throw new StartupRefused(`another flowrynd holds ${files.lock}; only one daemon may own a state directory`);
    assertSocketPathFits(sock);
    if (existsSync(sock)) {
      if (await socketAnswers(sock)) throw new StartupRefused(`another daemon already answers on ${sock}`);
      unlinkSync(sock); // stale: left by a daemon that died without cleaning up
    }

    const log: Log = fileLogger(files.logs, options.logToStderr ?? false);
    db = openDb(files.db);
    const problems = integrityProblems(db);
    if (problems.length > 0) {
      log(`integrity check failed: ${problems.join("; ")}`);
      throw new StartupRefused(`flowryn.db failed its integrity check (${problems[0]}); restore it with: flowryn doctor --restore`);
    }
    const migrated = migrate(db);
    const database = db;
    const build = pinOwnBuild(config.state_dir, selfCommand(), log);
    const commit = BUILD_STAMP?.commit ?? null;
    const startedAt = Date.now();
    const { instance, restarted } = tx(database, () => {
      const id = ensureInstanceId(database);
      appendEvent(database, { source: "daemon", kind: "daemon.started", payload: { pid: process.pid, version: VERSION, proto: PROTO, build, commit, migrated, instance: id } });
      // A restart the old daemon asked for: record who asked, with the build before and after.
      return { instance: id, restarted: recordRestarted(database, { pid: process.pid, version: VERSION, proto: PROTO, build, commit }, startedAt) };
    });
    // This daemon owns its external commands from here (process groups and the ledger); first, end what the last one left.
    // Before the reconciler's first pass, where launch/resume/cancel operations recover: a relaunch's
    // `git worktree add` then never races a git the last daemon left holding the worktree's locks.
    const ownedDir = join(config.state_dir, "owned");
    await recoverOwned(database, ownedDir, log);
    configureOwnedProcesses({ dir: ownedDir, log });
    ownsProcesses = true;

    const journalFiles = (): Record<JournalFile, string> => ({ backlog: config.tasks.backlog, todos: config.tasks.todos });
    const runner = (): TasksAxiRunner | null => {
      const tasksAxi = resolveTool(config, "tasks_axi");
      return tasksAxi && existsSync(tasksAxi) ? processRunner(tasksAxi, resolveTool(config, "node")) : null;
    };
    const journal = new Journal({ db: database, files: journalFiles, runner, log });
    const watcher = new BacklogWatcher({ db: database, journal, files: journalFiles, runner, log, intervalMs: options.watcherIntervalMs });

    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    let stopRequested: ((reason: string) => void) | null = null;
    const stopped = new Promise<string>((resolve) => {
      stopRequested = resolve;
    });
    // Installed before any startup work, so a stop during a slow startup is still a clean exit 0.
    const onSignal = (signal: NodeJS.Signals) => stopRequested?.(signal);
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    removeSignals = () => {
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
    };
    const info: DaemonInfo = { pid: process.pid, version: VERSION, proto: PROTO, instance, startedAt, execPath: process.execPath, build, commit, socket: sock, stateDir: config.state_dir };

    // M2: the Herdr runtime, launcher and reconciler (design sections 5 and 6).
    const herdrSocket = await resolveHerdrSocket(config);
    let runtime = herdrSocket.socket ? new HerdrRuntime(new HerdrClient(herdrSocket.socket, { log })) : null;
    log(runtime ? `herdr: ${herdrSocket.socket}` : `herdr: not available (${herdrSocket.reason}); workers cannot start until it is`);
    // Herdr may start after the daemon (launchd starts it at login): the watcher looks for its socket again with backoff.
    const resolveRuntime = async (): Promise<boolean> => {
      if (runtime) return true;
      const found = await resolveHerdrSocket(config);
      if (!found.socket) return false;
      runtime = new HerdrRuntime(new HerdrClient(found.socket, { log }));
      log(`herdr: ${found.socket}`);
      return true;
    };
    const bus = new SteerBus();
    const timing = () => timingConfig(config);
    const git = (args: string[], cwd?: string) => runTool(resolveTool(config, "git"), args, cwd);
    let reconciler: Reconciler | null = null;
    let scheduler: Scheduler | null = null;
    const launcher = new Launcher({
      db: database,
      config: () => config,
      runtime: () => runtime,
      log,
      now: Date.now,
      git,
      flowrynBin: async () => workerBinary(config.state_dir),
      socketPath: sock,
      home,
      onSettled: (runId) => {
        bus.notify(runId);
        reconciler?.schedule(runId);
        // A launch that failed released its slots; a stage worker that started may free the queue.
        scheduler?.kick();
      },
    });
    const control: ControlDeps = { db: database, runtime: () => runtime, bus, timing, now: Date.now };
    const urgent = new UrgentPreempter({ db: database, timing, now: Date.now, runtime: () => runtime, interrupt: (runId) => interruptRun(control, runId, undefined, { recordRefusal: false }), log });
    // Launch, resume and cancel as operations (docs/notes/2026-10-13-next-steps-md-rz.md).
    const operations = new Operations({
      db: database,
      runtime: () => runtime,
      timing,
      now: Date.now,
      log,
      exitRun: (runId) => exitRun(control, runId),
      cancelled: async (runId) => {
        bus.forget(runId);
        scheduler?.kick();
        const run = getRun(database, runId);
        if (run?.workspace_id && runtime) await runtime.closeWorkspace(run.workspace_id).catch(() => undefined);
      },
      matchesHarness: (harness) => {
        const binary = resolveTool(config, harness);
        return binary ? (p) => adapterFor(harness).matchesProcess(p, binary) : null;
      },
      isLaunching: (runId) => launcher.isActive(runId),
    });
    const fleet: FleetServices = {
      runtime: () => runtime,
      bus,
      timing,
      launch: (runId, mode, operation) => launcher.start(runId, mode, operation),
      driveCancel: (operation) => operations.driveCancel(operation),
      isLaunching: (runId) => launcher.isActive(runId),
      flowrynBin: async () => workerBinary(config.state_dir),
      harnessVersion,
      exitRun: (runId) => exitRun(control, runId),
      interruptRun: async (runId, waitMs) => {
        const result = await interruptRun(control, runId, waitMs);
        // No hook follows an interrupt (M0 c04): the tools it cut end here.
        if (result.ok) urgent.tools.clear(runId);
        return result;
      },
      reconcile: (runId) => reconciler?.schedule(runId),
      turnEndGuard: () => workersConfig(config).turn_end_guard,
      continuations: new Map(),
      urgent,
    };
    reconciler = new Reconciler({
      db: database,
      runtime: () => runtime,
      launch: (runId, mode, operation) => launcher.start(runId, mode, operation),
      recoverOperation: (run, op) => operations.recover(run, op),
      isLaunching: (runId) => launcher.isActive(runId),
      bus,
      timing,
      log,
      now: Date.now,
      docker: () => resolveTool(config, "docker"),
      released: () => scheduler?.kick(),
      harnessGate: (harness) => gateHarness(database, config, harness, harnessVersion, "reconciler", "resume", Date.now),
      // The invariant pass judges the snapshot only once it matches the file: a hand edit is diffed first.
      backlogFresh: async () => {
        await watcher.refreshIfIdle("backlog");
        if (journal.locks.isHeld("backlog")) return false;
        const snapshot = readSnapshot(database, "backlog");
        return snapshot !== null && snapshot.contentHash === hashFile(config.tasks.backlog);
      },
    });
    const herdrWatcher = new HerdrWatcher({
      runtime: () => runtime,
      resolve: resolveRuntime,
      onPane: (paneId) => reconciler?.onPane(paneId),
      onConnected: (first) => {
        if (tx(database, () => noteHerdrUp(database, "herdr", Date.now()))) log("herdr: reachable again");
        reconciler?.schedule(undefined, first ? "startup" : "reconnect");
        // Launches deferred while Herdr was away go now.
        scheduler?.kick();
      },
      // Design section 16: Herdr unreachable is one P1 per episode, once it matters.
      onDown: (reason) =>
        tx(database, () => {
          noteHerdrDown(database, reason, "herdr", Date.now());
          alertHerdrIfDue(database, herdrConfig(config).unreachable_alert_ms, Date.now());
        }),
      log,
    });

    // M3: leader waiters, the leader clocks and notifications (design sections 9 and 10).
    const recorder = recordingNotifierPath(env);
    const notifyPump = new NotifyPump({
      db: database,
      config: () => config,
      runtime: () => runtime,
      now: Date.now,
      log,
      off: () => notificationsOff(env),
      ...(recorder ? { macos: recordingNotify(recorder) } : {}),
    });
    if (notificationsOff(env)) log("notify: off (FLOWRYN_NOTIFY=off or FLOWRYN_NOTIFIER=null): notifications are recorded, none is delivered");
    else if (recorder) log(`notify: the macOS channel records to ${recorder} (FLOWRYN_NOTIFIER)`);
    const attention: AttentionServices = {
      bus: new SteerBus(),
      timing: () => leaderTiming(config),
      notify: () => notifyConfig(config),
      kick: () => void notifyPump.tick(),
      lsof: lsofPath,
      turnOffsets: new Map(),
    };

    // M4: the forge, cleanup and the delivery watchers (design sections 4, 7 and 14).
    const github = (): GitHubConfig => githubConfig(config);
    let forgeCache: { key: string; forge: GitHubForge } | null = null;
    const forge = (): GitHubForge => {
      const g = github();
      const key = `${g.api_url} ${g.web_url} ${g.timeout_ms} ${g.token_env.join(",")}`;
      if (!forgeCache || forgeCache.key !== key) {
        const token = tokenSource(env, g.token_env, resolveTool(config, "gh"), g.api_url, g.web_url);
        forgeCache = { key, forge: new GitHubForge({ apiUrl: g.api_url, webUrl: g.web_url, token, timeoutMs: g.timeout_ms }) };
      }
      return forgeCache.forge;
    };
    const deliveryGit = gitRunner(resolveTool(config, "git") ?? "git", 120_000);
    const landingDeps: LandingDeps = {
      db: database,
      forge,
      github,
      cleanupConfig: () => cleanupConfig(config),
      git: deliveryGit,
      lsof: lsofPath,
      noMistakes: () => resolveTool(config, "no_mistakes"),
      exitWorker: async (runId) => {
        const exited = await exitRun(control, runId);
        return { ok: exited.ok, detail: exited.detail ?? exited.evidence };
      },
      closeWorkspace: async (runId) => {
        const run = getRun(database, runId);
        if (run?.workspace_id && runtime) await runtime.closeWorkspace(run.workspace_id);
      },
      kickJournal: () => journal.kick(),
      log,
      now: Date.now,
    };
    const cleanups = new Map<string, Promise<CleanupReport>>();
    let deliveryWatcher: DeliveryWatcher | null = null;
    let upkeep: Upkeep | null = null;
    let policyFollow: PolicyFollower | null = null;
    const delivery: DeliveryServices = {
      forge,
      github,
      git: deliveryGit,
      challenges: new ChallengeStore(),
      inFlight: new Set(),
      cleanup: (runId, opts) => {
        const running = cleanups.get(runId);
        if (running) return running;
        // A cleaned run released its slots and landed its task: the scheduler looks at once (design section 11).
        const attempt = cleanupRun(landingDeps, runId, opts).finally(() => {
          cleanups.delete(runId);
          scheduler?.kick();
        });
        // A landing moved a default branch: the upkeep pass syncs the checkout and builds a Flowryn merge.
        void attempt.then((report) => (report.state === "cleaned" ? upkeep?.kick() : undefined)).catch(() => undefined);
        // The merge moved main whatever the cleanup's outcome: in-flight ships may now lack its policy change.
        void attempt.finally(() => policyFollow?.kick()).catch(() => undefined);
        cleanups.set(runId, attempt);
        return attempt;
      },
      watch: () => deliveryWatcher?.kick(),
    };
    deliveryWatcher = new DeliveryWatcher({
      db: database,
      forge,
      webUrl: () => github().web_url,
      git: deliveryGit,
      headFetchGit: gitRunner(resolveTool(config, "git") ?? "git", HEAD_FETCH_TIMEOUT_MS),
      noMistakes: () => resolveTool(config, "no_mistakes"),
      nmTimeoutMs: () => cleanupConfig(config).nomistakes_timeout_ms,
      validationStuckMs: () => schedTiming(config).validation_stuck_ms,
      pollMs: () => github().poll_ms,
      ciWaitAlertMin: () => validationConfig(config).ci_wait_alert,
      inFlight: delivery.inFlight,
      cleanup: (runId) =>
        void delivery.cleanup(runId, { discardApproval: null, auto: true }).catch((error: unknown) => log(`cleanup ${runId}: ${(error as Error).stack ?? String(error)}`)),
      nudgeConflicts: () => upkeepConfig(config).nudge_conflicts,
      kickScheduler: () => scheduler?.kick(),
      log,
      now: Date.now,
    });

    // M5: the scheduler (design section 11): capacity grants, the host check and auto-dispatch.
    const startDeps: StartDeps = {
      db: database,
      config: () => config,
      runtime: () => runtime,
      harnessVersion,
      git: async (cwd, args) => {
        const result = await git(["-C", cwd, ...args]);
        return result.exitCode === 0 ? result.stdout.trim() : null;
      },
      now: Date.now,
    };
    scheduler = new Scheduler({
      db: database,
      config: () => config,
      now: Date.now,
      log,
      launch: (runId, mode, operation) => launcher.start(runId, mode, operation),
      isLaunching: (runId) => launcher.isActive(runId),
      exitWorker: async (runId) => {
        const exited = await exitRun(control, runId);
        return { ok: exited.ok, detail: exited.detail ?? exited.evidence };
      },
      notify: (runId) => bus.notify(runId),
      startDeps,
      kickJournal: () => journal.kick(),
      drainVerifies: (isStopped) =>
        drainVerifyQueue({
          stopped: isStopped,
          db: database,
          git: deliveryGit,
          now: Date.now,
          log,
          root: verifyRoot(config),
          released: () => scheduler?.kick(),
          config: () => config,
          forge,
          webUrl: () => github().web_url,
          projectPath: (projectId) => getProject(database, projectId)?.path ?? null,
          host: async () => (await scheduler?.hostCheck()) ?? { ok: false, sample: null, reason: "the scheduler is not running" },
        }),
    });
    const sched: SchedServices = {
      kick: () => scheduler?.kick(),
      passNow: async () => scheduler?.passNow(),
      grantNow: async (runId) => (await scheduler?.grantNow(runId)) ?? false,
      host: async () => (await scheduler?.hostCheck()) ?? { ok: false, sample: null, reason: "the scheduler is not running" },
    };

    // Leader-safe restart: the guards read this daemon's in-memory work; launchd (or a test's script) restarts it.
    const supervisorFile = env.FLOWRYN_SUPERVISOR;
    let autoCheck: AutoContractChecker | null = null;
    let builder: MergeBuilder | null = null;
    const restart = new RestartController({
      db: database,
      env,
      now: Date.now,
      log,
      info: () => info,
      work: () => ({
        mergesInFlight: delivery.inFlight,
        cleanups: cleanups.keys(),
        launching: launcher.activeRuns(),
        challenges: delivery.challenges.openChallenges(Date.now()),
        contractChecks: autoCheck?.running() ?? [],
        builds: builder?.building() ?? [],
      }),
      supervisor: () => (supervisorFile ? scriptSupervisor(supervisorFile, env) : launchdSupervisor(plistSpecFor(config, home, env), env)),
      readValidations: () => deliveryWatcher?.readValidations() ?? Promise.resolve(),
    });
    // The build watcher: a new installed build applies by itself, through the restart's guards.
    const buildWatch = new BuildWatcher({
      db: database,
      env,
      now: Date.now,
      log,
      config: () => daemonConfig(config),
      info: () => info,
      supervisor: () => (supervisorFile ? scriptSupervisor(supervisorFile, env) : launchdSupervisor(plistSpecFor(config, home, env), env)),
      restart,
      git: (args, cwd) => git(args, cwd),
    });
    // Spec 3, phase 3: the build after a Flowryn merge, and the upkeep hooks (src/upkeep/).
    const supervisor = () => (supervisorFile ? scriptSupervisor(supervisorFile, env) : launchdSupervisor(plistSpecFor(config, home, env), env));
    builder = new MergeBuilder({
      db: database,
      env,
      now: Date.now,
      log,
      git: gitRunner(resolveTool(config, "git") ?? "git", 300_000),
      running: () => ({ build: info.build ?? null, commit: info.commit ?? null }),
      source: () => BUILD_STAMP?.source ?? null,
      target: async () => {
        const sup = supervisor();
        if (await sup.supervised()) return null;
        const target = await sup.target();
        if ("refusal" in target) return null;
        const command = commandOf(target.program);
        return command.length === 1 ? command[0]! : null;
      },
      // Bun's own installer puts it in ~/.bun/bin, which launchd's PATH does not have.
      bun: () => resolveTool(config, "bun") ?? (existsSync(join(homedir(), ".bun", "bin", "bun")) ? join(homedir(), ".bun", "bin", "bun") : null),
      workDir: join(config.data_dir, "build"),
      logDir: stateFiles(config.state_dir).logs,
    });
    const restartBusy = () => restart.inProgress || readPending(database) !== null || handoffPending(database);
    upkeep = new Upkeep({
      db: database,
      config: () => upkeepConfig(config),
      now: Date.now,
      log,
      git: deliveryGit,
      projects: () => listProjects(database),
      builder,
      busy: () => (restartBusy() ? "a restart is asked for or under way" : cleanups.size > 0 ? "a cleanup is running" : null),
      sweep: async (runId) => {
        const report = await delivery.cleanup(runId, { discardApproval: null, auto: false, sweep: true });
        return { outcome: report.outcome, reason: report.reason, task: report.task };
      },
    });
    // Policy follow-through: a policy change on a default branch steers that project's in-flight ships to merge it.
    policyFollow = new PolicyFollower({
      db: database,
      config: () => validationConfig(config),
      now: Date.now,
      log,
      git: deliveryGit,
      projects: () => listProjects(database),
      kickScheduler: () => scheduler?.kick(),
    });
    // Relaxed policy: the daemon runs the recording contract check on a new harness version itself, from its own build.
    autoCheck = new AutoContractChecker({
      db: database,
      config: () => config,
      env,
      now: Date.now,
      log,
      info: () => info,
      harnessVersion,
      restartBusy,
      herdrDown: () => {
        if (!runtime) return "no Herdr socket";
        const episode = herdrEpisode(database);
        return episode ? episode.detail || "unreachable" : null;
      },
      afterPass: () => {
        scheduler?.kick();
        reconciler?.schedule();
      },
    });
    // A review gate's questions: the widget beside its page, and a lavish-axi poll per open gate.
    const lavishTool = (): string | null => {
      const found = resolveTool(config, "lavish_axi");
      return found && existsSync(found) ? found : null;
    };
    // Review pages open in your browser once the gate's poll listens (docs/notes/2026-10-10-review-pages-open-4b.md).
    const opener = openerMode(env);
    const reviewOpener = new ReviewOpener({ db: database, review: () => reviewConfig(config), mode: () => opener, log, now: Date.now });
    if (opener.kind === "off") log(`browser: review pages are not opened (${opener.why})`);
    else if (opener.kind === "record") log(`browser: review pages are recorded to ${opener.path} (FLOWRYN_OPENER), never opened`);
    const lavishPoller = new LavishPoller({ db: database, lavish: lavishTool, log, now: Date.now, pidDir: join(config.state_dir, "lavish-polls"), opener: reviewOpener, channelAlertMs: () => reviewConfig(config).channel_alert_ms });

    const services: DaemonServices = {
      db: database,
      config: () => config,
      configStatus: () => configStatus,
      journal,
      watcher,
      now: Date.now,
      log,
      info: () => info,
      requestShutdown: (reason) => setTimeout(() => stopRequested?.(reason), 10),
      runTool: (_tool, args, cwd) => git(args, cwd),
      fleet,
      attention,
      delivery,
      sched,
      restart,
      lavish: { kick: () => lavishPoller.kick() },
    };
    const gateway = new Gateway({ services, lookup: serverVerb, ready });

    listener = await listen(sock, (message) => gateway.handle(message), (error) => log(`socket: ${error.message}`));
    boundSocket = true;
    log(`started pid=${process.pid} version=${VERSION} proto=${PROTO} build=${build ?? "dev"} socket=${sock} state=${config.state_dir}`);
    if (restarted) log(`restart: asked by ${String(restarted.by)}; ${JSON.stringify(restarted.old)} → this daemon`);
    const missing = missingTools(config);
    if (missing.length > 0) log(`configured tools missing: ${missing.join(", ")}`);

    // Startup, in order: replay pending intents, ingest the spool, read both files.
    const pendingAtStart = pendingIntents(database).length;
    await journal.drain();
    log(`replay: ${pendingAtStart} pending at start, ${pendingIntents(database).length} still pending`);
    const spool = spoolDir(config.data_dir);
    const isIngested = (id: string) => database.query("SELECT 1 FROM spool_ingested WHERE ulid = ?1").get(id) !== null;
    const ingested = await ingestSpool(spool, gateway, isIngested, log);
    if (ingested.ingested + ingested.duplicates + ingested.rejected > 0) log(`spool: ${JSON.stringify(ingested)}`);
    await watcher.start();
    journal.start();
    const syncTodos = () => {
      try {
        const synced = tx(database, () => syncOverdueTodos(database, Date.now()));
        if (synced.opened.length + synced.resolved > 0) log(`attention: overdue to-dos: ${synced.opened.length} opened, ${synced.resolved} resolved`);
      } catch (error) {
        log(`attention: overdue to-do check failed: ${(error as Error).message}`);
      }
    };
    syncTodos();
    // Away mode: an expiry passed while the daemon was down, or since the last pass, ends it; its brief rides your next message.
    const expireAwayIfDue = () => {
      try {
        const ended = tx(database, () => expireAway(database, Date.now()));
        if (ended) log("away: expired; the return brief rides the next message");
      } catch (error) {
        log(`away: expiry check failed: ${(error as Error).message}`);
      }
    };
    expireAwayIfDue();
    // Automatic away, checked on every attention tick: the user has given the leader no input for
    // [away] auto_after_min; idle waiters look again at once. A failing check logs once until it recovers.
    let autoAwayFailing = false;
    const autoAwayIfDue = () => {
      try {
        const started = tx(database, () => autoAway(database, { afterMs: awayConfig(config).auto_after_min * 60_000, now: Date.now() }));
        autoAwayFailing = false;
        if (!started) return;
        log("away: started automatically after the user's inactivity");
        attention.bus.notifyAll();
      } catch (error) {
        if (!autoAwayFailing) log(`away: automatic start check failed: ${(error as Error).message}`);
        autoAwayFailing = true;
      }
    };
    // A verification the last daemon was running when it stopped: recorded as an error and requeued once, its worktree removed.
    try {
      const recovered = await recoverVerifications({ db: database, git: deliveryGit, now: Date.now, log, root: join(config.state_dir, "verify") });
      if (recovered > 0) log(`verify: ${recovered} left running by the last daemon, recorded as errors and requeued`);
    } catch (error) {
      log(`verify: startup recovery failed: ${(error as Error).message}`);
    }
    resolveReady();

    // Design section 5: every harness in use, its installed version against the passing contract records, before any launch.
    try {
      const checks = await checkHarnessesAtStartup(database, config, harnessVersion, Date.now);
      if (checks.length > 0) log(`harness: ${checks.map((c) => (c.state === "missing" ? `${c.harness} ${c.detail}` : `${c.harness} ${c.version} ${c.state}`)).join("; ")}`);
    } catch (error) {
      log(`harness: the startup version check failed: ${(error as Error).message}`);
    }

    // Reconciler startup (design section 6, steps 4-7): subscribe first so events buffer,
    // then reconcile every open run; afterwards every event plus a steady pass.
    await herdrWatcher.start();
    await reconciler.passNow("startup");
    deliveryWatcher.start();
    scheduler.start();
    lavishPoller.kick();
    const steady = setInterval(() => reconciler?.schedule(undefined, "steady"), timing().pass_ms);
    let seenItem = lastItemNo(database);
    // The leader waiter fallback: a holder whose waiter is gone gets a fixed line typed when a wake is due.
    const rewake = new LeaderRewake({ db: database, attention, config: () => config, runtime: () => runtime, now: Date.now, log, startedAt: Date.now() });
    const attentionTick = setInterval(() => {
      const latest = lastItemNo(database);
      if (latest !== seenItem) {
        seenItem = latest;
        attention.bus.notifyAll();
      }
      autoAwayIfDue();
      void notifyPump.tick();
      void rewake.tick();
    }, ATTENTION_TICK_MS);

    buildWatch.start();
    autoCheck.start();
    upkeep.start();
    policyFollow.start();
    const pendingRestart = setInterval(() => void restart.tryPending().catch((error: unknown) => log(`restart: pending check failed: ${(error as Error).message}`)), PENDING_POLL_MS);

    let passing = false;
    const pass = setInterval(() => {
      if (passing) return;
      passing = true;
      void (async () => {
        try {
          await ingestSpool(spool, gateway, isIngested, log);
          syncTodos();
          expireAwayIfDue();
          lavishPoller.kick();
          const backup = backupIfDue(database, stateFiles(config.state_dir).backups);
          if (backup) log(`backup: ${backup}`);
          gateway.sweepIdempotency(Date.now());
        } catch (error) {
          log(`pass failed: ${(error as Error).stack ?? String(error)}`);
        } finally {
          passing = false;
        }
      })();
    }, options.passMs ?? DEFAULT_PASS_MS);

    const onHup = () => {
      try {
        const next = loadConfig(home).config;
        const configProblems = configSectionProblems(next, env);
        if (configProblems.length > 0) throw new Error(configProblems.join("; "));
        if (next.state_dir !== config.state_dir) log("SIGHUP: state_dir changed; restart the daemon to use it");
        config = { ...next, state_dir: config.state_dir };
        const at = Date.now();
        configStatus = { loaded_at: at, reload: { at, outcome: "accepted", error: null } };
        watcher.rewatch();
        void watcher.checkAll("sighup");
        log("SIGHUP: configuration reloaded");
      } catch (error) {
        // The last valid configuration stays in force; only the outcome is recorded.
        configStatus = { ...configStatus, reload: { at: Date.now(), outcome: "rejected", error: (error as Error).message } };
        log(`SIGHUP: configuration not reloaded: ${(error as Error).message}`);
      }
    };
    process.on("SIGHUP", onHup);

    const reason = await stopped;
    log(`stopping: ${reason}`);
    scheduler.stop();
    stopVerifications();
    clearInterval(pass);
    clearInterval(steady);
    clearInterval(attentionTick);
    clearInterval(pendingRestart);
    buildWatch.stop();
    upkeep.stop();
    policyFollow.stop();
    await autoCheck.stop();
    reconciler.stop();
    lavishPoller.stop();
    reviewOpener.stop();
    deliveryWatcher.stop();
    herdrWatcher.stop();
    bus.close();
    urgent.close();
    attention.bus.close();
    removeSignals?.();
    process.off("SIGHUP", onHup);
    watcher.stop();
    const closing = listener.close();
    listener = null;
    await Promise.race([Promise.all([closing, journal.stop()]), Bun.sleep(SHUTDOWN_GRACE_MS)]);
    // After the journal settles or the shutdown grace runs out: what still runs goes. A tasks-axi
    // mutation cut here is one the grace did not cover; its intent replays on the next start.
    const owned = await stopOwnedProcesses(OWNED_STOP_GRACE_MS);
    if (owned.left.length > 0) log(`stopping: external commands that outlived SIGKILL (pids ${owned.left.join(", ")}) stay recorded for the next start, which ends a group whose leader is still alive and drops the entry of one whose leader is gone`);
    tx(database, () => appendEvent(database, { source: "daemon", kind: "daemon.stopped", payload: { reason } }));
    return 0;
  } catch (error) {
    if (error instanceof StartupRefused) {
      say(error.message);
      return 1;
    }
    say(`failed: ${(error as Error).stack ?? String(error)}`);
    return 1;
  } finally {
    removeSignals?.();
    if (ownsProcesses) configureOwnedProcesses(null);
    if (listener) await Promise.race([listener.close(), Bun.sleep(1_000)]);
    if (db) db.close();
    if (boundSocket) {
      try {
        if (existsSync(sock)) unlinkSync(sock);
      } catch {
        // already gone
      }
    }
    lock?.release();
  }
}
