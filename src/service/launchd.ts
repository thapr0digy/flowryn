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

async function launchctl(args: string[]): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(["/bin/launchctl", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, output: (stdout + stderr).trim() };
}

function domain(): string {
  return `gui/${userInfo().uid}`;
}

export async function isLoaded(label: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  return (await launchctl(["print", `${domain()}/${label}`])).exitCode === 0;
}

/** Write the plist and (re)load it; launchd then starts the daemon (RunAtLoad). */
export async function installService(spec: PlistSpec, path: string): Promise<void> {
  if (process.platform !== "darwin") throw new Error("launchd service install is macOS only; on Linux use a systemd user unit (after v1)");
  ensureDir(spec.logDir, 0o700);
  ensureDir(dirname(path), 0o755);
  writeFileAtomic(path, renderPlist(spec), 0o644);
  const lint = Bun.spawnSync(["/usr/bin/plutil", "-lint", path]);
  if (lint.exitCode !== 0) throw new Error(`plutil rejected ${path}: ${lint.stdout.toString()}${lint.stderr.toString()}`);
  if (await isLoaded(spec.label)) await launchctl(["bootout", `${domain()}/${spec.label}`]);
  const boot = await launchctl(["bootstrap", domain(), path]);
  if (boot.exitCode !== 0) throw new Error(`launchctl bootstrap failed: ${boot.output}`);
}

export async function uninstallService(label: string, path: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const loaded = await isLoaded(label);
  if (loaded) await launchctl(["bootout", `${domain()}/${label}`]);
  if (existsSync(path)) unlinkSync(path);
  return loaded;
}

/** Start (or restart) an installed agent. */
export async function kickstart(label: string): Promise<boolean> {
  return (await launchctl(["kickstart", `${domain()}/${label}`])).exitCode === 0;
}
