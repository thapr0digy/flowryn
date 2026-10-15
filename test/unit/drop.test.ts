import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlowrynError } from "../../src/api/errors.ts";
import { migrate, openDb, tx } from "../../src/db/db.ts";
import { MIGRATIONS } from "../../src/db/schema.ts";
import { readSnapshot } from "../../src/journal/snapshot.ts";
import { applyDrop, DROP_VERBS, planDrop } from "../../src/lifecycle/drop.ts";
import { createRun } from "../../src/lifecycle/dispatch.ts";
import { getPlan, recordPlan, takenIds } from "../../src/lifecycle/plans.ts";
import { getProject } from "../../src/lifecycle/projects.ts";
import { queueTask } from "../../src/lifecycle/queued.ts";
import { queuedWork } from "../../src/lifecycle/queue-view.ts";
import { workflowFor } from "../../src/config/workflows.ts";
import { defaultConfig } from "../../src/config/config.ts";
import { intents, makeJournalEnv, type JournalEnv } from "../helpers/journal-env.ts";

let env: JournalEnv;
afterEach(async () => {
  await env.cleanup();
});

function setup(): JournalEnv {
  env = makeJournalEnv();
  env.db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', 'u', '/w', 'main', 'no-mistakes')").run();
  return env;
}

async function queue(id: string, blockedBy: string[] = []): Promise<void> {
  tx(env.db, () => queueTask(env.db, { taskId: id, title: `Title of ${id}`, body: "x", kind: "ship", project: getProject(env.db, "web")!, priority: null, blockedBy, now: env.clock.now }));
  await env.journal.drain();
}

function run(taskId: string, state: string, cleanup: string | null = null, id = `r-${taskId}`): void {
  env.db
    .query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at, cleanup)
       VALUES (?1, ?2, 'claude', '1', ?3, 'dead', 'fix', 'build', '/tmp/wt', 'b', 'abc', ?1, 1, 1, ?4)`,
    )
    .run(id, taskId, state, cleanup);
}

function drop(target: string, unblock = false): ReturnType<typeof planDrop> {
  return tx(env.db, () => {
    const planned = planDrop(env.db, target, { unblock });
    applyDrop(env.db, planned, { reason: "duplicate", by: "leader", now: env.clock.now });
    return planned;
  });
}

function refusal(target: string, unblock = false): FlowrynError {
  try {
    drop(target, unblock);
  } catch (error) {
    if (error instanceof FlowrynError) return error;
    throw error;
  }
  throw new Error(`drop ${target} was not refused`);
}

function backlogIds(): string[] {
  return (readSnapshot(env.db, "backlog")?.tasks ?? []).map((t) => t.id);
}

function filePlan(phases: { title: string }[], state: "pending" | "approved"): string {
  return tx(env.db, () =>
    recordPlan(env.db, {
      project: getProject(env.db, "web")!,
      title: "A plan",
      phases: phases.map((p) => ({ title: p.title, body: p.title, workflow: null, harness: null, after: null })),
      sourceTask: null,
      gateId: null,
      workflow: "fix",
      filedBy: "leader",
      state,
      now: env.clock.now,
    }),
  ).id;
}

function phaseIds(planId: string): string[] {
  return (env.db.query("SELECT task_id FROM plan_phases WHERE plan_id = ?1 ORDER BY phase_no").all(planId) as { task_id: string }[]).map((r) => r.task_id);
}

describe("what drop takes", () => {
  test("a Queued task with no run: deleted from the backlog, kept in drops with its reason, one event", async () => {
    setup();
    await queue("web-dup-q1");
    const planned = drop("web-dup-q1");
    expect(planned.tasks.map((t) => t.id)).toEqual(["web-dup-q1"]);
    const row = env.db.query("SELECT * FROM drops WHERE task_id = 'web-dup-q1'").get() as { title: string; reason: string; dropped_by: string };
    expect(row).toMatchObject({ title: "Title of web-dup-q1", reason: "duplicate", dropped_by: "leader" });
    const event = env.db.query("SELECT payload FROM events WHERE kind = 'task.dropped'").get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ reason: "duplicate", by: "leader", backlog: "rm" });
    expect(intents(env.db).at(-1)).toMatchObject({ verb: "rm", task_id: "web-dup-q1", state: "pending" });
    await env.journal.drain();
    expect(backlogIds()).not.toContain("web-dup-q1");
  });

  test("a parked task whose cancelled run's worktree the cleanup guard removed", async () => {
    setup();
    await queue("web-parked-q1");
    run("web-parked-q1", "cancelled", "done");
    expect(drop("web-parked-q1").tasks).toHaveLength(1);
  });

  test("a dropped task leaves the queue at once, before the journal's rm applies", async () => {
    setup();
    await queue("web-gone-q1");
    expect(queuedWork(env.db).map((q) => q.id)).toEqual(["web-gone-q1"]);
    drop("web-gone-q1");
    expect(queuedWork(env.db)).toEqual([]);
  });

  test("assumption: the dispatch window is closed: createRun refuses a dropped task before its rm applies", async () => {
    setup();
    await queue("web-late-q1");
    drop("web-late-q1");
    const config = defaultConfig(env.dir);
    const start = () =>
      tx(env.db, () =>
        createRun(env.db, config, { taskId: "web-late-q1", title: "t", body: "b", project: getProject(env.db, "web")!, kind: "ship", harness: "claude", version: "1", base: "abc", workflow: workflowFor(config, "fix", "ship"), sensitive: false, existing: true, by: "leader", override: null, now: env.clock.now }),
      );
    expect(start).toThrow("was dropped");
  });

  test("a dropped id is never minted again", async () => {
    setup();
    await queue("web-once-q1");
    drop("web-once-q1");
    await env.journal.drain();
    expect(takenIds(env.db)("web-once-q1")).toBe(true);
  });
});

describe("what drop refuses", () => {
  test("only the leader and you: a worker token is refused, like cancel", () => {
    expect(DROP_VERBS[0]!.roles).toEqual(["leader", "human"]);
  });

  test("a live or delivered run: task_started", async () => {
    setup();
    await queue("web-live-q1");
    run("web-live-q1", "running");
    expect(refusal("web-live-q1").code).toBe("task_started");
    await queue("web-ready-q1");
    run("web-ready-q1", "ready");
    expect(refusal("web-ready-q1").code).toBe("task_started");
  });

  test("a landed or cleaned run, or a task Done in the backlog: task_landed", async () => {
    setup();
    await queue("web-landed-q1");
    run("web-landed-q1", "landed");
    expect(refusal("web-landed-q1").code).toBe("task_landed");
    await queue("web-cleaned-q1");
    run("web-cleaned-q1", "cleaned", "done");
    expect(refusal("web-cleaned-q1").code).toBe("task_landed");
    await queue("web-done-q1");
    env.record({ file: "backlog", verb: "done", taskId: "web-done-q1", positional: ["web-done-q1"] });
    await env.journal.drain();
    expect(refusal("web-done-q1").code).toBe("task_landed");
  });

  test("a cancelled or failed run that keeps its worktree: worktree_kept, pointing at the cleanup guard", async () => {
    setup();
    await queue("web-kept-q1");
    run("web-kept-q1", "cancelled", null);
    const error = refusal("web-kept-q1");
    expect(error.code).toBe("worktree_kept");
    expect(error.help).toBe("flowryn cleanup web-kept-q1");
    await queue("web-failed-q1");
    run("web-failed-q1", "failed", "refused");
    expect(refusal("web-failed-q1").code).toBe("worktree_kept");
  });

  test("a task whose backlog write is still pending: not_ready", () => {
    setup();
    tx(env.db, () => queueTask(env.db, { taskId: "web-fresh-q1", title: "Fresh", body: "x", kind: "ship", project: getProject(env.db, "web")!, priority: null, blockedBy: [], now: env.clock.now }));
    expect(refusal("web-fresh-q1").code).toBe("not_ready");
  });

  test("a decision's task, an unknown id and a task already dropped", async () => {
    setup();
    env.db.query("INSERT INTO decisions (id, task_id, run_id, question, options, blocking, state) VALUES ('k1', 'decision-x-k1', NULL, 'q', '[]', 0, 'open')").run();
    expect(refusal("decision-x-k1").code).toBe("bad_args");
    expect(refusal("web-nope-q1").code).toBe("not_found");
    await queue("web-twice-q1");
    drop("web-twice-q1");
    expect(refusal("web-twice-q1").message).toContain("already dropped");
  });

  test("nothing is written when it refuses", async () => {
    setup();
    await queue("web-live-q2");
    run("web-live-q2", "running");
    const before = intents(env.db).length;
    refusal("web-live-q2");
    expect(intents(env.db)).toHaveLength(before);
    expect(env.db.query("SELECT COUNT(*) AS n FROM drops").get()).toEqual({ n: 0 });
  });
});

describe("tasks that wait for the dropped one", () => {
  test("refused with has_dependents, naming each and what it waits for", async () => {
    setup();
    await queue("web-base-q1");
    await queue("web-next-q1", ["web-base-q1"]);
    const error = refusal("web-base-q1");
    expect(error.code).toBe("has_dependents");
    expect(error.message).toContain("web-next-q1 (blocked by web-base-q1)");
    expect(error.help).toContain("--unblock");
  });

  test("a dependent dropped first no longer counts, though its rm has not applied yet", async () => {
    setup();
    await queue("web-base-q5");
    await queue("web-next-q5", ["web-base-q5"]);
    drop("web-next-q5");
    expect(drop("web-base-q5").dependents).toEqual([]);
    await env.journal.drain();
    expect(intents(env.db).every((i) => i.state === "applied")).toBe(true);
    expect(backlogIds()).toEqual([]);
  });

  test("--unblock clears the edges before the rm, and the dependent is ready", async () => {
    setup();
    await queue("web-base-q2");
    await queue("web-next-q2", ["web-base-q2"]);
    const planned = drop("web-base-q2", true);
    expect(planned.dependents.map((d) => d.task)).toEqual(["web-next-q2"]);
    const verbs = intents(env.db).filter((i) => i.state === "pending").map((i) => `${i.verb} ${i.task_id}`);
    expect(verbs).toEqual(["unblock web-next-q2", "rm web-base-q2"]);
    await env.journal.drain();
    expect(intents(env.db).every((i) => i.state === "applied")).toBe(true);
    const next = readSnapshot(env.db, "backlog")!.tasks.find((t) => t.id === "web-next-q2")!;
    expect(next.deps).toEqual([]);
    expect(backlogIds()).not.toContain("web-base-q2");
    const row = env.db.query("SELECT unblocked FROM drops WHERE task_id = 'web-base-q2'").get() as { unblocked: string };
    expect(JSON.parse(row.unblocked)).toEqual(["web-next-q2"]);
  });

  test("assumption: tasks-axi rm refuses while an open task still blocks on the id (so the unblock goes first)", async () => {
    setup();
    await queue("web-base-q3");
    await queue("web-next-q3", ["web-base-q3"]);
    const raw = await env.runner.real.run(["rm", "web-base-q3", "--file", env.files.backlog, "--json"]);
    expect(raw.exitCode).not.toBe(0);
    expect(backlogIds()).toContain("web-base-q3");
  });

  test("assumption: tasks-axi unblock --by is idempotent (a replayed intent is harmless)", async () => {
    setup();
    await queue("web-base-q4");
    await queue("web-next-q4", ["web-base-q4"]);
    for (let i = 0; i < 2; i++) {
      const raw = await env.runner.real.run(["unblock", "web-next-q4", "--by", "web-base-q4", "--file", env.files.backlog, "--json"]);
      expect(raw.exitCode).toBe(0);
    }
  });
});

describe("plans", () => {
  test("an approved plan none of whose phases started: every phase and the plan dropped; dependents inside it do not count", async () => {
    setup();
    const planId = filePlan([{ title: "First part" }, { title: "Second part" }], "approved");
    await env.journal.drain();
    const ids = phaseIds(planId);
    const planned = drop(planId);
    // tasks-axi rm refuses an id an open task still blocks on, so the later phase goes first.
    expect(planned.tasks.map((t) => t.id)).toEqual(ids.toReversed());
    expect(planned.dependents).toEqual([]);
    expect(getPlan(env.db, planId)!.state).toBe("dropped");
    expect((env.db.query("SELECT auto FROM task_policy WHERE task_id = ?1").get(ids[0]!) as { auto: number }).auto).toBe(0);
    await env.journal.drain();
    expect(intents(env.db).every((i) => i.state === "applied")).toBe(true);
    expect(backlogIds().filter((id) => ids.includes(id))).toEqual([]);
    const kinds = (env.db.query("SELECT kind FROM events WHERE kind LIKE '%.dropped' ORDER BY seq").all() as { kind: string }[]).map((r) => r.kind);
    expect(kinds).toEqual(["task.dropped", "task.dropped", "plan.dropped"]);
  });

  test("a plan with a started phase: phase_started, naming the phase, its task and its run", async () => {
    setup();
    const planId = filePlan([{ title: "Alpha" }, { title: "Beta" }], "approved");
    await env.journal.drain();
    const ids = phaseIds(planId);
    run(ids[0]!, "running", null, "r-alpha");
    const error = refusal(planId);
    expect(error.code).toBe("phase_started");
    expect(error.message).toContain(`phase 1 (${ids[0]}) has run r-alpha (running)`);
  });

  test("a pending plan (its design not yet approved) drops with no backlog write", () => {
    setup();
    const planId = filePlan([{ title: "Pending one" }], "pending");
    const before = intents(env.db).length;
    const planned = drop(planId);
    expect(planned.tasks[0]!.inBacklog).toBe(false);
    expect(intents(env.db)).toHaveLength(before);
    expect(getPlan(env.db, planId)!.state).toBe("dropped");
  });

  test("a single phase of a pending plan is refused: drop the plan", () => {
    setup();
    const planId = filePlan([{ title: "Lonely" }], "pending");
    const error = refusal(phaseIds(planId)[0]!);
    expect(error.code).toBe("bad_args");
    expect(error.help).toContain(`flowryn drop ${planId}`);
  });

  test("a plan already dropped or discarded is refused", () => {
    setup();
    const planId = filePlan([{ title: "Once" }], "pending");
    drop(planId);
    expect(refusal(planId).message).toContain("already dropped");
    const other = filePlan([{ title: "Discarded" }], "pending");
    env.db.query("UPDATE plans SET state = 'discarded' WHERE id = ?1").run(other);
    expect(refusal(other).message).toContain("already discarded");
  });

  test("phases dropped one task at a time, last first: the plan is dropped with its last phase", async () => {
    setup();
    const planId = filePlan([{ title: "Gamma" }, { title: "Delta" }], "approved");
    await env.journal.drain();
    const [first, second] = phaseIds(planId);
    expect(refusal(first!).code).toBe("has_dependents");
    drop(second!);
    expect(getPlan(env.db, planId)!.state).toBe("approved");
    await env.journal.drain();
    drop(first!);
    expect(getPlan(env.db, planId)!.state).toBe("dropped");
  });

  test("a later phase of an approved plan dropped with --unblock: the plan's own record loses the edge too", async () => {
    setup();
    await queue("web-ext-q1");
    const planId = tx(env.db, () =>
      recordPlan(env.db, { project: getProject(env.db, "web")!, title: "Waits", phases: [{ title: "Waiter", body: "w", workflow: null, harness: null, after: null }], sourceTask: null, gateId: null, blockedBy: ["web-ext-q1"], workflow: "fix", filedBy: "leader", state: "pending", now: env.clock.now }),
    ).id;
    expect(refusal("web-ext-q1").code).toBe("has_dependents");
    drop("web-ext-q1", true);
    const row = env.db.query("SELECT blocked_by FROM plan_phases WHERE plan_id = ?1").get(planId) as { blocked_by: string };
    expect(JSON.parse(row.blocked_by)).toEqual([]);
  });
});

describe("migration 26", () => {
  test("plans keep their rows and accept the dropped state; drops exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "fw-drop-"));
    try {
      const db = openDb(join(dir, "flowryn.db"));
      migrate(db, MIGRATIONS.slice(0, 25));
      db.exec("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('p', 'u', '/p', 'main', 'no-mistakes')");
      db.exec("INSERT INTO plans (id, project_id, title, state, filed_by, created_at) VALUES ('p1', 'p', 'Old', 'approved', 'leader', 1)");
      db.exec("INSERT INTO plan_phases (plan_id, phase_no, task_id, title, body, workflow, blocked_by) VALUES ('p1', 1, 'old-a1', 'Old', 'b', 'fix', '[]')");
      expect(() => db.exec("UPDATE plans SET state = 'dropped' WHERE id = 'p1'")).toThrow();
      expect(migrate(db, MIGRATIONS.slice(0, 26))).toEqual([26]);
      expect(db.query("SELECT id, state FROM plans").all()).toEqual([{ id: "p1", state: "approved" }]);
      db.exec("UPDATE plans SET state = 'dropped' WHERE id = 'p1'");
      expect(() => db.exec("UPDATE plans SET state = 'gone' WHERE id = 'p1'")).toThrow();
      expect(db.query("SELECT COUNT(*) AS n FROM drops").get()).toEqual({ n: 0 });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
