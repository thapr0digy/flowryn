/**
 * The stale-hook pointer through the reconciler and the fake Herdr
 * (docs/notes/2026-10-10-quieter-stale-hook-3q.md): a worker Herdr reads
 * working that goes quiet past stale_hook_ms gets one worker_idle item; one
 * that waits at its review gate gets none, whatever Herdr reads.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { waitUntil } from "../helpers/harness.ts";

const envs: FleetEnv[] = [];
afterEach(async () => {
  for (const env of envs.splice(0)) await env.cleanup();
});

async function fleet(): Promise<FleetEnv> {
  const env = await makeFleetEnv({ timing: { stale_hook_ms: 1_500 } });
  envs.push(env);
  return env;
}

function staleEvents(env: FleetEnv, runId: string): { since: number; quiet_from: number }[] {
  const db = env.h.db();
  try {
    return (db.query("SELECT payload FROM events WHERE run_id = ?1 AND kind = 'run.stale_hooks' ORDER BY seq").all(runId) as { payload: string }[]).map((e) => JSON.parse(e.payload));
  } finally {
    db.close();
  }
}

function idleItems(env: FleetEnv, runId: string): { line: string }[] {
  const db = env.h.db();
  try {
    return db.query("SELECT line FROM items WHERE run_id = ?1 AND kind = 'worker_idle'").all(runId) as { line: string }[];
  } finally {
    db.close();
  }
}

describe("the stale-hook pointer", () => {
  test("a working worker quiet past stale_hook_ms gets one item, its event naming where the quiet began", async () => {
    const env = await fleet();
    const { run } = await env.dispatch("Ship\nFAKE: sleep 200\nFAKE: stall\nFAKE: sleep 60000", { kind: "ship" });
    await env.waitRun(run, (r) => r.worker_started_at !== null, "started");
    env.herdr.setStatus(env.run(run).pane_id!, "working");
    await waitUntil(() => staleEvents(env, run).length > 0, 10_000, "the stale-hook event");
    const [event] = staleEvents(env, run);
    expect(event!.quiet_from).toBeGreaterThanOrEqual(event!.since);
    await Bun.sleep(1_000);
    expect(staleEvents(env, run)).toHaveLength(1);
    expect(idleItems(env, run)).toHaveLength(1);
    expect(idleItems(env, run)[0]!.line).toContain("looks busy but sent no hook event");
  }, 30_000);

  test("a worker at its review gate gets none while Herdr reads working", async () => {
    const env = await fleet();
    await env.json(["project", "set", "web", "--workflow", "feature"]);
    const { run } = await env.dispatch("Feature\nFAKE: stage-done --review lavish:x.html\nFAKE: sleep 60000", { kind: "ship" });
    await env.waitRun(run, (r) => r.stage_state === "review", "the review");
    env.herdr.setStatus(env.run(run).pane_id!, "working");
    await Bun.sleep(3_000);
    expect(staleEvents(env, run)).toHaveLength(0);
    expect(idleItems(env, run)).toHaveLength(0);
  }, 30_000);
});
