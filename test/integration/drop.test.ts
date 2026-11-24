import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tx } from "../../src/db/db.ts";
import { readSnapshot } from "../../src/journal/snapshot.ts";
import { getProject } from "../../src/lifecycle/projects.ts";
import { queueTask } from "../../src/lifecycle/queued.ts";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { waitUntil } from "../helpers/harness.ts";
import { useIntegrationTimeout } from "../helpers/integration-timeout.ts";

useIntegrationTimeout();

const envs: FleetEnv[] = [];
afterEach(async () => {
  for (const env of envs.splice(0)) await env.cleanup();
});

function inSnapshot(env: FleetEnv, id: string): boolean {
  return (readSnapshot(env.h.db(), "backlog")?.tasks ?? []).some((t) => t.id === id);
}

// A daemon, a dozen CLI calls and three journal waits: 3-5 s alone, 9-13 s with every core busy, past bun's 5 s default.
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
}, 60_000);

// The shape that misled an audit (p9): one phase ran, the rest were dropped one task at a time; `show` must say so.
test("flowryn show <plan> through the CLI: dropped phases read dropped, and a plan with nothing left to run reads finished", async () => {
  const env = await makeFleetEnv();
  envs.push(env);
  expect((await env.json(["project", "set", "web", "--autonomy", "manual"])).code).toBe(0);
  const filed = await env.json(["plan", "web", "--body-file", "-"], { stdin: "# Three steps\n## Phase 1: Ran\nx\n## Phase 2: Edges\nx\n## Phase 3: Cutover\nx\n" });
  expect(filed.code).toBe(0);
  const { plan, phases } = filed.reply.data as { plan: string; phases: { task: string }[] };
  const [first, second, third] = phases.map((p) => p.task);
  await waitUntil(() => inSnapshot(env, third!), 10_000, "the plan's phases in the snapshot");
  env.h
    .db()
    .query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
       VALUES ('r-ran', ?1, 'claude', '1', 'cancelled', 'dead', 'fix', 'build', '/tmp/wt', 'b', 'abc', 'r-ran', 1, 1)`,
    )
    .run(first!);

  for (const task of [third!, second!]) {
    const dropped = await env.json(["drop", task, "--body-file", "-"], { stdin: "superseded by p12\nthe long story" });
    expect(dropped.code).toBe(0);
    await waitUntil(() => !inSnapshot(env, task), 10_000, `${task}'s rm applied`);
  }

  const shown = await env.json(["show", plan]);
  expect(shown.code).toBe(0);
  const data = shown.reply.data as { state: string; phases: { task: string; at: string }[] };
  expect(data.state).toBe("finished");
  const at = data.phases.map((p) => p.at);
  expect(at[0]).toBe("cancelled · build active");
  for (const line of at.slice(1)) expect(line).toMatch(/^dropped · \d+s ago · superseded by p12$/);
  expect(JSON.stringify(data)).not.toContain("waits for");
}, 60_000);
