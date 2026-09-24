import { accessSync, constants, copyFileSync, existsSync, renameSync, statSync } from "node:fs";
import { basename } from "node:path";
import { configProblems, loadConfig, resolveTool, TOOL_NAMES, type FlowrynConfig, type ToolName } from "../config/config.ts";
import { flowrynHome, runDir, socketPath, stateFiles } from "../config/paths.ts";
import { integrityProblems, LATEST_SCHEMA_VERSION, openDb, schemaVersion } from "../db/db.ts";
import { listBackups } from "../db/backup.ts";
import { listTasks, processRunner, tasksAxiVersion } from "../journal/tasks-axi.ts";
import { isLoaded, plistPath, selfCommand, serviceLabel } from "../service/launchd.ts";
import { isLockHeld, tryExclusiveLock } from "../util/flock.ts";
import { canCreateOrWrite } from "../util/fsx.ts";
import { PINNED_TASKS_AXI, PROTO, VERSION } from "../version.ts";
import type { Reply } from "../api/envelope.ts";
import { workerConfigProblems } from "../config/workers.ts";
import { HARNESS_IDS, type HarnessId } from "../harness/types.ts";
import { harnessVersion } from "../lifecycle/fleet-services.ts";
import { HerdrClient } from "../runtime/herdr/client.ts";
import { resolveHerdrSocket } from "../runtime/herdr/socket.ts";
import { loadExtensionSource } from "../harness/pi/adapter.ts";
import { capacityConfig } from "../config/workflows.ts";
import { checkHost } from "../sched/host.ts";

export type CheckStatus = "ok" | "warn" | "fail" | "info";

export interface Check {
  check: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorEnv {
  env: NodeJS.ProcessEnv;
  ping: () => Promise<Reply | null>;
}

/** Tools M1 cannot work without; the rest are needed from M2 on, and these only for what uses them. */
const REQUIRED_TOOLS: readonly ToolName[] = ["tasks_axi", "git", "node"];
const OPTIONAL_TOOLS: Partial<Record<ToolName, string>> = {
  no_mistakes: "not found (optional: the no-mistakes delivery mode needs it)",
  docker: "not found (optional: visual QA runs Docker environments, and the capacity check counts them)",
};

const STALE_LOCK_MS = 30_000;

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function toolChecks(config: FlowrynConfig): Check[] {
  const checks: Check[] = [];
  for (const name of TOOL_NAMES) {
    const required = REQUIRED_TOOLS.includes(name);
    const configured = config.tools[name];
    const found = resolveTool(config, name);
    if (configured && !existsSync(configured)) {
      checks.push({ check: `tool ${name}`, status: required ? "fail" : "warn", detail: `configured path is missing: ${configured}` });
    } else if (found && !executable(found)) {
      checks.push({ check: `tool ${name}`, status: required ? "fail" : "warn", detail: `not executable: ${found}` });
    } else if (configured) {
      checks.push({ check: `tool ${name}`, status: "ok", detail: configured });
    } else if (found) {
      checks.push({ check: `tool ${name}`, status: required ? "warn" : "info", detail: `found on PATH, not recorded in config: ${found} (flowryn init records it)` });
    } else {
      checks.push({ check: `tool ${name}`, status: required ? "fail" : "info", detail: required ? "not found" : (OPTIONAL_TOOLS[name] ?? "not found (needed from M2)") });
    }
  }
  return checks;
}

async function tasksChecks(config: FlowrynConfig): Promise<Check[]> {
  const tasksAxi = resolveTool(config, "tasks_axi");
  if (!tasksAxi || !existsSync(tasksAxi)) return [{ check: "tasks-axi", status: "fail", detail: "tasks-axi not found; the journal cannot apply intents" }];
  const runner = processRunner(tasksAxi, resolveTool(config, "node"));
  const checks: Check[] = [];
  const version = await tasksAxiVersion(runner);
  if (!version) checks.push({ check: "tasks-axi version", status: "fail", detail: `${tasksAxi} --version failed` });
  else if (version !== PINNED_TASKS_AXI) {
    checks.push({ check: "tasks-axi version", status: "warn", detail: `${version}; the journal was verified against ${PINNED_TASKS_AXI}` });
  } else checks.push({ check: "tasks-axi version", status: "ok", detail: version });
  for (const [label, file] of [["backlog", config.tasks.backlog], ["todos", config.tasks.todos]] as const) {
    try {
      const tasks = await listTasks(runner, file);
      if (!canCreateOrWrite(file)) throw new Error("not writable");
      const note = existsSync(file) ? `${tasks.length} tasks, writable` : "created on first write";
      checks.push({ check: `${label} file`, status: "ok", detail: `${file} (${note})` });
    } catch (error) {
      checks.push({ check: `${label} file`, status: "fail", detail: `${file}: ${(error as Error).message}` });
    }
    const lock = `${file}.lock`;
    if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
      checks.push({ check: `${label} lock`, status: "warn", detail: `${lock} is over 30 s old; tasks-axi never breaks it. Remove it if no tasks-axi is running.` });
    }
  }
  return checks;
}

function databaseChecks(config: FlowrynConfig): Check[] {
  const { db: dbPath } = stateFiles(config.state_dir);
  if (!existsSync(dbPath)) return [{ check: "database", status: "info", detail: `${dbPath} does not exist yet; the daemon creates it` }];
  const checks: Check[] = [];
  const db = openDb(dbPath, { readonly: true });
  try {
    const problems = integrityProblems(db);
    checks.push(problems.length === 0 ? { check: "database", status: "ok", detail: `${dbPath} passes quick_check` } : { check: "database", status: "fail", detail: `quick_check: ${problems.slice(0, 3).join("; ")} (flowryn doctor --restore)` });
    const version = schemaVersion(db);
    if (version > LATEST_SCHEMA_VERSION) checks.push({ check: "schema", status: "fail", detail: `schema ${version} is newer than this binary (${LATEST_SCHEMA_VERSION})` });
    else if (version < LATEST_SCHEMA_VERSION) checks.push({ check: "schema", status: "warn", detail: `schema ${version}; the daemon migrates to ${LATEST_SCHEMA_VERSION} on start` });
    else checks.push({ check: "schema", status: "ok", detail: `version ${version}` });
    if (version >= 1) {
      const pending = db.query("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM intents WHERE state = 'pending'").get() as { n: number; oldest: number | null };
      const failed = (db.query("SELECT COUNT(*) AS n FROM intents WHERE state = 'failed'").get() as { n: number }).n;
      if (pending.n > 0 && pending.oldest !== null && Date.now() - pending.oldest > 60_000) {
        checks.push({ check: "journal", status: "warn", detail: `${pending.n} intent(s) pending, oldest ${Math.round((Date.now() - pending.oldest) / 1000)} s` });
      } else if (failed > 0) {
        checks.push({ check: "journal", status: "warn", detail: `${failed} intent(s) failed; see the backlog out of sync items` });
      } else checks.push({ check: "journal", status: "ok", detail: `${pending.n} pending, ${failed} failed` });
    }
  } finally {
    db.close();
  }
  const backups = listBackups(stateFiles(config.state_dir).backups);
  checks.push({ check: "backups", status: backups.length > 0 ? "ok" : "info", detail: backups.length > 0 ? `${backups.length} kept, newest ${basename(backups[backups.length - 1]!)}` : "none yet (nightly VACUUM INTO)" });
  return checks;
}

async function daemonChecks(home: string, config: FlowrynConfig, env: DoctorEnv): Promise<Check[]> {
  const checks: Check[] = [];
  const run = runDir(home);
  if (existsSync(run)) {
    const mode = statSync(run).mode & 0o777;
    checks.push(mode === 0o700 ? { check: "run dir", status: "ok", detail: `${run} (0700)` } : { check: "run dir", status: "fail", detail: `${run} is ${mode.toString(8)}; must be 0700` });
  }
  const reply = await env.ping();
  if (!reply) {
    const lock = stateFiles(config.state_dir).lock;
    const held = existsSync(lock) && isLockHeld(lock);
    checks.push({ check: "daemon", status: "warn", detail: `not answering on ${socketPath(home, env.env)}${held ? "; its state lock is held" : ""} (flowryn daemon start)` });
  } else if (!reply.ok && reply.error?.code === "protocol_mismatch") {
    checks.push({ check: "daemon", status: "fail", detail: `protocol mismatch: this CLI speaks ${PROTO}, the daemon ${String(reply.proto)}` });
  } else if (reply.ok) {
    const data = reply.data as { pid?: number; version?: string };
    const same = data.version === VERSION;
    checks.push({ check: "daemon", status: same ? "ok" : "warn", detail: `pid ${data.pid}, version ${data.version}${same ? "" : ` (this CLI is ${VERSION})`}` });
  }
  const label = serviceLabel(home);
  const plist = plistPath(label);
  if (process.platform === "darwin") {
    if (!existsSync(plist)) checks.push({ check: "launchd", status: "warn", detail: "agent not installed (flowryn daemon install)" });
    else checks.push({ check: "launchd", status: (await isLoaded(label)) ? "ok" : "warn", detail: `${plist}${(await isLoaded(label)) ? " loaded" : " installed but not loaded"}` });
  }
  return checks;
}

function binaryCheck(): Check | null {
  const command = selfCommand();
  if (command.length > 1) return { check: "binary", status: "info", detail: `development entry point (${command.join(" ")}); build with bun run build` };
  if (process.platform !== "darwin") return null;
  const verify = Bun.spawnSync(["/usr/bin/codesign", "--verify", "--strict", process.execPath]);
  return verify.exitCode === 0
    ? { check: "binary", status: "ok", detail: `${process.execPath} signature valid` }
    : { check: "binary", status: "fail", detail: `${process.execPath} signature invalid; rebuild (the build re-signs with codesign --force --sign -)` };
}

/** The Pi worker extension ships inside the binary; a build that lost it could not start a Pi worker. */
async function piExtensionCheck(): Promise<Check> {
  try {
    const source = await loadExtensionSource();
    return source.includes("project_trust")
      ? { check: "pi extension", status: "ok", detail: `embedded worker extension, ${source.length} bytes` }
      : { check: "pi extension", status: "fail", detail: "the embedded worker extension is not the Flowryn one" };
  } catch (error) {
    return { check: "pi extension", status: "fail", detail: `cannot read the embedded worker extension: ${(error as Error).message}` };
  }
}

/** Is the Herdr session flowrynd drives reachable? Read-only: a ping on its socket. */
async function herdrCheck(config: FlowrynConfig): Promise<Check> {
  let resolution;
  try {
    resolution = await resolveHerdrSocket(config);
  } catch (error) {
    return { check: "herdr", status: "fail", detail: (error as Error).message };
  }
  if (!resolution.socket) return { check: "herdr", status: "warn", detail: `${resolution.reason}; workers cannot start` };
  try {
    await new HerdrClient(resolution.socket).call("ping", {}, 3_000);
    return { check: "herdr", status: "ok", detail: resolution.socket };
  } catch (error) {
    return { check: "herdr", status: "warn", detail: `${resolution.socket} does not answer (${(error as Error).message}); workers cannot start` };
  }
}

/**
 * Design section 5: dispatch refuses a harness version with no passing
 * contract run. Report each installed harness against the recorded passes.
 */
async function contractChecks(config: FlowrynConfig): Promise<Check[]> {
  const db = existsSync(stateFiles(config.state_dir).db) ? openDb(stateFiles(config.state_dir).db, { readonly: true }) : null;
  const checks: Check[] = [];
  try {
    for (const harness of HARNESS_IDS) {
      const binary = resolveTool(config, harness);
      if (!binary) continue;
      const version = await harnessVersion(harness as HarnessId, binary);
      if (!version) {
        checks.push({ check: `contract ${harness}`, status: "warn", detail: `cannot read the version from ${binary} --version` });
        continue;
      }
      const row = db && schemaVersion(db) >= 2 ? (db.query("SELECT passed_at FROM harness_contracts WHERE harness = ?1 AND version = ?2").get(harness, version) as { passed_at: number } | null) : null;
      checks.push(
        row
          ? { check: `contract ${harness}`, status: "ok", detail: `${version} passed ${new Date(row.passed_at).toISOString().slice(0, 10)}` }
          : { check: `contract ${harness}`, status: "warn", detail: `${version} has no passing contract run, so dispatch refuses it: flowryn doctor --contracts --harness ${harness}` },
      );
    }
  } finally {
    db?.close();
  }
  return checks;
}

/** A config that does not say whether macOS notifications are on gets them by default: say so, so it is a choice. */
export function notifyMacosCheck(config: FlowrynConfig): Check | null {
  const notify = config.extra.notify;
  const table = typeof notify === "object" && notify !== null && !Array.isArray(notify) ? (notify as Record<string, unknown>) : {};
  if ("macos" in table) return null;
  return { check: "notify", status: "warn", detail: "[notify] has no macos key, so macOS notifications are on by default; set macos = true or false (flowryn init asks)" };
}

/** Every doctor check, in reading order. Never mutates anything. */
export async function runChecks(env: DoctorEnv): Promise<Check[]> {
  const home = flowrynHome(env.env);
  const checks: Check[] = [];
  let config: FlowrynConfig;
  try {
    const loaded = loadConfig(home);
    config = loaded.config;
    checks.push(loaded.exists ? { check: "config", status: "ok", detail: loaded.path } : { check: "config", status: "warn", detail: `${loaded.path} missing; using defaults (flowryn init)` });
    for (const problem of configProblems(config)) checks.push({ check: "config", status: problem.level === "error" ? "fail" : "warn", detail: problem.message });
    if (loaded.exists) {
      const notify = notifyMacosCheck(config);
      if (notify) checks.push(notify);
    }
  } catch (error) {
    return [{ check: "config", status: "fail", detail: (error as Error).message }];
  }
  const binary = binaryCheck();
  if (binary) checks.push(binary);
  checks.push(...toolChecks(config));
  checks.push(...(await tasksChecks(config)));
  checks.push(...databaseChecks(config));
  checks.push(...(await daemonChecks(home, config, env)));
  checks.push(...workerConfigProblems(config).map((problem): Check => ({ check: "config", status: "fail", detail: problem })));
  checks.push(await herdrCheck(config));
  checks.push(await piExtensionCheck());
  checks.push(...(await contractChecks(config)));
  checks.push(await hostCheckNow(config));
  return checks;
}

/** The capacity host check against this machine now (design section 11): a host that fails it starts no worker. */
async function hostCheckNow(config: FlowrynConfig): Promise<Check> {
  let host;
  try {
    host = capacityConfig(config).host;
  } catch {
    return { check: "host check", status: "info", detail: "not checked: the [capacity] config is invalid" };
  }
  const verdict = await checkHost(host);
  const pools = Object.entries(capacityConfig(config).pools).map(([pool, cap]) => `${pool} ${cap}`).join(", ");
  const now = verdict.sample ? `${verdict.sample.free_mem_gb.toFixed(1)} GB available, load ${verdict.sample.load_per_core.toFixed(2)} per core` : verdict.reason;
  if (verdict.ok) return { check: "host check", status: "ok", detail: `${now}; needs ${host.min_free_mem_gb} GB and at most ${host.max_load_per_core} per core; pools: ${pools}` };
  return { check: "host check", status: "warn", detail: `fails now (${verdict.reason}): no new worker or stage starts while it fails; lower [capacity.host] min_free_mem_gb or max_load_per_core if this machine never has that room` };
}

export interface RestoreResult {
  restored: string;
  from: string;
  previous: string | null;
}

/**
 * Replace flowryn.db with a nightly backup. Holds the daemon's state lock for
 * the whole swap, so a daemon launchd restarts meanwhile refuses at the flock
 * instead of opening a half-swapped database. The current database (and its
 * WAL files) is kept aside, never deleted.
 */
export function restoreBackup(config: FlowrynConfig, which: string | undefined, copy: (from: string, to: string) => void = copyFileSync): RestoreResult {
  const files = stateFiles(config.state_dir);
  const backups = listBackups(files.backups);
  if (backups.length === 0) throw new Error(`no backups in ${files.backups}`);
  const lock = tryExclusiveLock(files.lock);
  if (!lock) throw new Error("the daemon is running; stop it first (flowryn daemon stop)");
  try {
    const source = which ? backups.find((b) => basename(b).includes(which) || b === which) : backups[backups.length - 1];
    if (!source) throw new Error(`no backup matches ${which}; have: ${backups.map((b) => basename(b)).join(", ")}`);
    const probe = openDb(source, { readonly: true });
    const problems = integrityProblems(probe);
    probe.close();
    if (problems.length > 0) throw new Error(`${basename(source)} fails its own integrity check: ${problems[0]}`);
    let previous: string | null = null;
    if (existsSync(files.db)) {
      previous = `${files.db}.replaced-${Date.now()}`;
      renameSync(files.db, previous);
      for (const suffix of ["-wal", "-shm"]) if (existsSync(files.db + suffix)) renameSync(files.db + suffix, previous + suffix);
    }
    copy(source, files.db);
    return { restored: files.db, from: source, previous };
  } finally {
    lock.release();
  }
}

export function doctorExitCode(checks: Check[]): number {
  return checks.some((c) => c.status === "fail") ? 1 : 0;
}

