import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashToken, mintToken } from "../api/auth.ts";
import type { Reply } from "../api/envelope.ts";
import { resolveTool, type FlowrynConfig } from "../config/config.ts";
import { socketPath, stateFiles } from "../config/paths.ts";
import { renderToml } from "../config/toml.ts";
import { workersConfig } from "../config/workers.ts";
import { migrate, openDb, tx, type Db } from "../db/db.ts";
import { PING_VERB } from "../daemon/system-verbs.ts";
import type { HarnessId } from "../harness/types.ts";
import { harnessVersion } from "../lifecycle/fleet-services.ts";
import type { RunRow } from "../lifecycle/runs.ts";
import type { MessageRow } from "../lifecycle/steers.ts";
import { isAlive, terminate } from "../runtime/proc.ts";
import { HerdrClient } from "../runtime/herdr/client.ts";
import { HerdrRuntime } from "../runtime/herdr/runtime.ts";
import { contractPrefix, createdWorktrees, removeOwnWorktrees } from "./cleanup.ts";
import { selfCommand } from "../service/launchd.ts";
import { request } from "../transport/unix.ts";
import { ulid } from "../util/ulid.ts";
import { PROTO } from "../version.ts";
import { contractBody, contractSteps, type ContractEnv, type ContractEvent, type ContractState } from "./suite.ts";

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

/** Contract runs are slower than the design's clock needs to be, but never re-ring a steer mid-suite. */
const CONTRACT_TIMING = { pass_ms: 1_000, ring_interval_ms: 600_000, wait_poll_ms: 5_000, launch_timeout_ms: 30_000 };

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

function scratchConfig(options: ContractOptions, home: string, branchPrefix: string): string {
  const real = options.config;
  const workers: Record<string, unknown> = { ...(real.extra.workers as Record<string, unknown> | undefined) };
  workers.worktree_root = join(home, "wt");
  workers.branch_prefix = branchPrefix;
  if (options.model) workers[options.harness] = { ...(workers[options.harness] as Record<string, unknown> | undefined), model: options.model };
  const data: Record<string, unknown> = {
    data_dir: join(home, "data"),
    state_dir: join(home, "state"),
    tasks: { backlog: join(home, "data", "backlog.md"), todos: join(home, "data", "todos.md") },
    tools: { ...real.tools },
    herdr: { socket: options.herdrSocket },
    workers,
    reconcile: CONTRACT_TIMING,
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
  const binary = resolveTool(options.config, options.harness);
  if (!binary) throw new Error(`${options.harness} is not installed or not in [tools]`);
  const version = await harnessVersion(options.harness, binary);
  if (!version) throw new Error(`cannot read the ${options.harness} version from ${binary} --version`);
  const home = realpathSync(mkdtempSync(join(tmpdir(), "fwc-")));
  const { prefix } = contractPrefix();
  writeFileSync(join(home, "config.toml"), scratchConfig(options, home, prefix));
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
      await teardown(call, state, daemon);
      // A run that failed is not cancellable, so its workspace may still be open; close it by id.
      const runtime = new HerdrRuntime(new HerdrClient(options.herdrSocket));
      for (const ws of workspaces) await runtime.closeWorkspace(ws).catch(() => undefined);
      // Only a caller's own checkout has git state to undo; a scratch repository goes with the scratch home.
      if (options.project && project) removeOwnWorktrees(project, createdWorktrees(stateFiles(stateDir).db), prefix, join(home, "wt"), git, options.log);
      if (!options.keep) rmSync(home, { recursive: true, force: true });
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
      async waitFor(what, timeoutMs, check) {
        const until = Date.now() + timeoutMs;
        for (;;) {
          const value = check();
          if (value) return value;
          if (Date.now() > until) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}`);
          await Bun.sleep(500);
        }
      },
      async exitWorker() {
        const r = contractEnv.run();
        if (r.proc_pid === null || r.proc_start === null || r.proc_exe === null) return { ok: false, detail: "no harness process recorded" };
        const result = await terminate({ pid: r.proc_pid, start: r.proc_start, exe: r.proc_exe }, { group: true });
        return { ok: result.ok, detail: `${result.signal}, ${result.evidence}` };
      },
      isAlive: (pid, start, exe) => isAlive({ pid, start, exe }),
      log: options.log,
    };
    for (const step of contractSteps(options.harness)) {
      const started = Date.now();
      try {
        const detail = await step.run(contractEnv, state);
        steps.push({ step: step.name, ok: true, detail, seconds: Math.round((Date.now() - started) / 1000) });
        options.log(`ok ${step.name}: ${detail}`);
      } catch (error) {
        steps.push({ step: step.name, ok: false, detail: (error as Error).message, seconds: Math.round((Date.now() - started) / 1000) });
        options.log(`FAILED ${step.name}: ${(error as Error).message}`);
        break;
      }
    }
  } finally {
    await cleanup();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  const passed = steps.length === contractSteps(options.harness).length && steps.every((s) => s.ok);
  return { harness: options.harness, version, passed, steps, scratch: home };
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

/** Stop the worker (cancel exits it and closes its workspace), then stop the scratch daemon. */
async function teardown(
  call: (verb: string, args: Record<string, unknown>) => Promise<{ ok: boolean }>,
  state: ContractState | null,
  daemon: { exitCode: number | null; kill(signal?: number | NodeJS.Signals): void; exited: Promise<number> },
): Promise<void> {
  if (state) await call("cancel", { target: state.task, reason: "contract run finished" }).catch(() => ({ ok: false }));
  if (daemon.exitCode === null) {
    daemon.kill("SIGTERM");
    await Promise.race([daemon.exited, Bun.sleep(15_000)]);
    if (daemon.exitCode === null) daemon.kill("SIGKILL");
  }
}
