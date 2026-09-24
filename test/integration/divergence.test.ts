/**
 * Divergences between the backlog and the runs (design section 8): a hand
 * edit against a live run, and the reconciler's invariant pass ("a task is In
 * flight if and only if it has a non-terminal run"), each settled with
 * `flowryn divergence resolve <id> keep-run|accept-edit`. The daemon,
 * journal, watcher and tasks-axi are real; the worker is the fake harness.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { listTasks, processRunner, type BacklogTask } from "../../src/journal/tasks-axi.ts";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { realTasksAxi, waitUntil } from "../helpers/harness.ts";

const envs: FleetEnv[] = [];
async function fleet(options: Parameters<typeof makeFleetEnv>[0] = {}): Promise<FleetEnv> {
  const env = await makeFleetEnv(options);
  envs.push(env);
  return env;
}
afterEach(async () => {
  for (const env of envs.splice(0)) await env.cleanup();
});

interface DivergenceView {
  id: string;
  run_id: string | null;
  task_id: string | null;
  higher: string;
  lower: string;
  summary: string;
  resolved_at: number | null;
  resolution: string | null;
}

function divergences(env: FleetEnv): DivergenceView[] {
  const db = env.h.db();
  try {
    return db.query("SELECT * FROM divergences ORDER BY opened_at, id").all() as DivergenceView[];
  } finally {
    db.close();
  }
}

function divergenceItems(env: FleetEnv): { id: string; state: string; line: string }[] {
  const db = env.h.db();
  try {
    return db.query("SELECT id, state, line FROM items WHERE kind = 'divergence' ORDER BY opened_at").all() as { id: string; state: string; line: string }[];
  } finally {
    db.close();
  }
}

async function backlogTask(env: FleetEnv, taskId: string): Promise<BacklogTask | null> {
  const tasks = await listTasks(processRunner(realTasksAxi(), Bun.which("node")), env.h.backlog);
  return tasks.find((t) => t.id === taskId) ?? null;
}

/** An edit made outside Flowryn: tasks-axi run by hand on the backlog file. */
function byHand(env: FleetEnv, args: string[]): void {
  const result = Bun.spawnSync([realTasksAxi(), ...args, "--file", env.h.backlog, "--json"], { stdin: "ignore", env: process.env });
  if (result.exitCode !== 0) throw new Error(`tasks-axi ${args.join(" ")} failed: ${result.stdout.toString()}`);
}

async function inFlight(env: FleetEnv, task: string): Promise<void> {
  await waitUntil(async () => (await backlogTask(env, task))?.state === "in_flight", 10_000, `${task} In flight`);
}

async function resolve(env: FleetEnv, id: string, resolution: string) {
  return env.json(["divergence", "resolve", id, resolution]);
}

describe("a hand edit against a live run", () => {
  test(
    "keep-run: the run's state wins and the task goes back In flight; the divergence and its P1 close",
    async () => {
      const env = await fleet();
      const { task, run } = await env.dispatch("Scout\nFAKE: sleep 30000");
      await env.waitRun(run, (r) => r.liveness === "busy", "busy");
      await inFlight(env, task);
      byHand(env, ["done", task]);
      await waitUntil(() => divergences(env).some((d) => d.task_id === task && d.resolved_at === null), 10_000, "the divergence");
      const [d] = divergences(env);
      expect(d).toMatchObject({ run_id: run, higher: "run", lower: "backlog" });
      expect(divergenceItems(env)[0]!.line).toContain(`flowryn divergence resolve ${d!.id} keep-run|accept-edit`);
      const shown = await env.json(["show", d!.id]);
      expect(shown.reply.data).toMatchObject({ divergence: d!.id, state: "open", resolve: `flowryn divergence resolve ${d!.id} keep-run|accept-edit` });
      // The run is untouched meanwhile.
      await Bun.sleep(800);
      expect(env.run(run)).toMatchObject({ state: "running", liveness: "busy" });

      const resolved = await resolve(env, d!.id, "keep-run");
      expect(resolved.code).toBe(0);
      expect(resolved.reply.data).toMatchObject({ divergence: d!.id, resolution: "keep-run", backlog: "start" });
      await inFlight(env, task);
      expect(divergences(env)[0]).toMatchObject({ resolution: "keep-run" });
      expect(divergences(env)[0]!.resolved_at).not.toBeNull();
      expect(divergenceItems(env)[0]!.state).toBe("resolved");
      expect(env.run(run).state).toBe("running");
      // Settled means settled: the next passes raise nothing new.
      await Bun.sleep(1_000);
      expect(divergences(env)).toHaveLength(1);
      const again = await resolve(env, d!.id, "keep-run");
      expect(again.code).toBe(3);
    },
    { timeout: 45_000 },
  );

  test(
    "keep-run on a task deleted by hand adds it back In flight, as it was dispatched",
    async () => {
      const env = await fleet();
      const { task, run } = await env.dispatch("Scout the cache layer\nFAKE: sleep 30000");
      await env.waitRun(run, (r) => r.liveness === "busy", "busy");
      await inFlight(env, task);
      byHand(env, ["rm", task]);
      await waitUntil(() => divergences(env).some((d) => d.task_id === task), 10_000, "the divergence");
      expect((await resolve(env, divergences(env)[0]!.id, "keep-run")).reply.data).toMatchObject({ backlog: "add" });
      await inFlight(env, task);
      expect((await backlogTask(env, task))!.title).toContain("Scout the cache layer");
    },
    { timeout: 45_000 },
  );

  test(
    "accept-edit: your edit wins; the run is cancelled, its worker stopped, and the backlog stays as you left it",
    async () => {
      const env = await fleet();
      const { task, run } = await env.dispatch("Scout\nFAKE: sleep 30000");
      const busy = await env.waitRun(run, (r) => r.liveness === "busy", "busy");
      await inFlight(env, task);
      byHand(env, ["reopen", task]);
      await waitUntil(() => divergences(env).some((d) => d.task_id === task), 10_000, "the divergence");
      const resolved = await resolve(env, divergences(env)[0]!.id, "accept-edit");
      expect(resolved.code).toBe(0);
      expect(resolved.reply.data).toMatchObject({ resolution: "accept-edit", cancelled: run });
      expect(env.run(run)).toMatchObject({ state: "cancelled" });
      await waitUntil(() => env.herdr.harnessPid(busy.pane_id!) === null, 10_000, "the worker gone");
      // No parked hold: the task stays Queued exactly as edited, and the worktree waits for the cleanup guard.
      await Bun.sleep(1_000);
      const after = await backlogTask(env, task);
      expect(after).toMatchObject({ state: "queued", hold: null });
      expect(existsSync(busy.worktree_path)).toBe(true);
      expect(divergences(env)).toHaveLength(1);
    },
    { timeout: 45_000 },
  );

  test(
    "the edit undone by hand: the invariant holds again and the divergence closes by itself",
    async () => {
      const env = await fleet();
      const { task, run } = await env.dispatch("Scout\nFAKE: sleep 30000");
      await env.waitRun(run, (r) => r.liveness === "busy", "busy");
      await inFlight(env, task);
      byHand(env, ["reopen", task]);
      await waitUntil(() => divergences(env).some((d) => d.task_id === task), 10_000, "the divergence");
      byHand(env, ["start", task]);
      await waitUntil(() => divergences(env)[0]!.resolution === "agrees", 10_000, "the divergence settled by the reconciler");
      expect(divergenceItems(env)[0]!.state).toBe("resolved");
    },
    { timeout: 45_000 },
  );
});

describe("the invariant pass: In flight if and only if a non-terminal run", () => {
  test(
    "a task put In flight by hand with no run is a divergence; keep-run sends it back to Queued",
    async () => {
      const env = await fleet();
      byHand(env, ["add", "stray-task-z9", "A task nobody runs", "--start"]);
      await waitUntil(() => divergences(env).some((d) => d.task_id === "stray-task-z9"), 10_000, "the invariant divergence");
      const d = divergences(env).find((x) => x.task_id === "stray-task-z9")!;
      expect(d).toMatchObject({ run_id: null, higher: "run", lower: "backlog" });
      expect(d.summary).toContain("In flight in the backlog but has no live run (Flowryn never ran it)");
      expect((await resolve(env, d.id, "keep-run")).reply.data).toMatchObject({ backlog: "reopen" });
      await waitUntil(async () => (await backlogTask(env, "stray-task-z9"))?.state === "queued", 10_000, "back to Queued");
    },
    { timeout: 30_000 },
  );

  test(
    "accept-edit keeps it In flight, and the pass does not raise it again",
    async () => {
      const env = await fleet();
      byHand(env, ["add", "mine-a1", "My own work", "--start"]);
      await waitUntil(() => divergences(env).some((d) => d.task_id === "mine-a1"), 10_000, "the invariant divergence");
      const d = divergences(env).find((x) => x.task_id === "mine-a1")!;
      expect((await resolve(env, d.id, "accept-edit")).reply.data).toMatchObject({ resolution: "accept-edit", cancelled: "-", backlog: "unchanged" });
      await Bun.sleep(1_500);
      expect(divergences(env).filter((x) => x.task_id === "mine-a1")).toHaveLength(1);
      expect((await backlogTask(env, "mine-a1"))?.state).toBe("in_flight");
    },
    { timeout: 30_000 },
  );

  test(
    "a live run whose task left flight where the watcher did not flag it is caught by the pass",
    async () => {
      const env = await fleet();
      const { task, run } = await env.dispatch("Scout\nFAKE: sleep 30000");
      const r = await env.waitRun(run, (x) => x.liveness === "busy", "busy");
      await inFlight(env, task);
      // The watcher flags a hand edit only for a run with no divergence open; this run has one about a pane label.
      env.herdr.addForeignPane({ flowryn_run: run }, r.worktree_path);
      await waitUntil(() => divergences(env).some((d) => d.lower === "herdr"), 10_000, "the pane divergence");
      byHand(env, ["done", task]);
      await waitUntil(() => divergences(env).some((d) => d.lower === "backlog" && d.task_id === task), 10_000, "the invariant divergence");
      const d = divergences(env).find((x) => x.lower === "backlog")!;
      expect(d.summary).toBe(`task ${task} is Done in the backlog, but its run ${run} is running`);
      const db = env.h.db();
      const opened = db.query("SELECT source FROM events WHERE kind = 'divergence.opened' AND payload LIKE ?1").get(`%"divergence":"${d.id}"%`) as { source: string };
      db.close();
      expect(opened.source).toBe("reconciler");
    },
    { timeout: 45_000 },
  );
});

describe("a divergence between evidence sources", () => {
  test(
    "has no edit to accept; keep-run closes it and the same observation does not reopen it",
    async () => {
      const env = await fleet();
      const { run } = await env.dispatch("Scout\nFAKE: sleep 30000");
      const r = await env.waitRun(run, (x) => x.liveness === "busy", "busy");
      env.herdr.addForeignPane({ flowryn_run: run }, r.worktree_path);
      await waitUntil(() => divergences(env).some((d) => d.lower === "herdr"), 10_000, "the pane divergence");
      const d = divergences(env).find((x) => x.lower === "herdr")!;
      const refused = await resolve(env, d.id, "accept-edit");
      expect(refused.code).toBe(3);
      expect(refused.reply.error).toMatchObject({ code: "bad_args" });
      expect((await resolve(env, d.id, "keep-run")).code).toBe(0);
      await Bun.sleep(1_500);
      expect(divergences(env).filter((x) => x.lower === "herdr")).toHaveLength(1);
      expect(env.run(run).state).toBe("running");
    },
    { timeout: 45_000 },
  );
});
