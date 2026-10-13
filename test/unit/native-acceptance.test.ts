import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig } from "../../src/config/config.ts";
import { BASE_LABEL, plistPath, serviceLabel } from "../../src/service/launchd.ts";
import {
  acceptanceOverrides,
  collisions,
  extraToolLines,
  finishReport,
  invocationRefusals,
  leftovers,
  MAKEHOME_TOOLS,
  newReport,
  OPT_IN_ENV,
  parseCliArgs,
  planFor,
  plannedTools,
  productionTargets,
  scrubPath,
  STEPS,
  validateReport,
  type Artifact,
  type Environment,
  type Plan,
  type ProductionTarget,
  type Report,
  type Teardown,
} from "../../scripts/lab/native-acceptance.ts";
import { makeHome, REPO_ROOT } from "../helpers/harness.ts";

/**
 * The native acceptance run's guards, plan and report (docs/notes/2026-10-12-next-steps-md-ny.md).
 * Nothing here drives launchd: the run itself happens only under the script's import.meta.main
 * with both opt-ins, and the spawned scripts below either refuse or print their plan.
 */
const SCRIPT = join(REPO_ROOT, "scripts", "lab", "native-acceptance.ts");
const dirs: string[] = [];
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fw-na-")));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function planIn(home: string): Plan {
  return planFor(home, { ...defaultConfig(home), tools: plannedTools(home, "/usr/bin:/bin") }, acceptanceOverrides(home));
}

function production(home: string, extra: Partial<ProductionTarget> = {}): ProductionTarget {
  const label = serviceLabel(home);
  return { home, label, plist: plistPath(label), sockets: [join(home, "run", "flowrynd.sock")], dirs: [home, join(home, "data"), join(home, "state")], program: null, ...extra };
}

describe("opt-in", () => {
  const run = { mode: "run", home: null, report: null, keep: false } as const;

  test("no mode is refused, and --run needs FLOWRYN_NATIVE_ACCEPTANCE=1", () => {
    expect(invocationRefusals({ ...run, mode: null }, {}, "darwin")).toHaveLength(1);
    expect(invocationRefusals(run, {}, "darwin")[0]).toContain(OPT_IN_ENV);
    expect(invocationRefusals(run, { [OPT_IN_ENV]: "true" }, "darwin")).toHaveLength(1);
    expect(invocationRefusals(run, { [OPT_IN_ENV]: "1" }, "darwin")).toEqual([]);
  });

  test("a worker never runs it, and it runs only on macOS; --plan needs neither", () => {
    expect(invocationRefusals(run, { [OPT_IN_ENV]: "1", FLOWRYN_RUN: "r01X" }, "darwin")[0]).toContain("worker");
    expect(invocationRefusals(run, { [OPT_IN_ENV]: "1" }, "linux")[0]).toContain("macOS");
    expect(invocationRefusals({ ...run, mode: "plan" }, { FLOWRYN_RUN: "r01X" }, "linux")).toEqual([]);
  });

  test("arguments: --plan and --run are exclusive, unknown flags are refused", () => {
    expect(parseCliArgs(["--run", "--home", "/x", "--keep"])).toEqual({ mode: "run", home: "/x", report: null, keep: true });
    expect(() => parseCliArgs(["--plan", "--run"])).toThrow("exclusive");
    expect(() => parseCliArgs(["--yes"])).toThrow();
  });
});

describe("the plan", () => {
  test("assumption: the acceptance home's label, plist, socket and binary are its own, never production's", () => {
    const home = join(tempDir(), "fna-1");
    const plan = planIn(home);
    expect(plan.label).toBe(serviceLabel(home));
    expect(plan.label).not.toBe(BASE_LABEL);
    expect(plan.plist).toBe(plistPath(plan.label));
    for (const path of [plan.socket, plan.stateDir, plan.dataDir, plan.install, plan.herdrSocket, plan.pinnedLink]) expect(path.startsWith(`${home}/`)).toBe(true);
    expect(plan.spec.program).toEqual([plan.install, "daemon", "run"]);
    expect(plan.spec.env).toMatchObject({ FLOWRYN_HOME: home, FLOWRYN_NOTIFY: "off" });
    expect(plan.spec.env.FLOWRYN_OPENER).toStartWith("record:");
  });

  test("every tool makeHome does not record gets the absent stand-in, so the daemon's PATH has only the home's tools and the system", () => {
    const home = join(tempDir(), "fna-2");
    const lines = extraToolLines(home);
    for (const name of MAKEHOME_TOOLS) expect(lines.some((line) => line.startsWith(`${name} =`))).toBe(false);
    expect(lines.some((line) => line.startsWith("docker ="))).toBe(true);
    const tools = plannedTools(home, "/usr/bin:/bin");
    expect(tools.docker).toBe(join(home, "bin", "tool-absent"));
    expect(tools.claude).toBe(join(home, "bin", "harness-absent"));
  });

  test("assumption: makeHome records exactly MAKEHOME_TOOLS, so the extra lines never repeat a key", () => {
    const h = makeHome({ extraConfig: (home) => extraToolLines(home).join("\n") });
    try {
      // A duplicate key would make the config unreadable; a tool makeHome stopped recording would be unset.
      const tools = loadConfig(h.home).config.tools;
      for (const name of MAKEHOME_TOOLS) expect(tools[name]).toBeString();
      expect(tools.treehouse).toBe(join(h.home, "bin", "tool-absent"));
    } finally {
      h.cleanup();
    }
  });

  test("scrubPath drops entries inside a production home (its harness shims) and keeps the rest", () => {
    const prod = production("/Users/x/.flowryn");
    expect(scrubPath("/Users/x/.flowryn/state/shims:/opt/homebrew/bin::/usr/bin", [prod])).toBe("/opt/homebrew/bin:/usr/bin");
  });
});

describe("collision guards", () => {
  test("a fresh home collides with nothing", () => {
    const root = tempDir();
    expect(collisions(planIn(join(root, "fna-3")), [production(join(root, ".flowryn"))])).toEqual([]);
  });

  test("the production home itself: label, plist, socket and directories all collide", () => {
    const prodHome = join(homedir(), ".flowryn");
    const found = collisions(planIn(prodHome), [production(prodHome)]);
    expect(found.some((line) => line.includes(`production label ${BASE_LABEL}`))).toBe(true);
    expect(found.some((line) => line.startsWith("the plist"))).toBe(true);
    expect(found.some((line) => line.startsWith("the socket"))).toBe(true);
    expect(found.some((line) => line.startsWith("the home"))).toBe(true);
  });

  test("a home inside, or containing, a production directory collides", () => {
    const root = tempDir();
    const prodHome = join(root, "prod");
    expect(collisions(planIn(join(prodHome, "state", "fna")), [production(prodHome)]).some((line) => line.startsWith("the home"))).toBe(true);
    const inside = production(join(root, "elsewhere"), { dirs: [join(root, "outer", "fna-4", "data")] });
    expect(collisions(planIn(join(root, "outer", "fna-4")), [inside]).some((line) => line.includes("overlaps"))).toBe(true);
  });

  test("a FLOWRYN_HOME production home's own label and socket collide", () => {
    const root = tempDir();
    const plan = planIn(join(root, "fna-5"));
    const found = collisions(plan, [production(join(root, "other"), { label: plan.label, sockets: [plan.socket] })]);
    expect(found.some((line) => line.startsWith("the label"))).toBe(true);
    expect(found.some((line) => line.startsWith("the socket"))).toBe(true);
  });

  test("the production plist's program as the installed binary collides", () => {
    const root = tempDir();
    const plan = planIn(join(root, "fna-6"));
    expect(collisions(plan, [production(join(root, "p"), { program: plan.install })]).some((line) => line.startsWith("the installed binary"))).toBe(true);
  });

  test("a daemon PATH entry inside a production home collides", () => {
    const root = tempDir();
    const prodHome = join(root, "prod");
    const plan = planIn(join(root, "fna-7"));
    plan.spec.env.PATH = `${join(prodHome, "state", "shims")}:/usr/bin`;
    expect(collisions(plan, [production(prodHome)]).some((line) => line.includes("PATH entry"))).toBe(true);
  });

  test("leftovers: an existing home or an installed plist at the label", () => {
    const root = tempDir();
    const plan = planIn(join(root, "fna-8"));
    expect(leftovers(plan, () => false)).toEqual([]);
    expect(leftovers(plan, (path) => path === plan.plist)[0]).toContain("already installed");
    mkdirSync(plan.home);
    expect(leftovers(plan)[0]).toContain("already exists");
  });

  test("productionTargets covers ~/.flowryn and FLOWRYN_HOME, with each home's configured directories", async () => {
    const root = tempDir();
    const other = join(root, "other-home");
    mkdirSync(other);
    writeFileSync(join(other, "config.toml"), `data_dir = ${JSON.stringify(join(root, "d"))}\nstate_dir = ${JSON.stringify(join(root, "s"))}\n`);
    const targets = await productionTargets({ FLOWRYN_HOME: other }, async () => null);
    expect(targets.map((t) => t.home)).toEqual([join(homedir(), ".flowryn"), other]);
    expect(targets[0]!.label).toBe(BASE_LABEL);
    expect(targets[1]!.dirs).toEqual([other, join(root, "d"), join(root, "s")]);
  });
});

function environment(): Environment {
  return {
    host: "mac",
    macos: "26.3",
    macos_build: "25D1",
    arch: "arm64",
    uid: 501,
    launchd_domain: "gui/501",
    bun: "1.3.8",
    flowryn: "0.23.0",
    proto: 6,
    source_commit: "a".repeat(40),
    source_dirty: false,
    label: `${BASE_LABEL}.12345678`,
    plist: "/Users/x/Library/LaunchAgents/dev.flowryn.flowrynd.12345678.plist",
    home: "/private/var/fna-1",
    socket: "/private/var/fna-1/run/flowrynd.sock",
    herdr_socket: "/private/var/fna-1/herdr.sock",
    forge_url: "http://127.0.0.1:5000",
  };
}

function artifact(role: Artifact["role"], seed: string): Artifact {
  const sha256 = seed.repeat(64).slice(0, 64);
  return { role, path: `/x/${role}`, build: sha256.slice(0, 12), sha256, bytes: 100, commit: role === "broken" ? null : "b".repeat(40) };
}

const CLEAN: Teardown = { label_gone: true, plist_gone: true, home_removed: true, kept: false, errors: [] };

function fullReport(): Report {
  const report = newReport("01RUN", environment(), new Date(0));
  report.artifacts.push(artifact("initial", "1"), artifact("replacement", "2"), artifact("broken", "3"));
  for (const step of STEPS) report.steps.push({ name: step.name, ok: true, detail: "ok", evidence: {}, ms: 1 });
  return report;
}

describe("the report", () => {
  test("every step ok and a clean teardown is a pass, and the shape validates", () => {
    const report = finishReport(fullReport(), CLEAN, new Date(1));
    expect(report.result).toBe("pass");
    expect(validateReport(report)).toEqual([]);
    expect(validateReport(JSON.parse(JSON.stringify(report)))).toEqual([]);
  });

  test("a failed step, a missing step, or a label left loaded is a fail", () => {
    const failed = fullReport();
    failed.steps[3]!.ok = false;
    expect(finishReport(failed, CLEAN, new Date(1)).result).toBe("fail");
    const short = fullReport();
    short.steps.pop();
    expect(finishReport(short, CLEAN, new Date(1)).result).toBe("fail");
    expect(finishReport(fullReport(), { ...CLEAN, label_gone: false }, new Date(1)).result).toBe("fail");
    expect(finishReport(fullReport(), { ...CLEAN, errors: ["fake Herdr: x"] }, new Date(1)).result).toBe("fail");
    expect(validateReport(finishReport(failed, CLEAN, new Date(1)))).toEqual([]);
  });

  test("the shape check catches bad identifiers, steps out of order, a production label, and a pass it cannot back", () => {
    const report = finishReport(fullReport(), CLEAN, new Date(1));
    expect(validateReport({ ...report, artifacts: [{ ...artifact("initial", "1"), build: "zz" }] })).toContain("artifacts[0].build");
    expect(validateReport({ ...report, artifacts: [{ ...artifact("initial", "1"), build: "2".repeat(12) }] })).toContain("artifacts[0].build is not the sha256 prefix");
    expect(validateReport({ ...report, steps: [...report.steps].toReversed() })).toContain("steps[0].name");
    expect(validateReport({ ...report, environment: { ...report.environment, label: BASE_LABEL } })).toContain("environment.label is the production label");
    expect(validateReport({ ...report, teardown: null })).toContain("result is pass without every step and a teardown");
    expect(validateReport({ ...report, kind: "other" })).toContain("kind");
  });
});

describe("the script", () => {
  function spawnScript(args: string[], env: Record<string, string>) {
    const result = Bun.spawnSync(["bun", SCRIPT, ...args], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }, stdin: "ignore" });
    return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  }

  test("refuses with no mode, --run without the opt-in, and --run from a worker, creating nothing", () => {
    const fakeHome = tempDir();
    const home = join(fakeHome, "fna-9");
    expect(spawnScript([], { HOME: fakeHome }).code).toBe(2);
    const noOptIn = spawnScript(["--run", "--home", home], { HOME: fakeHome });
    expect(noOptIn.code).toBe(2);
    expect(noOptIn.stderr).toContain(OPT_IN_ENV);
    const worker = spawnScript(["--run", "--home", home], { HOME: fakeHome, [OPT_IN_ENV]: "1", FLOWRYN_RUN: "r01X" });
    expect(worker.code).toBe(2);
    expect(worker.stderr).toContain("worker");
    expect(existsSync(home)).toBe(false);
    // Bun keeps its own cache under ~/Library/Caches; only LaunchAgents matters here.
    expect(existsSync(join(fakeHome, "Library", "LaunchAgents"))).toBe(false);
  });

  test("--plan prints every identifier and the plist without creating the home or a plist", () => {
    const fakeHome = tempDir();
    const home = join(fakeHome, "fna-10");
    const planned = spawnScript(["--plan", "--home", home], { HOME: fakeHome });
    expect(planned.code).toBe(0);
    const out = JSON.parse(planned.stdout) as { home: string; label: string; plist: string; refusals: string[]; plist_xml: string; steps: { name: string }[]; run: string };
    expect(out.home).toBe(home);
    expect(out.label).toBe(serviceLabel(home));
    expect(out.plist).toBe(join(fakeHome, "Library", "LaunchAgents", `${out.label}.plist`));
    expect(out.refusals).toEqual([]);
    expect(out.plist_xml).toContain("<key>FLOWRYN_NOTIFY</key>");
    expect(out.steps.map((s) => s.name)).toEqual(STEPS.map((s) => s.name));
    expect(out.run).toContain(`${OPT_IN_ENV}=1`);
    expect(existsSync(home)).toBe(false);
    // Bun keeps its own cache under ~/Library/Caches; only LaunchAgents matters here.
    expect(existsSync(join(fakeHome, "Library", "LaunchAgents"))).toBe(false);
  });

  test("--plan on the production home exits 2 with its collisions", () => {
    const fakeHome = tempDir();
    const planned = spawnScript(["--plan", "--home", join(fakeHome, ".flowryn")], { HOME: fakeHome });
    expect(planned.code).toBe(2);
    expect((JSON.parse(planned.stdout) as { refusals: string[] }).refusals.some((line) => line.includes(BASE_LABEL))).toBe(true);
  });
});
