import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "../../src/transport/unix.ts";
import { ulid } from "../../src/util/ulid.ts";
import { PROTO } from "../../src/version.ts";
import { exitCodeFor } from "../../src/api/errors.ts";
import { PING_VERB } from "../../src/daemon/system-verbs.ts";
import { requireNotificationsOff } from "../../src/config/leader.ts";
import { cli, cliJson, makeHome, pingSocket, REPO_ROOT, startDaemon, type DaemonProc, type TestHome } from "../helpers/harness.ts";

const homes: TestHome[] = [];
const daemons: DaemonProc[] = [];
function home(): TestHome {
  const h = makeHome();
  homes.push(h);
  return h;
}
async function daemon(h: TestHome, env: Record<string, string> = {}): Promise<DaemonProc> {
  const d = await startDaemon(h, env);
  daemons.push(d);
  return d;
}
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.kill9().catch(() => {});
  for (const h of homes.splice(0)) h.cleanup();
});

async function runDaemonOnce(h: TestHome, extraEnv: Record<string, string> = {}) {
  const env = { ...h.env, ...extraEnv };
  requireNotificationsOff(env, "runDaemonOnce");
  const proc = Bun.spawn(["bun", join(REPO_ROOT, "src/main.ts"), "daemon", "run"], { cwd: REPO_ROOT, env, stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code, stderr };
}

describe("flowrynd lifecycle", () => {
  test("answers the handshake; the run directory is 0700 and the socket 0600", async () => {
    const h = home();
    await daemon(h);
    const { code, reply } = await cliJson(h, ["daemon", "status"]);
    expect(code).toBe(0);
    expect(reply.data).toMatchObject({ daemon: "up", proto: PROTO, pending_intents: 0 });
    expect(statSync(join(h.home, "run")).mode & 0o777).toBe(0o700);
    expect(statSync(join(h.home, "run", "flowrynd.sock")).mode & 0o777).toBe(0o600);
    expect(statSync(h.stateDir).mode & 0o777).toBe(0o700);
  });

  test("a second daemon on the same state directory exits with a message (flock)", async () => {
    const h = home();
    await daemon(h);
    const second = await runDaemonOnce(h);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("another flowrynd holds");
    expect(await pingSocket(h)).toBe(true);
  });

  test("a daemon with another state directory cannot take a live socket (exclusive bind)", async () => {
    const h = home();
    await daemon(h);
    const other = join(h.home, "config-b.toml");
    writeFileSync(other, "");
    const second = await runDaemonOnce(h, { FLOWRYN_HOME: join(h.home, "b"), FLOWRYN_SOCK: join(h.home, "run", "flowrynd.sock") });
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("already answers");
    expect(await pingSocket(h)).toBe(true);
  });

  test("kill -9 leaves a stale socket; the next start replaces it", async () => {
    const h = home();
    const first = await daemon(h);
    await first.kill9();
    expect(existsSync(join(h.home, "run", "flowrynd.sock"))).toBe(true);
    expect(await pingSocket(h)).toBe(false);
    await daemon(h);
    expect(await pingSocket(h)).toBe(true);
  });

  test("SIGTERM stops cleanly: exit 0, socket removed, a stopped event", async () => {
    const h = home();
    const d = await daemon(h);
    expect(await d.stop()).toBe(0);
    expect(existsSync(join(h.home, "run", "flowrynd.sock"))).toBe(false);
    const db = h.db();
    const kinds = (db.query("SELECT kind FROM events ORDER BY seq").all() as { kind: string }[]).map((r) => r.kind);
    db.close();
    expect(kinds[0]).toBe("daemon.started");
    expect(kinds.at(-1)).toBe("daemon.stopped");
  });

  test("a corrupt database stops startup and names the restore command", async () => {
    const h = home();
    mkdirSync(h.stateDir, { recursive: true });
    writeFileSync(join(h.stateDir, "flowryn.db"), "this is not a sqlite file, not even close ".repeat(200));
    const result = await runDaemonOnce(h);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/doctor --restore|not a database/);
  });

  test("a protocol mismatch is refused with code protocol_mismatch (exit 76); the handshake still answers", async () => {
    const h = home();
    await daemon(h);
    const sock = join(h.home, "run", "flowrynd.sock");
    const reply = (await request(sock, { proto: PROTO + 1, ulid: ulid(), verb: "fleet", args: {} }, { connectMs: 300, replyMs: 2_000 })) as {
      ok: boolean;
      proto: number;
      error: { code: string };
    };
    expect(reply).toMatchObject({ ok: false, proto: PROTO, error: { code: "protocol_mismatch" } });
    expect(exitCodeFor(reply.error.code)).toBe(76);
    // A new CLI after a protocol bump must still recognize the daemon it talks to (flowryn daemon restart).
    const ping = (await request(sock, { proto: PROTO + 1, ulid: ulid(), verb: PING_VERB, args: {} }, { connectMs: 300, replyMs: 2_000 })) as { ok: boolean; data: { proto: number } };
    expect(ping).toMatchObject({ ok: true, data: { proto: PROTO } });
  });

  test("daemon status exits 69 when nothing answers", async () => {
    const h = home();
    const result = await cli(h, ["daemon", "status"]);
    expect(result.code).toBe(69);
    expect(result.stdout).toContain("daemon: down");
  });
});
