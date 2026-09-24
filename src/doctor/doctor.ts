import { accessSync, constants, copyFileSync, existsSync, renameSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { configProblems, loadConfig, resolveTool, TOOL_BINARIES, type FlowrynConfig, type ToolName } from "../config/config.ts";
import { flowrynHome, runDir, socketPath, stateFiles } from "../config/paths.ts";
import { integrityProblems, LATEST_SCHEMA_VERSION, openDb, schemaVersion } from "../db/db.ts";
import { listBackups } from "../db/backup.ts";
import { listTasks, processRunner, tasksAxiVersion } from "../journal/tasks-axi.ts";
import { isLoaded, plistPath, selfCommand, serviceLabel } from "../service/launchd.ts";
import { isLockHeld } from "../util/flock.ts";
import { PINNED_TASKS_AXI, PROTO, VERSION } from "../version.ts";
import type { Reply } from "../api/envelope.ts";

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

/** Tools M1 cannot work without; the rest are needed from M2 on. */
const REQUIRED_TOOLS: readonly ToolName[] = ["tasks_axi", "git", "node"];

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
  for (const name of Object.keys(TOOL_BINARIES) as ToolName[]) {
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
      checks.push({ check: `tool ${name}`, status: required ? "fail" : "info", detail: required ? "not found" : "not found (needed from M2)" });
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
      accessSync(existsSync(file) ? file : dirname(file), constants.W_OK);
      checks.push({ check: `${label} file`, status: "ok", detail: `${file} (${tasks.length} tasks, writable)` });
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

/** Every doctor check, in reading order. Never mutates anything. */
export async function runChecks(env: DoctorEnv, contracts: boolean): Promise<Check[]> {
  const home = flowrynHome(env.env);
  const checks: Check[] = [];
  let config: FlowrynConfig;
  try {
    const loaded = loadConfig(home);
    config = loaded.config;
    checks.push(loaded.exists ? { check: "config", status: "ok", detail: loaded.path } : { check: "config", status: "warn", detail: `${loaded.path} missing; using defaults (flowryn init)` });
    for (const problem of configProblems(config)) checks.push({ check: "config", status: problem.level === "error" ? "fail" : "warn", detail: problem.message });
  } catch (error) {
    return [{ check: "config", status: "fail", detail: (error as Error).message }];
  }
  const binary = binaryCheck();
  if (binary) checks.push(binary);
  checks.push(...toolChecks(config));
  checks.push(...(await tasksChecks(config)));
  checks.push(...databaseChecks(config));
  checks.push(...(await daemonChecks(home, config, env)));
  if (contracts) checks.push({ check: "contracts", status: "warn", detail: "harness contract suites ship with the worker adapters in M2; nothing to run yet" });
  return checks;
}

export interface RestoreResult {
  restored: string;
  from: string;
  previous: string | null;
}

/**
 * Replace flowryn.db with a nightly backup. Refuses while a daemon holds the
 * state lock. The current database (and its WAL files) is kept aside, never
 * deleted.
 */
export function restoreBackup(config: FlowrynConfig, which: string | undefined): RestoreResult {
  const files = stateFiles(config.state_dir);
  if (existsSync(files.lock) && isLockHeld(files.lock)) throw new Error("the daemon is running; stop it first (flowryn daemon stop)");
  const backups = listBackups(files.backups);
  if (backups.length === 0) throw new Error(`no backups in ${files.backups}`);
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
  copyFileSync(source, files.db);
  return { restored: files.db, from: source, previous };
}

export function doctorExitCode(checks: Check[]): number {
  return checks.some((c) => c.status === "fail") ? 1 : 0;
}

