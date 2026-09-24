import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** macOS limits a Unix socket path to 104 bytes including the terminator. */
export const MAX_SOCKET_PATH_BYTES = 103;

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Flowryn's fixed home, ~/.flowryn. FLOWRYN_HOME overrides it (tests, and a
 * second install side by side); it holds config.toml, run/ and the defaults
 * for the data and state directories.
 */
export function flowrynHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.FLOWRYN_HOME;
  if (override && override.length > 0) return resolve(expandHome(override));
  return join(homedir(), ".flowryn");
}

export function configPath(home: string = flowrynHome()): string {
  return join(home, "config.toml");
}

export function runDir(home: string = flowrynHome()): string {
  return join(home, "run");
}

/** The daemon socket: fixed and short. Workers get FLOWRYN_SOCK at launch. */
export function socketPath(home: string = flowrynHome(), env: NodeJS.ProcessEnv = process.env): string {
  const override = env.FLOWRYN_SOCK;
  if (override && override.length > 0) return expandHome(override);
  return join(runDir(home), "flowrynd.sock");
}

export function assertSocketPathFits(path: string): void {
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`socket path is ${Buffer.byteLength(path)} bytes, over the ${MAX_SOCKET_PATH_BYTES}-byte macOS limit: ${path}`);
  }
}

export function toAbsolute(path: string, base: string): string {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

export function stateFiles(stateDir: string) {
  return {
    db: join(stateDir, "flowryn.db"),
    lock: join(stateDir, "flowrynd.lock"),
    logs: join(stateDir, "logs"),
    backups: join(stateDir, "backups"),
  };
}

export function spoolDir(dataDir: string): string {
  return join(dataDir, "spool");
}
