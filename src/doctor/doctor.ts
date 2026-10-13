import { accessSync, constants, copyFileSync, existsSync, renameSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { configProblems, loadConfig, resolveTool, TOOL_NAMES, whichTool, type FlowrynConfig, type ToolName } from "../config/config.ts";
import { flowrynHome, runDir, socketPath, stateFiles } from "../config/paths.ts";
import { integrityProblems, LATEST_SCHEMA_VERSION, openDb, schemaVersion, type Db } from "../db/db.ts";
import { listBackups } from "../db/backup.ts";
import { listTasks, processRunner, tasksAxiVersion } from "../journal/tasks-axi.ts";
import { isLoaded, plistPath, selfCommand, serviceLabel } from "../service/launchd.ts";
import { isLockHeld, tryExclusiveLock } from "../util/flock.ts";
import { canCreateOrWrite } from "../util/fsx.ts";
import { PINNED_TASKS_AXI, PROTO, VERIFIED_LAVISH_AXI, VERSION } from "../version.ts";
import type { Reply } from "../api/envelope.ts";
import { configSectionProblems } from "../config/effective.ts";
import { POLICY_MODE_LINES, policyMode } from "../config/policy.ts";
import { HARNESS_IDS, type HarnessId } from "../harness/types.ts";
import { harnessVersion } from "../lifecycle/fleet-services.ts";
import { contractsCommand, unverifiedReason } from "../lifecycle/harness-gate.ts";
import { BASELINE_REVISION, contractRevision } from "../contracts/revision.ts";
import { HerdrClient } from "../runtime/herdr/client.ts";
import { resolveHerdrSocket } from "../runtime/herdr/socket.ts";
import { loadExtensionSource } from "../harness/pi/adapter.ts";
import { capacityConfig, workflowsConfig } from "../config/workflows.ts";
import { INSTALL_HINTS } from "../init/install.ts";
import { checkHost } from "../sched/host.ts";
import { judgeQuota, probeQuota, type QuotaReading } from "../sched/quota.ts";

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
  lavish_axi: "not found (optional: a review's questions are then answered only through the leader)",
  gh_axi: "not found (every GitHub job uses it; the github rule names it)",
  chrome_devtools_axi: "not found (the browser for visual QA; the browser rule names it)",
  acli: "not found (jira-axi runs it for every call)",
  jira_axi: "not found (optional: Jira; the jira rule names it)",
  sqlite_axi: "not found (optional: SQLite reads; the sqlite rule names it)",
  treehouse: "not found (optional: git worktrees; the worktree rule names it)",
  quota_axi: "not found (the quota floor reads it before a new Claude run; without it nothing waits on the quota)",
  bun: "not found (optional: without it the daemon does not build Flowryn after a Flowryn merge)",
};

/** Some workflow holds the browser pool in a stage (visual QA; the default feature-ui does). */
function usesBrowser(config: FlowrynConfig): boolean {
  try {
    return Object.values(workflowsConfig(config)).some((wf) => wf.stages.some((stage) => stage.pools.includes("browser")));
  } catch {
    return false;
  }
}

/** The quota floor is on: the scheduler reads quota-axi before a new Claude run. */
function quotaFloorOn(config: FlowrynConfig): boolean {
  try {
    return capacityConfig(config).quota.floor > 0;
  } catch {
    return false;
  }
}

/**
 * A missing optional tool is info, except the toolkit's while something
 * depends on it (Q6): gh-axi always (every GitHub job), chrome-devtools-axi
 * while a workflow runs a browser stage, acli while jira-axi is installed,
 * and quota-axi while the quota floor is on.
 */
function missingStatus(config: FlowrynConfig, name: ToolName, which: Which): CheckStatus {
  if (REQUIRED_TOOLS.includes(name)) return "fail";
  if (name === "gh_axi") return "warn";
  if (name === "chrome_devtools_axi") return usesBrowser(config) ? "warn" : "info";
  if (name === "acli") return locate(config, "jira_axi", which) ? "warn" : "info";
  if (name === "quota_axi") return quotaFloorOn(config) ? "warn" : "info";
  return "info";
}

type Which = (binary: string) => string | null;

/** resolveTool, with the PATH lookup passed in (tests). */
function locate(config: FlowrynConfig, name: ToolName, which: Which): string | null {
  return config.tools[name] ?? whichTool(name, which);
}

/**
 * chrome-devtools-axi starts chrome-devtools-mcp from a global install, or else
 * fetches `npx -y chrome-devtools-mcp@latest` on every start (unpinned, and off
 * the registry for a sandboxed run): suggest the global install.
 */
export function chromeMcpCheck(config: FlowrynConfig, env: NodeJS.ProcessEnv, which: Which = Bun.which): Check | null {
  if (!locate(config, "chrome_devtools_axi", which)) return null;
  if (env.CHROME_DEVTOOLS_AXI_MCP_PATH || which("chrome-devtools-mcp")) return null;
  return {
    check: "chrome-devtools-mcp",
    status: "info",
    detail: "not installed globally: chrome-devtools-axi fetches chrome-devtools-mcp@latest with npx on each start. Install: npm install -g chrome-devtools-mcp",
  };
}

const STALE_LOCK_MS = 30_000;

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function toolChecks(config: FlowrynConfig, which: Which = Bun.which): Check[] {
  const checks: Check[] = [];
  for (const name of TOOL_NAMES) {
    const required = REQUIRED_TOOLS.includes(name);
    const configured = config.tools[name];
    const found = locate(config, name, which);
    if (configured && !existsSync(configured)) {
      checks.push({ check: `tool ${name}`, status: required ? "fail" : "warn", detail: `configured path is missing: ${configured}` });
    } else if (found && !executable(found)) {
      checks.push({ check: `tool ${name}`, status: required ? "fail" : "warn", detail: `not executable: ${found}` });
    } else if (configured) {
      checks.push({ check: `tool ${name}`, status: "ok", detail: configured });
    } else if (found) {
      checks.push({ check: `tool ${name}`, status: required ? "warn" : "info", detail: `found on PATH, not recorded in config: ${found} (flowryn init records it)` });
    } else {
      const detail = required ? "not found" : (OPTIONAL_TOOLS[name] ?? "not found (needed from M2)");
      checks.push({ check: `tool ${name}`, status: missingStatus(config, name, which), detail: `${detail}. Install: ${INSTALL_HINTS[name]}` });
    }
  }
  return checks;
}

/** lavish-axi's version against the one the review questions' poll was verified on; nothing when it is not installed. */
async function lavishCheck(config: FlowrynConfig): Promise<Check[]> {
  const lavish = resolveTool(config, "lavish_axi");
  if (!lavish || !existsSync(lavish)) return [];
  const node = resolveTool(config, "node");
  const path = [node ? dirname(node) : null, dirname(lavish), process.env.PATH ?? "/usr/bin:/bin"].filter(Boolean).join(":");
  let version = "";
  try {
    const proc = Bun.spawn([lavish, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...process.env, PATH: path } });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
    version = (await new Response(proc.stdout).text()).trim();
    clearTimeout(timer);
  } catch {
    version = "";
  }
  if (!/^\d+\.\d+\.\d+/.test(version)) return [{ check: "lavish-axi version", status: "warn", detail: `cannot read the version from ${lavish} --version` }];
  if (version !== VERIFIED_LAVISH_AXI) return [{ check: "lavish-axi version", status: "warn", detail: `${version}; review questions were verified against ${VERIFIED_LAVISH_AXI} (its poll output and prompt fields)` }];
  return [{ check: "lavish-axi version", status: "ok", detail: version }];
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
      checks.push(contractCheck(harness as HarnessId, version, db ? recordedPasses(db, harness, version) : []));
    }
  } finally {
    db?.close();
  }
  return checks;
}

/** The passes recorded for this harness version, any revision; one from before migration 21 is at the baseline revision. */
function recordedPasses(db: Db, harness: string, version: string): { revision: number; passed_at: number }[] {
  const schema = schemaVersion(db);
  if (schema < 2) return [];
  const sql =
    schema >= 21
      ? "SELECT revision, passed_at FROM harness_contracts WHERE harness = ?1 AND version = ?2 ORDER BY revision"
      : `SELECT ${BASELINE_REVISION} AS revision, passed_at FROM harness_contracts WHERE harness = ?1 AND version = ?2`;
  return db.query(sql).all(harness, version) as { revision: number; passed_at: number }[];
}

/** The contract check of an installed harness version: a pass at this build's contract revision, or why there is none. */
export function contractCheck(harness: HarnessId, version: string, passes: { revision: number; passed_at: number }[]): Check {
  const revision = contractRevision(harness);
  const current = passes.find((p) => p.revision === revision);
  if (current) return { check: `contract ${harness}`, status: "ok", detail: `${version} passed ${new Date(current.passed_at).toISOString().slice(0, 10)} at contract revision ${revision}` };
  const why = unverifiedReason(harness, version, revision, passes.map((p) => p.revision));
  return { check: `contract ${harness}`, status: "warn", detail: `${why}, so dispatch refuses it: ${contractsCommand(harness)}` };
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
  const chromeMcp = chromeMcpCheck(config, env.env);
  if (chromeMcp) checks.push(chromeMcp);
  checks.push(...(await tasksChecks(config)));
  checks.push(...(await lavishCheck(config)));
  checks.push(...databaseChecks(config));
  checks.push(...(await daemonChecks(home, config, env)));
  checks.push(...configSectionProblems(config, env.env).map((problem): Check => ({ check: "config", status: "fail", detail: problem })));
  checks.push(await herdrCheck(config));
  checks.push(await piExtensionCheck());
  checks.push(...(await contractChecks(config)));
  const policy = policyCheck(config);
  if (policy) checks.push(policy);
  checks.push(await hostCheckNow(config));
  const quota = await quotaCheck(config);
  if (quota) checks.push(quota);
  return checks;
}

/** The [policy] mode in force, in one line; a bad value is already a config failure above. */
export function policyCheck(config: FlowrynConfig): Check | null {
  try {
    const mode = policyMode(config);
    return { check: "policy", status: "ok", detail: `${mode}: ${POLICY_MODE_LINES[mode]}` };
  } catch {
    return null;
  }
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

/**
 * The quota floor's probe, run now as the scheduler runs it: the reading
 * against the floor. Nothing when the floor is off or quota-axi is missing
 * (its tool line says so).
 */
export async function quotaCheck(config: FlowrynConfig, probe: (tool: string, node: string | null) => Promise<QuotaReading> = probeQuota): Promise<Check | null> {
  let floor: number;
  try {
    floor = capacityConfig(config).quota.floor;
  } catch {
    return null;
  }
  if (floor <= 0) return null;
  const tool = resolveTool(config, "quota_axi");
  if (!tool || !existsSync(tool)) return null;
  const reading = await probe(tool, resolveTool(config, "node"));
  if (reading.state === "unknown") return { check: "quota probe", status: "warn", detail: `${reading.detail}; new Claude runs never wait on the quota while it fails` };
  const window = reading.window ? ` (${reading.window})` : "";
  if (judgeQuota(reading, floor) === "low") return { check: "quota probe", status: "warn", detail: `claude ${reading.percent}%${window}, under the ${floor}% floor: new Claude runs wait (flowryn capacity resume --harness claude starts them anyway)` };
  return { check: "quota probe", status: "ok", detail: `claude ${reading.percent}%${window} effective, floor ${floor}%` };
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

