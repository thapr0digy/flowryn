import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { configPath, flowrynHome, toAbsolute } from "./paths.ts";
import { FlowrynError } from "../api/errors.ts";

export const TOOL_NAMES = ["tasks_axi", "node", "git", "gh", "herdr", "claude", "pi", "no_mistakes"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Executable names on PATH for each tool key in [tools]. */
export const TOOL_BINARIES: Record<ToolName, string> = {
  tasks_axi: "tasks-axi",
  node: "node",
  git: "git",
  gh: "gh",
  herdr: "herdr",
  claude: "claude",
  pi: "pi",
  no_mistakes: "no-mistakes",
};

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

/** Resolve symlinks on the longest existing prefix, so a symlink into iCloud is still caught. */
function realishPath(path: string): string {
  let probe = path;
  const suffix: string[] = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return path;
    suffix.unshift(probe.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    probe = parent;
  }
  try {
    return join(realpathSync(probe), ...suffix);
  } catch {
    return path;
  }
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Folders a sync client may manage. SQLite WAL there risks corruption (design section 15). */
export function syncedFolderOf(path: string, home: string = homedir()): string | null {
  const real = realishPath(path);
  const roots = [
    join(home, "Library", "Mobile Documents"),
    join(home, "Library", "CloudStorage"),
    join(home, "Dropbox"),
    join(home, "Google Drive"),
    join(home, "OneDrive"),
    join(home, "Documents"),
    join(home, "Desktop"),
  ];
  for (const root of roots) {
    if (isUnder(real, root) || isUnder(path, root)) return root;
  }
  return null;
}

/** Folders where a background binary triggers macOS privacy prompts. */
export function privacyFolderOf(path: string, home: string = homedir()): string | null {
  const real = realishPath(path);
  const roots = [join(home, "Documents"), join(home, "Desktop"), join(home, "Downloads"), join(home, "Library", "Mobile Documents")];
  for (const root of roots) {
    if (isUnder(real, root) || isUnder(path, root)) return root;
  }
  return null;
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
  return Bun.which(TOOL_BINARIES[name]);
}
