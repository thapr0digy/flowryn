#!/usr/bin/env bun
/**
 * The v1 completion pass, live. Run it through scripts/lab/v1-live.sh, which
 * owns the Herdr lab session. Phases, in order (all by default):
 *
 *   harness     the startup check reads the real installed Claude Code and Pi
 *               versions, opens a P1 for each untested one; Pi's contract suite
 *               passes and settles its P1; a dispatch on Claude refuses
 *   scout       a real Pi scout delivers its report, lands, and is cleaned up
 *               through the cleanup guard; its task is done with the report
 *   promote     a real Pi scout promoted in place mid-task: its worker is
 *               relaunched into the same session as a ship, which commits,
 *               delivers locally, merges (yolo) and is cleaned
 *   divergence  a hand edit against a live run settled with keep-run; a task
 *               put In flight by hand, raised by the invariant pass and
 *               settled with accept-edit
 *   herdr       last, since it ends the lab session: the lab session is stopped
 *               through the helper under a live run, and one P1 opens for the
 *               outage while retries go on; a dispatch refuses
 *
 * Pi runs the offline scripted provider (no credentials, no network) with a
 * scratch agent dir, never ~/.pi; no Claude model is ever called (only
 * `claude --version`). Everything lives in a scratch Flowryn home with fresh
 * clones of this repository, removed at the end (--keep leaves it). Results go
 * to stdout and $V1_RESULTS.
 */
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { hashToken, mintToken } from "../../src/api/auth.ts";
import { requireNotificationsOff } from "../../src/config/leader.ts";
import { renderToml } from "../../src/config/toml.ts";
import { migrate, openDb, tx } from "../../src/db/db.ts";
import type { RunRow } from "../../src/lifecycle/runs.ts";
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
const labHelper = process.env.HERDR_LAB_HELPER ?? "";
if (!herdrSocket || !labSession.startsWith("fm-lab-") || !labHelper) {
  console.error("v1-live: run me through scripts/lab/v1-live.sh (a lab session and its helper are required)");
  process.exit(2);
}
const PHASES = ["harness", "scout", "promote", "divergence", "herdr"];
const phases = positionals.length > 0 ? positionals : PHASES;
for (const p of phases) if (!PHASES.includes(p)) throw new Error(`unknown phase ${p}`);

const which = (name: string) => Bun.which(name) ?? "";
const PI_BIN = process.env.PI_BIN ?? (existsSync("/opt/homebrew/bin/pi-signed") ? "/opt/homebrew/bin/pi-signed" : which("pi"));
const PI_MODEL = "flowryn-scripted/scripted";

const home = realpathSync(mkdtempSync(join(tmpdir(), "fwv-")));
const piAgent = join(home, "pi-agent");
mkdirSync(piAgent, { recursive: true });
function clone(name: string): { path: string; branch: string } {
  const path = join(home, name);
  const cloned = Bun.spawnSync(["git", "clone", "--quiet", "--no-hardlinks", ROOT, path], { stdin: "ignore" });
  if (cloned.exitCode !== 0) throw new Error(`git clone failed: ${cloned.stderr.toString()}`);
  return { path, branch: Bun.spawnSync(["git", "-C", path, "branch", "--show-current"]).stdout.toString().trim() };
}
/** Fresh clones of this repository: the Pi project, and one a Claude project names (only its version is checked). */
const piRepo = clone("repo");
const claudeRepo = clone("repo-claude");
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
      pi: {
        model: PI_MODEL,
        extensions: [join(ROOT, "spikes/pi/lib/scripted-provider.ts")],
        agent_dir: piAgent,
        session_dir: join(home, "pi-sessions"),
        env: { PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
      },
    },
    reconcile: { pass_ms: 2_000, wait_poll_ms: 10_000 },
    github: { api_url: "http://127.0.0.1:9" },
  },
  "Scratch home for the v1 completion live run",
);
writeFileSync(join(home, "config.toml"), config);
mkdirSync(join(home, "state"), { recursive: true, mode: 0o700 });
mkdirSync(join(home, "data"), { recursive: true, mode: 0o700 });
const leader = mintToken("leader");
{
  const db = openDb(join(home, "state", "flowryn.db"));
  migrate(db);
  tx(db, () => db.query("INSERT INTO leader_lease (id, session_id, harness, epoch, token_hash, claimed_at, heartbeat_at) VALUES (1, 'v1-live', 'claude', 1, ?1, ?2, ?2)").run(hashToken(leader), Date.now()));
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
  requireNotificationsOff(env, "v1-live");
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

async function call(verb: string, args: Record<string, unknown>): Promise<{ ok: boolean; data: Record<string, unknown>; error?: { code: string; message: string } }> {
  const reply = (await request(sock, { proto: PROTO, ulid: ulid(), verb, token: leader, args }, { connectMs: 1_000, replyMs: 120_000 })) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; message: string };
  };
  return { ok: reply.ok, data: reply.data ?? {}, error: reply.error };
}

function query<T>(sql: string, ...params: (string | number | null)[]): T[] {
  const db = openDb(dbPath, { readonly: true });
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}
const readRun = (runId: string) => query<RunRow>("SELECT * FROM runs WHERE id = ?1", runId)[0]!;
const runEvents = (runId: string) => query<{ kind: string }>("SELECT kind FROM events WHERE run_id = ?1 ORDER BY seq", runId).map((e) => e.kind);
const items = (kind: string) => query<{ id: string; state: string; line: string; task_id: string | null }>("SELECT id, state, line, task_id FROM items WHERE kind = ?1 ORDER BY opened_at", kind);
const divergences = () => query<{ id: string; run_id: string | null; task_id: string | null; lower: string; resolution: string | null; summary: string }>("SELECT * FROM divergences ORDER BY opened_at, id");

async function waitFor<T>(what: string, timeoutMs: number, check: () => T | null | undefined | false): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(1_000);
  }
}
async function waitRun(runId: string, what: string, timeoutMs: number, predicate: (r: RunRow) => boolean): Promise<RunRow> {
  try {
    return await waitFor(what, timeoutMs, () => {
      const run = readRun(runId);
      return run && predicate(run) ? run : null;
    });
  } catch (error) {
    const run = readRun(runId);
    throw new Error(`${(error as Error).message}; state ${run?.state}, liveness ${run?.liveness}; events: ${runEvents(runId).join(",")}`, { cause: error });
  }
}

function backlogTask(taskId: string): { state: string; kind: string | null; links: string } | null {
  const shown = Bun.spawnSync([which("tasks-axi"), "show", taskId, "--file", join(home, "data", "backlog.md")], { stdin: "ignore" });
  if (shown.exitCode !== 0) return null;
  const text = shown.stdout.toString();
  return { state: /^\s*state:\s*(\S+)/m.exec(text)?.[1] ?? "?", kind: /^\s*kind:\s*(\S+)/m.exec(text)?.[1] ?? null, links: text };
}
function byHand(args: string[]): void {
  const result = Bun.spawnSync([which("tasks-axi"), ...args, "--file", join(home, "data", "backlog.md"), "--json"], { stdin: "ignore" });
  if (result.exitCode !== 0) throw new Error(`tasks-axi ${args.join(" ")}: ${result.stdout.toString()}`);
}

const dispatched: string[] = [];
async function dispatch(script: string, title: string): Promise<{ task: string; run: string }> {
  const body = `${title}\nFLOWRYN-SCRIPT: ${script}`;
  const reply = await call("dispatch", { project: "scratch", kind: "scout", harness: "pi", body, title });
  if (!reply.ok) throw new Error(`dispatch: ${reply.error?.code} ${reply.error?.message}`);
  dispatched.push(String(reply.data.task));
  return { task: String(reply.data.task), run: String(reply.data.run) };
}

const REPORT = `bash mkdir -p "$FLOWRYN_REPORT_DIR" && ls src > "$FLOWRYN_REPORT_DIR/notes.md" && $FLOWRYN_BIN deliver --report "$FLOWRYN_REPORT_DIR/notes.md"`;
const SHIP = `bash printf 'promoted\\n' > promoted.txt && git add promoted.txt && git -c user.name=lab -c user.email=lab@example.invalid commit -qm 'the promoted fix' && $FLOWRYN_BIN deliver --local`;

// --- phases ---------------------------------------------------------------------------------------
async function harness(): Promise<void> {
  const checked = query<{ payload: string }>("SELECT payload FROM events WHERE kind = 'harness.checked' ORDER BY seq").map((e) => JSON.parse(e.payload) as { harness: string; state: string; version?: string });
  for (const h of ["claude", "pi"]) {
    const found = checked.find((c) => c.harness === h);
    record("harness", `startup check ${h}`, found?.state === "unverified", found ? `${h} ${found.version ?? "?"} ${found.state}` : "not checked");
    const item = items("harness_unverified").find((i) => i.task_id === `harness:${h}`);
    record("harness", `P1 ${h}`, item?.state === "open" && item.line.includes(`flowryn doctor --contracts --harness ${h}`), item?.line ?? "none");
  }
  const refused = await call("dispatch", { project: "claude-check", kind: "scout", body: "never runs", title: "never runs" });
  record("harness", "claude dispatch refused", refused.error?.code === "contract_unverified", refused.error ? `${refused.error.code}: ${refused.error.message}` : "dispatched");
  // Pi's contract suite, recorded with this daemon as your terminal would (script(1) gives it a TTY).
  const args = ["doctor", "--contracts", "--harness", "pi", "--herdr-socket", herdrSocket!, "--json"];
  log(`harness: flowryn ${args.join(" ")}`);
  const proc = Bun.spawn(["script", "-q", "/dev/null", "bun", MAIN, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  writeFileSync(join(home, "contract-pi.log"), `${err}\n${out}`);
  const passed = query<{ version: string }>("SELECT version FROM harness_contracts WHERE harness = 'pi'");
  record("harness", "pi contract suite recorded", passed.length > 0, passed.length > 0 ? `pi ${passed[0]!.version} (doctor exit ${code})` : `nothing recorded; see ${home}/contract-pi.log`);
  const pi = items("harness_unverified").find((i) => i.task_id === "harness:pi");
  record("harness", "pi P1 settled by the passing run", pi?.state === "resolved", pi ? `${pi.id} ${pi.state}` : "none");
}

async function scout(): Promise<void> {
  const { task, run } = await dispatch(`${REPORT} ;; say DONE`, "Live scout: list the source modules");
  try {
    const cleaned = await waitRun(run, "the scout landed and cleaned", 240_000, (r) => r.state === "cleaned");
    const events = runEvents(run);
    record("scout", "landed with its report, then cleaned", events.includes("run.landed") && events.includes("cleanup.done"), `${task}: ${events.filter((e) => e.startsWith("run.") || e.startsWith("cleanup.")).join(",")}`);
    record("scout", "worktree removed through the guard", !existsSync(cleaned.worktree_path) && cleaned.cleanup === "done", `${cleaned.worktree_path} ${existsSync(cleaned.worktree_path) ? "still there" : "removed"}`);
    const t = await waitFor("the task done", 30_000, () => {
      const b = backlogTask(task);
      return b?.state === "done" ? b : null;
    });
    record("scout", "task done with --report", t.links.includes(`data/${task}/report.md`), `${task} done`);
    const report = items("report_ready").find((i) => i.task_id === task);
    record("scout", "report_ready stays open to be read", report?.state === "open", report ? `${report.id} ${report.state}` : "none");
  } catch (error) {
    record("scout", "landed and cleaned", false, (error as Error).message);
  }
}

async function promote(): Promise<void> {
  const { task, run } = await dispatch(`bash sleep 40 ;; ${SHIP} ;; say DONE`, "Live scout to promote");
  try {
    const busy = await waitRun(run, "the scout busy", 120_000, (r) => r.liveness === "busy" && r.proc_pid !== null);
    const promoted = await call("promote", { task, body: "Ship the fix you found as promoted.txt." });
    record("promote", "promoted in place", promoted.ok && promoted.data.run === run, promoted.ok ? JSON.stringify(promoted.data) : `${promoted.error?.code}: ${promoted.error?.message}`);
    const relaunched = await waitRun(run, "the worker relaunched", 120_000, (r) => r.proc_pid !== null && r.proc_pid !== busy.proc_pid && r.pending_launch === null && r.worker_started_at !== null && r.worker_started_at > (busy.worker_started_at ?? 0));
    record("promote", "same session, new process", relaunched.agent_session === busy.agent_session, `session ${relaunched.agent_session}; pid ${busy.proc_pid} -> ${relaunched.proc_pid}; stage ${relaunched.stage}`);
    await waitRun(run, "the local delivery", 180_000, (r) => r.state === "ready");
    const merged = await call("merge", { task });
    record("promote", "merged under yolo", merged.ok, merged.ok ? String(merged.data.state) : `${merged.error?.code}: ${merged.error?.message}`);
    const done = await waitRun(run, "cleaned", 120_000, (r) => r.state === "cleaned");
    const onMain = Bun.spawnSync(["git", "-C", piRepo.path, "show", `${piRepo.branch}:promoted.txt`]).stdout.toString().trim();
    record("promote", "the ship landed and was cleaned", onMain === "promoted" && !existsSync(done.worktree_path), `promoted.txt on ${piRepo.branch}: ${onMain || "missing"}`);
    const t = backlogTask(task);
    record("promote", "the task is a ship, done", t?.state === "done" && t.kind === "ship", `${t?.state} ${t?.kind}`);
  } catch (error) {
    record("promote", "promoted scout shipped", false, (error as Error).message);
  }
}

async function divergence(): Promise<void> {
  const { task, run } = await dispatch("bash sleep 90 ;; say DONE", "Live scout for a hand edit");
  try {
    await waitRun(run, "busy", 120_000, (r) => r.liveness === "busy");
    await waitFor("the task In flight", 30_000, () => backlogTask(task)?.state === "in_flight");
    byHand(["done", task]);
    const d = await waitFor("the divergence", 30_000, () => divergences().find((x) => x.task_id === task && x.resolution === null));
    record("divergence", "hand edit is a divergence", d.lower === "backlog" && readRun(run).state === "running", `${d.id}: ${d.summary}`);
    const kept = await call("divergence resolve", { id: d.id, resolution: "keep-run" });
    record("divergence", "keep-run", kept.ok, JSON.stringify(kept.data));
    await waitFor("the task back In flight", 30_000, () => backlogTask(task)?.state === "in_flight");
    record("divergence", "the run's state written back", true, `${task} In flight again`);
    byHand(["add", "lab-stray-z9", "Stray task", "--start"]);
    const stray = await waitFor("the invariant divergence", 30_000, () => divergences().find((x) => x.task_id === "lab-stray-z9"));
    const accepted = await call("divergence resolve", { id: stray.id, resolution: "accept-edit" });
    await Bun.sleep(6_000);
    record("divergence", "invariant pass, accept-edit", accepted.ok && divergences().filter((x) => x.task_id === "lab-stray-z9").length === 1, `${stray.id}: ${stray.summary}`);
  } catch (error) {
    record("divergence", "settled", false, (error as Error).message);
  }
}

async function herdr(): Promise<void> {
  const { run } = await dispatch("bash sleep 300 ;; say DONE", "Live scout while Herdr goes away");
  try {
    await waitRun(run, "busy", 120_000, (r) => r.liveness === "busy");
    log(`herdr: stopping lab session ${labSession} through the helper`);
    const stopped = Bun.spawnSync([labHelper, "stop", labSession], { stdin: "ignore" });
    record("herdr", "lab session stopped", stopped.exitCode === 0, stopped.stderr.toString().trim() || "stopped");
    const item = await waitFor("the Herdr P1", 90_000, () => items("herdr_unreachable")[0]);
    record("herdr", "one P1 for the outage", item.state === "open", item.line);
    const refused = await call("dispatch", { project: "scratch", kind: "scout", harness: "pi", body: "never runs", title: "never runs" });
    record("herdr", "dispatch refused", refused.error?.code === "herdr_unavailable", refused.error ? `${refused.error.code}: ${refused.error.message}` : "dispatched");
    await Bun.sleep(40_000);
    const all = items("herdr_unreachable");
    const episodes = query<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE kind = 'herdr.unreachable'")[0]!.n;
    record("herdr", "still one P1 after 40 s of retries", all.length === 1 && episodes === 1, `${all.length} item(s), ${episodes} episode(s)`);
  } catch (error) {
    record("herdr", "P1 once", false, (error as Error).message);
  }
}

// --- run ---------------------------------------------------------------------------------------------
async function main(): Promise<number> {
  log(`scratch home ${home}; lab ${labSession}; pi ${PI_BIN} (${PI_MODEL})`);
  await startDaemon();
  for (const [id, repo, harnessId, extra] of [
    ["scratch", piRepo, "pi", { yolo: true }],
    ["claude-check", claudeRepo, "claude", {}],
  ] as const) {
    const added = await call("project add", { path: repo.path, id, mode: "local-only", "default-branch": repo.branch, harness: harnessId, ...extra });
    if (!added.ok) throw new Error(`project add ${id}: ${added.error?.message}`);
  }
  // The startup check runs on the harnesses in use: restart now that the projects name them.
  await stopDaemon();
  await startDaemon();
  if (phases.includes("harness")) await harness();
  else {
    // Other phases need Pi verified; seed the record for the installed version, as M5's live run did.
    const version = /(\d+\.\d+\.\d+)/.exec(Bun.spawnSync([PI_BIN, "--version"]).stdout.toString())?.[1] ?? "0.0.0";
    await call("contracts.record", { harness: "pi", version });
  }
  if (phases.includes("scout")) await scout();
  if (phases.includes("promote")) await promote();
  if (phases.includes("divergence")) await divergence();
  if (phases.includes("herdr")) await herdr();
  return results.every((r) => r.ok) && results.length > 0 ? 0 : 1;
}

async function cleanup(): Promise<void> {
  for (const task of dispatched) await call("cancel", { target: task, reason: "live run finished" }).catch(() => undefined);
  const workspaces = query<{ workspace_id: string }>("SELECT workspace_id FROM runs WHERE workspace_id IS NOT NULL").map((r) => r.workspace_id);
  const runtime = new HerdrRuntime(new HerdrClient(herdrSocket!));
  for (const ws of workspaces) await runtime.closeWorkspace(ws).catch(() => undefined);
  await stopDaemon().catch(() => undefined);
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
  const resultsPath = process.env.V1_RESULTS ?? join(home, "results.json");
  writeFileSync(resultsPath, JSON.stringify({ home, piModel: PI_MODEL, results }, null, 2));
  log(`results: ${results.filter((r) => r.ok).length}/${results.length} passed; ${resultsPath}`);
  if (!values.keep) rmSync(home, { recursive: true, force: true });
}
process.exit(code);
