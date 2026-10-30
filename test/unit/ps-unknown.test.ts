import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb, type Db } from "../../src/db/db.ts";
import { LavishPoller } from "../../src/lavish/poller.ts";
import { processCwd } from "../../src/lease/repin.ts";
import { reapUnder } from "../../src/policy/reap.ts";
import { TIMED_OUT, type BoundedResult } from "../../src/runtime/bounded.ts";
import { aliveOrUnknown, isAlive, parseLstart, psAnswer, psRunnerAt, PsUnavailable, readIdentity, readProcessTable, terminate, type PsRunner } from "../../src/runtime/proc.ts";

/**
 * ps answers liveness for every reader (the reconciler, terminate, the lease,
 * reaping, recovery). It runs bounded, and a ps that fails, hangs or prints
 * what does not parse makes the answer unknown: never "the process is gone",
 * and never a signal to a pid it could not vouch for.
 */

const dirs: string[] = [];
const dbs: Db[] = [];
const strays: number[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fw-ps-")));
  dirs.push(dir);
  return dir;
}

/** A stand-in ps: a shell script with this body. */
function fakePs(body: string): string {
  const path = join(tempDir(), "ps");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const unavailable = (): PsRunner => async () => {
  throw new PsUnavailable("/bin/ps exited 124: ps did not finish within 5000 ms");
};

const RECORDED = { pid: 4242, start: parseLstart("Wed Sep 23 22:48:39 2026")!, exe: "/bin/claude" };
const RECORDED_ROW = "  4242 Wed Sep 23 22:48:39 2026     /bin/claude\n";

function result(code: number, stdout = "", stderr = ""): BoundedResult {
  return { code, stdout, stderr, timedOut: code === TIMED_OUT, aborted: false, incomplete: null, lingering: false, spawnError: null, leftover: false };
}

async function finishedPid(): Promise<number> {
  const proc = Bun.spawn(["/usr/bin/true"]);
  await proc.exited;
  return proc.pid;
}

describe("what a ps exit means", () => {
  test("exit 1 having printed nothing is 'none of these pids' (macOS and procps)", () => {
    expect(psAnswer("/bin/ps", result(1))).toBe("");
    expect(psAnswer("/bin/ps", result(0, RECORDED_ROW))).toBe(RECORDED_ROW);
  });

  test.each([
    ["an error on stderr", result(1, "", "ps: Invalid process id: abc")],
    ["a timeout", result(TIMED_OUT, "", "ps did not finish within 5000 ms")],
    ["a spawn failure", result(127, "", "ENOENT")],
    ["a signal", result(137)],
  ])("%s is unavailable, not gone", (_what, read) => {
    expect(() => psAnswer("/bin/ps", read)).toThrow(PsUnavailable);
  });

  test("the real ps reads a finished pid as gone and this process as alive", async () => {
    expect(await readIdentity(await finishedPid())).toBeNull();
    const me = await readIdentity(process.pid);
    expect(me?.pid).toBe(process.pid);
  });
});

describe("a ps that cannot answer is unknown, never gone", () => {
  test("a ps that exits with an error throws PsUnavailable; aliveOrUnknown reads it as null", async () => {
    const ps = psRunnerAt(fakePs("echo 'ps: sysctl failed' >&2; exit 1"));
    await expect(readIdentity(process.pid, ps)).rejects.toBeInstanceOf(PsUnavailable);
    await expect(isAlive(RECORDED, ps)).rejects.toBeInstanceOf(PsUnavailable);
    expect(await aliveOrUnknown(RECORDED, ps)).toBeNull();
  });

  test("a hung ps is cut off at its deadline and reads as unknown", async () => {
    const started = Date.now();
    const ps = psRunnerAt(fakePs("exec sleep 30"), 300);
    await expect(readIdentity(process.pid, ps)).rejects.toThrow(/exited 124/);
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 10_000);

  test("a row that does not parse is unknown for every pid asked about", async () => {
    await expect(readIdentity(4242, async () => "  4242 garbled\n")).rejects.toBeInstanceOf(PsUnavailable);
  });

  test("a ps that cannot read the whole table throws PsUnavailable", async () => {
    await expect(readProcessTable(fakePs("echo boom >&2; exit 1"))).rejects.toBeInstanceOf(PsUnavailable);
    await expect(readProcessTable(fakePs("exec sleep 30"), 300)).rejects.toThrow(/exited 124/);
  }, 10_000);
});

describe("terminate signals only what ps vouches for", () => {
  test("ps failing before any signal: unknown, nothing sent", async () => {
    const sent: string[] = [];
    const ended = await terminate(RECORDED, { ps: unavailable(), kill: (pid, s) => sent.push(`${pid}:${s}`), graceMs: 10, pollMs: 2 });
    expect(ended).toEqual({ ok: false, evidence: "unknown", signal: "none" });
    expect(sent).toEqual([]);
  });

  test("ps failing after SIGTERM: no SIGKILL to a pid it cannot vouch for", async () => {
    const sent: string[] = [];
    let calls = 0;
    const ps: PsRunner = async () => {
      if (calls++ === 0) return RECORDED_ROW;
      throw new PsUnavailable("/bin/ps exited 124");
    };
    const ended = await terminate(RECORDED, { ps, kill: (pid, s) => sent.push(`${pid}:${s}`), graceMs: 20, pollMs: 2 });
    expect(ended).toEqual({ ok: false, evidence: "unknown", signal: "SIGTERM" });
    expect(sent).toEqual(["4242:SIGTERM"]);
  });

  test("ps failing after SIGKILL: unknown, not 'still alive'", async () => {
    const sent: string[] = [];
    const ps: PsRunner = async () => {
      if (sent.includes("4242:SIGKILL")) throw new PsUnavailable("/bin/ps exited 124");
      return RECORDED_ROW;
    };
    const ended = await terminate(RECORDED, { ps, kill: (pid, s) => sent.push(`${pid}:${s}`), graceMs: 10, pollMs: 1 });
    expect(ended).toEqual({ ok: false, evidence: "unknown", signal: "SIGKILL" });
  });

  test("a read that fails while waiting is waited through: gone afterwards is verified gone", async () => {
    const sent: string[] = [];
    let calls = 0;
    const ps: PsRunner = async () => {
      calls++;
      if (calls === 1) return RECORDED_ROW;
      if (calls === 2) throw new PsUnavailable("/bin/ps exited 124");
      return "";
    };
    const ended = await terminate(RECORDED, { ps, kill: (pid, s) => sent.push(`${pid}:${s}`), graceMs: 1_000, pollMs: 2 });
    expect(ended).toEqual({ ok: true, evidence: "process", signal: "SIGTERM" });
    expect(sent).toEqual(["4242:SIGTERM"]);
  });
});

describe("liveness readers built on ps", () => {
  test("reaping: ps failing leaves the leaked process unverified and unsignalled", async () => {
    const root = tempDir();
    const lsof = fakePs(`printf 'p4242\\nfcwd\\nn${root}/sub\\n'`);
    const sent: string[] = [];
    const reaped = await reapUnder([root], { lsof, ps: unavailable(), graceMs: 10, passes: 2, kill: (pid, s) => sent.push(`${pid}:${s}`), log: () => {} });
    expect(reaped).toMatchObject({ ok: false, reason: "identity_unverified" });
    expect(sent).toEqual([]);
  });

  test("the leader's cwd: ps failing reads as cannot be read (null)", async () => {
    expect(await processCwd(RECORDED, null, unavailable())).toBeNull();
  });

  test("the Lavish sweep: a leftover poll ps cannot check is not killed, and its record is kept beside the gate's for the next start", async () => {
    const dir = tempDir();
    const db = openDb(join(dir, "flowryn.db"));
    dbs.push(db);
    migrate(db);
    const pidDir = join(dir, "lavish-polls");
    mkdirSync(pidDir);
    const page = join(dir, "design.html");
    const orphan = Bun.spawn(["/bin/sh", "-c", "sleep 30; exit 0", "lavish-axi", "poll", page], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    strays.push(orphan.pid);
    writeFileSync(join(pidDir, "g1.json"), JSON.stringify({ pid: orphan.pid, page }));
    const logs: string[] = [];
    const poller = new LavishPoller({ db, lavish: () => null, log: (m) => logs.push(m), now: Date.now, pidDir, ps: fakePs("echo 'ps: sysctl failed' >&2; exit 1") });
    poller.pass();
    await poller.swept();
    poller.stop();
    expect(orphan.exitCode).toBeNull();
    expect(existsSync(join(pidDir, "g1.json"))).toBe(false);
    const kept = readdirSync(pidDir);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^g1\.\d+\.unchecked\.json$/);
    expect(logs.some((l) => l.includes("kept for the next start"))).toBe(true);
  }, 10_000);

  test("the Lavish sweep: the next start checks a kept record and removes it once its poll is gone", async () => {
    const dir = tempDir();
    const db = openDb(join(dir, "flowryn.db"));
    dbs.push(db);
    migrate(db);
    const pidDir = join(dir, "lavish-polls");
    mkdirSync(pidDir);
    writeFileSync(join(pidDir, "g1.123.unchecked.json"), JSON.stringify({ pid: await finishedPid(), page: join(dir, "design.html") }));
    const poller = new LavishPoller({ db, lavish: () => null, log: () => {}, now: Date.now, pidDir });
    poller.pass();
    await poller.swept();
    poller.stop();
    expect(readdirSync(pidDir)).toEqual([]);
  }, 10_000);
});
