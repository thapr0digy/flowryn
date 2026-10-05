import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tx } from "../../src/db/db.ts";
import { getProject } from "../../src/lifecycle/projects.ts";
import { queueTask } from "../../src/lifecycle/queued.ts";
import { failRun } from "../../src/lifecycle/runs.ts";
import { makeFleetEnv, makeRepo, type FleetEnv } from "../helpers/fleet-env.ts";
import { realTasksAxi, waitUntil } from "../helpers/harness.ts";
import { readSnapshot } from "../../src/journal/snapshot.ts";

const envs: FleetEnv[] = [];
afterEach(async () => {
  for (const env of envs.splice(0)) await env.cleanup();
});

test("a queued scout starts with dispatch --task", async () => {
  const env = await makeFleetEnv();
  envs.push(env);
  const db = env.h.db();
  tx(db, () => queueTask(db, { taskId: "web-amend-q1", title: "Amend the design", body: "Fold in the model\nFAKE: sleep 60000", kind: "scout", project: getProject(db, "web")!, priority: 2, blockedBy: [], importSource: "firstmate:web-amend-q1", now: Date.now() }));
  db.close();
  await waitUntil(() => env.h.db().query("SELECT 1 FROM intents WHERE task_id = 'web-amend-q1' AND state = 'applied'").get() !== null, 10_000, "added");
  const started = await env.json(["dispatch", "web", "--task", "web-amend-q1"]);
  expect(started.code).toBe(0);
  expect(started.reply.data).toMatchObject({ task: "web-amend-q1", state: expect.any(String) });
  const run = (started.reply.data as { run: string }).run;
  expect(env.run(run).task_id).toBe("web-amend-q1");
  const policy = env.h.db().query("SELECT kind FROM task_policy WHERE task_id = 'web-amend-q1'").get() as { kind: string };
  expect(policy.kind).toBe("scout");
});

test("dispatch --task against the wrong project refuses, naming the task's real project", async () => {
  const env = await makeFleetEnv();
  envs.push(env);
  const db = env.h.db();
  tx(db, () => queueTask(db, { taskId: "web-mismatch-q1", title: "Mismatched", body: "x", kind: "scout", project: getProject(db, "web")!, priority: null, blockedBy: [], importSource: "firstmate:web-mismatch-q1", now: Date.now() }));
  db.close();
  await waitUntil(() => env.h.db().query("SELECT 1 FROM intents WHERE task_id = 'web-mismatch-q1' AND state = 'applied'").get() !== null, 10_000, "added");
  const otherRepo = makeRepo(join(env.h.home, "other-repo"));
  const added = await env.json(["project", "add", otherRepo, "--id", "other", "--mode", "local-only"], { env: { FLOWRYN_TOKEN: env.leader } });
  expect(added.code).toBe(0);
  const result = await env.json(["dispatch", "other", "--task", "web-mismatch-q1"]);
  expect(result.code).not.toBe(0);
  expect(JSON.stringify(result.reply)).toContain("belongs to project web");
});

test("dispatch --task on a queued task still waiting for its blocker refuses, naming the blocker", async () => {
  const env = await makeFleetEnv();
  envs.push(env);
  const db = env.h.db();
  tx(db, () => {
    queueTask(db, { taskId: "web-blocker-q1", title: "The blocker", body: "x", kind: "scout", project: getProject(db, "web")!, priority: null, blockedBy: [], importSource: "firstmate:web-blocker-q1", now: Date.now() });
  });
  db.close();
  await waitUntil(() => env.h.db().query("SELECT 1 FROM intents WHERE task_id = 'web-blocker-q1' AND state = 'applied'").get() !== null, 10_000, "blocker added");
  const db2 = env.h.db();
  tx(db2, () => queueTask(db2, { taskId: "web-dependent-q1", title: "The dependent", body: "x", kind: "scout", project: getProject(db2, "web")!, priority: null, blockedBy: ["web-blocker-q1"], importSource: "firstmate:web-dependent-q1", now: Date.now() }));
  db2.close();
  await waitUntil(() => env.h.db().query("SELECT 1 FROM intents WHERE task_id = 'web-dependent-q1' AND state = 'applied'").get() !== null, 10_000, "dependent added");
  const result = await env.json(["dispatch", "web", "--task", "web-dependent-q1"]);
  expect(result.code).not.toBe(0);
  expect(JSON.stringify(result.reply)).toContain("web-blocker-q1");
});

test("a queued task whose run failed can be started again with --task (cutover C3 fix)", async () => {
  const env = await makeFleetEnv();
  envs.push(env);
  const db = env.h.db();
  tx(db, () => queueTask(db, { taskId: "web-retry-q1", title: "Retry me", body: "FAKE: sleep 60000", kind: "scout", project: getProject(db, "web")!, priority: null, blockedBy: [], importSource: "firstmate:web-retry-q1", now: Date.now() }));
  db.close();
  await waitUntil(() => env.h.db().query("SELECT 1 FROM intents WHERE task_id = 'web-retry-q1' AND state = 'applied'").get() !== null, 10_000, "added");
  const first = await env.json(["dispatch", "web", "--task", "web-retry-q1"]);
  expect(first.code).toBe(0);
  const runId = (first.reply.data as { run: string }).run;
  await env.waitRun(runId, (r) => r.worker_started_at !== null, "worker started");
  // Simulate the worker dying beyond recovery: fail the run directly, the way the reconciler would, and
  // its worktree being cleaned up afterward (a separate, already-existing mechanism this fix does not touch).
  const db2 = env.h.db();
  const worktree = env.run(runId).worktree_path;
  tx(db2, () => failRun(db2, env.run(runId), "test: forced failure", "cli", Date.now()));
  db2.close();
  rmSync(worktree, { recursive: true, force: true });
  await waitUntil(() => env.h.db().query("SELECT 1 FROM intents WHERE task_id = 'web-retry-q1' AND verb = 'hold' AND state = 'applied'").get() !== null, 10_000, "parked");
  // Queued again after the failure: show keeps the dead run's evidence and says what starts it again.
  await waitUntil(() => (readSnapshot(env.h.db(), "backlog")?.tasks ?? []).some((t) => t.id === "web-retry-q1" && t.state === "queued" && t.hold !== null), 10_000, "parked in the snapshot");
  const parked = await env.json(["show", "web-retry-q1"]);
  expect(parked.reply.data).toMatchObject({ run: runId, state: "failed", queued: "held · unhold" });
  const second = await env.json(["dispatch", "web", "--task", "web-retry-q1"]);
  expect(second.code).toBe(0);
  const secondRunId = (second.reply.data as { run: string }).run;
  expect(secondRunId).not.toBe(runId);
  expect(env.run(secondRunId).task_id).toBe("web-retry-q1");
});

type FleetData = { fleet: { id: string }[]; queued?: { id: string; kind: string; project: string; status: string; auto: string; waits: string; next: string; age: string }[] };

test("fleet lists a queued imported scout and show describes it, until dispatch starts it", async () => {
  const env = await makeFleetEnv();
  envs.push(env);
  const db = env.h.db();
  tx(db, () => queueTask(db, { taskId: "web-amend-three-column", title: "Amend the three-column design", body: "Fold in the model\nFAKE: sleep 60000", kind: "scout", project: getProject(db, "web")!, priority: 2, blockedBy: [], importSource: "firstmate:web-amend-three-column", now: Date.now() }));
  db.close();
  await waitUntil(() => (readSnapshot(env.h.db(), "backlog")?.tasks ?? []).some((t) => t.id === "web-amend-three-column"), 10_000, "in the snapshot");
  const before = await env.json(["fleet"]);
  const data = before.reply.data as FleetData;
  expect(data.fleet).toEqual([]);
  expect(data.queued).toEqual([{ id: "web-amend-three-column", kind: "scout", project: "web", status: "ready", auto: "off", waits: "-", next: "flowryn dispatch web --task web-amend-three-column", age: expect.any(String) }]);
  expect(before.reply.hints).toEqual(["flowryn show <id>", "flowryn dispatch <project> --task <id>"]);
  const shown = await env.json(["show", "web-amend-three-column"]);
  expect(shown.code).toBe(0);
  expect(shown.reply.data).toMatchObject({ task: "web-amend-three-column", title: "Amend the three-column design", state: "queued", status: "ready", kind: "scout", project: "web", workflow: "scout", priority: 2, auto: "off", blocked_by: [], waits: [], runs: [], body: "Fold in the model\nFAKE: sleep 60000" });
  expect((shown.reply.data as { filed: string }).filed).toContain("imported (firstmate:web-amend-three-column)");
  expect(shown.reply.hints).toEqual(["flowryn dispatch web --task web-amend-three-column"]);
  const started = await env.json(["dispatch", "web", "--task", "web-amend-three-column"]);
  expect(started.code).toBe(0);
  const after = (await env.json(["fleet"])).reply.data as FleetData;
  expect(after.fleet.map((f) => f.id)).toEqual(["web-amend-three-column"]);
  expect(after.queued).toBeUndefined();
});

test("show describes a waiting task and a hand-added one; fleet lists both", async () => {
  const env = await makeFleetEnv();
  envs.push(env);
  const db = env.h.db();
  tx(db, () => {
    queueTask(db, { taskId: "web-first-q1", title: "First", body: "x", kind: "ship", project: getProject(db, "web")!, priority: null, blockedBy: [], importSource: null, now: Date.now() });
    queueTask(db, { taskId: "web-second-q1", title: "Second", body: "x", kind: "ship", project: getProject(db, "web")!, priority: null, blockedBy: ["web-first-q1"], importSource: null, now: Date.now() });
  });
  db.close();
  await waitUntil(() => (readSnapshot(env.h.db(), "backlog")?.tasks ?? []).some((t) => t.id === "web-second-q1"), 10_000, "both in the snapshot");
  const added = Bun.spawnSync([realTasksAxi(), "add", "hand-note", "Tidy the docs", "--repo", "web", "--file", env.h.backlog, "--json"], { stdin: "ignore", env: process.env });
  expect(added.exitCode).toBe(0);
  await waitUntil(() => (readSnapshot(env.h.db(), "backlog")?.tasks ?? []).some((t) => t.id === "hand-note"), 10_000, "hand-added task in the snapshot");
  const waiting = await env.json(["show", "web-second-q1"]);
  expect(waiting.reply.data).toMatchObject({ state: "queued", status: "waiting", auto: "off", blocked_by: ["web-first-q1"], waits: ["web-first-q1"], next: "dispatch when unblocked" });
  expect((waiting.reply.data as { filed: string }).filed).toContain("by flowryn");
  expect(waiting.reply.hints).toEqual(["flowryn show web-first-q1"]);
  const hand = await env.json(["show", "hand-note"]);
  expect(hand.reply.data).toMatchObject({ task: "hand-note", title: "Tidy the docs", state: "queued", status: "ready", auto: "-", next: "-", filed: "by hand in backlog.md" });
  expect(hand.reply.hints ?? []).toEqual([]);
  const queued = ((await env.json(["fleet"])).reply.data as FleetData).queued!;
  // Ready rows come first; between the two ready ones, age decides (the hand task's backlog date is day-precise).
  expect(queued.slice(0, 2).map((q) => [q.id, q.status, q.waits]).toSorted()).toEqual([
    ["hand-note", "ready", "-"],
    ["web-first-q1", "ready", "-"],
  ]);
  expect(queued[2]).toMatchObject({ id: "web-second-q1", status: "waiting", waits: "web-first-q1" });
});
