import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, defaultConfig } from "../../src/config/config.ts";
import { migrate, openDb, schemaVersion, LATEST_SCHEMA_VERSION } from "../../src/db/db.ts";
import { backupIfDue } from "../../src/db/backup.ts";
import { restoreBackup } from "../../src/doctor/doctor.ts";
import { runInit, type InitDeps } from "../../src/init/init.ts";
import { renderPlist, plistSpecFor, serviceLabel, BASE_LABEL } from "../../src/service/launchd.ts";
import { stateFiles } from "../../src/config/paths.ts";
import { tryExclusiveLock } from "../../src/util/flock.ts";
import { homedir } from "node:os";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fw-setup-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("launchd agent", () => {
  test("has absolute program args, an explicit PATH, KeepAlive on crash only, and log paths", () => {
    const home = tempDir();
    const config = { ...defaultConfig(home), tools: { tasks_axi: "/opt/tools/bin/tasks-axi", node: "/opt/node/bin/node" } };
    const spec = plistSpecFor(config, home);
    expect(spec.label).toStartWith(`${BASE_LABEL}.`);
    expect(spec.program.slice(-2)).toEqual(["daemon", "run"]);
    expect(spec.program[0]).toStartWith("/");
    expect(spec.env.PATH!.split(":").slice(0, 2)).toEqual(["/opt/tools/bin", "/opt/node/bin"]);
    expect(spec.env.FLOWRYN_HOME).toBe(home);
    const xml = renderPlist(spec);
    expect(xml).toContain("<key>SuccessfulExit</key>\n    <false/>");
    expect(xml).toContain(join(config.state_dir, "logs", "launchd.err.log"));
    if (process.platform === "darwin") {
      const path = join(home, "agent.plist");
      writeFileSync(path, xml);
      const lint = Bun.spawnSync(["/usr/bin/plutil", "-lint", path]);
      expect(lint.exitCode).toBe(0);
    }
  });

  test("the default home uses the base label; others get their own", () => {
    expect(serviceLabel(join(homedir(), ".flowryn"))).toBe(BASE_LABEL);
    expect(serviceLabel("/tmp/other")).not.toBe(BASE_LABEL);
  });
});

function scriptedIo(answers: Record<string, string>, confirms: Record<string, boolean>) {
  const printed: string[] = [];
  return {
    printed,
    io: {
      print: (line: string) => printed.push(line),
      ask: async (question: string, fallback: string) => {
        const key = Object.keys(answers).find((k) => question.startsWith(k));
        return key ? answers[key]! : fallback;
      },
      confirm: async (question: string, fallback: boolean) => {
        const key = Object.keys(confirms).find((k) => question.startsWith(k));
        return key ? confirms[key]! : fallback;
      },
    },
  };
}

function initDeps(home: string, io: InitDeps["io"], overrides: Partial<InitDeps> = {}): InitDeps {
  return {
    env: { FLOWRYN_HOME: home },
    io,
    platform: "darwin",
    which: (binary) => (binary === "tasks-axi" ? "/opt/bin/tasks-axi" : binary === "git" ? "/usr/bin/git" : null),
    version: async (path) => (path.endsWith("tasks-axi") ? "0.2.5" : "1.0"),
    listTasks: async () => 3,
    installService: async () => "installed",
    addProject: async (path) => `project: ${path}`,
    doctor: async () => "doctor ran",
    ...overrides,
  };
}

function signedPiOnly(binary: string): string | null {
  if (binary === "tasks-axi") return "/opt/bin/tasks-axi";
  return binary === "pi-signed" ? "/nonexistent/bin/pi-signed" : null;
}

describe("init", () => {
  test("writes nothing when you decline", async () => {
    const home = tempDir();
    const { io, printed } = scriptedIo({}, { Write: false });
    expect(await runInit(initDeps(home, io))).toBe(1);
    expect(existsSync(join(home, "config.toml"))).toBe(false);
    expect(printed.at(-1)).toBe("nothing was written");
  });

  test("records tool paths, the data and state directories and the tasks-axi files", async () => {
    const home = tempDir();
    const data = join(home, "d");
    const { io } = scriptedIo({ "Data directory": data, "Morning briefing hour": "6", "Add a project": "" }, { Write: true, Install: false });
    expect(await runInit(initDeps(home, io))).toBe(0);
    const { config, exists } = loadConfig(home);
    expect(exists).toBe(true);
    expect(config).toMatchObject({ data_dir: data, morning_hour: 6, tasks: { backlog: join(data, "backlog.md"), todos: join(data, "todos.md") } });
    expect(config.tools).toEqual({ tasks_axi: "/opt/bin/tasks-axi", git: "/usr/bin/git" });
    expect(config.extra.capacity).toBeDefined();
    expect(statSync(join(home, "config.toml")).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "run")).mode & 0o777).toBe(0o700);
  });

  test("refuses a synced state directory and re-asks", async () => {
    const home = tempDir();
    let asked = 0;
    const { io, printed } = scriptedIo({}, { Write: true, Install: false });
    const deps = initDeps(home, {
      ...io,
      ask: async (question, fallback) => {
        if (question.startsWith("State directory")) {
          asked++;
          return asked === 1 ? join(homedir(), "Library/Mobile Documents/fw-state") : join(home, "state-ok");
        }
        return question.startsWith("Add a project") ? "" : fallback;
      },
    });
    expect(await runInit(deps)).toBe(0);
    expect(asked).toBe(2);
    expect(printed.some((l) => l.startsWith("refused: state_dir"))).toBe(true);
    expect(loadConfig(home).config.state_dir).toBe(join(home, "state-ok"));
  });

  test("finds Pi under its signed launcher name when there is no pi on PATH", async () => {
    const home = tempDir();
    const { io, printed } = scriptedIo({ "Add a project": "" }, { Write: true, Install: false });
    expect(await runInit(initDeps(home, io, { which: signedPiOnly }))).toBe(0);
    expect(loadConfig(home).config.tools.pi).toBe("/nonexistent/bin/pi-signed");
    expect(printed.some((l) => l.startsWith("  pi: /nonexistent/bin/pi-signed"))).toBe(true);
  });

  test("stops when tasks-axi is missing, printing how to install it", async () => {
    const home = tempDir();
    const { io, printed } = scriptedIo({}, {});
    expect(await runInit(initDeps(home, io, { which: () => null }))).toBe(1);
    expect(printed.some((l) => l.includes("npm install -g tasks-axi@0.2.5"))).toBe(true);
  });

  test("adopts an existing backlog only if tasks-axi can read it", async () => {
    const home = tempDir();
    const data = join(home, "d");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "backlog.md"), "garbage");
    const { io, printed } = scriptedIo({ "Data directory": data }, { Write: true });
    const deps = initDeps(home, io, {
      listTasks: async () => {
        throw new Error("unreadable");
      },
    });
    expect(await runInit(deps)).toBe(1);
    expect(printed.some((l) => l.includes("cannot read"))).toBe(true);
    expect(existsSync(join(home, "config.toml"))).toBe(false);
  });

  test("installs the service and registers projects when asked", async () => {
    const home = tempDir();
    const added: string[] = [];
    let projects = ["/repo/one", ""];
    const { io, printed } = scriptedIo({}, { Write: true, Install: true });
    const deps = initDeps(
      home,
      {
        ...io,
        ask: async (question, fallback) => (question.startsWith("Add a project") ? projects.shift()! : fallback),
      },
      { addProject: async (path) => (added.push(path), `project: ${path}`) },
    );
    expect(await runInit(deps)).toBe(0);
    expect(added).toEqual(["/repo/one"]);
    expect(printed).toContain("installed");
    expect(printed).toContain("doctor ran");
    projects = [];
  });
});

describe("doctor --restore", () => {
  test("replaces the database with a backup and keeps the old one aside", () => {
    const home = tempDir();
    const config = defaultConfig(home);
    const files = stateFiles(config.state_dir);
    mkdirSync(config.state_dir, { recursive: true });
    const db = openDb(files.db);
    migrate(db);
    backupIfDue(db, files.backups, new Date(2026, 8, 20));
    db.exec("INSERT INTO meta (key, value) VALUES ('after_backup', 'x')");
    db.close();
    const result = restoreBackup(config, "2026-09-20");
    expect(result.from).toEndWith("flowryn-2026-09-20.db");
    expect(existsSync(result.previous!)).toBe(true);
    const restored = openDb(files.db, { readonly: true });
    expect(schemaVersion(restored)).toBe(LATEST_SCHEMA_VERSION);
    expect(restored.query("SELECT value FROM meta WHERE key = 'after_backup'").get()).toBeNull();
    restored.close();
    expect(readFileSync(result.previous!).length).toBeGreaterThan(0);
  });

  test("refuses while a daemon holds the state lock", () => {
    const home = tempDir();
    const config = defaultConfig(home);
    const files = stateFiles(config.state_dir);
    mkdirSync(files.backups, { recursive: true });
    writeFileSync(join(files.backups, "flowryn-2026-09-20.db"), "");
    const lock = tryExclusiveLock(files.lock)!;
    try {
      expect(() => restoreBackup(config, undefined)).toThrow("daemon is running");
    } finally {
      lock.release();
    }
  });
});
