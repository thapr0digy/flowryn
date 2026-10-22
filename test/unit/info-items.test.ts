import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadCtx } from "../../src/api/verbs.ts";
import { composeBriefing } from "../../src/attention/briefing.ts";
import { closeSeenInfoItems, INFO_KEEP_MS, INFO_KEPT_REASON, LANE_TABLE, openItem, type ItemKind } from "../../src/attention/items.ts";
import { carry, confirmTurn } from "../../src/attention/presentations.ts";
import { parseConfig } from "../../src/config/config.ts";
import { DEFAULT_UPKEEP } from "../../src/config/upkeep.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { MIGRATIONS } from "../../src/db/schema.ts";
import { openContractRecorded, recordPass } from "../../src/contracts/verbs.ts";
import type { HarnessId } from "../../src/harness/types.ts";
import { LEADER_RUN_VERBS } from "../../src/lifecycle/leader-verbs.ts";
import { Upkeep } from "../../src/upkeep/upkeep.ts";

/**
 * The P1 lane means "needs attention" (docs/notes/2026-10-17-p1-lane-means-8v.md):
 * informational items never count in fleet's P1, a newer contract record
 * supersedes the older item, presented info items close after INFO_KEEP_MS,
 * and migration 28 closes the ones left open before.
 */

const NOW = new Date(2026, 9, 17, 12, 0, 0).getTime();
const HOUR = 3_600_000;

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-info-items-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function open(kind: ItemKind, line: string, at = NOW): string {
  return tx(db, () => openItem(db, { kind, eventSeq: appendEvent(db, { source: "cli", kind: "test.item" }).seq, line, now: at }));
}

function state(id: string): { state: string; resolved_by: string | null } {
  return db.query("SELECT state, resolved_by FROM items WHERE id = ?1").get(id) as { state: string; resolved_by: string | null };
}

/** A leader turn carries the item and ends at `at`: it is presented then. */
function present(id: string, at: number, turn = 1): void {
  tx(db, () => {
    carry(db, { itemId: id, session: "s1", turn, path: "digest", now: at });
    confirmTurn(db, "s1", turn, at);
  });
}

function fleetOpen(): string {
  const ctx: ReadCtx = { db, config: parseConfig("", "/tmp/fw-info-items"), now: NOW, caller: { role: "human", runId: null, taskId: null } };
  return LEADER_RUN_VERBS.find((v) => v.name === "fleet")!.read!(ctx, {}).data.open as string;
}

const INFO_KINDS = (Object.keys(LANE_TABLE) as ItemKind[]).filter((k) => LANE_TABLE[k].class === "info");

describe("the P1 count is what needs you", () => {
  test("fleet's P1 counts actionable items only, open or presented", () => {
    open("contract_recorded", "claude 2.1.300 passed, recorded automatically (build b1)");
    open("auto_resumed", "t1 resumed by itself");
    const pr = open("pr_ready", "t1 PR ready");
    present(pr, NOW);
    open("worker_question_blocking", "t2 asks");
    expect(fleetOpen()).toBe("P0 1 · P1 1");
  });

  test("assumption: the rule holds for every info kind in the lane table, not just contract_recorded and auto_resumed", () => {
    expect(INFO_KINDS).toEqual(expect.arrayContaining(["contract_recorded", "auto_resumed", "yolo_merged", "steer_acked"]));
    for (const kind of INFO_KINDS) open(kind, `${kind} line`);
    expect(fleetOpen()).toBe("P0 0 · P1 0");
  });

  test("fleet and the briefing agree: info items alone are nothing that needs you", () => {
    for (const kind of INFO_KINDS) open(kind, `${kind} line`);
    expect(fleetOpen()).toBe("P0 0 · P1 0");
    expect(composeBriefing(db, { session: null, now: NOW, morningHour: 99, ageMs: HOUR, markMorning: false }).text).toContain("Needs you: nothing");
  });
});

function record(harness: HarnessId, version: string, at: number): string {
  return tx(db, () => {
    const seq = recordPass(db, { harness, version, report: null, by: "daemon", build: "b1", session: null, source: "daemon", revision: 1, platform: null, herdr_version: null, launch_profile: null }, at);
    return openContractRecorded(db, harness, seq, `${harness} ${version} passed, recorded automatically (build b1)`, at);
  });
}

describe("a newer contract record supersedes the older item", () => {
  test("a newer claude record resolves the older claude item and opens its own", () => {
    const older = record("claude", "2.1.300", NOW - HOUR);
    const newer = record("claude", "2.1.301", NOW);
    expect(state(older)).toEqual({ state: "resolved", resolved_by: "superseded by claude 2.1.301" });
    expect(state(newer).state).toBe("open");
  });

  test("a presented item is superseded too", () => {
    const older = record("claude", "2.1.300", NOW - HOUR);
    present(older, NOW - HOUR);
    record("claude", "2.1.301", NOW);
    expect(state(older).state).toBe("resolved");
  });

  test("assumption: superseding is per harness, so a pi record leaves claude's item open", () => {
    const claude = record("claude", "2.1.300", NOW - HOUR);
    record("pi", "0.9.1", NOW);
    expect(state(claude).state).toBe("open");
  });
});

describe("presented info items close after the retention window", () => {
  test("an info item presented over INFO_KEEP_MS ago is resolved, with one items.info_closed event", () => {
    const info = open("auto_resumed", "t1 resumed by itself", NOW - 2 * INFO_KEEP_MS);
    present(info, NOW - INFO_KEEP_MS - 1);
    expect(closeSeenInfoItems(db, NOW)).toEqual([info]);
    expect(state(info)).toEqual({ state: "resolved", resolved_by: INFO_KEPT_REASON });
    const events = db.query("SELECT payload FROM events WHERE kind = 'items.info_closed'").all() as { payload: string }[];
    expect(events.map((e) => JSON.parse(e.payload))).toEqual([{ items: [info], keep_ms: INFO_KEEP_MS }]);
  });

  test("assumption: the window runs from the newest presentation, not from opening", () => {
    const info = open("contract_recorded", "claude 2.1.300 passed", NOW - 3 * INFO_KEEP_MS);
    present(info, NOW - 2 * INFO_KEEP_MS, 1);
    present(info, NOW - HOUR, 2);
    expect(closeSeenInfoItems(db, NOW)).toEqual([]);
    expect(state(info).state).toBe("presented");
  });

  test("within the window, or never presented, an info item stays", () => {
    const recent = open("auto_resumed", "recent", NOW - 2 * INFO_KEEP_MS);
    present(recent, NOW - INFO_KEEP_MS + 1);
    const unseen = open("phase_started", "unseen", NOW - 5 * INFO_KEEP_MS);
    expect(closeSeenInfoItems(db, NOW)).toEqual([]);
    expect(state(recent).state).toBe("presented");
    expect(state(unseen).state).toBe("open");
    expect(db.query("SELECT 1 FROM events WHERE kind = 'items.info_closed'").get()).toBeNull();
  });

  test("actionable P1s are untouched, however long ago they were presented", () => {
    const pr = open("pr_ready", "t1 PR ready", NOW - 5 * INFO_KEEP_MS);
    present(pr, NOW - 4 * INFO_KEEP_MS);
    const question = open("worker_question", "t1 asks", NOW - 5 * INFO_KEEP_MS);
    expect(closeSeenInfoItems(db, NOW)).toEqual([]);
    expect(state(pr).state).toBe("presented");
    expect(state(question).state).toBe("open");
  });

  test("the upkeep pass closes them, even while it otherwise waits", async () => {
    const info = open("steer_acked", "t1 acked", NOW - 2 * INFO_KEEP_MS);
    present(info, NOW - 2 * INFO_KEEP_MS);
    const logs: string[] = [];
    const upkeep = new Upkeep({
      db,
      config: () => ({ ...DEFAULT_UPKEEP, build_after_merge: false, sync_primary: false, clean_ended_hours: 0 }),
      now: () => NOW,
      log: (m) => logs.push(m),
      git: async () => ({ code: 0, stdout: "", stderr: "" }),
      projects: () => [],
      builder: { pass: async () => ({ outcome: "skipped", reason: "off" }) as never },
      busy: () => "a restart is asked for or under way",
      sweep: async () => ({ outcome: "kept", reason: "-", task: "-" }),
    });
    const report = await upkeep.pass();
    expect(report.waited).toBe("a restart is asked for or under way");
    expect(report.infoClosed).toEqual([info]);
    expect(state(info).state).toBe("resolved");
    expect(logs).toContain("upkeep: closed 1 informational items presented over 24 h ago");
  });
});

describe("migration 28", () => {
  test("closes stale info items, keeps the newest contract item per harness keyed, and leaves actionable ones", () => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), "fw-info-items-"));
    db = openDb(join(dir, "flowryn.db"));
    migrate(db, MIGRATIONS.slice(0, 27));
    const now = Date.now();
    const old = now - 9 * 86_400_000;
    // Before migration 28 contract_recorded items had no key (task_id NULL).
    const claudeOld = open("contract_recorded", "claude 2.1.300 passed, recorded automatically (build b1)", old);
    const claudeNew = open("contract_recorded", "claude 2.1.301 passed, recorded automatically (build b2)", now - HOUR);
    const piOnly = open("contract_recorded", "pi 0.9.1 passed, recorded by the leader (build b2)", now - 2 * HOUR);
    const staleResume = open("auto_resumed", "t1 resumed by itself", old);
    present(staleResume, old);
    const freshResume = open("auto_resumed", "t2 resumed by itself", now - HOUR);
    const pr = open("pr_ready", "t1 PR ready", old);
    expect(migrate(db)).toEqual([28]);
    expect(state(claudeOld)).toEqual({ state: "resolved", resolved_by: "superseded by a newer contract record" });
    expect(state(staleResume).state).toBe("resolved");
    expect(state(claudeNew).state).toBe("open");
    expect(state(piOnly).state).toBe("open");
    expect(state(freshResume).state).toBe("open");
    expect(state(pr).state).toBe("open");
    const keys = db.query("SELECT id, task_id FROM items WHERE kind = 'contract_recorded' AND state = 'open' ORDER BY id").all();
    expect(keys).toEqual([
      { id: claudeNew, task_id: "harness:claude" },
      { id: piOnly, task_id: "harness:pi" },
    ]);
    // The key it backfilled is the one the next record supersedes.
    record("claude", "2.1.302", now);
    expect(state(claudeNew).state).toBe("resolved");
  });
});
