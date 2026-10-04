import { afterEach, describe, expect, test } from "bun:test";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { waitUntil } from "../helpers/harness.ts";

const envs: FleetEnv[] = [];
afterEach(async () => {
  for (const env of envs.splice(0)) await env.cleanup();
});

function items(env: FleetEnv, runId: string) {
  const db = env.h.db();
  try {
    return db.query("SELECT kind, state, line FROM items WHERE run_id = ?1 ORDER BY opened_at").all(runId) as { kind: string; state: string; line: string }[];
  } finally {
    db.close();
  }
}

describe("a worker stopped by a confirmation prompt", () => {
  test("claude: permission_prompt opens one P1 with the prompt text; liveness holds; activity resolves it", async () => {
    const env = await makeFleetEnv({ timing: { prompt_suspect_ms: 60_000, idle_alert_ms: 1_000 } });
    envs.push(env);
    const { run } = await env.dispatch("Ship\nFAKE: sleep 300\nFAKE: prompt Do you want to proceed? git push --force-with-lease token=ghp_abcdefghijklmnopqrstuvwxyz0123\nFAKE: sleep 100\nFAKE: sleep 60000", { kind: "ship" });
    await env.waitRun(run, (r) => r.liveness === "blocked_dialog", "blocked_dialog");
    await Bun.sleep(1_500);
    const open = items(env, run).filter((i) => i.state !== "resolved");
    expect(open.filter((i) => i.kind === "blocked_prompt")).toHaveLength(1);
    expect(open.find((i) => i.kind === "blocked_prompt")!.line).toContain("waiting on a confirmation: Do you want to proceed? git push --force-with-lease");
    expect(open.find((i) => i.kind === "blocked_prompt")!.line).not.toContain("ghp_");
    expect(open.some((i) => i.kind === "worker_idle")).toBe(false);
    expect(env.run(run).liveness).toBe("blocked_dialog");
    env.clearScreen(run);
    await waitUntil(() => items(env, run).every((i) => i.kind !== "blocked_prompt" || i.state === "resolved"), 10_000, "resolved on activity");
  }, 30_000);

  test("backstop (claude): no hook for prompt_suspect_ms while Herdr reads blocked opens one suspected item", async () => {
    const env = await makeFleetEnv({ timing: { prompt_suspect_ms: 1_500 } });
    envs.push(env);
    const { run } = await env.dispatch("Ship\nFAKE: sleep 200\nFAKE: stall\nFAKE: sleep 60000", { kind: "ship" });
    await env.waitRun(run, (r) => r.worker_started_at !== null, "started");
    // Spike c12: agent_status reads "blocked" during a dialog and "working" during a long tool; they never overlap.
    env.herdr.setStatus(env.run(run).pane_id!, "blocked");
    await waitUntil(() => items(env, run).some((i) => i.kind === "blocked_prompt"), 10_000, "the suspected item");
    expect(items(env, run).filter((i) => i.kind === "blocked_prompt")).toHaveLength(1);
    expect(items(env, run).find((i) => i.kind === "blocked_prompt")!.line).toContain("may be waiting on a confirmation");
  }, 20_000);

  test("backstop (pi): no hook for prompt_suspect_ms while Herdr does not read working opens one suspected item, worded as a stall", async () => {
    const env = await makeFleetEnv({ timing: { prompt_suspect_ms: 1_500 } });
    envs.push(env);
    const { run } = await env.dispatch("Ship\nFAKE: sleep 200\nFAKE: stall\nFAKE: sleep 60000", { kind: "ship", harness: "pi" });
    await env.waitRun(run, (r) => r.worker_started_at !== null, "started");
    // Pi keeps the more conservative rule (M0 has no c12-equivalent Pi spike): anything but "working" counts.
    env.herdr.setStatus(env.run(run).pane_id!, "idle");
    await waitUntil(() => items(env, run).some((i) => i.kind === "blocked_prompt"), 10_000, "the suspected item");
    expect(items(env, run).filter((i) => i.kind === "blocked_prompt")).toHaveLength(1);
    expect(items(env, run).find((i) => i.kind === "blocked_prompt")!.line).toContain("may be stalled");
  }, 20_000);

  test("a run waiting on a review gate gets no item", async () => {
    const env = await makeFleetEnv({ timing: { prompt_suspect_ms: 1_000 } });
    envs.push(env);
    await env.json(["project", "set", "web", "--workflow", "feature"]);
    const { run } = await env.dispatch("Feature\nFAKE: stage-done --review https://lavish.test/x\nFAKE: sleep 60000", { kind: "ship" });
    await env.waitRun(run, (r) => r.stage_state === "review", "the review");
    env.herdr.setStatus(env.run(run).pane_id!, "idle");
    // Hold a busy lease, so it is idleByDesign (the review), not the Stop, that keeps the item away.
    const db = env.h.db();
    db.query("UPDATE runs SET busy_until = ?2, idle_since = NULL, last_hook_at = ?3 WHERE id = ?1").run(run, Date.now() + 600_000, Date.now() - 60_000);
    db.close();
    await Bun.sleep(3_000);
    expect(items(env, run).some((i) => i.kind === "blocked_prompt")).toBe(false);
  }, 20_000);
});
