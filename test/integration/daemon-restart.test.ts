import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tx } from "../../src/db/db.ts";
import { cliJson, killNextDaemon, makeHome, REPO_ROOT, seedLeader, seedRun, startDaemon, superviseWithScript, waitUntil, type DaemonProc, type TestHome } from "../helpers/harness.ts";

/**
 * `flowryn daemon restart` end to end, with the script supervisor standing in
 * for launchd (FLOWRYN_SUPERVISOR): it stops the old daemon with SIGTERM, as
 * `launchctl kickstart -k` does, and starts the next one in the background.
 */

const MAIN = join(REPO_ROOT, "src/main.ts");
const homes: TestHome[] = [];
const daemons: DaemonProc[] = [];

afterEach(async () => {
  for (const d of daemons.splice(0)) await d.kill9().catch(() => {});
  for (const h of homes.splice(0)) {
    killNextDaemon(h);
    h.cleanup();
  }
});

/** A home whose daemon is supervised by a script; `program` is the launchd target the binary check runs. */
function supervisedHome(program: string[] = ["bun", MAIN, "daemon", "run"]): { h: TestHome; env: Record<string, string> } {
  const h = makeHome();
  homes.push(h);
  return { h, env: superviseWithScript(h, program) };
}

async function daemon(h: TestHome, env: Record<string, string>): Promise<DaemonProc> {
  const d = await startDaemon(h, env);
  daemons.push(d);
  return d;
}

function events(h: TestHome, kind: string): Record<string, unknown>[] {
  const db = h.db();
  try {
    return (db.query("SELECT payload FROM events WHERE kind = ?1 ORDER BY seq").all(kind) as { payload: string }[]).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
  } finally {
    db.close();
  }
}

/**
 * A validation lease held by a run in a pane. The pane matters: with Herdr
 * unreachable the reconciler reads the run as unknown and leaves its lease,
 * where a run with no pane and no process is dead and its lease released.
 */
/** A merge left requested of GitHub: the "merging" guard (a validation is carried across a restart, never a guard). */
function seedMerging(h: TestHome, taskId: string): void {
  const db = h.db();
  try {
    tx(db, () => {
      db.query("INSERT INTO approvals (id, task_id, pr_url, head_sha, channel, actor, created_at, expires_at) VALUES ('a-guard', ?1, 'u', 'h', 'cli-tty', 'you', 1, 2)").run(taskId);
      db.query("INSERT INTO merges (id, task_id, pr_url, head_sha, approval_id, requested_at, state) VALUES ('mg-guard', ?1, 'u', 'h', 'a-guard', ?2, 'requested')").run(taskId, Date.now());
    });
  } finally {
    db.close();
  }
}

describe("flowryn daemon restart", () => {
  test("the leader restarts the daemon: the old one exits cleanly, the new one answers and records who asked", async () => {
    const { h, env } = supervisedHome();
    const token = seedLeader(h);
    const old = await daemon(h, env);
    const { code, reply } = await cliJson(h, ["daemon", "restart"], { env: { ...env, FLOWRYN_TOKEN: token } });
    expect(code).toBe(0);
    const data = reply.data as Record<string, string>;
    expect(data.restarted).toBe("script");
    expect(data.old).toContain(`pid ${old.pid}`);
    expect(data.new).not.toContain(`pid ${old.pid}`);
    expect(await old.exited).toBe(0);
    const restarted = events(h, "daemon.restarted");
    expect(restarted).toHaveLength(1);
    expect(restarted[0]).toMatchObject({ by: "leader", session: "test-session", old: { pid: old.pid } });
    expect(events(h, "daemon.stopped").at(-1)).toMatchObject({ reason: "SIGTERM" });
    const status = await cliJson(h, ["daemon", "status"]);
    expect(status.reply.data).toMatchObject({ daemon: "up", restart_pending: null });
  }, 60_000);

  test("a worker is refused, both in its pane and by its token alone", async () => {
    const { h, env } = supervisedHome();
    const run = seedRun(h);
    const d = await daemon(h, env);
    const inPane = await cliJson(h, ["daemon", "restart"], { env: { ...env, FLOWRYN_TOKEN: run.token, FLOWRYN_RUN: run.runId } });
    expect(inPane.code).toBe(77);
    expect((inPane.reply.error as { code: string }).code).toBe("worker_token");
    const byToken = await cliJson(h, ["daemon", "restart"], { env: { ...env, FLOWRYN_TOKEN: run.token } });
    expect(byToken.code).toBe(77);
    expect((byToken.reply.error as { code: string }).code).toBe("worker_token");
    expect(events(h, "daemon.restart_requested")).toHaveLength(0);
    expect(d.pid).toBeGreaterThan(0);
  }, 60_000);

  test("a merge in flight blocks it; --when-idle parks it and the daemon restarts once it ends", async () => {
    const { h, env } = supervisedHome();
    const token = seedLeader(h);
    const run = seedRun(h);
    seedMerging(h, run.taskId);
    const old = await daemon(h, env);
    const asLeader = { env: { ...env, FLOWRYN_TOKEN: token } };

    const blocked = await cliJson(h, ["daemon", "restart"], asLeader);
    expect(blocked.code).toBe(2);
    expect(blocked.reply.error).toMatchObject({ code: "restart_blocked" });
    expect((blocked.reply.error as { message: string }).message).toContain(`merging: ${run.taskId}`);

    const parked = await cliJson(h, ["daemon", "restart", "--when-idle"], asLeader);
    expect(parked.code).toBe(0);
    expect(parked.reply.data).toMatchObject({ restart: "pending" });
    const status = await cliJson(h, ["daemon", "status"]);
    expect(status.reply.data).toMatchObject({ restart_pending: { by: "leader" } });

    const db = h.db();
    tx(db, () => db.query("UPDATE merges SET state = 'refused', checked_at = ?1 WHERE id = 'mg-guard'").run(Date.now()));
    db.close();
    expect(await old.exited).toBe(0);
    await waitUntil(() => events(h, "daemon.restarted").length === 1, 20_000, "the new daemon to record the restart");
    expect(events(h, "daemon.restarted")[0]).toMatchObject({ by: "leader", old: { pid: old.pid } });
  }, 60_000);

  test("--cancel drops a parked restart", async () => {
    const { h, env } = supervisedHome();
    const token = seedLeader(h);
    const run = seedRun(h);
    seedMerging(h, run.taskId);
    await daemon(h, env);
    const asLeader = { env: { ...env, FLOWRYN_TOKEN: token } };
    expect((await cliJson(h, ["daemon", "restart", "--when-idle"], asLeader)).reply.data).toMatchObject({ restart: "pending" });
    expect((await cliJson(h, ["daemon", "restart", "--cancel"], asLeader)).reply.data).toMatchObject({ restart: "cancelled", had_pending: true });
    expect((await cliJson(h, ["daemon", "status"])).reply.data).toMatchObject({ restart_pending: null });
  }, 60_000);

  test("a broken build never replaces the running daemon", async () => {
    const { h } = supervisedHome();
    const broken = join(h.home, "broken-flowryn");
    writeFileSync(broken, "#!/bin/sh\necho 'dyld: missing symbol' >&2\nexit 134\n");
    chmodSync(broken, 0o755);
    const file = join(h.home, "supervisor.json");
    writeFileSync(file, JSON.stringify({ program: [broken, "daemon", "run"], restart: [join(h.home, "supervisor.sh")] }));
    const env = { FLOWRYN_SUPERVISOR: file };
    const token = seedLeader(h);
    const d = await daemon(h, env);
    const { code, reply } = await cliJson(h, ["daemon", "restart"], { env: { ...env, FLOWRYN_TOKEN: token } });
    expect(code).toBe(2);
    expect(reply.error).toMatchObject({ code: "binary_broken" });
    expect((reply.error as { message: string }).message).toContain("version exited 134");
    expect((await cliJson(h, ["daemon", "status"])).reply.data).toMatchObject({ daemon: "up", pid: d.pid });
  }, 60_000);

  test("a supervisor that refuses: the CLI reports restart_dropped at once, the old daemon stays, a P1 says why", async () => {
    const { h, env } = supervisedHome();
    const refusing = join(h.home, "refusing.sh");
    writeFileSync(refusing, "#!/bin/sh\necho 'Could not find service in domain' >&2\nexit 113\n");
    chmodSync(refusing, 0o755);
    writeFileSync(env.FLOWRYN_SUPERVISOR!, JSON.stringify({ program: ["bun", MAIN, "daemon", "run"], restart: [refusing] }));
    const token = seedLeader(h);
    const d = await daemon(h, env);
    const started = Date.now();
    const { code, reply } = await cliJson(h, ["daemon", "restart"], { env: { ...env, FLOWRYN_TOKEN: token } });
    expect(code).toBe(2);
    expect(reply.error).toMatchObject({ code: "restart_dropped" });
    expect((reply.error as { message: string }).message).toContain("Could not find service in domain");
    expect(Date.now() - started).toBeLessThan(15_000);
    expect((await cliJson(h, ["daemon", "status"])).reply.data).toMatchObject({ daemon: "up", pid: d.pid, restart_handoff: false });
    const db = h.db();
    try {
      expect(db.query("SELECT COUNT(*) AS n FROM items WHERE kind = 'restart_dropped' AND state = 'open'").get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  }, 60_000);

  test("a daemon not under launchd (started in the background) is refused as not_supervised", async () => {
    const h = makeHome();
    homes.push(h);
    const token = seedLeader(h);
    await daemon(h, {});
    const { code, reply } = await cliJson(h, ["daemon", "restart"], { env: { FLOWRYN_TOKEN: token } });
    expect(code).toBe(2);
    expect(reply.error).toMatchObject({ code: "not_supervised" });
  }, 60_000);
});
