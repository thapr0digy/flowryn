import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlowrynError } from "../../src/api/errors.ts";
import type { DaemonInfo } from "../../src/api/verbs.ts";
import { DEFAULT_DAEMON, daemonConfig, type DaemonConfig } from "../../src/config/daemon.ts";
import { defaultConfig } from "../../src/config/config.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { BuildWatcher, compareVersions, downgradeOf, readJudged, type GitResult } from "../../src/daemon/build-watch.ts";
import { RestartController, readPending, type SmokeResult, type Supervisor } from "../../src/daemon/restart.ts";

/**
 * The build watcher with every outside fact faked: the launchd target, the
 * file's stat key and hash, its `version --json` answer and git. The restart
 * controller is the real one, so a verdict of "apply" shows as its parked
 * automatic request.
 */

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-buildwatch-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const RUNNING = "aaaaaaaaaaaa";
const NEW = "bbbbbbbbbbbb";
const MERGED = "c0ffee0000000000000000000000000000000000";

function info(build: string | null = RUNNING, commit: string | null = null): DaemonInfo {
  return { pid: 4411, version: "0.9.0", proto: 6, instance: "i", startedAt: Date.now() - 90_000, execPath: "/d/flowryn", build, commit, socket: "/s", stateDir: "/st" };
}

function target(overrides: Partial<SmokeResult> = {}): SmokeResult {
  return { version: "0.9.0", proto: 6, build: NEW, schema: 13, commit: MERGED, dirty: false, source: "/src/flowryn", ...overrides };
}

const supervisor: Supervisor = {
  name: "fake",
  supervised: async () => null,
  target: async () => ({ program: ["/d/flowryn", "daemon", "run"] }),
  restart: async () => ({ ok: true, detail: "" }),
};

interface World {
  now: number;
  key: string;
  build: string | null;
  smoke: SmokeResult | Error;
  /** Commits on origin/main; a fetch adds `fetchAdds`. */
  merged: Set<string>;
  fetchAdds: string[];
  gitCalls: string[][];
  smokeCalls: number;
  hashCalls: number;
  config: DaemonConfig;
  running: string | null;
  /** The commit the running daemon was built from, and the commits git calls its ancestors. */
  runningCommit: string | null;
  ancestorsOfRunning: Set<string>;
}

function world(): World {
  return { now: 1_000_000, key: "k1", build: NEW, smoke: target(), merged: new Set([MERGED]), fetchAdds: [], gitCalls: [], smokeCalls: 0, hashCalls: 0, config: { ...DEFAULT_DAEMON }, running: RUNNING, runningCommit: null, ancestorsOfRunning: new Set() };
}

function watcher(w: World) {
  const restart = new RestartController({
    db,
    env: {},
    now: () => w.now,
    log: () => {},
    info: () => info(w.running, w.runningCommit),
    work: () => ({ mergesInFlight: [], cleanups: [], launching: [], challenges: [] }),
    supervisor: () => supervisor,
    smoke: async () => target(),
  });
  const git = async (args: string[]): Promise<GitResult> => {
    w.gitCalls.push(args);
    if (args.includes("fetch")) {
      for (const c of w.fetchAdds) w.merged.add(c);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const commit = args[args.indexOf("--is-ancestor") + 1]!;
    const of = args[args.indexOf("--is-ancestor") + 2]!;
    if (of === w.runningCommit) return { exitCode: w.ancestorsOfRunning.has(commit) ? 0 : 1, stdout: "", stderr: "" };
    return { exitCode: w.merged.has(commit) ? 0 : 1, stdout: "", stderr: "" };
  };
  return new BuildWatcher({
    db,
    env: {},
    now: () => w.now,
    log: () => {},
    config: () => w.config,
    info: () => info(w.running, w.runningCommit),
    supervisor: () => supervisor,
    restart,
    git,
    stat: () => w.key,
    hash: () => {
      w.hashCalls++;
      return w.build;
    },
    smoke: async () => {
      w.smokeCalls++;
      if (w.smoke instanceof Error) throw w.smoke;
      return w.smoke;
    },
    schema: 13,
  });
}

/** Two looks a settle apart: the first sees the file, the second judges it. */
async function settled(w: World, bw: BuildWatcher): Promise<void> {
  await bw.tick();
  w.now += w.config.build_settle_ms;
  await bw.tick();
}

function openItems(kind: string): string[] {
  return (db.query("SELECT line FROM items WHERE kind = ?1 AND state IN ('open','presented')").all(kind) as { line: string }[]).map((r) => r.line);
}

function eventCount(kind: string): number {
  return (db.query("SELECT COUNT(*) AS n FROM events WHERE kind = ?1").get(kind) as { n: number }).n;
}

describe("build watcher", () => {
  test("a clean build of a merged commit parks an automatic restart, once the file has held still", async () => {
    const w = world();
    const bw = watcher(w);
    await bw.tick();
    expect(w.hashCalls).toBe(0);
    w.now += w.config.build_settle_ms - 1;
    await bw.tick();
    expect(readPending(db)).toBeNull();
    w.now += 1;
    await bw.tick();
    expect(readPending(db)).toMatchObject({ by: "auto", build: NEW, commit: MERGED });
    expect(readJudged(db)).toMatchObject({ build: NEW, verdict: "apply" });
    expect(openItems("build_held")).toHaveLength(0);
  });

  test("a file that changes again restarts the settle clock", async () => {
    const w = world();
    const bw = watcher(w);
    await bw.tick();
    w.now += w.config.build_settle_ms;
    w.key = "k2";
    await bw.tick();
    expect(w.hashCalls).toBe(0);
    w.now += w.config.build_settle_ms;
    await bw.tick();
    expect(readPending(db)).toMatchObject({ build: NEW });
  });

  test("each build is judged once: no second binary check while the file is unchanged, nor after a restart of the watcher", async () => {
    const w = world();
    await settled(w, watcher(w));
    await watcher(w).tick();
    const again = watcher(w);
    await settled(w, again);
    await again.tick();
    expect(w.smokeCalls).toBe(1);
    expect(eventCount("daemon.restart_requested")).toBe(1);
  });

  test("the installed build is the running one: nothing to do, and a held line about an older build closes", async () => {
    const w = world();
    w.smoke = target({ dirty: true });
    await settled(w, watcher(w));
    expect(openItems("build_held")).toHaveLength(1);
    w.build = RUNNING;
    w.key = "k2";
    await settled(w, watcher(w));
    expect(openItems("build_held")).toHaveLength(0);
    expect(readJudged(db)).toBeNull();
    expect(readPending(db)).toBeNull();
  });

  test("a dirty build is held with an info line, never applied", async () => {
    const w = world();
    w.smoke = target({ dirty: true });
    await settled(w, watcher(w));
    expect(readPending(db)).toBeNull();
    expect(openItems("build_held")[0]).toContain("uncommitted changes");
  });

  test("an unstamped build (no commit) is held", async () => {
    const w = world();
    w.smoke = target({ commit: null, dirty: null, source: null });
    await settled(w, watcher(w));
    expect(readPending(db)).toBeNull();
    expect(openItems("build_held")[0]).toContain("no build stamp");
  });

  test("an unmerged commit fetches once and stays held even once origin/main has it", async () => {
    const w = world();
    w.smoke = target({ commit: "feed000" });
    const bw = watcher(w);
    await settled(w, bw);
    expect(w.gitCalls.filter((a) => a.includes("fetch"))).toHaveLength(1);
    expect(w.gitCalls.find((a) => a.includes("fetch"))).toEqual(["-C", "/src/flowryn", "fetch", "--quiet", "origin", "main"]);
    expect(openItems("build_held")[0]).toContain("never applied by itself");
    expect(openItems("build_held")[0]).toContain("rebuild from the default branch");
    await bw.tick();
    expect(readPending(db)).toBeNull();
    w.merged.add("feed000");
    await bw.tick();
    w.now += w.config.build_poll_ms;
    await bw.tick();
    expect(readPending(db)).toBeNull();
    expect(openItems("build_held")).toHaveLength(1);
    expect(w.gitCalls.filter((a) => a.includes("fetch"))).toHaveLength(1);
    expect(w.hashCalls).toBe(1);
  });

  test("a commit the fetch brings in applies at once", async () => {
    const w = world();
    w.smoke = target({ commit: "feed000" });
    w.fetchAdds = ["feed000"];
    await settled(w, watcher(w));
    expect(readPending(db)).toMatchObject({ commit: "feed000" });
  });

  test("the default branch comes from the project whose checkout built it", async () => {
    tx(db, () => db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('fl', 'u', '/src/flowryn', 'trunk', 'no-mistakes')").run());
    const w = world();
    await settled(w, watcher(w));
    expect(w.gitCalls[0]).toContain("refs/remotes/origin/trunk");
  });

  for (const [name, overrides, why] of [
    ["a lower protocol", { proto: 5 }, "protocol 5"],
    ["a lower version", { version: "0.8.9" }, "version 0.8.9"],
    ["an older schema", { schema: 12 }, "schema 12"],
  ] as const) {
    test(`a downgrade (${name}) is refused with a P1 and never parked`, async () => {
      const w = world();
      w.smoke = target(overrides);
      await settled(w, watcher(w));
      expect(readPending(db)).toBeNull();
      expect(openItems("build_refused")[0]).toContain(why);
    });
  }

  test("a build of an older commit with the same version is refused as a downgrade, now that PRs do not bump the version", async () => {
    const w = world();
    w.runningCommit = "d00d000000000000000000000000000000000000";
    w.ancestorsOfRunning.add(MERGED);
    await settled(w, watcher(w));
    expect(readPending(db)).toBeNull();
    expect(openItems("build_refused")[0]).toContain(`its commit is an ancestor of d00d000`);
    expect(readJudged(db)).toMatchObject({ verdict: "refused", reason: "downgrade" });
  });

  test("a build of a newer commit with the same version still applies", async () => {
    const w = world();
    w.runningCommit = "d00d000000000000000000000000000000000000";
    await settled(w, watcher(w));
    expect(readPending(db)).toMatchObject({ build: NEW });
  });

  test("a higher protocol is the normal upgrade", async () => {
    const w = world();
    w.smoke = target({ proto: 7 });
    await settled(w, watcher(w));
    expect(readPending(db)).toMatchObject({ build: NEW });
  });

  test("a build that fails its binary check is refused with a P1", async () => {
    const w = world();
    w.smoke = new FlowrynError("binary_broken", "/d/flowryn failed its smoke check: codesign --verify --strict failed");
    await settled(w, watcher(w));
    expect(readPending(db)).toBeNull();
    expect(openItems("build_refused")[0]).toContain("codesign");
  });

  test("a newer build replaces the line about the one before", async () => {
    const w = world();
    w.smoke = target({ dirty: true });
    await settled(w, watcher(w));
    w.key = "k2";
    w.build = "cccccccccccc";
    w.smoke = target({ proto: 5, build: "cccccccccccc" });
    await settled(w, watcher(w));
    expect(openItems("build_held")).toHaveLength(0);
    expect(openItems("build_refused")).toHaveLength(1);
  });

  test("auto_restart off: the watcher does nothing", async () => {
    const w = world();
    w.config = { ...w.config, auto_restart: "off" };
    await settled(w, watcher(w));
    expect(w.hashCalls).toBe(0);
    expect(readPending(db)).toBeNull();
  });

  test("a development daemon (no build of its own) is never restarted by the watcher", async () => {
    const w = world();
    w.running = null;
    await settled(w, watcher(w));
    expect(w.hashCalls).toBe(0);
  });
});

describe("downgrades and versions", () => {
  test("compareVersions orders x.y.z and treats anything else as equal", () => {
    expect(compareVersions("0.9.0", "0.10.0")).toBe(-1);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
    expect(compareVersions("0.9.0", "0.9.0")).toBe(0);
    expect(compareVersions("dev", "0.9.0")).toBe(0);
  });

  test("an unstamped target with no schema is not called older for it", () => {
    expect(downgradeOf(target({ schema: null }), { version: "0.9.0", proto: 6, schema: 13 })).toBeNull();
  });
});

const withDaemon = (daemon: Record<string, unknown>) => ({ ...defaultConfig("/h"), extra: { daemon } });

describe("[daemon] config", () => {
  test("defaults: merged, 30 s poll, 10 s settle", () => {
    expect(daemonConfig(defaultConfig("/h"))).toEqual({ auto_restart: "merged", build_poll_ms: 30_000, build_settle_ms: 10_000 });
  });

  test("off, and the clocks, are read; an unknown key or mode is refused", () => {
    expect(daemonConfig(withDaemon({ auto_restart: "off", build_poll_ms: 200, build_settle_ms: 300 }))).toEqual({ auto_restart: "off", build_poll_ms: 200, build_settle_ms: 300 });
    expect(() => daemonConfig(withDaemon({ auto_restart: "always" }))).toThrow(/auto_restart must be/);
    expect(() => daemonConfig(withDaemon({ restart: true }))).toThrow(/not a known setting/);
    expect(() => daemonConfig(withDaemon({ build_poll_ms: 0 }))).toThrow(/positive integer/);
  });
});
