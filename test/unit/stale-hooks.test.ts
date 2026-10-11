import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openItem } from "../../src/attention/items.ts";
import { DEFAULT_TIMING } from "../../src/config/workers.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { BACKGROUND_ENDED, BACKGROUND_STARTED } from "../../src/lifecycle/background-jobs.ts";
import { getRun } from "../../src/lifecycle/runs.ts";
import { staleHooksDue } from "../../src/lifecycle/stale-hooks.ts";
import { pendingWait } from "../../src/lifecycle/turn-end-guard.ts";
import replay from "../fixtures/stale-hooks-2026-10.json";

/**
 * The stale-hook pointer's rule (docs/notes/2026-10-10-quieter-stale-hook-3q.md):
 * Herdr working, quiet stale_hook_ms since the later of the last hook and the
 * last instruction, nothing the turn-end guard counts as a wait, and no
 * pointer raised this episode. The 21 events flowryn.db recorded in October
 * are replayed from test/fixtures/stale-hooks-2026-10.json: all were noise.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;

interface Replayed {
  seq: number;
  task: string;
  at: number;
  last_hook: number;
  state: string;
  stage_state: string;
  stage_started_at: number;
  carried_at: number | null;
  open_questions: number;
  background_jobs: number;
  wait: string | null;
  expect: { due: boolean; why?: string };
}

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-stale-hooks-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  tx(db, () => {
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('p', '', '/p', 'main', 'local-only')").run();
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES ('t1', 'p', 'ship', 'local-only', 0, 'fix', 0)").run();
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Seed {
  startedAt: number;
  lastHook: number;
  state?: string;
  stageState?: string;
  stageStartedAt?: number | null;
  carriedAt?: number | null;
  openQuestions?: number;
  backgroundJobs?: number;
}

/** One run, r1, in the given state; a background job's transcript is missing, so it reads as still running. */
function seed(s: Seed): void {
  tx(db, () => {
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, stage_state, stage_started_at, worktree_path, branch, base_sha, token_hash,
         started_at, updated_at, pane_id, worker_started_at, last_hook_at, transcript_path)
       VALUES ('r1', 't1', 'claude', 'v', ?1, 'busy', 'fix', 'build', ?2, ?3, '/w', 'b', 's', 'h', ?4, ?4, 'w1:p1', ?4, ?5, ?6)`,
    ).run(s.state ?? "running", s.stageState ?? "active", s.stageStartedAt ?? null, s.startedAt, s.lastHook, join(dir, "missing.jsonl"));
    if (s.carriedAt != null) db.query("INSERT INTO messages (id, run_id, body, created_at, carried_at) VALUES ('m1', 'r1', 'carry on', ?1, ?1)").run(s.carriedAt);
    for (let i = 0; i < (s.openQuestions ?? 0); i++) {
      db.query("INSERT INTO decisions (id, task_id, run_id, question, options, blocking, state, created_at) VALUES (?1, 't1', 'r1', 'Which?', '[]', 0, 'open', ?2)").run(`q${i}`, s.startedAt);
    }
    for (let i = 0; i < (s.backgroundJobs ?? 0); i++) {
      appendEvent(db, { source: "hook", kind: BACKGROUND_STARTED, runId: "r1", taskId: "t1", payload: { tool_use_id: `tu${i}`, tool: "Bash", job: `b${i}`, transcript: null, offset: 0 }, ts: s.lastHook });
    }
  });
}

function verdict(t: number, herdr: string | null = "working") {
  return tx(db, () => staleHooksDue(db, getRun(db, "r1")!, herdr, t, DEFAULT_TIMING));
}

describe("the October replay: every recorded run.stale_hooks event was noise", () => {
  const events = (replay as { events: Replayed[] }).events;

  test("the fixture holds the 21 events", () => {
    expect(events).toHaveLength(21);
  });

  for (const e of events) {
    test(`${e.seq} (${e.task}): ${e.expect.why}`, () => {
      // The old rule (Herdr working, quiet since the last hook) fired on each.
      expect(e.at - e.last_hook).toBeGreaterThanOrEqual(DEFAULT_TIMING.stale_hook_ms);
      seed({
        startedAt: Math.min(e.last_hook, e.stage_started_at, e.carried_at ?? Infinity) - HOUR,
        lastHook: e.last_hook,
        state: e.state,
        stageState: e.stage_state,
        stageStartedAt: e.stage_started_at,
        carriedAt: e.carried_at,
        openQuestions: e.open_questions,
        backgroundJobs: e.background_jobs,
      });
      expect(tx(db, () => pendingWait(db, getRun(db, "r1")!, e.at, "reconciler"))).toBe(e.wait);
      expect(verdict(e.at)).toEqual(e.expect as { due: false; why: string });
    });
  }
});

describe("staleHooksDue", () => {
  const t0 = 10 * HOUR;

  test("a running worker in an active stage, nothing to wait on, quiet 31 min: due, quiet from its last hook", () => {
    seed({ startedAt: t0 - HOUR, lastHook: t0 });
    expect(verdict(t0 + 31 * MIN)).toEqual({ due: true, quietFrom: t0 });
  });

  test("quiet 29 min: silent", () => {
    seed({ startedAt: t0 - HOUR, lastHook: t0 });
    expect(verdict(t0 + 29 * MIN)).toEqual({ due: false, why: "quiet 29m since its last hook" });
  });

  test("its own background job still running: silent, the guard's wait", () => {
    seed({ startedAt: t0 - HOUR, lastHook: t0, backgroundJobs: 1 });
    expect(verdict(t0 + 31 * MIN)).toEqual({ due: false, why: "its own background job" });
  });

  test("a background job the reconciler finds ended is recorded with its source, and the pointer fires", () => {
    seed({ startedAt: t0 - HOUR, lastHook: t0, backgroundJobs: 1 });
    const transcript = join(dir, "missing.jsonl");
    writeFileSync(transcript, `{"type":"user","message":{"content":"<task-notification><tool-use-id>tu0</tool-use-id><status>completed</status></task-notification>"}}\n`);
    expect(verdict(t0 + 31 * MIN)).toEqual({ due: true, quietFrom: t0 });
    expect(db.query("SELECT source FROM events WHERE kind = ?1").all(BACKGROUND_ENDED)).toEqual([{ source: "reconciler" }]);
  });

  test("the clock counts from the last instruction: a worker woken by a steer is not overdue at once", () => {
    seed({ startedAt: t0 - HOUR, lastHook: t0, carriedAt: t0 + 40 * MIN });
    expect(verdict(t0 + 40 * MIN)).toEqual({ due: false, why: "quiet 0m since its last instruction" });
    expect(verdict(t0 + 71 * MIN)).toEqual({ due: true, quietFrom: t0 + 40 * MIN });
  });

  test("Herdr not reading working: silent", () => {
    seed({ startedAt: t0 - HOUR, lastHook: t0 });
    expect(verdict(t0 + 2 * HOUR, "idle")).toEqual({ due: false, why: "herdr idle" });
    expect(verdict(t0 + 2 * HOUR, null)).toEqual({ due: false, why: "herdr unreachable" });
  });

  test("an open question or a pending launch: silent", () => {
    seed({ startedAt: t0 - HOUR, lastHook: t0, openQuestions: 1 });
    expect(verdict(t0 + 31 * MIN)).toEqual({ due: false, why: "an open question" });
    tx(db, () => db.query("DELETE FROM decisions").run());
    tx(db, () => db.query("UPDATE runs SET pending_launch = 'resume' WHERE id = 'r1'").run());
    expect(verdict(t0 + 31 * MIN)).toEqual({ due: false, why: "pending launch resume" });
  });

  test("once per episode: an open worker_idle item holds it", () => {
    seed({ startedAt: t0 - HOUR, lastHook: t0 });
    tx(db, () => {
      const event = appendEvent(db, { source: "reconciler", kind: "run.stale_hooks", runId: "r1", taskId: "t1", payload: { since: t0 }, ts: t0 + 31 * MIN });
      openItem(db, { kind: "worker_idle", eventSeq: event.seq, runId: "r1", taskId: "t1", line: "stale", now: t0 + 31 * MIN });
    });
    expect(verdict(t0 + 32 * MIN)).toEqual({ due: false, why: "pointer already raised this episode" });
  });
});
