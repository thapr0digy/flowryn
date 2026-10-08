import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TIMING } from "../../src/config/workers.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { TURN_END_REMINDER } from "../../src/harness/contract-text.ts";
import { openBlockedPrompt } from "../../src/lifecycle/prompt-wedge.ts";
import { getRun } from "../../src/lifecycle/runs.ts";
import { createSteer, markRung } from "../../src/lifecycle/steers.ts";
import { BACKGROUND_ENDED, backgroundStartOf, recordBackgroundStart, runningBackgroundJobs, type ToolHookInput } from "../../src/lifecycle/background-jobs.ts";
import { guardTurnEnd, instructionAt, OUTCOME_KINDS, reminderIgnored, REMINDER_KIND, RESULT_KIND, WAIT_BACKGROUND, WAIT_END_TURN, type TurnEnd } from "../../src/lifecycle/turn-end-guard.ts";

/**
 * The turn-end guard's rules (autonomy spec 2, ship A): one reminder per
 * episode, only for a turn that ended with no outcome since the last
 * instruction and nothing it waits on; each reminder settled as obeyed or
 * ignored at the next turn end.
 */

let dir: string;
let db: Db;
let clock: number;
let transcript: string;

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
  transcript = join(dir, "session.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: "the task" } }) + "\n");
  tx(db, () => {
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('p', '', '/p', 'main', 'local-only')").run();
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES ('t1', 'p', 'ship', 'local-only', 0, 'fix', 0)").run();
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at, pane_id, worker_started_at)
       VALUES ('r1', 't1', 'claude', 'v', 'running', 'busy', 'fix', 'build', '/w', 'b', 's', 'h', ?1, ?1, 'w1:p1', ?1)`,
    ).run(clock);
    db.query("UPDATE runs SET transcript_path = ?1 WHERE id = 'r1'").run(transcript);
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

/**
 * Background jobs, as Claude reports them (shapes copied from worker
 * transcripts on 2.1.292): the PostToolUse input of the call that started
 * one, and the <task-notification> that ends it, as the prompt of the turn it
 * wakes or as a queued_command attachment inside a busy turn.
 */
const BASH_BACKGROUND = (id: string, job: string): ToolHookInput => ({
  tool_name: "Bash",
  tool_use_id: id,
  tool_input: { command: "bun test > $TMPDIR/full.txt 2>&1", run_in_background: true },
  tool_response: { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: job },
});
const AGENT_ASYNC = (id: string, agent: string): ToolHookInput => ({
  tool_name: "Agent",
  tool_use_id: id,
  tool_input: { description: "research", prompt: "look" },
  tool_response: { isAsync: true, status: "async_launched", agentId: agent, description: "research" },
});

function notification(toolUseId: string, job: string): string {
  return `<task-notification>\n<task-id>${job}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>/tmp/tasks/${job}.output</output-file>\n<status>completed</status>\n<summary>Background command "Run full bun test suite" completed (exit code 0)</summary>\n</task-notification>`;
}

function started(input: ToolHookInput): void {
  clock += 10;
  const start = backgroundStartOf(input);
  if (!start) throw new Error("not a background start");
  tx(db, () => recordBackgroundStart(db, run(), start, transcript, clock));
  appendFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: [{ tool_use_id: input.tool_use_id, type: "tool_result", content: "Command running in background" }] } }) + "\n");
}

/** The job's notice woke the worker: the prompt of a new turn. */
function wokenBy(toolUseId: string, job: string): void {
  appendFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: notification(toolUseId, job) }, origin: { kind: "task-notification" } }) + "\n");
}

/** The job ended inside a busy turn: an attachment, and no hook fires. */
function endedMidTurn(toolUseId: string, job: string): void {
  appendFileSync(transcript, JSON.stringify({ type: "attachment", attachment: { type: "queued_command", prompt: notification(toolUseId, job), commandMode: "task-notification" } }) + "\n");
}

function running(): string[] {
  return tx(db, () => runningBackgroundJobs(db, run(), clock)).map((j) => j.job ?? j.toolUseId);
}

describe("misfires from the data (2026-10-05 to 10-07): a worker waiting on its own background job", () => {
  test("build: the full bun test run in the background (reminders 5729, 5969, 5995, 6234) gets none; once its notice woke the worker, an outcome-less stop gets one", () => {
    started(BASH_BACKGROUND("toolu_bt", "b1iwwc2po"));
    expect(stop()).toBeNull();
    expect(reminders()).toBe(0);
    wokenBy("toolu_bt", "b1iwwc2po");
    expect(stop()).toBe(TURN_END_REMINDER);
    const ended = db.query("SELECT payload FROM events WHERE kind = ?1").all(BACKGROUND_ENDED) as { payload: string }[];
    expect(ended.map((e) => JSON.parse(e.payload))).toMatchObject([{ tool_use_id: "toolu_bt", job: "b1iwwc2po", status: "completed" }]);
  });

  test("ship: no-mistakes started in the background before run.validating (reminders 5434, 5815, 5989, 6029, 6271, 6377) gets none", () => {
    clock += 10;
    update("UPDATE runs SET stage = 'ship', stage_started_at = ?2 WHERE id = ?1", "r1", clock);
    started(BASH_BACKGROUND("toolu_nm", "bmy9mj4pg"));
    expect(stop()).toBeNull();
    // The reconciler sees the pipeline next: the run goes validating, a wait of its own.
    update("UPDATE runs SET state = 'validating' WHERE id = ?1", "r1");
    wokenBy("toolu_nm", "bmy9mj4pg");
    expect(stop()).toBeNull();
    expect(reminders()).toBe(0);
  });

  test("scout: research agents launched asynchronously (reminder 5682) get none until the last one ends", () => {
    started(AGENT_ASYNC("toolu_a1", "a82a77a05e16192f7"));
    started(AGENT_ASYNC("toolu_a2", "a287c69a4a4247d38"));
    expect(stop()).toBeNull();
    wokenBy("toolu_a1", "a82a77a05e16192f7");
    expect(running()).toEqual(["a287c69a4a4247d38"]);
    expect(stop()).toBeNull();
    wokenBy("toolu_a2", "a287c69a4a4247d38");
    expect(stop()).toBe(TURN_END_REMINDER);
  });

  test("a job that ended inside a busy turn (a queued_command attachment, no hook) no longer holds the guard", () => {
    started(BASH_BACKGROUND("toolu_mid", "bf1ambuzj"));
    endedMidTurn("toolu_mid", "bf1ambuzj");
    expect(stop()).toBe(TURN_END_REMINDER);
  });

  test("Pi (reminders 5554, 5589): an empty turn, or stage done echoed instead of run, is still reminded", () => {
    expect(stop({ harness: "pi" })).toBe(TURN_END_REMINDER);
    expect(stop({ harness: "pi" })).toBeNull();
    expect(results()).toMatchObject([{ obeyed: false, outcome: null }]);
  });

  test("a background wait that began after the reminder obeys it", () => {
    expect(stop()).toBe(TURN_END_REMINDER);
    started(BASH_BACKGROUND("toolu_late", "blate"));
    expect(stop({ continuationsUsed: 1 })).toBeNull();
    expect(results()).toMatchObject([{ obeyed: true, outcome: WAIT_BACKGROUND }]);
  });
});

describe("what counts as a background job", () => {
  test("a background Bash call or an asynchronous agent of the main agent; not a subagent's own call, nor a foreground one", () => {
    expect(backgroundStartOf(BASH_BACKGROUND("t1", "b1"))).toEqual({ toolUseId: "t1", tool: "Bash", job: "b1" });
    expect(backgroundStartOf(AGENT_ASYNC("t2", "a1"))).toEqual({ toolUseId: "t2", tool: "Agent", job: "a1" });
    expect(backgroundStartOf({ ...BASH_BACKGROUND("t3", "b3"), agent_id: "sub" })).toBeNull();
    expect(backgroundStartOf({ tool_name: "Bash", tool_use_id: "t4", tool_input: { command: "ls" }, tool_response: { stdout: "a" } })).toBeNull();
    expect(backgroundStartOf({ tool_name: "Agent", tool_use_id: "t5", tool_response: { status: "completed", agentId: "a5" } })).toBeNull();
    expect(backgroundStartOf({ ...BASH_BACKGROUND("t6", "b6"), tool_use_id: null })).toBeNull();
  });

  test("assumption A1 fallback: a Bash call asked to run in the background counts even when its response names no id", () => {
    expect(backgroundStartOf({ tool_name: "Bash", tool_use_id: "t7", tool_input: { command: "sleep 5", run_in_background: true }, tool_response: { stdout: "" } })).toEqual({ toolUseId: "t7", tool: "Bash", job: null });
  });

  test("assumption A2: the end is matched by the tool use id in the notice, not the job id, and only after the start", () => {
    // A notice for the same tool use id written before this start (an earlier session's line) does not end it.
    wokenBy("toolu_same", "bold");
    started(BASH_BACKGROUND("toolu_same", "bnew"));
    expect(running()).toEqual(["bnew"]);
    // A waiter wake is a task notification too, with no tool use id: it ends nothing.
    appendFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: "<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>" } }) + "\n");
    expect(running()).toEqual(["bnew"]);
    wokenBy("toolu_same", "bnew");
    expect(running()).toEqual([]);
  });

  test("an agent that hands its report back (<agent-message from=...>, Claude 2.1.294) has ended", () => {
    started(AGENT_ASYNC("toolu_hb", "af26666239937089b"));
    expect(running()).toEqual(["af26666239937089b"]);
    appendFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: '<agent-message from="af26666239937089b">\n[Subagent hand-back] ok\n</agent-message>' } }) + "\n");
    expect(running()).toEqual([]);
    const ended = db.query("SELECT payload FROM events WHERE kind = ?1").all(BACKGROUND_ENDED) as { payload: string }[];
    expect(ended.map((e) => JSON.parse(e.payload))).toMatchObject([{ job: "af26666239937089b", status: "handed_back" }]);
  });

  test("a job started before the worker was relaunched or resumed does not count", () => {
    started(BASH_BACKGROUND("toolu_old", "bold"));
    clock += 10;
    update("UPDATE runs SET worker_started_at = ?2 WHERE id = ?1", "r1", clock);
    expect(running()).toEqual([]);
    expect(stop()).toBe(TURN_END_REMINDER);
  });

  test("a transcript that cannot be read leaves the job running: the guard stays quiet", () => {
    started(BASH_BACKGROUND("toolu_gone", "bgone"));
    rmSync(transcript);
    expect(stop()).toBeNull();
    expect(running()).toEqual(["bgone"]);
  });
});

/** A leader steer carried to the worker, sent with --end-turn or not. */
function carrySteer(endTurn: boolean): void {
  clock += 10;
  tx(db, () => {
    const m = createSteer(db, run(), "wait for #41 to merge, then end your turn", clock, null, false, endTurn);
    markRung(db, m, run(), "waiter", clock, true, DEFAULT_TIMING);
  });
}

describe("the leader told the worker to end its turn (steer --end-turn)", () => {

  test("its turn end gets no reminder; the next instruction (a stage start) earns one again", () => {
    carrySteer(true);
    expect(stop()).toBeNull();
    expect(reminders()).toBe(0);
    clock += 10;
    update("UPDATE runs SET stage_started_at = ?2 WHERE id = ?1", "r1", clock);
    expect(stop()).toBe(TURN_END_REMINDER);
  });

  test("a later steer without the flag starts an episode that is guarded again", () => {
    carrySteer(true);
    expect(stop()).toBeNull();
    carrySteer(false);
    expect(stop()).toBe(TURN_END_REMINDER);
  });

  test("an --end-turn steer after a reminder settles it obeyed", () => {
    expect(stop()).toBe(TURN_END_REMINDER);
    carrySteer(true);
    expect(stop()).toBeNull();
    expect(results()).toMatchObject([{ obeyed: true, outcome: WAIT_END_TURN }]);
  });
});

describe("deliberate stops already covered (regression)", () => {
  test("stage done, then the turn ends in the same episode: no reminder", () => {
    event("stage.done");
    expect(stop()).toBeNull();
  });

  test("a delivered ship steered to fix a merge conflict, then stopped: its run is past running, no reminder", () => {
    event("run.delivered");
    update("UPDATE runs SET state = 'ready' WHERE id = ?1", "r1");
    clock += 10;
    tx(db, () => {
      const m = createSteer(db, run(), "Your PR conflicts with main: merge origin/main and push", clock);
      markRung(db, m, run(), "waiter", clock, true, DEFAULT_TIMING);
    });
    expect(stop()).toBeNull();
    expect(reminders()).toBe(0);
  });
});
