import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../../src/config/config.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import type { HostVerdict } from "../../src/sched/host.ts";
import { Scheduler } from "../../src/sched/scheduler.ts";
import { insertRequest } from "../../src/verify/queue.ts";

/**
 * The scheduler's capacity P1 (design section 16) is opened by runs waiting
 * for a grant over wait_alert_ms and names the oldest queued verify, in the
 * queue's own order, with its age (docs/notes/2026-11-06-no-silent-waits-vj.md).
 * A queued verify alone never opens it, and a run whose own registry wait is
 * itemized (or still covered by an open item) is not counted twice.
 */

const HOME = "/tmp/fw-capacity-alert";
const NOW = 100 * 60_000;
let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-calert-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  tx(db, () => db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', '', ?1, 'main', 'local-only')").run(join(dir, "web")));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** One scheduler pass in which no run is granted (each reads as launching), so its waits stay as seeded. */
async function pass(): Promise<void> {
  const config = parseConfig(`[tools]\nclaude = "/bin/true"\n`, HOME);
  const now = () => NOW;
  const s = new Scheduler({
    db,
    config: () => config,
    now,
    log: () => {},
    launch: () => {},
    isLaunching: () => true,
    exitWorker: async () => ({ ok: true }),
    notify: () => {},
    startDeps: { db, config: () => config, runtime: () => null, harnessVersion: async () => "1", git: async () => null, signIn: async () => null, now },
    kickJournal: () => {},
    host: async () => ({ ok: true, reason: "test" }) as HostVerdict,
    quota: async () => ({ state: "known", percent: 80, window: "five_hour", resets_at: null }),
  });
  await s.passNow();
  await s.stop();
}

function queue(requestedAt: number, rank = 0): string {
  return tx(db, () => insertRequest(db, { project_id: "web", pr_url: "local:b", task_id: "t1", head_sha: "a".repeat(40), policy_id: "p", pr_number: null, head_ref: null, worktree: null, source: "auto", path: null, rank, now: requestedAt })).id;
}

function seedRun(id: string, task: string, waitingSince: number): void {
  tx(db, () => {
    db.query("INSERT OR IGNORE INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, sensitive, workflow, auto, created_at) VALUES (?1, 'web', 'ship', 'local-only', 0, 0, 'fix', 0, 0)").run(task);
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, stage_state, worktree_path, branch, base_sha, token_hash, started_at, updated_at, waiting_since)
       VALUES (?1, ?2, 'claude', '1', 'running', 'idle', 'fix', 'build', 'waiting', '/tmp/wt', 'flowryn/x', 'abc', 'x', 0, 0, ?3)`,
    ).run(id, task, waitingSince);
  });
}

function waitRow(key: string, itemId: string): void {
  tx(db, () => db.query("INSERT INTO waits (key, kind, task_id, run_id, since, due, recovered_at, item_id, updated_at) VALUES (?1, 'capacity', NULL, 'r1', 0, 0, 0, ?2, 0)").run(key, itemId));
}

function openItemRow(id: string, state = "open"): void {
  tx(db, () => {
    const event = appendEvent(db, { source: "daemon", kind: "sched.usage_limit", payload: {}, ts: 0 });
    db.query("INSERT INTO items (id, event_seq, class, lane, kind, line, opened_at, state) VALUES (?1, ?2, 'actionable', 'P1', 'usage_limit', 'usage limit', 0, ?3)").run(id, event.seq, state);
  });
}

const alerts = () => db.query("SELECT line, state FROM items WHERE kind = 'capacity_wait'").all() as { line: string; state: string }[];

test("a queued verify alone opens no capacity P1, however long it has waited", async () => {
  const id = queue(NOW - 90 * 60_000);
  await pass();
  expect(db.query("SELECT state FROM verify_queue WHERE id = ?1").get(id)).toEqual({ state: "queued" });
  expect(alerts()).toEqual([]);
});

test("runs waiting over wait_alert_ms open the P1 naming the oldest queued verify in queue order with its age, and it closes once nothing waits that long", async () => {
  queue(NOW - 40 * 60_000);
  const first = queue(NOW - 5 * 60_000, -1);
  seedRun("r1", "t1", NOW - 10 * 60_000);
  await pass();
  expect(alerts()).toEqual([]);
  tx(db, () => db.query("UPDATE runs SET waiting_since = ?1").run(NOW - 31 * 60_000));
  await pass();
  const [alert] = alerts();
  expect(alert!.line).toStartWith("1 run(s) waiting over 30m for capacity");
  expect(alert!.line).toContain(`oldest queued verify ${first} (t1) 5m`);
  expect(alert!.line).toEndWith("flowryn capacity");
  tx(db, () => db.query("UPDATE runs SET stage_state = 'active', waiting_since = NULL").run());
  await pass();
  expect(alerts()).toEqual([{ line: alert!.line, state: "resolved" }]);
});

test("a run whose own registry wait is itemized, or covered by an item still open, opens no second P1", async () => {
  seedRun("r1", "t1", NOW - 31 * 60_000);
  waitRow("run:r1", "i1");
  await pass();
  expect(alerts()).toEqual([]);
  tx(db, () => db.query("DELETE FROM waits").run());
  openItemRow("i9");
  waitRow("run:r1", "covered:i9");
  await pass();
  expect(alerts()).toEqual([]);
});

test("a run counts as waiting once its cover closes, or when only another key with its run id is itemized", async () => {
  seedRun("r1", "t1", NOW - 31 * 60_000);
  openItemRow("i9", "resolved");
  waitRow("run:r1", "covered:i9");
  await pass();
  expect(alerts()).toHaveLength(1);
  tx(db, () => db.query("DELETE FROM items").run());
  tx(db, () => db.query("DELETE FROM waits").run());
  waitRow("auto_merge:am1", "i1");
  await pass();
  expect(alerts()).toHaveLength(1);
});
