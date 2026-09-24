/**
 * M2 runtime, workers and reconciler against a fake Herdr (test/helpers/
 * fake-herdr.ts) and a fake harness that plays a worker through the real
 * flowryn CLI hooks and worker verbs. The daemon, journal, tasks-axi and the
 * process table are real. The live runs against Herdr, Claude Code and Pi are
 * in scripts/lab/ (docs/m2-notes.md).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { listTasks, processRunner } from "../../src/journal/tasks-axi.ts";
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

function items(env: FleetEnv, runId: string): { kind: string; lane: string; state: string; line: string }[] {
  const db = env.h.db();
  try {
    return db.query("SELECT kind, lane, state, line FROM items WHERE run_id = ?1 ORDER BY opened_at").all(runId) as { kind: string; lane: string; state: string; line: string }[];
  } finally {
    db.close();
  }
}

async function backlogTask(env: FleetEnv, taskId: string) {
  const tasks = await listTasks(processRunner(realTasksAxi(), Bun.which("node")), env.h.backlog);
  return tasks.find((t) => t.id === taskId) ?? null;
}

describe("a scout end to end", () => {
  test(
    "claude: launch, worker-start with isolation, deliver --report, ready, backlog updated",
    async () => {
      const env = await fleet();
      const { task, run } = await env.dispatch("Scout the auth module\nFAKE: sleep 300\nFAKE: deliver summary.md auth is fine");
      const ready = await env.waitRun(run, (r) => r.state === "ready", "the run to be ready");
      expect(ready.pane_id).not.toBeNull();
      expect(ready.proc_pid).not.toBeNull();
      expect(ready.worker_started_at).not.toBeNull();
      const events = env.events(run);
      expect(events).toEqual(expect.arrayContaining(["run.dispatched", "run.pane", "run.launching", "run.launched", "run.worker_started", "run.delivered"]));
      expect(items(env, run).find((i) => i.kind === "report_ready")).toMatchObject({ lane: "P1", state: "open" });
      await waitUntil(async () => (await backlogTask(env, task))?.state === "in_flight", 10_000, "the backlog task in flight");
      await waitUntil(async () => ((await backlogTask(env, task))?.links ?? []).includes(`report:data/${task}/report.md`), 10_000, "the report link in the backlog");
      expect(readFileSync(join(env.h.dataDir, task, "report.md"), "utf8")).toContain("auth is fine");
      // The pane got the run's identity through pane.split env (M0 h04), and Herdr never saw a control character.
      const split = env.herdr.calls.find((c) => c.method === "pane.split")!;
      expect((split.params.env as Record<string, string>).FLOWRYN_RUN).toBe(run);
      expect((split.params.env as Record<string, string>).CLAUDECODE).toBe("");
      const start = env.herdr.calls.find((c) => c.method === "agent.start")!;
      expect((start.params.args as string[]).every((a) => !/[\n\t]/.test(a))).toBe(true);
      expect(start.params.kind).toBe("claude");
      await env.waitRun(run, (r) => r.liveness === "idle", "the worker to go idle");
    },
    { timeout: 45_000 },
  );
});
