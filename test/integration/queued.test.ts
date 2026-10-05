import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tx } from "../../src/db/db.ts";
import { getProject } from "../../src/lifecycle/projects.ts";
import { queueTask } from "../../src/lifecycle/queued.ts";
import { failRun } from "../../src/lifecycle/runs.ts";
import { makeFleetEnv, makeRepo, type FleetEnv } from "../helpers/fleet-env.ts";
import { waitUntil } from "../helpers/harness.ts";

const envs: FleetEnv[] = [];
afterEach(async () => {
  for (const env of envs.splice(0)) await env.cleanup();
});

test("a queued scout starts with dispatch --task", async () => {
  const env = await makeFleetEnv();
  envs.push(env);
  const db = env.h.db();
  tx(db, () => queueTask(db, { taskId: "web-amend-q1", title: "Amend the design", body: "Fold in the model\nFAKE: sleep 60000", kind: "scout", project: getProject(db, "web")!, priority: 2, blockedBy: [], now: Date.now() }));
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
  tx(db, () => queueTask(db, { taskId: "web-mismatch-q1", title: "Mismatched", body: "x", kind: "scout", project: getProject(db, "web")!, priority: null, blockedBy: [], now: Date.now() }));
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
    queueTask(db, { taskId: "web-blocker-q1", title: "The blocker", body: "x", kind: "scout", project: getProject(db, "web")!, priority: null, blockedBy: [], now: Date.now() });
  });
  db.close();
  await waitUntil(() => env.h.db().query("SELECT 1 FROM intents WHERE task_id = 'web-blocker-q1' AND state = 'applied'").get() !== null, 10_000, "blocker added");
  const db2 = env.h.db();
  tx(db2, () => queueTask(db2, { taskId: "web-dependent-q1", title: "The dependent", body: "x", kind: "scout", project: getProject(db2, "web")!, priority: null, blockedBy: ["web-blocker-q1"], now: Date.now() }));
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
  tx(db, () => queueTask(db, { taskId: "web-retry-q1", title: "Retry me", body: "FAKE: sleep 60000", kind: "scout", project: getProject(db, "web")!, priority: null, blockedBy: [], now: Date.now() }));
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
  const second = await env.json(["dispatch", "web", "--task", "web-retry-q1"]);
  expect(second.code).toBe(0);
  const secondRunId = (second.reply.data as { run: string }).run;
  expect(secondRunId).not.toBe(runId);
  expect(env.run(secondRunId).task_id).toBe("web-retry-q1");
});
