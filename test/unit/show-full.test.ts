import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Args } from "../../src/api/verbs.ts";
import { openItem } from "../../src/attention/items.ts";
import { parseConfig } from "../../src/config/config.ts";
import { tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { writeSnapshot } from "../../src/journal/snapshot.ts";
import type { BacklogTask } from "../../src/journal/tasks-axi.ts";
import { LEADER_RUN_VERBS } from "../../src/lifecycle/leader-verbs.ts";
import { recordPlan } from "../../src/lifecycle/plans.ts";
import { getProject } from "../../src/lifecycle/projects.ts";
import { recordDelivery } from "../../src/lifecycle/delivery.ts";
import { getRunWithPolicy } from "../../src/lifecycle/runs.ts";
import { makeHome, type TestHome } from "../helpers/harness.ts";

let h: TestHome;
let db: Db;

const LONG_TITLE = `Make show print whole text ${"t".repeat(150)} END`;
const LONG_LINE = `a long line ${"l".repeat(400)} END`;
const LONG_BODY = [`first ${"b".repeat(200)} END`, "two", "three", "four", "five", "six", "seven, past the default six lines"].join("\n");

beforeEach(() => {
  h = makeHome();
  db = h.db();
  db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', 'u', '/w', 'main', 'no-mistakes')").run();
});

afterEach(() => {
  db.close();
  h.cleanup();
});

function show(target: string, full = false): { data: Record<string, unknown>; hints?: string[] } {
  const spec = LEADER_RUN_VERBS.find((v) => v.name === "show")!;
  const args: Args = { target, ...(full ? { full: true } : {}) };
  const ctx = { db, config: parseConfig("", h.home), now: Date.now(), caller: { role: "human" as const, runId: null, taskId: null } };
  return spec.read!(ctx, args) as { data: Record<string, unknown>; hints?: string[] };
}

function task(id: string, extra: Partial<BacklogTask> = {}): BacklogTask {
  return { id, title: id, state: "queued", kind: "ship", repo: "web", priority: null, body: "", created: null, closed: null, deps: [], hold: null, links: [], ...extra };
}

function policy(taskId: string): void {
  db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, auto, created_at) VALUES (?1, 'web', 'ship', 'no-mistakes', 0, 'fix', 0, 1)").run(taskId);
}

function run(taskId: string, id: string): void {
  db.query(
    `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
     VALUES (?1, ?2, 'claude', '1', 'running', 'busy', 'fix', 'build', '/tmp/wt', 'b', 'abc', 'h', 1, 1)`,
  ).run(id, taskId);
}

function item(line: string, ids: { taskId?: string; runId?: string } = {}): string {
  return tx(db, () => {
    const event = appendEvent(db, { source: "cli", kind: "test.item", taskId: ids.taskId ?? null, runId: ids.runId ?? null });
    return openItem(db, { kind: "worker_question", eventSeq: event.seq, line, taskId: ids.taskId ?? null, runId: ids.runId ?? null });
  });
}

function decision(id: string, taskId: string, question: string): void {
  db.query("INSERT INTO decisions (id, task_id, run_id, question, options, blocking, state, origin, key, created_at, blocks) VALUES (?1, ?2, NULL, ?3, '[\"a\",\"b\"]', 1, 'open', NULL, NULL, 1, ?4)").run(
    id,
    taskId,
    question,
    LONG_LINE,
  );
}

describe("show --full on a queued task", () => {
  test("by default the title, body and hold are cut and the view says how to see them whole", () => {
    policy("web-long-q1");
    tx(db, () => writeSnapshot(db, "backlog", "h", [task("web-long-q1", { title: LONG_TITLE, body: LONG_BODY, hold: { kind: "captain", reason: LONG_LINE, until: null } })], 1));
    const cut = show("web-long-q1").data;
    expect((cut.title as string).length).toBe(120);
    expect(cut.title).toEndWith("…");
    expect((cut.body as string).split("\n")).toHaveLength(6);
    expect(cut.truncated).toBe("flowryn show web-long-q1 --full for the complete text");
    const whole = show("web-long-q1", true).data;
    expect(whole.title).toBe(LONG_TITLE);
    expect(whole.body).toBe(LONG_BODY);
    expect(whole.hold).toBe(`captain · ${LONG_LINE}`);
    expect(whole.truncated).toBeUndefined();
  });

  test("a body ending in a newline after its sixth line has no pointer", () => {
    policy("web-six-q1");
    tx(db, () => writeSnapshot(db, "backlog", "h", [task("web-six-q1", { title: "Short", body: "one\ntwo\nthree\nfour\nfive\nsix\n" })], 1));
    const view = show("web-six-q1").data;
    expect((view.body as string).split("\n")).toHaveLength(6);
    expect(view.truncated).toBeUndefined();
  });

  test("a view that cut nothing has no pointer", () => {
    policy("web-short-q1");
    tx(db, () => writeSnapshot(db, "backlog", "h", [task("web-short-q1", { title: "Short", body: "one line" })], 1));
    expect(show("web-short-q1").data.truncated).toBeUndefined();
  });
});

describe("show --full on a run", () => {
  test("prints the whole title, steer body, question and item line", () => {
    policy("web-run-a1");
    tx(db, () => writeSnapshot(db, "backlog", "h", [task("web-run-a1", { title: LONG_TITLE, state: "in_flight" })], 1));
    run("web-run-a1", "r01RUN");
    db.query("INSERT INTO messages (id, run_id, body, created_at) VALUES ('m1', 'r01RUN', ?1, 1)").run(LONG_LINE);
    decision("q1", "web-run-a1", LONG_LINE);
    db.query("UPDATE decisions SET run_id = 'r01RUN' WHERE id = 'q1'").run();
    const itemId = item(LONG_LINE, { taskId: "web-run-a1", runId: "r01RUN" });
    const cut = show("web-run-a1").data as { title: string; steers: { body: string }[]; decisions: { question: string }[]; items: { line: string }[]; truncated?: string };
    expect(cut.title).toHaveLength(120);
    expect(cut.steers[0]!.body).toHaveLength(60);
    expect(cut.decisions[0]!.question).toHaveLength(80);
    expect(cut.items[0]!.line).toHaveLength(100);
    expect(cut.truncated).toBe("flowryn show web-run-a1 --full for the complete text");
    const whole = show("web-run-a1", true).data as typeof cut;
    expect(whole.title).toBe(LONG_TITLE);
    expect(whole.steers[0]!.body).toBe(LONG_LINE);
    expect(whole.decisions[0]!.question).toBe(LONG_LINE);
    expect(whole.items[0]!.line).toBe(LONG_LINE);
    expect(whole.truncated).toBeUndefined();
    // An item on a run shows its run; the pointer names what you asked for.
    expect(show(itemId).data).toMatchObject({ run: "r01RUN", truncated: `flowryn show ${itemId} --full for the complete text` });
  });
});

describe("show --full on an item", () => {
  test("an item keeps its whole line beside the 200-character digest line", () => {
    const id = item(LONG_LINE);
    const stored = db.query("SELECT line, full_line FROM items WHERE id = ?1").get(id) as { line: string; full_line: string | null };
    expect(stored.line).toHaveLength(200);
    expect(stored.full_line).toBe(LONG_LINE);
    expect(show(id).data).toMatchObject({ item: id, line: stored.line, truncated: `flowryn show ${id} --full for the complete text` });
    expect(show(id, true).data).toEqual({ item: id, lane: "P1", state: "open", line: LONG_LINE });
  });

  test("a delivery again rewrites the whole line along with the digest line", () => {
    policy("web-ship-a1");
    tx(db, () => writeSnapshot(db, "backlog", "h", [task("web-ship-a1", { title: LONG_TITLE, state: "in_flight" })], 1));
    run("web-ship-a1", "r01SHIP");
    tx(db, () => recordDelivery(db, getRunWithPolicy(db, "r01SHIP")!, { kind: "local", head: "abc", commits: 1 }, "test", 1));
    tx(db, () => recordDelivery(db, getRunWithPolicy(db, "r01SHIP")!, { kind: "local", head: "def", commits: 2 }, "test", 2));
    const whole = show("web-ship-a1", true).data as { items: { line: string }[] };
    expect(whole.items.map((i) => i.line)).toEqual([`Branch ready to merge: ${LONG_TITLE} (web), local-only, 2 commit(s)`]);
  });

  test("a short item stores no second copy and needs no pointer", () => {
    const id = item("short line");
    expect(db.query("SELECT full_line FROM items WHERE id = ?1").get(id)).toEqual({ full_line: null });
    expect(show(id).data.truncated).toBeUndefined();
    expect(show(id, true).data.line).toBe("short line");
  });
});

describe("show --full on a decision", () => {
  test("prints the whole question and what it blocks", () => {
    decision("k1", "web-dec-k1", LONG_LINE);
    const cut = show("k1").data;
    expect(cut.question as string).toHaveLength(200);
    expect(cut.blocks as string).toHaveLength(200);
    expect(cut.truncated).toBe("flowryn show k1 --full for the complete text");
    const whole = show("k1", true).data;
    expect(whole).toMatchObject({ decision: "k1", question: LONG_LINE, blocks: LONG_LINE });
    expect(whole.truncated).toBeUndefined();
  });
});

describe("show --full on a plan", () => {
  test("adds each phase's body, which the default view leaves out", () => {
    const filed = tx(db, () =>
      recordPlan(db, {
        project: getProject(db, "web")!,
        title: "Cart",
        phases: [{ title: "Cart API", body: LONG_BODY, workflow: null, harness: null, after: null }],
        sourceTask: null,
        gateId: null,
        workflow: "fix",
        filedBy: "leader",
        state: "pending",
        now: 5,
      }),
    );
    const cut = show(filed.id);
    expect((cut.data.phases as Record<string, unknown>[])[0]!.body).toBeUndefined();
    expect(cut.hints).toEqual(["flowryn fleet", `flowryn show ${filed.id} --full`]);
    const whole = show(filed.id, true);
    expect((whole.data.phases as Record<string, unknown>[])[0]).toMatchObject({ title: "Cart API", body: LONG_BODY });
    expect(whole.hints).toEqual(["flowryn fleet"]);
  });
});
