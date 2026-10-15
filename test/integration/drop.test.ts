import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tx } from "../../src/db/db.ts";
import { readSnapshot } from "../../src/journal/snapshot.ts";
import { getProject } from "../../src/lifecycle/projects.ts";
import { queueTask } from "../../src/lifecycle/queued.ts";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { waitUntil } from "../helpers/harness.ts";

const envs: FleetEnv[] = [];
afterEach(async () => {
  for (const env of envs.splice(0)) await env.cleanup();
});

function inSnapshot(env: FleetEnv, id: string): boolean {
  return (readSnapshot(env.h.db(), "backlog")?.tasks ?? []).some((t) => t.id === id);
}

test("flowryn drop through the CLI: refuses started work and a missing reason, drops a queued task and a plan, and the backlog follows", async () => {
  const env = await makeFleetEnv();
  envs.push(env);
  const db = env.h.db();
  tx(db, () => {
    queueTask(db, { taskId: "web-base-q1", title: "The base", body: "x", kind: "ship", project: getProject(db, "web")!, priority: null, blockedBy: [], now: Date.now() });
    queueTask(db, { taskId: "web-next-q1", title: "The next", body: "x", kind: "ship", project: getProject(db, "web")!, priority: null, blockedBy: ["web-base-q1"], now: Date.now() });
  });
  db.close();
  await waitUntil(() => inSnapshot(env, "web-next-q1"), 10_000, "queued tasks in the snapshot");
  // The shape of the duplicate that started this: a dispatch that waits is a one-phase plan.
  const filed = await env.json(["dispatch", "web", "--kind", "ship", "--blocked-by", "web-base-q1", "--body-file", "-"], { stdin: "Duplicate work\nFAKE: sleep 60000" });
  expect(filed.code).toBe(0);
  const plan = String((filed.reply.data as { plan: string }).plan);
  const phase = (env.h.db().query("SELECT task_id FROM plan_phases WHERE plan_id = ?1").get(plan) as { task_id: string }).task_id;
  await waitUntil(() => inSnapshot(env, phase), 10_000, "the plan's phase in the snapshot");
  const live = await env.dispatch("Busy work\nFAKE: sleep 60000");

  const started = await env.json(["drop", live.task, "--body-file", "-"], { stdin: "not wanted" });
  expect(started.code).toBe(2);
  expect(started.reply).toMatchObject({ error: { code: "task_started" } });

  const noReason = await env.json(["drop", "web-base-q1"]);
  expect(noReason.code).toBe(3);
  expect(JSON.stringify(noReason.reply)).toContain("say why it is dropped");

  const blocking = await env.json(["drop", "web-base-q1", "--body-file", "-"], { stdin: "superseded" });
  expect(blocking.code).toBe(2);
  expect(blocking.reply).toMatchObject({ error: { code: "has_dependents" } });
  expect(JSON.stringify(blocking.reply)).toContain("web-next-q1");
  expect(JSON.stringify(blocking.reply)).toContain(phase);

  const planDrop = await env.json(["drop", plan, "--body-file", "-"], { stdin: "duplicate of web-base-q1" });
  expect(planDrop.code).toBe(0);
  expect(planDrop.reply.data).toMatchObject({ plan, dropped: [phase], unblocked: [], backlog: "rm" });
  const taskDrop = await env.json(["drop", "web-next-q1", "--body-file", "-"], { stdin: "no longer needed" });
  expect(taskDrop.code).toBe(0);
  const baseDrop = await env.json(["drop", "web-base-q1", "--body-file", "-"], { stdin: "superseded" });
  expect(baseDrop.code).toBe(0);

  await waitUntil(() => !inSnapshot(env, "web-base-q1") && !inSnapshot(env, "web-next-q1") && !inSnapshot(env, phase), 10_000, "the drops applied");
  const backlog = readFileSync(env.h.backlog, "utf8");
  for (const id of ["web-base-q1", "web-next-q1", phase]) expect(backlog).not.toContain(id);
  expect(backlog).toContain(live.task);
  // assumption: the journal's rm is Flowryn's own write, so the watcher and the invariant raise no divergence.
  expect(env.h.db().query("SELECT COUNT(*) AS n FROM divergences").get()).toEqual({ n: 0 });
  expect(env.h.db().query("SELECT state FROM plans WHERE id = ?1").get(plan)).toEqual({ state: "dropped" });

  const shown = await env.json(["show", "web-base-q1"]);
  expect(shown.code).toBe(0);
  expect(shown.reply.data).toMatchObject({ task: "web-base-q1", title: "The base", state: "dropped", reason: "superseded" });
  const fleet = (await env.json(["fleet"])).reply.data as { queued?: { id: string }[] };
  expect((fleet.queued ?? []).map((q) => q.id)).toEqual([]);
  const again = await env.json(["dispatch", "web", "--task", "web-base-q1"]);
  expect(again.code).toBe(4);
  expect(JSON.stringify(again.reply)).toContain("was dropped");
});
