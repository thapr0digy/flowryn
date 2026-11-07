/**
 * Idle-with-work nudges end to end (no-idle-workers-23 phase 2): the real
 * daemon's reconciler nudges a stopped fake worker that left commits
 * unpushed, the nudge rides the ordinary steer carry, and the worker acts
 * on it; a worker that ignores its nudges ends in one worker_stalled P1.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { waitUntil } from "../helpers/harness.ts";

const envs: FleetEnv[] = [];
async function fleet(options: Parameters<typeof makeFleetEnv>[0] = {}): Promise<FleetEnv> {
  const env = await makeFleetEnv(options);
  envs.push(env);
  return env;
}
afterEach(async () => {
  for (const env of envs.splice(0)) await env.cleanup();
});

function payloads(env: FleetEnv, runId: string, kind: string): Record<string, unknown>[] {
  const db = env.h.db();
  try {
    return (db.query("SELECT payload FROM events WHERE run_id = ?1 AND kind = ?2 ORDER BY seq").all(runId, kind) as { payload: string }[]).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
  } finally {
    db.close();
  }
}

function items(env: FleetEnv, runId: string, kind: string): { line: string }[] {
  const db = env.h.db();
  try {
    return db.query("SELECT line FROM items WHERE run_id = ?1 AND kind = ?2").all(runId, kind) as { line: string }[];
  } finally {
    db.close();
  }
}

describe("idle with work left", () => {
  test("unpushed commits plus idle: a nudge after the window, the worker pushes and delivers, and no more nudges", async () => {
    // 0.02 min: the first window is 1.2 s.
    const env = await fleet({ origin: true, turnEndGuard: false, idleNudge: { min: 0.02 } });
    const { run } = await env.dispatch(
      ["Fix", "FAKE: commit a.txt one", "FAKE: push", "FAKE: commit b.txt two", "FAKE: stop-no-outcome", "FAKE: push", "FAKE: deliver-local", "FAKE: sleep 60000"].join("\n"),
      { kind: "ship" },
    );
    await waitUntil(() => payloads(env, run, "run.idle_nudge").length === 1, 20_000, "the first nudge");
    expect(payloads(env, run, "run.idle_nudge")[0]).toMatchObject({ n: 1, outstanding: expect.arrayContaining(["unpushed:1"]) });
    await env.waitRun(run, (r) => r.state === "ready", "delivered after the nudge");
    // Several windows later: still the one nudge.
    await Bun.sleep(3_000);
    expect(payloads(env, run, "run.idle_nudge")).toHaveLength(1);
  }, 45_000);

  test("a worker that ignores its nudges: three, then one worker_stalled P1", async () => {
    const env = await fleet({ turnEndGuard: false, idleNudge: { min: 0.01 } });
    const { run } = await env.dispatch("Build\nFAKE: ignore-steers\nFAKE: stop-no-outcome\nFAKE: sleep 60000");
    await waitUntil(() => items(env, run, "worker_stalled").length === 1, 30_000, "the worker_stalled item");
    expect(payloads(env, run, "run.idle_nudge").map((p) => p.n)).toEqual([1, 2, 3]);
    expect(items(env, run, "worker_stalled")[0]!.line).toMatch(/idle with work left after 3 nudges .*stage \S+ not done/);
    await Bun.sleep(1_500);
    expect(payloads(env, run, "run.idle_stalled")).toHaveLength(1);
  }, 45_000);
});
