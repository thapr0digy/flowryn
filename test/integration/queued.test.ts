import { afterEach, expect, test } from "bun:test";
import { tx } from "../../src/db/db.ts";
import { getProject } from "../../src/lifecycle/projects.ts";
import { queueTask } from "../../src/lifecycle/queued.ts";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { waitUntil } from "../helpers/harness.ts";

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
