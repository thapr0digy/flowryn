import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { configProblems, defaultConfig, loadConfig, TOOL_BINARIES, TOOL_NAMES, type FlowrynConfig, type ToolName } from "../config/config.ts";
import { configPath, flowrynHome, runDir, toAbsolute } from "../config/paths.ts";
import { renderConfig } from "../config/toml.ts";
import { ensureDir, writeFileAtomic } from "../util/fsx.ts";
import { PINNED_TASKS_AXI } from "../version.ts";

/** How to install each tool; init prints these and installs nothing itself. */
export const INSTALL_HINTS: Record<ToolName, string> = {
  tasks_axi: `npm install -g tasks-axi@${PINNED_TASKS_AXI}`,
  node: "brew install node",
  git: "xcode-select --install",
  gh: "brew install gh, then gh auth login",
  herdr: "install Herdr 0.7.5 or newer (protocol 17); needed from M2",
  claude: "npm install -g @anthropic-ai/claude-code",
  pi: "npm install -g @earendil-works/pi-coding-agent",
  no_mistakes: "install no-mistakes (optional; the no-mistakes delivery mode needs it)",
};

/** Defaults for the sections later milestones read; written once so they are there to edit. */
export const LATER_SECTION_DEFAULTS: Record<string, unknown> = {
  workers: {
    claude: { model: "opus", effort: "high", permission_mode: "bypass" },
    pi: { effort: "medium" },
  },
  style: { terse: true },
  capacity: { worker: 20, validation: 5, docker_env: 5, browser: 5, host: { min_free_mem_gb: 8, max_load_per_core: 1.5 } },
  autonomy: { default: "plan" },
  notify: { min_interval_min: 30, p0_coalesce_s: 60, max_triggered_turns_per_hour: 3 },
};

export interface InitIo {
  print(line: string): void;
  ask(question: string, fallback: string): Promise<string>;
  confirm(question: string, fallback: boolean): Promise<boolean>;
}

export interface InitDeps {
  env: NodeJS.ProcessEnv;
  io: InitIo;
  which(binary: string): string | null;
  /** `<tool> --version`, first line, or null. */
  version(path: string): Promise<string | null>;
  /** Prove tasks-axi can read a file; returns its task count or throws. */
  listTasks(tasksAxi: string, node: string | null, file: string): Promise<number>;
  installService(config: FlowrynConfig, home: string): Promise<string>;
  /** Register a project through the running daemon; returns the reply text. */
  addProject(path: string): Promise<string>;
  doctor(): Promise<string>;
  platform: NodeJS.Platform;
}

/**
 * Resolve a tool's symlinks, as section 15 asks, except into a versioned
 * Homebrew Cellar: that path breaks on the next `brew upgrade`, so the stable
 * link in the Homebrew bin directory is kept instead.
 */
export function recordedToolPath(found: string): string {
  try {
    const real = realpathSync(found);
    return real.includes(`${sep}Cellar${sep}`) ? found : real;
  } catch {
    return found;
  }
}

function writableTarget(path: string): boolean {
  let probe = existsSync(path) ? path : dirname(path);
  while (!existsSync(probe)) probe = dirname(probe);
  try {
    accessSync(probe, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function askPath(io: InitIo, question: string, fallback: string, home: string): Promise<string> {
  return toAbsolute((await io.ask(question, fallback)).trim() || fallback, home);
}

/**
 * `flowryn init` (design section 15): detect first, ask, and write nothing
 * until you confirm. Re-running it starts from the current answers.
 */
export async function runInit(deps: InitDeps): Promise<number> {
  const { io } = deps;
  const home = flowrynHome(deps.env);
  const loaded = (() => {
    try {
      return loadConfig(home);
    } catch (error) {
      io.print(`existing config ignored: ${(error as Error).message}`);
      return { config: defaultConfig(home), path: configPath(home), exists: false };
    }
  })();
  const current = loaded.config;
  io.print(loaded.exists ? `Updating ${loaded.path}. Enter keeps the current answer.` : `Setting up Flowryn in ${home}. Nothing is written until you confirm.`);

  // 1. Preflight
  if (deps.platform !== "darwin") io.print(`warning: macOS is the v1 platform; this is ${deps.platform}`);
  const tools: Partial<Record<ToolName, string>> = {};
  io.print("Tools:");
  for (const name of TOOL_NAMES) {
    const found = current.tools[name] && existsSync(current.tools[name]!) ? current.tools[name]! : deps.which(TOOL_BINARIES[name]);
    if (!found) {
      io.print(`  ${name}: missing. Install: ${INSTALL_HINTS[name]}`);
      continue;
    }
    const recorded = recordedToolPath(found);
    tools[name] = recorded;
    const version = await deps.version(recorded);
    io.print(`  ${name}: ${recorded}${version ? ` (${version})` : ""}`);
  }
  if (!tools.tasks_axi) {
    io.print(`tasks-axi is required. Install it (${INSTALL_HINTS.tasks_axi}) and re-run flowryn init.`);
    return 1;
  }
  const tasksAxiVersion = await deps.version(tools.tasks_axi);
  if (tasksAxiVersion && !tasksAxiVersion.includes(PINNED_TASKS_AXI)) {
    io.print(`warning: tasks-axi ${tasksAxiVersion}; Flowryn's journal was verified against ${PINNED_TASKS_AXI}`);
  }

  // 2-3. Directories
  const dataDir = await askPath(io, "Data directory (reports, spool, artifacts)", current.data_dir, home);
  let stateDir = "";
  for (let attempt = 0; attempt < 3 && !stateDir; attempt++) {
    const candidate = await askPath(io, "State directory (flowryn.db, lock, logs; not a synced folder)", current.state_dir, home);
    const problem = configProblems({ ...current, state_dir: candidate, data_dir: dataDir }).find((p) => p.level === "error" && p.message.startsWith("state_dir"));
    if (problem) io.print(`refused: ${problem.message}`);
    else stateDir = candidate;
  }
  if (!stateDir) {
    io.print("no usable state directory; nothing was written");
    return 1;
  }

  // 4. tasks-axi files
  const sameDataDir = dataDir === current.data_dir;
  const backlog = await askPath(io, "Backlog file (tasks)", sameDataDir ? current.tasks.backlog : join(dataDir, "backlog.md"), home);
  const todos = await askPath(io, "To-do file (personal to-dos)", sameDataDir ? current.tasks.todos : join(dataDir, "todos.md"), home);
  for (const [label, file] of [["backlog", backlog], ["todos", todos]] as const) {
    if (!writableTarget(file)) {
      io.print(`refused: ${label} file ${file} is not writable; nothing was written`);
      return 1;
    }
    if (existsSync(file)) {
      try {
        const count = await deps.listTasks(tools.tasks_axi, tools.node ?? null, file);
        io.print(`  ${label}: adopting ${file} (${count} tasks)`);
      } catch (error) {
        io.print(`refused: tasks-axi cannot read ${file}: ${(error as Error).message}`);
        return 1;
      }
    } else io.print(`  ${label}: ${file} (created on first write)`);
  }

  // 6. Morning briefing hour (the briefing itself arrives in M3)
  const hourText = await io.ask("Morning briefing hour (0-23)", String(current.morning_hour));
  const morningHour = Number(hourText);
  if (!Number.isInteger(morningHour) || morningHour < 0 || morningHour > 23) {
    io.print(`refused: ${hourText} is not an hour from 0 to 23; nothing was written`);
    return 1;
  }

  const config: FlowrynConfig = {
    home,
    data_dir: dataDir,
    state_dir: stateDir,
    morning_hour: morningHour,
    tasks: { backlog, todos },
    tools,
    extra: { ...LATER_SECTION_DEFAULTS, ...current.extra },
  };
  for (const problem of configProblems(config)) io.print(`${problem.level}: ${problem.message}`);
  if (configProblems(config).some((p) => p.level === "error")) {
    io.print("nothing was written");
    return 1;
  }

  const text = renderConfig(config);
  io.print(`\n${loaded.path}:\n${text}`);
  if (!(await io.confirm(`Write ${loaded.path} and create the directories?`, true))) {
    io.print("nothing was written");
    return 1;
  }
  ensureDir(home, 0o700);
  ensureDir(runDir(home), 0o700);
  ensureDir(dataDir, 0o700);
  ensureDir(stateDir, 0o700);
  writeFileAtomic(loaded.path, text, 0o600);
  io.print(`wrote ${loaded.path}`);

  // 8. Service, then projects, then doctor
  let daemonUp = false;
  if (deps.platform === "darwin" && (await io.confirm("Install the launchd agent and start the daemon?", true))) {
    try {
      io.print(await deps.installService(config, home));
      daemonUp = true;
    } catch (error) {
      io.print(`service install failed: ${(error as Error).message}`);
    }
  } else io.print("Start the daemon later with: flowryn daemon start (or flowryn daemon install)");

  if (daemonUp) {
    for (;;) {
      const path = (await io.ask("Add a project: path of its primary checkout (blank to finish)", "")).trim();
      if (!path) break;
      io.print(await deps.addProject(toAbsolute(path, process.cwd())));
    }
  }
  io.print(await deps.doctor());
  return 0;
}
