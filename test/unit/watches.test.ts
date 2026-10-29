import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { findOpenItem } from "../../src/attention/items.ts";
import { tx, type Db } from "../../src/db/db.ts";
import { writeSnapshot } from "../../src/journal/snapshot.ts";
import type { BacklogTask } from "../../src/journal/tasks-axi.ts";
import { hasLanded } from "../../src/lifecycle/plans.ts";
import { getProject } from "../../src/lifecycle/projects.ts";
import { queuedWork, waitsCell } from "../../src/lifecycle/queue-view.ts";
import {
  applyVerdict,
  blockerLabel,
  orphanReason,
  openWatch,
  ownPrVerdict,
  parseAfter,
  prVerdict,
  reportVerdict,
  setWaiter,
  watchOfTask,
  type WatchRow,
} from "../../src/lifecycle/watches.ts";
import { makeHome, type TestHome } from "../helpers/harness.ts";

let h: TestHome;
let db: Db;

beforeEach(() => {
  h = makeHome();
  db = h.db();
  db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', 'https://github.com/acme/web.git', '/w', 'main', 'no-mistakes')").run();
});

afterEach(() => {
  db.close();
  h.cleanup();
});

function task(id: string, extra: Partial<BacklogTask> = {}): BacklogTask {
  return { id, title: id, state: "queued", kind: "ship", repo: "web", priority: null, body: "", created: null, closed: null, deps: [], hold: null, links: [], ...extra };
}

function backlog(...tasks: BacklogTask[]): void {
  writeSnapshot(db, "backlog", "h", tasks, 1);
}

function run(taskId: string, state: string, startedAt = 1): string {
  db.query("INSERT OR IGNORE INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, auto, created_at) VALUES (?1, 'web', 'scout', 'no-mistakes', 0, 'scout', 0, 1)").run(taskId);
  const id = `r-${taskId}-${state}-${startedAt}`;
  db.query(
    `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
     VALUES (?1, ?2, 'claude', '1', ?3, 'busy', 'scout', 'scout', '/tmp/wt', 'b', 'abc', 'h', ?4, ?4)`,
  ).run(id, taskId, state, startedAt);
  return id;
}

function watch(event: Parameters<typeof openWatch>[1]["event"], waiter = "web-waiter-a1"): WatchRow {
  return tx(db, () => {
    const w = openWatch(db, { project: getProject(db, "web")!, event, now: 10 });
    setWaiter(db, w, waiter, "cli", 10);
    return { ...w, waiter_task: waiter };
  });
}

function settled(): void {
  db.query("UPDATE intents SET state = 'applied'").run();
}

describe("parseAfter", () => {
  test("the three forms, duplicates collapsed", () => {
    expect(parseAfter(["task:web-a-x1", "pr:112", "pr:#112", "report:scout-b-y2", "task:web-a-x1"])).toEqual({
      tasks: ["web-a-x1"],
      events: [
        { kind: "pr", number: 112 },
        { kind: "report", task: "scout-b-y2" },
      ],
    });
  });

  test.each(["112", "pr:", "pr:abc", "pr:0", "merge:112", "task:", "report:Bad Id", "web-a-x1"])("refuses %p, naming the forms", (value) => {
    expect(() => parseAfter([value])).toThrow(/task:<id> \(it lands\), pr:<number> \(it merges\) or report:<scout task>/);
  });
});

describe("openWatch", () => {
  test("a held backlog task of kind watch, its add before its hold, and a readable label", () => {
    const w = watch({ kind: "pr", number: 112 });
    expect(w.id).toBe("w1");
    expect(w.task_id).toMatch(/^after-pr-112-/);
    const intents = db.query("SELECT verb, args FROM intents WHERE task_id = ?1 ORDER BY seq").all(w.task_id) as { verb: string; args: string }[];
    expect(intents.map((i) => i.verb)).toEqual(["add", "hold"]);
    expect(intents[0]!.args).toContain("watch");
    expect(watchOfTask(db, w.task_id)).toMatchObject({ waiter_task: "web-waiter-a1", kind: "pr", target: "112", state: "open" });
    expect(blockerLabel(db, w.task_id)).toBe("PR #112 to merge");
    expect(blockerLabel(db, "web-other-x1")).toBe("web-other-x1");
    expect(watch({ kind: "report", task: "scout-b-y2" }).id).toBe("w2");
  });
});

describe("verdicts", () => {
  test("GitHub's word on a PR", () => {
    expect(prVerdict("merged")).toEqual({ fire: "merged on GitHub" });
    expect(prVerdict("closed")).toEqual({ stuck: "it was closed without merging" });
    expect(prVerdict("open")).toEqual({ waiting: true });
  });

  test("a scout's report: landed or cleaned fires, failed is stuck, running waits", () => {
    expect(reportVerdict(db, "scout-a")).toEqual({ waiting: true });
    run("scout-a", "running");
    expect(reportVerdict(db, "scout-a")).toEqual({ waiting: true });
    run("scout-b", "failed");
    expect(reportVerdict(db, "scout-b")).toMatchObject({ stuck: expect.stringContaining("failed") });
    const landed = run("scout-c", "landed");
    expect(reportVerdict(db, "scout-c")).toEqual({ fire: `report landed (run ${landed})` });
  });

  test("assumption: a scout promoted to a ship keeps its landed report, so its report wait fires while the ship runs", () => {
    const scoutRun = run("scout-p", "cleaned", 1);
    run("scout-p", "running", 2);
    expect(reportVerdict(db, "scout-p")).toEqual({ fire: `report landed (run ${scoutRun})` });
  });

  test("a PR Flowryn delivered decides from its run once it landed; otherwise GitHub does", () => {
    const url = "https://github.com/acme/web/pull/7";
    expect(ownPrVerdict(db, url)).toBeNull();
    db.query("INSERT INTO artifacts (id, task_id, kind, ref, created_at) VALUES ('a1', 'web-ship-x1', 'pr', ?1, 1)").run(url);
    const shipRun = run("web-ship-x1", "merging");
    expect(ownPrVerdict(db, url)).toBeNull();
    db.query("UPDATE runs SET state = 'landed' WHERE id = ?1").run(shipRun);
    expect(ownPrVerdict(db, url)).toEqual({ fire: "merged (web-ship-x1 landed)" });
  });
});

describe("applying a verdict", () => {
  test("fire: the watch task is unheld and done, and counts as landed before the backlog says so", () => {
    const w = watch({ kind: "pr", number: 9 });
    backlog(task(w.task_id, { kind: "watch", hold: { kind: "captain", reason: "watch w1", until: null } }));
    expect(hasLanded(db, w.task_id, [])).toBe(false);
    expect(tx(db, () => applyVerdict(db, w, { fire: "merged on GitHub" }, 20))).toBe(true);
    expect(watchOfTask(db, w.task_id)).toMatchObject({ state: "fired", detail: "merged on GitHub", ended_at: 20 });
    expect(hasLanded(db, w.task_id, [])).toBe(true);
    const verbs = (db.query("SELECT verb FROM intents WHERE task_id = ?1 ORDER BY seq").all(w.task_id) as { verb: string }[]).map((r) => r.verb);
    expect(verbs).toEqual(["add", "hold", "unhold", "done"]);
    expect(db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'watch.fired'").get()).toEqual({ n: 1 });
  });

  test("stuck: one P1 however many passes see it, cleared when it waits again, closed when it fires", () => {
    const w = watch({ kind: "pr", number: 9 });
    tx(db, () => applyVerdict(db, w, { stuck: "it was closed without merging" }, 20));
    tx(db, () => applyVerdict(db, w, { stuck: "it was closed without merging" }, 21));
    expect(db.query("SELECT COUNT(*) AS n FROM items WHERE kind = 'watch_stuck'").get()).toEqual({ n: 1 });
    const item = findOpenItem(db, "watch_stuck", w.task_id)!;
    expect(item.line).toContain("web-waiter-a1 waits for PR #9 to merge, but it was closed without merging");
    expect(watchOfTask(db, w.task_id)!.state).toBe("open");
    tx(db, () => applyVerdict(db, watchOfTask(db, w.task_id)!, { waiting: true }, 22));
    expect(findOpenItem(db, "watch_stuck", w.task_id)).toBeNull();
    expect(watchOfTask(db, w.task_id)!.detail).toBeNull();
    tx(db, () => applyVerdict(db, w, { stuck: "again" }, 23));
    tx(db, () => applyVerdict(db, w, { fire: "merged on GitHub" }, 24));
    expect(findOpenItem(db, "watch_stuck", w.task_id)).toBeNull();
  });
});

describe("orphanReason", () => {
  test("assumption: a watch just filed is not closed before its edges reach the backlog", () => {
    const w = watch({ kind: "pr", number: 9 });
    backlog();
    const pending = new Set([w.task_id, w.waiter_task]);
    expect(orphanReason(db, w, [], pending)).toBeNull();
  });

  test("kept while a queued task waits for it; closed with an rm once none does", () => {
    const w = watch({ kind: "pr", number: 9 });
    settled();
    const own = task(w.task_id, { kind: "watch" });
    const waiter = task(w.waiter_task, { deps: [`blocked-by:${w.task_id}`] });
    expect(orphanReason(db, w, [own, waiter], new Set())).toBeNull();
    expect(orphanReason(db, w, [own, { ...waiter, deps: [] }], new Set())).toEqual({ why: "no queued task waits for it", removeTask: true });
    db.query("INSERT INTO drops (task_id, title, reason, dropped_by, unblocked, dropped_at) VALUES (?1, 't', 'r', 'leader', '[]', 1)").run(w.waiter_task);
    expect(orphanReason(db, w, [own], new Set())).toEqual({ why: `${w.waiter_task} was dropped`, removeTask: true });
  });

  test("its own task dropped or completed by hand: closed without another backlog write", () => {
    const w = watch({ kind: "pr", number: 9 });
    settled();
    const waiter = task(w.waiter_task, { deps: [`blocked-by:${w.task_id}`] });
    expect(orphanReason(db, w, [task(w.task_id, { state: "done" }), waiter], new Set())).toEqual({ why: "its task was completed by hand", removeTask: false });
    expect(orphanReason(db, w, [waiter], new Set())).toEqual({ why: "its task left the backlog", removeTask: false });
    db.query("INSERT INTO drops (task_id, title, reason, dropped_by, unblocked, dropped_at) VALUES (?1, 't', 'r', 'leader', '[]', 1)").run(w.task_id);
    expect(orphanReason(db, w, [waiter], new Set())).toEqual({ why: "its task was dropped", removeTask: false });
  });
});

describe("the queue", () => {
  test("a watch's task is not queued work, and the waiting task shows it in words", () => {
    const w = watch({ kind: "pr", number: 112 });
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, auto, created_at) VALUES (?1, 'web', 'ship', 'no-mistakes', 0, 'fix', 1, 1)").run(w.waiter_task);
    // The kind is what tasks-axi reports; the watches table decides even when the snapshot lacks it.
    backlog(task(w.task_id, { kind: null as unknown as string }), task(w.waiter_task, { deps: [`blocked-by:${w.task_id}`, "blocked-by:web-other-x1"] }));
    const queued = queuedWork(db);
    expect(queued.map((q) => q.id)).toEqual([w.waiter_task]);
    expect(queued[0]!.waits).toEqual([w.task_id, "web-other-x1"]);
    expect(waitsCell(queued[0]!)).toBe("PR #112 to merge, web-other-x1");
  });
});
