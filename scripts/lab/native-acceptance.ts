#!/usr/bin/env bun
/**
 * The native deployment acceptance run (docs/notes/2026-10-12-next-steps-md-ny.md):
 * Flowryn installed under real launchd on this Mac, with a separate home and
 * label, compiled artifacts and the fake external services, exercising a
 * replacement build, a failed candidate, pinned callers, shutdown and
 * uninstall, and keeping a report of exactly what ran.
 *
 *   bun scripts/lab/native-acceptance.ts --plan [--home <dir>]
 *   FLOWRYN_NATIVE_ACCEPTANCE=1 bun scripts/lab/native-acceptance.ts --run [--home <dir>] [--report <file>] [--keep]
 *
 * --plan prints what it would install and touches nothing (no launchd, no
 * files). --run needs FLOWRYN_NATIVE_ACCEPTANCE=1 as well, refuses anything
 * that could reach the production service, and always unloads its own label
 * at the end. Run it outside a command sandbox. `bun test` imports this module
 * for its guards and report shape; the run itself only happens under
 * import.meta.main.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { hostname, homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Database } from "bun:sqlite";
import { defaultConfig, loadConfig, TOOL_NAMES, whichTool, type FlowrynConfig, type ToolName } from "../../src/config/config.ts";
import { requireNotificationsOff } from "../../src/config/leader.ts";
import { flowrynHome, socketPath, stateFiles } from "../../src/config/paths.ts";
import { callerLink } from "../../src/daemon/caller-binary.ts";
import { buildIdOf } from "../../src/daemon/restart.ts";
import { PING_VERB, STOP_VERB } from "../../src/daemon/system-verbs.ts";
import { agentPid, BASE_LABEL, installService, isLoaded, plistPath, plistSpecFor, readInstalledPlist, renderPlist, serviceLabel, uninstallService, type PlistSpec } from "../../src/service/launchd.ts";
import { request } from "../../src/transport/unix.ts";
import { ulid } from "../../src/util/ulid.ts";
import { PROTO, VERSION } from "../../src/version.ts";

export const REPO_ROOT = resolve(import.meta.dir, "../..");
export const OPT_IN_ENV = "FLOWRYN_NATIVE_ACCEPTANCE";
export const REPORT_KIND = "flowryn-native-acceptance";
export const REPORT_SCHEMA = 1;
/** launchd's ThrottleInterval in the plist is 10 s; a clean exit must still be stopped after it. */
const STAYS_STOPPED_MS = 12_000;
/** How long teardown waits for an install in flight (bootstrap retries and all) before unloading. */
const INSTALL_SETTLE_MS = 30_000;
/** Extra bootouts teardown makes when a late bootstrap loaded the label after its uninstall. */
const LATE_BOOTOUT_SWEEPS = 3;
/** The signals that tear the run down, write the report and exit 130 (SIGHUP: the terminal closed). */
export const TEARDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const satisfies readonly NodeJS.Signals[];

export const STEPS = [
  { name: "build", does: "compile candidates A and B with scripts/build.sh, stamped with two commits on a scratch origin/main; a truncated copy of B is the broken one" },
  { name: "install", does: "copy A into <home>/inst/flowryn, write and bootstrap the plist; launchd's pid answers the socket with A's build" },
  { name: "pinned-callers", does: "<state>/bin/flowryn links to A; its version reports A's commit; a todo add through it is served" },
  { name: "replacement", does: "rename B over the installed binary; the link stays on A until launchd restarts the daemon onto B, which then serves a todo add" },
  { name: "failed-candidate", does: "rename the broken binary over it; the daemon refuses it (build_refused) and B keeps serving; B goes back and the item closes" },
  { name: "shutdown", does: "daemon.stop as flowryn daemon stop sends it; the socket goes quiet and launchd leaves the clean exit stopped past its throttle" },
  { name: "uninstall", does: "uninstallService: the label is no longer loaded and the plist is gone" },
] as const;
export type StepName = (typeof STEPS)[number]["name"];

// ---------------------------------------------------------------- arguments and opt-in

export interface Args {
  mode: "plan" | "run" | null;
  home: string | null;
  report: string | null;
  keep: boolean;
}

export function parseCliArgs(argv: string[]): Args {
  const { values } = parseArgs({
    args: argv,
    options: { plan: { type: "boolean" }, run: { type: "boolean" }, home: { type: "string" }, report: { type: "string" }, keep: { type: "boolean" } },
    strict: true,
  });
  if (values.plan && values.run) throw new Error("--plan and --run are exclusive");
  return { mode: values.plan ? "plan" : values.run ? "run" : null, home: values.home ?? null, report: values.report ?? null, keep: values.keep === true };
}

/** Why this invocation may not go ahead at all, before any path is looked at. */
export function invocationRefusals(args: Args, env: NodeJS.ProcessEnv, platform: string): string[] {
  const refusals: string[] = [];
  if (args.mode === null) refusals.push("say --plan (print what it would install) or --run (install it, with FLOWRYN_NATIVE_ACCEPTANCE=1)");
  if (args.mode === "run" && env[OPT_IN_ENV] !== "1") refusals.push(`--run installs a launchd agent; it needs ${OPT_IN_ENV}=1 as well`);
  if (args.mode === "run" && platform !== "darwin") refusals.push("the acceptance run drives launchd, which is macOS only");
  if (args.mode === "run" && (env.FLOWRYN_RUN ?? "").length > 0) refusals.push("FLOWRYN_RUN is set: a worker never installs a launchd agent");
  return refusals;
}

// ---------------------------------------------------------------- the plan

export interface Plan {
  home: string;
  label: string;
  plist: string;
  socket: string;
  stateDir: string;
  dataDir: string;
  install: string;
  herdrSocket: string;
  pinnedLink: string;
  spec: PlistSpec;
}

/** The environment the acceptance home's daemon runs with: what `makeHome` sets (test/helpers/harness.ts). */
export function acceptanceOverrides(home: string): Record<string, string> {
  return { FLOWRYN_NOTIFY: "off", FLOWRYN_NOTIFIER: `record:${join(home, "notified.jsonl")}`, FLOWRYN_OPENER: `record:${join(home, "browser-opens.log")}` };
}

/** The tools makeHome records (test/helpers/harness.ts); every other tool gets the absent stand-in, so none resolves on this machine's PATH. */
export const MAKEHOME_TOOLS: readonly ToolName[] = ["tasks_axi", "node", "git", "no_mistakes", "gh", "lavish_axi", "quota_axi", "claude", "pi"];
export const ABSENT_TOOL = "#!/bin/sh\necho 'not available in the native acceptance run' >&2\nexit 1\n";

export function absentToolPath(home: string): string {
  return join(home, "bin", "tool-absent");
}

/** The [tools] lines the run adds to makeHome's config: the absent stand-in for every tool it does not record. */
export function extraToolLines(home: string): string[] {
  return TOOL_NAMES.filter((name) => !MAKEHOME_TOOLS.includes(name)).map((name) => `${name} = ${JSON.stringify(absentToolPath(home))}`);
}

/** The tools as the run's home will record them, for --plan: node, git and tasks-axi from the scrubbed PATH, stand-ins for the rest. */
export function plannedTools(home: string, path: string): FlowrynConfig["tools"] {
  const tools: FlowrynConfig["tools"] = {};
  for (const name of TOOL_NAMES) {
    if (name === "node" || name === "git" || name === "tasks_axi") {
      const found = whichTool(name, (binary) => Bun.which(binary, { PATH: path }));
      if (found) tools[name] = found;
    } else if (name === "claude" || name === "pi") tools[name] = join(home, "bin", "harness-absent");
    else tools[name] = MAKEHOME_TOOLS.includes(name) ? join(home, "bin", name.replace(/_/g, "-")) : absentToolPath(home);
  }
  return tools;
}

/** A fresh home path: under the temp directory's realpath (a compiled binary's execPath is resolved), short enough for its socket. */
export function defaultHome(): string {
  return join(realpathSync(tmpdir()), `fna-${randomBytes(4).toString("hex")}`);
}

/** The --home given: absolute, with its parent's symlinks resolved (the home itself must not exist yet). */
export function resolveHome(given: string): string {
  const abs = resolve(given);
  const parent = dirname(abs);
  return join(existsSync(parent) ? realpathSync(parent) : parent, basename(abs));
}

/**
 * Every identifier the run would use, from the home alone (the layout
 * makeHome writes). The plist is the daemon's own spec with the installed
 * binary as its program, which is what the compiled daemon computes for
 * itself, so its launchd supervisor restarts through it without drift.
 */
export function planFor(home: string, config: FlowrynConfig, daemonEnv: Record<string, string>): Plan {
  const install = join(home, "inst", "flowryn");
  const spec = { ...plistSpecFor(config, home, daemonEnv), program: [install, "daemon", "run"] };
  return {
    home,
    label: spec.label,
    plist: plistPath(spec.label),
    socket: socketPath(home, {}),
    stateDir: config.state_dir,
    dataDir: config.data_dir,
    install,
    herdrSocket: join(home, "herdr.sock"),
    pinnedLink: callerLink(config.state_dir),
    spec,
  };
}

// ---------------------------------------------------------------- the guards

export interface ProductionTarget {
  home: string;
  label: string;
  plist: string;
  sockets: string[];
  dirs: string[];
  program: string | null;
}

/** The production homes: the default ~/.flowryn and the caller's FLOWRYN_HOME, each with its label, plist, socket, directories and installed program. */
export async function productionTargets(env: NodeJS.ProcessEnv, readProgram: (plist: string) => Promise<string | null> = installedProgram): Promise<ProductionTarget[]> {
  const homes = [join(homedir(), ".flowryn")];
  if ((env.FLOWRYN_HOME ?? "").length > 0) homes.push(flowrynHome(env));
  const targets: ProductionTarget[] = [];
  for (const home of new Set(homes)) {
    const label = serviceLabel(home);
    const plist = plistPath(label);
    const dirs = [home];
    try {
      const { config } = loadConfig(home);
      dirs.push(config.data_dir, config.state_dir);
    } catch {
      // An unreadable config still leaves the home itself guarded.
    }
    const sockets = [...new Set([socketPath(home, {}), socketPath(home, env)])];
    targets.push({ home, label, plist, sockets, dirs: [...new Set(dirs)], program: await readProgram(plist) });
  }
  return targets;
}

async function installedProgram(plist: string): Promise<string | null> {
  if (!existsSync(plist)) return null;
  try {
    return (await readInstalledPlist(plist)).program[0] ?? null;
  } catch {
    return null;
  }
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function overlaps(a: string, b: string): boolean {
  const x = real(a);
  const y = real(b);
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/** Every way the plan could reach a production service; empty when it cannot. */
export function collisions(plan: Plan, production: ProductionTarget[]): string[] {
  const found: string[] = [];
  if (plan.label === BASE_LABEL) found.push(`the label is the production label ${BASE_LABEL}`);
  for (const prod of production) {
    if (plan.label === prod.label) found.push(`the label ${plan.label} is the label of ${prod.home}`);
    if (plan.plist === prod.plist) found.push(`the plist ${plan.plist} is the plist of ${prod.home}`);
    if (prod.sockets.includes(plan.socket)) found.push(`the socket ${plan.socket} is the socket of ${prod.home}`);
    for (const dir of prod.dirs) {
      for (const [what, mine] of [["home", plan.home], ["state dir", plan.stateDir], ["data dir", plan.dataDir]] as const) {
        if (overlaps(mine, dir)) found.push(`the ${what} ${mine} overlaps ${dir} of ${prod.home}`);
      }
    }
    if (prod.program && real(prod.program) === real(plan.install)) found.push(`the installed binary ${plan.install} is the program of ${prod.label}`);
    for (const entry of (plan.spec.env.PATH ?? "").split(":")) {
      if (entry.length > 0 && prod.dirs.some((dir) => overlaps(entry, dir))) found.push(`the daemon's PATH entry ${entry} is inside ${prod.home}`);
    }
  }
  return [...new Set(found)];
}

/** The PATH without any entry inside a production home or its directories (its harness shims), so no tool resolves there. */
export function scrubPath(path: string, production: ProductionTarget[]): string {
  const dirs = production.flatMap((prod) => prod.dirs);
  return path
    .split(":")
    .filter((entry) => entry.length > 0 && !dirs.some((dir) => overlaps(entry, dir)))
    .join(":");
}

/** What an earlier run left behind: the home, or a plist at this label. */
export function leftovers(plan: Plan, exists: (path: string) => boolean = existsSync): string[] {
  const found: string[] = [];
  if (exists(plan.home)) found.push(`${plan.home} already exists; give a new --home`);
  if (exists(plan.plist)) found.push(`a plist is already installed at ${plan.plist}`);
  return found;
}

// ---------------------------------------------------------------- the report

export interface Artifact {
  role: "initial" | "replacement" | "broken";
  path: string;
  build: string;
  sha256: string;
  bytes: number;
  commit: string | null;
}

export interface StepResult {
  name: StepName;
  ok: boolean;
  detail: string;
  evidence: Record<string, unknown>;
  ms: number;
}

export interface Teardown {
  label_gone: boolean;
  plist_gone: boolean;
  home_removed: boolean;
  kept: boolean;
  errors: string[];
}

export interface Environment {
  host: string;
  macos: string | null;
  macos_build: string | null;
  arch: string;
  uid: number;
  launchd_domain: string;
  bun: string;
  flowryn: string;
  proto: number;
  source_commit: string | null;
  source_dirty: boolean | null;
  label: string;
  plist: string;
  home: string;
  socket: string;
  herdr_socket: string;
  forge_url: string | null;
}

export interface Report {
  kind: typeof REPORT_KIND;
  schema: typeof REPORT_SCHEMA;
  run_id: string;
  result: "pass" | "fail";
  started_at: string;
  ended_at: string | null;
  environment: Environment;
  artifacts: Artifact[];
  steps: StepResult[];
  teardown: Teardown | null;
}

export function newReport(runId: string, environment: Environment, now: Date): Report {
  return { kind: REPORT_KIND, schema: REPORT_SCHEMA, run_id: runId, result: "fail", started_at: now.toISOString(), ended_at: null, environment, artifacts: [], steps: [], teardown: null };
}

/** A pass needs every step, in order, each ok, and a teardown that left no label, plist or error behind. */
export function finishReport(report: Report, teardown: Teardown, now: Date): Report {
  const allSteps = report.steps.length === STEPS.length && STEPS.every((step, i) => report.steps[i]?.name === step.name && report.steps[i]?.ok);
  const clean = teardown.label_gone && teardown.plist_gone && teardown.errors.length === 0;
  return { ...report, teardown, ended_at: now.toISOString(), result: allSteps && clean ? "pass" : "fail" };
}

/** Shape problems in a report; empty when it is well formed. */
export function validateReport(raw: unknown): string[] {
  const problems: string[] = [];
  if (!raw || typeof raw !== "object") return ["not an object"];
  const r = raw as Partial<Report>;
  if (r.kind !== REPORT_KIND) problems.push("kind");
  if (r.schema !== REPORT_SCHEMA) problems.push("schema");
  if (typeof r.run_id !== "string" || r.run_id.length === 0) problems.push("run_id");
  if (r.result !== "pass" && r.result !== "fail") problems.push("result");
  if (typeof r.started_at !== "string" || Number.isNaN(Date.parse(r.started_at))) problems.push("started_at");
  if (r.ended_at !== null && (typeof r.ended_at !== "string" || Number.isNaN(Date.parse(r.ended_at)))) problems.push("ended_at");
  const env = r.environment as Partial<Environment> | undefined;
  if (!env || typeof env !== "object") problems.push("environment");
  else {
    for (const key of ["host", "arch", "launchd_domain", "bun", "flowryn", "label", "plist", "home", "socket", "herdr_socket"] as const) {
      if (typeof env[key] !== "string" || (env[key] as string).length === 0) problems.push(`environment.${key}`);
    }
    if (env.label === BASE_LABEL) problems.push("environment.label is the production label");
    if (typeof env.uid !== "number" || typeof env.proto !== "number") problems.push("environment.uid/proto");
  }
  if (!Array.isArray(r.artifacts)) problems.push("artifacts");
  else
    r.artifacts.forEach((a, i) => {
      if (!["initial", "replacement", "broken"].includes(a?.role)) problems.push(`artifacts[${i}].role`);
      if (!/^[0-9a-f]{12}$/.test(a?.build ?? "")) problems.push(`artifacts[${i}].build`);
      if (!/^[0-9a-f]{64}$/.test(a?.sha256 ?? "")) problems.push(`artifacts[${i}].sha256`);
      if (a?.sha256 && a?.build && !a.sha256.startsWith(a.build)) problems.push(`artifacts[${i}].build is not the sha256 prefix`);
      if (typeof a?.bytes !== "number" || typeof a?.path !== "string") problems.push(`artifacts[${i}].path/bytes`);
      if (a?.commit !== null && !/^[0-9a-f]{40}$/.test(a?.commit ?? "")) problems.push(`artifacts[${i}].commit`);
    });
  if (!Array.isArray(r.steps)) problems.push("steps");
  else
    r.steps.forEach((s, i) => {
      if (s?.name !== STEPS[i]?.name) problems.push(`steps[${i}].name`);
      if (typeof s?.ok !== "boolean" || typeof s?.detail !== "string" || typeof s?.ms !== "number" || !s?.evidence || typeof s.evidence !== "object") problems.push(`steps[${i}]`);
    });
  if (r.teardown !== null) {
    const t = r.teardown as Partial<Teardown> | undefined;
    if (!t || typeof t.label_gone !== "boolean" || typeof t.plist_gone !== "boolean" || typeof t.home_removed !== "boolean" || !Array.isArray(t.errors)) problems.push("teardown");
  }
  if (r.result === "pass" && (r.teardown === null || r.steps?.length !== STEPS.length || r.steps.some((s) => !s.ok))) problems.push("result is pass without every step and a teardown");
  return problems;
}

export function describeArtifact(role: Artifact["role"], path: string, commit: string | null): Artifact {
  const bytes = readFileSync(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { role, path, build: buildIdOf([path])!, sha256, bytes: bytes.length, commit };
}

// ---------------------------------------------------------------- the run

class StepFailed extends Error {
  constructor(
    message: string,
    readonly evidence: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function check(ok: boolean, message: string, evidence: Record<string, unknown> = {}): void {
  if (!ok) throw new StepFailed(message, evidence);
}

function sh(argv: string[], options: { cwd?: string; env?: Record<string, string> } = {}): { code: number; out: string; err: string } {
  const result = Bun.spawnSync(argv, { cwd: options.cwd, env: options.env ?? (process.env as Record<string, string>), stdin: "ignore" });
  return { code: result.exitCode, out: result.stdout.toString().trim(), err: result.stderr.toString().trim() };
}

function git(cwd: string, args: string[]): string {
  const env = { ...(process.env as Record<string, string>), GIT_AUTHOR_NAME: "acceptance", GIT_AUTHOR_EMAIL: "acceptance@localhost", GIT_COMMITTER_NAME: "acceptance", GIT_COMMITTER_EMAIL: "acceptance@localhost" };
  const result = sh(["git", ...args], { cwd, env });
  if (result.code !== 0) throw new StepFailed(`git ${args.join(" ")}: ${result.err}`);
  return result.out;
}

async function waitFor<T>(what: string, timeoutMs: number, probe: () => Promise<T | null> | T | null): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== null) return value;
    await Bun.sleep(100);
  }
  throw new StepFailed(`timed out after ${timeoutMs / 1000} s waiting for ${what}`);
}

interface Ping {
  pid: number;
  build: string | null;
}

async function ping(socket: string): Promise<Ping | null> {
  try {
    const reply = (await request(socket, { proto: PROTO, ulid: ulid(), verb: PING_VERB, args: {} }, { connectMs: 300, replyMs: 3_000 })) as { ok: boolean; data?: Ping };
    return reply.ok && reply.data ? reply.data : null;
  } catch {
    return null;
  }
}

/** Put a file in place the way a build does: a copy beside the target, then a rename, so the target gets a new inode at once. */
function installOver(source: string, target: string): void {
  const staging = join(dirname(target), `.staging-${basename(target)}`);
  copyFileSync(source, staging);
  renameSync(staging, target);
}

function readDb<T>(stateDir: string, read: (db: Database) => T): T {
  const db = new Database(stateFiles(stateDir).db, { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function osVersion(flag: string): string | null {
  const result = sh(["/usr/bin/sw_vers", flag]);
  return result.code === 0 ? result.out : null;
}

function sourceState(): { commit: string | null; dirty: boolean | null } {
  const head = sh(["git", "-C", REPO_ROOT, "rev-parse", "HEAD"]);
  const status = sh(["git", "-C", REPO_ROOT, "status", "--porcelain"]);
  return { commit: head.code === 0 ? head.out : null, dirty: status.code === 0 ? status.out.length > 0 : null };
}

export function environmentOf(plan: Plan, forgeUrl: string | null): Environment {
  const source = sourceState();
  return {
    host: hostname(),
    macos: osVersion("-productVersion"),
    macos_build: osVersion("-buildVersion"),
    arch: process.arch,
    uid: userInfo().uid,
    launchd_domain: `gui/${userInfo().uid}`,
    bun: Bun.version,
    flowryn: VERSION,
    proto: PROTO,
    source_commit: source.commit,
    source_dirty: source.dirty,
    label: plan.label,
    plist: plan.plist,
    home: plan.home,
    socket: plan.socket,
    herdr_socket: plan.herdrSocket,
    forge_url: forgeUrl,
  };
}

async function run(args: Args, home: string): Promise<number> {
  // The fakes and the home builder are the test harness's own (the run is a lab tool, not product code).
  const { makeHome, seedLeader } = await import("../../test/helpers/harness.ts");
  const { FakeHerdr } = await import("../../test/helpers/fake-herdr.ts");
  const { FakeGitHub } = await import("../../test/helpers/fake-github.ts");

  // Guards first, from the plan alone: nothing exists yet. Tools resolve on a PATH without production's directories.
  const production = await productionTargets(process.env);
  const planned = planFor(home, { ...defaultConfig(home), tools: plannedTools(home, scrubPath(process.env.PATH ?? "", production)) }, acceptanceOverrides(home));
  const refused = [...collisions(planned, production), ...leftovers(planned)];
  if (await isLoaded(planned.label)) refused.push(`the label ${planned.label} is already loaded in launchd`);
  if (refused.length > 0) {
    console.error(`native-acceptance: refused:\n  ${refused.join("\n  ")}`);
    return 2;
  }

  const runId = ulid();
  const reportPath = resolve(args.report ?? join(REPO_ROOT, "spikes", ".runs", `native-acceptance-${runId}.json`));
  const forge = await FakeGitHub.start();
  let herdr: { stop(): Promise<void> } | null = null;
  // A failure before the steps: nothing is loaded yet, so stop what started and remove the home, which did not exist before the guards.
  const abandonSetup = async (): Promise<void> => {
    for (const [what, stop] of [["fake Herdr", () => herdr?.stop()], ["fake forge", () => forge.stop()]] as const) {
      try {
        await stop();
      } catch (error) {
        console.error(`native-acceptance: stopping the ${what}: ${(error as Error).message}`);
      }
    }
    if (home.length > 1) rmSync(home, { recursive: true, force: true });
  };
  let h: ReturnType<typeof makeHome>;
  let plan: Plan;
  let token: string;
  try {
    h = makeHome({
      home,
      extraConfig: [
        ...extraToolLines(home),
        "[daemon]",
        "build_poll_ms = 200",
        "build_settle_ms = 3000",
        "[upkeep]",
        "build_after_merge = false",
        "[herdr]",
        `socket = ${JSON.stringify(join(home, "herdr.sock"))}`,
        "[github]",
        `api_url = ${JSON.stringify(forge.apiUrl)}`,
      ].join("\n"),
    });
    writeFileSync(absentToolPath(home), ABSENT_TOOL, { mode: 0o755 });
    requireNotificationsOff(h.env, "the native acceptance run");
    plan = planFor(home, loadConfig(home).config, h.env);
    const late = collisions(plan, production);
    if (plan.label !== planned.label || plan.socket !== planned.socket || plan.plist !== planned.plist || late.length > 0) {
      await abandonSetup();
      console.error(`native-acceptance: refused once the home was built:\n  ${[...late, "or the home's config moved an identifier the guards checked"].join("\n  ")}`);
      return 2;
    }
    herdr = await FakeHerdr.start(plan.herdrSocket, { env: h.env, logDir: join(home, "herdr-logs") });
    token = seedLeader(h);
  } catch (error) {
    await abandonSetup();
    console.error(`native-acceptance: setup failed, nothing was installed: ${(error as Error).message}`);
    return 1;
  }
  let report = newReport(runId, environmentOf(plan, forge.apiUrl), new Date());
  const callerEnv = { ...h.env, FLOWRYN_TOKEN: token };

  // The install in flight, so a signal during bootstrap tears down after it settles rather than racing it.
  let installing: Promise<void> | null = null;
  let tornDown: Promise<Teardown> | null = null;
  const teardown = (): Promise<Teardown> => {
    tornDown ??= (async () => {
      const errors: string[] = [];
      if (installing) await Promise.race([installing.catch(() => undefined), Bun.sleep(INSTALL_SETTLE_MS)]);
      try {
        await uninstallService(plan.label, plan.plist);
      } catch (error) {
        errors.push(`uninstall ${plan.label}: ${(error as Error).message}`);
      }
      for (const [what, stop] of [["fake Herdr", () => herdr?.stop()], ["fake forge", () => forge.stop()]] as const) {
        try {
          await stop();
        } catch (error) {
          errors.push(`${what}: ${(error as Error).message}`);
        }
      }
      // A bootstrap that was still in flight can load the label after the uninstall: boot it out again, a bounded number of times.
      for (let sweep = 0; sweep < LATE_BOOTOUT_SWEEPS && (await isLoaded(plan.label)); sweep++) {
        try {
          await uninstallService(plan.label, plan.plist);
        } catch (error) {
          errors.push(`late bootout ${plan.label}: ${(error as Error).message}`);
        }
        await Bun.sleep(500);
      }
      if (existsSync(plan.plist)) {
        try {
          unlinkSync(plan.plist);
        } catch (error) {
          errors.push(`remove ${plan.plist}: ${(error as Error).message}`);
        }
      }
      const labelGone = !(await isLoaded(plan.label));
      const plistGone = !existsSync(plan.plist);
      let homeRemoved = false;
      if (!args.keep && labelGone && plan.home.length > 1) {
        rmSync(plan.home, { recursive: true, force: true });
        homeRemoved = !existsSync(plan.home);
      }
      return { label_gone: labelGone, plist_gone: plistGone, home_removed: homeRemoved, kept: args.keep, errors };
    })();
    return tornDown;
  };
  const writeReport = async (): Promise<void> => {
    report = finishReport(report, await teardown(), new Date());
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  };
  const onSignal = (signal: NodeJS.Signals) => {
    console.error(`native-acceptance: ${signal}, tearing down ${plan.label}; report ${reportPath}`);
    void writeReport().finally(() => process.exit(130));
  };
  for (const signal of TEARDOWN_SIGNALS) process.once(signal, onSignal);

  const state: { a?: Artifact; b?: Artifact; broken?: Artifact; pid?: number } = {};
  const pinnedCaller = (argv: string[]) => sh([plan.pinnedLink, ...argv], { env: callerEnv });
  const servedTodo = (text: string): Record<string, unknown> => {
    const added = pinnedCaller(["todo", "add", text]);
    check(added.code === 0, `todo add through the pinned caller exited ${added.code}: ${added.err || added.out}`);
    check(readFileSync(h.todos, "utf8").includes(text), `todos.md lacks ${text}`);
    return { todo: text };
  };

  const steps: Record<StepName, () => Promise<Record<string, unknown>>> = {
    build: async () => {
      const origin = join(home, "src-origin.git");
      const source = join(home, "source");
      git(home, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
      git(home, ["clone", "--quiet", origin, source]);
      const commits: string[] = [];
      for (const which of ["a", "b"]) {
        writeFileSync(join(source, "CANDIDATE"), `${which}\n`);
        git(source, ["add", "CANDIDATE"]);
        git(source, ["commit", "--quiet", "-m", `candidate ${which}`]);
        commits.push(git(source, ["rev-parse", "HEAD"]));
      }
      git(source, ["push", "--quiet", "origin", "HEAD:main"]);
      git(source, ["fetch", "--quiet", "origin"]);
      const buildEnv = { ...h.env, BUN_TMPDIR: process.env.BUN_TMPDIR ?? tmpdir() };
      const built: Artifact[] = [];
      for (const [i, role] of (["initial", "replacement"] as const).entries()) {
        const out = join(home, "cand", role, "flowryn");
        const result = sh([join(REPO_ROOT, "scripts", "build.sh"), out], {
          cwd: REPO_ROOT,
          env: { ...buildEnv, FLOWRYN_BUILD_COMMIT: commits[i]!, FLOWRYN_BUILD_DIRTY: "false", FLOWRYN_BUILD_SOURCE: source },
        });
        check(result.code === 0, `scripts/build.sh for ${role} exited ${result.code}: ${result.err.split("\n").slice(-3).join(" ")}`);
        built.push(describeArtifact(role, out, commits[i]!));
      }
      [state.a, state.b] = built;
      check(state.a!.build !== state.b!.build, "the two candidates have the same build id");
      const broken = join(home, "cand", "broken", "flowryn");
      mkdirSync(dirname(broken), { recursive: true });
      writeFileSync(broken, readFileSync(state.b!.path).subarray(0, 256 * 1024), { mode: 0o755 });
      state.broken = describeArtifact("broken", broken, null);
      report.artifacts.push(state.a!, state.b!, state.broken);
      return { source, commits };
    },
    install: async () => {
      mkdirSync(dirname(plan.install), { recursive: true });
      installOver(state.a!.path, plan.install);
      installing = installService(plan.spec, plan.plist);
      await installing;
      const up = await waitFor("the launchd daemon to answer", 30_000, () => ping(plan.socket));
      const launchdPid = await agentPid(plan.label);
      check(launchdPid === up.pid, `launchd runs pid ${launchdPid}, the socket answers pid ${up.pid}`, { launchdPid, ...up });
      check(up.build === state.a!.build, `the daemon runs build ${up.build}, not A's ${state.a!.build}`, { ...up });
      state.pid = up.pid;
      return { pid: up.pid, build: up.build, plist: renderPlist(plan.spec) };
    },
    "pinned-callers": async () => {
      const link = readlinkSync(plan.pinnedLink);
      check(link === `flowryn-${state.a!.build}`, `the pinned link names ${link}`, { link });
      const version = pinnedCaller(["version", "--json"]);
      const commit = (JSON.parse(version.out) as { data: { commit: string } }).data.commit;
      check(commit === state.a!.commit, `the pinned caller reports commit ${commit}`, { commit });
      return { link, commit, ...servedTodo(`acceptance ${runId} served by A`) };
    },
    replacement: async () => {
      const inode = statSync(plan.install).ino;
      installOver(state.b!.path, plan.install);
      check(statSync(plan.install).ino !== inode, "the installed binary kept its inode");
      const before = readlinkSync(plan.pinnedLink);
      check(before === `flowryn-${state.a!.build}`, `right after the rename the pinned link names ${before}`, { before });
      const next = await waitFor("launchd to restart the daemon onto B", 90_000, async () => {
        const p = await ping(plan.socket);
        return p && p.pid !== state.pid && p.build === state.b!.build ? p : null;
      });
      const launchdPid = await agentPid(plan.label);
      check(launchdPid === next.pid, `launchd runs pid ${launchdPid}, the socket answers pid ${next.pid}`, { launchdPid, ...next });
      const after = readlinkSync(plan.pinnedLink);
      check(after === `flowryn-${state.b!.build}`, `after the restart the pinned link names ${after}`, { after });
      const restarted = readDb(plan.stateDir, (db) => db.query("SELECT payload FROM events WHERE kind = 'daemon.restarted' ORDER BY seq").all() as { payload: string }[]).map(
        (row) => JSON.parse(row.payload) as { by: string; old: { build: string }; new: { build: string; commit: string } },
      );
      check(restarted.length === 1 && restarted[0]!.by === "auto" && restarted[0]!.old.build === state.a!.build && restarted[0]!.new.build === state.b!.build, "no daemon.restarted event by auto from A to B", { restarted });
      const old = state.pid;
      state.pid = next.pid;
      return { old_pid: old, new_pid: next.pid, link_before: before, link_after: after, restarted: restarted[0], ...servedTodo(`acceptance ${runId} served by B`) };
    },
    "failed-candidate": async () => {
      installOver(state.broken!.path, plan.install);
      const verdict = await waitFor("the build watcher to refuse the broken candidate", 30_000, () =>
        readDb(plan.stateDir, (db) => {
          const meta = db.query("SELECT value FROM meta WHERE key = 'build_watch'").get() as { value: string } | null;
          const judged = meta ? (JSON.parse(meta.value) as { build: string; verdict: string; reason?: string }) : null;
          const item = db.query("SELECT line FROM items WHERE kind = 'build_refused' AND state IN ('open','presented')").get() as { line: string } | null;
          return judged?.build === state.broken!.build && item ? { judged, item: item.line } : null;
        }),
      );
      check(verdict.judged.verdict === "refused" && verdict.judged.reason === "broken", `the verdict is ${verdict.judged.verdict}/${verdict.judged.reason}`, verdict);
      const still = await ping(plan.socket);
      check(still?.pid === state.pid && still?.build === state.b!.build, "the daemon did not keep serving B", { still });
      check((await agentPid(plan.label)) === state.pid, "launchd's pid changed");
      const served = servedTodo(`acceptance ${runId} served by B past the broken one`);
      installOver(state.b!.path, plan.install);
      await waitFor("the build_refused item to close once B is back", 30_000, () =>
        readDb(plan.stateDir, (db) => (db.query("SELECT 1 FROM items WHERE kind = 'build_refused' AND state IN ('open','presented')").get() ? null : true)),
      );
      return { ...verdict, pid: still?.pid, build: still?.build, restored: state.b!.build, ...served };
    },
    shutdown: async () => {
      const reply = (await request(plan.socket, { proto: PROTO, ulid: ulid(), verb: STOP_VERB, channel: "tty", args: {} }, { connectMs: 300, replyMs: 5_000 })) as { ok: boolean };
      check(reply.ok, "daemon.stop was refused", { reply });
      await waitFor("the socket to go quiet", 15_000, async () => ((await ping(plan.socket)) === null ? true : null));
      await Bun.sleep(STAYS_STOPPED_MS);
      const loaded = await isLoaded(plan.label);
      const pid = await agentPid(plan.label);
      const answering = (await ping(plan.socket)) !== null;
      check(loaded && pid === null && !answering, "launchd did not leave the clean exit stopped", { loaded, pid, answering });
      return { loaded, pid, answering, waited_ms: STAYS_STOPPED_MS };
    },
    uninstall: async () => {
      const wasLoaded = await uninstallService(plan.label, plan.plist);
      const loaded = await isLoaded(plan.label);
      const plistExists = existsSync(plan.plist);
      check(wasLoaded && !loaded && !plistExists, "the label or its plist is still there", { wasLoaded, loaded, plistExists });
      return { was_loaded: wasLoaded, loaded, plist_exists: plistExists };
    },
  };

  try {
    for (const { name } of STEPS) {
      const started = Date.now();
      try {
        const evidence = await steps[name]();
        report.steps.push({ name, ok: true, detail: "ok", evidence, ms: Date.now() - started });
        console.log(`ok   ${name}`);
      } catch (error) {
        const evidence = error instanceof StepFailed ? error.evidence : {};
        report.steps.push({ name, ok: false, detail: (error as Error).message, evidence, ms: Date.now() - started });
        console.log(`FAIL ${name}: ${(error as Error).message}`);
        break;
      }
    }
  } finally {
    for (const signal of TEARDOWN_SIGNALS) process.off(signal, onSignal);
    await writeReport();
  }
  const problems = validateReport(report);
  if (problems.length > 0) console.log(`report shape: ${problems.join(", ")}`);
  console.log(`${report.result}: ${report.steps.filter((s) => s.ok).length}/${STEPS.length} steps; teardown label_gone=${report.teardown!.label_gone} plist_gone=${report.teardown!.plist_gone}; report ${reportPath}`);
  return report.result === "pass" && problems.length === 0 ? 0 : 1;
}

/** --plan: every identifier, the guards' verdict and the plist, from the home path alone; creates and loads nothing. */
export async function planOutput(home: string, env: NodeJS.ProcessEnv): Promise<{ ok: boolean; text: string }> {
  const production = await productionTargets(env);
  const plan = planFor(home, { ...defaultConfig(home), tools: plannedTools(home, scrubPath(env.PATH ?? "", production)) }, acceptanceOverrides(home));
  const refusals = [...collisions(plan, production), ...leftovers(plan)];
  const out = {
    mode: "plan",
    home: plan.home,
    label: plan.label,
    plist: plan.plist,
    socket: plan.socket,
    state_dir: plan.stateDir,
    data_dir: plan.dataDir,
    installed_binary: plan.install,
    pinned_caller: plan.pinnedLink,
    herdr_socket: plan.herdrSocket,
    program: plan.spec.program,
    environment: plan.spec.env,
    path_note: "node, git and tasks-axi as found on this PATH without production's directories (makeHome records them the same way); every other tool is a stand-in in <home>/bin",
    steps: STEPS,
    refusals,
    plist_xml: renderPlist(plan.spec),
    run: `${OPT_IN_ENV}=1 bun scripts/lab/native-acceptance.ts --run --home ${plan.home}`,
  };
  return { ok: refusals.length === 0, text: JSON.stringify(out, null, 2) };
}

async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    console.error(`native-acceptance: ${(error as Error).message}`);
    return 2;
  }
  const refused = invocationRefusals(args, process.env, process.platform);
  if (refused.length > 0) {
    console.error(`native-acceptance: refused:\n  ${refused.join("\n  ")}`);
    return 2;
  }
  const home = args.home ? resolveHome(args.home) : defaultHome();
  if (args.mode === "plan") {
    const plan = await planOutput(home, process.env);
    console.log(plan.text);
    return plan.ok ? 0 : 2;
  }
  return run(args, home);
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
