/**
 * Urgent steers (steer latency Tier 2) against the fake Herdr and the fake
 * worker, through the real daemon and CLI: an urgent steer blocks the next
 * tool call, cuts a tool that has run past steer_preempt_after_ms, and never
 * sends a key while a permission dialog is open.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { waitUntil } from "../helpers/harness.ts";

const AFTER_MS = 1_000;
const envs: FleetEnv[] = [];
async function fleet(): Promise<FleetEnv> {
  const env = await makeFleetEnv({ timing: { steer_preempt_after_ms: AFTER_MS } });
  envs.push(env);
  return env;
}
afterEach(async () => {
  for (const env of envs.splice(0)) await env.cleanup();
});

interface SteerRow {
  id: string;
  rings: number;
  created_at: number;
  carried_at: number | null;
  seen_at: number | null;
  acked_at: number | null;
  preempted_at: number | null;
  ring_state: string | null;
}

function steerRow(env: FleetEnv, id: string): SteerRow {
  const db = env.h.db();
  try {
    return db.query("SELECT id, rings, created_at, carried_at, seen_at, acked_at, preempted_at, ring_state FROM messages WHERE id = ?1").get(id) as SteerRow;
  } finally {
    db.close();
  }
}

function payloads(env: FleetEnv, runId: string, kind: string): Record<string, unknown>[] {
  const db = env.h.db();
  try {
    return (db.query("SELECT payload FROM events WHERE run_id = ?1 AND kind = ?2 ORDER BY seq").all(runId, kind) as { payload: string }[]).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
  } finally {
    db.close();
  }
}

function items(env: FleetEnv, runId: string): { kind: string; state: string }[] {
  const db = env.h.db();
  try {
    return db.query("SELECT kind, state FROM items WHERE run_id = ?1").all(runId) as { kind: string; state: string }[];
  } finally {
    db.close();
  }
}

async function steer(env: FleetEnv, target: string, text: string, urgent: boolean): Promise<string> {
  const result = await env.json(["steer", target, ...(urgent ? ["--urgent"] : []), "--body-file", "-"], { stdin: text });
  expect(result.code).toBe(0);
  expect(result.reply.data).toMatchObject({ urgent });
  return String((result.reply.data as { steer: string }).steer);
}

const keysSent = (env: FleetEnv) => env.herdr.calls.filter((c) => c.method === "pane.send_keys").length;

describe("urgent steers to a claude worker", () => {
  test(
    "a long tool is cut once it has run the threshold: the interrupt key, then the waiter carries the steer into the idle session",
    async () => {
      const env = await fleet();
      const { task, run } = await env.dispatch("Build\nFAKE: sleep 60000");
      await env.waitRun(run, (r) => r.liveness === "busy", "busy");
      await Bun.sleep(AFTER_MS + 200);
      const id = await steer(env, task, "stop the migration", true);
      await waitUntil(() => steerRow(env, id).acked_at !== null, 15_000, "the urgent steer acknowledged");
      const row = steerRow(env, id);
      expect(row.preempted_at).not.toBeNull();
      // The tool was already past the threshold: cut at once; the carry follows the verified interrupt.
      expect(row.carried_at! - row.created_at).toBeLessThan(3_000);
      expect(keysSent(env)).toBe(1);
      expect(payloads(env, run, "steer.preempted")[0]).toMatchObject({ steer: id, via: "escape", verified: true });
      expect(payloads(env, run, "steer.rung").find((p) => p.steer === id)).toMatchObject({ path: "waiter" });
      const shown = await env.json(["show", task]);
      const line = (shown.reply.data as { steers: { id: string; delivery: string }[] }).steers.find((m) => m.id === id)!.delivery;
      expect(line).toMatch(/^urgent, cut a tool \+\S+, carried \+/);
    },
    { timeout: 45_000 },
  );

  test(
    "a normal steer in the same spot waits for the tool: no key, not carried",
    async () => {
      const env = await fleet();
      const { task, run } = await env.dispatch("Build\nFAKE: sleep 60000");
      await env.waitRun(run, (r) => r.liveness === "busy", "busy");
      const id = await steer(env, task, "when you are done, also update the docs", false);
      await Bun.sleep(AFTER_MS * 3);
      expect(keysSent(env)).toBe(0);
      expect(steerRow(env, id)).toMatchObject({ carried_at: null, preempted_at: null });
    },
    { timeout: 30_000 },
  );

  test(
    "mid-inference: the next main-agent PreToolUse is denied with the steer as its reason; a subagent's is not",
    async () => {
      const env = await fleet();
      // A worker that sends no hooks of its own: the test plays Claude's hooks with the run's token.
      const { run } = await env.dispatch("Build\nFAKE: no-start");
      const launched = await env.waitRun(run, (r) => r.pane_id !== null && r.proc_pid !== null, "launched");
      const token = env.herdr.panes.get(launched.pane_id!)!.env.FLOWRYN_TOKEN!;
      const hook = (name: string, input: Record<string, unknown>) => env.cli(["hook", name, "--harness", "claude"], { env: { FLOWRYN_TOKEN: token }, stdin: JSON.stringify(input) });
      await hook("prompt", {});
      const id = await steer(env, run, "stop the migration", true);

      const sub = await hook("pre-tool", { tool_name: "Bash", tool_use_id: "toolu_sub", agent_id: "agent_1" });
      expect(sub.stdout.trim()).toBe("");
      const main = await hook("pre-tool", { tool_name: "Bash", tool_use_id: "toolu_main" });
      const output = JSON.parse(main.stdout.trim()) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };
      expect(output.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
      expect(output.hookSpecificOutput.permissionDecisionReason).toStartWith(`Flowryn steer [${id}]: stop the migration`);
      expect(output.hookSpecificOutput.permissionDecisionReason).toContain("This tool call was blocked");
      expect(payloads(env, run, "steer.rung")).toEqual([expect.objectContaining({ steer: id, path: "pre-tool" })]);
      // Carried once: the next tool call runs. The hook after the model's next inference proves it was read.
      expect((await hook("pre-tool", { tool_name: "Bash", tool_use_id: "toolu_2" })).stdout.trim()).toBe("");
      expect(steerRow(env, id)).toMatchObject({ ring_state: "seen", rings: 1 });
      expect(keysSent(env)).toBe(0);
    },
    { timeout: 30_000 },
  );

  test(
    "a permission dialog is open: no key at all and one deferral; once you answer it, the approved tool gets its own threshold and is cut",
    async () => {
      const env = await fleet();
      const { task, run } = await env.dispatch("Ship\nFAKE: dialog-tool 60000 Bash command: git commit --amend Do you want to proceed?", { kind: "ship" });
      await waitUntil(() => items(env, run).some((i) => i.kind === "blocked_prompt" && i.state !== "resolved"), 15_000, "the dialog");
      const pane = env.run(run).pane_id!;
      env.herdr.setStatus(pane, "blocked");
      const id = await steer(env, task, "stop the migration", true);
      await Bun.sleep(AFTER_MS * 3);
      expect(keysSent(env)).toBe(0);
      expect(payloads(env, run, "steer.preempt_deferred")).toHaveLength(1);
      expect(steerRow(env, id)).toMatchObject({ preempted_at: null, acked_at: null });

      // You approve the dialog: it leaves the screen and Herdr reads the tool working.
      const answered = Date.now();
      rmSync(join(env.herdr.panes.get(pane)!.env.FLOWRYN_REPORT_DIR!, "fake-screen.txt"));
      env.herdr.setStatus(pane, "working");
      await waitUntil(() => steerRow(env, id).acked_at !== null, 15_000, "the steer acknowledged after the dialog");
      expect(keysSent(env)).toBe(1);
      expect(steerRow(env, id).preempted_at! - answered).toBeGreaterThanOrEqual(AFTER_MS);
      expect(env.events(run)).toContain("run.prompt_cleared");
    },
    { timeout: 45_000 },
  );
});

describe("urgent steers to a pi worker", () => {
  test(
    "a long tool is cut by the extension's abort once hook preempt says go; the dropped steer rings again to the idle agent",
    async () => {
      const env = await fleet();
      const { task, run } = await env.dispatch("Build\nFAKE: sleep 60000", { harness: "pi" });
      await env.waitRun(run, (r) => r.liveness === "busy", "busy");
      const id = await steer(env, task, "stop the migration", true);
      await waitUntil(() => steerRow(env, id).acked_at !== null, 15_000, "the urgent steer acknowledged");
      const row = steerRow(env, id);
      expect(row.preempted_at).not.toBeNull();
      expect(row.preempted_at! - row.created_at).toBeLessThan(AFTER_MS + 2_000);
      // At least the busy carry and the ring after the abort (the fast test clock may add an interval re-ring).
      expect(row.rings).toBeGreaterThanOrEqual(2);
      expect(payloads(env, run, "steer.preempted")[0]).toMatchObject({ steer: id, via: "abort" });
      expect(payloads(env, run, "steer.lost")[0]).toMatchObject({ steer: id, reason: "turn settled unseen" });
      expect(keysSent(env)).toBe(0);
    },
    { timeout: 45_000 },
  );
});
