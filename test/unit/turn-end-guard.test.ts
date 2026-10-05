import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TIMING } from "../../src/config/workers.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { TURN_END_REMINDER } from "../../src/harness/contract-text.ts";
import { openBlockedPrompt } from "../../src/lifecycle/prompt-wedge.ts";
import { getRun } from "../../src/lifecycle/runs.ts";
import { createSteer, markRung } from "../../src/lifecycle/steers.ts";
import { guardTurnEnd, instructionAt, OUTCOME_KINDS, reminderIgnored, REMINDER_KIND, RESULT_KIND, type TurnEnd } from "../../src/lifecycle/turn-end-guard.ts";

/**
 * The turn-end guard's rules (autonomy spec 2, ship A): one reminder per
 * episode, only for a turn that ended with no outcome since the last
 * instruction and nothing it waits on; each reminder settled as obeyed or
 * ignored at the next turn end.
 */

let dir: string;
let db: Db;
let clock: number;

const turn = (over: Partial<TurnEnd> = {}): TurnEnd => ({ harness: "claude", stopHookActive: false, continuationsUsed: 0, maxContinuations: 2, steerDue: false, ...over });

function run() {
  return getRun(db, "r1")!;
}

function stop(over: Partial<TurnEnd> = {}): string | null {
  clock += 10;
  return tx(db, () => guardTurnEnd(db, run(), turn(over), clock));
}

function event(kind: string, payload: Record<string, unknown> = {}): void {
  clock += 10;
  tx(db, () => appendEvent(db, { source: "cli", kind, runId: "r1", taskId: "t1", payload, ts: clock }));
}

function results(): { obeyed: boolean; outcome: string | null }[] {
  return (db.query("SELECT payload FROM events WHERE kind = ?1 ORDER BY seq").all(RESULT_KIND) as { payload: string }[]).map((e) => JSON.parse(e.payload));
}

function reminders(): number {
  return (db.query("SELECT COUNT(*) AS n FROM events WHERE kind = ?1").get(REMINDER_KIND) as { n: number }).n;
}

function update(sql: string, ...params: (string | number | null)[]): void {
  tx(db, () => db.query(sql).run(...params));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-guard-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  clock = 1_000_000;
  tx(db, () => {
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('p', '', '/p', 'main', 'local-only')").run();
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES ('t1', 'p', 'ship', 'local-only', 0, 'fix', 0)").run();
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at, pane_id, worker_started_at)
       VALUES ('r1', 't1', 'claude', 'v', 'running', 'busy', 'fix', 'build', '/w', 'b', 's', 'h', ?1, ?1, 'w1:p1', ?1)`,
    ).run(clock);
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the turn-end guard", () => {
  test("an outcome-less turn end gets the fixed reminder once; the second is silent and settles it ignored", () => {
    expect(stop()).toBe(TURN_END_REMINDER);
    expect(stop({ continuationsUsed: 1 })).toBeNull();
    expect(stop()).toBeNull();
    expect(reminders()).toBe(1);
    expect(results()).toMatchObject([{ obeyed: false, outcome: null }]);
    expect(reminderIgnored(db, run())).toBe(true);
  });

  for (const kind of OUTCOME_KINDS) {
    test(`an outcome recorded since the last instruction (${kind}) earns no reminder`, () => {
      event(kind);
      expect(stop()).toBeNull();
      expect(reminders()).toBe(0);
    });
  }

  test("report progress counts as an outcome, and obeys a reminder", () => {
    expect(stop()).toBe(TURN_END_REMINDER);
    event("worker.report", { status: "progress" });
    expect(stop({ continuationsUsed: 1 })).toBeNull();
    expect(results()).toMatchObject([{ obeyed: true, outcome: "worker.report" }]);
    expect(reminderIgnored(db, run())).toBe(false);
  });

  test("an outcome before the last instruction does not count: a steer carried since starts a new episode", () => {
    event("stage.done");
    clock += 10;
    tx(db, () => {
      const steer = createSteer(db, run(), "now write the docs", clock);
      markRung(db, steer, run(), "waiter", clock, true, DEFAULT_TIMING);
    });
    expect(instructionAt(db, run())).toBe(clock);
    expect(stop()).toBe(TURN_END_REMINDER);
  });

  test("a new episode (a stage started) earns a new reminder, and the idle pointer forgets the old ignored one", () => {
    expect(stop()).toBe(TURN_END_REMINDER);
    expect(stop()).toBeNull();
    expect(reminderIgnored(db, run())).toBe(true);
    clock += 10;
    update("UPDATE runs SET stage_started_at = ?2 WHERE id = ?1", "r1", clock);
    expect(reminderIgnored(db, run())).toBe(false);
    expect(stop()).toBe(TURN_END_REMINDER);
    expect(reminders()).toBe(2);
  });

  test("a due steer wins: no reminder, and the episode keeps its one", () => {
    expect(stop({ steerDue: true })).toBeNull();
    expect(stop()).toBe(TURN_END_REMINDER);
  });

  test("never past the continuation cap a steer already used up", () => {
    expect(stop({ continuationsUsed: 2 })).toBeNull();
    expect(stop({ continuationsUsed: 1 })).toBe(TURN_END_REMINDER);
  });

  test("assumption A1: stop_hook_active (true on a waiter-woken turn, spike c14) does not suppress it, and is recorded", () => {
    expect(stop({ stopHookActive: true })).toBe(TURN_END_REMINDER);
    const payload = JSON.parse((db.query("SELECT payload FROM events WHERE kind = ?1").get(REMINDER_KIND) as { payload: string }).payload);
    expect(payload.stop_hook_active).toBe(true);
  });

  const waits: [string, () => void][] = [
    ["a stage waiting on a grant", () => update("UPDATE runs SET stage_state = 'waiting' WHERE id = ?1", "r1")],
    ["a review gate", () => update("UPDATE runs SET stage_state = 'review' WHERE id = ?1", "r1")],
    ["a delivered stage", () => update("UPDATE runs SET stage_state = 'done' WHERE id = ?1", "r1")],
    ["a pending launch", () => update("UPDATE runs SET pending_launch = 'stage' WHERE id = ?1", "r1")],
    ["a run past running", () => update("UPDATE runs SET state = 'validating' WHERE id = ?1", "r1")],
    ["an open question of its own", () => update("INSERT INTO decisions (id, task_id, run_id, question, options, blocking, state) VALUES ('q1', 't1', 'r1', '?', '[]', 0, 'open')")],
    ["an open blocked_prompt", () => tx(db, () => openBlockedPrompt(db, run(), { suspected: false, screen: "Do you want to proceed?", harness: "claude", lastHook: clock }, clock))],
  ];
  for (const [name, setUp] of waits) {
    test(`a worker waiting on ${name} gets none`, () => {
      setUp();
      expect(stop()).toBeNull();
      expect(reminders()).toBe(0);
    });
  }

  test("a wait that began after the reminder obeys it", () => {
    expect(stop()).toBe(TURN_END_REMINDER);
    update("UPDATE runs SET stage_state = 'waiting' WHERE id = ?1", "r1");
    expect(stop({ continuationsUsed: 1 })).toBeNull();
    expect(results()).toMatchObject([{ obeyed: true, outcome: "stage waiting" }]);
  });
});
