import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { BACKGROUND_HOLD_PREFIX } from "../../src/harness/contract-text.ts";
import { backgroundStartOf, recordBackgroundStart, type ToolHookInput } from "../../src/lifecycle/background-jobs.ts";
import { HOLD_CAP_MS, HOLD_KIND, HOLD_MAX_REFUSALS, HOLD_RELEASED_KIND, holdTurnEnd } from "../../src/lifecycle/background-hold.ts";
import { getRun } from "../../src/lifecycle/runs.ts";
import { createSteer, markRung } from "../../src/lifecycle/steers.ts";
import { DEFAULT_TIMING } from "../../src/config/workers.ts";

/**
 * The background hold (docs/notes/2026-11-27-a-worker-cannot-w5.md): a Claude
 * worker's Stop is refused while its own background Bash job runs, and the
 * refusal is bounded by the job's end, its deadline (the cap) and a refusal
 * count. The shape replays the appsec-signal transcripts (m1242, m1541,
 * m1557): `make ui-check-changed` started with run_in_background, then the
 * turn ended "I'll act when it lands".
 */

let dir: string;
let db: Db;
let clock: number;
let transcript: string;

const run = () => getRun(db, "r1")!;

/** The PostToolUse input of m1557's call, as Claude sends it. */
const UI_CHECK = (id: string, job: string, timeout?: number): ToolHookInput => ({
  tool_name: "Bash",
  tool_use_id: id,
  tool_input: { command: "make ui-check-changed BASE=main", run_in_background: true, ...(timeout !== undefined ? { timeout } : {}) },
  tool_response: { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: job },
});

function started(input: ToolHookInput): void {
  clock += 10;
  const start = backgroundStartOf(input);
  if (!start) throw new Error("not a background start");
  tx(db, () => recordBackgroundStart(db, run(), start, transcript, clock));
}

function ended(toolUseId: string, job: string): void {
  const notice = `<task-notification>\n<task-id>${job}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n</task-notification>`;
  appendFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: notice } }) + "\n");
}

function stop(after = 10): string | null {
  clock += after;
  return tx(db, () => holdTurnEnd(db, run(), clock));
}

function payloads(kind: string): Record<string, unknown>[] {
  return (db.query("SELECT payload FROM events WHERE kind = ?1 ORDER BY seq").all(kind) as { payload: string }[]).map((e) => JSON.parse(e.payload));
}

function update(sql: string, ...params: (string | number | null)[]): void {
  tx(db, () => db.query(sql).run(...params));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-hold-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  clock = 1_000_000;
  transcript = join(dir, "session.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: "the task" } }) + "\n");
  tx(db, () => {
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('p', '', '/p', 'main', 'local-only')").run();
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES ('t1', 'p', 'ship', 'local-only', 0, 'fix', 0)").run();
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at, pane_id, worker_started_at, transcript_path)
       VALUES ('r1', 't1', 'claude', 'v', 'running', 'busy', 'fix', 'build', '/w', 'b', 's', 'h', ?1, ?1, 'w1:p1', ?1, ?2)`,
    ).run(clock, transcript);
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the background hold", () => {
  test("a turn end while its own background Bash job runs is refused, naming the job and how to wait", () => {
    started(UI_CHECK("toolu_1", "bui1"));
    const line = stop(12 * 60_000);
    expect(line).toStartWith(BACKGROUND_HOLD_PREFIX);
    expect(line).toContain("your background job (Bash bui1, started 12m ago) is still running");
    expect(line).toContain("Monitor");
    expect(line).toContain("TaskStop");
    expect(payloads(HOLD_KIND)).toEqual([{ tool_use_ids: ["toolu_1"], jobs: ["bui1"] }]);
  });

  test("two jobs are named together", () => {
    started(UI_CHECK("toolu_1", "bui1"));
    started(UI_CHECK("toolu_2", "bui2"));
    expect(stop()).toContain("your background jobs (Bash bui1, Bash bui2; the first started 0m ago) are still running");
  });

  test("with no background job, nothing holds", () => {
    expect(stop()).toBeNull();
    expect(payloads(HOLD_KIND)).toEqual([]);
  });

  test("once the job's end notice is in the transcript, the turn may end", () => {
    started(UI_CHECK("toolu_1", "bui1"));
    expect(stop()).not.toBeNull();
    ended("toolu_1", "bui1");
    expect(stop()).toBeNull();
    expect(payloads("run.background_ended")).toMatchObject([{ tool_use_id: "toolu_1", status: "completed" }]);
    expect(payloads(HOLD_RELEASED_KIND)).toEqual([]);
  });

  test("a job whose end was missed holds no longer than the cap, with the reason recorded once", () => {
    started(UI_CHECK("toolu_1", "bui1"));
    expect(stop(HOLD_CAP_MS - 1_000)).not.toBeNull();
    expect(stop(2_000)).toBeNull();
    expect(stop()).toBeNull();
    expect(payloads(HOLD_RELEASED_KIND)).toMatchObject([{ tool_use_id: "toolu_1", reason: "cap" }]);
  });

  test("the call's own timeout does not release the job before the cap", () => {
    started(UI_CHECK("toolu_1", "bui1", 600_000));
    expect(stop(601_000)).toContain("Bash bui1");
    expect(payloads(HOLD_RELEASED_KIND)).toEqual([]);
    expect(stop(HOLD_CAP_MS)).toBeNull();
    expect(payloads(HOLD_RELEASED_KIND)).toMatchObject([{ tool_use_id: "toolu_1", job: "bui1", reason: "cap", refusals: 1 }]);
  });

  test("a worker that keeps ending its turn is let go after the refusal cap, with the reason", () => {
    started(UI_CHECK("toolu_1", "bui1"));
    for (let i = 0; i < HOLD_MAX_REFUSALS; i++) expect(stop()).not.toBeNull();
    expect(stop()).toBeNull();
    expect(payloads(HOLD_RELEASED_KIND)).toMatchObject([{ tool_use_id: "toolu_1", reason: "refusals", refusals: HOLD_MAX_REFUSALS }]);
    // A job started after the release holds again, on its own count.
    started(UI_CHECK("toolu_2", "bui2"));
    expect(stop()).toContain("Bash bui2");
  });

  test("an asynchronous agent never holds: its hand-back wakes the worker", () => {
    started({ tool_name: "Agent", tool_use_id: "toolu_a", tool_input: { prompt: "look" }, tool_response: { status: "async_launched", agentId: "a1" } });
    expect(stop()).toBeNull();
  });

  test("a job of an earlier worker process (before a relaunch) does not hold", () => {
    started(UI_CHECK("toolu_1", "bui1"));
    update("UPDATE runs SET worker_started_at = ?1 WHERE id = 'r1'", clock + 5);
    expect(stop()).toBeNull();
  });

  test("a rightful wait wins: the run past running, a stage at its gate, or a steer that said end the turn", () => {
    started(UI_CHECK("toolu_1", "bui1"));
    update("UPDATE runs SET state = 'validating' WHERE id = 'r1'");
    expect(stop()).toBeNull();
    update("UPDATE runs SET state = 'running', stage_state = 'review' WHERE id = 'r1'");
    expect(stop()).toBeNull();
    update("UPDATE runs SET stage_state = 'active' WHERE id = 'r1'");
    clock += 10;
    tx(db, () => {
      const steer = createSteer(db, run(), "wait for #41 to merge; end your turn", clock, null, false, true);
      markRung(db, steer, run(), "waiter", clock, true, DEFAULT_TIMING);
    });
    expect(stop()).toBeNull();
    expect(payloads(HOLD_KIND)).toEqual([]);
  });
});
