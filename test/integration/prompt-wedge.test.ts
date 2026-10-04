import { afterEach, describe, expect, test } from "bun:test";
import { makeFleetEnv, setHarnessVersion, type FleetEnv } from "../helpers/fleet-env.ts";
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
    await env.waitRun(run, (r) => r.pane_id !== null, "paned");
    // The dialog's whole duration (spike c12): keeps the reconciler's "Esc declined it" clearing from firing while it is genuinely still up.
    env.herdr.setStatus(env.run(run).pane_id!, "blocked");
    await env.waitRun(run, (r) => r.liveness === "blocked_dialog", "blocked_dialog");
    await Bun.sleep(1_500);
    const open = items(env, run).filter((i) => i.state !== "resolved");
    expect(open.filter((i) => i.kind === "blocked_prompt")).toHaveLength(1);
    expect(open.find((i) => i.kind === "blocked_prompt")!.line).toContain("waiting on a confirmation: Do you want to proceed? git push --force-with-lease");
    expect(open.find((i) => i.kind === "blocked_prompt")!.line).not.toContain("ghp_");
    // Force the idle-alert condition true (busy false, idle_since well past idle_alert_ms) to prove the open
    // blocked_prompt item is what suppresses worker_idle, not FAST_TIMING's 10-minute default busy lease.
    const db = env.h.db();
    db.query("UPDATE runs SET busy_until = NULL, idle_since = ?2 WHERE id = ?1").run(run, Date.now() - 2_000);
    db.close();
    await Bun.sleep(500);
    expect(items(env, run).some((i) => i.kind === "worker_idle")).toBe(false);
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
    // "blocked" (not "idle"): the Claude backstop's own status gate would already suppress "idle" for free,
    // so idleByDesign (the review) must be what is actually doing the work here, not a vacuously wrong status.
    env.herdr.setStatus(env.run(run).pane_id!, "blocked");
    // Hold a busy lease, so it is idleByDesign (the review), not the Stop, that keeps the item away.
    const db = env.h.db();
    db.query("UPDATE runs SET busy_until = ?2, idle_since = NULL, last_hook_at = ?3 WHERE id = ?1").run(run, Date.now() + 600_000, Date.now() - 60_000);
    db.close();
    await Bun.sleep(3_000);
    expect(items(env, run).some((i) => i.kind === "blocked_prompt")).toBe(false);
  }, 20_000);

  test("claude: an Esc decline (agent_status leaves \"blocked\" with no hook) resolves the item and liveness; staying \"blocked\" keeps it open", async () => {
    const env = await makeFleetEnv({ timing: { prompt_suspect_ms: 60_000 } });
    envs.push(env);
    const { run } = await env.dispatch("Ship\nFAKE: sleep 300\nFAKE: prompt Do you want to proceed?\nFAKE: sleep 60000", { kind: "ship" });
    await env.waitRun(run, (r) => r.pane_id !== null, "paned");
    env.herdr.setStatus(env.run(run).pane_id!, "blocked");
    await env.waitRun(run, (r) => r.liveness === "blocked_dialog", "blocked_dialog");
    await Bun.sleep(500);
    // Still "blocked": the item stays open and liveness stays blocked_dialog, with no hook having fired.
    expect(items(env, run).some((i) => i.kind === "blocked_prompt" && i.state !== "resolved")).toBe(true);
    expect(env.run(run).liveness).toBe("blocked_dialog");
    // Esc declines the dialog in the pane: no hook fires (M0 c04), but Herdr's agent_status leaves "blocked".
    env.herdr.setStatus(env.run(run).pane_id!, "idle");
    await waitUntil(() => items(env, run).every((i) => i.kind !== "blocked_prompt" || i.state === "resolved"), 10_000, "resolved once the dialog is gone");
    expect(env.run(run).liveness).not.toBe("blocked_dialog");
  }, 20_000);

  test("claude: permission_prompt for a run idle by design (an unacked steer) still opens the item: a confirmed dialog is never idle by design", async () => {
    const env = await makeFleetEnv({ timing: { prompt_suspect_ms: 60_000 } });
    envs.push(env);
    const { run } = await env.dispatch("Ship\nFAKE: prompt Do you want to proceed?\nFAKE: sleep 60000", { kind: "ship" });
    // Inserted directly (and fast) right after dispatch returns, so it is unacked before the worker's
    // first FAKE step (the prompt, with no tool wrapper to carry it back for an ack) ever runs.
    const db = env.h.db();
    db.query("INSERT INTO messages (id, run_id, body, created_at) VALUES ('m900', ?1, 'hold on', ?2)").run(run, Date.now());
    db.close();
    await env.waitRun(run, (r) => r.worker_started_at !== null, "started");
    await waitUntil(() => items(env, run).some((i) => i.kind === "blocked_prompt"), 10_000, "the confirmed item, despite the unacked steer");
  }, 20_000);

  test("claude: the backstop needs \"blocked\"; \"working\" or \"idle\" alone opens nothing", async () => {
    const env = await makeFleetEnv({ timing: { prompt_suspect_ms: 1_000 } });
    envs.push(env);
    const { run } = await env.dispatch("Ship\nFAKE: sleep 200\nFAKE: stall\nFAKE: sleep 60000", { kind: "ship" });
    await env.waitRun(run, (r) => r.worker_started_at !== null, "started");
    env.herdr.setStatus(env.run(run).pane_id!, "working");
    await Bun.sleep(2_000);
    expect(items(env, run).some((i) => i.kind === "blocked_prompt")).toBe(false);
    env.herdr.setStatus(env.run(run).pane_id!, "idle");
    await Bun.sleep(2_000);
    expect(items(env, run).some((i) => i.kind === "blocked_prompt")).toBe(false);
  }, 20_000);

  test("a run with an open blocked_prompt that dies resolves the item, even when its resume is deferred (no relaunch to carry a hook)", async () => {
    const env = await makeFleetEnv({ timing: { prompt_suspect_ms: 60_000 } });
    envs.push(env);
    const { run } = await env.dispatch("Ship\nFAKE: sleep 300\nFAKE: prompt Do you want to proceed?\nFAKE: sleep 60000", { kind: "ship" });
    await env.waitRun(run, (r) => r.pane_id !== null, "paned");
    env.herdr.setStatus(env.run(run).pane_id!, "blocked");
    await env.waitRun(run, (r) => r.liveness === "blocked_dialog", "blocked_dialog");
    expect(items(env, run).some((i) => i.kind === "blocked_prompt" && i.state !== "resolved")).toBe(true);
    // No passing contract for this version: the death defers the resume (reconciler.ts deferResume)
    // instead of relaunching at once, so nothing else (no fresh worker hook) could resolve the item.
    setHarnessVersion(env.h, "claude", "0.0.1");
    env.herdr.killHarness(env.run(run).pane_id!);
    await waitUntil(() => items(env, run).every((i) => i.kind !== "blocked_prompt" || i.state === "resolved"), 15_000, "resolved on death");
  }, 20_000);

  test("claude: Herdr status \"unknown\" after the dialog holds the item open", async () => {
    const env = await makeFleetEnv({ timing: { prompt_suspect_ms: 60_000, pass_ms: 300 } });
    envs.push(env);
    const { run } = await env.dispatch("Ship\nFAKE: sleep 300\nFAKE: prompt Do you want to proceed?\nFAKE: sleep 60000", { kind: "ship" });
    await env.waitRun(run, (r) => r.pane_id !== null, "paned");
    env.herdr.setStatus(env.run(run).pane_id!, "blocked");
    await env.waitRun(run, (r) => r.liveness === "blocked_dialog", "blocked_dialog");
    // Herdr briefly loses the pane's status: never treated the same as the dialog actually clearing.
    env.herdr.setStatus(env.run(run).pane_id!, "unknown");
    await Bun.sleep(1_200);
    expect(items(env, run).some((i) => i.kind === "blocked_prompt" && i.state !== "resolved")).toBe(true);
    expect(env.run(run).liveness).toBe("blocked_dialog");
  }, 20_000);

  test("claude: Herdr status \"idle\" releases the item only on its second consecutive pass", async () => {
    const env = await makeFleetEnv({ timing: { prompt_suspect_ms: 60_000, pass_ms: 1_000 } });
    envs.push(env);
    const { run } = await env.dispatch("Ship\nFAKE: sleep 300\nFAKE: prompt Do you want to proceed?\nFAKE: sleep 60000", { kind: "ship" });
    await env.waitRun(run, (r) => r.pane_id !== null, "paned");
    env.herdr.setStatus(env.run(run).pane_id!, "blocked");
    await env.waitRun(run, (r) => r.liveness === "blocked_dialog", "blocked_dialog");
    env.herdr.setStatus(env.run(run).pane_id!, "idle");
    // The first pass to see "idle" only just transitioned from "blocked": it must hold, not release.
    await Bun.sleep(400);
    expect(items(env, run).some((i) => i.kind === "blocked_prompt" && i.state !== "resolved")).toBe(true);
    // The second consecutive "idle" pass releases it.
    await waitUntil(() => items(env, run).every((i) => i.kind !== "blocked_prompt" || i.state === "resolved"), 10_000, "resolved on the second consecutive idle pass");
  }, 20_000);

  test("claude: Herdr status \"working\" releases the item at once, with no second pass needed", async () => {
    const env = await makeFleetEnv({ timing: { prompt_suspect_ms: 60_000, pass_ms: 1_000 } });
    envs.push(env);
    const { run } = await env.dispatch("Ship\nFAKE: sleep 300\nFAKE: prompt Do you want to proceed?\nFAKE: sleep 60000", { kind: "ship" });
    await env.waitRun(run, (r) => r.pane_id !== null, "paned");
    env.herdr.setStatus(env.run(run).pane_id!, "blocked");
    await env.waitRun(run, (r) => r.liveness === "blocked_dialog", "blocked_dialog");
    env.herdr.setStatus(env.run(run).pane_id!, "working");
    await waitUntil(() => items(env, run).every((i) => i.kind !== "blocked_prompt" || i.state === "resolved"), 3_000, "resolved on the first working pass");
  }, 20_000);

  test("a suspected (backstop) item is resolved by later hook activity", async () => {
    const env = await makeFleetEnv({ timing: { prompt_suspect_ms: 1_000 } });
    envs.push(env);
    const { run } = await env.dispatch("Ship\nFAKE: sleep 200\nFAKE: sleep 3000\nFAKE: sleep 100", { kind: "ship" });
    await env.waitRun(run, (r) => r.worker_started_at !== null, "started");
    env.herdr.setStatus(env.run(run).pane_id!, "blocked");
    await waitUntil(() => items(env, run).some((i) => i.kind === "blocked_prompt"), 10_000, "the suspected item");
    // The long sleep ends and the next tool call's pre/post-tool hooks fire: ordinary activity resolves it.
    await waitUntil(() => items(env, run).every((i) => i.kind !== "blocked_prompt" || i.state === "resolved"), 10_000, "resolved by hook activity");
  }, 20_000);
});
