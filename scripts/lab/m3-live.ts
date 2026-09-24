#!/usr/bin/env bun
/**
 * M3 leader bridges, live. Run it through scripts/lab/m3-live.sh, which owns
 * the Herdr lab session. For each harness given (default: claude and pi), it
 * starts two real leaders with `flowryn lead` in lab panes and runs the shared
 * leader bridge contract suite (src/contracts/bridge-suite.ts) against them:
 * the same steps `bun test` runs against the fake leaders.
 *
 * Everything lives in a scratch Flowryn home, removed at the end (--keep
 * leaves it). A seeded worker run (no process) raises the P0s and P1s. Claude
 * leads from a linked worktree of a checkout it already trusts
 * (--claude-project), on a `flowryn/contract-<runid>-leader` branch that is
 * removed with its worktree by exact name; ~/.claude.json is never written and
 * no dialog is ever answered. Pi leads from a scratch directory with a scratch
 * agent dir and the offline scripted provider. Results go to stdout and
 * $M3_RESULTS.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { hashToken, mintToken } from "../../src/api/auth.ts";
import type { Reply } from "../../src/api/envelope.ts";
import { renderToml } from "../../src/config/toml.ts";
import { BRIDGE_STEPS, type BridgeDriver, type BridgeEnv, type LeaderHarness, type PresentationView } from "../../src/contracts/bridge-suite.ts";
import { contractPrefix, removeOwnWorktrees } from "../../src/contracts/cleanup.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
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
  console.error("m3-live: run me through scripts/lab/m3-live.sh (a lab session socket is required)");
  process.exit(2);
}
const HARNESSES: LeaderHarness[] = ["claude", "pi"];
const wanted = (positionals.length > 0 ? positionals : HARNESSES) as LeaderHarness[];
for (const h of wanted) if (!HARNESSES.includes(h)) throw new Error(`unknown harness ${h}`);

const CLAUDE_MODEL = process.env.M3_CLAUDE_MODEL ?? "haiku";
const PI_MODEL = process.env.M3_PI_MODEL ?? "flowryn-scripted/scripted";
const scripted = PI_MODEL.startsWith("flowryn-scripted/");
const which = (name: string) => Bun.which(name) ?? "";
const PI_BIN = process.env.PI_BIN ?? (existsSync("/opt/homebrew/bin/pi-signed") ? "/opt/homebrew/bin/pi-signed" : which("pi"));
const BUN = process.execPath;

const home = realpathSync(mkdtempSync(join(tmpdir(), "fw3-")));
const sock = join(home, "run", "flowrynd.sock");
const dbPath = join(home, "state", "flowryn.db");
const { prefix: runPrefix } = contractPrefix();
const claudeProject = values["claude-project"] ? realpathSync(values["claude-project"]) : null;
const results: { harness: string; step: string; ok: boolean; detail: string; seconds: number }[] = [];

function log(line: string): void {
  const text = `${new Date().toISOString().slice(11, 19)} ${line}`;
  console.log(text);
  appendFileSync(join(home, "run.log"), text + "\n");
}

// --- the scratch home ---------------------------------------------------------------------
const piAgent = process.env.M3_PI_AGENT_DIR ?? join(home, "pi-agent");
mkdirSync(piAgent, { recursive: true });
// Pi refuses to compact a short session ("Nothing to compact"); keeping one recent token makes /compact work, as in M0 p06.
// It goes in the scratch agent dir's own settings, which need no project trust; a given agent dir is left alone.
if (!process.env.M3_PI_AGENT_DIR) writeFileSync(join(piAgent, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }) + "\n");
writeFileSync(
  join(home, "config.toml"),
  renderToml(
    {
      data_dir: join(home, "data"),
      state_dir: join(home, "state"),
      tasks: { backlog: join(home, "data", "backlog.md"), todos: join(home, "data", "todos.md") },
      tools: { tasks_axi: which("tasks-axi"), node: which("node"), git: which("git"), claude: which("claude"), pi: PI_BIN, herdr: which("herdr") },
      herdr: { socket: herdrSocket },
      // Short clocks: an interrupt's lease, Pi's inactivity, the P0 coalescing window.
      leader: { busy_lease_ms: 45_000, inactive_ms: 5_000 },
      notify: { macos: false, herdr: true, p0_coalesce_s: 1, min_interval_min: 1 },
      reconcile: { pass_ms: 5_000, wait_poll_ms: 10_000 },
    },
    "Scratch home for the M3 live leader bridge run",
  ),
);
mkdirSync(join(home, "state"), { recursive: true, mode: 0o700 });
mkdirSync(join(home, "data"), { recursive: true, mode: 0o700 });
const workerToken = mintToken("run");
{
  const db = openDb(dbPath);
  migrate(db);
  const now = Date.now();
  tx(db, () => {
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('lab', 'https://example.invalid/lab.git', ?1, 'main', 'local-only')").run(home);
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES ('lab-billing-q4', 'lab', 'ship', 'local-only', 0, 'fix', ?1)").run(now);
    // A run that has delivered: the reconciler leaves it alone, and it can still fail or ask.
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
       VALUES ('r01LAB', 'lab-billing-q4', 'pi', '0', 'ready', 'idle', 'fix', 'build', ?1, 'none', 'none', ?2, ?3, ?3)`,
    ).run(home, hashToken(workerToken), now);
  });
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

async function call(verb: string, args: Record<string, unknown>, token: string | null): Promise<Reply> {
  return (await request(sock, { proto: PROTO, ulid: ulid(), verb, token, channel: token ? null : "tty", args }, { connectMs: 1_000, replyMs: 30_000 })) as Reply;
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

// --- Herdr: the lab session, with the one lab-only method, typing into a leader's composer ------
const lab = new HerdrClient(herdrSocket, { labMethods: ["pane.send_text"] });
const runtime = new HerdrRuntime(lab);
const workspaces: string[] = [];
const knownSessions = new Set<string>();

async function typeText(pane: string, text: string): Promise<void> {
  await lab.call("pane.send_text", { pane_id: pane, text });
}

async function keys(pane: string, ...k: string[]): Promise<void> {
  await lab.call("pane.send_keys", { pane_id: pane, keys: k });
}

async function screen(pane: string): Promise<string> {
  try {
    const result = await lab.call("pane.read", { pane_id: pane, source: "recent", lines: 40 });
    return String((result.read as { text?: string } | undefined)?.text ?? result.text ?? JSON.stringify(result)).slice(-1_500);
  } catch (error) {
    return `(pane read failed: ${(error as Error).message})`;
  }
}

interface SessionRow {
  session_id: string;
  turn_no: number;
  busy: number;
  busy_until: number | null;
  user_inactive_since: number | null;
  transcript_path: string | null;
  ended_at: number | null;
}

// --- a live leader in a lab pane ---------------------------------------------------------------
class LiveLeader implements BridgeDriver {
  readonly harness: LeaderHarness;
  private readonly name: string;
  private readonly cwd: string;
  private pane = "";
  private sessionId = "";
  private readonly providerLog: string;
  private readonly sessionDir: string;
  /** Every transcript this Claude session wrote to (a compaction may start another). */
  private readonly transcripts = new Set<string>();

  constructor(harness: LeaderHarness, name: string, cwd: string) {
    this.harness = harness;
    this.name = name;
    this.cwd = cwd;
    this.providerLog = join(home, `provider-${name}.jsonl`);
    this.sessionDir = join(home, `pi-sessions-${name}`);
  }

  session(): string {
    return this.sessionId;
  }

  private row(): SessionRow {
    return withDb((db) => db.query("SELECT * FROM leader_sessions WHERE session_id = ?1").get(this.sessionId) as SessionRow);
  }

  private busyNow(): boolean {
    const r = this.row();
    return r.busy === 1 && r.busy_until !== null && r.busy_until > Date.now();
  }

  private launchScript(): string {
    const script = join(home, `lead-${this.name}.sh`);
    const lines = ["#!/bin/sh", `cd ${JSON.stringify(this.cwd)} || exit 1`, `export FLOWRYN_HOME=${JSON.stringify(home)}`];
    let args: string[];
    if (this.harness === "claude") {
      // --setting-sources user keeps a checkout's own .claude settings out; Haiku runs auto as default mode, so the one
      // long command the suite asks for is allowed up front (M0 finding 4).
      args = ["lead", "--", "--model", CLAUDE_MODEL, "--setting-sources", "user", "--allowedTools", "Bash(perl -e *)"];
    } else {
      for (const [k, v] of Object.entries({ PI_CODING_AGENT_DIR: piAgent, PI_OFFLINE: scripted ? "1" : "0", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", FLOWRYN_PROVIDER_LOG: this.providerLog })) {
        lines.push(`export ${k}=${JSON.stringify(v)}`);
      }
      args = ["lead", "--pi", "--", "--model", PI_MODEL, "--session-dir", this.sessionDir, "--no-context-files"];
      if (scripted) args.push("-e", join(ROOT, "spikes/pi/lib/scripted-provider.ts"));
    }
    lines.push(`exec ${[BUN, MAIN, ...args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ")}`);
    writeFileSync(script, lines.join("\n") + "\n", { mode: 0o700 });
    return script;
  }

  async start(): Promise<void> {
    const ws = await runtime.openWorkspace(this.cwd, `m3-${this.name}`);
    workspaces.push(ws.workspaceId);
    this.pane = ws.rootPaneId;
    const started = Date.now();
    await Bun.sleep(1_500);
    // A short command line: a long one is cut off by a shell still starting (M0 finding 11).
    await typeText(this.pane, `sh ${this.launchScript()}`);
    await keys(this.pane, "Enter");
    // Leaders start one at a time, so the newest session of this harness since the launch is this one.
    const known = [...knownSessions];
    const row = await waitFor(`the ${this.name} leader session`, 60_000, () =>
      withDb((db) =>
        (db.query("SELECT * FROM leader_sessions WHERE harness = ?1 AND started_at >= ?2 ORDER BY started_at DESC").all(this.harness, started - 1_000) as SessionRow[]).find(
          (r) => !known.includes(r.session_id),
        ),
      ),
    );
    knownSessions.add(row.session_id);
    this.sessionId = row.session_id;
    try {
      await waitFor(`${this.name} to start (session-start hook)`, 90_000, () =>
        withDb((db) => db.query("SELECT 1 FROM events WHERE kind = 'leader.session_started' AND payload LIKE ?1").get(`%"session":"${this.sessionId}"%`)),
      );
    } catch (error) {
      throw new Error(`${(error as Error).message}; a dialog may be blocking pane ${this.pane} (never answered):\n${await screen(this.pane)}`, { cause: error });
    }
    if (this.harness === "pi") await Bun.sleep(1_500);
  }

  private promptText(label: string, busy: boolean): string {
    if (this.harness === "pi") return scripted ? `FLOWRYN-SCRIPT: ${busy ? "bash perl -e 'sleep 20' ;; " : ""}say {markers}` : `${label}: reply with the single word ok.`;
    return busy
      ? `${label}: use the Bash tool to run exactly this command and wait for it to finish: perl -e 'sleep 20'. Then reply with the single word ok.`
      : `${label}: reply with the single word ok.`;
  }

  private async send(text: string): Promise<void> {
    await typeText(this.pane, text);
    await Bun.sleep(400);
    await keys(this.pane, "Enter");
  }

  private async turnEnded(before: number, timeoutMs: number): Promise<void> {
    await waitFor(`${this.name}'s turn to end`, timeoutMs, async () => {
      const r = this.row();
      if (r.turn_no <= before || this.busyNow()) return false;
      await Bun.sleep(2_000);
      return !this.busyNow();
    });
  }

  async prompt(label: string): Promise<void> {
    const before = this.row().turn_no;
    await this.send(this.promptText(label, false));
    await this.turnEnded(before, 180_000);
  }

  async promptBusy(label: string): Promise<void> {
    const before = this.row().turn_no;
    await this.send(this.promptText(label, true));
    await waitFor(`${this.name} busy`, 90_000, () => this.row().turn_no > before && this.busyNow());
    await Bun.sleep(4_000);
  }

  async finishBusy(): Promise<void> {
    await waitFor(`${this.name}'s long command to finish`, 180_000, async () => {
      if (this.busyNow()) return false;
      await Bun.sleep(3_000);
      return !this.busyNow();
    });
  }

  async typeDraft(text: string): Promise<void> {
    await typeText(this.pane, text);
  }

  async clearDraft(): Promise<void> {
    await keys(this.pane, "ctrl+u");
    await Bun.sleep(300);
  }

  async goInactive(): Promise<void> {
    // Claude: idle_prompt, about 60 s after the turn with no typing (M0 c03). Pi: the extension's own check.
    await waitFor(`${this.name} inactive`, this.harness === "claude" ? 150_000 : 60_000, () => this.row().user_inactive_since !== null);
  }

  async interrupt(): Promise<void> {
    await keys(this.pane, "Escape");
  }

  async compact(): Promise<void> {
    const since = Date.now();
    await this.send("/compact");
    await waitFor(`${this.name} to compact`, 240_000, () =>
      withDb((db) =>
        db.query("SELECT 1 FROM events WHERE kind = 'leader.session_started' AND ts >= ?1 AND payload LIKE ?2 AND payload LIKE '%\"source\":\"compact\"%'").get(since, `%"session":"${this.sessionId}"%`),
      ),
    );
    await Bun.sleep(3_000);
  }

  /**
   * What reached the model. Claude: transcript entries carrying hook context
   * (attachments) or a wake, never a compaction summary or the model's own
   * words. Pi: the scripted provider's request log, one line per request.
   */
  async saw(marker: string): Promise<number> {
    let n = 0;
    for (const file of this.historyFiles()) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.includes(marker)) continue;
        try {
          if (this.shownToModel(JSON.parse(line) as Record<string, unknown>)) n++;
        } catch {
          // a half-written line
        }
      }
    }
    return n;
  }

  /** Claude's transcripts, or this Pi leader's session files. */
  private historyFiles(): string[] {
    if (this.harness === "pi") {
      if (!existsSync(this.sessionDir)) return [];
      return Array.from(new Bun.Glob("**/*.jsonl").scanSync({ cwd: this.sessionDir, absolute: true }));
    }
    const current = this.row().transcript_path;
    if (current) this.transcripts.add(current);
    return [...this.transcripts].filter((t) => existsSync(t));
  }

  /**
   * An entry that carried text to the model: Claude hook context (an
   * attachment) or a wake (a user or system entry), never a compaction
   * summary or the model's own words; a Pi custom message or user message,
   * never an assistant reply (the scripted model echoes markers).
   */
  private shownToModel(entry: Record<string, unknown>): boolean {
    if (this.harness === "pi") {
      if (entry.type === "custom_message") return true;
      const role = (entry.message as { role?: string } | undefined)?.role;
      return entry.type === "message" && (role === "custom" || role === "user");
    }
    if (entry.isCompactSummary) return false;
    return entry.type === "attachment" || entry.type === "user" || entry.type === "system";
  }

  async quit(): Promise<void> {
    if (this.harness === "claude") {
      await keys(this.pane, "Escape");
      await this.send("/exit");
    } else await this.send("/quit");
    await waitFor(`${this.name} to end`, 60_000, () => this.row().ended_at !== null).catch(async (error) => {
      log(`${this.name}: ${(error as Error).message}; screen:\n${await screen(this.pane)}`);
      throw error;
    });
  }
}

// --- the suite's environment -------------------------------------------------------------------
async function worker(verb: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reply = await call(verb, args, workerToken);
  if (!reply.ok) throw new Error(`${verb}: ${JSON.stringify(reply.error)}`);
  return (reply.data ?? {}) as Record<string, unknown>;
}

function bridgeEnv(harness: LeaderHarness, drivers: [BridgeDriver, BridgeDriver]): BridgeEnv {
  const claude = harness === "claude";
  return {
    harness,
    driver: (i) => drivers[i],
    async openP0(mark) {
      return String((await worker("fail", { body: `${mark}: the migration stopped` })).item);
    },
    async openP1(mark) {
      await worker("ask", { options: "yes,no", body: `${mark}: keep the old schema?` });
      return withDb((db) => (db.query("SELECT id FROM items WHERE kind = 'worker_question' ORDER BY rowid DESC LIMIT 1").get() as { id: string }).id);
    },
    lease: () => withDb((db) => (db.query("SELECT session_id AS session, epoch FROM leader_lease WHERE id = 1").get() as { session: string | null; epoch: number } | null) ?? { session: null, epoch: 0 }),
    presentations: (item) => withDb((db) => db.query("SELECT session_id, turn_no, path, state FROM presentations WHERE item_id = ?1 ORDER BY carried_at").all(item) as PresentationView[]),
    leaderSession: (session) =>
      withDb((db) => {
        const row = db.query("SELECT busy, busy_until, user_inactive_since, ended_at FROM leader_sessions WHERE session_id = ?1").get(session) as SessionRow | null;
        if (!row) return { busy: false, inactive: false, ended: true };
        return { busy: row.busy === 1 && row.busy_until !== null && row.busy_until > Date.now(), inactive: row.user_inactive_since !== null, ended: row.ended_at !== null };
      }),
    notifiedItems: () => withDb((db) => (db.query("SELECT item_ids FROM notifications").all() as { item_ids: string }[]).flatMap((r) => JSON.parse(r.item_ids) as string[])),
    deliveredVia: (item) =>
      withDb((db) => {
        const rows = db.query("SELECT payload FROM events WHERE kind = 'leader.p0_delivered' ORDER BY seq DESC").all() as { payload: string }[];
        return rows.map((r) => JSON.parse(r.payload) as { item: string; path: string }).find((p) => p.item === item)?.path ?? null;
      }),
    async claimFor(session) {
      const reply = await call("leader claim", { session }, null);
      if (!reply.ok) throw new Error(`leader claim: ${JSON.stringify(reply.error)}`);
    },
    waitFor,
    sleep: (ms) => Bun.sleep(ms),
    timeouts: { turn: claude ? 240_000 : 90_000, inactive: claude ? 150_000 : 60_000, busyExpiry: claude ? 120_000 : 30_000, quiet: claude ? 20_000 : 12_000 },
    log,
  };
}

// --- run ---------------------------------------------------------------------------------------
function git(args: string[], cwd: string): { code: number; out: string } {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdin: "ignore" });
  return { code: result.exitCode, out: (result.stdout.toString() + result.stderr.toString()).trim() };
}

const createdWorktrees: { branch: string; worktree: string }[] = [];

function claudeWorktree(): string {
  const branch = `${runPrefix}leader`;
  const path = join(home, "wt", "leader");
  mkdirSync(join(home, "wt"), { recursive: true });
  createdWorktrees.push({ branch, worktree: path });
  const added = git(["worktree", "add", "-b", branch, path, "HEAD"], claudeProject!);
  if (added.code !== 0) throw new Error(`git worktree add: ${added.out}`);
  return realpathSync(path);
}

async function runSuite(harness: LeaderHarness): Promise<void> {
  let cwd: string;
  if (harness === "claude") {
    if (!claudeProject) {
      results.push({ harness, step: "suite", ok: false, detail: "skipped: needs --claude-project <a checkout Claude trusts>", seconds: 0 });
      return;
    }
    cwd = claudeWorktree();
  } else {
    cwd = join(home, "pi-cwd");
    mkdirSync(cwd, { recursive: true });
  }
  const drivers: [LiveLeader, LiveLeader] = [new LiveLeader(harness, `${harness}-a`, cwd), new LiveLeader(harness, `${harness}-b`, cwd)];
  const suiteEnv = bridgeEnv(harness, drivers);
  for (const step of BRIDGE_STEPS) {
    const started = Date.now();
    try {
      const detail = await step.run(suiteEnv);
      results.push({ harness, step: step.name, ok: true, detail, seconds: Math.round((Date.now() - started) / 1000) });
      log(`PASS ${harness} / ${step.name}: ${detail}`);
    } catch (error) {
      results.push({ harness, step: step.name, ok: false, detail: (error as Error).message, seconds: Math.round((Date.now() - started) / 1000) });
      log(`FAIL ${harness} / ${step.name}: ${(error as Error).message}`);
      break;
    }
  }
}

async function cleanup(): Promise<void> {
  for (const ws of workspaces.splice(0)) await runtime.closeWorkspace(ws).catch(() => undefined);
  if (daemon) {
    daemon.kill("SIGTERM");
    await Promise.race([daemon.exited, Bun.sleep(15_000)]);
    if (daemon.exitCode === null) daemon.kill("SIGKILL");
  }
  if (claudeProject && createdWorktrees.length > 0) removeOwnWorktrees(claudeProject, createdWorktrees, runPrefix, join(home, "wt"), git, log);
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
  log(`scratch home ${home}; lab ${values.session}; harnesses ${wanted.join(",")}; claude ${CLAUDE_MODEL}; pi ${PI_MODEL}`);
  await startDaemon();
  for (const harness of wanted) {
    await runSuite(harness);
    for (const ws of workspaces.splice(0)) await runtime.closeWorkspace(ws).catch(() => undefined);
  }
  code = results.length > 0 && results.every((r) => r.ok) ? 0 : 1;
} catch (error) {
  log(`aborted: ${(error as Error).stack ?? String(error)}`);
} finally {
  await cleanupOnce();
  const resultsPath = process.env.M3_RESULTS ?? join(home, "results.json");
  writeFileSync(resultsPath, JSON.stringify({ home, claudeProject, claudeModel: CLAUDE_MODEL, piModel: PI_MODEL, results }, null, 2));
  log(`results: ${results.filter((r) => r.ok).length}/${results.length} passed; ${resultsPath}`);
  if (!values.keep) rmSync(home, { recursive: true, force: true });
}
process.exit(code);
