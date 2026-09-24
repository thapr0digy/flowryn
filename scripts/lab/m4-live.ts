#!/usr/bin/env bun
/**
 * M4 exit, live. Run it through scripts/lab/m4-live.sh, which owns the Herdr
 * lab session. Each flow is one ship, from dispatch to merged and cleaned:
 *
 *   claude-ask  Claude leader; a real Claude worker ships a local-only commit;
 *               the leader runs `flowryn merge`, Claude prompts, the run says yes
 *   cli-tty     Claude leader; a Pi worker ships local-only; `flowryn approve`
 *               runs in a lab pane and its /dev/tty code is typed back; the
 *               leader merges (Claude prompts again) on that record
 *   pi-confirm  Pi leader; a Pi worker ships local-only; the leader calls the
 *               flowryn_merge tool and its ctx.ui.confirm is answered yes
 *   board       Pi leader; a Pi worker ships local-only; the board's approve
 *               key (a lab pane) records the approval; the leader merges
 *   forge       Pi leader; Pi workers ship through direct-PR and no-mistakes
 *               to a fake GitHub served here on 127.0.0.1 (a bare origin
 *               behind it), merged through the tool and proven
 *
 * Everything lives in a scratch Flowryn home, removed at the end (--keep
 * leaves it). The Claude flows use linked worktrees of a checkout Claude
 * already trusts (--claude-project): the project is a linked worktree on a
 * `flowryn/contract-<runid>-main` branch, the ships merge into it, and every
 * branch and worktree the run made is removed by exact name. No dialog other
 * than a merge approval (the thing under test) is ever answered, and
 * ~/.claude.json and ~/.pi are never written. Results go to stdout and $M4_RESULTS.
 */
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Reply } from "../../src/api/envelope.ts";
import { renderToml } from "../../src/config/toml.ts";
import { contractPrefix, removeOwnWorktrees } from "../../src/contracts/cleanup.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import type { RunRow } from "../../src/lifecycle/runs.ts";
import { HerdrClient } from "../../src/runtime/herdr/client.ts";
import { HerdrRuntime } from "../../src/runtime/herdr/runtime.ts";
import { request } from "../../src/transport/unix.ts";
import { ulid } from "../../src/util/ulid.ts";
import { PROTO } from "../../src/version.ts";
import { FakeGitHub } from "../../test/helpers/fake-github.ts";

const ROOT = resolve(import.meta.dir, "../..");
const MAIN = join(ROOT, "src/main.ts");
const { values, positionals } = parseArgs({
  options: {
    "herdr-socket": { type: "string" },
    session: { type: "string" },
    keep: { type: "boolean" },
    "claude-project": { type: "string" },
    "seed-contracts": { type: "boolean" },
  },
  allowPositionals: true,
});
const herdrSocket = values["herdr-socket"];
if (!herdrSocket || !values.session?.startsWith("fm-lab-")) {
  console.error("m4-live: run me through scripts/lab/m4-live.sh (a lab session socket is required)");
  process.exit(2);
}
const FLOWS = ["claude-ask", "cli-tty", "pi-confirm", "board", "forge"];
const flows = positionals.length > 0 ? positionals : FLOWS;
for (const f of flows) if (!FLOWS.includes(f)) throw new Error(`unknown flow ${f}`);

const CLAUDE_MODEL = process.env.M4_CLAUDE_MODEL ?? "haiku";
const PI_MODEL = process.env.M4_PI_MODEL ?? "flowryn-scripted/scripted";
const scripted = PI_MODEL.startsWith("flowryn-scripted/");
const which = (name: string) => Bun.which(name) ?? "";
const PI_BIN = process.env.PI_BIN ?? (existsSync("/opt/homebrew/bin/pi-signed") ? "/opt/homebrew/bin/pi-signed" : which("pi"));
const BUN = process.execPath;

const home = realpathSync(mkdtempSync(join(tmpdir(), "fw4-")));
const sock = join(home, "run", "flowrynd.sock");
const dbPath = join(home, "state", "flowryn.db");
const { prefix: runPrefix } = contractPrefix();
const claudeProject = values["claude-project"] ? realpathSync(values["claude-project"]) : null;
const results: { flow: string; check: string; ok: boolean; detail: string; seconds: number }[] = [];

function log(line: string): void {
  const text = `${new Date().toISOString().slice(11, 19)} ${line}`;
  console.log(text);
  appendFileSync(join(home, "run.log"), text + "\n");
}

function record(name: string, check: string, ok: boolean, detail: string, started: number): void {
  results.push({ flow: name, check, ok, detail, seconds: Math.round((Date.now() - started) / 1000) });
  log(`${ok ? "PASS" : "FAIL"} ${name} / ${check}: ${detail}`);
}

function git(args: string[], cwd: string): { code: number; out: string } {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdin: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return { code: result.exitCode, out: (result.stdout.toString() + result.stderr.toString()).trim() };
}

function mustGit(args: string[], cwd: string): string {
  const r = git(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.out}`);
  return r.out;
}

/** A tiny repository on main with its own identity (so a worker can commit), optionally with a bare origin. */
function scratchRepo(name: string, origin: boolean): { path: string; origin: string | null } {
  const path = join(home, "repos", name);
  mkdirSync(path, { recursive: true });
  mustGit(["init", "-q", "-b", "main"], path);
  mustGit(["config", "user.name", "flowryn m4 live"], path);
  mustGit(["config", "user.email", "m4-live@flowryn.invalid"], path);
  mustGit(["config", "commit.gpgsign", "false"], path);
  writeFileSync(join(path, "README.md"), `scratch project ${name}\n`);
  mustGit(["add", "README.md"], path);
  mustGit(["commit", "-q", "-m", "init"], path);
  if (!origin) return { path, origin: null };
  const bare = join(home, "repos", `${name}.git`);
  mustGit(["init", "-q", "--bare", "-b", "main", bare], home);
  mustGit(["remote", "add", "origin", bare], path);
  mustGit(["push", "-q", "-u", "origin", "main"], path);
  mustGit(["remote", "set-head", "origin", "main"], path);
  return { path, origin: bare };
}

// --- the fake GitHub, and the scratch home ---------------------------------------------------------
const github = await FakeGitHub.start();
const piAgent = process.env.M4_PI_AGENT_DIR ?? join(home, "pi-agent");
mkdirSync(piAgent, { recursive: true });
const bin = join(home, "bin");
mkdirSync(bin, { recursive: true });
// The real no-mistakes is a shared daemon: never reached from a lab run. This stand-in answers "no run".
writeFileSync(join(bin, "no-mistakes"), "#!/bin/sh\nexit 0\n");
chmodSync(join(bin, "no-mistakes"), 0o755);
writeFileSync(join(bin, "gh-absent"), "#!/bin/sh\nexit 1\n");
chmodSync(join(bin, "gh-absent"), 0o755);
writeFileSync(
  join(home, "config.toml"),
  renderToml(
    {
      data_dir: join(home, "data"),
      state_dir: join(home, "state"),
      tasks: { backlog: join(home, "data", "backlog.md"), todos: join(home, "data", "todos.md") },
      tools: { tasks_axi: which("tasks-axi"), node: which("node"), git: which("git"), claude: which("claude"), pi: PI_BIN, herdr: which("herdr"), no_mistakes: join(bin, "no-mistakes"), gh: join(bin, "gh-absent") },
      herdr: { socket: herdrSocket },
      github: { api_url: github.apiUrl, poll_ms: 2_000 },
      workers: {
        worktree_root: join(home, "wt"),
        branch_prefix: runPrefix,
        claude: { model: CLAUDE_MODEL, effort: "low", pretrust: "check" },
        pi: {
          model: PI_MODEL,
          extensions: scripted ? [join(ROOT, "spikes/pi/lib/scripted-provider.ts")] : [],
          agent_dir: piAgent,
          session_dir: join(home, "pi-sessions"),
          no_context_files: true,
          env: { PI_OFFLINE: scripted ? "1" : "0", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
        },
      },
      leader: { busy_lease_ms: 45_000, inactive_ms: 5_000 },
      notify: { macos: false, herdr: false },
      reconcile: { pass_ms: 5_000, wait_poll_ms: 10_000 },
    },
    "Scratch home for the M4 live exit run",
  ),
);
mkdirSync(join(home, "state"), { recursive: true, mode: 0o700 });
mkdirSync(join(home, "data"), { recursive: true, mode: 0o700 });
{
  const db = openDb(dbPath);
  migrate(db);
  db.close();
}
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("FLOWRYN_") && k !== "CLAUDECODE" && !k.startsWith("CLAUDE_CODE_")) env[k] = v;
env.FLOWRYN_HOME = home;

let daemon: ReturnType<typeof Bun.spawn> | null = null;
async function startDaemon(): Promise<void> {
  const fd = openSync(join(home, "daemon.log"), "a");
  daemon = Bun.spawn([BUN, MAIN, "daemon", "run"], { env, stdin: "ignore", stdout: fd, stderr: fd });
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

/** A call from "your own terminal" (channel tty): this run plays you for dispatch and project verbs. */
async function call(verb: string, args: Record<string, unknown>): Promise<Reply> {
  return (await request(sock, { proto: PROTO, ulid: ulid(), verb, token: null, channel: "tty", args }, { connectMs: 1_000, replyMs: 120_000 })) as Reply;
}

function withDb<T>(fn: (db: Db) => T): T {
  const db = openDb(dbPath, { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

async function waitFor<T>(what: string, timeoutMs: number, check: () => T | null | undefined | false | Promise<T | null | undefined | false>): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null && value !== undefined && value !== false) return value as T;
    if (Date.now() > until) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}`);
    await Bun.sleep(500);
  }
}

function readRun(runId: string): RunRow {
  return withDb((db) => db.query("SELECT * FROM runs WHERE id = ?1").get(runId) as RunRow);
}

function runEvents(runId: string): string {
  return withDb((db) => (db.query("SELECT kind FROM events WHERE run_id = ?1 ORDER BY seq").all(runId) as { kind: string }[]).map((e) => e.kind).join(","));
}

async function waitRun(runId: string, what: string, timeoutMs: number, check: (r: RunRow) => boolean): Promise<RunRow> {
  try {
    return await waitFor(what, timeoutMs, () => {
      const run = readRun(runId);
      if (run?.state === "failed") throw new Error(`the run failed while waiting for ${what}`);
      return run && check(run) ? run : null;
    });
  } catch (error) {
    const run = readRun(runId);
    throw new Error(`${(error as Error).message}; state ${run?.state}, liveness ${run?.liveness}, cleanup ${run?.cleanup ?? "-"}: ${run?.cleanup_detail ?? ""}; events: ${runEvents(runId)}`, { cause: error });
  }
}

function mergeChannel(task: string): string {
  return withDb((db) => (db.query("SELECT a.channel FROM merges m JOIN approvals a ON a.id = m.approval_id WHERE m.task_id = ?1 AND m.state = 'merged'").get(task) as { channel: string } | null)?.channel ?? "none");
}

// --- Herdr: the lab session, with the one lab-only method, typing into a pane ------------------------
const lab = new HerdrClient(herdrSocket, { labMethods: ["pane.send_text"] });
const runtime = new HerdrRuntime(lab);
const workspaces: string[] = [];

async function typeText(pane: string, text: string): Promise<void> {
  await lab.call("pane.send_text", { pane_id: pane, text });
}

async function keys(pane: string, ...k: string[]): Promise<void> {
  await lab.call("pane.send_keys", { pane_id: pane, keys: k });
}

async function screen(pane: string, lines = 60): Promise<string> {
  try {
    const result = await lab.call("pane.read", { pane_id: pane, source: "recent", lines });
    return String((result.read as { text?: string } | undefined)?.text ?? result.text ?? JSON.stringify(result));
  } catch (error) {
    return `(pane read failed: ${(error as Error).message})`;
  }
}

async function paneAt(cwd: string, label: string): Promise<string> {
  const ws = await runtime.openWorkspace(cwd, label);
  workspaces.push(ws.workspaceId);
  await Bun.sleep(1_500);
  return ws.rootPaneId;
}

/** Run a command line in a pane through a script file (a long typed line is cut off, M0 finding 11). */
async function runInPane(pane: string, name: string, lines: string[]): Promise<void> {
  const script = join(home, `${name}.sh`);
  writeFileSync(script, ["#!/bin/sh", `export FLOWRYN_HOME=${JSON.stringify(home)}`, ...lines].join("\n") + "\n", { mode: 0o700 });
  await typeText(pane, `sh ${script}`);
  await keys(pane, "Enter");
}

// --- a live leader ---------------------------------------------------------------------------------------
const knownSessions = new Set<string>();

class LiveLeader {
  readonly harness: "claude" | "pi";
  pane = "";
  session = "";
  private readonly cwd: string;

  constructor(harness: "claude" | "pi", cwd: string) {
    this.harness = harness;
    this.cwd = cwd;
  }

  async start(): Promise<void> {
    this.pane = await paneAt(this.cwd, `m4-${this.harness}-leader`);
    const started = Date.now();
    const exports: string[] = [`cd ${JSON.stringify(this.cwd)} || exit 1`];
    let args: string[];
    if (this.harness === "claude") {
      args = ["lead", "--", "--model", CLAUDE_MODEL, "--setting-sources", "user"];
    } else {
      for (const [k, v] of Object.entries({ PI_CODING_AGENT_DIR: piAgent, PI_OFFLINE: scripted ? "1" : "0", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" })) exports.push(`export ${k}=${JSON.stringify(v)}`);
      args = ["lead", "--pi", "--", "--model", PI_MODEL, "--session-dir", join(home, "pi-leader-sessions"), "--no-context-files"];
      if (scripted) args.push("-e", join(ROOT, "spikes/pi/lib/scripted-provider.ts"));
    }
    await runInPane(this.pane, `lead-${this.harness}`, [...exports, `exec ${[BUN, MAIN, ...args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ")}`]);
    const known = [...knownSessions];
    const row = await waitFor(`the ${this.harness} leader session`, 60_000, () =>
      withDb((db) =>
        (db.query("SELECT session_id FROM leader_sessions WHERE harness = ?1 AND started_at >= ?2 ORDER BY started_at DESC").all(this.harness, started - 1_000) as { session_id: string }[]).find(
          (r) => !known.includes(r.session_id),
        ),
      ),
    );
    knownSessions.add(row.session_id);
    this.session = row.session_id;
    try {
      await waitFor(`${this.harness} to claim the lease`, 120_000, () => withDb((db) => (db.query("SELECT session_id FROM leader_lease WHERE id = 1").get() as { session_id: string | null } | null)?.session_id === this.session));
    } catch (error) {
      throw new Error(`${(error as Error).message}; a dialog may be blocking pane ${this.pane} (never answered):\n${await screen(this.pane)}`, { cause: error });
    }
    await Bun.sleep(this.harness === "pi" ? 1_500 : 3_000);
  }

  async send(text: string): Promise<void> {
    await typeText(this.pane, text);
    await Bun.sleep(400);
    await keys(this.pane, "Enter");
  }

  /** Wait for a confirmation on the leader's screen, then answer it yes (Enter: the first choice, Yes). */
  async approveOnScreen(pattern: RegExp, timeoutMs: number): Promise<string> {
    const shown = await waitFor(`the ${this.harness} confirmation`, timeoutMs, async () => {
      const text = await screen(this.pane);
      return pattern.test(text) ? text : null;
    });
    await Bun.sleep(500);
    await keys(this.pane, "Enter");
    return shown;
  }

  async quit(): Promise<void> {
    if (this.harness === "claude") {
      await keys(this.pane, "Escape");
      await this.send("/exit");
    } else await this.send("/quit");
    await waitFor(`${this.harness} to end`, 60_000, () => withDb((db) => (db.query("SELECT ended_at FROM leader_sessions WHERE session_id = ?1").get(this.session) as { ended_at: number | null }).ended_at !== null)).catch(
      async (error) => log(`${this.harness}: ${(error as Error).message}; screen:\n${await screen(this.pane)}`),
    );
  }

  /** Merge a task the way this leader does: Claude runs the command and its prompt is answered; Pi calls the tool and its confirm is answered. */
  async merge(task: string): Promise<string> {
    if (this.harness === "claude") {
      await this.send(`Use the Bash tool to run exactly this command, once: flowryn merge ${task}. Then reply with the one line it printed about the merge.`);
      return this.approveOnScreen(/Do you want to proceed/, 240_000);
    }
    const script = scripted ? `FLOWRYN-SCRIPT: tool flowryn_merge {"task":"${task}"} ;; say merged` : `Call the flowryn_merge tool once with task ${task}, then reply ok.`;
    await this.send(script);
    return this.approveOnScreen(new RegExp(`Merge ${task}\\?`), 120_000);
  }
}

// --- ships -----------------------------------------------------------------------------------------------
const dispatched: string[] = [];

async function dispatch(project: string, harness: "claude" | "pi", body: string, title: string): Promise<{ task: string; run: string }> {
  const reply = await call("dispatch", { project, kind: "ship", harness, body, title });
  if (!reply.ok) throw new Error(`dispatch: ${JSON.stringify(reply.error)}`);
  const data = reply.data as { task: string; run: string };
  dispatched.push(data.task);
  log(`dispatched ${data.task} (${harness}, ${project})`);
  return data;
}

function piShip(file: string, mode: "local" | "pr", repo?: string): string {
  const commit = `bash printf '%s\\n' '${file}' > ${file}.txt && git add ${file}.txt && git commit -q -m 'm4 live: ${file}'`;
  const steps =
    mode === "local"
      ? [commit, "bash $FLOWRYN_BIN deliver --local", "say DONE"]
      : [
          commit,
          "bash git push -q origin HEAD",
          `bash b=$(git rev-parse --abbrev-ref HEAD) && curl -s -X POST -d "{\\"title\\":\\"m4 live ${file}\\",\\"head\\":\\"$b\\",\\"base\\":\\"main\\"}" ${github.apiUrl}/repos/${repo}/pulls | jq -r .html_url > "$FLOWRYN_REPORT_DIR/pr-url"`,
          'bash $FLOWRYN_BIN deliver --pr "$(cat "$FLOWRYN_REPORT_DIR/pr-url")"',
          "say DONE",
        ];
  return [`Ship: add ${file}.txt, commit it, and deliver.`, scripted ? `FLOWRYN-SCRIPT: ${steps.join(" ;; ")}` : "Follow your contract to deliver."].join("\n");
}

async function landed(name: string, task: string, run: string, channel: string, started: number): Promise<void> {
  const done = await waitRun(run, `${task} merged and cleaned`, 240_000, (r) => r.state === "cleaned");
  const got = mergeChannel(task);
  record(name, `merged and cleaned via ${channel}`, got === channel && !existsSync(done.worktree_path), `${task}: channel ${got}, worktree ${existsSync(done.worktree_path) ? "still there" : "removed"}, cleanup ${done.cleanup}`, started);
}

/** You, in a lab pane: `flowryn approve <task>`, with the code read off the pane and typed back. */
async function approveInPane(task: string): Promise<string> {
  const pane = await paneAt(home, `m4-approve-${task}`);
  await runInPane(pane, `approve-${task}`, [`exec ${BUN} ${MAIN} approve ${task}`]);
  const code = await waitFor("the approve code", 60_000, async () => /Type ([A-Z]{4}) to approve/.exec(await screen(pane))?.[1]);
  await typeText(pane, code);
  await keys(pane, "Enter");
  return waitFor("the approval", 30_000, async () => {
    const text = await screen(pane);
    return /approval: a\d+/.test(text) ? text : null;
  });
}

/** You, on the board in a lab pane: a, the ship's number, the code, then back and quit. */
async function approveOnBoard(task: string): Promise<string> {
  const pane = await paneAt(home, "m4-board");
  await runInPane(pane, "board", [`exec ${BUN} ${MAIN} board`]);
  await waitFor("the board", 30_000, async () => (await screen(pane)).includes("a approve a merge"));
  await typeText(pane, "a");
  const number = await waitFor("the approve list", 20_000, async () => new RegExp(`(\\d+)\\. ${task}`).exec(await screen(pane))?.[1]);
  await typeText(pane, number);
  await keys(pane, "Enter");
  const code = await waitFor("the board's code", 60_000, async () => /Type ([A-Z]{4}) to approve/.exec(await screen(pane))?.[1]);
  await typeText(pane, code);
  await keys(pane, "Enter");
  const shown = await waitFor("the board approval", 30_000, async () => {
    const text = await screen(pane);
    return text.includes(`Approved ${task}`) ? text : null;
  });
  await keys(pane, "Enter");
  await Bun.sleep(1_000);
  await typeText(pane, "q");
  return shown;
}

// --- flows -----------------------------------------------------------------------------------------------
async function flow(name: string, body: () => Promise<void>): Promise<void> {
  if (!flows.includes(name)) return;
  const started = Date.now();
  try {
    await body();
  } catch (error) {
    record(name, "flow", false, (error as Error).message, started);
  }
}

const createdWorktrees: { branch: string; worktree: string }[] = [];

function trustedWorktree(suffix: string): string {
  const branch = `${runPrefix}${suffix}`;
  const path = join(home, "wt", `trusted-${suffix}`);
  mkdirSync(join(home, "wt"), { recursive: true });
  createdWorktrees.push({ branch, worktree: path });
  mustGit(["worktree", "add", "-q", "-b", branch, path, "HEAD"], claudeProject!);
  return realpathSync(path);
}

async function main(): Promise<number> {
  log(`scratch home ${home}; lab ${values.session}; flows ${flows.join(",")}; claude ${CLAUDE_MODEL}; pi ${PI_MODEL}; fake GitHub ${github.apiUrl}`);
  await startDaemon();
  const local = scratchRepo("local", false);
  const pr = scratchRepo("pr", true);
  const nm = scratchRepo("nm", true);
  github.addRepo("acme", "pr", { bare: pr.origin });
  github.addRepo("acme", "nm", { bare: nm.origin });
  for (const [id, path, mode, url] of [
    ["local", local.path, "local-only", undefined],
    ["pr", pr.path, "direct-PR", "https://github.com/acme/pr.git"],
    ["nm", nm.path, "no-mistakes", "https://github.com/acme/nm.git"],
  ] as const) {
    const added = await call("project add", { path, id, mode, harness: "pi", ...(url ? { "repo-url": url } : {}) });
    if (!added.ok) throw new Error(`project add ${id}: ${JSON.stringify(added.error)}`);
  }
  let trustedPrimary: string | null = null;
  if (claudeProject && (flows.includes("claude-ask") || flows.includes("cli-tty"))) {
    trustedPrimary = trustedWorktree("main");
    const added = await call("project add", { path: trustedPrimary, id: "trusted", mode: "local-only", "default-branch": `${runPrefix}main`, harness: "claude" });
    if (!added.ok) throw new Error(`project add trusted: ${JSON.stringify(added.error)}`);
  }

  // The contract gate: dispatch refuses a harness version with no passing contract run.
  if (values["seed-contracts"]) {
    const db = openDb(dbPath);
    const versions: [string, string][] = [["pi", Bun.spawnSync([PI_BIN, "--version"]).stdout.toString().trim()], ["claude", /(\d+\.\d+\.\d+)/.exec(Bun.spawnSync([which("claude"), "--version"]).stdout.toString())?.[1] ?? "?"]];
    tx(db, () => {
      for (const [h, v] of versions) db.query("INSERT OR IGNORE INTO harness_contracts (harness, version, passed_at, report_path) VALUES (?1, ?2, ?3, 'seeded by m4-live --seed-contracts')").run(h, v, Date.now());
    });
    db.close();
    log(`contracts seeded (not run): ${JSON.stringify(versions)}`);
  } else {
    for (const harness of ["pi", "claude"] as const) {
      if (harness === "claude" && !claudeProject) continue;
      const args = ["doctor", "--contracts", "--harness", harness, "--herdr-socket", herdrSocket!, "--json"];
      if (harness === "claude") args.push("--project", claudeProject!, "--model", CLAUDE_MODEL);
      const started = Date.now();
      log(`contracts: flowryn ${args.join(" ")}`);
      const proc = Bun.spawn(["script", "-q", "/dev/null", BUN, MAIN, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [out, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      writeFileSync(join(home, `contract-${harness}.log`), out);
      const recorded = withDb((db) => db.query("SELECT version FROM harness_contracts WHERE harness = ?1").get(harness) as { version: string } | null);
      record("contracts", harness, recorded !== null, recorded ? `${harness} ${recorded.version} passed and was recorded` : `not recorded (exit ${code}); see ${home}/contract-${harness}.log`, started);
    }
  }

  // Claude leader: claude-ask and cli-tty.
  if (claudeProject && (flows.includes("claude-ask") || flows.includes("cli-tty"))) {
    const leader = new LiveLeader("claude", trustedWorktree("leader"));
    await leader.start();
    await flow("claude-ask", async () => {
      const started = Date.now();
      const { task, run } = await dispatch(
        "trusted",
        "claude",
        `Create a new file named m4-live-claude-ask.txt in your worktree containing the single line: claude-ask. Commit it on your branch with git (git add m4-live-claude-ask.txt, then git commit -m "m4 live: claude-ask"). Do not push and do not change any other file. Then run $FLOWRYN_BIN deliver --local and end your turn.`,
        "m4 live claude-ask",
      );
      await waitRun(run, `${task} delivered`, 480_000, (r) => r.state === "ready");
      record("claude-ask", "a real Claude worker delivered its branch", true, task, started);
      const shown = await leader.merge(task);
      // Claude's own permission dialog (M0 c08); the screen is kept in the run's home. The recorded channel is the proof it was this prompt.
      writeFileSync(join(home, `screen-${task}.txt`), shown);
      record("claude-ask", "Claude prompted before the merge ran", /Do you want to proceed/.test(shown), shown.split("\n").filter((l) => /proceed|flowryn merge|Bash|word/i.test(l)).slice(-4).join(" | ").slice(0, 400), started);
      await landed("claude-ask", task, run, "claude-ask", started);
      record("claude-ask", "the commit is on the project's main", mustGit(["show", `${runPrefix}main:m4-live-claude-ask.txt`], trustedPrimary!) === "claude-ask", `${runPrefix}main has m4-live-claude-ask.txt`, started);
    });
    await flow("cli-tty", async () => {
      const started = Date.now();
      const { task, run } = await dispatch("local", "pi", piShip("cli-tty", "local"), "m4 live cli-tty");
      await waitRun(run, `${task} delivered`, 180_000, (r) => r.state === "ready");
      const shown = await approveInPane(task);
      record("cli-tty", "approve read its code from /dev/tty in a lab pane", /approval: a\d+/.test(shown), shown.split("\n").filter((l) => /Merge|head|approval/.test(l)).slice(0, 4).join(" | ").slice(0, 300), started);
      await leader.merge(task);
      await landed("cli-tty", task, run, "cli-tty", started);
    });
    await leader.quit();
    for (const ws of workspaces.splice(0)) await runtime.closeWorkspace(ws).catch(() => undefined);
  } else if (flows.includes("claude-ask") || flows.includes("cli-tty")) {
    record("claude", "flows", false, "skipped: needs --claude-project <a checkout Claude trusts>", Date.now());
  }

  // Pi leader: pi-confirm, board and the forge flows.
  if (flows.some((f) => ["pi-confirm", "board", "forge"].includes(f))) {
    const cwd = join(home, "pi-cwd");
    mkdirSync(cwd, { recursive: true });
    const leader = new LiveLeader("pi", cwd);
    await leader.start();
    await flow("pi-confirm", async () => {
      const started = Date.now();
      const { task, run } = await dispatch("local", "pi", piShip("pi-confirm", "local"), "m4 live pi-confirm");
      await waitRun(run, `${task} delivered`, 180_000, (r) => r.state === "ready");
      const shown = await leader.merge(task);
      writeFileSync(join(home, `screen-${task}.txt`), shown);
      record("pi-confirm", "the flowryn_merge tool asked with ctx.ui.confirm", shown.includes(`Merge ${task}?`), shown.split("\n").filter((l) => /Merge|head|branch/.test(l)).slice(0, 3).join(" | ").slice(0, 300), started);
      await landed("pi-confirm", task, run, "pi-confirm", started);
      record("pi-confirm", "the commit is on the project's main", mustGit(["show", "main:pi-confirm.txt"], local.path) === "pi-confirm", "local main has pi-confirm.txt", started);
    });
    await flow("board", async () => {
      const started = Date.now();
      const { task, run } = await dispatch("local", "pi", piShip("board", "local"), "m4 live board");
      await waitRun(run, `${task} delivered`, 180_000, (r) => r.state === "ready");
      const shown = await approveOnBoard(task);
      record("board", "the board's approve key recorded the approval", shown.includes(`Approved ${task}`), `board showed "Approved ${task}"`, started);
      await leader.merge(task);
      await landed("board", task, run, "board", started);
    });
    await flow("forge", async () => {
      for (const [project, repo] of [
        ["pr", "acme/pr"],
        ["nm", "acme/nm"],
      ] as const) {
        const started = Date.now();
        const { task, run } = await dispatch(project, "pi", piShip(`forge-${project}`, "pr", repo), `m4 live forge ${project}`);
        await waitRun(run, `${task} delivered (named-head gate)`, 180_000, (r) => r.state === "ready");
        await leader.merge(task);
        await landed("forge", task, run, "pi-confirm", started);
        const fake = github.repo(repo).prs.at(-1)!;
        record("forge", `${project}: the fake GitHub merged the PR at its head`, fake.merged && mustGit(["show", `main:forge-${project}.txt`], project === "pr" ? pr.origin! : nm.origin!) === `forge-${project}`, `PR ${repo}#${fake.number} merged at ${fake.mergeSha?.slice(0, 8)}`, started);
      }
    });
    await leader.quit();
  }
  return results.length > 0 && results.every((r) => r.ok) ? 0 : 1;
}

async function cleanup(): Promise<void> {
  for (const task of dispatched) await call("cancel", { target: task, reason: "live run finished" }).catch(() => undefined);
  const known = withDb((db) => (db.query("SELECT workspace_id FROM runs WHERE workspace_id IS NOT NULL").all() as { workspace_id: string }[]).map((r) => r.workspace_id));
  for (const ws of [...workspaces.splice(0), ...known]) await runtime.closeWorkspace(ws).catch(() => undefined);
  if (daemon) {
    daemon.kill("SIGTERM");
    await Promise.race([daemon.exited, Bun.sleep(15_000)]);
    if (daemon.exitCode === null) daemon.kill("SIGKILL");
  }
  await github.stop().catch(() => undefined);
  if (claudeProject) {
    // Exactly what this run made in the trusted checkout: its project and leader worktrees, and the task worktrees and branches.
    const tasks = withDb((db) => db.query("SELECT branch, worktree_path AS worktree FROM runs WHERE worktree_path LIKE ?1").all(`${join(home, "wt", "trusted")}%`) as { branch: string; worktree: string }[]);
    removeOwnWorktrees(claudeProject, [...tasks, ...createdWorktrees.toReversed()], runPrefix, join(home, "wt"), git, log);
  }
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
  const resultsPath = process.env.M4_RESULTS ?? join(home, "results.json");
  writeFileSync(resultsPath, JSON.stringify({ home, claudeProject, claudeModel: CLAUDE_MODEL, piModel: PI_MODEL, results }, null, 2));
  log(`results: ${results.filter((r) => r.ok).length}/${results.length} passed; ${resultsPath}`);
  if (!values.keep) rmSync(home, { recursive: true, force: true });
}
process.exit(code);
