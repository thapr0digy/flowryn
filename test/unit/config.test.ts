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

describe("known sections", () => {
  function refusal(text: string): string {
    try {
      parseConfig(text, HOME);
    } catch (error) {
      expect(error).toBeInstanceOf(FlowrynError);
      expect((error as FlowrynError).code).toBe("config_invalid");
      return (error as Error).message;
    }
    throw new Error("parseConfig accepted the text");
  }

  test("a misspelled section is refused with the section it most likely meant", () => {
    expect(refusal("[notfiy]\nmacos = false\n")).toBe("[notfiy] is not a known section; did you mean [notify]?");
  });

  test("a misspelled dynamic parent is refused too: [workflow.fix] suggests [workflows]", () => {
    expect(refusal('[workflow.fix]\nstages = [{ id = "ship", gate = "merge" }]\n')).toBe("[workflow] is not a known section; did you mean [workflows]?");
  });

  test("a top-level key far from any known name is refused without a guess, and lists the known sections", () => {
    const message = refusal("[zzzzzzzz]\nx = 1\n");
    expect(message).toStartWith("[zzzzzzzz] is not a known section; known sections: ");
    expect(message).not.toContain("did you mean");
    expect(message).toContain("notify");
    expect(message).toContain("projects");
  });

  test("a misspelled top-level key such as morning_hours suggests morning_hour", () => {
    expect(refusal("morning_hours = 6\n")).toBe("morning_hours is not a known setting; did you mean morning_hour?");
  });

  test("a config.toml-shaped file with comments, every registered section and dynamic project and workflow names still parses", () => {
    const text = `# Flowryn configuration, written by \`flowryn init\`.
data_dir = "/x/data" # trailing comment
state_dir = "/x/state"
morning_hour = 5

[tasks]
backlog = "/x/data/backlog.md"
todos = "/x/data/todos.md"

[tools]
tasks_axi = "/bin/tasks-axi"

[workers.claude]
model = "opus"

[workers.pi]
effort = "medium"

[style]
terse = true

[capacity]
worker = 20
validation = 5

[capacity.host]
min_free_mem_gb = 8

[autonomy]
default = "plan"

[notify]
macos = true

# custom workflows keep any id
[workflows.feature-ui-2]
stages = [{ id = "build" }, { id = "ship", pools = ["validation"], gate = "merge" }]

[workflows.quick]
stages = [{ id = "ship", gate = "merge" }]

[projects.web-app]
verify = ["bun test"]

[projects.another_one]
verify_timeout_min = 10

[policy]
mode = "strict"

[herdr]
[reconcile]
[leader]
[away]
[grants]
[review]
[github]
[cleanup]
[daemon]
[upkeep]
[validation]
[sched]
[decisions]
`;
    const config = parseConfig(text, HOME);
    expect(Object.keys((config.extra.workflows as Record<string, unknown>) ?? {})).toEqual(["feature-ui-2", "quick"]);
    expect(Object.keys((config.extra.projects as Record<string, unknown>) ?? {})).toEqual(["web-app", "another_one"]);
    expect(config.extra.notify).toEqual({ macos: true });
  });

  test("every section init writes is registered, so a fresh init config always loads", () => {
    const text = renderConfig({ ...defaultConfig(HOME), extra: LATER_SECTION_DEFAULTS });
    expect(() => parseConfig(text, HOME)).not.toThrow();
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
