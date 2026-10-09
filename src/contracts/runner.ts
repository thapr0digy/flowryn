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
import { migrate, openDb, tx, type Db } from "../db/db.ts";
import { PING_VERB } from "../daemon/system-verbs.ts";
import type { HarnessId } from "../harness/types.ts";
import { harnessVersion } from "../lifecycle/fleet-services.ts";
import type { RunRow } from "../lifecycle/runs.ts";
import type { MessageRow } from "../lifecycle/steers.ts";
import { descendantCommands, isAlive, readProcessTable, terminate, type ProcIdentity } from "../runtime/proc.ts";
import { HerdrClient } from "../runtime/herdr/client.ts";
import { HerdrRuntime } from "../runtime/herdr/runtime.ts";
import { contractPrefix, createdWorktrees, removeOwnWorktrees } from "./cleanup.ts";
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
  /** Override the worker model for this run. */
  model: string | null;
  keep: boolean;
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
const CONTRACT_CAPACITY = { worker: 1, host: { min_free_mem_gb: 1, max_load_per_core: 8 } };

function git(args: string[], cwd: string): { code: number; out: string } {
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
  if (options.model) workers[options.harness] = { ...(workers[options.harness] as Record<string, unknown> | undefined), model: options.model };
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
  writeFileSync(join(home, "config.toml"), scratchConfig(options, pin, home, prefix));
  const stateDir = join(home, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, "data"), { recursive: true, mode: 0o700 });
  const leader = mintToken("leader");
  const seed = openDb(stateFiles(stateDir).db);
  migrate(seed);
  tx(seed, () => {
    seed.query("INSERT INTO leader_lease (id, session_id, harness, epoch, token_hash, claimed_at, heartbeat_at) VALUES (1, 'contract', ?1, 1, ?2, ?3, ?3)").run(options.harness, hashToken(leader), Date.now());
    seed.query("INSERT INTO harness_contracts (harness, version, passed_at, report_path) VALUES (?1, ?2, ?3, 'scratch')").run(options.harness, version, Date.now());
  });
  seed.close();

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("FLOWRYN_")) env[k] = v;
  env.FLOWRYN_HOME = home;
  // A contract run's scratch daemon delivers no notification to your Mac (or Herdr).
  env.FLOWRYN_NOTIFY = "off";
  requireNotificationsOff(env, "the contract runner");
  const sock = socketPath(home, env);
  const logFd = openSync(join(home, "daemon.log"), "a");
  const daemon = Bun.spawn([...selfCommand(), "daemon", "run"], { env, stdin: "ignore", stdout: logFd, stderr: logFd });
  closeSync(logFd);

  const call = async (verb: string, args: Record<string, unknown>) => {
    const reply = (await request(sock, { proto: PROTO, ulid: ulid(), verb, token: leader, args }, { connectMs: 1_000, replyMs: 60_000 })) as Reply;
    return { ok: reply.ok, data: (reply.data ?? {}) as Record<string, unknown>, error: reply.error as { code: string; message: string } | undefined };
  };
  let db: Db | null = null;
  const steps: StepResult[] = [];
  let project: string | null = null;
  let state: ContractState | null = null;
  let cleaning: Promise<void> | null = null;
  // Runs once, from the finally block or from a signal: nothing this run created outlives it.
  const cleanup = () =>
    (cleaning ??= (async () => {
      db?.close();
      db = null;
      const workspaces = createdWorkspaces(stateDir);
      const harnesses = harnessProcesses(stateDir);
      await teardown(call, state, daemon);
      // A run that failed is not cancellable, so its workspace may still be open; close it by id.
      const runtime = new HerdrRuntime(new HerdrClient(options.herdrSocket));
      for (const ws of workspaces) await runtime.closeWorkspace(ws).catch(() => undefined);
      // Nothing that writes into the scratch home may outlive it: a worker still exiting would spool its hooks there.
      for (const proc of harnesses) {
        const ended = await terminate(proc, { group: true });
        if (!ended.ok) options.log(`harness pid ${proc.pid} did not exit (${ended.signal}, ${ended.evidence})`);
      }
      // Only a caller's own checkout has git state to undo; a scratch repository goes with the scratch home.
      if (options.project && project) removeOwnWorktrees(project, createdWorktrees(stateFiles(stateDir).db), prefix, join(home, "wt"), git, options.log);
      if (!options.keep) await removeScratchHome(home, options.log);
    })());
  const onSignal = (signal: NodeJS.Signals) => {
    options.log(`${signal}: cleaning up before exit`);
    void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        await request(sock, { proto: PROTO, ulid: ulid(), verb: PING_VERB, args: {} }, { connectMs: 300, replyMs: 2_000 });
        break;
      } catch {
        if (Date.now() > deadline || daemon.exitCode !== null) throw new Error(`the scratch daemon did not start; see ${join(home, "daemon.log")}`);
        await Bun.sleep(100);
      }
    }
    project = options.project ? realpathSync(options.project) : scratchRepo(join(home, "repo"));
    const branch = git(["branch", "--show-current"], project).out;
    if (!branch) throw new Error(`${project} is on a detached HEAD; the contract run needs a branch to base its worktree on`);
    const added = await call("project add", { path: project, id: "contract", mode: "local-only", "default-branch": branch, harness: options.harness });
    if (!added.ok) throw new Error(`project add: ${added.error?.message}`);
    const piModel = options.model ?? workersConfig(options.config).pi.model ?? "";
    const scripted = options.harness === "pi" && piModel.startsWith("flowryn-scripted/");
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
      async waitFor(what, timeoutMs, check) {
        const limitMs = Math.min(timeoutMs, maxWaitMs(process.env));
        const until = Date.now() + limitMs;
        for (;;) {
          const value = await check();
          if (value) return value;
          // A harness updated mid-wait would be refused (contract_unverified) and the wait would only time out.
          const drifted = await drift();
          if (drifted) throw new Error(drifted);
          if (Date.now() > until) throw new Error(`timed out after ${Math.round(limitMs / 1000)}s waiting for ${what}`);
          await Bun.sleep(WAIT_POLL_MS);
        }
      },
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
    };
    steps.push(...(await runContractSteps(contractSteps(options.harness), contractEnv, state, options.log, drift)));
  } finally {
    await cleanup();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  const passed = steps.length === contractSteps(options.harness).length && steps.every((s) => s.ok);
  return { harness: options.harness, version, passed, steps, scratch: home };
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

function createdWorkspaces(stateDir: string): string[] {
  const path = stateFiles(stateDir).db;
  if (!existsSync(path)) return [];
  const db = openDb(path, { readonly: true });
  try {
    return (db.query("SELECT workspace_id FROM runs WHERE workspace_id IS NOT NULL").all() as { workspace_id: string }[]).map((r) => r.workspace_id);
  } finally {
    db.close();
  }
}

/** The harness processes the scratch daemon recorded, to make sure each is gone before the scratch home goes. */
function harnessProcesses(stateDir: string): ProcIdentity[] {
  const path = stateFiles(stateDir).db;
  if (!existsSync(path)) return [];
  const db = openDb(path, { readonly: true });
  try {
    const rows = db.query("SELECT proc_pid, proc_start, proc_exe FROM runs WHERE proc_pid IS NOT NULL AND proc_start IS NOT NULL AND proc_exe IS NOT NULL").all() as {
      proc_pid: number;
      proc_start: number;
      proc_exe: string;
    }[];
    return rows.map((r) => ({ pid: r.proc_pid, start: r.proc_start, exe: r.proc_exe }));
  } finally {
    db.close();
  }
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

/** Stop the worker (cancel exits it and closes its workspace), then stop the scratch daemon and wait for it to exit. */
async function teardown(
  call: (verb: string, args: Record<string, unknown>) => Promise<{ ok: boolean }>,
  state: ContractState | null,
  daemon: { exitCode: number | null; kill(signal?: number | NodeJS.Signals): void; exited: Promise<number> },
): Promise<void> {
  if (state) await call("cancel", { target: state.task, reason: "contract run finished" }).catch(() => ({ ok: false }));
  if (daemon.exitCode === null) {
    daemon.kill("SIGTERM");
    await Promise.race([daemon.exited, Bun.sleep(15_000)]);
    if (daemon.exitCode === null) {
      daemon.kill("SIGKILL");
      await Promise.race([daemon.exited, Bun.sleep(5_000)]);
    }
  }
}
