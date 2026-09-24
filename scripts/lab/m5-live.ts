#!/usr/bin/env bun
/**
 * M5 exit, live. Run it through scripts/lab/m5-live.sh, which owns the Herdr
 * lab session. Each flow runs two independent two-phase features side by side
 * under its one leader (design section 17), each in its own project: phase 1
 * runs the feature workflow (design, review, build, visual QA, review, ship)
 * and hands in a phase plan with its design; approving the design approves the
 * plan; phase 1 merges and is cleaned; phase 2 starts by itself and ships.
 * Both phase-1 workers are live together; gates and merges take turns with
 * the one leader and the one of you, as each opens. The worker pool is capped
 * at 4, and a sampler counts the runs with a live harness process every
 * second: a flow passes its concurrency check only if the peak is 2 to 4.
 *
 *   pi      Pi leader; Pi workers on the scripted provider; a scratch repo.
 *           Design gate: flowryn_gate_pass (ctx.ui.confirm); QA gate: the board.
 *   claude  Claude leader; phase 1 on a scripted Pi worker, phase 2 on a real
 *           Claude worker; a linked worktree of a checkout Claude trusts.
 *           Design gate: Claude's permission prompt; QA gate: `flowryn approve
 *           --gate qa` in a lab pane.
 *
 * Everything lives in a scratch Flowryn home, removed at the end (--keep
 * leaves it). Every branch and worktree made in the trusted checkout is
 * `flowryn/contract-<runid>-…` and removed by exact name; every container is
 * labelled with a run of this home and removed at the end. Results go to
 * stdout and $M5_RESULTS.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  console.error("m5-live: run me through scripts/lab/m5-live.sh (a lab session socket is required)");
  process.exit(2);
}
const FLOWS = ["pi", "claude"];
const flows = positionals.length > 0 ? positionals : FLOWS;
for (const f of flows) if (!FLOWS.includes(f)) throw new Error(`unknown flow ${f}`);

const CLAUDE_MODEL = process.env.M5_CLAUDE_MODEL ?? "haiku";
const PI_MODEL = process.env.M5_PI_MODEL ?? "flowryn-scripted/scripted";
const scripted = PI_MODEL.startsWith("flowryn-scripted/");
if (!scripted) {
  console.error("m5-live: the phase scripts need the scripted Pi provider (M5_PI_MODEL=flowryn-scripted/scripted)");
  process.exit(2);
}
const MIN_FREE_GB = Number(process.env.M5_MIN_FREE_GB ?? "4");
/** The live concurrency the exit proves: at least 2 workers at once, never more than 4. */
const MIN_LIVE = 2;
const MAX_LIVE = 4;
const which = (name: string) => Bun.which(name) ?? "";
const PI_BIN = process.env.PI_BIN ?? (existsSync("/opt/homebrew/bin/pi-signed") ? "/opt/homebrew/bin/pi-signed" : which("pi"));
const BUN = process.execPath;

const home = realpathSync(mkdtempSync(join(tmpdir(), "fw5-")));
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

/** A tiny local-only repository on main with its own identity, so a worker can commit. */
function scratchRepo(name: string): string {
  const path = join(home, "repos", name);
  mkdirSync(path, { recursive: true });
  mustGit(["init", "-q", "-b", "main"], path);
  mustGit(["config", "user.name", "flowryn m5 live"], path);
  mustGit(["config", "user.email", "m5-live@flowryn.invalid"], path);
  mustGit(["config", "commit.gpgsign", "false"], path);
  writeFileSync(join(path, "README.md"), `scratch shop ${name}\n`);
  mustGit(["add", "README.md"], path);
  mustGit(["commit", "-q", "-m", "init"], path);
  return path;
}

// --- the scratch home ----------------------------------------------------------------------------------
const piAgent = process.env.M5_PI_AGENT_DIR ?? join(home, "pi-agent");
mkdirSync(piAgent, { recursive: true });
const bin = join(home, "bin");
mkdirSync(bin, { recursive: true });
// The real no-mistakes is a shared daemon: never reached from a lab run. This stand-in answers "no run".
writeFileSync(join(bin, "no-mistakes"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
writeFileSync(join(bin, "gh-absent"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
writeFileSync(
  join(home, "config.toml"),
  renderToml(
    {
      data_dir: join(home, "data"),
      state_dir: join(home, "state"),
      tasks: { backlog: join(home, "data", "backlog.md"), todos: join(home, "data", "todos.md") },
      tools: { tasks_axi: which("tasks-axi"), node: which("node"), git: which("git"), claude: which("claude"), pi: PI_BIN, herdr: which("herdr"), docker: which("docker"), no_mistakes: join(bin, "no-mistakes"), gh: join(bin, "gh-absent") },
      herdr: { socket: herdrSocket },
      github: { api_url: "http://127.0.0.1:9" },
      workers: {
        worktree_root: join(home, "wt"),
        branch_prefix: runPrefix,
        claude: { model: CLAUDE_MODEL, effort: "low", pretrust: "check" },
        pi: {
          model: PI_MODEL,
          extensions: [join(ROOT, "spikes/pi/lib/scripted-provider.ts")],
          agent_dir: piAgent,
          session_dir: join(home, "pi-sessions"),
          no_context_files: true,
          env: { PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
        },
      },
      // The design's pools; the host check reads this machine (vm_stat and the load average).
      capacity: { worker: MAX_LIVE, validation: 5, docker_env: 5, browser: 5, host: { min_free_mem_gb: MIN_FREE_GB, max_load_per_core: 1.5 } },
      autonomy: { default: "plan" },
      sched: { pass_ms: 5_000 },
      leader: { busy_lease_ms: 45_000, inactive_ms: 5_000 },
      notify: { macos: false, herdr: false },
      reconcile: { pass_ms: 5_000, wait_poll_ms: 10_000, ring_interval_ms: 1_800_000 },
    },
    "Scratch home for the M5 live exit run",
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
// A live run never posts to your Mac: its scratch daemon records notifications and delivers none.
env.FLOWRYN_NOTIFY = "off";

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
    throw new Error(`${(error as Error).message}; state ${run?.state}, stage ${run?.stage} ${run?.stage_state}, liveness ${run?.liveness}; events: ${runEvents(runId)}`, { cause: error });
  }
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
    this.pane = await paneAt(this.cwd, `m5-${this.harness}-leader`);
    const started = Date.now();
    const exports: string[] = [`cd ${JSON.stringify(this.cwd)} || exit 1`];
    let args: string[];
    if (this.harness === "claude") {
      args = ["lead", "--", "--model", CLAUDE_MODEL, "--setting-sources", "user"];
    } else {
      for (const [k, v] of Object.entries({ PI_CODING_AGENT_DIR: piAgent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" })) exports.push(`export ${k}=${JSON.stringify(v)}`);
      args = ["lead", "--pi", "--", "--model", PI_MODEL, "--session-dir", join(home, "pi-leader-sessions"), "--no-context-files", "-e", join(ROOT, "spikes/pi/lib/scripted-provider.ts")];
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

  /** Pass a review gate the way this leader does: Claude runs the command and its prompt is answered; Pi calls the tool and its confirm is answered. */
  async passGate(task: string, stage: string): Promise<string> {
    if (this.harness === "claude") {
      await this.send(`The user reviewed the page and approves it. Use the Bash tool to run exactly this command, once: flowryn gate pass ${task}. Then reply with the one line it printed.`);
      return this.approveOnScreen(/Do you want to proceed/, 240_000);
    }
    await this.send(`FLOWRYN-SCRIPT: tool flowryn_gate_pass {"task":"${task}"} ;; say passed`);
    return this.approveOnScreen(new RegExp(`Pass the ${stage} review of ${task}\\?`), 120_000);
  }

  async merge(task: string): Promise<string> {
    if (this.harness === "claude") {
      await this.send(`Use the Bash tool to run exactly this command, once: flowryn merge ${task}. Then reply with the one line it printed about the merge.`);
      return this.approveOnScreen(/Do you want to proceed/, 240_000);
    }
    await this.send(`FLOWRYN-SCRIPT: tool flowryn_merge {"task":"${task}"} ;; say merged`);
    return this.approveOnScreen(new RegExp(`Merge ${task}\\?`), 120_000);
  }
}

// --- the scripted phase-1 worker ------------------------------------------------------------------------
/**
 * Phase 1's script, one step per model turn (spikes/pi/NOTES.md). Each stage
 * ends with `stage done`: after a review gate the turn ends and the verdict's
 * steer starts the next turn; after an ungated stage a short sleep lets the
 * stage-start steer arrive mid-turn, the documented Pi channel (M0 p13). Every
 * stage starts by acknowledging its steers. Visual QA is real: an nginx:alpine
 * container labelled with the run, a curl, a chrome-devtools-axi screenshot.
 */
function phaseOneScript(label: string, planFile: string): string {
  const site = `m5-live/${label}`;
  const ack = "for id in $($FLOWRYN_BIN inbox --json | jq -r '.data.steers[].id'); do $FLOWRYN_BIN ack $id; done";
  const container = "flowryn-qa-$FLOWRYN_RUN";
  const axi = "CHROME_DEVTOOLS_AXI_SESSION=flowryn-$FLOWRYN_RUN chrome-devtools-axi";
  const steps = [
    `bash mkdir -p "$FLOWRYN_REPORT_DIR/design" && printf '<html><body><h1>Design: the ${label} cart page</h1><p>A static cart page, served by nginx. Assumption: the page carries an element with id cart. Phase 2 adds checkout.</p></body></html>\\n' > "$FLOWRYN_REPORT_DIR/design/design.html" && cp ${JSON.stringify(planFile)} "$FLOWRYN_REPORT_DIR/plan.md" && $FLOWRYN_BIN stage done --review "file://$FLOWRYN_REPORT_DIR/design/design.html" --plan-file "$FLOWRYN_REPORT_DIR/plan.md"`,
    "say the design is ready for review",
    `bash ${ack} && mkdir -p ${site} && printf '<html><body><h1 id="cart">Cart</h1></body></html>\\n' > ${site}/index.html && printf 'grep -q "id=.cart." "$(dirname "$0")/index.html"\\n' > ${site}/test.sh && sh ${site}/test.sh && git add ${site} && git commit -q -m "m5 live: ${label} cart page" && $FLOWRYN_BIN stage done && sleep 5`,
    `bash ${ack} && docker run -d --label flowryn.run=$FLOWRYN_RUN --label com.docker.compose.project=flowryn-$FLOWRYN_RUN --name ${container} -p 127.0.0.1::80 nginx:alpine && docker cp ${site}/. ${container}:/usr/share/nginx/html/ && sleep 2 && port=$(docker port ${container} 80/tcp | head -1 | sed 's/.*://') && mkdir -p "$FLOWRYN_REPORT_DIR/qa" && curl -s "http://127.0.0.1:$port/" > "$FLOWRYN_REPORT_DIR/qa/page.html" && grep -q 'id="cart"' "$FLOWRYN_REPORT_DIR/qa/page.html" && (${axi} open "http://127.0.0.1:$port/" > "$FLOWRYN_REPORT_DIR/qa/walk.txt" 2>&1 && ${axi} screenshot "$FLOWRYN_REPORT_DIR/qa/cart.png" >> "$FLOWRYN_REPORT_DIR/qa/walk.txt" 2>&1; ${axi} stop > /dev/null 2>&1; true) && sleep 12`,
    `bash docker rm -f ${container} && printf '<html><body><h1>QA evidence: ${label}</h1><p>GET / served the cart page (id cart present).</p><img src="cart.png" alt="the cart page"></body></html>\\n' > "$FLOWRYN_REPORT_DIR/qa/evidence.html" && $FLOWRYN_BIN stage done --review "file://$FLOWRYN_REPORT_DIR/qa/evidence.html"`,
    "say the QA evidence is ready for review",
    `bash ${ack} && $FLOWRYN_BIN deliver --local`,
    "say DONE",
  ];
  return `FLOWRYN-SCRIPT: ${steps.join(" ;; ")}`;
}

/** The phase plan the design hands in: phase 2, on Pi (scripted) or on a real Claude worker. */
function planText(label: string, phase2: "pi" | "claude"): string {
  const site = `m5-live/${label}`;
  const body =
    phase2 === "pi"
      ? `Add the checkout page next to the cart page.\nFLOWRYN-SCRIPT: bash mkdir -p ${site} && printf '<html><body><h1 id="checkout">Checkout</h1></body></html>\\n' > ${site}/checkout.html && git add ${site}/checkout.html && git commit -q -m "m5 live: ${label} checkout" && $FLOWRYN_BIN deliver --local ;; say DONE`
      : `In your worktree, create the file ${site}/NOTES.md containing exactly one line: phase two. Commit it with git (git add ${site}/NOTES.md, then git commit -m "m5 live: ${label} notes"). Do not push and do not change any other file. Then finish the way your Flowryn contract and task file say.`;
  return `# ${label} checkout\n\n## Phase 2: ${label} ${phase2 === "pi" ? "checkout page" : "notes"}\nworkflow: fix\nharness: ${phase2}\n${body}\n`;
}

// --- flows ------------------------------------------------------------------------------------------------
async function flow(name: string, body: () => Promise<void>): Promise<void> {
  if (!flows.includes(name)) return;
  const started = Date.now();
  try {
    await body();
  } catch (error) {
    record(name, "flow", false, (error as Error).message, started);
  }
}

const dispatched: string[] = [];

function one<T>(sql: string, ...params: string[]): T | null {
  return withDb((db) => (db.query(sql).get(...params) as T | null) ?? null);
}

function leases(runId: string): string {
  return withDb((db) => (db.query("SELECT pool FROM pool_leases WHERE run_id = ?1 AND released_at IS NULL ORDER BY pool").all(runId) as { pool: string }[]).map((l) => l.pool).join(" "));
}

/** You, in a lab pane: `flowryn approve <task> --gate <stage>`, with the code read off the pane and typed back. */
async function approveGateInPane(task: string, stage: string): Promise<string> {
  const pane = await paneAt(home, `m5-approve-${task}`);
  await runInPane(pane, `approve-${task}`, [`exec ${BUN} ${MAIN} approve ${task} --gate ${stage}`]);
  const code = await waitFor("the approve code", 60_000, async () => /Type ([A-Z]{4}) to approve/.exec(await screen(pane))?.[1]);
  const shown = await screen(pane);
  await typeText(pane, code);
  await keys(pane, "Enter");
  await waitFor("the gate pass", 30_000, async () => /passed: true|approval: a\d+/.test(await screen(pane)));
  return shown;
}

/** You, on the board in a lab pane: a, the review's number, the code, then back and quit. */
async function approveGateOnBoard(task: string, stage: string): Promise<string> {
  const pane = await paneAt(home, "m5-board");
  await runInPane(pane, "board", [`exec ${BUN} ${MAIN} board`]);
  await waitFor("the board", 30_000, async () => (await screen(pane)).includes("a approve a merge or review"));
  await typeText(pane, "a");
  const number = await waitFor("the approve list", 20_000, async () => new RegExp(`(\\d+)\\. ${task}`).exec(await screen(pane))?.[1]).catch(async (error) => {
    throw new Error(`${(error as Error).message}; the board showed:\n${await screen(pane)}`, { cause: error });
  });
  const listed = await screen(pane);
  if (!listed.includes(`(${stage} review)`)) log(`the board's list did not show "(${stage} review)":\n${listed}`);
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

let turn: Promise<unknown> = Promise.resolve();

/** One leader and one of you: the gate passes and merges of features running side by side take turns. */
function inTurn<T>(fn: () => Promise<T>): Promise<T> {
  const next = turn.then(fn, fn);
  turn = next.catch(() => undefined);
  return next;
}

/** Runs with a live harness process: a recorded pid that still answers signal 0. */
function liveWorkers(): number {
  const rows = withDb((db) => db.query("SELECT proc_pid FROM runs WHERE proc_pid IS NOT NULL AND state NOT IN ('cleaned','failed','cancelled')").all() as { proc_pid: number }[]);
  return rows.filter(({ proc_pid }) => {
    try {
      process.kill(proc_pid, 0);
      return true;
    } catch {
      return false;
    }
  }).length;
}

/** Samples the live workers every second until stopped; the peak is the concurrency the flow reached. */
function concurrencySampler(): { stop(): Promise<{ peak: number; samples: number }> } {
  const state = { running: true, peak: 0, samples: 0 };
  const loop = (async () => {
    while (state.running) {
      state.peak = Math.max(state.peak, liveWorkers());
      state.samples++;
      await Bun.sleep(1_000);
    }
  })();
  return {
    async stop() {
      state.running = false;
      await loop;
      return { peak: state.peak, samples: state.samples };
    },
  };
}

interface Feature {
  name: string;
  project: string;
  checkout: string;
  mainBranch: string;
}

/**
 * A flow's features side by side under its one leader, with the live workers
 * sampled throughout. Each feature's failure is recorded on its own; the
 * concurrency check fails when the peak is under 2 or over 4.
 */
async function sideBySide(flowName: string, features: Feature[], leader: LiveLeader, phase2: "pi" | "claude", gateQa: (task: string) => Promise<string>, expected: { design: string; qa: string }): Promise<void> {
  const started = Date.now();
  const sampler = concurrencySampler();
  const outcomes = await Promise.allSettled(features.map((f) => twoPhaseFeature(f.name, f.project, f.checkout, f.mainBranch, leader, phase2, gateQa, expected)));
  const { peak, samples } = await sampler.stop();
  record(flowName, `${MIN_LIVE} to ${MAX_LIVE} live workers at once`, peak >= MIN_LIVE && peak <= MAX_LIVE, `peak ${peak} live worker processes over ${samples} one-second samples`, started);
  outcomes.forEach((o, i) => {
    if (o.status === "rejected") record(features[i]!.name, "flow", false, (o.reason as Error).message, started);
  });
}

/**
 * One two-phase feature, end to end. `gateDesign` and `gateQa` are the human
 * channels this flow proves; `merge` is the leader's. The leader and human
 * steps take turns with a feature running beside it.
 */
async function twoPhaseFeature(
  name: string,
  project: string,
  checkout: string,
  mainBranch: string,
  leader: LiveLeader,
  phase2: "pi" | "claude",
  gateQa: (task: string) => Promise<string>,
  expected: { design: string; qa: string },
): Promise<void> {
  const started = Date.now();
  const label = `${name}-${runPrefix.slice(-9, -1)}`;
  const planFile = join(home, "plans", `${label}.md`);
  mkdirSync(join(home, "plans"), { recursive: true });
  writeFileSync(planFile, planText(label, phase2));
  const reply = await call("dispatch", { project, kind: "ship", harness: "pi", workflow: "feature", title: `m5 live ${label} cart`, body: `Build the ${label} cart page, in stages.\n${phaseOneScript(label, planFile)}` });
  if (!reply.ok) throw new Error(`dispatch: ${JSON.stringify(reply.error)}`);
  const { task, run } = reply.data as { task: string; run: string };
  dispatched.push(task);
  log(`${name}: phase 1 is ${task} (${run})`);

  // Design: the page and the plan, a review gate, and nothing of phase 2 in the backlog yet.
  await waitRun(run, "the design review", 240_000, (r) => r.stage === "design" && r.stage_state === "review" && r.liveness === "idle");
  const plan = one<{ id: string; state: string }>("SELECT id, state FROM plans WHERE source_task = ?1", task);
  record(name, "the design stage handed in its page and plan; the gate is open", plan?.state === "pending" && one("SELECT 1 FROM items WHERE kind = 'gate_ready' AND run_id = ?1", run) !== null, `plan ${plan?.id} ${plan?.state}`, started);
  const designShown = await inTurn(() => leader.passGate(task, "design"));
  writeFileSync(join(home, `screen-design-${task}.txt`), designShown);
  await waitRun(run, "the build stage", 120_000, (r) => r.stage !== "design");
  const phase = one<{ task_id: string }>("SELECT task_id FROM plan_phases WHERE plan_id = ?1", plan!.id)!;
  const planNow = one<{ state: string; approved_via: string }>("SELECT state, approved_via FROM plans WHERE id = ?1", plan!.id)!;
  record(name, "passing the design approved the plan", planNow.state === "approved", `plan ${plan!.id} ${planNow.state} via ${planNow.approved_via}; phase 2 is ${phase.task_id}`, started);

  // Visual QA holds a Docker environment and a browser; the reconciler sees the labelled container.
  const inQa = await waitRun(run, "the QA stage", 240_000, (r) => r.stage === "qa" && r.stage_state === "active");
  const held = leases(inQa.id);
  const docker = await waitFor("the Docker evidence", 60_000, () => one<{ value: string }>("SELECT value FROM run_evidence WHERE run_id = ?1 AND source = 'docker'", run)).catch(() => null);
  record(name, "visual QA held docker_env and browser; the labelled container was counted", held.includes("docker_env") && held.includes("browser") && docker !== null, `leases: ${held}; docker: ${docker?.value ?? "none"}`, started);
  await waitRun(run, "the QA review", 240_000, (r) => r.stage === "qa" && r.stage_state === "review" && r.liveness === "idle");
  const shot = existsSync(join(home, "data", task, "qa", "cart.png"));
  record(name, "the QA evidence page is in the report directory", existsSync(join(home, "data", task, "qa", "evidence.html")), `evidence.html${shot ? " with a chrome-devtools-axi screenshot" : " (no screenshot)"}`, started);
  const qaShown = await inTurn(() => gateQa(task));
  writeFileSync(join(home, `screen-qa-${task}.txt`), qaShown);

  // Ship, and the merge: phase 2 waits until phase 1 has landed.
  await waitRun(run, "phase 1 delivered", 240_000, (r) => r.state === "ready");
  await Bun.sleep(6_000);
  record(name, "phase 2 did not start on unmerged work", one("SELECT 1 FROM runs WHERE task_id = ?1", phase.task_id) === null, `${phase.task_id} has no run while ${task} is ready`, started);
  const merged = await inTurn(() => leader.merge(task));
  writeFileSync(join(home, `screen-merge-${task}.txt`), merged);
  await waitRun(run, "phase 1 merged and cleaned", 240_000, (r) => r.state === "cleaned");
  const gates = withDb((db) => db.query("SELECT g.kind, g.stage, g.state, a.channel FROM gates g LEFT JOIN approvals a ON a.id = g.approval_id WHERE g.run_id = ?1 ORDER BY g.opened_at").all(run) as { kind: string; stage: string; state: string; channel: string | null }[]);
  const gateLine = gates.map((g) => `${g.kind}/${g.stage} ${g.state} (${g.channel ?? "-"})`).join(", ");
  record(name, "phase 1: design, review, build, visual QA, review, ship, merge", gates.length === 3 && gates[0]!.channel === expected.design && gates[1]!.channel === expected.qa && gates.every((g) => g.state === "passed"), gateLine, started);

  // Phase 2 starts by itself.
  const run2 = await waitFor("phase 2 to start by itself", 120_000, () => one<{ id: string }>("SELECT id FROM runs WHERE task_id = ?1", phase.task_id));
  const startedLine = one<{ line: string }>("SELECT line FROM items WHERE kind = 'phase_started' AND task_id = ?1", phase.task_id);
  record(name, "phase 2 started by itself once phase 1 landed", startedLine !== null && one("SELECT 1 FROM events WHERE kind = 'phase.started' AND task_id = ?1", phase.task_id) !== null, startedLine?.line ?? "no phase_started item", started);
  await waitRun(run2.id, "phase 2 delivered", phase2 === "claude" ? 600_000 : 240_000, (r) => r.state === "ready");
  await inTurn(() => leader.merge(phase.task_id));
  await waitRun(run2.id, "phase 2 merged and cleaned", 240_000, (r) => r.state === "cleaned");
  const files = phase2 === "pi" ? ["index.html", "checkout.html"] : ["index.html", "NOTES.md"];
  const onMain = files.every((f) => git(["cat-file", "-e", `${mainBranch}:m5-live/${label}/${f}`], checkout).code === 0);
  record(name, `both phases are on ${mainBranch}`, onMain, files.map((f) => `m5-live/${label}/${f}`).join(", "), started);
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
  log(`scratch home ${home}; lab ${values.session}; flows ${flows.join(",")}; claude ${CLAUDE_MODEL}; pi ${PI_MODEL}; host check needs ${MIN_FREE_GB} GB`);
  await startDaemon();
  // One project per feature: a local-only merge is a fast-forward, so two features never share a main.
  const shops: Feature[] = [];
  for (const id of ["a", "b"]) {
    const path = scratchRepo(`shop-${id}`);
    const added = await call("project add", { path, id: `shop-${id}`, mode: "local-only", harness: "pi", workflow: "feature" });
    if (!added.ok) throw new Error(`project add shop-${id}: ${JSON.stringify(added.error)}`);
    shops.push({ name: `pi-${id}`, project: `shop-${id}`, checkout: path, mainBranch: "main" });
  }
  const trusted: Feature[] = [];
  if (claudeProject && flows.includes("claude")) {
    for (const id of ["a", "b"]) {
      const path = trustedWorktree(`main-${id}`);
      const added = await call("project add", { path, id: `trusted-${id}`, mode: "local-only", "default-branch": `${runPrefix}main-${id}`, harness: "pi", workflow: "feature" });
      if (!added.ok) throw new Error(`project add trusted-${id}: ${JSON.stringify(added.error)}`);
      trusted.push({ name: `claude-${id}`, project: `trusted-${id}`, checkout: path, mainBranch: `${runPrefix}main-${id}` });
    }
  }

  // The contract gate: dispatch refuses a harness version with no passing contract run.
  if (values["seed-contracts"]) {
    const db = openDb(dbPath);
    const versions: [string, string][] = [["pi", Bun.spawnSync([PI_BIN, "--version"]).stdout.toString().trim()], ["claude", /(\d+\.\d+\.\d+)/.exec(Bun.spawnSync([which("claude"), "--version"]).stdout.toString())?.[1] ?? "?"]];
    tx(db, () => {
      for (const [h, v] of versions) db.query("INSERT OR IGNORE INTO harness_contracts (harness, version, passed_at, report_path) VALUES (?1, ?2, ?3, 'seeded by m5-live --seed-contracts')").run(h, v, Date.now());
    });
    db.close();
    log(`contracts seeded (not run): ${JSON.stringify(versions)}`);
  } else {
    for (const harness of ["pi", "claude"] as const) {
      if (harness === "claude" && !(claudeProject && flows.includes("claude"))) continue;
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

  await flow("pi", async () => {
    const cwd = join(home, "pi-cwd");
    mkdirSync(cwd, { recursive: true });
    const leader = new LiveLeader("pi", cwd);
    await leader.start();
    try {
      await sideBySide("pi", shops, leader, "pi", (task) => approveGateOnBoard(task, "qa"), { design: "pi-confirm", qa: "board" });
    } finally {
      await leader.quit();
    }
  });

  await flow("claude", async () => {
    if (!claudeProject || trusted.length === 0) {
      record("claude", "flow", false, "skipped: needs --claude-project <a checkout Claude trusts>", Date.now());
      return;
    }
    const leader = new LiveLeader("claude", trustedWorktree("leader"));
    await leader.start();
    try {
      await sideBySide("claude", trusted, leader, "claude", (task) => approveGateInPane(task, "qa"), { design: "claude-ask", qa: "cli-tty" });
    } finally {
      await leader.quit();
    }
  });
  const host = one<{ value: string }>("SELECT value FROM meta WHERE key = 'sched_host'");
  if (host) log(`host check as the scheduler last recorded it: ${host.value}`);
  return results.length > 0 && results.every((r) => r.ok) ? 0 : 1;
}

/** Remove every container labelled with a run of this home: the QA stage removes its own; this is the backstop. */
function removeOwnContainers(): void {
  const docker = which("docker");
  if (!docker) return;
  const runs = new Set(withDb((db) => (db.query("SELECT id FROM runs").all() as { id: string }[]).map((r) => r.id)));
  const listed = Bun.spawnSync([docker, "ps", "-a", "--filter", "label=flowryn.run", "--format", '{{.ID}}\t{{.Label "flowryn.run"}}']).stdout.toString();
  for (const line of listed.split("\n")) {
    const [id, run] = line.split("\t");
    if (id && run && runs.has(run)) {
      Bun.spawnSync([docker, "rm", "-f", id]);
      log(`removed container ${id} of ${run}`);
    }
  }
}

async function cleanup(): Promise<void> {
  for (const task of dispatched) await call("cancel", { target: task, reason: "live run finished" }).catch(() => undefined);
  for (const row of withDb((db) => db.query("SELECT task_id FROM runs WHERE state NOT IN ('cleaned','failed','cancelled')").all() as { task_id: string }[])) {
    await call("cancel", { target: row.task_id, reason: "live run finished" }).catch(() => undefined);
  }
  const known = withDb((db) => (db.query("SELECT workspace_id FROM runs WHERE workspace_id IS NOT NULL").all() as { workspace_id: string }[]).map((r) => r.workspace_id));
  for (const ws of [...workspaces.splice(0), ...known]) await runtime.closeWorkspace(ws).catch(() => undefined);
  removeOwnContainers();
  if (daemon) {
    daemon.kill("SIGTERM");
    await Promise.race([daemon.exited, Bun.sleep(15_000)]);
    if (daemon.exitCode === null) daemon.kill("SIGKILL");
  }
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
  const resultsPath = process.env.M5_RESULTS ?? join(home, "results.json");
  writeFileSync(resultsPath, JSON.stringify({ home, claudeProject, claudeModel: CLAUDE_MODEL, piModel: PI_MODEL, results }, null, 2));
  log(`results: ${results.filter((r) => r.ok).length}/${results.length} passed; ${resultsPath}`);
  if (!values.keep) rmSync(home, { recursive: true, force: true });
}
process.exit(code);
