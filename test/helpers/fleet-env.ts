import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tx, type Db } from "../../src/db/db.ts";
import type { Timing } from "../../src/config/workers.ts";
import type { RunRow } from "../../src/lifecycle/runs.ts";
import { FakeHerdr } from "./fake-herdr.ts";
import { cli, cliJson, makeHome, seedLeader, startDaemon, waitUntil, type CliOptions, type DaemonProc, type RunResult, type TestHome } from "./harness.ts";

/** Fast clocks for the reconciler, so recovery paths finish in seconds. */
export const FAST_TIMING: Partial<Timing> = {
  pass_ms: 250,
  trust_wedge_ms: 2_000,
  ring_interval_ms: 1_000,
  max_rings: 3,
  wait_poll_ms: 1_000,
  launch_timeout_ms: 8_000,
  exit_grace_ms: 1_500,
};

export const FAKE_VERSION = "9.9.9";

export interface FleetEnv {
  h: TestHome;
  herdr: FakeHerdr;
  repo: string;
  /** The bare origin, when the fleet has one. */
  origin: string | null;
  leader: string;
  daemon: DaemonProc;
  claudeStore: string;
  cli(args: string[], options?: CliOptions): Promise<RunResult>;
  json(args: string[], options?: CliOptions): Promise<{ code: number; reply: Record<string, unknown>; stderr: string }>;
  dispatch(body: string, options?: { kind?: "ship" | "scout"; harness?: "claude" | "pi" }): Promise<{ task: string; run: string }>;
  run(runId: string): RunRow;
  events(runId: string): string[];
  waitRun(runId: string, predicate: (run: RunRow) => boolean, what: string, timeoutMs?: number): Promise<RunRow>;
  restartDaemon(): Promise<void>;
  cleanup(): Promise<void>;
}

function git(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdin: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
}

/** A scratch repository with one commit on main. */
export function makeRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), "scratch project\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

/** A stand-in harness binary that only answers --version. */
function versionScript(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho "${FAKE_VERSION} (fake ${name})"\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A bare "origin" with one commit on main, and a clone of it as the project's primary checkout. */
export function makeOriginRepo(dir: string): { origin: string; repo: string } {
  const origin = join(dir, "origin.git");
  const seed = join(dir, "seed");
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "--bare", "-b", "main", origin]);
  makeRepo(seed);
  git(seed, ["push", "-q", origin, "main"]);
  const repo = join(dir, "repo");
  git(dir, ["clone", "-q", origin, repo]);
  return { origin, repo };
}

export interface FleetOptions {
  timing?: Partial<Timing>;
  contracts?: boolean;
  /** The project's delivery mode (default local-only). */
  mode?: "local-only" | "direct-PR" | "no-mistakes";
  /** Give the project a bare origin (a clone of it is the primary checkout) and a GitHub repo URL, acme/web. */
  origin?: boolean;
  /** More config after the fleet's own sections ([github], [cleanup], [leader], ...). */
  extraConfig?: string;
  yolo?: boolean;
}

export async function makeFleetEnv(options: FleetOptions = {}): Promise<FleetEnv> {
  const timing = { ...FAST_TIMING, ...options.timing };
  const h = makeHome({
    extraConfig: (home) => {
      const bin = join(home, "bin");
      mkdirSync(bin, { recursive: true });
      return [
        `claude = ${JSON.stringify(versionScript(bin, "claude"))}`,
        `pi = ${JSON.stringify(versionScript(bin, "pi"))}`,
        "[herdr]",
        `socket = ${JSON.stringify(join(home, "herdr.sock"))}`,
        "[workers]",
        `worktree_root = ${JSON.stringify(join(home, "wt"))}`,
        "[workers.claude]",
        'pretrust = "register"',
        `config_dir = ${JSON.stringify(join(home, "claude-config"))}`,
        "[reconcile]",
        ...Object.entries(timing).map(([k, v]) => `${k} = ${v}`),
        options.extraConfig ?? "",
      ].join("\n");
    },
  });
  const home = h.home;
  const store = join(home, "claude-config");
  mkdirSync(store, { recursive: true });
  const logDir = join(home, "harness-logs");
  mkdirSync(logDir, { recursive: true });
  const herdr = await FakeHerdr.start(join(home, "herdr.sock"), { env: h.env, logDir });
  const leader = seedLeader(h);
  if (options.contracts !== false) {
    const db = h.db();
    tx(db, () => {
      for (const harness of ["claude", "pi"]) db.query("INSERT OR IGNORE INTO harness_contracts (harness, version, passed_at) VALUES (?1, ?2, ?3)").run(harness, FAKE_VERSION, Date.now());
    });
    db.close();
  }
  const origin = options.origin ? makeOriginRepo(join(home, "proj")) : null;
  const repo = origin ? origin.repo : makeRepo(join(home, "repo"));
  let daemon = await startDaemon(h);
  const env = { FLOWRYN_TOKEN: leader };
  const addArgs = ["project", "add", repo, "--id", "web", "--mode", options.mode ?? "local-only"];
  if (origin) addArgs.push("--repo-url", "https://github.com/acme/web.git");
  if (options.yolo) addArgs.push("--yolo");
  const added = await cliJson(h, addArgs, { env });
  if (added.code !== 0) throw new Error(`project add failed: ${JSON.stringify(added.reply)}`);

  const withDb = <T>(fn: (db: Db) => T): T => {
    const db = h.db();
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };
  const fleet: FleetEnv = {
    h,
    herdr,
    repo,
    origin: origin?.origin ?? null,
    leader,
    get daemon() {
      return daemon;
    },
    claudeStore: store,
    cli: (args, opts = {}) => cli(h, args, { ...opts, env: { ...env, ...opts.env } }),
    json: (args, opts = {}) => cliJson(h, args, { ...opts, env: { ...env, ...opts.env } }),
    async dispatch(body, opts = {}) {
      const result = await cliJson(h, ["dispatch", "web", "--kind", opts.kind ?? "scout", "--harness", opts.harness ?? "claude", "--body-file", "-"], { env, stdin: body });
      if (result.code !== 0) throw new Error(`dispatch failed (${result.code}): ${JSON.stringify(result.reply)}`);
      const data = result.reply.data as { task: string; run: string };
      return { task: data.task, run: data.run };
    },
    run: (runId) => withDb((db) => db.query("SELECT * FROM runs WHERE id = ?1").get(runId) as RunRow),
    events: (runId) => withDb((db) => (db.query("SELECT kind FROM events WHERE run_id = ?1 ORDER BY seq").all(runId) as { kind: string }[]).map((e) => e.kind)),
    async waitRun(runId, predicate, what, timeoutMs = 20_000) {
      let last: RunRow | null = null;
      try {
        await waitUntil(() => {
          last = fleet.run(runId);
          return last !== null && predicate(last);
        }, timeoutMs, what);
      } catch (error) {
        throw new Error(`${(error as Error).message}; run: ${JSON.stringify(last)}; events: ${fleet.events(runId).join(",")}`, { cause: error });
      }
      return last!;
    },
    async restartDaemon() {
      daemon = await startDaemon(h);
    },
    async cleanup() {
      await daemon.kill9().catch(() => {});
      await herdr.stop().catch(() => {});
      if (process.env.FLOWRYN_TEST_KEEP === "1") process.stderr.write(`kept test home: ${h.home}\n`);
      else h.cleanup();
    },
  };
  return fleet;
}
