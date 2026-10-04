import { afterEach, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { tx } from "../../src/db/db.ts";
import { recordIntent } from "../../src/journal/journal.ts";
import { readSnapshot } from "../../src/journal/snapshot.ts";
import { makeOriginRepo } from "../helpers/fleet-env.ts";
import { daemonCall, makeHome, seedLeader, startDaemon, waitUntil, type DaemonProc, type TestHome } from "../helpers/harness.ts";

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
  // decision.opened carries the import source directly (no separate UPDATE after the insert).
  const opened = db.query("SELECT payload FROM events WHERE kind = 'decision.opened'").get() as { payload: string };
  expect(JSON.parse(opened.payload)).toMatchObject({ import_source: "firstmate:alpha-arch-r2-decision-retention" });
  db.close();
});

test("omitting dry behaves as a dry run (fail-safe default): nothing is written", async () => {
  h = makeHome();
  daemon = await startDaemon(h);
  const alpha = makeOriginRepo(join(h.home, "alpha"));
  const plan = planFor(alpha.repo);
  const reply = await daemonCall(h.home, "import.apply", { plan: JSON.stringify(plan) });
  expect(reply.ok).toBe(true);
  expect((reply.data as { rows: { action: string }[] }).rows.map((r) => r.action)).toEqual(["create", "create", "create"]);
  const db = h.db();
  expect(db.query("SELECT * FROM projects").all()).toEqual([]);
  expect(db.query("SELECT * FROM decisions").all()).toEqual([]);
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

test("a decision key tasks-axi would refuse refuses as a plan row, dry and real, rather than aborting the apply", async () => {
  h = makeHome();
  daemon = await startDaemon(h);
  const alpha = makeOriginRepo(join(h.home, "alpha"));
  const plan = planFor(alpha.repo);
  plan.decisions[0]!.key = "Not Valid!";

  const dry = await daemonCall(h.home, "import.apply", { plan: JSON.stringify(plan), dry: true });
  expect(dry.ok).toBe(true);
  const dryRows = (dry.data as { rows: { kind: string; action: string; reason: string }[] }).rows;
  const dryDecision = dryRows.find((r) => r.kind === "decision")!;
  expect(dryDecision.action).toBe("refuse");
  expect(dryDecision.reason).toContain("must be lowercase letters, digits and dashes");

  const real = await daemonCall(h.home, "import.apply", { plan: JSON.stringify(plan), dry: false });
  expect(real.ok).toBe(true);
  const realRows = (real.data as { rows: { kind: string; action: string }[] }).rows;
  expect(realRows.find((r) => r.kind === "project")?.action).toBe("create");
  expect(realRows.find((r) => r.kind === "task")?.action).toBe("create");
  expect(realRows.find((r) => r.kind === "decision")?.action).toBe("refuse");
  const db = h.db();
  expect(db.query("SELECT COUNT(*) AS n FROM decisions").get()).toEqual({ n: 0 });
  db.close();
});

test("a dependent task listed before its blocker in the plan still creates both, with the edge intact (cutover C3 fix 3)", async () => {
  h = makeHome();
  daemon = await startDaemon(h);
  const alpha = makeOriginRepo(join(h.home, "alpha"));
  const plan = {
    projects: [{ name: "alpha", path: alpha.repo, mode: "no-mistakes", yolo: true }],
    tasks: [
      { id: "alpha-dep-q1", project: "alpha", kind: "scout", title: "The dependent", body: "x", priority: null, blockedBy: ["alpha-blocker-q1"] },
      { id: "alpha-blocker-q1", project: "alpha", kind: "scout", title: "The blocker", body: "x", priority: null, blockedBy: [] },
    ],
    decisions: [],
  };
  const reply = await daemonCall(h.home, "import.apply", { plan: JSON.stringify(plan), dry: false });
  expect(reply.ok).toBe(true);
  const rows = (reply.data as { rows: { item: string; kind: string; action: string }[] }).rows;
  const taskRows = rows.filter((r) => r.kind === "task");
  expect(taskRows.map((r) => r.item)).toEqual(["alpha-dep-q1", "alpha-blocker-q1"]);
  expect(taskRows.map((r) => r.action)).toEqual(["create", "create"]);
  await waitUntil(
    () => {
      const row = h.db().query("SELECT state FROM intents WHERE task_id = 'alpha-dep-q1' AND verb = 'add'").get() as { state: string } | null;
      return row !== null && row.state !== "pending";
    },
    10_000,
    "dependent intent settled",
  );
  const settled = h.db().query("SELECT state, last_error FROM intents WHERE task_id = 'alpha-dep-q1' AND verb = 'add'").get();
  expect(settled).toMatchObject({ state: "applied" });
});

test("a refused blocker drops the blocked-by edge with a warn row; the dependent still creates", async () => {
  h = makeHome();
  const db0 = h.db();
  tx(db0, () => {
    recordIntent(db0, { file: "backlog", verb: "add", taskId: "alpha-blocker-q1", positional: ["alpha-blocker-q1", "pre-existing, not imported"], flags: {}, now: Date.now() });
  });
  db0.close();
  daemon = await startDaemon(h);
  const alpha = makeOriginRepo(join(h.home, "alpha"));
  const plan = {
    projects: [{ name: "alpha", path: alpha.repo, mode: "no-mistakes", yolo: true }],
    tasks: [
      { id: "alpha-blocker-q1", project: "alpha", kind: "scout", title: "The blocker", body: "x", priority: null, blockedBy: [] },
      { id: "alpha-dep-q1", project: "alpha", kind: "scout", title: "The dependent", body: "x", priority: null, blockedBy: ["alpha-blocker-q1"] },
    ],
    decisions: [],
  };
  const reply = await daemonCall(h.home, "import.apply", { plan: JSON.stringify(plan), dry: false });
  expect(reply.ok).toBe(true);
  const rows = (reply.data as { rows: { item: string; kind: string; action: string; reason: string }[] }).rows;
  const blocker = rows.find((r) => r.item === "alpha-blocker-q1" && r.kind === "task")!;
  expect(blocker.action).toBe("refuse");
  const dependent = rows.find((r) => r.item === "alpha-dep-q1" && r.action === "create")!;
  expect(dependent).toBeTruthy();
  const warning = rows.find((r) => r.item === "alpha-dep-q1" && r.action === "warn")!;
  expect(warning.reason).toContain("blocked-by alpha-blocker-q1 dropped");
  await waitUntil(() => h.db().query("SELECT 1 FROM intents WHERE task_id = 'alpha-dep-q1' AND state = 'applied'").get() !== null, 10_000, "dependent intent applied");
  const db = h.db();
  const task = (readSnapshot(db, "backlog")?.tasks ?? []).find((t) => t.id === "alpha-dep-q1");
  db.close();
  expect(task?.deps.some((d) => d.includes("alpha-blocker-q1"))).toBe(false);
});

test("a dropped-blocker warning is reported once, even when the dependent's resolution takes several passes", async () => {
  h = makeHome();
  const db0 = h.db();
  tx(db0, () => {
    recordIntent(db0, { file: "backlog", verb: "add", taskId: "alpha-blocker-bad-q1", positional: ["alpha-blocker-bad-q1", "pre-existing, not imported"], flags: {}, now: Date.now() });
  });
  db0.close();
  daemon = await startDaemon(h);
  const alpha = makeOriginRepo(join(h.home, "alpha"));
  // alpha-final-q1 is listed first and depends on a refused blocker plus the end of a 3-task chain, so its
  // own resolution is deliberately deferred across several passes of the while loop in apply.ts.
  const plan = {
    projects: [{ name: "alpha", path: alpha.repo, mode: "no-mistakes", yolo: true }],
    tasks: [
      { id: "alpha-final-q1", project: "alpha", kind: "scout", title: "Final", body: "x", priority: null, blockedBy: ["alpha-blocker-bad-q1", "alpha-chain-3-q1"] },
      { id: "alpha-chain-1-q1", project: "alpha", kind: "scout", title: "Chain 1", body: "x", priority: null, blockedBy: [] },
      { id: "alpha-chain-2-q1", project: "alpha", kind: "scout", title: "Chain 2", body: "x", priority: null, blockedBy: ["alpha-chain-1-q1"] },
      { id: "alpha-chain-3-q1", project: "alpha", kind: "scout", title: "Chain 3", body: "x", priority: null, blockedBy: ["alpha-chain-2-q1"] },
    ],
    decisions: [],
  };
  const reply = await daemonCall(h.home, "import.apply", { plan: JSON.stringify(plan), dry: false });
  expect(reply.ok).toBe(true);
  const rows = (reply.data as { rows: { item: string; kind: string; action: string; reason: string }[] }).rows;
  expect(rows.filter((r) => r.item === "alpha-final-q1" && r.action === "create")).toHaveLength(1);
  const warnings = rows.filter((r) => r.item === "alpha-final-q1" && r.action === "warn");
  expect(warnings).toHaveLength(1);
  expect(warnings[0]!.reason).toContain("blocked-by alpha-blocker-bad-q1 dropped");
});

test("two tasks blocking each other refuse with blocked-by cycle; an unrelated task still creates", async () => {
  h = makeHome();
  daemon = await startDaemon(h);
  const alpha = makeOriginRepo(join(h.home, "alpha"));
  const plan = {
    projects: [{ name: "alpha", path: alpha.repo, mode: "no-mistakes", yolo: true }],
    tasks: [
      { id: "alpha-cycle-a-q1", project: "alpha", kind: "scout", title: "A", body: "x", priority: null, blockedBy: ["alpha-cycle-b-q1"] },
      { id: "alpha-cycle-b-q1", project: "alpha", kind: "scout", title: "B", body: "x", priority: null, blockedBy: ["alpha-cycle-a-q1"] },
      { id: "alpha-plain-q1", project: "alpha", kind: "scout", title: "Plain", body: "x", priority: null, blockedBy: [] },
    ],
    decisions: [],
  };
  const reply = await daemonCall(h.home, "import.apply", { plan: JSON.stringify(plan), dry: false });
  expect(reply.ok).toBe(true);
  const rows = (reply.data as { rows: { item: string; kind: string; action: string; reason: string }[] }).rows;
  expect(rows.find((r) => r.item === "alpha-cycle-a-q1")).toMatchObject({ action: "refuse", reason: "blocked-by cycle" });
  expect(rows.find((r) => r.item === "alpha-cycle-b-q1")).toMatchObject({ action: "refuse", reason: "blocked-by cycle" });
  expect(rows.find((r) => r.item === "alpha-plain-q1")).toMatchObject({ action: "create" });
});

test("a task blocked-by a decision's own Firstmate item id is remapped to the decision's real task id (cutover C3 fix 4)", async () => {
  h = makeHome();
  daemon = await startDaemon(h);
  const alpha = makeOriginRepo(join(h.home, "alpha"));
  const plan = {
    projects: [{ name: "alpha", path: alpha.repo, mode: "no-mistakes", yolo: true }],
    tasks: [{ id: "alpha-dep-q1", project: "alpha", kind: "scout", title: "Waits on the decision", body: "x", priority: null, blockedBy: ["alpha-arch-r2-decision-retention"] }],
    decisions: [{ id: "alpha-arch-r2-decision-retention", project: "alpha", origin: "alpha-arch-r2", key: "retention", question: "Confirm 365-day retention?", context: "trade-off", archived: "2026-09-20" }],
  };
  const reply = await daemonCall(h.home, "import.apply", { plan: JSON.stringify(plan), dry: false });
  expect(reply.ok).toBe(true);
  const rows = (reply.data as { rows: { item: string; kind: string; action: string }[] }).rows;
  expect(rows.find((r) => r.item === "alpha-dep-q1")).toMatchObject({ action: "create" });
  expect(rows.find((r) => r.item === "alpha-arch-r2-decision-retention" && r.kind === "decision")).toMatchObject({ action: "create" });
  expect(rows.some((r) => r.item === "alpha-dep-q1" && r.action === "warn")).toBe(false);
  await waitUntil(() => h.db().query("SELECT 1 FROM intents WHERE task_id = 'alpha-dep-q1' AND state = 'applied'").get() !== null, 10_000, "dependent intent applied");
  const db = h.db();
  const decisionTaskId = (db.query("SELECT task_id FROM decisions WHERE import_source = ?1").get("firstmate:alpha-arch-r2-decision-retention") as { task_id: string }).task_id;
  const task = (readSnapshot(db, "backlog")?.tasks ?? []).find((t) => t.id === "alpha-dep-q1");
  db.close();
  // The Firstmate item id never becomes a real blocked-by edge: only the decision's own real task id does.
  expect(task?.deps.some((d) => d.includes(decisionTaskId))).toBe(true);
  expect(task?.deps.some((d) => d.includes("alpha-arch-r2-decision-retention"))).toBe(false);
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
