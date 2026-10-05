import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { composeBriefing } from "../../src/attention/briefing.ts";
import { boardFrame } from "../../src/cli/commands/board.ts";
import { openItem } from "../../src/attention/items.ts";
import { tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { writeSnapshot } from "../../src/journal/snapshot.ts";
import type { BacklogTask } from "../../src/journal/tasks-axi.ts";
import { recordPlan } from "../../src/lifecycle/plans.ts";
import { getProject } from "../../src/lifecycle/projects.ts";
import { queuedSummary, queuedTask, queuedWork, waitsCell } from "../../src/lifecycle/queue-view.ts";
import { makeHome, type TestHome } from "../helpers/harness.ts";

let h: TestHome;
let db: Db;

beforeEach(() => {
  h = makeHome();
  db = h.db();
  db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', 'u', '/w', 'main', 'no-mistakes')").run();
});

afterEach(() => {
  db.close();
  h.cleanup();
});

function task(id: string, extra: Partial<BacklogTask> = {}): BacklogTask {
  return { id, title: id, state: "queued", kind: "ship", repo: "web", priority: null, body: "", created: null, closed: null, deps: [], hold: null, links: [], ...extra };
}

function policy(taskId: string, extra: { kind?: string; auto?: number; importSource?: string | null; createdAt?: number } = {}): void {
  db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, auto, created_at, import_source) VALUES (?1, 'web', ?2, 'no-mistakes', 0, 'fix', ?3, ?4, ?5)").run(
    taskId,
    extra.kind ?? "ship",
    extra.auto ?? 0,
    extra.createdAt ?? 1,
    extra.importSource ?? null,
  );
}

function run(taskId: string, state: string, id = `r-${taskId}-${state}`): void {
  db.query(
    `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
     VALUES (?1, ?2, 'claude', '1', ?3, 'busy', 'fix', 'build', '/tmp/wt', 'b', 'abc', 'h', 1, 1)`,
  ).run(id, taskId, state);
}

function backlog(...tasks: BacklogTask[]): void {
  writeSnapshot(db, "backlog", "h", tasks, 1);
}

describe("what counts as queued", () => {
  test("a standalone decision's task is not queued work", () => {
    backlog(task("decision-a-x1", { kind: "decision" }), task("web-x-q1"));
    expect(queuedWork(db).map((q) => q.id)).toEqual(["web-x-q1"]);
  });

  test("assumption: the snapshot lags a run's start, so a task with an open run is in flight, not queued", () => {
    policy("web-started");
    run("web-started", "running");
    backlog(task("web-started"));
    expect(queuedWork(db)).toEqual([]);
    expect(queuedTask(db, "web-started")).toBeNull();
  });

  test("a task Queued again after its run failed is queued", () => {
    policy("web-retry");
    run("web-retry", "failed");
    backlog(task("web-retry", { hold: { kind: "parked", reason: "failed", until: null } }));
    expect(queuedTask(db, "web-retry")).toMatchObject({ status: "held", next: "unhold" });
  });

  test("in-flight and done tasks are not queued", () => {
    backlog(task("a", { state: "in_flight" }), task("b", { state: "done" }));
    expect(queuedWork(db)).toEqual([]);
  });
});

describe("each queued task's status", () => {
  test("a hand-added backlog task is listed with auto - and next -", () => {
    backlog(task("hand-made", { kind: null, repo: "web", created: "2026-09-01" }));
    expect(queuedTask(db, "hand-made")).toMatchObject({ kind: "-", project: "web", status: "ready", auto: "-", next: "-", filed: "backlog", createdAt: Date.parse("2026-09-01") });
  });

  test("an imported queued scout is ready to dispatch by hand", () => {
    policy("web-amend", { kind: "scout", importSource: "firstmate:web-amend" });
    backlog(task("web-amend", { kind: "scout" }));
    expect(queuedTask(db, "web-amend")).toMatchObject({ kind: "scout", status: "ready", auto: "off", next: "flowryn dispatch web --task web-amend", filed: "imported", importSource: "firstmate:web-amend" });
  });

  test("a task waits until its blockers land: a Flowryn task's run must be cleaned, a hand task done", () => {
    policy("web-blocker");
    policy("web-dependent");
    backlog(task("web-blocker"), task("hand-done", { state: "done" }), task("web-dependent", { deps: ["blocked-by:web-blocker", "blocked-by:hand-done"] }));
    expect(queuedTask(db, "web-dependent")).toMatchObject({ status: "waiting", blockedBy: ["web-blocker", "hand-done"], waits: ["web-blocker"], next: "dispatch when unblocked" });
    run("web-blocker", "cleaned");
    expect(queuedTask(db, "web-dependent")).toMatchObject({ status: "ready", waits: [] });
  });

  test("a hold wins over blockers, and the waits cell shows it", () => {
    policy("web-parked");
    backlog(task("web-parked", { deps: ["blocked-by:nope"], hold: { kind: "parked", reason: "cancelled by human", until: null } }));
    const q = queuedTask(db, "web-parked")!;
    expect(q).toMatchObject({ status: "held", next: "unhold" });
    expect(waitsCell(q)).toBe("parked: cancelled by human");
  });
});

/** An approved two-phase plan, both phases Queued in the backlog. */
function phases(): [string, string] {
  const project = getProject(db, "web")!;
  const filed = tx(db, () =>
    recordPlan(db, {
      project,
      title: "Cart",
      phases: [
        { title: "Cart API", body: "api", workflow: null, harness: null, after: null },
        { title: "Cart page", body: "page", workflow: null, harness: null, after: null },
      ],
      sourceTask: null,
      gateId: null,
      workflow: "fix",
      filedBy: "leader",
      state: "approved",
      now: 5,
    }),
  );
  const [one, two] = filed.phases.map((p) => p.task_id) as [string, string];
  backlog(task(one), task(two, { deps: [`blocked-by:${one}`] }));
  return [one, two];
}

describe("plan phases and --auto", () => {
  test("an approved phase with auto on starts by itself, or starts when unblocked", () => {
    const [one, two] = phases();
    expect(queuedTask(db, one)).toMatchObject({ status: "ready", auto: "on", next: "starts by itself", plan: { phase: 1, of: 2, title: "Cart" } });
    expect(queuedTask(db, two)).toMatchObject({ status: "waiting", auto: "on", next: "starts when unblocked", waits: [one] });
  });

  test("a ready phase that cannot start names its phase_blocked item", () => {
    const [one] = phases();
    const item = tx(db, () => {
      const event = appendEvent(db, { source: "daemon", kind: "phase.blocked", taskId: one, payload: {} });
      return openItem(db, { kind: "phase_blocked", eventSeq: event.seq, taskId: one, line: "cannot start", now: 6 });
    });
    expect(queuedTask(db, one)!.next).toBe(`cannot start (${item})`);
  });

  test("auto on in a project whose autonomy is off does not start by itself", () => {
    const [one] = phases();
    db.query("UPDATE projects SET autonomy = 'off' WHERE id = 'web'").run();
    expect(queuedTask(db, one)).toMatchObject({ auto: "on (autonomy off)", next: `flowryn dispatch web --task ${one}` });
  });

  test("assumption: a pending plan's phases never reach the backlog, so a queued phase is always approved", () => {
    const project = getProject(db, "web")!;
    const filed = tx(db, () => recordPlan(db, { project, title: "Later", phases: [{ title: "Later work", body: "x", workflow: null, harness: null, after: null }], sourceTask: null, gateId: null, workflow: "fix", filedBy: "worker", state: "pending", now: 5 }));
    const taskId = filed.phases[0]!.task_id;
    expect(db.query("SELECT 1 FROM intents WHERE task_id = ?1 AND verb = 'add'").get(taskId)).toBeNull();
  });
});

describe("ordering and the count", () => {
  test("ready first, then waiting, then held; by priority, then age", () => {
    policy("old-ready", { createdAt: 1 });
    policy("new-ready", { createdAt: 2 });
    policy("urgent-ready", { createdAt: 3 });
    policy("waiting");
    policy("held");
    backlog(
      task("held", { hold: { kind: "parked", reason: null, until: null } }),
      task("waiting", { deps: ["blocked-by:nope"] }),
      task("new-ready"),
      task("old-ready"),
      task("urgent-ready", { priority: 0 }),
    );
    expect(queuedWork(db).map((q) => q.id)).toEqual(["urgent-ready", "old-ready", "new-ready", "waiting", "held"]);
  });

  test("the summary leaves out zero parts", () => {
    expect(queuedSummary([])).toBe("0");
    backlog(task("a"), task("b", { hold: { kind: "parked", reason: null, until: null } }), task("c"));
    expect(queuedSummary(queuedWork(db))).toBe("3 (2 ready, 1 held)");
  });

  test("the briefing's count is the queued list's length", () => {
    policy("web-started");
    run("web-started", "running");
    backlog(task("web-started"), task("decision-x", { kind: "decision" }), task("a"), task("b", { deps: ["blocked-by:nope"] }));
    const text = composeBriefing(db, { session: null, now: 10, morningHour: 99, ageMs: 86_400_000, markMorning: false }).text;
    expect(text).toContain("Queued: 2 (1 ready, 1 waiting).");
    expect(queuedWork(db)).toHaveLength(2);
  });
});

describe("the board", () => {
  test("a QUEUED section lists the same set, at most 6 rows", () => {
    const tasks = Array.from({ length: 7 }, (_, i) => task(`web-q${i}`));
    policy("web-q0", { importSource: "firstmate:web-q0" });
    backlog(...tasks, task("web-held", { hold: { kind: "parked", reason: "failed", until: null } }));
    const lines = boardFrame(db, { now: 10, daemon: "down" }, 86_400_000);
    const at = lines.indexOf("QUEUED (8)");
    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 1]).toMatch(/^ {2}web-q0 +ship +web +ready +auto off · flowryn dispatch web --task web-q0$/);
    expect(lines.slice(at + 1, at + 7).every((l) => l.startsWith("  web-q"))).toBe(true);
    expect(lines[at + 7]).toBe("  +2 more (flowryn fleet)");
  });

  test("an empty queue says so", () => {
    backlog();
    const lines = boardFrame(db, { now: 10, daemon: "down" }, 86_400_000);
    expect(lines[lines.indexOf("QUEUED (0)") + 1]).toBe("  nothing queued");
  });
});
