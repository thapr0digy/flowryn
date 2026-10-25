import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Reply } from "../../src/api/envelope.ts";
import { STYLE_BLOCK } from "../../src/harness/contract-text.ts";
import { writeLeaderFiles, type LeaderFiles } from "../../src/bridges/files.ts";
import { leaderEnv } from "../../src/cli/commands/lead.ts";
import type { BridgeDriver, BridgeEnv, LeaderHarness, PresentationView } from "../../src/contracts/bridge-suite.ts";
import { openItem } from "../../src/attention/items.ts";
import { tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { request } from "../../src/transport/unix.ts";
import { ulid } from "../../src/util/ulid.ts";
import { PROTO } from "../../src/version.ts";
import { FakeClaudeLeader } from "./fake-claude-leader.ts";
import { FakePiLeader } from "./fake-pi-leader.ts";
import { FakeHerdr } from "./fake-herdr.ts";
import { cliJson, makeHome, REPO_ROOT, seedRun, startDaemon, waitUntil, type DaemonProc, type SeededRun, type TestHome } from "./harness.ts";
import { loadConfig } from "../../src/config/config.ts";
import { configStaticLayers } from "../../src/policy/static.ts";

/** Leader clocks short enough for tests: an interrupt's busy lease, your inactivity, the P0 coalescing window. */
export const LEADER_TEST_CONFIG = [
  "[leader]",
  "busy_lease_ms = 3000",
  "inactive_ms = 400",
  // The CLI runs under bun from source here, whose start alone can take a second; the budget test sets its own.
  "digest_budget_ms = 30000",
  "[notify]",
  "macos = false",
  "p0_coalesce_s = 1",
  "min_interval_min = 1",
  "[reconcile]",
  "wait_poll_ms = 2000",
].join("\n");

export interface OpenedSession {
  session: string;
  token: string;
  env: Record<string, string>;
}

export interface LeaderEnv {
  h: TestHome;
  daemon: DaemonProc;
  herdr: FakeHerdr | null;
  files: LeaderFiles;
  worker: SeededRun;
  call(verb: string, args: Record<string, unknown>, token: string | null): Promise<Reply>;
  openSession(harness: LeaderHarness, pane?: string): Promise<OpenedSession>;
  claude(pane?: string): Promise<FakeClaudeLeader>;
  pi(): Promise<FakePiLeader>;
  openP0(text: string): Promise<string>;
  openP1(text: string): Promise<string>;
  /** A P1 that is not a question (a PR ready), so only a digest or a briefing carries it. */
  openPlainP1(text: string): string;
  withDb<T>(fn: (db: Db) => T): T;
  /** Kill the daemon and start a new one on the same home: its in-memory state (transcript offsets) is gone. */
  restartDaemon(): Promise<void>;
  bridgeEnv(harness: LeaderHarness, drivers: [BridgeDriver, BridgeDriver]): BridgeEnv;
  cleanup(): Promise<void>;
}

async function waitFor<T>(what: string, timeoutMs: number, check: () => T | null | undefined | false | Promise<T | null | undefined | false>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null && value !== undefined && value !== false) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await Bun.sleep(40);
  }
}

export interface LeaderEnvOptions {
  extraConfig?: string;
  /** Run a fake Herdr on the home's socket (notifications and agent status go there). */
  herdr?: boolean;
}

/** A daemon, the leader files `flowryn lead` writes, and a worker run to raise items with. */
export async function makeLeaderEnv(options: LeaderEnvOptions = {}): Promise<LeaderEnv> {
  const extra = options.extraConfig ?? "";
  const h = makeHome({
    extraConfig: (home) => `${LEADER_TEST_CONFIG}\n${extra}${options.herdr ? `\n[herdr]\nsocket = ${JSON.stringify(join(home, "herdr.sock"))}` : ""}`,
  });
  const herdr = options.herdr ? await FakeHerdr.start(join(h.home, "herdr.sock"), { env: h.env, logDir: h.home }) : null;
  // A worker run that has delivered: the reconciler leaves it alone, and it can still fail or ask.
  const worker = seedRun(h, "web-billing-q4", "r01LEADER");
  {
    const db = h.db();
    db.query("UPDATE runs SET state = 'ready', liveness = 'idle' WHERE id = ?1").run(worker.runId);
    db.close();
  }
  const daemon = await startDaemon(h);
  const files = await writeLeaderFiles({ home: h.home, socket: join(h.home, "run", "flowrynd.sock"), command: ["bun", join(REPO_ROOT, "src/main.ts")], style: STYLE_BLOCK, toolkit: configStaticLayers(loadConfig(h.home).config) });
  const fakes: { kill(): void }[] = [];
  const cwd = join(h.home, "leader-cwd");
  mkdirSync(cwd, { recursive: true });

  const call = async (verb: string, args: Record<string, unknown>, token: string | null): Promise<Reply> =>
    (await request(join(h.home, "run", "flowrynd.sock"), { proto: PROTO, ulid: ulid(), verb, token, channel: token ? null : "tty", args }, { connectMs: 1_000, replyMs: 30_000 })) as Reply;

  const withDb = <T>(fn: (db: Db) => T): T => {
    const db = h.db();
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };

  const openSession = async (harness: LeaderHarness, pane?: string): Promise<OpenedSession> => {
    const reply = await call("lead.open", { harness, pane: pane ?? `w9:p${Math.floor(Math.random() * 90) + 10}`, cwd }, null);
    if (!reply.ok) throw new Error(`lead.open: ${JSON.stringify(reply.error)}`);
    const { session, token } = reply.data as { session: string; token: string };
    return { session, token, env: leaderEnv({ ...h.env }, { token, session, files, inactiveMs: 400 }) };
  };

  const closeWith = (token: string) => async () => {
    await call("lead.close", { reason: "test quit" }, token);
  };

  const workerCall = async (args: string[], body: string): Promise<Record<string, unknown>> => {
    const result = await cliJson(h, args, { env: { FLOWRYN_TOKEN: worker.token, FLOWRYN_RUN: worker.runId }, stdin: body });
    if (result.code !== 0) throw new Error(`${args.join(" ")} failed: ${JSON.stringify(result.reply)}`);
    return (result.reply.data ?? {}) as Record<string, unknown>;
  };

  const env: LeaderEnv = {
    h,
    daemon,
    herdr,
    files,
    worker,
    call,
    openSession,
    withDb,
    async restartDaemon() {
      await env.daemon.kill9();
      env.daemon = await startDaemon(h);
    },
    async claude(pane) {
      const opened = await openSession("claude", pane);
      const fake = new FakeClaudeLeader({ settingsPath: files.claudeSettings, env: opened.env, dir: h.home, cwd, onQuit: closeWith(opened.token) });
      fakes.push(fake);
      return fake;
    },
    async pi() {
      const opened = await openSession("pi");
      const fake = new FakePiLeader({
        extensionPath: files.piExtension,
        env: opened.env,
        cwd,
        inactive: () => withDb((db) => (db.query("SELECT user_inactive_since FROM leader_sessions WHERE session_id = ?1").get(opened.session) as { user_inactive_since: number | null }).user_inactive_since !== null),
        onQuit: closeWith(opened.token),
      });
      fakes.push(fake);
      return fake;
    },
    async openP0(text) {
      const data = await workerCall(["fail", "--body-file", "-"], text);
      return String(data.item);
    },
    async openP1(text) {
      await workerCall(["ask", "--options", "yes,no", "--blocks", "the next step of the task", "--body-file", "-"], text);
      return withDb((db) => (db.query("SELECT id FROM items WHERE kind = 'worker_question' ORDER BY rowid DESC LIMIT 1").get() as { id: string }).id);
    },
    openPlainP1(text) {
      return withDb((db) =>
        tx(db, () => {
          const event = appendEvent(db, { source: "cli", kind: "test.item", payload: {} });
          return openItem(db, { kind: "pr_ready", eventSeq: event.seq, line: `PR ready: ${text}`, taskId: worker.taskId, runId: worker.runId });
        }),
      );
    },
    bridgeEnv(harness, drivers) {
      return {
        harness,
        driver: (i) => drivers[i],
        openP0: env.openP0,
        openP1: env.openP1,
        lease: () => withDb((db) => (db.query("SELECT session_id AS session, epoch FROM leader_lease WHERE scope = 'default'").get() as { session: string | null; epoch: number } | null) ?? { session: null, epoch: 0 }),
        presentations: (item) =>
          withDb((db) => db.query("SELECT session_id, turn_no, path, state FROM presentations WHERE item_id = ?1 ORDER BY carried_at").all(item) as PresentationView[]),
        leaderSession: (session) =>
          withDb((db) => {
            const row = db.query("SELECT busy, busy_until, user_inactive_since, ended_at FROM leader_sessions WHERE session_id = ?1").get(session) as {
              busy: number;
              busy_until: number | null;
              user_inactive_since: number | null;
              ended_at: number | null;
            } | null;
            if (!row) return { busy: false, inactive: false, ended: true };
            return { busy: row.busy === 1 && row.busy_until !== null && row.busy_until > Date.now(), inactive: row.user_inactive_since !== null, ended: row.ended_at !== null };
          }),
        notifiedItems: () => withDb((db) => (db.query("SELECT item_ids FROM notifications").all() as { item_ids: string }[]).flatMap((r) => JSON.parse(r.item_ids) as string[])),
        deliveredVia: (item) =>
          withDb((db) => {
            const rows = db.query("SELECT payload FROM events WHERE kind = 'leader.p0_delivered' ORDER BY seq DESC").all() as { payload: string }[];
            const hit = rows.map((r) => JSON.parse(r.payload) as { item: string; path: string }).find((p) => p.item === item);
            return hit?.path ?? null;
          }),
        async claimFor(session) {
          const reply = await call("leader claim", { session }, null);
          if (!reply.ok) throw new Error(`leader claim: ${JSON.stringify(reply.error)}`);
        },
        waitFor,
        sleep: (ms) => Bun.sleep(ms),
        timeouts: { turn: 15_000, inactive: 10_000, busyExpiry: 10_000, quiet: 1_500 },
        log: () => {},
      };
    },
    async cleanup() {
      for (const fake of fakes) fake.kill();
      await env.daemon.kill9().catch(() => {});
      await herdr?.stop().catch(() => {});
      if (process.env.FLOWRYN_TEST_KEEP === "1") process.stderr.write(`kept test home: ${h.home}\n`);
      else h.cleanup();
    },
  };
  return env;
}

export { waitFor, waitUntil };
