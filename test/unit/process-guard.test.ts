import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { descendants, parsePsTable, pidExists, readPsTable, REAPER, signalIfSame, survivors, sweepStaleStates, track, type PsRow, type Tracked } from "../helpers/process-guard.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = "./test/fixtures/process-guard/leaks.fixture.ts";

const row = (pid: number, ppid: number, start = "Sat Nov 21 10:00:00 2026", command = `cmd-${pid}`): PsRow => ({ pid, ppid, start, command });

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await Bun.sleep(50);
  }
}

/** A nested bun test's reaper is gone (it exits once its test process has), so this file's own guard never counts it. */
async function reaperGone(testPid: number): Promise<void> {
  await waitFor(() => !(readPsTable() ?? []).some((r) => r.command.includes(REAPER) && r.command.endsWith(` ${testPid}`)), 15_000, `the reaper of ${testPid} to exit`);
}

describe("the process table", () => {
  test("reads ps rows with a space-padded day and a command with spaces", () => {
    const rows = parsePsTable("  412     1 Sat Nov  7 09:05:01 2026     /bin/sh -c while [ ! -f go ]; do sleep 0.05; done\n 9 412 Sat Nov 21 10:00:00 2026 sleep 1\nnot a row\n");
    expect(rows).toEqual([
      { pid: 412, ppid: 1, start: "Sat Nov 7 09:05:01 2026", command: "/bin/sh -c while [ ! -f go ]; do sleep 0.05; done" },
      { pid: 9, ppid: 412, start: "Sat Nov 21 10:00:00 2026", command: "sleep 1" },
    ]);
  });

  test("the live table reads, and lists this process under its parent", () => {
    const rows = readPsTable();
    expect(rows).not.toBeNull();
    expect(rows!.find((r) => r.pid === process.pid)?.ppid).toBe(process.ppid);
  });
});

describe("what the guard remembers", () => {
  test("descendants are the whole tree under the root, leaving out an excluded subtree (the reaper and its ps)", () => {
    const rows = [row(10, 1), row(11, 10), row(12, 11), row(13, 10), row(14, 13), row(20, 1)];
    expect(descendants(rows, 10, new Set([13])).map((r) => r.pid)).toEqual([11, 12]);
  });

  test("a process seen under the test process stays remembered after launchd adopts it, and is forgotten once it exits", () => {
    const tracked = new Map<string, Tracked>();
    expect(track(tracked, [row(10, 1), row(11, 10), row(12, 11)], 10, new Set())).toBe(true);
    // The sh between them exited: 12 was adopted by launchd, and is still the test's.
    expect(track(tracked, [row(10, 1), row(12, 1)], 10, new Set())).toBe(true);
    expect([...tracked.values()].map((t) => t.pid)).toEqual([12]);
    expect(track(tracked, [row(10, 1), row(12, 1)], 10, new Set())).toBe(false);
    expect(track(tracked, [row(10, 1)], 10, new Set())).toBe(true);
    expect(tracked.size).toBe(0);
  });

  test("survivors are only remembered processes: never an unrelated adopted process, never a reused pid", () => {
    const tracked: Tracked[] = [{ pid: 12, start: "Sat Nov 21 10:00:00 2026", command: "sleep 600" }, { pid: 30, start: "Sat Nov 21 10:00:00 2026", command: "sh" }];
    const rows = [
      row(12, 1, "Sat Nov 21 10:00:00 2026", "sleep 600"),
      // pid 30 exited and was reused by another process: another start time.
      row(30, 1, "Sat Nov 21 11:30:00 2026", "/usr/local/bin/claude"),
      // The user's own Claude session, adopted by launchd like the leak, but never seen under the test process.
      row(77, 1, "Sat Nov 21 09:00:00 2026", "claude --version"),
    ];
    expect(survivors(tracked, rows).map((r) => r.pid)).toEqual([12]);
  });

  test("a cleanup never signals a pid it did not spawn: only the tracked child, checked against the live table", async () => {
    const mine = Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    try {
      await waitFor(() => (readPsTable() ?? []).some((r) => r.pid === mine.pid), 5_000, "the child in the table");
      const live = readPsTable()!;
      const own = live.find((r) => r.pid === mine.pid)!;
      const parent = live.find((r) => r.pid === process.ppid)!;
      const sent: number[] = [];
      const targets: Tracked[] = [
        { pid: own.pid, start: own.start, command: own.command },
        // This test process's parent with a start time it does not have: a reused pid.
        { pid: parent.pid, start: "Thu Jan  1 00:00:00 1970", command: parent.command },
        // launchd, recorded with a start time it does not have.
        { pid: 1, start: "Thu Jan  1 00:00:00 1970", command: "launchd" },
      ];
      expect(signalIfSame(targets, "SIGTERM", (pid) => sent.push(pid))).toEqual([mine.pid]);
      expect(sent).toEqual([mine.pid]);
    } finally {
      mine.kill("SIGKILL");
      await mine.exited;
    }
  });
});

describe("the guard's state files", () => {
  test("a file whose test process is gone, or a torn write whose writer is, is swept; a live one and other names are kept", () => {
    // A scratch directory: the real one holds this run's own state.
    const dir = mkdtempSync(join(tmpdir(), "fw-guard-states-"));
    const names = ["999999901.json", "999999902.json", "999999902.json.999999903.tmp", "999999902.json.999999904.tmp", "notes.txt"];
    for (const name of names) writeFileSync(join(dir, name), "{}");
    try {
      const live = new Set([999999902, 999999904]);
      expect(sweepStaleStates((pid) => live.has(pid), dir).toSorted()).toEqual(["999999901.json", "999999902.json.999999903.tmp"]);
      expect(names.filter((name) => existsSync(join(dir, name)))).toEqual(["999999902.json", "999999902.json.999999904.tmp", "notes.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("only ESRCH reads as gone: this process exists, an exited child does not", async () => {
    const child = Bun.spawn(["true"]);
    await child.exited;
    expect(pidExists(process.pid)).toBe(true);
    expect(pidExists(child.pid)).toBe(false);
  });
});

describe("the guard on a real bun test", () => {
  test(
    "a file that leaks a grandchild fails its run, names it, and the leak is ended",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "fw-guard-"));
      try {
        const pidFile = join(dir, "leak.pid");
        const run = Bun.spawn(["bun", "test", FIXTURE], { cwd: REPO_ROOT, env: { ...process.env, LEAK_PID_FILE: pidFile }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
        const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
        await reaperGone(run.pid);
        expect(code).not.toBe(0);
        expect(out + err).toContain("process guard: 2 process(es) the tests started outlived their teardown; they have been ended");
        expect(out + err).toContain("sleep 30");
        expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test(
    "a bun test killed with SIGKILL mid-test: its reaper ends the leaked grandchild, adopted by launchd, within seconds",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "fw-guard-"));
      try {
        const pidFile = join(dir, "leak.pid");
        const run = Bun.spawn(["bun", "test", FIXTURE], { cwd: REPO_ROOT, env: { ...process.env, LEAK_PID_FILE: pidFile, LEAK_HOLD_MS: "60000", LEAK_SECONDS: "120" }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
        await waitFor(() => existsSync(pidFile), 15_000, "the leaked child");
        const leaked = Number(readFileSync(pidFile, "utf8"));
        // Long enough for the reaper to have sampled it.
        await Bun.sleep(2_500);
        expect(alive(leaked)).toBe(true);
        run.kill("SIGKILL");
        await run.exited;
        await waitFor(() => !alive(leaked), 10_000, "the leaked child to be ended");
        await reaperGone(run.pid);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    40_000,
  );
});
