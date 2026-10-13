import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INCOMPLETE, TIMED_OUT, configureOwnedProcesses, recoverOwnedProcesses, runBounded, stopOwnedProcesses } from "../../src/runtime/bounded.ts";

/**
 * The daemon's bounded external commands (src/runtime/bounded.ts) against real
 * processes: a silent child and the descendants holding its pipes are stopped
 * within the call's budget, the ownership ledger names a running child, and
 * startup recovery ends exactly what a ledger entry proves its own.
 */

const dirs: string[] = [];
const strays: number[] = [];
const lines: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fw-bnd-"));
  dirs.push(dir);
  return dir;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number, ms = 2_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() > deadline) return false;
    await Bun.sleep(20);
  }
  return true;
}

async function pidFrom(path: string): Promise<number> {
  for (let i = 0; i < 200; i++) {
    if (existsSync(path)) {
      const n = Number(readFileSync(path, "utf8").trim());
      if (n > 0) {
        strays.push(n);
        return n;
      }
    }
    await Bun.sleep(10);
  }
  throw new Error(`no pid in ${path}`);
}

/** A process in a group of its own that has nothing to do with the call under test. */
function unrelated(): number {
  const proc = Bun.spawn(["/bin/sleep", "60"], { detached: true, stdout: "ignore", stderr: "ignore" });
  strays.push(proc.pid);
  return proc.pid;
}

function own(): string {
  const dir = join(tempDir(), "owned");
  configureOwnedProcesses({ dir, log: (line) => lines.push(line) });
  return dir;
}

afterEach(() => {
  configureOwnedProcesses(null);
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  lines.length = 0;
});

describe("runBounded in the daemon (own process group, ledger)", () => {
  test("a silent child whose descendant holds its pipes is stopped within timeout + grace + drain, both gone", async () => {
    own();
    const dir = tempDir();
    const other = unrelated();
    const began = Date.now();
    const result = await runBounded(["/bin/sh", "-c", `sleep 60 & echo $! > ${dir}/child; wait`], { label: "silent", timeoutMs: 300, graceMs: 300, drainMs: 200 });
    const elapsed = Date.now() - began;
    expect(result.code).toBe(TIMED_OUT);
    expect(result.timedOut).toBe(true);
    expect(result.stderr).toContain("silent did not finish within 300 ms");
    expect(elapsed).toBeLessThan(300 + 300 + 200 + 1_000 + 500);
    expect(await gone(await pidFrom(join(dir, "child")))).toBe(true);
    expect(alive(other)).toBe(true);
  });

  test("a child that ignores SIGTERM is SIGKILLed only after the grace", async () => {
    own();
    const dir = tempDir();
    const began = Date.now();
    const result = await runBounded(["/bin/sh", "-c", `trap '' TERM; sleep 60 & echo $! > ${dir}/child; wait`], { label: "stubborn", timeoutMs: 200, graceMs: 600, drainMs: 200 });
    const elapsed = Date.now() - began;
    expect(result.code).toBe(TIMED_OUT);
    expect(elapsed).toBeGreaterThanOrEqual(200 + 600 - 50);
    expect(await gone(await pidFrom(join(dir, "child")))).toBe(true);
  });

  test("a leader that exits 0 while a descendant holds stdout is incomplete (125) within the drain, and the descendant is left alone", async () => {
    own();
    const dir = tempDir();
    const began = Date.now();
    const result = await runBounded(["/bin/sh", "-c", `sleep 30 & echo $! > ${dir}/child; echo partial`], { label: "leaky", timeoutMs: 10_000, drainMs: 200 });
    expect(Date.now() - began).toBeLessThan(2_000);
    expect(result.code).toBe(INCOMPLETE);
    expect(result.timedOut).toBe(false);
    expect(result.incomplete).toContain("still open");
    expect(result.stdout).toContain("partial");
    expect(alive(await pidFrom(join(dir, "child")))).toBe(true);
  });

  test("output over the cap is incomplete, never a clean read", async () => {
    own();
    const result = await runBounded(["/bin/sh", "-c", "head -c 5000 /dev/zero"], { label: "loud", timeoutMs: 5_000, maxOutputBytes: 1_000 });
    expect(result.code).toBe(INCOMPLETE);
    expect(result.stdout.length).toBe(1_000);
    expect(result.incomplete).toContain("over 1000 bytes");
  });

  test("a clean call keeps its code and output, and the ledger holds the child only while it runs", async () => {
    const ledger = own();
    const pending = runBounded(["/bin/sh", "-c", "sleep 0.3; echo out; echo err >&2; exit 3"], { label: "clean", timeoutMs: 5_000 });
    await Bun.sleep(100);
    const entries = readdirSync(ledger).filter((n) => n.endsWith(".json"));
    expect(entries).toHaveLength(1);
    const entry = JSON.parse(readFileSync(join(ledger, entries[0]!), "utf8")) as { pid: number; label: string; spawned_at: number };
    expect(entry.label).toBe("clean");
    const result = await pending;
    expect(result).toMatchObject({ code: 3, stdout: "out\n", stderr: "err\n", timedOut: false, incomplete: null });
    expect(readdirSync(ledger)).toEqual([]);
  });

  test("a missing binary is a spawn failure (127), never a throw", async () => {
    own();
    const result = await runBounded(["/nonexistent/tool"], { label: "absent", timeoutMs: 1_000 });
    expect(result.code).toBe(127);
    expect(result.spawnError).not.toBeNull();
  });

  test("the daemon's stop ends every running group and drops its entries", async () => {
    const ledger = own();
    const dir = tempDir();
    const other = unrelated();
    const pending = runBounded(["/bin/sh", "-c", `sleep 60 & echo $! > ${dir}/child; wait`], { label: "running", timeoutMs: 60_000 });
    const child = await pidFrom(join(dir, "child"));
    const stopped = await stopOwnedProcesses(500);
    expect(stopped.left).toEqual([]);
    expect(stopped.ended).toHaveLength(1);
    const result = await pending;
    expect(result.code).not.toBe(0);
    expect(await gone(child)).toBe(true);
    expect(readdirSync(ledger)).toEqual([]);
    expect(alive(other)).toBe(true);
  });
});

describe("runBounded outside the daemon (the CLI's group)", () => {
  test("a silent child still returns within its budget, with no ledger", async () => {
    const dir = tempDir();
    const began = Date.now();
    const result = await runBounded(["/bin/sh", "-c", `sleep 60 & echo $! > ${dir}/child; wait`], { label: "cli", timeoutMs: 200, graceMs: 200, drainMs: 200 });
    await pidFrom(join(dir, "child"));
    expect(result.code).toBe(TIMED_OUT);
    expect(Date.now() - began).toBeLessThan(200 + 200 + 200 + 1_000);
  });
});

describe("recoverOwnedProcesses (the next daemon's start)", () => {
  function entry(dir: string, pid: number, spawnedAt: number, label = "left"): string {
    const path = join(dir, `${pid}.json`);
    writeFileSync(path, JSON.stringify({ pid, spawned_at: spawnedAt, argv0: "sh", label }));
    return path;
  }

  test("a recorded live group is ended, the entry removed, and an unrelated process left alone", async () => {
    const ledger = tempDir();
    const dir = tempDir();
    const other = unrelated();
    const spawnedAt = Date.now();
    const leader = Bun.spawn(["/bin/sh", "-c", `sleep 60 & echo $! > ${dir}/child; wait`], { detached: true, stdout: "ignore", stderr: "ignore" });
    strays.push(leader.pid);
    const child = await pidFrom(join(dir, "child"));
    const path = entry(ledger, leader.pid, spawnedAt, "docker ps");
    const found = await recoverOwnedProcesses(ledger, { graceMs: 500 });
    expect(found.ended).toEqual([{ pid: leader.pid, label: "docker ps" }]);
    expect(found.failed).toEqual([]);
    expect(await gone(child)).toBe(true);
    expect(await gone(leader.pid)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(alive(other)).toBe(true);
  });

  test("an entry whose pid is gone is dropped and nothing is signalled", async () => {
    const ledger = tempDir();
    const proc = Bun.spawn(["/usr/bin/true"]);
    await proc.exited;
    const path = entry(ledger, proc.pid, Date.now());
    const found = await recoverOwnedProcesses(ledger);
    expect(found.gone).toEqual([{ pid: proc.pid, label: "left" }]);
    expect(existsSync(path)).toBe(false);
  });

  test("a live group leader that started outside the entry's window is another process: dropped, left running", async () => {
    const ledger = tempDir();
    const other = unrelated();
    entry(ledger, other, Date.now() - 3_600_000);
    const found = await recoverOwnedProcesses(ledger);
    expect(found.gone.map((g) => g.pid)).toEqual([other]);
    expect(found.ended).toEqual([]);
    await Bun.sleep(100);
    expect(alive(other)).toBe(true);
  });

  test("a live process at the pid that does not lead its own group is not ours: dropped, left running", async () => {
    const ledger = tempDir();
    const spawnedAt = Date.now();
    const notLeader = Bun.spawn(["/bin/sleep", "60"], { stdout: "ignore", stderr: "ignore" });
    strays.push(notLeader.pid);
    entry(ledger, notLeader.pid, spawnedAt);
    const found = await recoverOwnedProcesses(ledger);
    expect(found.gone.map((g) => g.pid)).toEqual([notLeader.pid]);
    expect(alive(notLeader.pid)).toBe(true);
  });

  test("an unreadable entry is kept and reported, never read as nothing", async () => {
    const ledger = tempDir();
    const path = join(ledger, "123.json");
    writeFileSync(path, "{");
    const found = await recoverOwnedProcesses(ledger);
    expect(found.unreadable).toEqual([path]);
    expect(existsSync(path)).toBe(true);
  });

  test("a missing ledger directory is nothing to recover", async () => {
    const found = await recoverOwnedProcesses(join(tempDir(), "absent"));
    expect(found).toEqual({ ended: [], gone: [], failed: [], unreadable: [] });
  });
});
