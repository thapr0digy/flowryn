import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RELAY_KINDS, type ItemRow } from "../../src/attention/items.ts";
import { DEFAULT_SCHED } from "../../src/config/workflows.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { getRunWithPolicy } from "../../src/lifecycle/runs.ts";
import { oldestStep, parseNmStatus, quietSeconds } from "../../src/policy/nomistakes.ts";
import { applyNmObservation } from "../../src/reconcile/delivery.ts";
import { releaseLeases } from "../../src/sched/pools.ts";

/**
 * A validation slot held with no progress (task stuck-validations-become-y6):
 * the quiet-step reading of a no-mistakes status, and the one-item-per-episode
 * rule over the rows the delivery watcher's reads leave.
 */

let dir: string;
let db: Db;
let now: number;

const MIN = 60_000;
const STUCK_MS = DEFAULT_SCHED.validation_stuck_ms;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-vstuck-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  now = Date.now();
  tx(db, () => {
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('p', 'u', '/p', 'main', 'no-mistakes')").run();
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES ('t1', 'p', 'ship', 'no-mistakes', 0, 'fix', ?1)").run(now);
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, stage_state, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
       VALUES ('r1', 't1', 'claude', 'v', 'running', 'busy', 'fix', 'ship', 'active', '/w', 'b', 's', 'r1', ?1, ?1)`,
    ).run(now);
    db.query("INSERT INTO pool_leases (pool, run_id, stage, granted_at) VALUES ('validation', 'r1', 'ship', ?1)").run(now);
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** `axi status` with one active step, in the v1.53.0 shape. */
function running(step: string, activeFor: string, lastActivity: string, branch = "b"): string {
  return [
    "run:",
    '  id: "01NM"',
    `  branch: ${branch}`,
    "  status: running",
    "  head: abc",
    "  active_steps[1]{step,status,active_for,last_activity,agent_pid,round}:",
    `    ${step},running,${activeFor},"${lastActivity}",81234,1`,
    "",
  ].join("\n");
}

const ENDED = 'run:\n  id: "01NM"\n  branch: b\n  status: completed\n  head: abc\n  pr: ""\noutcome: passed\n';

function observe(text: string | null, at = now): void {
  tx(db, () => applyNmObservation(db, getRunWithPolicy(db, "r1")!, text === null ? null : parseNmStatus(text), STUCK_MS, at));
}

function stuckItems(): ItemRow[] {
  return db.query("SELECT * FROM items WHERE kind = 'validation_stuck' ORDER BY opened_at, rowid").all() as ItemRow[];
}

function episodeEvents(): string[] {
  return (db.query("SELECT kind FROM events WHERE kind IN ('run.validation_stuck','run.validation_moving') ORDER BY seq").all() as { kind: string }[]).map((e) => e.kind);
}

describe("how long a no-mistakes step has been quiet", () => {
  test("assumption: last_activity reads '<duration> ago: ...', as v1.53.0 prints it", () => {
    const real = parseNmStatus(running("review", "42m", "9m24s ago: agent: reading src/a.ts, src/b.ts"))!.activeSteps![0]!;
    expect(real.lastActivity).toBe("9m24s ago: agent: reading src/a.ts, src/b.ts");
    expect(quietSeconds(real)).toBe(564);
    expect(quietSeconds({ activeFor: "3h", lastActivity: "1h5m ago: log: x" })).toBe(3900);
    expect(quietSeconds({ activeFor: "3h", lastActivity: "350ms ago: log: x" })).toBe(0);
  });

  test("a later no-mistakes' quiet marker before the age still reads", () => {
    expect(quietSeconds({ activeFor: "3h", lastActivity: "quiet 41m ago: log: waiting for checks" })).toBe(2460);
    expect(quietSeconds({ activeFor: "3h", lastActivity: "quiet: 2h ago: agent: thinking" })).toBe(7200);
  });

  test("a step with no activity yet has been quiet for its whole run", () => {
    expect(quietSeconds({ activeFor: "3m", lastActivity: "" })).toBe(180);
    expect(quietSeconds({ activeFor: "", lastActivity: "" })).toBeNull();
  });

  test("an activity this copy cannot read says nothing", () => {
    expect(quietSeconds({ activeFor: "3h", lastActivity: "just now: log: x" })).toBeNull();
    expect(quietSeconds({ activeFor: "3h", lastActivity: "log: x" })).toBeNull();
  });

  test("the oldest step is the one that has run longest", () => {
    const steps = [
      { step: "ci", status: "running", activeFor: "3m", lastActivity: "", agentPid: "" },
      { step: "review", status: "running", activeFor: "1h2m", lastActivity: "", agentPid: "1" },
    ];
    expect(oldestStep(steps)!.step).toBe("review");
    expect(oldestStep([])).toBeNull();
  });
});

describe("a validation slot held with no progress", () => {
  test("a step quiet past the threshold opens one P1 naming the task, the step, how long and flowryn show", () => {
    observe(running("review", "50m", "45m ago: agent: thinking"));
    const items = stuckItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ lane: "P1", class: "actionable", task_id: "t1", run_id: "r1", state: "open" });
    expect(items[0]!.line).toBe("Validation stuck: t1 (p): no-mistakes step review quiet for 45m; flowryn show t1");
    // One per episode: the next read of the same stall opens nothing.
    observe(running("review", "51m", "46m ago: agent: thinking"), now + MIN);
    expect(stuckItems()).toHaveLength(1);
    expect(episodeEvents()).toEqual(["run.validation_stuck"]);
  });

  test("a step under the threshold, or a step with an activity this copy cannot read, opens nothing", () => {
    observe(running("review", "2h", "29m ago: agent: thinking"));
    observe(running("review", "2h", "sometime: agent: thinking"));
    expect(stuckItems()).toEqual([]);
    expect(episodeEvents()).toEqual([]);
  });

  test("a status without the steps table, or a run parked with no active step, is not judged", () => {
    observe('run:\n  id: "01NM"\n  branch: b\n  status: running\n  head: abc\n');
    observe('run:\n  id: "01NM"\n  branch: b\n  status: awaiting_approval\n  head: abc\n  active_steps[0]{step,status,active_for,last_activity,agent_pid,round}:\n');
    expect(stuckItems()).toEqual([]);
  });

  test("the step moving resolves the item, and a new stall opens a new one", () => {
    observe(running("review", "50m", "45m ago: agent: thinking"));
    observe(running("review", "51m", "10s ago: agent: wrote src/a.ts"), now + MIN);
    expect(stuckItems().map((i) => [i.state, i.resolved_by])).toEqual([["resolved", "step moved"]]);
    observe(running("test", "40m", "31m ago: log: go test"), now + 2 * MIN);
    expect(stuckItems().map((i) => i.state)).toEqual(["resolved", "open"]);
    expect(episodeEvents()).toEqual(["run.validation_stuck", "run.validation_moving", "run.validation_stuck"]);
  });

  test("a dismissed item does not come back until the run moved and stalled again", () => {
    observe(running("review", "50m", "45m ago: agent: thinking"));
    tx(db, () => db.query("UPDATE items SET state = 'resolved', resolved_by = 'dismissed' WHERE kind = 'validation_stuck'").run());
    observe(running("review", "52m", "47m ago: agent: thinking"), now + 2 * MIN);
    expect(stuckItems()).toHaveLength(1);
    observe(running("review", "53m", "5s ago: agent: x"), now + 3 * MIN);
    observe(running("review", "90m", "35m ago: agent: x"), now + 40 * MIN);
    expect(stuckItems().map((i) => i.state)).toEqual(["resolved", "open"]);
  });

  test("a run that ended with the slot still held opens the P1 once the threshold has passed since it stopped", () => {
    observe(running("ci", "5m", "1m ago: log: waiting"));
    tx(db, () => db.query("UPDATE runs SET state = 'validating' WHERE id = 'r1'").run());
    observe(ENDED, now + 10 * MIN);
    expect(stuckItems()).toEqual([]);
    observe(ENDED, now + 39 * MIN);
    expect(stuckItems()).toEqual([]);
    observe(ENDED, now + 41 * MIN);
    expect(stuckItems().map((i) => i.line)).toEqual(["Validation stuck: t1 (p): no-mistakes run 01NM ended (passed), quiet for 31m with the slot held and nothing delivered; flowryn show t1"]);
  });

  test("no run on the branch (none, or another branch's) counts from the slot's grant", () => {
    observe(null, now + 20 * MIN);
    expect(stuckItems()).toEqual([]);
    observe(running("review", "1m", "1h ago: x", "other"), now + 31 * MIN);
    expect(stuckItems().map((i) => i.line)).toEqual(["Validation stuck: t1 (p): no no-mistakes run on b, quiet for 31m with the slot held and nothing delivered; flowryn show t1"]);
  });

  test("no validation slot: nothing is judged", () => {
    tx(db, () => db.query("UPDATE pool_leases SET released_at = ?1, released_by = 'x'").run(now));
    observe(running("review", "50m", "45m ago: agent: thinking"));
    observe(null, now + 2 * 60 * MIN);
    expect(stuckItems()).toEqual([]);
  });

  test("releasing the slot resolves the item, naming why; another pool's release does not", () => {
    observe(running("review", "50m", "45m ago: agent: thinking"));
    tx(db, () => db.query("INSERT INTO pool_leases (pool, run_id, stage, granted_at) VALUES ('worker', 'r1', 'ship', ?1)").run(now));
    tx(db, () => releaseLeases(db, "r1", "t1", { keepWorker: false }, "stage ship delivered", now + MIN));
    expect(stuckItems().map((i) => [i.state, i.resolved_by])).toEqual([["resolved", "slot released: stage ship delivered"]]);
  });

  test("a new slot starts a new episode", () => {
    observe(running("review", "50m", "45m ago: agent: thinking"));
    tx(db, () => releaseLeases(db, "r1", "t1", { keepWorker: true }, "run.failed", now + MIN));
    tx(db, () => db.query("INSERT INTO pool_leases (pool, run_id, stage, granted_at) VALUES ('validation', 'r1', 'ship', ?1)").run(now + 2 * MIN));
    observe(running("review", "50m", "45m ago: agent: thinking"), now + 3 * MIN);
    expect(stuckItems().map((i) => i.state)).toEqual(["resolved", "open"]);
  });

  test("a stuck validation is an item the leader's turn end relays", () => {
    expect(RELAY_KINDS).toContain("validation_stuck");
  });
});
