import { existsSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
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
import { herdrConfig, timingConfig, workerConfigProblems } from "../config/workers.ts";
import { exitRun, interruptRun, type ControlDeps } from "../lifecycle/control.ts";
import { harnessVersion, workerBinary, type FleetServices } from "../lifecycle/fleet-services.ts";
import { Launcher } from "../lifecycle/launcher.ts";
import { LavishPoller } from "../lavish/poller.ts";
import { SteerBus } from "../lifecycle/steers.ts";
import { Reconciler } from "../reconcile/reconciler.ts";
import { HerdrClient } from "../runtime/herdr/client.ts";
import { HerdrRuntime } from "../runtime/herdr/runtime.ts";
import { resolveHerdrSocket } from "../runtime/herdr/socket.ts";
import { HerdrWatcher } from "../watch/herdr.ts";
import { leaderTiming, notificationsOff, notifyConfig, recordingNotifierPath } from "../config/leader.ts";
import type { AttentionServices } from "../attention/services.ts";
import { NotifyPump, recordingNotify } from "../attention/notify.ts";
import { lastItemNo } from "../attention/items.ts";
import { syncOverdueTodos } from "../attention/todos-due.ts";
import { cleanupConfig, githubConfig, type GitHubConfig } from "../config/delivery.ts";
import { GitHubForge, tokenSource } from "../forge/github.ts";
import { cleanupRun, type CleanupReport, type LandingDeps } from "../lifecycle/landing.ts";
import { getRun } from "../lifecycle/runs.ts";
import { ChallengeStore } from "../policy/approvals.ts";
import { gitRunner } from "../policy/git.ts";
import type { DeliveryServices } from "../policy/services.ts";
import { DeliveryWatcher } from "../watch/delivery.ts";
import { Scheduler } from "../sched/scheduler.ts";
import type { SchedServices } from "../sched/services.ts";
import type { StartDeps } from "../lifecycle/dispatch.ts";
import { checkHarnessesAtStartup, gateHarness } from "../lifecycle/harness-gate.ts";
import { alertHerdrIfDue, noteHerdrDown, noteHerdrUp } from "../reconcile/herdr-health.ts";

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

class StartupRefused extends Error {}

function say(message: string): void {
  process.stderr.write(`flowrynd: ${message}\n`);
}

async function runTool(path: string | null, args: string[], cwd?: string) {
  if (!path) return { exitCode: 127, stdout: "", stderr: "tool not found" };
  const proc = Bun.spawn([path, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const timer = setTimeout(() => proc.kill("SIGKILL"), TOOL_TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr };
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

/** lsof for the cleanup guard; launchd's PATH may not reach /usr/sbin. */
function lsofPath(): string | null {
  return Bun.which("lsof") ?? (existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : null);
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
export async function runDaemon(options: DaemonOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const home = flowrynHome(env);
  let lock: HeldLock | null = null;
  let db: Db | null = null;
  let listener: Listener | null = null;
  let boundSocket = false;
  let removeSignals: (() => void) | null = null;
  const sock = socketPath(home, env);

  try {
    let config = loadConfig(home).config;
    const workerProblems = workerConfigProblems(config);
    if (workerProblems.length > 0) throw new StartupRefused(`config.toml: ${workerProblems.join("; ")}`);
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
    const instance = tx(database, () => {
      const id = ensureInstanceId(database);
      appendEvent(database, { source: "daemon", kind: "daemon.started", payload: { pid: process.pid, version: VERSION, proto: PROTO, migrated, instance: id } });
      return id;
    });
    const startedAt = Date.now();

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
    const info: DaemonInfo = { pid: process.pid, version: VERSION, proto: PROTO, instance, startedAt, execPath: process.execPath, socket: sock, stateDir: config.state_dir };

    // M2: the Herdr runtime, launcher and reconciler (design sections 5 and 6).
    const herdrSocket = await resolveHerdrSocket(config);
    let runtime = herdrSocket.socket ? new HerdrRuntime(new HerdrClient(herdrSocket.socket)) : null;
    log(runtime ? `herdr: ${herdrSocket.socket}` : `herdr: not available (${herdrSocket.reason}); workers cannot start until it is`);
    // Herdr may start after the daemon (launchd starts it at login): the watcher looks for its socket again with backoff.
    const resolveRuntime = async (): Promise<boolean> => {
      if (runtime) return true;
      const found = await resolveHerdrSocket(config);
      if (!found.socket) return false;
      runtime = new HerdrRuntime(new HerdrClient(found.socket));
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
    const fleet: FleetServices = {
      runtime: () => runtime,
      bus,
      timing,
      launch: (runId, mode) => launcher.start(runId, mode),
      isLaunching: (runId) => launcher.isActive(runId),
      flowrynBin: async () => workerBinary(config.state_dir),
      harnessVersion,
      exitRun: (runId) => exitRun(control, runId),
      interruptRun: (runId, waitMs) => interruptRun(control, runId, waitMs),
      reconcile: (runId) => reconciler?.schedule(runId),
      continuations: new Map(),
    };
    reconciler = new Reconciler({
      db: database,
      runtime: () => runtime,
      launch: (runId, mode) => launcher.start(runId, mode),
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
      noMistakes: () => resolveTool(config, "no_mistakes"),
      nmTimeoutMs: () => cleanupConfig(config).nomistakes_timeout_ms,
      pollMs: () => github().poll_ms,
      inFlight: delivery.inFlight,
      cleanup: (runId) =>
        void delivery.cleanup(runId, { discardApproval: null, auto: true }).catch((error: unknown) => log(`cleanup ${runId}: ${(error as Error).stack ?? String(error)}`)),
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
      launch: (runId, mode) => launcher.start(runId, mode),
      isLaunching: (runId) => launcher.isActive(runId),
      exitWorker: async (runId) => {
        const exited = await exitRun(control, runId);
        return { ok: exited.ok, detail: exited.detail ?? exited.evidence };
      },
      notify: (runId) => bus.notify(runId),
      startDeps,
      kickJournal: () => journal.kick(),
    });
    const sched: SchedServices = { kick: () => scheduler?.kick(), passNow: async () => scheduler?.passNow(), grantNow: async (runId) => (await scheduler?.grantNow(runId)) ?? false };

    // A review gate's questions: the widget beside its page, and a lavish-axi poll per open gate.
    const lavishPoller = new LavishPoller({ db: database, lavish: () => resolveTool(config, "lavish_axi"), log, now: Date.now });

    const services: DaemonServices = {
      db: database,
      config: () => config,
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
      lavish: { kick: () => lavishPoller.kick() },
    };
    const gateway = new Gateway({ services, lookup: serverVerb, ready });

    listener = await listen(sock, (message) => gateway.handle(message), (error) => log(`socket: ${error.message}`));
    boundSocket = true;
    log(`started pid=${process.pid} version=${VERSION} proto=${PROTO} socket=${sock} state=${config.state_dir}`);
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
    const attentionTick = setInterval(() => {
      const latest = lastItemNo(database);
      if (latest !== seenItem) {
        seenItem = latest;
        attention.bus.notifyAll();
      }
      void notifyPump.tick();
    }, ATTENTION_TICK_MS);

    let passing = false;
    const pass = setInterval(() => {
      if (passing) return;
      passing = true;
      void (async () => {
        try {
          await ingestSpool(spool, gateway, isIngested, log);
          syncTodos();
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
        const configProblems = workerConfigProblems(next);
        if (configProblems.length > 0) throw new Error(configProblems.join("; "));
        if (next.state_dir !== config.state_dir) log("SIGHUP: state_dir changed; restart the daemon to use it");
        config = { ...next, state_dir: config.state_dir };
        watcher.rewatch();
        void watcher.checkAll("sighup");
        log("SIGHUP: configuration reloaded");
      } catch (error) {
        log(`SIGHUP: configuration not reloaded: ${(error as Error).message}`);
      }
    };
    process.on("SIGHUP", onHup);

    const reason = await stopped;
    log(`stopping: ${reason}`);
    clearInterval(pass);
    clearInterval(steady);
    clearInterval(attentionTick);
    reconciler.stop();
    scheduler.stop();
    lavishPoller.stop();
    deliveryWatcher.stop();
    herdrWatcher.stop();
    bus.close();
    attention.bus.close();
    removeSignals?.();
    process.off("SIGHUP", onHup);
    watcher.stop();
    const closing = listener.close();
    listener = null;
    await Promise.race([Promise.all([closing, journal.stop()]), Bun.sleep(SHUTDOWN_GRACE_MS)]);
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
