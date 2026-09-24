import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { configPath, flowrynHome, toAbsolute } from "./paths.ts";
import { FlowrynError } from "../api/errors.ts";

export const TOOL_NAMES = ["tasks_axi", "node", "git", "gh", "herdr", "claude", "pi", "no_mistakes"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * Executable names on PATH for each tool key in [tools], in lookup order. Pi
 * also ships as `pi-signed` (the signed Pi Launcher build), which a shell alias
 * usually maps to `pi`; aliases are invisible to a PATH lookup.
 */
export const TOOL_BINARIES: Record<ToolName, readonly string[]> = {
  tasks_axi: ["tasks-axi"],
  node: ["node"],
  git: ["git"],
  gh: ["gh"],
  herdr: ["herdr"],
  claude: ["claude"],
  pi: ["pi", "pi-signed"],
  no_mistakes: ["no-mistakes"],
};

/** First executable on PATH among a tool's names. */
export function whichTool(name: ToolName, which: (binary: string) => string | null = Bun.which): string | null {
  for (const binary of TOOL_BINARIES[name]) {
    const found = which(binary);
    if (found) return found;
  }
  return null;
}

export interface FlowrynConfig {
  home: string;
  data_dir: string;
  state_dir: string;
  morning_hour: number;
  tasks: { backlog: string; todos: string };
  tools: Partial<Record<ToolName, string>>;
  /** Sections owned by later milestones ([workers.*], [capacity], [notify], ...), kept verbatim. */
  extra: Record<string, unknown>;
}

export interface LoadedConfig {
  config: FlowrynConfig;
  path: string;
  exists: boolean;
}

const KNOWN_TOP_LEVEL = new Set(["data_dir", "state_dir", "morning_hour", "tasks", "tools"]);

export function defaultConfig(home: string = flowrynHome()): FlowrynConfig {
  const dataDir = join(home, "data");
  return {
    home,
    data_dir: dataDir,
    state_dir: join(home, "state"),
    morning_hour: 5,
    tasks: { backlog: join(dataDir, "backlog.md"), todos: join(dataDir, "todos.md") },
    tools: {},
    extra: {},
  };
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FlowrynError("config_invalid", `${where} must be a table`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new FlowrynError("config_invalid", `${where} must be a non-empty string`);
  return value;
}

/** Parse config text into a full config; relative paths resolve against the Flowryn home. */
export function parseConfig(text: string, home: string): FlowrynConfig {
  let raw: Record<string, unknown>;
  try {
    raw = Bun.TOML.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new FlowrynError("config_invalid", `config.toml is not valid TOML: ${(error as Error).message}`);
  }
  const defaults = defaultConfig(home);
  const dataDir = toAbsolute(asString(raw.data_dir, "data_dir") ?? defaults.data_dir, home);
  const stateDir = toAbsolute(asString(raw.state_dir, "state_dir") ?? defaults.state_dir, home);
  const tasks = asRecord(raw.tasks, "[tasks]");
  const tools = asRecord(raw.tools, "[tools]");

  const morningHour = raw.morning_hour ?? defaults.morning_hour;
  if (typeof morningHour !== "number" || !Number.isInteger(morningHour) || morningHour < 0 || morningHour > 23) {
    throw new FlowrynError("config_invalid", "morning_hour must be an integer from 0 to 23");
  }

  const parsedTools: Partial<Record<ToolName, string>> = {};
  for (const [key, value] of Object.entries(tools)) {
    if (!(TOOL_NAMES as readonly string[]).includes(key)) {
      throw new FlowrynError("config_invalid", `[tools] ${key} is not a known tool (${TOOL_NAMES.join(", ")})`);
    }
    parsedTools[key as ToolName] = toAbsolute(asString(value, `[tools] ${key}`)!, home);
  }

  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_TOP_LEVEL.has(key)) extra[key] = value;
  }

  const config: FlowrynConfig = {
    home,
    data_dir: dataDir,
    state_dir: stateDir,
    morning_hour: morningHour,
    tasks: {
      backlog: toAbsolute(asString(tasks.backlog, "[tasks] backlog") ?? join(dataDir, "backlog.md"), home),
      todos: toAbsolute(asString(tasks.todos, "[tasks] todos") ?? join(dataDir, "todos.md"), home),
    },
    tools: parsedTools,
    extra,
  };
  const problems = configProblems(config).filter((p) => p.level === "error");
  if (problems.length > 0) throw new FlowrynError("config_invalid", problems.map((p) => p.message).join("; "));
  return config;
}

export function loadConfig(home: string = flowrynHome()): LoadedConfig {
  const path = configPath(home);
  if (!existsSync(path)) return { config: defaultConfig(home), path, exists: false };
  return { config: parseConfig(readFileSync(path, "utf8"), home), path, exists: true };
}

export interface ConfigProblem {
  level: "error" | "warn";
  message: string;
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function protectedRootOf(path: string, roots: readonly string[]): string | null {
  return roots.find((root) => isUnder(path, root)) ?? null;
}

const MAX_SYMLINK_HOPS = 40;

/** Folders macOS guards with privacy (TCC) or File Provider; nothing at or inside them is ever opened here. */
function guardedRoots(home: string): string[] {
  return ["Documents", "Desktop", "Downloads", join("Library", "Mobile Documents"), join("Library", "CloudStorage")].map((dir) => join(home, dir));
}

/**
 * Resolve symlinks one component at a time with lstat/readlink, so a symlink
 * into iCloud is still caught. It stops as soon as the partial path reaches a
 * protected root: on macOS, opening or stat-ing a TCC-protected folder (iCloud,
 * Documents, Desktop, CloudStorage) from a launchd-descended process can block
 * forever on an invisible privacy prompt, and realpath opens the path.
 */
function resolveTowardRoots(path: string, roots: readonly string[]): string {
  let resolved = sep;
  const pending = path.split(sep).filter(Boolean);
  let hops = 0;
  while (pending.length > 0) {
    const part = pending.shift()!;
    if (part === ".") continue;
    if (part === "..") {
      resolved = dirname(resolved);
      continue;
    }
    const next = join(resolved, part);
    if (protectedRootOf(next, roots)) return join(next, ...pending);
    let isLink: boolean;
    try {
      isLink = lstatSync(next).isSymbolicLink();
    } catch {
      return join(next, ...pending);
    }
    if (!isLink) {
      resolved = next;
      continue;
    }
    if (++hops > MAX_SYMLINK_HOPS) return path;
    let target: string;
    try {
      target = readlinkSync(next);
    } catch {
      return path;
    }
    if (isAbsolute(target)) resolved = sep;
    pending.unshift(...target.split(sep).filter(Boolean));
  }
  return resolved;
}

/** The protected root a path is under, literally or through symlinks; never touches the root itself. */
function folderUnder(path: string, roots: readonly string[], home: string): string | null {
  return protectedRootOf(path, roots) ?? protectedRootOf(resolveTowardRoots(path, [...roots, ...guardedRoots(home)]), roots);
}

/** Folders a sync client may manage. SQLite WAL there risks corruption (design section 15). */
export function syncedFolderOf(path: string, home: string = homedir()): string | null {
  return folderUnder(path, [
    join(home, "Library", "Mobile Documents"),
    join(home, "Library", "CloudStorage"),
    join(home, "Dropbox"),
    join(home, "Google Drive"),
    join(home, "OneDrive"),
    join(home, "Documents"),
    join(home, "Desktop"),
  ], home);
}

/** Folders where a background binary triggers macOS privacy prompts. */
export function privacyFolderOf(path: string, home: string = homedir()): string | null {
  return folderUnder(path, [join(home, "Documents"), join(home, "Desktop"), join(home, "Downloads"), join(home, "Library", "Mobile Documents")], home);
}

export function configProblems(config: FlowrynConfig, home: string = homedir()): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const synced = syncedFolderOf(config.state_dir, home);
  if (synced) {
    problems.push({
      level: "error",
      message: `state_dir ${config.state_dir} is under ${synced}, a synced folder; SQLite WAL there risks corruption`,
    });
  }
  const privacy = privacyFolderOf(config.data_dir, home);
  if (privacy) {
    problems.push({
      level: "warn",
      message: `data_dir ${config.data_dir} is under ${privacy}; macOS may show privacy prompts for a background binary`,
    });
  }
  if (config.tasks.backlog === config.tasks.todos) {
    problems.push({ level: "error", message: "[tasks] backlog and todos must be different files" });
  }
  const nvm = config.tools.tasks_axi && config.tools.tasks_axi.includes(`${sep}.nvm${sep}`);
  if (nvm) {
    problems.push({
      level: "warn",
      message: `tasks-axi is under an nvm directory (${config.tools.tasks_axi}); it breaks on the next Node upgrade`,
    });
  }
  return problems;
}

/** Absolute path of a tool: the configured one, else a PATH lookup (doctor flags the latter). */
export function resolveTool(config: FlowrynConfig, name: ToolName): string | null {
  const configured = config.tools[name];
  if (configured) return configured;
  return whichTool(name);
}
