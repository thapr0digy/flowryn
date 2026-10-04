#!/usr/bin/env bun
/**
 * The cutover live run. Run it through scripts/lab/cutover-live.sh, which owns
 * the Herdr lab session. Phases, in order (all by default):
 *
 *   decisions  a real Claude scout delivers a report whose `## Open
 *              decisions` section raises three standalone decisions, one
 *              `Reserved: lab`; the leader answers two with --rationale, the
 *              user's own shell (the human role) answers the reserved one;
 *              and a `--blocked-by <task> --auto` ship gets a run once its
 *              blocker (one of the leader-answered decisions) lands.
 *   prompt     a real Claude worker whose branch carries an extra
 *              `.claude/settings.json`, outside anything Flowryn itself
 *              writes, with a PreToolUse hook that forces an "ask" decision
 *              for any `git commit --amend` command; its task is told to run
 *              exactly that command, and the run must open one
 *              `blocked_prompt` item naming "amend" within 120 s, with no
 *              `worker_idle` item alongside.
 *
 * Both phases run in a scratch Flowryn home with its own scratch daemon
 * (FLOWRYN_NOTIFY=off, requireNotificationsOff before it starts), so nothing
 * here ever touches ~/.flowryn. The Claude project is a linked worktree of
 * THIS checkout (one more worktree of a worktree, the same shape M2's live
 * run proved: trust.ts canonicalizes through every level to the one primary
 * checkout), which only works because this checkout is already Claude-trusted
 * (you are reading this file through it); `[workers.claude] pretrust =
 * "check"` never writes ~/.claude.json even so. A scratch Claude config
 * directory was tried first and rejected: CLAUDE_CONFIG_DIR isolates
 * credentials too, so a fresh one hits Claude's own login flow before
 * anything else runs (recorded under "Live runs" below). Every worker branch
 * carries this run's own `flowryn/contract-<runid>-` prefix (`[workers]
 * branch_prefix`), and every worktree and branch this run adds to this
 * checkout is removed by exact name on exit, the same guard
 * `src/contracts/cleanup.ts` gives the other live scripts. Results go to
 * stdout and $CUTOVER_RESULTS. Clean up removes the scratch home (--keep
 * leaves it for inspection).
 */
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { hashToken, mintToken } from "../../src/api/auth.ts";
import { requireNotificationsOff } from "../../src/config/leader.ts";
import { renderToml } from "../../src/config/toml.ts";
import { contractPrefix, removeOwnWorktrees, type CreatedWorktree } from "../../src/contracts/cleanup.ts";
import { migrate, openDb, tx } from "../../src/db/db.ts";
import { HerdrClient } from "../../src/runtime/herdr/client.ts";
import { HerdrRuntime } from "../../src/runtime/herdr/runtime.ts";
import { request } from "../../src/transport/unix.ts";
import { ulid } from "../../src/util/ulid.ts";
import { PROTO } from "../../src/version.ts";

const ROOT = resolve(import.meta.dir, "../..");
const MAIN = join(ROOT, "src/main.ts");
const { values, positionals } = parseArgs({
  options: { "herdr-socket": { type: "string" }, session: { type: "string" }, keep: { type: "boolean" } },
  allowPositionals: true,
});
const herdrSocket = values["herdr-socket"];
const labSession = values.session ?? "";
if (!herdrSocket || !labSession.startsWith("fm-lab-")) {
  console.error("cutover-live: run me through scripts/lab/cutover-live.sh (a lab session socket is required)");
  process.exit(2);
}
const PHASES = ["decisions", "prompt"];
const phases = positionals.length > 0 ? positionals : PHASES;
for (const p of phases) if (!PHASES.includes(p)) throw new Error(`unknown phase ${p}`);

const which = (name: string) => Bun.which(name) ?? "";
const PI_BIN = process.env.PI_BIN ?? (existsSync("/opt/homebrew/bin/pi-signed") ? "/opt/homebrew/bin/pi-signed" : which("pi"));
const PI_MODEL = "flowryn-scripted/scripted";
const CLAUDE_MODEL = process.env.CUTOVER_CLAUDE_MODEL ?? "haiku";

const home = realpathSync(mkdtempSync(join(tmpdir(), "fwc-")));
const piAgent = join(home, "pi-agent");
mkdirSync(piAgent, { recursive: true });
const { runId, prefix: runPrefix } = contractPrefix();

function git(args: string[], cwd: string): { code: number; out: string } {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: (r.exitCode === 0 ? r.stdout : r.stderr).toString().trim() };
}
function mustGit(args: string[], cwd: string): string {
  const r = git(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} (in ${cwd}): ${r.out}`);
  return r.out;
}

/** A disposable Pi project: a fresh clone of this repository, never a worktree of it. */
function clone(name: string): { path: string; branch: string } {
  const path = join(home, name);
  const cloned = Bun.spawnSync(["git", "clone", "--quiet", "--no-hardlinks", ROOT, path], { stdin: "ignore" });
  if (cloned.exitCode !== 0) throw new Error(`git clone failed: ${cloned.stderr.toString()}`);
  return { path, branch: Bun.spawnSync(["git", "-C", path, "branch", "--show-current"]).stdout.toString().trim() };
}
const piRepo = clone("repo-pi");

const createdWorktrees: CreatedWorktree[] = [];
/**
 * A linked worktree of THIS checkout on its own `flowryn/contract-<runid>-main`
 * branch, with a committed `.claude/settings.json` carrying the "prompt"
 * phase's extra PreToolUse hook (spike c12's shape: "ask" for a `git commit
 * --amend` command only), so every task worktree Flowryn checks out from this
 * branch inherits that file too, outside Flowryn's own per-run --settings.
 */
function trustedWorktree(): { path: string; branch: string } {
  const branch = `${runPrefix}main`;
  const path = join(home, "wt", "trusted-main");
  mkdirSync(join(home, "wt"), { recursive: true });
  createdWorktrees.push({ branch, worktree: path });
  mustGit(["worktree", "add", "-q", "-b", branch, path, "HEAD"], ROOT);
  mkdirSync(join(path, ".claude"), { recursive: true });
  // spike c12's shape: "ask" only for a git commit --amend command, so no other Bash call in the
  // prompt phase's task is wedged by it. Inline, not a separate script file: this settings.json is
  // committed to the branch, so a relative path to a sibling script would need to resolve the same
  // way from every task worktree Flowryn later checks out from it.
  const amendAskHook = 'cmd=$(cat | jq -r \'.tool_input.command // ""\'); case "$cmd" in *"git commit --amend"*) jq -cn \'{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "cutover-live: a non-Flowryn hook"}}\' ;; esac; exit 0';
  writeFileSync(
    join(path, ".claude", "settings.json"),
    `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: amendAskHook }] }] } }, null, 2)}\n`,
  );
  mustGit(["add", ".claude/settings.json"], path);
  mustGit(["-c", "user.name=cutover-live", "-c", "user.email=cutover-live@example.invalid", "commit", "-q", "-m", "cutover-live: an extra PreToolUse hook for the prompt phase"], path);
  return { path: realpathSync(path), branch };
}
const claudeRepo = trustedWorktree();

const results: { phase: string; check: string; ok: boolean; detail: string }[] = [];
function log(line: string): void {
  console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
}
function record(phase: string, check: string, ok: boolean, detail: string): void {
  results.push({ phase, check, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${phase} / ${check}: ${detail}`);
}

// --- the scratch home -----------------------------------------------------------------------
const config = renderToml(
  {
    data_dir: join(home, "data"),
    state_dir: join(home, "state"),
    tasks: { backlog: join(home, "data", "backlog.md"), todos: join(home, "data", "todos.md") },
    tools: { tasks_axi: which("tasks-axi"), node: which("node"), git: which("git"), claude: which("claude"), pi: PI_BIN, herdr: which("herdr") },
    herdr: { socket: herdrSocket, unreachable_alert_ms: 5_000 },
    workers: {
      worktree_root: join(home, "wt"),
      branch_prefix: runPrefix,
      // "check" never writes ~/.claude.json: this checkout's trust already covers the linked worktree below.
      claude: { model: CLAUDE_MODEL, pretrust: "check" },
      pi: {
        model: PI_MODEL,
        extensions: [join(ROOT, "spikes/pi/lib/scripted-provider.ts")],
        agent_dir: piAgent,
        session_dir: join(home, "pi-sessions"),
        env: { PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
      },
    },
    reconcile: { pass_ms: 2_000, wait_poll_ms: 10_000, prompt_suspect_ms: 120_000 },
    sched: { pass_ms: 2_000 },
    capacity: { host: { min_free_mem_gb: 1, max_load_per_core: 8 } },
    github: { api_url: "http://127.0.0.1:9" },
  },
  "Scratch home for the cutover live run",
);
writeFileSync(join(home, "config.toml"), config);
mkdirSync(join(home, "state"), { recursive: true, mode: 0o700 });
mkdirSync(join(home, "data"), { recursive: true, mode: 0o700 });
const leader = mintToken("leader");
{
  const db = openDb(join(home, "state", "flowryn.db"));
  migrate(db);
  tx(db, () => db.query("INSERT INTO leader_lease (id, session_id, harness, epoch, token_hash, claimed_at, heartbeat_at) VALUES (1, 'cutover-live', 'claude', 1, ?1, ?2, ?2)").run(hashToken(leader), Date.now()));
  db.close();
}
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("FLOWRYN_") && k !== "CLAUDECODE" && !k.startsWith("CLAUDE_CODE_")) env[k] = v;
env.FLOWRYN_HOME = home;
// A live run never posts to your Mac: its scratch daemon records notifications and delivers none.
env.FLOWRYN_NOTIFY = "off";
const sock = join(home, "run", "flowrynd.sock");
const dbPath = join(home, "state", "flowryn.db");

// --- the daemon ---------------------------------------------------------------------------------
let daemon: ReturnType<typeof Bun.spawn> | null = null;
async function startDaemon(): Promise<void> {
  requireNotificationsOff(env, "cutover-live");
  const fd = openSync(join(home, "daemon.log"), "a");
  daemon = Bun.spawn(["bun", MAIN, "daemon", "run"], { env, stdin: "ignore", stdout: fd, stderr: fd });
  closeSync(fd);
  const until = Date.now() + 20_000;
  for (;;) {
    try {
      await request(sock, { proto: PROTO, ulid: ulid(), verb: "daemon.ping", args: {} }, { connectMs: 300, replyMs: 2_000 });
      return;
    } catch {
      if (Date.now() > until) throw new Error(`the daemon did not start; see ${home}/daemon.log`);
      await Bun.sleep(200);
    }
  }
}
async function stopDaemon(): Promise<void> {
  if (!daemon) return;
  daemon.kill("SIGTERM");
  await daemon.exited;
  daemon = null;
}

type CallReply = { ok: boolean; data: Record<string, unknown>; error?: { code: string; message: string } };
async function callAs(token: string | null, channel: "tty" | null, verb: string, args: Record<string, unknown>): Promise<CallReply> {
  const reply = (await request(sock, { proto: PROTO, ulid: ulid(), verb, token, channel, args }, { connectMs: 1_000, replyMs: 120_000 })) as CallReply;
  return { ok: reply.ok, data: reply.data ?? {}, error: reply.error };
}
/** A call with the leader's own token, as the leader itself would make it. */
const call = (verb: string, args: Record<string, unknown>) => callAs(leader, null, verb, args);
/** A call with no token and channel "tty": the human role, as your own shell would make it (client.ts's buildEnvelope). */
const callHuman = (verb: string, args: Record<string, unknown>) => callAs(null, "tty", verb, args);

function query<T>(sql: string, ...params: (string | number | null)[]): T[] {
  const db = openDb(dbPath, { readonly: true });
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}
const items = (kind: string) => query<{ id: string; state: string; line: string; task_id: string | null }>("SELECT id, state, line, task_id FROM items WHERE kind = ?1 ORDER BY opened_at", kind);
const decisionsOf = (origin: string) => query<{ id: string; task_id: string; key: string | null; reserved_reason: string | null }>("SELECT id, task_id, key, reserved_reason FROM decisions WHERE origin = ?1 ORDER BY created_at", origin);
const runOf = (taskId: string) => query<{ id: string; state: string }>("SELECT id, state FROM runs WHERE task_id = ?1", taskId)[0];

async function waitFor<T>(what: string, timeoutMs: number, check: () => T | null | undefined | false): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(1_000);
  }
}

const dispatched: string[] = [];

/** A real Claude scout/ship: `body` is the exact instructions the worker gets, in plain language. */
async function dispatchClaude(project: string, kind: "ship" | "scout", body: string, title: string): Promise<{ task: string; run: string }> {
  const reply = await call("dispatch", { project, kind, harness: "claude", body, title });
  if (!reply.ok) throw new Error(`dispatch: ${reply.error?.code} ${reply.error?.message}`);
  dispatched.push(String(reply.data.task));
  return { task: String(reply.data.task), run: String(reply.data.run) };
}

/** Files a one-phase Pi plan, Queued behind `blockedBy`, auto-starting once it lands (dispatch.ts's "queue" mode). */
async function dispatchPiQueued(project: string, blockedBy: string, title: string): Promise<{ task: string; data: Record<string, unknown> }> {
  const body = `${title}\nFLOWRYN-SCRIPT: bash sleep 90 ;; say DONE`;
  const reply = await call("dispatch", { project, kind: "ship", harness: "pi", body, title, "blocked-by": [blockedBy], auto: true });
  if (!reply.ok) throw new Error(`dispatch --blocked-by --auto: ${reply.error?.code} ${reply.error?.message}`);
  const task = String(reply.data.task);
  dispatched.push(task);
  return { task, data: reply.data };
}

// --- phases ---------------------------------------------------------------------------------------
const DECISIONS_REPORT = [
  "Run exactly this and nothing else, then end your turn:",
  "",
  'mkdir -p "$FLOWRYN_REPORT_DIR" && cat > "$FLOWRYN_REPORT_DIR/report.md" <<\'CUTOVERLIVE\'',
  "## Open decisions",
  "",
  "### lab-a: Keep the scratch fixture after this run?",
  "Options: keep, drop",
  "Recommendation: drop",
  "Why it matters: cutover live check",
  "",
  "### lab-b: Ship the second fixture now?",
  "Options: now, later",
  "Recommendation: later",
  "Why it matters: cutover live check",
  "",
  "### lab-c: Who may approve this reserved action?",
  "Options: proceed, hold",
  "Reserved: lab",
  "Why it matters: cutover live check",
  "CUTOVERLIVE",
  '$FLOWRYN_BIN deliver --report "$FLOWRYN_REPORT_DIR/report.md"',
].join("\n");

async function decisions(): Promise<void> {
  try {
    const { task: scoutTask, run: scoutRun } = await dispatchClaude("trusted", "scout", DECISIONS_REPORT, "cutover live: open decisions report");
    const landed = await waitFor("the Claude scout's report landed", 480_000, () => {
      const r = runOf(scoutTask);
      return r && (r.state === "landed" || r.state === "cleaned") ? r : null;
    });
    record("decisions", "a real Claude scout delivered a report", true, `${scoutTask}: run ${scoutRun} ${landed.state}`);

    const rows = await waitFor("three open decisions from the report", 30_000, () => {
      const ds = decisionsOf(scoutTask);
      return ds.length === 3 ? ds : null;
    });
    record("decisions", "three standalone decisions opened, one reserved", rows.length === 3 && rows.filter((d) => d.reserved_reason !== null).length === 1, rows.map((d) => `${d.id}${d.reserved_reason ? ` (reserved: ${d.reserved_reason})` : ""}`).join(", "));

    const reserved = rows.find((d) => d.reserved_reason !== null)!;
    const leaderOnes = rows.filter((d) => d.id !== reserved.id);
    // DECISIONS_REPORT's own keys and options: lab-a (keep|drop) and lab-b (now|later); lab-c is reserved.
    const CHOICE: Record<string, string> = { "lab-a": "keep", "lab-b": "later" };

    // File the dependent ship before answering, so its blocker is still open when it is filed.
    const blocker = leaderOnes.find((d) => d.key === "lab-a") ?? leaderOnes[0]!;
    const queued = await dispatchPiQueued("scratch", blocker.task_id, "cutover live: starts once its decision lands");
    record("decisions", "a --blocked-by --auto ship was filed, queued", queued.data.state === "queued" && queued.data.auto === "on", JSON.stringify(queued.data));

    for (const d of leaderOnes) {
      const ans = await call("decide", { decision: d.id, choice: CHOICE[d.key ?? ""] ?? "keep", rationale: "cutover live: the leader answers" });
      record("decisions", `the leader answered ${d.id}`, ans.ok, ans.ok ? JSON.stringify(ans.data) : `${ans.error?.code}: ${ans.error?.message}`);
    }
    const human = await callHuman("decide", { decision: reserved.id, choice: "hold", body: "cutover live: the user answers a reserved decision" });
    record("decisions", "the user's own shell answered the reserved decision", human.ok && human.data.by === "captain", human.ok ? JSON.stringify(human.data) : `${human.error?.code}: ${human.error?.message}`);

    const started = await waitFor("the blocked ship's run, within 120 s of its blocker landing", 120_000, () => runOf(queued.task));
    record("decisions", "the --blocked-by --auto ship got a run within 120 s", true, `${queued.task}: run ${started.id} ${started.state}`);
  } catch (error) {
    record("decisions", "the import-decision flow", false, (error as Error).message);
  }
}

async function prompt(): Promise<void> {
  try {
    const { task, run } = await dispatchClaude("trusted", "scout", "Run exactly this Bash command and nothing else: git commit --amend --no-edit", "cutover live: an extra ask hook on git commit --amend");
    log(`prompt: dispatched ${task} (run ${run}); watching for a blocked_prompt item naming "amend"`);
    const opened = await waitFor('a blocked_prompt item naming "amend"', 120_000, () => items("blocked_prompt").find((i) => i.task_id === task && /amend/i.test(i.line)));
    record("prompt", 'the extra PreToolUse hook opened a blocked_prompt item within 120 s, naming "amend"', true, opened.line);
    const idle = items("worker_idle").filter((i) => i.task_id === task && i.state !== "resolved");
    record("prompt", "no worker_idle item alongside the open blocked_prompt", idle.length === 0, idle.length === 0 ? "none open" : idle.map((i) => i.id).join(", "));
  } catch (error) {
    record("prompt", "the extra hook wedges a real Claude worker", false, (error as Error).message);
  }
}

// --- run ---------------------------------------------------------------------------------------------
async function main(): Promise<number> {
  log(`scratch home ${home}; lab ${labSession}; run ${runId}; claude ${CLAUDE_MODEL} (worktree ${claudeRepo.path}); pi ${PI_MODEL}`);
  await startDaemon();
  for (const [id, repo, harnessId] of [
    ["trusted", claudeRepo, "claude"],
    ["scratch", piRepo, "pi"],
  ] as const) {
    const added = await call("project add", { path: repo.path, id, mode: "local-only", "default-branch": repo.branch, harness: harnessId, yolo: true, autonomy: "plan" });
    if (!added.ok) throw new Error(`project add ${id}: ${JSON.stringify(added.error)}`);
  }
  // The startup check runs on the harnesses in use: restart now that the projects name them.
  await stopDaemon();
  await startDaemon();
  // Neither phase runs the harness contract suites; seed the installed versions directly (as
  // v1-live's non-"harness" phases do), so dispatch never refuses with contract_unverified.
  for (const [harness, bin] of [["pi", PI_BIN], ["claude", which("claude")]] as const) {
    const version = /(\d+\.\d+\.\d+)/.exec(Bun.spawnSync([bin, "--version"]).stdout.toString())?.[1] ?? "0.0.0";
    const seeded = await call("contracts.record", { harness, version, report: "seeded by cutover-live (not run)" });
    if (!seeded.ok) throw new Error(`contracts.record ${harness}: ${JSON.stringify(seeded.error)}`);
    log(`seeded ${harness} ${version} (contract suite not run)`);
  }
  if (phases.includes("decisions")) await decisions();
  if (phases.includes("prompt")) await prompt();
  return results.every((r) => r.ok) && results.length > 0 ? 0 : 1;
}

async function cleanup(): Promise<void> {
  for (const task of dispatched) await call("cancel", { target: task, reason: "cutover live run finished" }).catch(() => undefined);
  const workspaces = query<{ workspace_id: string }>("SELECT workspace_id FROM runs WHERE workspace_id IS NOT NULL").map((r) => r.workspace_id);
  const runtime = new HerdrRuntime(new HerdrClient(herdrSocket!));
  for (const ws of workspaces) await runtime.closeWorkspace(ws).catch(() => undefined);
  // Exactly what this run made in this checkout: the "trusted" project's own worktree, and every
  // task worktree and branch Flowryn created under it (the Pi project is a disposable clone inside
  // `home`, removed with it below).
  const tasks = existsSync(dbPath) ? query<{ branch: string; worktree: string }>("SELECT branch, worktree_path AS worktree FROM runs WHERE worktree_path IS NOT NULL") : [];
  await stopDaemon().catch(() => undefined);
  removeOwnWorktrees(ROOT, [...createdWorktrees, ...tasks], runPrefix, join(home, "wt"), git, log);
}

let cleaning: Promise<void> | null = null;
const cleanupOnce = () => (cleaning ??= cleanup());
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log(`${signal}: cleaning up before exit`);
    void cleanupOnce().finally(() => {
      if (!values.keep) rmSync(home, { recursive: true, force: true });
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  });
}

let code = 1;
try {
  code = await main();
} catch (error) {
  log(`aborted: ${(error as Error).stack ?? String(error)}`);
} finally {
  await cleanupOnce();
  const resultsPath = process.env.CUTOVER_RESULTS ?? join(home, "results.json");
  writeFileSync(resultsPath, JSON.stringify({ home, runId, claudeModel: CLAUDE_MODEL, piModel: PI_MODEL, results }, null, 2));
  log(`results: ${results.filter((r) => r.ok).length}/${results.length} passed; ${resultsPath}`);
  if (!values.keep) rmSync(home, { recursive: true, force: true });
}
process.exit(code);
