import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hashToken, mintToken } from "../../src/api/auth.ts";
import type { Reply } from "../../src/api/envelope.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { requireNotificationsOff } from "../../src/config/leader.ts";
import { stateFiles } from "../../src/config/paths.ts";
import { PING_VERB } from "../../src/daemon/system-verbs.ts";
import { request } from "../../src/transport/unix.ts";
import { ulid } from "../../src/util/ulid.ts";
import { PROTO } from "../../src/version.ts";

export const REPO_ROOT = resolve(import.meta.dir, "../..");
const MAIN = join(REPO_ROOT, "src/main.ts");

/**
 * The test homes' no-mistakes: `axi status` prints $FLOWRYN_HOME/nm-status (a
 * test writes the run it wants the watcher to see), `axi abort` is logged to
 * $FLOWRYN_HOME/nm-abort.log, and every call to $FLOWRYN_HOME/nm-calls.log.
 * Nothing reaches the shared no-mistakes daemon.
 */
const FAKE_NO_MISTAKES = `#!/bin/sh
echo "$*" >> "$FLOWRYN_HOME/nm-calls.log"
case "$1 $2" in
  "axi status") [ -f "$FLOWRYN_HOME/nm-status" ] && cat "$FLOWRYN_HOME/nm-status"; exit 0 ;;
  "axi abort") echo "$*" >> "$FLOWRYN_HOME/nm-abort.log"; exit 0 ;;
esac
exit 0
`;

/**
 * The test homes' lavish-axi: every call is logged to $FLOWRYN_HOME/lavish-calls.log; `poll` waits for
 * the first file in $FLOWRYN_HOME/lavish-queue/*.out (a test writes what the user "sent", in the poll's
 * own output format), claims it by renaming and prints it, or prints `status: waiting` once its
 * --timeout-ms runs out; a queued file named *.fail.out makes the poll
 * fail the way a missing session does. Nothing reaches a real Lavish server or browser.
 */
const FAKE_LAVISH = `#!/bin/sh
echo "$*" >> "$FLOWRYN_HOME/lavish-calls.log"
[ "$1" = "poll" ] || exit 0
q="$FLOWRYN_HOME/lavish-queue"
mkdir -p "$q"
parent=$PPID
ticks=-1
prev=""
for a in "$@"; do [ "$prev" = "--timeout-ms" ] && ticks=$((a / 50)); prev="$a"; done
while :; do
  if [ "$ticks" -eq 0 ]; then printf 'session:\n  status: waiting\n'; exit 0; fi
  [ "$ticks" -gt 0 ] && ticks=$((ticks - 1))
  # Unlike the real one, it ends with its daemon (or its home), so tests leave no process behind.
  kill -0 "$parent" 2>/dev/null || exit 0
  [ -d "$FLOWRYN_HOME" ] || exit 0
  for f in "$q"/*.out; do
    [ -e "$f" ] || continue
    if mv "$f" "$f.taken" 2>/dev/null; then
      cat "$f.taken"
      case "$f" in *.fail.out) exit 1 ;; esac
      exit 0
    fi
  done
  sleep 0.05
done
`;

/** What the stand-in quota-axi prints unless a test writes its own: Claude at 80%, in quota-axi 0.1.37's schema. */
export function quotaJson(percent: number, status = "known"): string {
  return JSON.stringify({
    schemaVersion: 5,
    providers: [
      {
        provider: "claude",
        windows: [
          { id: "five_hour", kind: "session", resetsAt: "2026-10-10T22:00:00+00:00", percentRemaining: Math.min(100, percent + 10) },
          { id: "seven_day", kind: "weekly", resetsAt: "2026-10-11T04:00:00+00:00", percentRemaining: percent },
        ],
        quotaSemantics: { status, effectiveAvailability: [{ scope: "all_models", status, effectivePercentRemaining: percent, limitingWindowIds: ["seven_day"] }] },
      },
    ],
  });
}

/**
 * The test homes' quota-axi: every call is logged to $FLOWRYN_HOME/quota-calls.log; it prints
 * $FLOWRYN_HOME/quota.json when a test wrote one (quotaJson), else Claude at 80%, and exits 1 while
 * $FLOWRYN_HOME/quota.fail exists. Nothing reaches the network or the keychain.
 */
const FAKE_QUOTA = `#!/bin/sh
echo "$*" >> "$FLOWRYN_HOME/quota-calls.log"
if [ -f "$FLOWRYN_HOME/quota.fail" ]; then echo "quota-axi: claude: network unreachable" >&2; exit 1; fi
if [ -f "$FLOWRYN_HOME/quota.json" ]; then cat "$FLOWRYN_HOME/quota.json"; exit 0; fi
cat <<'JSON'
${quotaJson(80)}
JSON
`;

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
  /** A directory to create as the home (it must not exist) in place of a fresh one under the temp directory. */
  home?: string;
}

/** A throwaway Flowryn home: config.toml, data and state directories, short enough for a socket path. */
export function makeHome(options: HomeOptions = {}): TestHome {
  const home = options.home ?? mkdtempSync(join(tmpdir(), "fw-"));
  if (options.home) mkdirSync(home, { mode: 0o700 });
  const extraConfig = typeof options.extraConfig === "function" ? options.extraConfig(home) : (options.extraConfig ?? "");
  const dataDir = join(home, "data");
  const stateDir = join(home, "state");
  const backlog = join(dataDir, "backlog.md");
  const todos = join(dataDir, "todos.md");
  const node = Bun.which("node");
  const git = Bun.which("git");
  // Tests never reach the real no-mistakes (a shared daemon) or gh (a real login): stand-ins answer instead.
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const noMistakes = join(bin, "no-mistakes");
  writeFileSync(noMistakes, FAKE_NO_MISTAKES);
  chmodSync(noMistakes, 0o755);
  const lavish = join(bin, "lavish-axi");
  writeFileSync(lavish, FAKE_LAVISH);
  chmodSync(lavish, 0o755);
  // Nor the real quota-axi (the network and the keychain): the scheduler and doctor read this one.
  const quota = join(bin, "quota-axi");
  writeFileSync(quota, FAKE_QUOTA);
  chmodSync(quota, 0o755);
  const gh = join(bin, "gh-absent");
  writeFileSync(gh, "#!/bin/sh\necho 'gh is not available in tests' >&2\nexit 1\n");
  chmodSync(gh, 0o755);
  // Nor a real harness: unless a test brings its own stand-in, `claude` and `pi` answer no version (so the
  // daemon's startup check of the harnesses in use finds none installed, whatever this machine has on PATH).
  const noHarness = join(bin, "harness-absent");
  writeFileSync(noHarness, "#!/bin/sh\necho 'no harness in this test' >&2\nexit 1\n");
  chmodSync(noHarness, 0o755);
  const harnessStandIns = ["claude", "pi"].filter((name) => !new RegExp(`^${name}\\s*=`, "m").test(extraConfig)).map((name) => `${name} = ${JSON.stringify(noHarness)}`);
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
    `no_mistakes = ${JSON.stringify(noMistakes)}`,
    `gh = ${JSON.stringify(gh)}`,
    ...(/^lavish_axi\s*=/m.test(extraConfig) ? [] : [`lavish_axi = ${JSON.stringify(lavish)}`]),
    ...(/^quota_axi\s*=/m.test(extraConfig) ? [] : [`quota_axi = ${JSON.stringify(quota)}`]),
    ...harnessStandIns,
    extraConfig,
  ];
  // Nor GitHub: a forge address that answers nothing unless a test serves a fake one.
  if (!extraConfig.includes("[github]")) lines.push("[github]", 'api_url = "http://127.0.0.1:9"');
  // Nor this machine's memory and load: the host check passes unless a test sets its own (a probe, or limits).
  if (!extraConfig.includes("[capacity.host]")) lines.push("[capacity.host]", "min_free_mem_gb = 0", "max_load_per_core = 1000");
  // Tests never reach a real Herdr: without a socket of their own they get one that does not exist. Such a
  // home has no Herdr by design, so its "Herdr unreachable" P1 (design section 16) is kept out of its items.
  // Nor this machine's Claude transcripts: a chat-answer grant is checked against the fake leader's transcript in the home.
  if (!extraConfig.includes("[grants]")) lines.push("[grants]", `claude_projects_dir = ${JSON.stringify(join(home, "claude-projects"))}`);
  if (!extraConfig.includes("[herdr]")) lines.push("[herdr]", `socket = ${JSON.stringify(join(home, "no-herdr.sock"))}`, "unreachable_alert_ms = 86400000");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "config.toml"), lines.join("\n") + "\n");
  // No daemon the tests start ever delivers a notification (FLOWRYN_NOTIFY=off, which startDaemon requires);
  // behind it, the macOS channel only records, never runs osascript, and review pages are recorded to
  // browser-opens.log, never opened (FLOWRYN_OPENER; src/lavish/opener.ts).
  // TZ=UTC: bun test pins the test file's own clock to UTC regardless of TZ, but a daemon/CLI spawned via
  // Bun.spawn runs in the box's real local zone unless told otherwise, so every spawned process agrees with
  // bun test's own "today" at any hour (see test/unit/tz.test.ts).
  const env = { ...cleanEnv(), FLOWRYN_HOME: home, FLOWRYN_NOTIFY: "off", FLOWRYN_NOTIFIER: `record:${join(home, "notified.jsonl")}`, FLOWRYN_OPENER: `record:${join(home, "browser-opens.log")}`, TZ: "UTC" };
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

/**
 * A project, task policy and live run, as a dispatch creates them, with the
 * task In flight in the backlog: the reconciler's invariant (design section 8)
 * holds, so a daemon started on this home raises no divergence about it.
 */
export function seedRun(h: TestHome, taskId = "web-fix-a1", runId = "r01TEST"): SeededRun {
  const added = Bun.spawnSync([realTasksAxi(), "add", taskId, taskId, "--kind", "ship", "--repo", "web", "--start", "--file", h.backlog, "--json"], { stdin: "ignore", env: process.env });
  if (added.exitCode !== 0) throw new Error(`tasks-axi add ${taskId} failed: ${added.stdout.toString()}${added.stderr.toString()}`);
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

/**
 * A daemon call as your own terminal (channel tty) or with a token, the way
 * `flowryn approve` makes it. Pass `channel: null` explicitly to simulate an
 * anonymous, token-less, non-tty caller (a gate process, a script).
 */
export async function daemonCall(home: string, verb: string, args: Record<string, unknown>, token: string | null = null, channel: "tty" | null = token ? null : "tty"): Promise<Reply> {
  return (await request(join(home, "run", "flowrynd.sock"), { proto: PROTO, ulid: ulid(), verb, token, channel, args }, { connectMs: 1_000, replyMs: 120_000 })) as Reply;
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

/**
 * Start flowrynd as a subprocess and wait until it answers the handshake;
 * refused without FLOWRYN_NOTIFY=off. `program` runs another command (a
 * compiled binary's `daemon run`) in place of the source.
 */
export async function startDaemon(h: TestHome, extraEnv: Record<string, string> = {}, program: string[] = ["bun", MAIN, "daemon", "run"]): Promise<DaemonProc> {
  const env = { ...h.env, ...extraEnv, FLOWRYN_LOG_STDERR: "1" };
  requireNotificationsOff(env, "the test harness");
  const proc = Bun.spawn(program, {
    cwd: REPO_ROOT,
    env,
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

/**
 * Supervise a home's daemon with a script instead of launchd (FLOWRYN_SUPERVISOR,
 * for `flowryn daemon restart`): it stops the old daemon with SIGTERM, as
 * `launchctl kickstart -k` does, and starts the next one in the background,
 * recording its pid in next-daemon.pid (`killNextDaemon` stops it). `program`
 * is the launchd target the binary check runs. Returns the daemon's env.
 */
export function superviseWithScript(h: TestHome, program: string[] = ["bun", MAIN, "daemon", "run"]): Record<string, string> {
  const script = join(h.home, "supervisor.sh");
  writeFileSync(
    script,
    `#!/bin/sh
kill -TERM "$FLOWRYN_DAEMON_PID"
while kill -0 "$FLOWRYN_DAEMON_PID" 2>/dev/null; do sleep 0.05; done
cd ${JSON.stringify(REPO_ROOT)}
FLOWRYN_LOG_STDERR=1 bun ${JSON.stringify(MAIN)} daemon run >> ${JSON.stringify(join(h.home, "next-daemon.log"))} 2>&1 &
echo $! > ${JSON.stringify(join(h.home, "next-daemon.pid"))}
`,
  );
  chmodSync(script, 0o755);
  const file = join(h.home, "supervisor.json");
  writeFileSync(file, JSON.stringify({ program, restart: [script] }));
  return { FLOWRYN_SUPERVISOR: file };
}

/** Stop a daemon the script supervisor started, if any. */
export function killNextDaemon(h: TestHome): void {
  const file = join(h.home, "next-daemon.pid");
  if (!existsSync(file)) return;
  try {
    process.kill(Number(readFileSync(file, "utf8").trim()), "SIGKILL");
  } catch {
    // already gone
  }
}
