import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tx, type Db } from "../../src/db/db.ts";
import { contractRevision } from "../../src/contracts/revision.ts";
import { HARNESS_IDS } from "../../src/harness/types.ts";
import type { Timing } from "../../src/config/workers.ts";
import type { RunRow } from "../../src/lifecycle/runs.ts";
import { FakeHerdr, type FakeHerdrOptions } from "./fake-herdr.ts";
import { cli, cliJson, killNextDaemon, makeHome, seedLeader, startDaemon, superviseWithScript, waitUntil, type CliOptions, type DaemonProc, type RunResult, type TestHome } from "./harness.ts";

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
  readonly herdr: FakeHerdr;
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
  /** Herdr goes away (its server stops, and with it every harness in its panes), and comes back on the same socket. */
  stopHerdr(): Promise<void>;
  startHerdr(): Promise<void>;
  /** The user answered the dialog: the fake screen is gone (the fake worker carries on). */
  clearScreen(runId: string): void;
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

/** Where the stand-in harnesses log each ask's print-mode call (test/helpers/fake-ask.ts). */
export function askCallLog(home: string): string {
  return join(home, "ask-calls.jsonl");
}

/**
 * A stand-in harness binary that answers --version, and plays an ask's
 * print-mode call (`-p`) with test/helpers/fake-ask.ts. Written beside the
 * path and renamed over it, as an installer replaces a binary: macOS now and
 * then SIGKILLs the exec of an executed file rewritten in place.
 */
function versionScript(dir: string, name: string, version = FAKE_VERSION): string {
  const path = join(dir, name);
  const staged = `${path}.new`;
  const ask = `if [ "$1" = "-p" ]; then exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dir, "fake-ask.ts"))} ${name} ${JSON.stringify(askCallLog(join(dir, "..")))} "$@"; fi\n`;
  writeFileSync(staged, `#!/bin/sh\n${ask}echo "${version} (fake ${name})"\n`);
  chmodSync(staged, 0o755);
  renameSync(staged, path);
  return path;
}

/** The harness "updated": its stand-in binary now answers another version (design section 16). */
export function setHarnessVersion(h: TestHome, harness: "claude" | "pi", version: string): void {
  versionScript(join(h.home, "bin"), harness, version);
}

/**
 * A stand-in docker: `docker ps` prints the containers the fake workers
 * started (`FAKE: docker-up`), one line each in the format the reconciler
 * asks for. With `docker-silent` in the home it never answers: it starts a
 * sleeper holding its stdout (its pid in docker-silent.pid) and waits on it.
 * Nothing reaches a real Docker.
 */
export function dockerScript(dir: string, home: string): string {
  const path = join(dir, "docker");
  const silent = JSON.stringify(join(home, "docker-silent"));
  const silentGuard = `if [ -f ${silent} ]; then\n  sleep 600 &\n  echo $! > ${JSON.stringify(join(home, "docker-silent.pid"))}\n  wait\nfi\n`;
  // docker-helper: leave a helper running that holds both streams (as docker's credential helpers can), and flood stderr, then answer.
  const helper = JSON.stringify(join(home, "docker-helper"));
  const helperGuard = `if [ -f ${helper} ]; then\n  sleep 600 &\n  echo $! > ${JSON.stringify(join(home, "docker-helper.pid"))}\n  head -c 20000000 /dev/zero >&2\nfi\n`;
  writeFileSync(path, `#!/bin/sh\n${silentGuard}${helperGuard}case "$1" in\n  ps) [ -f ${JSON.stringify(join(home, "docker-ps.txt"))} ] && cat ${JSON.stringify(join(home, "docker-ps.txt"))}; exit 0 ;;\nesac\nexit 1\n`);
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
  /** The contract revision the seeded passes carry (default this build's; another one is a stale pass). */
  contractsAt?: number;
  /** The project's delivery mode (default local-only). */
  mode?: "local-only" | "direct-PR" | "no-mistakes";
  /** Give the project a bare origin (a clone of it is the primary checkout) and a GitHub repo URL, acme/web. */
  origin?: boolean;
  /** More config after the fleet's own sections ([github], [cleanup], [leader], ...). */
  extraConfig?: string;
  /** The scope the seeded leader leads (default: the implicit one, which a config with scopes moves to its default). */
  leaderScope?: string;
  /** More [tools] lines (`name = "path"`); one naming lavish_axi or quota_axi replaces the home's stand-in. */
  tools?: string[];
  yolo?: boolean;
  /** [herdr] unreachable_alert_ms: how long Herdr may be away before its P1. */
  herdrAlertMs?: number;
  /** How the first fake Herdr answers events.subscribe (FakeHerdr.subscribeReply). */
  herdrSubscribe?: FakeHerdr["subscribeReply"];
  /** Supervise the daemon with a script, so `flowryn daemon restart` works (superviseWithScript). */
  supervised?: boolean;
  /** [workers] turn_end_guard (default on). */
  turnEndGuard?: boolean;
  /** The fake Herdr starts these scripts in place of the FAKE: worker, per harness kind. */
  harnessScripts?: FakeHerdrOptions["harnessScripts"];
  /** The fake Herdr server's own shell shows this startup prompt and eats the first typed character (FakeHerdrOptions.serverShellPrompt). */
  herdrShellPrompt?: string;
  /** Run the daemon from this command (a compiled binary's `daemon run`) rather than the source. */
  daemonProgram?: string[];
  /** More environment for the daemon. */
  daemonEnv?: Record<string, string>;
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
        `docker = ${JSON.stringify(dockerScript(bin, home))}`,
        ...(options.tools ?? []),
        "[herdr]",
        `socket = ${JSON.stringify(join(home, "herdr.sock"))}`,
        ...(options.herdrAlertMs ? [`unreachable_alert_ms = ${options.herdrAlertMs}`] : []),
        "[workers]",
        `worktree_root = ${JSON.stringify(join(home, "wt"))}`,
        ...(options.turnEndGuard === false ? ["turn_end_guard = false"] : []),
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
  const herdrOptions = { env: h.env, logDir, harnessScripts: options.harnessScripts, serverShellPrompt: options.herdrShellPrompt };
  let herdr = await FakeHerdr.start(join(home, "herdr.sock"), herdrOptions);
  if (options.herdrSubscribe) herdr.subscribeReply = options.herdrSubscribe;
  let herdrUp = true;
  const leader = seedLeader(h, options.leaderScope);
  if (options.contracts !== false) {
    const db = h.db();
    tx(db, () => {
      for (const harness of HARNESS_IDS) {
        db.query("INSERT OR IGNORE INTO harness_contracts (harness, version, revision, passed_at) VALUES (?1, ?2, ?3, ?4)").run(harness, FAKE_VERSION, options.contractsAt ?? contractRevision(harness), Date.now());
      }
    });
    db.close();
  }
  const origin = options.origin ? makeOriginRepo(join(home, "proj")) : null;
  const repo = origin ? origin.repo : makeRepo(join(home, "repo"));
  const daemonEnv = { ...(options.supervised ? superviseWithScript(h) : {}), ...options.daemonEnv };
  let daemon = await startDaemon(h, daemonEnv, options.daemonProgram);
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
    get herdr() {
      return herdr;
    },
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
      daemon = await startDaemon(h, daemonEnv, options.daemonProgram);
    },
    async stopHerdr() {
      herdrUp = false;
      await herdr.stop();
    },
    async startHerdr() {
      herdr = await FakeHerdr.start(join(home, "herdr.sock"), herdrOptions);
      herdrUp = true;
    },
    clearScreen(runId) {
      const r = fleet.run(runId);
      rmSync(join(h.dataDir, r.task_id, "fake-screen.txt"), { force: true });
      if (r.pane_id) herdr.screens.delete(r.pane_id);
    },
    async cleanup() {
      await daemon.kill9().catch(() => {});
      killNextDaemon(h);
      if (herdrUp) await herdr.stop().catch(() => {});
      if (process.env.FLOWRYN_TEST_KEEP === "1") process.stderr.write(`kept test home: ${h.home}\n`);
      else h.cleanup();
    },
  };
  return fleet;
}
