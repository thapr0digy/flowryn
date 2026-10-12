import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashToken, mintToken } from "../api/auth.ts";
import type { Reply } from "../api/envelope.ts";
import { resolveTool, type FlowrynConfig } from "../config/config.ts";
import { requireNotificationsOff } from "../config/leader.ts";
import { socketPath, stateFiles } from "../config/paths.ts";
import { renderToml } from "../config/toml.ts";
import { workersConfig } from "../config/workers.ts";
import { claudeConfigDir } from "../harness/claude/trust.ts";
import { migrate, openDb, tx, type Db } from "../db/db.ts";
import { PING_VERB } from "../daemon/system-verbs.ts";
import type { HarnessId } from "../harness/types.ts";
import { harnessVersion } from "../lifecycle/fleet-services.ts";
import type { RunRow } from "../lifecycle/runs.ts";
import type { MessageRow } from "../lifecycle/steers.ts";
import { descendantCommands, isAlive, readIdentity, readProcessTable, terminate } from "../runtime/proc.ts";
import { contractPrefix } from "./cleanup.ts";
import { RELEASE_LIMITS, createdWorkspaces, harnessProcesses, releaseOwned, writeManifest, type CleanupOutcome, type OwnedResources } from "./owned.ts";
import { piAgentDir, piAgentSource, realPiTable, scriptedPiTable, seedAgentDir, writeScriptedProvider, type PiProfile } from "./pi-profile.ts";
import { pinDrift, pinHarness, type HarnessPin } from "./pin.ts";
import { selfCommand } from "../service/launchd.ts";
import { request } from "../transport/unix.ts";
import { ulid } from "../util/ulid.ts";
import { PROTO } from "../version.ts";
import { contractBody, contractSteps, type ContractEnv, type ContractEvent, type ContractState, type ContractStep } from "./suite.ts";

export interface ContractOptions {
  harness: HarnessId;
  /** The real Flowryn config: tools, worker profiles and style carry over to the scratch home. */
  config: FlowrynConfig;
  herdrSocket: string;
  /** A checkout the worker's worktree is created from (its current branch is the base); default a scratch repo. */
  project: string | null;
  /** Override the worker model for this run: Claude's, or the model of a Pi `real` pass (the Pi gate is always scripted). */
  model: string | null;
  /**
   * Pi only: `scripted` (the default, and the gate) plays the model with the
   * offline scripted provider; `real` is the opt-in informational pass on
   * `model` (src/contracts/pi-profile.ts).
   */
  piProfile?: PiProfile;
  keep: boolean;
  /**
   * Where to keep the ownership manifest (src/contracts/owned.ts): the
   * daemon's automatic check names one, so it can release what a killed run
   * left. Null for a run in your terminal.
   */
  manifest?: string | null;
  log(line: string): void;
}

export interface StepResult {
  step: string;
  ok: boolean;
  detail: string;
  seconds: number;
}

export interface ContractResult {
  harness: HarnessId;
  version: string;
  passed: boolean;
  steps: StepResult[];
  scratch: string;
  /** Whether the run released everything it created: separate from `passed`, the suite's own result. */
  cleanup: CleanupOutcome;
}

/**
 * Contract runs never re-ring a steer on the ring interval mid-suite; the
 * waiter's long poll and the fast re-ring of a lost or unseen carry keep the
 * design's clock, so the steer timings are what production sees.
 */
const CONTRACT_TIMING = { pass_ms: 1_000, ring_interval_ms: 600_000, launch_timeout_ms: 30_000 };

/** How often the runner re-reads the scratch database while it waits; step seconds carry at most this much slack. */
const WAIT_POLL_MS = 100;

/** How long the runner keeps removing its scratch home while something recreates part of it, and the quiet spell that proves it gone. */
const REMOVE_DEADLINE_MS = 10_000;
const REMOVE_QUIET_MS = 250;

/** Cleanup's first steps: the cancel request (connect, reply), then the scratch daemon's SIGTERM grace and its SIGKILL wait. */
const CANCEL_CONNECT_MS = 1_000;
const CANCEL_REPLY_MS = 15_000;
const DAEMON_TERM_MS = 15_000;
const DAEMON_KILL_MS = 5_000;

/**
 * The most a contract run's cleanup takes: the sum of its bounded steps for
 * the one run a suite dispatches (cancel, the scratch daemon, a workspace, a
 * harness, the caller's worktrees, the scratch home). The runner holds itself
 * to it after a signal, and the daemon's automatic check waits this long
 * after SIGTERM before it kills the runner (src/contracts/auto.ts).
 */
export const CONTRACT_CLEANUP_BUDGET_MS =
  CANCEL_CONNECT_MS +
  CANCEL_REPLY_MS +
  DAEMON_TERM_MS +
  DAEMON_KILL_MS +
  RELEASE_LIMITS.workspaceCloseMs +
  RELEASE_LIMITS.processGraceMs +
  RELEASE_LIMITS.processKillMs +
  RELEASE_LIMITS.worktreesMs +
  REMOVE_DEADLINE_MS +
  2 * REMOVE_QUIET_MS;

/**
 * FLOWRYN_CONTRACT_MAX_WAIT_MS caps every step's wait. The offline contract
 * test (test/integration/contracts-offline.test.ts) sets it: its fakes answer
 * in seconds, so a broken step fails there at once, naming itself, rather than
 * after a live model's minutes.
 */
function maxWaitMs(env: NodeJS.ProcessEnv): number {
  const value = Number(env.FLOWRYN_CONTRACT_MAX_WAIT_MS);
  return Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
}

/**
 * The suite launches the one worker you asked for, so the host check that
 * guards autonomous capacity (design section 11) refuses it only when the
 * machine is truly out of room; with the defaults (8 GB free) a busy laptop
 * never granted the launch, and the suite timed out at its first step.
 */
// You asked for this run: the quota floor does not hold it (the daemon's own auto check waits on it instead).
const CONTRACT_CAPACITY = { worker: 1, host: { min_free_mem_gb: 1, max_load_per_core: 8 }, quota: { floor: 0 } };

/** git as a contract run uses it on the caller's checkout (and the daemon, releasing what a killed run left there). */
export function git(args: string[], cwd: string): { code: number; out: string } {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdin: "ignore",
    env: { ...process.env, GIT_AUTHOR_NAME: "flowryn", GIT_AUTHOR_EMAIL: "flowryn@localhost", GIT_COMMITTER_NAME: "flowryn", GIT_COMMITTER_EMAIL: "flowryn@localhost" },
  });
  return { code: result.exitCode, out: result.stdout.toString().trim() };
}

function scratchRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "README.md"), "Flowryn contract scratch project\n");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "init"], dir);
  return dir;
}

/** The scratch home's config.toml: the real config's tools, workers and style, with the harness pinned. */
export function scratchConfig(options: ContractOptions, pin: HarnessPin, home: string, branchPrefix: string): string {
  const real = options.config;
  const workers: Record<string, unknown> = { ...(real.extra.workers as Record<string, unknown> | undefined) };
  workers.worktree_root = join(home, "wt");
  workers.branch_prefix = branchPrefix;
  // The contract worker ends its turns without an outcome on purpose; a reminder would keep it busy past the idle step.
  workers.turn_end_guard = false;
  if (options.harness === "pi") {
    const own = workers.pi as Record<string, unknown> | undefined;
    if (options.piProfile === "real") {
      if (!options.model) throw new Error("a real-model Pi pass needs a model");
      workers.pi = realPiTable(own, options.model, home);
    } else workers.pi = scriptedPiTable(home);
  } else if (options.model) workers[options.harness] = { ...(workers[options.harness] as Record<string, unknown> | undefined), model: options.model };
  const data: Record<string, unknown> = {
    data_dir: join(home, "data"),
    state_dir: join(home, "state"),
    tasks: { backlog: join(home, "data", "backlog.md"), todos: join(home, "data", "todos.md") },
    // Launch and resume run the pinned file, so an update mid-run cannot change the version under test.
    tools: { ...real.tools, [pin.harness]: pin.binary },
    herdr: { socket: options.herdrSocket },
    workers,
    reconcile: CONTRACT_TIMING,
    capacity: CONTRACT_CAPACITY,
  };
  if (real.extra.style) data.style = real.extra.style;
  return renderToml(data, "Scratch home for a Flowryn harness contract run");
}

/**
 * Run one harness's contract suite end to end (design section 5): a scratch
 * Flowryn home and daemon, one real worker in the given Herdr session, every
 * step in order. The scratch daemon is its own lease holder, and the version
 * under test is marked passed there only so its dispatch gate lets the run
 * start; the caller records a real pass only if every step passes.
 */
export async function runContract(options: ContractOptions): Promise<ContractResult> {
  const configured = resolveTool(options.config, options.harness);
  if (!configured) throw new Error(`${options.harness} is not installed or not in [tools]`);
  const pin = await pinHarness(options.harness, configured, harnessVersion);
  const { version } = pin;
  options.log(`${options.harness} ${version} pinned at ${pin.binary}`);
  const drift = () => pinDrift(pin, harnessVersion);
  const home = realpathSync(mkdtempSync(join(tmpdir(), "fwc-")));
  const { prefix } = contractPrefix();
  // What this run owns, kept where its owner can read it if this process is killed (src/contracts/owned.ts).
  let owned: OwnedResources = {
    runner: null,
    home,
    herdr_socket: options.herdrSocket,
    branch_prefix: prefix,
    project: null,
    daemon: null,
    workspaces: [],
    harnesses: [],
    cleanup: null,
  };
  const note = (change: Partial<OwnedResources>) => {
    owned = { ...owned, ...change };
    if (!options.manifest) return;
    try {
      writeManifest(options.manifest, owned);
    } catch (error) {
      options.log(`could not write the ownership manifest ${options.manifest}: ${(error as Error).message}`);
    }
  };
  note({});
  const leader = mintToken("leader");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("FLOWRYN_")) env[k] = v;
  env.FLOWRYN_HOME = home;
  // A contract run's scratch daemon delivers no notification to your Mac (or Herdr).
  env.FLOWRYN_NOTIFY = "off";
  requireNotificationsOff(env, "the contract runner");
  const sock = socketPath(home, env);

  const call = async (verb: string, args: Record<string, unknown>, replyMs = 60_000) => {
    const reply = (await request(sock, { proto: PROTO, ulid: ulid(), verb, token: leader, args }, { connectMs: CANCEL_CONNECT_MS, replyMs })) as Reply;
    return { ok: reply.ok, data: (reply.data ?? {}) as Record<string, unknown>, error: reply.error as { code: string; message: string } | undefined };
  };
  let daemon: ReturnType<typeof Bun.spawn> | null = null;
  let db: Db | null = null;
  let state: ContractState | null = null;
  let cleaning: Promise<CleanupOutcome> | null = null;
  // Runs once, from the finally block or from a signal: nothing this run created outlives it, or it says what did.
  const cleanup = () =>
    (cleaning ??= (async (): Promise<CleanupOutcome> => {
      db?.close();
      db = null;
      const problems: string[] = [];
      try {
        note({ workspaces: createdWorkspaces(home), harnesses: harnessProcesses(home) });
      } catch (error) {
        problems.push(`the scratch database is unreadable, so its workspaces and harnesses are unknown: ${(error as Error).message}`);
      }
      problems.push(...(await teardown(call, state, daemon)));
      // A run that failed is not cancellable, so its workspace may still be open; release everything by id.
      problems.push(...(await releaseOwned(owned, { git, log: options.log, removeHome: (path) => (options.keep ? Promise.resolve(true) : removeScratchHome(path, options.log)) })));
      const outcome: CleanupOutcome = { ok: problems.length === 0, problems, by: "runner", at: Date.now() };
      for (const problem of problems) options.log(`cleanup: ${problem}`);
      note({ cleanup: outcome });
      return outcome;
    })());
  // A signal (the daemon's automatic check stopping this run, or ^C) cleans up within the budget, then exits.
  // A second signal while cleaning is ignored: dying half way would leave what the cleanup was releasing.
  let signalled = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (signalled) {
      options.log(`${signal}: already cleaning up`);
      return;
    }
    signalled = true;
    options.log(`${signal}: cleaning up before exit`);
    const overdue = Bun.sleep(CONTRACT_CLEANUP_BUDGET_MS).then(() => {
      const outcome: CleanupOutcome = { ok: false, problems: [`cleanup did not finish within ${CONTRACT_CLEANUP_BUDGET_MS / 1000} s`], by: "runner", at: Date.now() };
      note({ cleanup: outcome });
      return outcome;
    });
    void Promise.race([cleanup(), overdue]).finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const steps: StepResult[] = [];
  let cleanupOutcome: CleanupOutcome;
  try {
    note({ runner: await readIdentity(process.pid).catch(() => null) });
    writeFileSync(join(home, "config.toml"), scratchConfig(options, pin, home, prefix));
    const scripted = options.harness === "pi" && options.piProfile !== "real";
    const stateDir = join(home, "state");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "data"), { recursive: true, mode: 0o700 });
    const seed = openDb(stateFiles(stateDir).db);
    migrate(seed);
    tx(seed, () => {
      seed.query("INSERT INTO leader_lease (id, session_id, harness, epoch, token_hash, claimed_at, heartbeat_at) VALUES (1, 'contract', ?1, 1, ?2, ?3, ?3)").run(options.harness, hashToken(leader), Date.now());
      seed.query("INSERT INTO harness_contracts (harness, version, passed_at, report_path) VALUES (?1, ?2, ?3, 'scratch')").run(options.harness, version, Date.now());
    });
    seed.close();

    const logFd = openSync(join(home, "daemon.log"), "a");
    const scratchDaemon = Bun.spawn([...selfCommand(), "daemon", "run"], { env, stdin: "ignore", stdout: logFd, stderr: logFd });
    daemon = scratchDaemon;
    closeSync(logFd);
    note({ daemon: await readIdentity(scratchDaemon.pid).catch(() => null) });

    if (scripted) options.log(`pi plays the offline scripted model (provider ${await writeScriptedProvider(home)})`);
    else if (options.harness === "pi") {
      const source = piAgentSource(options.config, process.env);
      options.log(`pi on ${options.model}: copied ${seedAgentDir(source, piAgentDir(home)).join(", ")} from ${source} into a scratch agent dir`);
    }
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        await request(sock, { proto: PROTO, ulid: ulid(), verb: PING_VERB, args: {} }, { connectMs: 300, replyMs: 2_000 });
        break;
      } catch {
        if (Date.now() > deadline || scratchDaemon.exitCode !== null) throw new Error(`the scratch daemon did not start; see ${join(home, "daemon.log")}`);
        await Bun.sleep(100);
      }
    }
    const project = options.project ? realpathSync(options.project) : scratchRepo(join(home, "repo"));
    if (options.project) note({ project });
    const branch = git(["branch", "--show-current"], project).out;
    if (!branch) throw new Error(`${project} is on a detached HEAD; the contract run needs a branch to base its worktree on`);
    const added = await call("project add", { path: project, id: "contract", mode: "local-only", "default-branch": branch, harness: options.harness });
    if (!added.ok) throw new Error(`project add: ${added.error?.message}`);
    const dispatched = await call("dispatch", { project: "contract", kind: "scout", harness: options.harness, body: contractBody(options.harness, scripted), title: `contract ${options.harness} ${version}` });
    if (!dispatched.ok) throw new Error(`dispatch: ${dispatched.error?.code} ${dispatched.error?.message}`);
    db = openDb(stateFiles(stateDir).db, { readonly: true });
    const readDb = db;
    const runId = String(dispatched.data.run);
    const run = readDb.query("SELECT * FROM runs WHERE id = ?1").get(runId) as RunRow;
    state = { task: String(dispatched.data.task), run: runId, session: run.agent_session ?? randomUUID(), pid: 0 };
    const contractEnv: ContractEnv = {
      harness: options.harness,
      scripted,
      call,
      run: () => readDb.query("SELECT * FROM runs WHERE id = ?1").get(runId) as RunRow,
      events: () =>
        (readDb.query("SELECT kind, payload FROM events WHERE run_id = ?1 ORDER BY seq").all(runId) as { kind: string; payload: string }[]).map(
          (e): ContractEvent => ({ kind: e.kind, payload: JSON.parse(e.payload) as Record<string, unknown> }),
        ),
      steers: () => readDb.query("SELECT * FROM messages WHERE run_id = ?1 ORDER BY created_at, id").all(runId) as MessageRow[],
      lastHook: () => {
        const row = readDb.query("SELECT value FROM run_evidence WHERE run_id = ?1 AND source = 'hook'").get(runId) as { value: string } | null;
        if (!row) return null;
        const value = JSON.parse(row.value) as { hook?: string; signal?: string; at?: number };
        return { hook: value.hook ?? null, signal: String(value.signal ?? ""), at: Number(value.at ?? 0) };
      },
      waitFor: (what, timeoutMs, check, explain) => pollFor(what, Math.min(timeoutMs, maxWaitMs(process.env)), check, explain, drift),
      async exitWorker() {
        const r = contractEnv.run();
        if (r.proc_pid === null || r.proc_start === null || r.proc_exe === null) return { ok: false, detail: "no harness process recorded" };
        const result = await terminate({ pid: r.proc_pid, start: r.proc_start, exe: r.proc_exe }, { group: true });
        return { ok: result.ok, detail: `${result.signal}, ${result.evidence}` };
      },
      isAlive: (pid, start, exe) => isAlive({ pid, start, exe }),
      async commandRunning(command) {
        const pid = contractEnv.run().proc_pid;
        return pid !== null && descendantCommands(await readProcessTable(), pid).includes(command);
      },
      log: options.log,
      claudeStore: options.harness === "claude" ? (workersConfig(options.config).claude.config_dir ?? claudeConfigDir(process.env)) : null,
    };
    steps.push(...(await runContractSteps(contractSteps(options.harness), contractEnv, state, options.log, drift)));
  } finally {
    cleanupOutcome = await cleanup();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  const passed = steps.length === contractSteps(options.harness).length && steps.every((s) => s.ok);
  return { harness: options.harness, version, passed, steps, scratch: home, cleanup: cleanupOutcome };
}

/**
 * The contract env's `waitFor`: poll `check` every WAIT_POLL_MS until it
 * returns a truthy value. A `check` that throws, or a harness that drifted
 * (it would be refused, and the wait would only time out), fails it at once;
 * after `limitMs` it fails naming `what`, plus what `explain` says.
 */
export async function pollFor<T>(
  what: string,
  limitMs: number,
  check: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  explain: (() => string) | undefined,
  drift: () => Promise<string | null>,
): Promise<T> {
  const until = Date.now() + limitMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    const drifted = await drift();
    if (drifted) throw new Error(drifted);
    if (Date.now() > until) throw new Error(`timed out after ${Math.round(limitMs / 1000)}s waiting for ${what}${explain ? ` (${explain()})` : ""}`);
    await Bun.sleep(WAIT_POLL_MS);
  }
}

/**
 * Run the steps in order, logging step N/M as each starts and ends; stop at
 * the first failure. `drift` says why the harness under test changed, and a
 * step that would start on a changed harness fails at once with that reason.
 */
export async function runContractSteps(
  steps: ContractStep[],
  env: ContractEnv,
  state: ContractState,
  log: (line: string) => void,
  drift: () => Promise<string | null> = async () => null,
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const [index, step] of steps.entries()) {
    const position = `step ${index + 1}/${steps.length}`;
    log(`${position} ${step.name} (usually ~${step.typicalSeconds}s)`);
    const started = Date.now();
    try {
      const drifted = await drift();
      if (drifted) throw new Error(drifted);
      const detail = await step.run(env, state);
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      results.push({ step: step.name, ok: true, detail, seconds });
      log(`${position} ok ${step.name} (${seconds}s): ${detail}`);
    } catch (error) {
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      results.push({ step: step.name, ok: false, detail: (error as Error).message, seconds });
      log(`${position} FAILED ${step.name} (${seconds}s): ${(error as Error).message}`);
      break;
    }
  }
  return results;
}

/**
 * Remove the scratch home and see that it stays gone: a straggler that writes
 * into it as it goes (rmSync then fails ENOTEMPTY) or just after (a directory
 * comes back) gets another pass, until the deadline. A home that will not go
 * is logged with the reason, never skipped in silence.
 */
export async function removeScratchHome(home: string, log: (line: string) => void, deadlineMs = REMOVE_DEADLINE_MS): Promise<boolean> {
  const until = Date.now() + deadlineMs;
  let lastError = "";
  for (;;) {
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      lastError = "";
    } catch (error) {
      lastError = (error as Error).message;
    }
    if (!existsSync(home)) {
      await Bun.sleep(REMOVE_QUIET_MS);
      if (!existsSync(home)) return true;
      lastError = "something recreated it after removal";
    }
    if (Date.now() > until) {
      log(`scratch home ${home} was not removed: ${lastError || "it is still there"}`);
      return false;
    }
    await Bun.sleep(REMOVE_QUIET_MS);
  }
}

/**
 * Stop the worker (cancel exits it and closes its workspace), then stop the
 * scratch daemon and wait for it to exit, each within its own bound. Returns
 * what did not happen; the release that follows closes and ends by id anyway.
 */
async function teardown(
  call: (verb: string, args: Record<string, unknown>, replyMs?: number) => Promise<{ ok: boolean }>,
  state: ContractState | null,
  daemon: { exitCode: number | null; kill(signal?: number | NodeJS.Signals): void; exited: Promise<number> } | null,
): Promise<string[]> {
  const problems: string[] = [];
  if (state && daemon?.exitCode === null) await call("cancel", { target: state.task, reason: "contract run finished" }, CANCEL_REPLY_MS).catch(() => ({ ok: false }));
  if (daemon && daemon.exitCode === null) {
    daemon.kill("SIGTERM");
    await Promise.race([daemon.exited, Bun.sleep(DAEMON_TERM_MS)]);
    if (daemon.exitCode === null) {
      daemon.kill("SIGKILL");
      await Promise.race([daemon.exited, Bun.sleep(DAEMON_KILL_MS)]);
      if (daemon.exitCode === null) problems.push("the scratch daemon did not exit after SIGKILL");
    }
  }
  return problems;
}
