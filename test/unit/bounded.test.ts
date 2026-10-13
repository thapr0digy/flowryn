import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INCOMPLETE, TIMED_OUT, configureOwnedProcesses, parseEtime, recoverOwnedProcesses, runBounded, stopOwnedProcesses } from "../../src/runtime/bounded.ts";
import { psRunner, type PsRunner } from "../../src/runtime/proc.ts";

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

  test("a leader that exits 0 while a descendant holds stdout (a daemon it started) succeeds with what it wrote, within the drain, and the descendant is left alone", async () => {
    own();
    const dir = tempDir();
    const began = Date.now();
    const result = await runBounded(["/bin/sh", "-c", `sleep 30 & echo $! > ${dir}/child; echo answer`], { label: "starter", timeoutMs: 10_000, drainMs: 200 });
    expect(Date.now() - began).toBeLessThan(2_000);
    expect(result).toMatchObject({ code: 0, stdout: "answer\n", stderr: "", timedOut: false, incomplete: null, lingering: true });
    expect(lines.join("\n")).toContain("starter");
    expect(alive(await pidFrom(join(dir, "child")))).toBe(true);
  });

  test("a leader that exits non-zero while a descendant holds stdout keeps its own code", async () => {
    own();
    const dir = tempDir();
    const result = await runBounded(["/bin/sh", "-c", `sleep 30 & echo $! > ${dir}/child; echo why >&2; exit 3`], { label: "failing", timeoutMs: 10_000, drainMs: 200 });
    expect(result).toMatchObject({ code: 3, stderr: "why\n", timedOut: false, lingering: true });
    expect(alive(await pidFrom(join(dir, "child")))).toBe(true);
  });

  test("a leader that does not finish while a descendant holds stdout is 124, not a success", async () => {
    const dir = tempDir();
    const result = await runBounded(["/bin/sh", "-c", `sleep 30 & echo $! > ${dir}/child; echo partial; sleep 30`], { label: "unfinished", timeoutMs: 200, graceMs: 200, drainMs: 200 });
    expect(result.code).toBe(TIMED_OUT);
    expect(result.lingering).toBe(false);
    await pidFrom(join(dir, "child"));
  });

  test("stderr: ignore leaves the result to stdout alone, however much stderr there is", async () => {
    own();
    const result = await runBounded(["/bin/sh", "-c", "head -c 5000 /dev/zero >&2; echo token"], { label: "quiet", timeoutMs: 5_000, maxOutputBytes: 1_000, stderr: "ignore" });
    expect(result).toMatchObject({ code: 0, stdout: "token\n", stderr: "", incomplete: null });
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

function writeEntry(dir: string, pid: number, spawnedAt: number, label = "left"): string {
  const path = join(dir, `${pid}.json`);
  writeFileSync(path, JSON.stringify({ pid, spawned_at: spawnedAt, argv0: "sh", label }));
  return path;
}

/** ps that cannot run for pid 999999, as when it cannot spawn, and answers for the rest. */
const psFailingFor999999: PsRunner = async (pids) => {
  if (pids.includes(999_999)) throw new Error("posix_spawn failed");
  return psRunner(pids);
};

describe("recoverOwnedProcesses (the next daemon's start)", () => {
  test("a recorded live group is ended, the entry removed, and an unrelated process left alone", async () => {
    const ledger = tempDir();
    const dir = tempDir();
    const other = unrelated();
    const spawnedAt = Date.now();
    const leader = Bun.spawn(["/bin/sh", "-c", `sleep 60 & echo $! > ${dir}/child; wait`], { detached: true, stdout: "ignore", stderr: "ignore" });
    strays.push(leader.pid);
    const child = await pidFrom(join(dir, "child"));
    const path = writeEntry(ledger, leader.pid, spawnedAt, "docker ps");
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
    const path = writeEntry(ledger, proc.pid, Date.now());
    const found = await recoverOwnedProcesses(ledger);
    expect(found.gone).toEqual([{ pid: proc.pid, label: "left" }]);
    expect(existsSync(path)).toBe(false);
  });

  test("a live group leader that started outside the entry's window is another process: dropped, left running", async () => {
    const ledger = tempDir();
    const other = unrelated();
    writeEntry(ledger, other, Date.now() - 3_600_000);
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
    writeEntry(ledger, notLeader.pid, spawnedAt);
    const found = await recoverOwnedProcesses(ledger);
    expect(found.gone.map((g) => g.pid)).toEqual([notLeader.pid]);
    expect(alive(notLeader.pid)).toBe(true);
  });

  test("a torn .json.tmp (died between write and rename) is removed, not reported on every start", async () => {
    const ledger = tempDir();
    const path = join(ledger, "123.json.tmp");
    writeFileSync(path, "{");
    const found = await recoverOwnedProcesses(ledger);
    expect(found.discarded).toEqual([path]);
    expect(found.unreadable).toEqual([]);
    expect(existsSync(path)).toBe(false);
    expect((await recoverOwnedProcesses(ledger)).discarded).toEqual([]);
  });

  test("a readable .json.tmp is recovered like an entry", async () => {
    const ledger = tempDir();
    const dir = tempDir();
    const spawnedAt = Date.now();
    const leader = Bun.spawn(["/bin/sh", "-c", `sleep 60 & echo $! > ${dir}/child; wait`], { detached: true, stdout: "ignore", stderr: "ignore" });
    strays.push(leader.pid);
    const child = await pidFrom(join(dir, "child"));
    const path = join(ledger, `${leader.pid}.json.tmp`);
    writeFileSync(path, JSON.stringify({ pid: leader.pid, spawned_at: spawnedAt, argv0: "sh", label: "torn rename" }));
    const found = await recoverOwnedProcesses(ledger, { graceMs: 500 });
    expect(found.ended).toEqual([{ pid: leader.pid, label: "torn rename" }]);
    expect(await gone(child)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  test("ps failing for one entry keeps that entry and still recovers the others", async () => {
    const ledger = tempDir();
    const dir = tempDir();
    const spawnedAt = Date.now();
    const leader = Bun.spawn(["/bin/sh", "-c", `sleep 60 & echo $! > ${dir}/child; wait`], { detached: true, stdout: "ignore", stderr: "ignore" });
    strays.push(leader.pid);
    const child = await pidFrom(join(dir, "child"));
    // "0.json" sorts first: its check fails, as when ps cannot spawn.
    const broken = join(ledger, "0.json");
    writeFileSync(broken, JSON.stringify({ pid: 999_999, spawned_at: spawnedAt, argv0: "sh", label: "unchecked" }));
    const path = writeEntry(ledger, leader.pid, spawnedAt, "docker ps");
    const found = await recoverOwnedProcesses(ledger, { graceMs: 500, ps: psFailingFor999999 });
    expect(found.failed).toEqual([{ pid: 999_999, label: "unchecked", detail: "cannot check it: posix_spawn failed" }]);
    expect(found.ended).toEqual([{ pid: leader.pid, label: "docker ps" }]);
    expect(existsSync(broken)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(await gone(child)).toBe(true);
  });

  test("a live leader whose group cannot be read is kept as failed, never dropped as gone", async () => {
    const ledger = tempDir();
    const dir = tempDir();
    const spawnedAt = Date.now();
    const leader = Bun.spawn(["/bin/sh", "-c", `sleep 60 & echo $! > ${dir}/child; wait`], { detached: true, stdout: "ignore", stderr: "ignore" });
    strays.push(leader.pid);
    const child = await pidFrom(join(dir, "child"));
    const failingPs = join(dir, "ps");
    writeFileSync(failingPs, "#!/bin/sh\necho 'ps: no table' >&2\nexit 1\n", { mode: 0o755 });
    const garblingPs = join(dir, "ps-garbled");
    writeFileSync(garblingPs, "#!/bin/sh\necho 'not a group'\n", { mode: 0o755 });
    const path = writeEntry(ledger, leader.pid, spawnedAt, "docker ps");
    for (const groupPs of [failingPs, garblingPs]) {
      const found = await recoverOwnedProcesses(ledger, { graceMs: 500, groupPs });
      expect(found.gone).toEqual([]);
      expect(found.failed.map((f) => f.pid)).toEqual([leader.pid]);
      expect(found.failed[0]!.detail).toStartWith("cannot check it: ");
      expect(existsSync(path)).toBe(true);
      expect(alive(child)).toBe(true);
    }
    const found = await recoverOwnedProcesses(ledger, { graceMs: 500 });
    expect(found.ended).toEqual([{ pid: leader.pid, label: "docker ps" }]);
    expect(await gone(child)).toBe(true);
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
    expect(found).toEqual({ ended: [], gone: [], failed: [], unreadable: [], discarded: [] });
  });
});

test("ps etime reads as elapsed ms in every form ps prints, and garbage as null", () => {
  expect(parseEtime("00:05")).toBe(5_000);
  expect(parseEtime("12:34")).toBe((12 * 60 + 34) * 1_000);
  expect(parseEtime("01:02:03")).toBe((3_600 + 120 + 3) * 1_000);
  expect(parseEtime("2-01:00:00")).toBe((2 * 24 + 1) * 3_600_000);
  expect(parseEtime("  00:01 ")).toBe(1_000);
  expect(parseEtime("")).toBeNull();
  expect(parseEtime("soon")).toBeNull();
});
