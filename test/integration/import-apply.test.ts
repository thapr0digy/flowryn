import { afterEach, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { tx } from "../../src/db/db.ts";
import { recordIntent } from "../../src/journal/journal.ts";
import { makeOriginRepo } from "../helpers/fleet-env.ts";
import { daemonCall, makeHome, seedLeader, startDaemon, type DaemonProc, type TestHome } from "../helpers/harness.ts";

let h: TestHome;
let daemon: DaemonProc;
afterEach(async () => {
  await daemon?.kill9().catch(() => {});
  h?.cleanup();
});

function planFor(alphaPath: string) {
  return {
    projects: [{ name: "alpha", path: alphaPath, mode: "no-mistakes", yolo: true }],
    tasks: [{ id: "alpha-amend-q1", project: "alpha", kind: "scout", title: "Fold the model in", body: "x", priority: null, blockedBy: [] }],
    decisions: [{ id: "alpha-arch-r2-decision-retention", project: "alpha", origin: "alpha-arch-r2", key: "retention", question: "Confirm 365-day retention?", context: "trade-off", archived: "2026-09-20" }],
  };
}

test("dry run reports create; apply creates; a second apply reports exists", async () => {
  h = makeHome();
  daemon = await startDaemon(h);
  const alpha = makeOriginRepo(join(h.home, "alpha"));
  const plan = planFor(alpha.repo);

  const dry = await daemonCall(h.home, "import.apply", { plan: JSON.stringify(plan), dry: true });
  expect((dry.data as { rows: { action: string }[] }).rows.map((r) => r.action)).toEqual(["create", "create", "create"]);

  // A dry run writes nothing at all.
  {
    const db = h.db();
    expect(db.query("SELECT * FROM projects").all()).toEqual([]);
    expect(db.query("SELECT * FROM task_policy").all()).toEqual([]);
    expect(db.query("SELECT * FROM decisions").all()).toEqual([]);
    expect(db.query("SELECT * FROM intents WHERE task_id = ?1").all("alpha-amend-q1")).toEqual([]);
    expect(db.query("SELECT value FROM meta WHERE key = 'import_triage'").get()).toBeNull();
    db.close();
  }

  const applied = await daemonCall(h.home, "import.apply", { plan: JSON.stringify(plan), dry: false });
  expect(applied.ok).toBe(true);
  expect((applied.data as { rows: { action: string }[] }).rows.map((r) => r.action)).toEqual(["create", "create", "create"]);
  {
    const db = h.db();
    expect(db.query("SELECT value FROM meta WHERE key = 'import_triage'").get()).toEqual({ value: "1" });
    db.close();
  }

  const again = await daemonCall(h.home, "import.apply", { plan: JSON.stringify(plan), dry: false });
  expect((again.data as { rows: { action: string }[] }).rows.map((r) => r.action)).toEqual(["exists", "exists", "exists"]);

  const db = h.db();
  expect(db.query("SELECT id, delivery_mode, yolo, import_source FROM projects").all()).toEqual([{ id: "alpha", delivery_mode: "no-mistakes", yolo: 1, import_source: "firstmate:alpha" }]);
  expect(db.query("SELECT COUNT(*) AS n FROM task_policy WHERE task_id = 'alpha-amend-q1'").get()).toEqual({ n: 1 });
  expect(db.query("SELECT COUNT(*) AS n FROM intents WHERE task_id = 'alpha-amend-q1' AND verb = 'add'").get()).toEqual({ n: 1 });
  expect(db.query("SELECT import_source, origin, key FROM decisions").all()).toEqual([{ import_source: "firstmate:alpha-arch-r2-decision-retention", origin: "alpha-arch-r2", key: "retention" }]);
  db.close();
});

test("a leader cannot import", async () => {
  h = makeHome();
  const leader = seedLeader(h);
  daemon = await startDaemon(h);
  const refused = await daemonCall(h.home, "import.apply", { plan: JSON.stringify({ projects: [], tasks: [], decisions: [] }), dry: true }, leader);
  expect(refused.ok).toBe(false);
  expect(refused.error?.code).toBe("human_only");
});

test("an anonymous caller cannot import", async () => {
  h = makeHome();
  daemon = await startDaemon(h);
  const refused = await daemonCall(h.home, "import.apply", { plan: JSON.stringify({ projects: [], tasks: [], decisions: [] }), dry: true }, null, null);
  expect(refused.ok).toBe(false);
});

test("a same-named non-imported project refuses the project, its task and its decision", async () => {
  h = makeHome();
  const db0 = h.db();
  tx(db0, () => {
    db0
      .query(
        `INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode, yolo, priority, harness, workflow, autonomy)
         VALUES ('alpha', '', '/some/other/path', 'main', 'local-only', 0, 2, 'claude', 'fix', 'plan')`,
      )
      .run();
  });
  db0.close();
  daemon = await startDaemon(h);
  const alpha = makeOriginRepo(join(h.home, "alpha"));
  const plan = planFor(alpha.repo);
  const reply = await daemonCall(h.home, "import.apply", { plan: JSON.stringify(plan), dry: false });
  const rows = (reply.data as { rows: { item: string; kind: string; action: string; reason: string }[] }).rows;
  expect(rows.find((r) => r.kind === "project")?.action).toBe("refuse");
  expect(rows.find((r) => r.kind === "task")?.action).toBe("refuse");
  expect(rows.find((r) => r.kind === "task")?.reason).toContain("not imported");
  expect(rows.find((r) => r.kind === "decision")?.action).toBe("refuse");
  expect(rows.find((r) => r.kind === "decision")?.reason).toContain("not imported");
});

test("a task id already used by a non-imported task refuses", async () => {
  h = makeHome();
  const db0 = h.db();
  tx(db0, () => {
    recordIntent(db0, { file: "backlog", verb: "add", taskId: "alpha-amend-q1", positional: ["alpha-amend-q1", "pre-existing"], flags: {}, now: Date.now() });
  });
  db0.close();
  daemon = await startDaemon(h);
  const alpha = makeOriginRepo(join(h.home, "alpha"));
  const plan = planFor(alpha.repo);
  const reply = await daemonCall(h.home, "import.apply", { plan: JSON.stringify(plan), dry: false });
  const rows = (reply.data as { rows: { item: string; kind: string; action: string; reason: string }[] }).rows;
  const taskRow = rows.find((r) => r.kind === "task");
  expect(taskRow?.action).toBe("refuse");
  expect(taskRow?.reason).toContain("already used");
});

test("a same-named non-imported project previews refuse, not create, in a dry run against a missing clone target", async () => {
  h = makeHome();
  const db0 = h.db();
  tx(db0, () => {
    db0
      .query(
        `INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode, yolo, priority, harness, workflow, autonomy)
         VALUES ('alpha', '', '/some/other/path', 'main', 'local-only', 0, 2, 'claude', 'fix', 'plan')`,
      )
      .run();
  });
  db0.close();
  daemon = await startDaemon(h);
  const plan = planFor(join(h.home, "missing-clone"));
  const dry = await daemonCall(h.home, "import.apply", { plan: JSON.stringify(plan), dry: true });
  const rows = (dry.data as { rows: { item: string; kind: string; action: string; reason: string }[] }).rows;
  const projectRow = rows.find((r) => r.kind === "project");
  expect(projectRow?.action).toBe("refuse");
  expect(projectRow?.reason).toContain("already exists and was not imported");
});

test("a different-named non-imported project registered at the same checkout path refuses, naming that project", async () => {
  h = makeHome();
  daemon = await startDaemon(h);
  const alpha = makeOriginRepo(join(h.home, "alpha"));
  const db0 = h.db();
  tx(db0, () => {
    db0
      .query(
        `INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode, yolo, priority, harness, workflow, autonomy)
         VALUES ('other-alpha', '', ?1, 'main', 'local-only', 0, 2, 'claude', 'fix', 'plan')`,
      )
      .run(realpathSync(alpha.repo));
  });
  db0.close();
  const plan = planFor(alpha.repo);
  const reply = await daemonCall(h.home, "import.apply", { plan: JSON.stringify(plan), dry: false });
  const rows = (reply.data as { rows: { item: string; kind: string; action: string; reason: string }[] }).rows;
  const projectRow = rows.find((r) => r.kind === "project");
  expect(projectRow?.action).toBe("refuse");
  expect(projectRow?.reason).toContain("already registered as project other-alpha");
});

test("a decision (origin, key) already used by another decision refuses, with no relabelling", async () => {
  h = makeHome();
  daemon = await startDaemon(h);
  const alpha = makeOriginRepo(join(h.home, "alpha"));
  const plan = planFor(alpha.repo);
  const db0 = h.db();
  tx(db0, () => {
    db0
      .query(
        `INSERT INTO decisions (id, task_id, run_id, question, options, blocking, state, origin, key, created_at)
         VALUES ('k1', 'some-other-task', NULL, 'q', '[]', 1, 'open', ?1, ?2, ?3)`,
      )
      .run(plan.decisions[0]!.origin, plan.decisions[0]!.key, Date.now());
  });
  db0.close();
  const reply = await daemonCall(h.home, "import.apply", { plan: JSON.stringify(plan), dry: false });
  const rows = (reply.data as { rows: { item: string; kind: string; action: string; reason: string }[] }).rows;
  const decisionRow = rows.find((r) => r.kind === "decision");
  expect(decisionRow?.action).toBe("refuse");
  expect(decisionRow?.reason).toContain("k1");
  const db = h.db();
  expect(db.query("SELECT COUNT(*) AS n FROM decisions").get()).toEqual({ n: 1 });
  db.close();
});
