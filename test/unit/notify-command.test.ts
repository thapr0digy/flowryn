import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NotifyPump, commandEnv, commandInput, runNotifyCommand, testMessage, type CommandMessage } from "../../src/attention/notify.ts";
import { startAway } from "../../src/attention/away.ts";
import { openItem, type ItemKind } from "../../src/attention/items.ts";
import { parseConfig } from "../../src/config/config.ts";
import { DEFAULT_NOTIFY, notifyConfig } from "../../src/config/leader.ts";
import { tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { notifyCommandCheck } from "../../src/doctor/doctor.ts";
import { configureOwnedProcesses } from "../../src/runtime/bounded.ts";
import { daemonCall, makeHome, startDaemon, type DaemonProc, type TestHome } from "../helpers/harness.ts";

/**
 * `[notify] command` (docs/notes/2026-10-25-notifications-that-reach-6f.md):
 * a shell command of yours, run for every P0 send and, while you are away,
 * the batched one, with the text on stdin. These tests run a real /bin/sh
 * script that writes what it got to a file; nothing reaches the network.
 */

const homes: TestHome[] = [];
const dbs: Db[] = [];
const daemons: DaemonProc[] = [];

afterEach(async () => {
  configureOwnedProcesses(null);
  for (const d of daemons.splice(0)) await d.kill9().catch(() => {});
  for (const db of dbs.splice(0)) db.close();
  for (const h of homes.splice(0)) h.cleanup();
});

function home(extraConfig = ""): TestHome {
  const h = makeHome({ extraConfig });
  homes.push(h);
  return h;
}

function openDb(h: TestHome): Db {
  const db = h.db();
  dbs.push(db);
  return db;
}

function open(db: Db, kind: ItemKind, line: string, now: number): string {
  return tx(db, () => {
    const event = appendEvent(db, { source: "cli", kind: "test.item" });
    return openItem(db, { kind, eventSeq: event.seq, line, now });
  });
}

/** A notify script that appends one JSON line per run: its stdin and the FLOWRYN_NOTIFY_* it saw. */
function recorder(h: TestHome, body = ""): { command: string; runs(): { stdin: string; env: Record<string, string> }[] } {
  const out = join(h.home, "notify-runs.jsonl");
  const script = join(h.home, "notify.sh");
  writeFileSync(
    script,
    `#!/bin/sh
stdin=$(cat)
${body}
bun -e 'const e = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("FLOWRYN_") || k === "GH_TOKEN" || k === "KEEP_ME")); require("fs").appendFileSync(process.argv[1], JSON.stringify({ stdin: process.argv[2], env: e }) + "\\n")' "${out}" "$stdin"
`,
  );
  chmodSync(script, 0o755);
  return {
    command: script,
    runs: () => (existsSync(out) ? readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []),
  };
}

function pump(h: TestHome, db: Db, clock: { now: number }, notify: string, opts: { off?: boolean; log?: string[]; env?: NodeJS.ProcessEnv } = {}) {
  const cfg = parseConfig(`[notify]\nmacos = false\nherdr = false\nmin_interval_min = 30\n${notify}`, h.home);
  return new NotifyPump({
    db,
    config: () => cfg,
    runtime: () => null,
    now: () => clock.now,
    log: (line) => void opts.log?.push(line),
    off: () => opts.off ?? false,
    env: opts.env ?? { PATH: process.env.PATH, HOME: process.env.HOME },
    cwd: h.home,
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function commandEvents(db: Db): Record<string, unknown>[] {
  return (db.query("SELECT payload FROM events WHERE kind = 'notification.command' ORDER BY seq").all() as { payload: string }[]).map((r) => JSON.parse(r.payload));
}

describe("[notify] command config", () => {
  test("off by default; a string is trimmed; anything else is refused", () => {
    expect(DEFAULT_NOTIFY.command).toBe("");
    expect(DEFAULT_NOTIFY.command_timeout_s).toBe(10);
    const h = home();
    expect(notifyConfig(parseConfig(`[notify]\ncommand = "  /bin/true  "\ncommand_timeout_s = 3`, h.home))).toMatchObject({ command: "/bin/true", command_timeout_s: 3 });
    expect(() => notifyConfig(parseConfig(`[notify]\ncommand = 1`, h.home))).toThrow("[notify] command must be a string");
    expect(() => notifyConfig(parseConfig(`[notify]\ncommand = ["a"]`, h.home))).toThrow("[notify] command must be a string");
    expect(() => notifyConfig(parseConfig(`[notify]\ncommand_timeout_s = 0`, h.home))).toThrow("[notify] command_timeout_s must be a positive integer");
    expect(() => notifyConfig(parseConfig(`[notify]\ncommands = "x"`, h.home))).toThrow("[notify] commands is not a known setting");
  });
});

describe("what the command receives", () => {
  const message: CommandMessage = {
    kind: "p0",
    notification: "n7",
    away: true,
    title: "Flowryn: 2 P0s need you",
    items: [
      { id: "i3", lane: "P0", line: "web-fix-a1 failed; token ghp_abcdefghijklmnopqrstuvwxyz0123" },
      { id: "i4", lane: "P0", line: "$(touch /tmp/pwned) `id` stays text" },
    ],
  };

  test("stdin: the title, then every item, with secrets blanked", () => {
    expect(commandInput(message)).toBe("Flowryn: 2 P0s need you\ni3 P0 web-fix-a1 failed; token [redacted]\ni4 P0 $(touch /tmp/pwned) `id` stays text\n");
  });

  test("env: the scrubbed base plus ids and kinds; never item text, Flowryn's own variables or a GitHub token", () => {
    const env = commandEnv({ PATH: "/usr/bin", KEEP_ME: "1", GH_TOKEN: "g", GITHUB_TOKEN: "g", FLOWRYN_HOME: "/f", CLAUDECODE: "1" }, message);
    expect(env).toEqual({
      PATH: "/usr/bin",
      KEEP_ME: "1",
      FLOWRYN_NOTIFY_ID: "n7",
      FLOWRYN_NOTIFY_KIND: "p0",
      FLOWRYN_NOTIFY_AWAY: "1",
      FLOWRYN_NOTIFY_ITEMS: "i3 i4",
      FLOWRYN_NOTIFY_TITLE: "Flowryn: 2 P0s need you",
    });
    expect(Object.values(env).some((v) => v.includes("failed"))).toBe(false);
  });

  test("assumption: runBounded closes stdin after writing, so cat in the command ends", async () => {
    const outcome = await runNotifyCommand("cat >/dev/null; echo done >&2; exit 3", 5_000, message, { env: { PATH: "/usr/bin:/bin" } });
    expect(outcome).toEqual({ code: 3, timedOut: false, stderr: "done" });
  });

  test("item text never reaches the command line: a line that is shell is only read", async () => {
    const h = home();
    const out = join(h.home, "got.txt");
    const outcome = await runNotifyCommand(`cat > '${out}'`, 5_000, { ...message, items: [{ id: "i9", lane: "P0", line: `$(touch '${join(h.home, "pwned")}')` }] }, { env: { PATH: "/usr/bin:/bin" } });
    expect(outcome.code).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("$(touch");
    expect(existsSync(join(h.home, "pwned"))).toBe(false);
  });
});

describe("which sends reach the command", () => {
  test("every P0 send; the batch only while you are away; each run is an event", async () => {
    const h = home();
    const db = openDb(h);
    const script = recorder(h);
    const clock = { now: Date.now() };
    const notifier = pump(h, db, clock, `command = "${script.command}"`);
    const p0 = open(db, "failure_needs_you", "first p0", clock.now);
    open(db, "report_ready", "report at home", clock.now);
    await notifier.tick();
    expect(script.runs()).toHaveLength(1);
    expect(script.runs()[0]!.stdin).toBe(`Flowryn: a P0 needs you\n${p0} P0 first p0`);
    expect(script.runs()[0]!.env).toMatchObject({ FLOWRYN_NOTIFY_KIND: "p0", FLOWRYN_NOTIFY_AWAY: "0", FLOWRYN_NOTIFY_ITEMS: p0 });
    // At home with the Mac channels off the batch has no channel: it is not recorded, so it still goes out once you are away.
    expect(db.query("SELECT channel FROM notifications ORDER BY sent_at").all()).toEqual([{ channel: "p0:command" }]);

    tx(db, () => startAway(db, { until: clock.now + 3_600_000, words: null, by: "human", now: clock.now }));
    clock.now += 1_000;
    await notifier.tick();
    expect(script.runs()).toHaveLength(2);
    expect(script.runs()[1]!.stdin).toContain("Flowryn: 1 item needs you\n");
    expect(script.runs()[1]!.stdin).toContain("report at home");
    expect(script.runs()[1]!.env).toMatchObject({ FLOWRYN_NOTIFY_KIND: "batch", FLOWRYN_NOTIFY_AWAY: "1" });
    expect(commandEvents(db).map((e) => [e.kind, e.ok, e.code])).toEqual([
      ["p0", true, 0],
      ["batch", true, 0],
    ]);
  });

  test("the Mac channels keep their own batch at home; only the command waits for away", async () => {
    const h = home();
    const db = openDb(h);
    const script = recorder(h);
    const clock = { now: Date.now() };
    const sent: string[] = [];
    const cfg = parseConfig(`[notify]\nmacos = true\nherdr = false\ncommand = "${script.command}"`, h.home);
    const notifier = new NotifyPump({ db, config: () => cfg, runtime: () => null, now: () => clock.now, log: () => {}, off: () => false, macos: async (title) => void sent.push(title), env: { PATH: process.env.PATH } });
    open(db, "report_ready", "report", clock.now);
    await notifier.tick();
    expect(sent).toEqual(["Flowryn: 1 item needs you"]);
    expect(script.runs()).toEqual([]);
    expect(db.query("SELECT channel FROM notifications").all()).toEqual([{ channel: "batch:macos" }]);
  });

  test("no command set: nothing changes", async () => {
    const h = home();
    const db = openDb(h);
    const clock = { now: Date.now() };
    open(db, "failure_needs_you", "p0", clock.now);
    await pump(h, db, clock, "").tick();
    expect(db.query("SELECT COUNT(*) AS n FROM notifications").get()).toEqual({ n: 0 });
    expect(commandEvents(db)).toEqual([]);
  });

  test("FLOWRYN_NOTIFY=off: the send is recorded, the command never runs", async () => {
    const h = home();
    const db = openDb(h);
    const script = recorder(h);
    const clock = { now: Date.now() };
    open(db, "failure_needs_you", "p0", clock.now);
    await pump(h, db, clock, `command = "${script.command}"`, { off: true }).tick();
    expect(db.query("SELECT channel FROM notifications").all()).toEqual([{ channel: "p0:command" }]);
    expect(script.runs()).toEqual([]);
    expect(commandEvents(db)).toEqual([]);
  });

  test("assumption: the away check in the plan sees the posture startAway wrote, and an expired away is not away", async () => {
    const h = home();
    const db = openDb(h);
    const script = recorder(h);
    const clock = { now: Date.now() };
    tx(db, () => startAway(db, { until: clock.now + 1_000, words: null, by: "human", now: clock.now }));
    clock.now += 2_000;
    open(db, "report_ready", "report", clock.now);
    await pump(h, db, clock, `command = "${script.command}"`).tick();
    expect(script.runs()).toEqual([]);
  });
});

describe("a failing or hung command", () => {
  test("a non-zero exit is logged and recorded, never retried", async () => {
    const h = home();
    const db = openDb(h);
    const clock = { now: Date.now() };
    const log: string[] = [];
    open(db, "failure_needs_you", "p0", clock.now);
    await pump(h, db, clock, `command = "echo 'no route to ntfy' >&2; exit 7"`, { log }).tick();
    expect(commandEvents(db)).toEqual([{ notification: "n1", kind: "p0", ok: false, code: 7, timed_out: false, stderr: "no route to ntfy" }]);
    expect(log).toEqual(["notify: command failed for n1: exit 7: no route to ntfy"]);
    await pump(h, db, clock, `command = "exit 7"`, { log }).tick();
    expect(commandEvents(db)).toHaveLength(1);
  });

  test("a missing program is a failure, not a crash", async () => {
    const h = home();
    const db = openDb(h);
    const clock = { now: Date.now() };
    open(db, "failure_needs_you", "p0", clock.now);
    await pump(h, db, clock, `command = "/nonexistent/notify"`).tick();
    expect(commandEvents(db)).toMatchObject([{ ok: false, code: 127 }]);
  });

  test("a command past its deadline is ended with everything it started, and the next send still goes out", async () => {
    const h = home();
    const db = openDb(h);
    configureOwnedProcesses({ dir: join(h.home, "owned"), log: () => {} });
    const pidFile = join(h.home, "child.pid");
    const clock = { now: Date.now() };
    const config = `command = "sleep 30 & echo $! > '${pidFile}'; wait"\ncommand_timeout_s = 1\np0_coalesce_s = 1`;
    open(db, "failure_needs_you", "first", clock.now);
    const started = Date.now();
    await pump(h, db, clock, config).tick();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(commandEvents(db)).toMatchObject([{ ok: false, code: 124, timed_out: true }]);
    const child = Number(readFileSync(pidFile, "utf8").trim());
    expect(alive(child)).toBe(false);
    open(db, "failure_needs_you", "second", clock.now);
    clock.now += 2_000;
    await pump(h, db, clock, `command = "cat >/dev/null"\np0_coalesce_s = 1`).tick();
    expect(commandEvents(db)).toMatchObject([{ ok: false, code: 124 }, { ok: true, code: 0 }]);
  }, 20_000);
});

describe("flowryn notify test", () => {
  test("runs the command once with a sample and records it; refuses with notifications off or no command", async () => {
    const h = home();
    const db = openDb(h);
    const script = recorder(h);
    const clock = { now: Date.now() };
    const { outcome, message } = await pump(h, db, clock, `command = "${script.command}"`).testCommand();
    expect(outcome.code).toBe(0);
    expect(message).toEqual(testMessage(false));
    expect(script.runs()[0]!.env).toMatchObject({ FLOWRYN_NOTIFY_KIND: "test", FLOWRYN_NOTIFY_ID: "" });
    expect(commandEvents(db)).toMatchObject([{ kind: "test", ok: true }]);
    await expect(pump(h, db, clock, `command = "${script.command}"`, { off: true }).testCommand()).rejects.toThrow("notifications are off");
    await expect(pump(h, db, clock, "").testCommand()).rejects.toThrow("[notify] command is not set");
  });

  test("assumption: a daemon verb's prepare can await the command (under the test home's off switch it reaches the pump and is refused there)", async () => {
    const h = home(`[notify]\nmacos = false\nherdr = false\ncommand = "/bin/true"`);
    daemons.push(await startDaemon(h));
    const reply = await daemonCall(h.home, "notify test", {});
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe("not_supported");
    expect(reply.error?.message).toContain("notifications are off");
  }, 30_000);
});

describe("doctor's notify command check", () => {
  test("nothing without a command; info before a run; ok after a success; a warning after a failure", () => {
    const h = home();
    const db = openDb(h);
    const set = parseConfig(`[notify]\ncommand = "/bin/true"`, h.home);
    expect(notifyCommandCheck(parseConfig("", h.home), db)).toBeNull();
    expect(notifyCommandCheck(set, db)).toMatchObject({ status: "info" });
    expect(notifyCommandCheck(set, null)).toMatchObject({ status: "info" });
    const record = (payload: Record<string, unknown>) => tx(db, () => appendEvent(db, { source: "daemon", kind: "notification.command", payload }));
    record({ notification: "n1", kind: "p0", ok: true, code: 0, timed_out: false, stderr: "" });
    expect(notifyCommandCheck(set, db)).toMatchObject({ status: "ok", check: "notify command" });
    record({ notification: "n2", kind: "batch", ok: false, code: 124, timed_out: true, stderr: "" });
    const warn = notifyCommandCheck(set, db);
    expect(warn?.status).toBe("warn");
    expect(warn?.detail).toContain("(batch) failed: timed out; fix it, then flowryn notify test");
  });
});

describe("a review page's pass code (docs/notes/2026-10-30-pass-a-review-c6.md)", () => {
  test("goes to the notify command whether or not you are away, stored nowhere: no notifications row, no item, and the event keeps no stderr", async () => {
    const h = home();
    const db = openDb(h);
    const rec = recorder(h, 'echo "$stdin" >&2');
    const log: string[] = [];
    const p = pump(h, db, { now: 1_000 }, `command = "${rec.command}"`, { log });
    expect(await p.sendPassCode("g1", "Flowryn pass code: WXYZ", "Type WXYZ on the review page to pass the design review of web-x")).toEqual(["command"]);
    const [run] = rec.runs();
    expect(run!.stdin).toContain("Type WXYZ on the review page");
    expect(run!.env.FLOWRYN_NOTIFY_KIND).toBe("pass_code");
    expect(run!.env.FLOWRYN_NOTIFY_TITLE).toBe("Flowryn pass code: WXYZ");
    expect(commandEvents(db)).toEqual([expect.objectContaining({ kind: "pass_code", ok: true, stderr: "" })]);
    expect(db.query("SELECT COUNT(*) AS n FROM notifications").get()).toEqual({ n: 0 });
    expect(JSON.stringify(db.query("SELECT * FROM events").all())).not.toContain("WXYZ");
    expect(log.join("\n")).not.toContain("WXYZ");
  });

  test("with notifications off it reaches nothing, except the tests' recorder", async () => {
    const h = home();
    const db = openDb(h);
    const rec = recorder(h);
    const off = pump(h, db, { now: 1_000 }, `command = "${rec.command}"`, { off: true });
    expect(await off.sendPassCode("g1", "t", "x")).toEqual([]);
    expect(rec.runs()).toEqual([]);
    const seen: string[] = [];
    const cfg = parseConfig(`[notify]\nmacos = true\ncommand = "${rec.command}"`, h.home);
    const recording = new NotifyPump({ db, config: () => cfg, runtime: () => null, now: () => 1_000, log: () => {}, off: () => true, macos: async (title) => void seen.push(title), macosRecords: true });
    expect(await recording.sendPassCode("g1", "Flowryn pass code: ABCD", "x")).toEqual(["macos"]);
    expect(seen).toEqual(["Flowryn pass code: ABCD"]);
    expect(rec.runs()).toEqual([]);
  });
});
