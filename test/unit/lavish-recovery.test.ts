import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { lavishLines } from "../../src/attention/briefing.ts";
import { isServerError, LavishDoctor, PROBE_PAGE, RESTART_WINDOW_MS, type RestartablePoller } from "../../src/lavish/recovery.ts";
import { makeHome, type TestHome } from "../helpers/harness.ts";

/**
 * Recovering a broken Lavish server (docs/notes/2026-11-08-recover-a-broken-7e.md): the doctor's
 * probe, restart, rate limit and give-up, against a scripted lavish-axi that answers a server
 * error while `<home>/broken` exists and whose `stop` removes it (or fails while `<home>/stop-fail`
 * exists, or leaves the breakage while `<home>/stop-no-cure` exists).
 */

const SERVER_ERROR_OUT = 'error: "Lavish Editor request failed: 500"\ncode: SERVER_ERROR\n';
const NOW = Date.UTC(2026, 10, 8, 7, 0, 0);

let h: TestHome;
let db: Db;
let bin: string;
let clock = NOW;

function calls(): string[] {
  const log = join(h.home, "calls.log");
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
}

function stops(): number {
  return calls().filter((c) => c === "stop").length;
}

function kinds(): string[] {
  return (db.query("SELECT kind FROM events WHERE kind LIKE 'lavish.%' ORDER BY seq").all() as { kind: string }[]).map((e) => e.kind);
}

function brokenItems(): { id: string; lane: string; class: string; state: string; line: string }[] {
  return db.query("SELECT id, lane, class, state, line FROM items WHERE kind = 'lavish_broken' ORDER BY id").all() as ReturnType<typeof brokenItems>;
}

function breakServer(): void {
  writeFileSync(join(h.home, "broken"), "");
}

class FakePoller implements RestartablePoller {
  log: string[] = [];
  failed: string[] = [];
  pauseForRestart(): void {
    this.log.push("pause");
  }
  async resumeAfterRestart(): Promise<{ hosted: string[]; failed: string[] }> {
    this.log.push("resume");
    return { hosted: ["g1", "g2"], failed: this.failed };
  }
}

function doctor(poller: RestartablePoller = new FakePoller()): LavishDoctor {
  return new LavishDoctor({ db, lavish: () => bin, stateDir: h.stateDir, poller, log: () => {}, now: () => clock });
}

beforeEach(() => {
  h = makeHome();
  db = h.db();
  clock = NOW;
  const home = JSON.stringify(h.home);
  bin = join(h.home, "scripted-lavish");
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$*" >> ${home}/calls.log
if [ "$1" = "stop" ]; then
  [ -e ${home}/stop-fail ] && { echo "error: cannot stop" >&2; exit 1; }
  [ -e ${home}/stop-no-cure ] || rm -f ${home}/broken
  exit 0
fi
if [ -e ${home}/broken ]; then printf '${SERVER_ERROR_OUT.replaceAll("\n", "\\n")}'; exit 1; fi
real="$(cd "$(dirname "$1")" && pwd -P)/$(basename "$1")"
key=$(printf %s "$real" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-16)
printf 'session:\\n  url: http://127.0.0.1:4387/session/%s\\n' "$key"
`,
  );
  chmodSync(bin, 0o755);
});

afterEach(() => {
  h.cleanup();
});

describe("isServerError", () => {
  test("a 500 and a server that cannot be reached are server errors", () => {
    expect(isServerError(1, SERVER_ERROR_OUT, "")).toBe(true);
    expect(isServerError(1, "error: Lavish Editor server connection failed\ncode: SERVER_ERROR\n", "")).toBe(true);
    expect(isServerError(1, "", "code: SERVER_ERROR")).toBe(true);
  });

  test("a missing session, a timeout, a spawn failure and success are not", () => {
    expect(isServerError(1, "error: no session\ncode: NOT_FOUND\n", "")).toBe(false);
    expect(isServerError(124, SERVER_ERROR_OUT, "")).toBe(false);
    expect(isServerError(125, SERVER_ERROR_OUT, "")).toBe(false);
    expect(isServerError(-1, SERVER_ERROR_OUT, "")).toBe(false);
    expect(isServerError(0, SERVER_ERROR_OUT, "")).toBe(false);
    expect(isServerError(1, "the text mentions SERVER_ERROR in passing", "")).toBe(false);
  });
});

describe("LavishDoctor", () => {
  test("a server whose probe page hosts is a blip: no restart", async () => {
    const poller = new FakePoller();
    expect(await doctor(poller).check("poll failed twice", "daemon")).toEqual({ state: "ok" });
    expect(stops()).toBe(0);
    expect(poller.log).toEqual([]);
    expect(kinds()).toEqual(["lavish.probe_ok"]);
  });

  test("the probe page is Flowryn's own, in its state dir, with no task content", async () => {
    await doctor().check("x", "daemon");
    const probe = join(h.stateDir, "lavish-probe", "probe.html");
    expect(readFileSync(probe, "utf8")).toBe(PROBE_PAGE);
    expect(calls()[0]).toContain("lavish-probe/probe.html --no-open");
  });

  test("a broken server is stopped once, the poller paused then resumed, and the restart recorded", async () => {
    breakServer();
    const poller = new FakePoller();
    const outcome = await doctor(poller).check("poll of gate g1 failed twice", "daemon");
    expect(outcome).toEqual({ state: "restarted", pages: 2, failed: [] });
    expect(stops()).toBe(1);
    expect(poller.log).toEqual(["pause", "resume"]);
    expect(kinds()).toEqual(["lavish.broken", "lavish.restarted"]);
    const payload = JSON.parse((db.query("SELECT payload FROM events WHERE kind = 'lavish.restarted'").get() as { payload: string }).payload);
    expect(payload).toEqual({ reason: "poll of gate g1 failed twice", by: "daemon", pages: 2, failed: [], ok: true });
    expect(brokenItems()).toEqual([]);
  });

  test("a re-host that fails after the restart is recorded on the restart", async () => {
    breakServer();
    const poller = new FakePoller();
    poller.failed = ["g3"];
    const outcome = await doctor(poller).check("x", "daemon");
    expect(outcome).toMatchObject({ state: "restarted", failed: ["g3"] });
    const payload = JSON.parse((db.query("SELECT payload FROM events WHERE kind = 'lavish.restarted'").get() as { payload: string }).payload);
    expect(payload.failed).toEqual(["g3"]);
  });

  test("rate limit: a second breakage within ten minutes gives up with one P1 and no second stop", async () => {
    const d = doctor();
    breakServer();
    await d.check("first", "daemon");
    clock += 5 * 60_000;
    breakServer();
    const outcome = await d.check("second", "worker:r1");
    expect(outcome.state).toBe("gave_up");
    expect(stops()).toBe(1);
    const items = brokenItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ lane: "P1", class: "actionable", state: "open", id: outcome.item });
    expect(items[0]!.line).toStartWith("Lavish keeps failing (it broke again within 10 minutes of the restart at ");
    expect(kinds()).toEqual(["lavish.broken", "lavish.restarted", "lavish.broken", "lavish.gave_up"]);
    // After a give-up: no probe, no restart, the same item.
    const before = calls().length;
    expect(await d.check("third", "worker:r1")).toMatchObject({ state: "gave_up", item: outcome.item });
    expect(calls().length).toBe(before);
  });

  test("rate limit: the window is read from the events, so a new daemon keeps it", async () => {
    breakServer();
    await doctor().check("first", "daemon");
    clock += RESTART_WINDOW_MS - 1;
    breakServer();
    expect((await doctor().check("after a daemon restart", "daemon")).state).toBe("gave_up");
    expect(stops()).toBe(1);
  });

  test("rate limit: past the window a new breakage restarts again", async () => {
    breakServer();
    await doctor().check("first", "daemon");
    clock += RESTART_WINDOW_MS + 1;
    breakServer();
    expect((await doctor().check("later", "daemon")).state).toBe("restarted");
    expect(stops()).toBe(2);
  });

  test("a stop that fails gives up, records why, and resumes the polls", async () => {
    breakServer();
    writeFileSync(join(h.home, "stop-fail"), "");
    const poller = new FakePoller();
    const outcome = await doctor(poller).check("x", "daemon");
    expect(outcome.state).toBe("gave_up");
    expect(outcome.detail).toContain("lavish-axi stop exited 1: error: cannot stop");
    expect(poller.log).toEqual(["pause", "resume"]);
    expect(kinds()).toEqual(["lavish.broken", "lavish.stop_failed", "lavish.gave_up"]);
    expect(brokenItems()).toHaveLength(1);
  });

  test("a server still failing after the restart gives up; the restart still counts", async () => {
    breakServer();
    writeFileSync(join(h.home, "stop-no-cure"), "");
    const outcome = await doctor().check("x", "daemon");
    expect(outcome.state).toBe("gave_up");
    expect(outcome.detail).toStartWith("still failing after the restart:");
    expect(kinds()).toEqual(["lavish.broken", "lavish.restarted", "lavish.gave_up"]);
    const payload = JSON.parse((db.query("SELECT payload FROM events WHERE kind = 'lavish.restarted'").get() as { payload: string }).payload);
    expect(payload.ok).toBe(false);
  });

  test("concurrent checks share one probe and one stop", async () => {
    breakServer();
    const d = doctor();
    const [a, b, c] = await Promise.all([d.check("a", "daemon"), d.check("b", "worker:r1"), d.check("c", "worker:r2")]);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a.state).toBe("restarted");
    expect(stops()).toBe(1);
  });

  test("Lavish answering again resolves the give-up item, and restarts are allowed once the window passes", async () => {
    const d = doctor();
    breakServer();
    await d.check("first", "daemon");
    breakServer();
    await d.check("second", "daemon");
    expect(brokenItems()[0]!.state).toBe("open");
    d.noteHealthy();
    expect(brokenItems()[0]!.state).toBe("resolved");
    expect(kinds().at(-1)).toBe("lavish.healthy");
    // Healthy with nothing open: nothing written.
    d.noteHealthy();
    expect(kinds().filter((k) => k === "lavish.healthy")).toHaveLength(1);
  });

  test("no lavish-axi: off, nothing runs", async () => {
    const d = new LavishDoctor({ db, lavish: () => null, stateDir: h.stateDir, poller: new FakePoller(), log: () => {}, now: () => clock });
    expect(await d.check("x", "daemon")).toEqual({ state: "off" });
    expect(calls()).toEqual([]);
  });

  test("a stopped doctor refuses a check", async () => {
    const d = doctor();
    d.stop();
    await expect(d.check("x", "daemon")).rejects.toThrow(/stopping/);
  });
});

describe("the briefing's Lavish lines", () => {
  test("each restart and give-up since the last briefing is shown; a scoped leader does not see why", () => {
    tx(db, () => {
      appendEvent(db, { source: "daemon", kind: "lavish.restarted", payload: { reason: "the poll of gate g12 failed twice", by: "daemon", pages: 3, failed: [], ok: true }, ts: NOW });
      appendEvent(db, { source: "daemon", kind: "lavish.restarted", payload: { reason: "a worker hit a server error", by: "worker:r1", pages: 1, failed: ["g2"], ok: true }, ts: NOW + 60_000 });
      appendEvent(db, { source: "daemon", kind: "lavish.gave_up", payload: { reason: "x", by: "daemon", detail: "lavish-axi stop exited 1" }, ts: NOW + 120_000 });
    });
    const open = { restricted: false } as Parameters<typeof lavishLines>[1];
    const lines = lavishLines(db, open);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^Lavish restarted \d\d:\d\d automatically \(the poll of gate g12 failed twice\): 3 review pages hosted again\.$/);
    expect(lines[1]).toMatch(/for a worker \(a worker hit a server error\): 1 review page hosted again, 1 failed to host\.$/);
    expect(lines[2]).toMatch(/^Lavish recovery gave up \d\d:\d\d: lavish-axi stop exited 1; see the lavish_broken item\.$/);
    const scoped = lavishLines(db, { restricted: true } as Parameters<typeof lavishLines>[1]);
    expect(scoped[0]).not.toContain("g12");
  });

  test("a restart already briefed is not shown again", () => {
    tx(db, () => appendEvent(db, { source: "daemon", kind: "lavish.restarted", payload: { reason: "x", by: "daemon", pages: 0, failed: [], ok: true }, ts: NOW }));
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_briefing_at', ?1)").run(String(NOW + 1));
    expect(lavishLines(db, { restricted: false } as Parameters<typeof lavishLines>[1])).toEqual([]);
  });
});
