import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, defaultConfig, parseConfig, CONFIG_SECTIONS } from "../../src/config/config.ts";
import { notifyConfig } from "../../src/config/leader.ts";
import { configOverrides, configSectionProblems, differingSections, effectiveConfig, redactConfig, REDACTED, resolveEnv, SNAPSHOT_KEYS } from "../../src/config/effective.ts";
import { checkSection, configReport, type DaemonState, type FileState } from "../../src/cli/config-view.ts";
import { upkeepConfig } from "../../src/config/upkeep.ts";
import { capacityConfig } from "../../src/config/workflows.ts";
import { migrate, openDb, schemaVersion, LATEST_SCHEMA_VERSION } from "../../src/db/db.ts";
import { backupIfDue } from "../../src/db/backup.ts";
import { notifyMacosCheck, restoreBackup } from "../../src/doctor/doctor.ts";
import { runInit, type InitDeps } from "../../src/init/init.ts";
import { POLICY_MODE_LINES } from "../../src/config/policy.ts";
import { renderPlist, plistDrift, plistSpecFor, serviceLabel, BASE_LABEL, SERVICE_ENV_PASSTHROUGH } from "../../src/service/launchd.ts";
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
  });

  // macOS only: plutil ships with macOS; CI on Linux has no plist linter.
  test.skipIf(process.platform !== "darwin")("renders a plist that plutil accepts", () => {
    const home = tempDir();
    const config = { ...defaultConfig(home), tools: { tasks_axi: "/opt/tools/bin/tasks-axi", node: "/opt/node/bin/node" } };
    const path = join(home, "agent.plist");
    writeFileSync(path, renderPlist(plistSpecFor(config, home)));
    expect(Bun.spawnSync(["/usr/bin/plutil", "-lint", path]).exitCode).toBe(0);
  });

  test("carries the safety overrides from the installer's environment, and nothing else of it", () => {
    const home = tempDir();
    const config = defaultConfig(home);
    const plain = plistSpecFor(config, home, { PATH: "/x", FLOWRYN_SOCK: "/elsewhere.sock" });
    expect(Object.keys(plain.env).toSorted()).toEqual(["FLOWRYN_HOME", "HOME", "PATH"]);
    const overrides = { FLOWRYN_NOTIFY: "off", FLOWRYN_NOTIFIER: "record:/n.jsonl", FLOWRYN_OPENER: "record:/o.log" };
    const safe = plistSpecFor(config, home, { ...overrides, FLOWRYN_TOKEN: "t", FLOWRYN_NOTIFY_EXTRA: "x" });
    expect(safe.env).toMatchObject(overrides);
    expect(Object.keys(safe.env).toSorted()).toEqual(["FLOWRYN_HOME", "FLOWRYN_NOTIFIER", "FLOWRYN_NOTIFY", "FLOWRYN_OPENER", "HOME", "PATH"]);
    expect(SERVICE_ENV_PASSTHROUGH).toEqual(["FLOWRYN_NOTIFY", "FLOWRYN_NOTIFIER", "FLOWRYN_OPENER"]);
  });

  test("assumption: a daemon launched with the plist's environment computes the same spec, so its overrides are no drift", () => {
    const home = tempDir();
    const config = defaultConfig(home);
    const installed = plistSpecFor(config, home, { FLOWRYN_NOTIFY: "off", FLOWRYN_OPENER: "record:/o.log" });
    const daemonSide = plistSpecFor(config, home, installed.env);
    expect(plistDrift({ program: installed.program, env: installed.env, workingDir: installed.workingDir }, daemonSide)).toEqual([]);
    // A daemon whose plist lacks them (a production install) computes a spec without them.
    const production = plistSpecFor(config, home, {});
    expect(plistDrift({ program: production.program, env: production.env, workingDir: production.workingDir }, plistSpecFor(config, home, production.env))).toEqual([]);
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
    install: async (argv) => {
      throw new Error(`unexpected install: ${argv.join(" ")}`);
    },
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

  test("writes macos explicitly: on unless you decline", async () => {
    const on = tempDir();
    expect(await runInit(initDeps(on, scriptedIo({ "Add a project": "" }, { Write: true, Install: false }).io))).toBe(0);
    expect(loadConfig(on).config.extra.notify).toMatchObject({ macos: true });
    const off = tempDir();
    expect(await runInit(initDeps(off, scriptedIo({ "Add a project": "" }, { "Post macOS notifications": false, Write: true, Install: false }).io))).toBe(0);
    expect(loadConfig(off).config.extra.notify).toMatchObject({ macos: false });
  });

  test("asks the leader policy once, strict by default, and writes it explicitly", async () => {
    const strict = tempDir();
    const { io, printed } = scriptedIo({ "Add a project": "" }, { Write: true, Install: false });
    expect(await runInit(initDeps(strict, io))).toBe(0);
    expect(loadConfig(strict).config.extra.policy).toEqual({ mode: "strict" });
    expect(printed).toContain(`  strict: ${POLICY_MODE_LINES.strict}`);
    expect(printed).toContain(`  relaxed: ${POLICY_MODE_LINES.relaxed}`);
    const relaxed = tempDir();
    expect(await runInit(initDeps(relaxed, scriptedIo({ "Policy mode": "relaxed", "Add a project": "" }, { Write: true, Install: false }).io))).toBe(0);
    expect(loadConfig(relaxed).config.extra.policy).toEqual({ mode: "relaxed" });
    // Re-running offers the current mode as the default.
    expect(await runInit(initDeps(relaxed, scriptedIo({ "Add a project": "" }, { Write: true, Install: false }).io))).toBe(0);
    expect(loadConfig(relaxed).config.extra.policy).toEqual({ mode: "relaxed" });
  });

  test("refuses a policy mode that is neither strict nor relaxed and writes nothing", async () => {
    const home = tempDir();
    const { io, printed } = scriptedIo({ "Policy mode": "lax" }, { Write: true, Install: false });
    expect(await runInit(initDeps(home, io))).toBe(1);
    expect(existsSync(join(home, "config.toml"))).toBe(false);
    expect(printed.at(-1)).toBe("refused: lax is not strict or relaxed; nothing was written");
  });

  test("re-running fills keys an existing table lacks, keeping every current value", async () => {
    const home = tempDir();
    writeFileSync(join(home, "config.toml"), "[notify]\nmin_interval_min = 45\n[capacity]\nworker = 7\n");
    const before = loadConfig(home).config;
    expect(notifyMacosCheck(before)?.status).toBe("warn");
    expect(notifyConfig(before).macos).toBe(true);
    const { io } = scriptedIo({ "Add a project": "" }, { Write: true, Install: false });
    expect(await runInit(initDeps(home, io))).toBe(0);
    const after = loadConfig(home).config;
    expect(after.extra.notify).toEqual({ macos: true, herdr: true, min_interval_min: 45, p0_coalesce_s: 60, max_triggered_turns_per_hour: 3 });
    expect(after.extra.capacity).toMatchObject({ worker: 7, validation: 5, host: { min_free_mem_gb: 8, max_load_per_core: 1.5 } });
    expect(notifyMacosCheck(after)).toBeNull();
  });

  test("re-running fills a [workers.claude] table that lacks permission_mode with a valid one", async () => {
    const home = tempDir();
    writeFileSync(join(home, "config.toml"), '[workers.claude]\nmodel = "sonnet"\n');
    const { io } = scriptedIo({ "Add a project": "" }, { Write: true, Install: false });
    expect(await runInit(initDeps(home, io))).toBe(0);
    const config = loadConfig(home).config;
    expect(config.extra.workers).toMatchObject({ claude: { model: "sonnet", permission_mode: "bypassPermissions" } });
    expect(configSectionProblems(config)).toEqual([]);
  });

  test("refuses to write a config whose sections fail validation", async () => {
    const home = tempDir();
    const original = '[workers.claude]\npermission_mode = "bypass"\n';
    writeFileSync(join(home, "config.toml"), original);
    const { io, printed } = scriptedIo({ "Add a project": "" }, { Write: true, Install: false });
    expect(await runInit(initDeps(home, io))).toBe(1);
    expect(printed.some((l) => l.startsWith("error:") && l.includes("permission_mode"))).toBe(true);
    expect(printed.at(-1)).toBe("nothing was written");
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(original);
  });

  test("re-running keeps macos = false as the answer to keep", async () => {
    const home = tempDir();
    writeFileSync(join(home, "config.toml"), "[notify]\nmacos = false\n");
    const { io } = scriptedIo({ "Add a project": "" }, { Write: true, Install: false });
    expect(await runInit(initDeps(home, io))).toBe(0);
    expect(notifyConfig(loadConfig(home).config).macos).toBe(false);
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

  test("Q5: offers the missing tools' installers under one y/N that defaults to no, and installs nothing then", async () => {
    const home = tempDir();
    const { io, printed } = scriptedIo({ "Add a project": "" }, { Write: true, "Install the launchd": false });
    const onPath = (binary: string) => (binary === "tasks-axi" ? "/opt/bin/tasks-axi" : binary === "npm" ? "/opt/bin/npm" : null);
    expect(await runInit(initDeps(home, io, { which: onPath }))).toBe(0);
    expect(printed).toContain("  npm install -g gh-axi");
    expect(printed).not.toContain("  brew tap atlassian/homebrew-acli");
    expect(printed.some((l) => l.startsWith("  acli: brew is not on PATH"))).toBe(true);
    expect(printed).toContain("  sh -c 'curl -fsSL https://kunchenguid.github.io/treehouse/install.sh | sh'");
    // Harnesses, gh and Docker get a hint only.
    expect(printed.some((l) => /^\s+(npm install -g @anthropic-ai|brew install gh)/.test(l))).toBe(false);
    expect(loadConfig(home).config.tools.gh_axi).toBeUndefined();
  });

  test("Q5: on yes, runs each command in turn, reports a failure and carries on, and records what installed", async () => {
    const home = tempDir();
    const ran: string[] = [];
    const installed = new Set<string>();
    const { io, printed } = scriptedIo({ "Add a project": "" }, { Write: true, "Run these install": true, "Install the launchd": false });
    const which = (binary: string) => {
      if (["tasks-axi", "npm", "brew"].includes(binary)) return `/opt/bin/${binary}`;
      return installed.has(binary) ? `/opt/bin/${binary}` : null;
    };
    const install = async (argv: string[]) => {
      ran.push(argv.join(" "));
      if (argv[0] === "brew" && argv[1] === "tap") return 1;
      if (argv[0] === "npm") for (const pkg of argv.slice(3)) installed.add(pkg);
      return 0;
    };
    expect(await runInit(initDeps(home, io, { which, install }))).toBe(0);
    expect(ran).toContain("npm install -g gh-axi");
    // acli's tap failed, so its install step never ran; the tools after it still did.
    expect(ran).not.toContain("brew install acli");
    expect(ran).toContain("npm install -g sqlite-axi");
    expect(printed.some((l) => l.startsWith("  acli: install failed (brew tap atlassian/homebrew-acli exited 1)"))).toBe(true);
    expect(printed).toContain("  gh_axi: next, gh-axi runs gh: sign in with gh auth login");
    const tools = loadConfig(home).config.tools;
    expect(tools.gh_axi).toBe("/opt/bin/gh-axi");
    expect(tools.chrome_devtools_axi).toBe("/opt/bin/chrome-devtools-axi");
    expect(tools.acli).toBeUndefined();
  });

  test("Q5: a missing tasks-axi installed from the offer no longer stops init", async () => {
    const home = tempDir();
    let have = false;
    const { io } = scriptedIo({ "Add a project": "" }, { Write: true, "Run these install": true, "Install the launchd": false });
    const which = (binary: string) => (binary === "npm" ? "/opt/bin/npm" : binary === "tasks-axi" && have ? "/opt/bin/tasks-axi" : null);
    const install = async (argv: string[]) => {
      if (argv.join(" ") === "npm install -g tasks-axi@0.2.5") have = true;
      return 0;
    };
    expect(await runInit(initDeps(home, io, { which, install }))).toBe(0);
    expect(loadConfig(home).config.tools.tasks_axi).toBe("/opt/bin/tasks-axi");
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

  test("holds the state lock for the whole swap, so a daemon started meanwhile refuses", () => {
    const home = tempDir();
    const config = defaultConfig(home);
    const files = stateFiles(config.state_dir);
    mkdirSync(config.state_dir, { recursive: true });
    const db = openDb(files.db);
    migrate(db);
    backupIfDue(db, files.backups, new Date(2026, 8, 20));
    db.close();
    const daemonGotLock: boolean[] = [];
    restoreBackup(config, undefined, (from, to) => {
      const daemonLock = tryExclusiveLock(files.lock);
      daemonGotLock.push(daemonLock !== null);
      daemonLock?.release();
      copyFileSync(from, to);
    });
    expect(daemonGotLock).toEqual([false]);
    const after = tryExclusiveLock(files.lock);
    expect(after).not.toBeNull();
    after!.release();
  });

  test("releases the state lock when the restore fails", () => {
    const home = tempDir();
    const config = defaultConfig(home);
    const files = stateFiles(config.state_dir);
    mkdirSync(files.backups, { recursive: true });
    writeFileSync(join(files.backups, "flowryn-2026-09-20.db"), "");
    expect(() => restoreBackup(config, "2026-01-01")).toThrow("no backup matches");
    const after = tryExclusiveLock(files.lock);
    expect(after).not.toBeNull();
    after!.release();
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

describe("effective configuration", () => {
  const H = "/tmp/fw-eff";
  const ENV = { HOME: "/tmp/fw-eff-user" };
  const cfg = (text: string) => parseConfig(text, H);
  const fileOf = (text: string | null): FileState => {
    try {
      return { path: `${H}/config.toml`, exists: text !== null, text, config: text === null ? defaultConfig(H) : cfg(text), error: null };
    } catch (error) {
      return { path: `${H}/config.toml`, exists: true, text, config: null, error: (error as Error).message };
    }
  };
  const daemonOf = (text: string, reload: Extract<DaemonState, { state: "answered" }>["reload"] = null, env: NodeJS.ProcessEnv = ENV): DaemonState => {
    const snapshot = effectiveConfig(cfg(text), env);
    return { state: "answered", loaded_at: "2026-10-12T10:00:00.000Z", reload, problems: snapshot.problems, sections: redactConfig(snapshot.sections), resolve_env: resolveEnv(env) };
  };

  test("the snapshot has one entry per registered section, plus core, and the defaults raise no problem", () => {
    const { sections, problems } = effectiveConfig(defaultConfig(H), ENV);
    expect(Object.keys(sections)).toEqual(["core", ...CONFIG_SECTIONS]);
    expect(SNAPSHOT_KEYS).toEqual(["core", ...CONFIG_SECTIONS]);
    expect(problems).toEqual([]);
    expect(Object.values(sections).every((value) => value !== null)).toBe(true);
  });

  test("each section's effective values are its own parser's: the snapshot adds no defaults of its own", () => {
    const config = cfg("[upkeep]\nsync_primary = false\n[capacity]\nworker = 3\n[notify]\nmacos = false\n");
    const { sections } = effectiveConfig(config, ENV);
    expect(sections.upkeep).toEqual(upkeepConfig(config));
    expect(sections.capacity).toEqual(capacityConfig(config));
    expect(sections.notify).toEqual(notifyConfig(config));
    expect(sections.policy).toEqual({ mode: "strict" });
  });

  test("workflows say which are built in and which the file adds or replaces", () => {
    const { sections } = effectiveConfig(cfg('[workflows.quick]\nstages = [{ id = "ship", gate = "merge" }]\n[workflows.feature]\nstages = [{ id = "ship", gate = "merge" }]\n'), ENV);
    const workflows = sections.workflows as Record<string, { source: string; stages: { id: string }[] }>;
    expect(workflows.quick).toMatchObject({ source: "config", stages: [{ id: "ship" }] });
    expect(workflows.feature!.source).toBe("config (replaces the built-in)");
    expect(workflows["feature-ui"]!.source).toBe("built-in");
  });

  test("a refused section is null in the snapshot and its refusal is a problem; the others still resolve", () => {
    const { sections, problems } = effectiveConfig(cfg('[policy]\nmode = "lax"\n'), ENV);
    expect(sections.policy).toBeNull();
    expect(problems).toEqual([expect.stringContaining("[policy] mode")]);
    expect(sections.notify).not.toBeNull();
  });

  test("the startup check now covers [grants], [decisions] and [projects.<id>], which it used to miss", () => {
    expect(configSectionProblems(cfg("[grants]\nclaude_projects_dir = 3\n"), ENV)).toEqual([expect.stringContaining("[grants]")]);
    expect(configSectionProblems(cfg('[decisions]\nreserved_classes = ["nope"]\n'), ENV)).toEqual([expect.stringContaining("[decisions]")]);
    expect(configSectionProblems(cfg("[projects.web]\nverfy = []\n"), ENV)).toEqual([expect.stringContaining("[projects.web] verfy")]);
    expect(configSectionProblems(cfg('[projects.web]\nverify = ["bun test"]\n'), ENV)).toEqual([]);
  });

  test("overrides are the dotted paths of the leaves the file sets; an array is one leaf and comments are not values", () => {
    const text = '# a comment\nmorning_hour = 6\n[notify]\nmacos = false # off\n[capacity.host]\nmin_free_mem_gb = 0\n[workflows.quick]\nstages = [{ id = "ship", gate = "merge" }]\n';
    expect(configOverrides(text)).toEqual(["capacity.host.min_free_mem_gb", "morning_hour", "notify.macos", "workflows.quick.stages"]);
    expect(configOverrides("not = = toml")).toEqual([]);
    expect(configOverrides("")).toEqual([]);
  });

  test("redaction hides harness env values, secret-named keys, secret flags in extra_args and token-shaped strings; github token_env stays", () => {
    const { sections } = effectiveConfig(
      cfg(`[workers.pi]
env = { OPENAI_API_KEY = "sk-live-0123456789", PLAIN = "not-secret-but-env" }
extra_args = ["--api-key", "k1", "--auth-token=k2", "--model", "m", "ghp_abcdefghijklmnopqrstuvwxyz"]
[workers.claude]
extra_args = ["--password", "hunter2", "--verbose"]
[github]
token_env = ["GH_TOKEN", "GITHUB_TOKEN"]
`),
      ENV,
    );
    const redacted = redactConfig(sections) as { workers: { pi: { env: Record<string, string>; extra_args: string[] }; claude: { extra_args: string[] } }; github: { token_env: string[] } };
    expect(redacted.workers.pi.env).toEqual({ OPENAI_API_KEY: REDACTED, PLAIN: REDACTED });
    expect(redacted.workers.pi.extra_args).toEqual(["--api-key", REDACTED, `--auth-token=${REDACTED}`, "--model", "m", REDACTED]);
    expect(redacted.workers.claude.extra_args).toEqual(["--password", REDACTED, "--verbose"]);
    expect(redacted.github.token_env).toEqual(["GH_TOKEN", "GITHUB_TOKEN"]);
    const text = JSON.stringify(redacted);
    for (const secret of ["sk-live-0123456789", "k1", "k2", "hunter2", "ghp_abcdefghijklmnopqrstuvwxyz", "not-secret-but-env"]) expect(text).not.toContain(`"${secret}"`);
    expect(redactConfig({ x: { client_secret: "s", nested: { password: 1 } } })).toEqual({ x: { client_secret: REDACTED, nested: { password: REDACTED } } });
  });

  test("differingSections names only the sections whose values differ", () => {
    expect(differingSections({ core: 1, notify: { a: 1 }, upkeep: { b: 1 } }, { core: 1, notify: { a: 2 }, upkeep: { b: 1 } })).toEqual(["notify"]);
    expect(differingSections({ notify: { a: 1 } }, { notify: { a: 1 } })).toEqual([]);
  });

  describe("flowryn config's report", () => {
    test("no file: defaults, no overrides, and the daemon not running", () => {
      const data = configReport(fileOf(null), { state: "not_running" }, ENV);
      expect(data).toMatchObject({ exists: "no (defaults)", file: "valid", daemon: "not running", overrides: "none: every value shown is a default", effective_from: "the file" });
      expect(Object.keys(data.effective as object)).toEqual([...SNAPSHOT_KEYS]);
      expect(data.daemon_values).toBeUndefined();
    });

    test("the daemon's accepted configuration matching the file says so, with its load time", () => {
      const text = "[upkeep]\nsync_primary = false\n";
      const data = configReport(fileOf(text), daemonOf(text), ENV);
      expect(data).toMatchObject({ daemon: "running; its accepted configuration matches the file", daemon_loaded: "2026-10-12T10:00:00.000Z", overrides: ["upkeep.sync_primary"] });
      expect(data.daemon_values).toBeUndefined();
    });

    test("a daemon with another CLAUDE_CONFIG_DIR than the caller matches the same file, resolved with the daemon's environment", () => {
      const caller = { ...ENV, CLAUDE_CONFIG_DIR: "/tmp/fw-eff-claude-work" };
      const data = configReport(fileOf(""), daemonOf("", null, ENV), caller);
      expect(data.daemon).toBe("running; its accepted configuration matches the file");
      expect((data.effective as { grants: { claude_projects_dir: string } }).grants.claude_projects_dir).toBe("/tmp/fw-eff-user/.claude/projects");
      expect(configReport(fileOf(""), { state: "not_running" }, caller).effective).toMatchObject({ grants: { claude_projects_dir: "/tmp/fw-eff-claude-work/projects" } });
    });

    test("a daemon on an older file: the differing sections are named and the daemon's values of only those are shown", () => {
      const data = configReport(fileOf("[upkeep]\nsync_primary = false\n"), daemonOf(""), ENV);
      expect(data.daemon).toBe("running; its accepted configuration differs from the file in [upkeep] (it reads the file again on SIGHUP or a restart)");
      expect(data.daemon_values).toEqual({ upkeep: expect.objectContaining({ sync_primary: true }) });
      expect((data.effective as { upkeep: { sync_primary: boolean } }).upkeep.sync_primary).toBe(false);
    });

    test("an invalid file with a running daemon: the effective values are the daemon's, and a rejected reload is shown", () => {
      const file = fileOf("[notfiy]\nmacos = false\n");
      const data = configReport(file, daemonOf("[upkeep]\nsync_primary = false\n", { at: "2026-10-12T11:00:00.000Z", outcome: "rejected", error: "[notfiy] is not a known section; did you mean [notify]?" }), ENV);
      expect(data.file).toBe("invalid: [notfiy] is not a known section; did you mean [notify]?");
      expect(data.daemon).toBe("running; the file does not load, so the effective values below are the daemon's");
      expect(data.daemon_reload).toBe("rejected at 2026-10-12T11:00:00.000Z: [notfiy] is not a known section; did you mean [notify]?; the daemon keeps its last valid configuration");
      expect(data.effective_from).toBe("the running daemon");
      expect((data.effective as { upkeep: { sync_primary: boolean } }).upkeep.sync_primary).toBe(false);
      expect(data.overrides).toEqual(["notfiy.macos"]);
    });

    test("an invalid file with no daemon shows no effective values, only why", () => {
      const data = configReport(fileOf("[notfiy]\n"), { state: "not_running" }, ENV);
      expect(data.effective).toBeUndefined();
      expect(data.file).toStartWith("invalid: ");
    });

    test("--section narrows the effective values, the overrides and the daemon's differing values to one section", () => {
      const text = "morning_hour = 7\n[upkeep]\nsync_primary = false\n[notify]\nmacos = false\n";
      const data = configReport(fileOf(text), daemonOf(""), ENV, "notify");
      expect(Object.keys(data.effective as object)).toEqual(["notify"]);
      expect(data.overrides).toEqual(["notify.macos"]);
      expect(Object.keys(data.daemon_values as object)).toEqual(["notify"]);
      expect(data.daemon).toContain("differs from the file in [notify] ");
      expect(configReport(fileOf(text), daemonOf(""), ENV, "core").overrides).toEqual(["morning_hour"]);
    });

    test("a section name that is not one is refused with the closest", () => {
      expect(checkSection("capacity")).toBe("capacity");
      expect(() => checkSection("notfy")).toThrow("--section notfy is not a section; did you mean notify?");
    });

    test("secrets never reach the report, from the file or from the daemon", () => {
      const text = '[workers.pi]\nenv = { KEY = "very-secret-value" }\n';
      const data = configReport(fileOf(text), daemonOf(text.replace("very-secret-value", "older-secret-value")), ENV);
      const out = JSON.stringify(data);
      expect(out).not.toContain("very-secret-value");
      expect(out).not.toContain("older-secret-value");
      expect(data.overrides).toEqual(["workers.pi.env.KEY"]);
    });
  });
});
