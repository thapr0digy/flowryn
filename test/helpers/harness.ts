import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hashToken, mintToken } from "../../src/api/auth.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { stateFiles } from "../../src/config/paths.ts";
import { PING_VERB } from "../../src/daemon/system-verbs.ts";
import { request } from "../../src/transport/unix.ts";
import { ulid } from "../../src/util/ulid.ts";
import { PROTO } from "../../src/version.ts";

export const REPO_ROOT = resolve(import.meta.dir, "../..");
const MAIN = join(REPO_ROOT, "src/main.ts");

/** The real tasks-axi. The journal tests run against it, never a reimplementation. */
export function realTasksAxi(): string {
  const found = process.env.FLOWRYN_TEST_TASKS_AXI ?? Bun.which("tasks-axi");
  if (!found) throw new Error("tests need tasks-axi on PATH: npm install -g tasks-axi@0.2.5");
  return found;
}

export interface TestHome {
  home: string;
  stateDir: string;
  dataDir: string;
  backlog: string;
  todos: string;
  env: Record<string, string>;
  db(): Db;
  cleanup(): void;
}

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("FLOWRYN_") || key.startsWith("CLAUDE_CODE_") || key === "CLAUDECODE") continue;
    env[key] = value;
  }
  return env;
}

export interface HomeOptions {
  tasksAxi?: string;
  /** Appended after [tools]; lines before its first table header add tools. A function gets the home path. */
  extraConfig?: string | ((home: string) => string);
}

/** A throwaway Flowryn home: config.toml, data and state directories, short enough for a socket path. */
export function makeHome(options: HomeOptions = {}): TestHome {
  const home = mkdtempSync(join(tmpdir(), "fw-"));
  const extraConfig = typeof options.extraConfig === "function" ? options.extraConfig(home) : (options.extraConfig ?? "");
  const dataDir = join(home, "data");
  const stateDir = join(home, "state");
  const backlog = join(dataDir, "backlog.md");
  const todos = join(dataDir, "todos.md");
  const node = Bun.which("node");
  const git = Bun.which("git");
  const lines = [
    `data_dir = ${JSON.stringify(dataDir)}`,
    `state_dir = ${JSON.stringify(stateDir)}`,
    "[tasks]",
    `backlog = ${JSON.stringify(backlog)}`,
    `todos = ${JSON.stringify(todos)}`,
    "[tools]",
    `tasks_axi = ${JSON.stringify(options.tasksAxi ?? realTasksAxi())}`,
    ...(node ? [`node = ${JSON.stringify(node)}`] : []),
    ...(git ? [`git = ${JSON.stringify(git)}`] : []),
    extraConfig,
  ];
  // Tests never reach a real Herdr: without a socket of their own they get one that does not exist.
  if (!extraConfig.includes("[herdr]")) lines.push("[herdr]", `socket = ${JSON.stringify(join(home, "no-herdr.sock"))}`);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "config.toml"), lines.join("\n") + "\n");
  const env = { ...cleanEnv(), FLOWRYN_HOME: home };
  return {
    home,
    stateDir,
    dataDir,
    backlog,
    todos,
    env,
    db() {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const db = openDb(stateFiles(stateDir).db);
      migrate(db);
      return db;
    },
    cleanup() {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Give the home a leader lease and return its token (the lease manager itself is M3). */
export function seedLeader(h: TestHome): string {
  const token = mintToken("leader");
  const db = h.db();
  tx(db, () => {
    db.query("INSERT OR REPLACE INTO leader_lease (id, session_id, harness, epoch, token_hash, claimed_at, heartbeat_at) VALUES (1, 'test-session', 'claude', 1, ?1, ?2, ?2)").run(
      hashToken(token),
      Date.now(),
    );
  });
  db.close();
  return token;
}

export interface SeededRun {
  runId: string;
  taskId: string;
  token: string;
}

/** A project, task policy and live run, as M2's dispatch will create them. */
export function seedRun(h: TestHome, taskId = "web-fix-a1", runId = "r01TEST"): SeededRun {
  const token = mintToken("run");
  const db = h.db();
  const now = Date.now();
  tx(db, () => {
    db.query("INSERT OR IGNORE INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', 'https://example.test/web.git', '/tmp/web', 'main', 'no-mistakes')").run();
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES (?1, 'web', 'ship', 'no-mistakes', 0, 'fix', ?2)").run(taskId, now);
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
       VALUES (?1, ?2, 'claude', '2.1.281', 'running', 'busy', 'fix', 'build', '/tmp/wt', 'fm/x', 'abc123', ?3, ?4, ?4)`,
    ).run(runId, taskId, hashToken(token), now);
  });
  db.close();
  return { runId, taskId, token };
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CliOptions {
  env?: Record<string, string>;
  stdin?: string;
}

/** Run the CLI as a subprocess, the way agents and hooks do. */
export async function cli(h: TestHome, args: string[], options: CliOptions = {}): Promise<RunResult> {
  const proc = Bun.spawn(["bun", MAIN, ...args], {
    cwd: REPO_ROOT,
    env: { ...h.env, ...options.env },
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

export async function cliJson(h: TestHome, args: string[], options: CliOptions = {}): Promise<{ code: number; reply: Record<string, unknown>; stderr: string }> {
  const result = await cli(h, [...args, "--json"], options);
  let reply: Record<string, unknown>;
  try {
    reply = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`not JSON (exit ${result.code}): ${result.stdout}\n${result.stderr}`);
  }
  return { code: result.code, reply, stderr: result.stderr };
}

export async function pingSocket(h: TestHome): Promise<boolean> {
  try {
    await request(join(h.home, "run", "flowrynd.sock"), { proto: PROTO, ulid: ulid(), verb: PING_VERB, args: {} }, { connectMs: 300, replyMs: 2_000 });
    return true;
  } catch {
    return false;
  }
}

export interface DaemonProc {
  pid: number;
  exited: Promise<number>;
  kill9(): Promise<void>;
  stop(): Promise<number>;
  output(): Promise<string>;
}

export async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
}

/** Start flowrynd as a subprocess and wait until it answers the handshake. */
export async function startDaemon(h: TestHome, extraEnv: Record<string, string> = {}): Promise<DaemonProc> {
  const proc = Bun.spawn(["bun", MAIN, "daemon", "run"], {
    cwd: REPO_ROOT,
    env: { ...h.env, ...extraEnv, FLOWRYN_LOG_STDERR: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(proc.stderr).text();
  const daemon: DaemonProc = {
    pid: proc.pid,
    exited: proc.exited,
    async kill9() {
      proc.kill(9);
      await proc.exited;
    },
    async stop() {
      proc.kill("SIGTERM");
      return proc.exited;
    },
    output: () => stderr,
  };
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await pingSocket(h)) return daemon;
    if (proc.exitCode !== null) throw new Error(`flowrynd exited ${proc.exitCode}: ${await stderr}`);
    await Bun.sleep(50);
  }
  proc.kill(9);
  throw new Error(`flowrynd did not answer: ${await stderr}`);
}

/**
 * A tasks-axi wrapper that can pause a mutation before or after the real
 * tasks-axi runs, to open a precise window for kill -9. Control files live in
 * `ctlDir`: `pause-before` or `pause-after` arm a pause, `pause-at` limits it
 * to the Nth mutation, `release` ends it. The wrapper records its pid.
 */
export function makePausingTasksAxi(dir: string): { path: string; ctl: string } {
  const ctl = join(dir, "ctl");
  mkdirSync(ctl, { recursive: true });
  const path = join(dir, "tasks-axi-pausing");
  const script = `#!/bin/sh
CTL=${JSON.stringify(ctl)}
REAL=${JSON.stringify(realTasksAxi())}
case "$1" in list|show|--version|-v) exec "$REAL" "$@" ;; esac
echo "$*" >> "$CTL/calls.log"
n=$(grep -c . "$CTL/calls.log")
armed=1
if [ -f "$CTL/pause-at" ] && [ "$(cat "$CTL/pause-at")" != "$n" ]; then armed=0; fi
wait_release() { echo $$ > "$CTL/wrapper.pid"; touch "$CTL/$1"; while [ ! -f "$CTL/release" ]; do sleep 0.05; done; }
if [ $armed = 1 ] && [ -f "$CTL/pause-before" ]; then wait_release in-before; fi
"$REAL" "$@"
rc=$?
if [ $armed = 1 ] && [ -f "$CTL/pause-after" ]; then wait_release in-after; fi
exit $rc
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return { path, ctl };
}

export function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}
