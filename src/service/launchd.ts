import { existsSync, unlinkSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { FlowrynConfig } from "../config/config.ts";
import { TOOL_NAMES, resolveTool } from "../config/config.ts";
import { stateFiles } from "../config/paths.ts";
import { sha256Hex } from "../util/hash.ts";
import { ensureDir, writeFileAtomic } from "../util/fsx.ts";

export const BASE_LABEL = "dev.flowryn.flowrynd";
const SYSTEM_PATH = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** One label per Flowryn home, so a second install (FLOWRYN_HOME) never replaces the first's agent. */
export function serviceLabel(home: string): string {
  const defaultHome = join(homedir(), ".flowryn");
  return home === defaultHome ? BASE_LABEL : `${BASE_LABEL}.${sha256Hex(home).slice(0, 8)}`;
}

export function plistPath(label: string, agentsDir: string = join(homedir(), "Library", "LaunchAgents")): string {
  return join(agentsDir, `${label}.plist`);
}

/** The command that runs this binary as the daemon: the compiled binary, or bun plus the entry script in development. */
export function selfCommand(): string[] {
  const script = process.argv[1];
  const compiled = !script || script.startsWith("/$bunfs/") || script.startsWith("B:/~BUN/");
  return compiled ? [process.execPath] : [process.execPath, script];
}

/** An explicit PATH: the directory of every recorded tool first, then the system directories. */
export function servicePath(config: FlowrynConfig): string {
  const dirs: string[] = [];
  for (const name of TOOL_NAMES) {
    const tool = resolveTool(config, name);
    if (tool && !dirs.includes(dirname(tool))) dirs.push(dirname(tool));
  }
  for (const dir of SYSTEM_PATH) if (!dirs.includes(dir)) dirs.push(dir);
  return dirs.join(":");
}

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface PlistSpec {
  label: string;
  program: string[];
  env: Record<string, string>;
  logDir: string;
  workingDir: string;
}

/**
 * The launchd agent (design section 15): absolute paths, an explicit PATH,
 * KeepAlive and log paths. KeepAlive restarts the daemon after a crash or a
 * kill, but not after a clean exit, so `flowryn daemon stop` stays stopped.
 * Flowryn rotates its own log; these files catch only crash output.
 */
export function renderPlist(spec: PlistSpec): string {
  const args = spec.program.map((a) => `    <string>${xml(a)}</string>`).join("\n");
  const env = Object.entries(spec.env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(spec.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(spec.workingDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(join(spec.logDir, "launchd.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(spec.logDir, "launchd.err.log"))}</string>
</dict>
</plist>
`;
}

export function plistSpecFor(config: FlowrynConfig, home: string): PlistSpec {
  const env: Record<string, string> = { PATH: servicePath(config), HOME: homedir() };
  if (home !== join(homedir(), ".flowryn")) env.FLOWRYN_HOME = home;
  return {
    label: serviceLabel(home),
    program: [...selfCommand(), "daemon", "run"],
    env,
    logDir: stateFiles(config.state_dir).logs,
    workingDir: config.state_dir,
  };
}

export interface LaunchctlResult {
  exitCode: number;
  output: string;
}

/** What loading and unloading the agent needs, injectable so tests can script launchctl's asynchronous bootout. */
export interface LaunchdDeps {
  launchctl(args: string[]): Promise<LaunchctlResult>;
  sleep(ms: number): Promise<void>;
  /** How long to wait for a bootout to finish before bootstrapping anyway. */
  unloadTimeoutMs: number;
  unloadPollMs: number;
  /** The waits between bootstrap attempts; its length is the number of retries. */
  bootstrapBackoffMs: number[];
}

async function launchctl(args: string[]): Promise<LaunchctlResult> {
  const proc = Bun.spawn(["/bin/launchctl", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, output: (stdout + stderr).trim() };
}

export const LAUNCHD_DEPS: LaunchdDeps = {
  launchctl,
  sleep: (ms) => Bun.sleep(ms),
  unloadTimeoutMs: 5_000,
  unloadPollMs: 100,
  bootstrapBackoffMs: [250, 500, 1_000, 2_000],
};

function domain(): string {
  return `gui/${userInfo().uid}`;
}

async function loaded(label: string, deps: LaunchdDeps): Promise<boolean> {
  return (await deps.launchctl(["print", `${domain()}/${label}`])).exitCode === 0;
}

export async function isLoaded(label: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  return loaded(label, LAUNCHD_DEPS);
}

/**
 * Boot the agent out and wait until launchd has actually unloaded it: bootout
 * returns before the service is gone, and a bootstrap in that window fails
 * with "5: Input/output error". Returns false when it was still loaded at the timeout.
 */
export async function unloadAgent(label: string, deps: LaunchdDeps = LAUNCHD_DEPS): Promise<boolean> {
  await deps.launchctl(["bootout", `${domain()}/${label}`]);
  for (let waited = 0; waited < deps.unloadTimeoutMs; waited += deps.unloadPollMs) {
    if (!(await loaded(label, deps))) return true;
    await deps.sleep(deps.unloadPollMs);
  }
  return !(await loaded(label, deps));
}

/** Bootstrap the plist, unloading any earlier copy first and retrying with a bounded backoff while launchd catches up. */
export async function loadAgent(label: string, path: string, deps: LaunchdDeps = LAUNCHD_DEPS): Promise<void> {
  if (await loaded(label, deps)) await unloadAgent(label, deps);
  const attempts = deps.bootstrapBackoffMs.length + 1;
  let last: LaunchctlResult = { exitCode: 0, output: "" };
  for (let attempt = 0; attempt < attempts; attempt++) {
    last = await deps.launchctl(["bootstrap", domain(), path]);
    if (last.exitCode === 0) return;
    const wait = deps.bootstrapBackoffMs[attempt];
    if (wait !== undefined) await deps.sleep(wait);
  }
  const stillLoaded = await loaded(label, deps);
  const hint = stillLoaded
    ? `; the previous agent ${label} is still loaded, so run flowryn daemon uninstall, then flowryn daemon install again`
    : `; check the plist with plutil -lint ${path} and launchctl print ${domain()}/${label}`;
  throw new Error(`launchctl bootstrap ${domain()} ${path} failed after ${attempts} attempts (exit ${last.exitCode}: ${last.output || "no output"})${hint}`);
}

/** Write the plist and (re)load it; launchd then starts the daemon (RunAtLoad). */
export async function installService(spec: PlistSpec, path: string): Promise<void> {
  if (process.platform !== "darwin") throw new Error("launchd service install is macOS only; on Linux use a systemd user unit (after v1)");
  ensureDir(spec.logDir, 0o700);
  ensureDir(dirname(path), 0o755);
  writeFileAtomic(path, renderPlist(spec), 0o644);
  const lint = Bun.spawnSync(["/usr/bin/plutil", "-lint", path]);
  if (lint.exitCode !== 0) throw new Error(`plutil rejected ${path}: ${lint.stdout.toString()}${lint.stderr.toString()}`);
  await loadAgent(spec.label, path);
}

/** Unload and remove the agent; a following install still retries if launchd has not finished the bootout. */
export async function uninstallService(label: string, path: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const wasLoaded = await isLoaded(label);
  if (wasLoaded) await unloadAgent(label);
  if (existsSync(path)) unlinkSync(path);
  return wasLoaded;
}

/** Start (or restart) an installed agent. */
export async function kickstart(label: string): Promise<boolean> {
  return (await launchctl(["kickstart", `${domain()}/${label}`])).exitCode === 0;
}
