import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../../src/config/config.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import type { HostVerdict } from "../../src/sched/host.ts";
import { Scheduler } from "../../src/sched/scheduler.ts";
import { insertRequest } from "../../src/verify/queue.ts";

/**
 * The scheduler's capacity P1 (design section 16) counts a queued verify as
 * waiting work (docs/notes/2026-11-06-no-silent-waits-vj.md): the oldest
 * queued request's age is in the alert, and a verify the wait registry has
 * already itemized does not open a second P1.
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

async function pass(): Promise<void> {
  const config = parseConfig(`[tools]\nclaude = "/bin/true"\n`, HOME);
  const now = () => NOW;
  const s = new Scheduler({
    db,
    config: () => config,
    now,
    log: () => {},
    launch: () => {},
    isLaunching: () => false,
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

function queue(requestedAt: number): string {
  return tx(db, () => insertRequest(db, { project_id: "web", pr_url: "local:b", task_id: "t1", head_sha: "a".repeat(40), policy_id: "p", pr_number: null, head_ref: null, worktree: null, source: "auto", path: null, now: requestedAt })).id;
}

const alerts = () => db.query("SELECT line, state FROM items WHERE kind = 'capacity_wait'").all() as { line: string; state: string }[];

test("a verify queued over wait_alert_ms opens the capacity P1 with its age, and it closes once nothing waits that long", async () => {
  queue(NOW - 10 * 60_000);
  await pass();
  expect(alerts()).toEqual([]);
  tx(db, () => db.query("UPDATE verify_queue SET requested_at = ?1").run(NOW - 31 * 60_000));
  await pass();
  const [alert] = alerts();
  expect(alert!.line).toContain("oldest queued verify vq1 (t1) 31m");
  expect(alert!.line).toEndWith("flowryn capacity");
  tx(db, () => db.query("UPDATE verify_queue SET state = 'cancelled', ended_at = ?1").run(NOW));
  await pass();
  expect(alerts()).toEqual([{ line: alert!.line, state: "resolved" }]);
});

test("a queued verify the wait registry already itemized opens no second P1", async () => {
  const id = queue(NOW - 31 * 60_000);
  tx(db, () => db.query("INSERT INTO waits (key, kind, task_id, run_id, since, due, recovered_at, item_id, updated_at) VALUES (?1, 'verify_queue', 't1', NULL, 0, 0, 0, 'i1', 0)").run(`verify:${id}`));
  await pass();
  expect(alerts()).toEqual([]);
});
