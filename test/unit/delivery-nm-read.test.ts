import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import type { Forge } from "../../src/forge/types.ts";
import { DeliveryWatcher, VALIDATION_READ_MIN_GAP_MS } from "../../src/watch/delivery.ts";

let dir: string;
let db: Db;
let calls: string;
let noMistakes: string;
let now: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-nm-read-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  calls = join(dir, "calls");
  writeFileSync(calls, "");
  noMistakes = join(dir, "no-mistakes");
  // Each status read logs its worktree, then answers after a short delay, as a real read takes a moment.
  writeFileSync(noMistakes, `#!/bin/sh\necho "$PWD" >> "${calls}"\nsleep 0.2\necho "run: null"\n`);
  chmodSync(noMistakes, 0o755);
  now = 1_000_000;
  const created = Date.now();
  tx(db, () => {
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('p', 'u', '/p', 'main', 'no-mistakes')").run();
    for (const [task, run] of [
      ["t1", "r1"],
      ["t2", "r2"],
    ] as const) {
      const worktree = join(dir, run);
      mkdirSync(worktree);
      db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES (?1, 'p', 'ship', 'no-mistakes', 0, 'fix', ?2)").run(task, created);
      db.query(
        `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
         VALUES (?1, ?2, 'claude', 'v', 'running', 'busy', 'fix', 'ship', ?3, 'b', 's', ?1, ?4, ?4)`,
      ).run(run, task, worktree, created);
    }
    db.query("INSERT INTO pool_leases (pool, run_id, stage, granted_at) VALUES ('validation', 'r1', 'ship', ?1)").run(created);
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function watcher(): DeliveryWatcher {
  return new DeliveryWatcher({
    db,
    forge: () => ({}) as Forge,
    webUrl: () => "https://github.com",
    git: async () => ({ code: 0, stdout: "", stderr: "" }),
    noMistakes: () => noMistakes,
    nmTimeoutMs: () => 5_000,
    pollMs: () => 60_000,
    inFlight: new Set(),
    cleanup: () => {},
    log: () => {},
    now: () => now,
    nudgeConflicts: () => false,
    kickScheduler: () => {},
  });
}

function readWorktrees(): string[] {
  return readFileSync(calls, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(line.lastIndexOf("/") + 1));
}

describe("the restart guard's no-mistakes read", () => {
  test("reads only the runs holding a validation slot", async () => {
    await watcher().readValidations();
    expect(readWorktrees()).toEqual(["r1"]);
  });

  test("concurrent asks share one read in progress", async () => {
    const w = watcher();
    await Promise.all([w.readValidations(), w.readValidations(), w.readValidations()]);
    expect(readWorktrees()).toEqual(["r1"]);
  });

  test("an ask soon after a read is skipped; once the gap has passed it reads again", async () => {
    const w = watcher();
    await w.readValidations();
    now += VALIDATION_READ_MIN_GAP_MS - 1;
    await w.readValidations();
    expect(readWorktrees()).toEqual(["r1"]);
    now += 1;
    await w.readValidations();
    expect(readWorktrees()).toEqual(["r1", "r1"]);
  });

  test("the poll's read counts: an ask right after it is skipped", async () => {
    const w = watcher();
    await w.pass();
    expect(readWorktrees().toSorted()).toEqual(["r1", "r2"]);
    await w.readValidations();
    expect(readWorktrees()).toHaveLength(2);
  });
});
