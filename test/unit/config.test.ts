import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { configProblems, defaultConfig, parseConfig, privacyFolderOf, syncedFolderOf } from "../../src/config/config.ts";
import { renderConfig, renderToml } from "../../src/config/toml.ts";
import { assertSocketPathFits, flowrynHome, socketPath } from "../../src/config/paths.ts";
import { FlowrynError } from "../../src/api/errors.ts";
import { LATER_SECTION_DEFAULTS, recordedToolPath } from "../../src/init/init.ts";

const HOME = "/tmp/fw-home";

describe("config", () => {
  test("defaults live under the Flowryn home", () => {
    const config = defaultConfig(HOME);
    expect(config.data_dir).toBe(`${HOME}/data`);
    expect(config.state_dir).toBe(`${HOME}/state`);
    expect(config.tasks).toEqual({ backlog: `${HOME}/data/backlog.md`, todos: `${HOME}/data/todos.md` });
    expect(config.morning_hour).toBe(5);
  });

  test("parses paths, expands ~ and keeps later sections verbatim", () => {
    const config = parseConfig(
      `data_dir = "~/fw-data"\nstate_dir = "state2"\nmorning_hour = 6\n[tasks]\nbacklog = "/x/backlog.md"\n[tools]\ntasks_axi = "/bin/tasks-axi"\n[capacity]\nworker = 20\n`,
      HOME,
    );
    expect(config.data_dir).toBe(join(homedir(), "fw-data"));
    expect(config.state_dir).toBe(`${HOME}/state2`);
    expect(config.tasks.backlog).toBe("/x/backlog.md");
    expect(config.tasks.todos).toBe(join(homedir(), "fw-data", "todos.md"));
    expect(config.tools.tasks_axi).toBe("/bin/tasks-axi");
    expect(config.extra).toEqual({ capacity: { worker: 20 } });
  });

  test("rejects bad values with config_invalid", () => {
    const bad = ["morning_hour = 24", "[tools]\nnot_a_tool = \"/x\"", "data_dir = 3", "not toml ==="];
    for (const text of bad) {
      expect(() => parseConfig(text, HOME)).toThrow(FlowrynError);
    }
  });

  test("refuses a state directory in a synced folder, warns for a data directory in Documents", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "fw-fakehome-")));
    try {
      expect(syncedFolderOf(join(home, "Library/Mobile Documents/com~apple~CloudDocs/fw"), home)).not.toBeNull();
      expect(syncedFolderOf(join(home, "Dropbox/fw"), home)).not.toBeNull();
      expect(syncedFolderOf(join(home, ".flowryn/state"), home)).toBeNull();
      expect(privacyFolderOf(join(home, "Documents/fw"), home)).not.toBeNull();
      const config = { ...defaultConfig(HOME), state_dir: join(home, "Documents/fw-state"), data_dir: join(home, "Desktop/fw") };
      const problems = configProblems(config, home);
      expect(problems.find((p) => p.level === "error")?.message).toContain("synced folder");
      expect(problems.find((p) => p.level === "warn")?.message).toContain("privacy");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    // Matched literally against the real home, so the check never touches ~/Documents.
    expect(() => parseConfig(`state_dir = ${JSON.stringify(join(homedir(), "Documents/fw-state"))}`, HOME)).toThrow("synced folder");
  });

  test("a symlink into a synced folder is still refused", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "fw-fakehome-")));
    try {
      const iCloud = join(home, "Library", "Mobile Documents");
      mkdirSync(join(home, "links"), { recursive: true });
      mkdirSync(join(home, "plain"));
      symlinkSync(join(iCloud, "x"), join(home, "links", "absolute"));
      symlinkSync(join("..", "Library", "Mobile Documents", "x"), join(home, "links", "relative"));
      symlinkSync(join(home, "plain"), join(home, "links", "safe"));
      expect(syncedFolderOf(join(home, "links", "absolute", "state"), home)).toBe(iCloud);
      expect(syncedFolderOf(join(home, "links", "relative", "state"), home)).toBe(iCloud);
      expect(privacyFolderOf(join(home, "links", "absolute"), home)).toBe(iCloud);
      expect(syncedFolderOf(join(home, "links", "safe", "state"), home)).toBeNull();
      expect(configProblems({ ...defaultConfig(HOME), state_dir: join(home, "links", "absolute") }, home).some((p) => p.level === "error")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("flags tasks-axi under nvm", () => {
    const config = { ...defaultConfig(HOME), tools: { tasks_axi: "/Users/me/.nvm/versions/node/v22/bin/tasks-axi" } };
    expect(configProblems(config).some((p) => p.message.includes("nvm"))).toBe(true);
  });

  test("the backlog and to-do files must differ", () => {
    expect(() => parseConfig('[tasks]\nbacklog = "/x/a.md"\ntodos = "/x/a.md"\n', HOME)).toThrow("different files");
  });

  test("renderConfig round-trips through the parser", () => {
    const config = { ...defaultConfig(HOME), morning_hour: 7, tools: { tasks_axi: "/opt/tasks-axi", git: "/usr/bin/git" }, extra: { ...LATER_SECTION_DEFAULTS } };
    const text = renderConfig(config);
    const parsed = parseConfig(text, HOME);
    expect(parsed).toEqual(config);
    expect(text).toContain("[capacity.host]");
  });

  test("renderToml writes inline tables inside arrays", () => {
    const text = renderToml({ workflows: { fix: { stages: [{ id: "build" }, { id: "ship", pools: ["validation"], gate: "merge" }] } } });
    expect(Bun.TOML.parse(text)).toEqual({ workflows: { fix: { stages: [{ id: "build" }, { id: "ship", pools: ["validation"], gate: "merge" }] } } });
  });
});

describe("paths", () => {
  test("FLOWRYN_HOME and FLOWRYN_SOCK override the fixed locations", () => {
    expect(flowrynHome({ FLOWRYN_HOME: "/tmp/x" })).toBe("/tmp/x");
    expect(flowrynHome({})).toBe(join(homedir(), ".flowryn"));
    expect(socketPath("/tmp/x", {})).toBe("/tmp/x/run/flowrynd.sock");
    expect(socketPath("/tmp/x", { FLOWRYN_SOCK: "/tmp/s.sock" })).toBe("/tmp/s.sock");
  });

  test("refuses socket paths over the macOS limit", () => {
    expect(() => assertSocketPathFits("/tmp/" + "x".repeat(120))).toThrow("macOS limit");
    expect(() => assertSocketPathFits(join(homedir(), ".flowryn/run/flowrynd.sock"))).not.toThrow();
  });

  test("init resolves tool symlinks but keeps a stable link into a versioned directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "fw-tools-"));
    try {
      mkdirSync(join(dir, "Cellar", "gh", "2.93.0", "bin"), { recursive: true });
      mkdirSync(join(dir, "bin"));
      mkdirSync(join(dir, "real"));
      writeFileSync(join(dir, "Cellar", "gh", "2.93.0", "bin", "gh"), "");
      writeFileSync(join(dir, "real", "git"), "");
      symlinkSync(join(dir, "Cellar", "gh", "2.93.0", "bin", "gh"), join(dir, "bin", "gh"));
      symlinkSync(join(dir, "real", "git"), join(dir, "bin", "git"));
      expect(recordedToolPath(join(dir, "bin", "gh"))).toBe(join(dir, "bin", "gh"));
      expect(recordedToolPath(join(dir, "bin", "git"))).toBe(realpathSync(join(dir, "real", "git")));
      expect(recordedToolPath("/definitely/not/here")).toBe("/definitely/not/here");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
