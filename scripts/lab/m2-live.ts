#!/usr/bin/env bun
/**
 * M2 exit, live. Run it through scripts/lab/m2-live.sh, which owns the Herdr
 * lab session. Phases, in order (all by default):
 *
 *   contracts    flowryn doctor --contracts for pi and claude, recorded with the daemon
 *   scouts       a real scout on each harness, dispatch to a verified report
 *   kill-worker  a worker killed mid-run is resumed once and finishes
 *   kill-daemon  the daemon killed mid-run: the worker spools, the restart reattaches
 *
 * Everything lives in a scratch Flowryn home, removed when the run ends
 * (--keep leaves it). Pi works in a fresh clone of this repository inside that
 * home, so no git state outside it is touched. Claude shows a workspace-trust
 * dialog for a fresh clone, and Flowryn never answers dialogs or writes your
 * ~/.claude.json from a test, so the Claude phases run only with
 * --claude-project <checkout>: a checkout Claude already trusts, whose linked
 * worktrees inherit that trust (docs/m2-notes.md); their worktrees and branches
 * are removed in code at the end. Results go to stdout and $M2_RESULTS.
 */
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { hashToken, mintToken } from "../../src/api/auth.ts";
import { requireNotificationsOff } from "../../src/config/leader.ts";
import { renderToml } from "../../src/config/toml.ts";
import { migrate, openDb, tx } from "../../src/db/db.ts";
import type { RunRow } from "../../src/lifecycle/runs.ts";
import { terminate } from "../../src/runtime/proc.ts";
import { contractPrefix, createdWorktrees, removeOwnWorktrees } from "../../src/contracts/cleanup.ts";
import { HerdrClient } from "../../src/runtime/herdr/client.ts";
import { HerdrRuntime } from "../../src/runtime/herdr/runtime.ts";
import { request } from "../../src/transport/unix.ts";
import { ulid } from "../../src/util/ulid.ts";
import { PROTO } from "../../src/version.ts";

const ROOT = resolve(import.meta.dir, "../..");
const MAIN = join(ROOT, "src/main.ts");
const { values, positionals } = parseArgs({
  options: { "herdr-socket": { type: "string" }, session: { type: "string" }, keep: { type: "boolean" }, "claude-project": { type: "string" } },
  allowPositionals: true,
});
const herdrSocket = values["herdr-socket"];
if (!herdrSocket || !values.session?.startsWith("fm-lab-")) {
  console.error("m2-live: run me through scripts/lab/m2-live.sh (a lab session socket is required)");
  process.exit(2);
}
const PHASES = ["contracts", "scouts", "kill-worker", "kill-daemon"];
const phases = positionals.length > 0 ? positionals : PHASES;
for (const p of phases) if (!PHASES.includes(p)) throw new Error(`unknown phase ${p}`);

const CLAUDE_MODEL = process.env.M2_CLAUDE_MODEL ?? "haiku";
const PI_MODEL = process.env.M2_PI_MODEL ?? "flowryn-scripted/scripted";
const scripted = PI_MODEL.startsWith("flowryn-scripted/");
const which = (name: string) => Bun.which(name) ?? "";
const PI_BIN = process.env.PI_BIN ?? (existsSync("/opt/homebrew/bin/pi-signed") ? "/opt/homebrew/bin/pi-signed" : which("pi"));

const home = realpathSync(mkdtempSync(join(tmpdir(), "fw2-")));
const { prefix: runPrefix } = contractPrefix();
const piAgent = process.env.M2_PI_AGENT_DIR ?? join(home, "pi-agent");
mkdirSync(piAgent, { recursive: true });
/** A fresh clone of this repository in the scratch home: the Pi project. */
const project = join(home, "repo");
{
  const cloned = Bun.spawnSync(["git", "clone", "--quiet", "--no-hardlinks", ROOT, project], { stdin: "ignore" });
  if (cloned.exitCode !== 0) throw new Error(`git clone failed: ${cloned.stderr.toString()}`);
}
const projectBranch = Bun.spawnSync(["git", "-C", project, "branch", "--show-current"]).stdout.toString().trim();
/** A checkout Claude already trusts (optional): Claude runs happen in linked worktrees of it. */
const claudeProject = values["claude-project"] ? realpathSync(values["claude-project"]) : null;
const claudeBranch = claudeProject ? Bun.spawnSync(["git", "-C", claudeProject, "branch", "--show-current"]).stdout.toString().trim() : "";
const results: { phase: string; check: string; ok: boolean; detail: string }[] = [];

function log(line: string): void {
  console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
}

function record(phase: string, check: string, ok: boolean, detail: string): void {
  results.push({ phase, check, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${phase} / ${check}: ${detail}`);
}

// --- the scratch home ---------------------------------------------------------------------
const config = renderToml(
  {
    data_dir: join(home, "data"),
    state_dir: join(home, "state"),
    tasks: { backlog: join(home, "data", "backlog.md"), todos: join(home, "data", "todos.md") },
    tools: { tasks_axi: which("tasks-axi"), node: which("node"), git: which("git"), claude: which("claude"), pi: PI_BIN, herdr: which("herdr") },
    herdr: { socket: herdrSocket },
    workers: {
      worktree_root: join(home, "wt"),
      // Every branch this run creates carries its own prefix, so cleanup can go by exact name.
      branch_prefix: runPrefix,
      claude: { model: CLAUDE_MODEL, effort: "low", pretrust: "check" },
      pi: {
        model: PI_MODEL,
        extensions: scripted ? [join(ROOT, "spikes/pi/lib/scripted-provider.ts")] : [],
        agent_dir: piAgent,
        session_dir: join(home, "pi-sessions"),
        env: { PI_OFFLINE: scripted ? "1" : "0", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
      },
    },
    reconcile: { pass_ms: 2_000, wait_poll_ms: 10_000 },
  },
  "Scratch home for the M2 live exit run",
);
writeFileSync(join(home, "config.toml"), config);
mkdirSync(join(home, "state"), { recursive: true, mode: 0o700 });
mkdirSync(join(home, "data"), { recursive: true, mode: 0o700 });
const leader = mintToken("leader");
{
  const db = openDb(join(home, "state", "flowryn.db"));
  migrate(db);
  tx(db, () => db.query("INSERT INTO leader_lease (id, session_id, harness, epoch, token_hash, claimed_at, heartbeat_at) VALUES (1, 'm2-live', 'claude', 1, ?1, ?2, ?2)").run(hashToken(leader), Date.now()));
  db.close();
}
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("FLOWRYN_") && k !== "CLAUDECODE" && !k.startsWith("CLAUDE_CODE_")) env[k] = v;
env.FLOWRYN_HOME = home;
// A live run never posts to your Mac: its scratch daemon records notifications and delivers none.
env.FLOWRYN_NOTIFY = "off";
const sock = join(home, "run", "flowrynd.sock");

// --- the daemon ------------------------------------------------------------------------------
let daemon: ReturnType<typeof Bun.spawn> | null = null;
async function startDaemon(): Promise<void> {
  requireNotificationsOff(env, "m2-live");
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
async function killDaemon(): Promise<void> {
  if (!daemon) return;
  daemon.kill(9);
  await daemon.exited;
  daemon = null;
}

async function call(verb: string, args: Record<string, unknown>): Promise<{ ok: boolean; data: Record<string, unknown>; error?: { code: string; message: string } }> {
  const reply = (await request(sock, { proto: PROTO, ulid: ulid(), verb, token: leader, args }, { connectMs: 1_000, replyMs: 60_000 })) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; message: string };
  };
  return { ok: reply.ok, data: reply.data ?? {}, error: reply.error };
}

function readRun(runId: string): RunRow {
  const db = openDb(join(home, "state", "flowryn.db"), { readonly: true });
  try {
    return db.query("SELECT * FROM runs WHERE id = ?1").get(runId) as RunRow;
  } finally {
    db.close();
  }
}
function runEvents(runId: string): string[] {
  const db = openDb(join(home, "state", "flowryn.db"), { readonly: true });
  try {
    return (db.query("SELECT kind FROM events WHERE run_id = ?1 ORDER BY seq").all(runId) as { kind: string }[]).map((e) => e.kind);
  } finally {
    db.close();
  }
}
async function waitRun(runId: string, what: string, timeoutMs: number, check: (r: RunRow) => boolean): Promise<RunRow> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const run = readRun(runId);
    if (run && check(run)) return run;
    if (run?.state === "failed") throw new Error(`the run failed while waiting for ${what}; events: ${runEvents(runId).join(",")}`);
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}; liveness ${run?.liveness}, state ${run?.state}; events: ${runEvents(runId).join(",")}`);
    await Bun.sleep(1_000);
  }
}

const dispatched: { task: string; project: string }[] = [];
async function dispatch(harness: "claude" | "pi", body: string, title: string): Promise<{ task: string; run: string }> {
  const projectId = harness === "claude" ? "claude-trusted" : "scratch";
  const reply = await call("dispatch", { project: projectId, kind: "scout", harness, body, title });
  if (!reply.ok) throw new Error(`dispatch: ${reply.error?.code} ${reply.error?.message}`);
  dispatched.push({ task: String(reply.data.task), project: projectId });
  return { task: String(reply.data.task), run: String(reply.data.run) };
}

const deliverScript = `bash mkdir -p "$FLOWRYN_REPORT_DIR" && ls src > "$FLOWRYN_REPORT_DIR/notes.md" && $FLOWRYN_BIN deliver --report "$FLOWRYN_REPORT_DIR/notes.md"`;

function piScout(extra: string[]): string {
  const text = [
    "Scout: list the top-level source modules of this repository into $FLOWRYN_REPORT_DIR/notes.md, then deliver it with $FLOWRYN_BIN deliver --report $FLOWRYN_REPORT_DIR/notes.md and end your turn.",
  ];
  if (scripted) text.push(`FLOWRYN-SCRIPT: ${[...extra, deliverScript, "say DONE"].join(" ;; ")}`);
  return text.join("\n");
}

const CLAUDE_SCOUT = [
  "Scout: read README.md in your worktree and write a summary of what Flowryn is, in at most three lines, to $FLOWRYN_REPORT_DIR/report.md.",
  "Then run $FLOWRYN_BIN deliver --report $FLOWRYN_REPORT_DIR/report.md and end your turn. Do not change any file in the repository.",
].join("\n");

// --- phases ----------------------------------------------------------------------------------
async function contracts(): Promise<void> {
  for (const harness of ["pi", "claude"] as const) {
    if (harness === "claude" && !claudeProject) {
      record("contracts", "claude", false, "skipped: needs --claude-project <a checkout Claude trusts>");
      continue;
    }
    // Pi's contract makes its own scratch repository; Claude's uses linked worktrees of the trusted checkout.
    const args = ["doctor", "--contracts", "--harness", harness, "--herdr-socket", herdrSocket!, "--json"];
    if (harness === "claude") args.push("--project", claudeProject!, "--model", CLAUDE_MODEL);
    log(`contracts: flowryn ${args.join(" ")}`);
    // Recording a pass is a human verb: script(1) gives the doctor your terminal's TTY channel.
    const proc = Bun.spawn(["script", "-q", "/dev/null", "bun", MAIN, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    writeFileSync(join(home, `contract-${harness}.log`), `${err}\n${out}`);
    // script(1) merges stderr (the step log) into the same pty; the reply is the line that starts {"ok".
    const line = out
      .split("\n")
      .map((l) => l.replace(/\r$/, ""))
      .map((l) => l.slice(Math.max(0, l.indexOf('{"ok"'))))
      .find((l) => l.startsWith('{"ok"'));
    let checks: { check: string; status: string; detail: string }[] = [];
    try {
      checks = ((JSON.parse(line ?? "") as { data: { checks: typeof checks } }).data?.checks ?? []).filter((c) => c.check.startsWith("contract"));
    } catch {
      record("contracts", harness, false, `unreadable doctor output (exit ${code}); see ${home}/contract-${harness}.log`);
      continue;
    }
    for (const step of checks.filter((c) => c.check !== `contract ${harness}`)) record("contracts", step.check.replace("contract ", ""), step.status === "ok", step.detail);
    const summary = checks.find((c) => c.check === `contract ${harness}`);
    record("contracts", `${harness} recorded`, summary?.status === "ok", summary?.detail ?? `no summary (exit ${code})`);
  }
}

/** A scout's verified report lands its run, which the daemon then cleans up (the v1 completion pass; docs/m5-notes.md). */
function landedWithReport(r: { state: string }): boolean {
  return r.state === "landed" || r.state === "cleaned";
}

async function scouts(): Promise<void> {
  const runs: ["pi" | "claude", { task: string; run: string }, number][] = [["pi", await dispatch("pi", piScout([]), "live pi scout"), 180_000]];
  if (claudeProject) runs.push(["claude", await dispatch("claude", CLAUDE_SCOUT, "live claude scout"), 420_000]);
  else record("scouts", "claude", false, "skipped: needs --claude-project <a checkout Claude trusts>");
  for (const [harness, run, timeout] of runs) {
    try {
      const done = await waitRun(run.run, `the ${harness} scout's report`, timeout, landedWithReport);
      const report = readFileSync(join(home, "data", run.task, "report.md"), "utf8").trim();
      record("scouts", harness, true, `${run.task} landed after ${Math.round((done.updated_at - done.started_at) / 1000)}s; report: ${report.split("\n")[0]!.slice(0, 120)}`);
    } catch (error) {
      record("scouts", harness, false, (error as Error).message);
    }
  }
}

async function killWorker(): Promise<void> {
  const { task, run } = await dispatch("pi", piScout(["bash perl -e 'sleep 30'"]), "live kill-worker");
  try {
    const busy = await waitRun(run, "the worker to be busy", 120_000, (r) => r.liveness === "busy" && r.proc_pid !== null);
    await Bun.sleep(4_000);
    log(`kill-worker: SIGKILL to the harness group ${busy.proc_pid} of ${task}`);
    await terminate({ pid: busy.proc_pid!, start: busy.proc_start!, exe: busy.proc_exe! }, { group: true, graceMs: 0 });
    const done = await waitRun(run, "the resumed worker to deliver", 240_000, landedWithReport);
    const events = runEvents(run);
    const ok = done.resume_count === 1 && done.proc_pid !== busy.proc_pid && events.includes("run.auto_resumed");
    record("kill-worker", "resumed once and finished", ok, `resume_count ${done.resume_count}, pid ${busy.proc_pid} -> ${done.proc_pid}`);
  } catch (error) {
    record("kill-worker", "resumed once and finished", false, (error as Error).message);
  }
}

async function killDaemon_(): Promise<void> {
  const { task, run } = await dispatch("pi", piScout(["bash perl -e 'sleep 25'"]), "live kill-daemon");
  try {
    const busy = await waitRun(run, "the worker to be busy", 120_000, (r) => r.liveness === "busy" && r.proc_pid !== null);
    log(`kill-daemon: kill -9 flowrynd while ${task} works`);
    await killDaemon();
    const spool = join(home, "data", "spool", run);
    const until = Date.now() + 120_000;
    while (!(existsSync(spool) && readdirSync(spool).some((f) => f.endsWith(".json")))) {
      if (Date.now() > until) throw new Error("the worker's deliver never reached the spool");
      await Bun.sleep(1_000);
    }
    log("kill-daemon: the deliver is spooled; restarting the daemon");
    await startDaemon();
    const done = await waitRun(run, "the spooled deliver", 60_000, landedWithReport);
    const until2 = Date.now() + 30_000;
    while (!runEvents(run).includes("run.reattached") && Date.now() < until2) await Bun.sleep(500);
    const events = runEvents(run);
    const ok = done.proc_pid === busy.proc_pid && done.resume_count === 0 && events.includes("run.reattached");
    record("kill-daemon", "reattached and ingested the spool", ok, `pid ${busy.proc_pid} kept, resume_count ${done.resume_count}, reattached ${events.includes("run.reattached")}`);
  } catch (error) {
    record("kill-daemon", "reattached and ingested the spool", false, (error as Error).message);
  }
}

// --- run -------------------------------------------------------------------------------------
async function main(): Promise<number> {
  log(`scratch home ${home}; lab ${values.session}; project ${project} on ${projectBranch}; claude ${CLAUDE_MODEL}; pi ${PI_MODEL}`);
  await startDaemon();
  const added = await call("project add", { path: project, id: "scratch", mode: "local-only", "default-branch": projectBranch });
  if (!added.ok) throw new Error(`project add: ${added.error?.message}`);
  if (claudeProject) {
    const trusted = await call("project add", { path: claudeProject, id: "claude-trusted", mode: "local-only", "default-branch": claudeBranch });
    if (!trusted.ok) throw new Error(`project add: ${trusted.error?.message}`);
  }
  if (phases.includes("contracts")) await contracts();
  if (phases.some((p) => p !== "contracts")) {
    const db = openDb(join(home, "state", "flowryn.db"), { readonly: true });
    const passed = db.query("SELECT harness, version FROM harness_contracts").all();
    db.close();
    log(`recorded contract passes: ${JSON.stringify(passed)}`);
  }
  if (phases.includes("scouts")) await scouts();
  if (phases.includes("kill-worker")) await killWorker();
  if (phases.includes("kill-daemon")) await killDaemon_();
  return results.every((r) => r.ok) && results.length > 0 ? 0 : 1;
}

async function cleanup(): Promise<void> {
  for (const { task } of dispatched) await call("cancel", { target: task, reason: "live run finished" }).catch(() => undefined);
  // Failed runs cannot be cancelled; close every workspace this run opened, by id.
  const db = openDb(join(home, "state", "flowryn.db"), { readonly: true });
  const workspaces = (db.query("SELECT workspace_id FROM runs WHERE workspace_id IS NOT NULL").all() as { workspace_id: string }[]).map((r) => r.workspace_id);
  db.close();
  const runtime = new HerdrRuntime(new HerdrClient(herdrSocket!));
  for (const ws of workspaces) await runtime.closeWorkspace(ws).catch(() => undefined);
  await killDaemon();
  // Scratch-clone worktrees go with the scratch home. Only runs in the trusted checkout left git state
  // outside it: exactly the branches and worktrees this run's database recorded, under this run's prefix.
  if (claudeProject) {
    const created = createdWorktrees(join(home, "state", "flowryn.db")).filter((c) => c.worktree.startsWith(join(home, "wt", "claude-trusted")));
    removeOwnWorktrees(claudeProject, created, runPrefix, join(home, "wt"), gitIn, log);
  }
}

function gitIn(args: string[], cwd: string): { code: number; out: string } {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdin: "ignore" });
  return { code: result.exitCode, out: result.stdout.toString().trim() };
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
  const resultsPath = process.env.M2_RESULTS ?? join(home, "results.json");
  writeFileSync(resultsPath, JSON.stringify({ home, claudeProject, piModel: PI_MODEL, claudeModel: CLAUDE_MODEL, results }, null, 2));
  log(`results: ${results.filter((r) => r.ok).length}/${results.length} passed; ${resultsPath}`);
  if (!values.keep) rmSync(home, { recursive: true, force: true });
}
process.exit(code);
