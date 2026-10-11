import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NotifyPump, osascriptNotify, recordingNotify } from "../../src/attention/notify.ts";
import { openItem } from "../../src/attention/items.ts";
import { parseConfig } from "../../src/config/config.ts";
import { DEFAULT_NOTIFY, notificationsOff, recordingNotifierPath, requireNotificationsOff } from "../../src/config/leader.ts";
import { tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { LATER_SECTION_DEFAULTS } from "../../src/init/init.ts";
import { makeHome, pingSocket, startDaemon, waitUntil, type DaemonProc, type TestHome } from "../helpers/harness.ts";
import { refusedOsascriptSpawns } from "../helpers/no-notifications.ts";
import { runOpen } from "../../src/lavish/opener.ts";

/**
 * macOS notifications are on in your own setup unless your config turns them
 * off; FLOWRYN_NOTIFY=off stops every channel while the decisions are still
 * recorded, and nothing in the test suite ever reaches osascript: the preload
 * sets the override and refuses osascript in-process, every harness daemon
 * runs with the override and a recording macOS channel, and a launcher
 * refuses to start a daemon without the override.
 */

const homes: TestHome[] = [];
const daemons: DaemonProc[] = [];

afterEach(async () => {
  for (const d of daemons.splice(0)) await d.kill9().catch(() => {});
  for (const h of homes.splice(0)) h.cleanup();
});

function home(extraConfig = ""): TestHome {
  const h = makeHome({ extraConfig });
  homes.push(h);
  return h;
}

function openP0(db: Db, line: string): void {
  tx(db, () => {
    const event = appendEvent(db, { source: "cli", kind: "test.p0" });
    openItem(db, { kind: "failure_needs_you", eventSeq: event.seq, line, now: Date.now() });
  });
}

describe("notifications are on in your setup, and never real under test", () => {
  test("the macOS channel is on by default, and the override stops it", () => {
    expect(DEFAULT_NOTIFY.macos).toBe(true);
    expect((LATER_SECTION_DEFAULTS.notify as { macos: boolean }).macos).toBe(true);
    expect(process.env.FLOWRYN_NOTIFY).toBe("off");
    expect(notificationsOff({ FLOWRYN_NOTIFY: "off" })).toBe(true);
    expect(notificationsOff({ FLOWRYN_NOTIFIER: "null" })).toBe(true);
    expect(notificationsOff({})).toBe(false);
    expect(recordingNotifierPath({ FLOWRYN_NOTIFIER: "record:/tmp/n.jsonl" })).toBe("/tmp/n.jsonl");
    expect(recordingNotifierPath({ FLOWRYN_NOTIFIER: "null" })).toBeNull();
  });

  test("every test home's daemon runs with FLOWRYN_NOTIFY=off and a recording macOS channel", () => {
    const h = home();
    expect(h.env.FLOWRYN_NOTIFY).toBe("off");
    expect(h.env.FLOWRYN_NOTIFIER).toBe(`record:${join(h.home, "notified.jsonl")}`);
  });

  test("the pump delivers to macOS unless the config turns it off or the override stops it", async () => {
    const h = home();
    const db = h.db();
    try {
      const sent: string[] = [];
      const macos = async (title: string) => void sent.push(title);
      const pump = (text: string, off: boolean) =>
        new NotifyPump({ db, config: () => parseConfig(text, h.home), runtime: () => null, now: Date.now, log: () => {}, macos, off: () => off });
      openP0(db, "first");
      await pump("[notify]\nmacos = false\nherdr = false", false).tick();
      expect(sent).toEqual([]);
      expect(db.query("SELECT COUNT(*) AS n FROM notifications").get()).toEqual({ n: 0 });
      await pump("[notify]\nmacos = true\nherdr = false", true).tick();
      // Off: the decision is recorded, nothing is delivered.
      expect(sent).toEqual([]);
      expect(db.query("SELECT channel FROM notifications").all()).toEqual([{ channel: "p0:macos" }]);
      openP0(db, "second");
      await pump("[notify]\nmacos = true\nherdr = false\np0_coalesce_s = 1", false).tick().then(() => Bun.sleep(1_100));
      await pump("[notify]\nmacos = true\nherdr = false\np0_coalesce_s = 1", false).tick();
      expect(sent).toEqual(["Flowryn: a P0 needs you"]);
    } finally {
      db.close();
    }
  });

  test(
    "a daemon with macOS notifications on records them and delivers none under FLOWRYN_NOTIFY=off",
    async () => {
      const h = home("[notify]\nmacos = true\nherdr = false\np0_coalesce_s = 1");
      const recorded = join(h.home, "notified.jsonl");
      const db = h.db();
      openP0(db, "while off");
      db.close();
      daemons.push(await startDaemon(h));
      await waitUntil(() => {
        const check = h.db();
        try {
          return (check.query("SELECT COUNT(*) AS n FROM notifications").get() as { n: number }).n === 1;
        } finally {
          check.close();
        }
      }, 10_000, "the P0's notification to be recorded");
      expect(existsSync(recorded)).toBe(false);
    },
    { timeout: 30_000 },
  );

  test("a launcher refuses to start a daemon without FLOWRYN_NOTIFY=off", async () => {
    expect(() => requireNotificationsOff({}, "m5-live")).toThrow("m5-live starts no daemon without FLOWRYN_NOTIFY=off");
    expect(() => requireNotificationsOff({ FLOWRYN_NOTIFY: "on" }, "m5-live")).toThrow("without FLOWRYN_NOTIFY=off");
    expect(() => requireNotificationsOff({ FLOWRYN_NOTIFY: "off" }, "m5-live")).not.toThrow();
    const h = home("[notify]\nmacos = true\nherdr = false");
    await expect(startDaemon(h, { FLOWRYN_NOTIFY: "" })).rejects.toThrow("the test harness starts no daemon without FLOWRYN_NOTIFY=off");
    expect(await pingSocket(h)).toBe(false);
  });

  test("the recording macOS channel appends each notification instead of running osascript", async () => {
    const h = home();
    const recorded = join(h.home, "notified.jsonl");
    await recordingNotify(recorded)("Flowryn: a P0 needs you", "body");
    expect(JSON.parse(readFileSync(recorded, "utf8").trim())).toMatchObject({ title: "Flowryn: a P0 needs you", body: "body" });
  });

  test("in this process, osascript is refused, and nothing has spawned it", async () => {
    await expect(osascriptNotify("title", "body")).rejects.toThrow("never runs osascript");
    // That refusal is counted too; the preload's afterAll fails a file with any, so take this one back out.
    const spawns = refusedOsascriptSpawns() as string[];
    expect(spawns.length).toBe(1);
    spawns.splice(0);
  });

  test("nor does a test open a browser tab: open is refused in-process, and test homes record review pages", async () => {
    expect(await runOpen("Google Chrome", "http://127.0.0.1:1/session/0123456789abcdef")).toEqual({ ok: false, why: "cannot run open: the test suite never runs open: a real browser tab would open on your Mac" });
    const spawns = refusedOsascriptSpawns() as string[];
    expect(spawns.length).toBe(1);
    spawns.splice(0);
    const h = home();
    expect(h.env.FLOWRYN_OPENER).toBe(`record:${join(h.home, "browser-opens.log")}`);
  });
});
