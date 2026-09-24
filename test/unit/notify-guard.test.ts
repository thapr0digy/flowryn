import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NotifyPump, osascriptNotify } from "../../src/attention/notify.ts";
import { openItem } from "../../src/attention/items.ts";
import { parseConfig } from "../../src/config/config.ts";
import { DEFAULT_NOTIFY, notificationsOff, recordingNotifierPath } from "../../src/config/leader.ts";
import { tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { LATER_SECTION_DEFAULTS } from "../../src/init/init.ts";
import { makeHome, startDaemon, waitUntil, type DaemonProc, type TestHome } from "../helpers/harness.ts";
import { refusedOsascriptSpawns } from "../helpers/no-notifications.ts";

/**
 * Real macOS notifications are opt-in (your `flowryn init` writes them on;
 * the default is off), FLOWRYN_NOTIFY=off stops every channel while the
 * decisions are still recorded, and nothing in the test suite ever reaches
 * osascript: the preload refuses it in-process, and every harness daemon runs
 * with the override and a recording macOS channel.
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

describe("notifications are opt-in, and never real under test", () => {
  test("the macOS channel is off by default; only your own setup (flowryn init) turns it on", () => {
    expect(DEFAULT_NOTIFY.macos).toBe(false);
    expect((LATER_SECTION_DEFAULTS.notify as { macos: boolean }).macos).toBe(true);
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

  test("the pump delivers to macOS only when the config turns it on and no override stops it", async () => {
    const h = home();
    const db = h.db();
    try {
      const sent: string[] = [];
      const macos = async (title: string) => void sent.push(title);
      const pump = (text: string, off: boolean) =>
        new NotifyPump({ db, config: () => parseConfig(text, h.home), runtime: () => null, now: Date.now, log: () => {}, macos, off: () => off });
      openP0(db, "first");
      await pump("[notify]\nherdr = false", false).tick();
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
    "a daemon with macOS notifications on records them and delivers none under FLOWRYN_NOTIFY=off; cleared, only the recorder hears",
    async () => {
      const h = home("[notify]\nmacos = true\nherdr = false\np0_coalesce_s = 1");
      const recorded = join(h.home, "notified.jsonl");
      const db = h.db();
      openP0(db, "while off");
      db.close();
      const d = await startDaemon(h);
      daemons.push(d);
      await waitUntil(() => {
        const check = h.db();
        try {
          return (check.query("SELECT COUNT(*) AS n FROM notifications").get() as { n: number }).n === 1;
        } finally {
          check.close();
        }
      }, 10_000, "the P0's notification to be recorded");
      expect(existsSync(recorded)).toBe(false);
      await d.stop();
      daemons.splice(0);

      const again = h.db();
      openP0(again, "with the override cleared");
      again.close();
      daemons.push(await startDaemon(h, { FLOWRYN_NOTIFY: "" }));
      await waitUntil(() => existsSync(recorded) && readFileSync(recorded, "utf8").includes("a P0 needs you"), 10_000, "the recording notifier");
    },
    { timeout: 30_000 },
  );

  test("in this process, osascript is refused, and nothing has spawned it", async () => {
    await expect(osascriptNotify("title", "body")).rejects.toThrow("never runs osascript");
    // That refusal is counted too; the preload's afterAll fails a file with any, so take this one back out.
    const spawns = refusedOsascriptSpawns() as string[];
    expect(spawns.length).toBe(1);
    spawns.splice(0);
  });
});
