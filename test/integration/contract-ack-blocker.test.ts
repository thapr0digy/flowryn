/**
 * The contract's named ack causes (src/contracts/suite.ts ackBlocker) against
 * the rows the real hooks write: a test plays a Claude worker's hooks with the
 * run's token, so `idle_since`, `seen_at` and the run's state are what
 * production sets (docs/notes/2026-10-11-make-the-pi-rv.md).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { ackBlocker, IGNORED_GRACE_MS } from "../../src/contracts/suite.ts";
import type { MessageRow } from "../../src/lifecycle/steers.ts";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";

const envs: FleetEnv[] = [];
afterEach(async () => {
  for (const env of envs.splice(0)) await env.cleanup();
});

function message(env: FleetEnv, id: string): MessageRow {
  const db = env.h.db();
  try {
    return db.query("SELECT * FROM messages WHERE id = ?1").get(id) as MessageRow;
  } finally {
    db.close();
  }
}

async function claudeWorker(env: FleetEnv) {
  // A worker that sends no hooks of its own: the test plays Claude's hooks with the run's token.
  const { task, run } = await env.dispatch("Build\nFAKE: no-start");
  const launched = await env.waitRun(run, (r) => r.pane_id !== null && r.proc_pid !== null, "launched");
  const token = env.herdr.panes.get(launched.pane_id!)!.env.FLOWRYN_TOKEN!;
  const hook = async (name: string, input: Record<string, unknown> = {}) => {
    const result = await env.cli(["hook", name, "--harness", "claude"], { env: { FLOWRYN_TOKEN: token }, stdin: JSON.stringify(input) });
    expect(result.code).toBe(0);
    return result.stdout;
  };
  const steer = async (text: string) => {
    const result = await env.json(["steer", task, "--body-file", "-"], { stdin: text });
    expect(result.code).toBe(0);
    return String((result.reply.data as { steer: string }).steer);
  };
  return { run, hook, steer };
}

describe("the contract's named ack causes, on the rows real hooks write", () => {
  test("assumption: a Claude Stop that carries a steer continues the turn, so it is not a turn end", async () => {
    // Contract runs turn the turn-end guard off (src/contracts/runner.ts), so a turn end is just that.
    const env = await makeFleetEnv({ turnEndGuard: false });
    envs.push(env);
    const { run, hook, steer } = await claudeWorker(env);
    await hook("prompt");
    const id = await steer("only acknowledge this");
    expect(await hook("stop")).toContain(`[${id}]`);
    await hook("pre-tool", { tool_name: "Bash", tool_use_id: "toolu_1" });
    const seen = message(env, id);
    expect(seen.seen_at).not.toBeNull();
    expect(env.run(run).idle_since).toBeNull();
    expect(ackBlocker(env.run(run), seen, Date.now() + 60_000)).toBeNull();

    // The continued turn ends with no acknowledgement: that is a turn end after it was seen.
    await hook("post-tool", { tool_name: "Bash", tool_use_id: "toolu_1" });
    await hook("stop", { stop_hook_active: true });
    const ended = env.run(run);
    expect(ended.idle_since).toBeGreaterThan(seen.seen_at!);
    expect(ackBlocker(ended, message(env, id), ended.idle_since! + IGNORED_GRACE_MS - 1)).toBeNull();
    expect(ackBlocker(ended, message(env, id), ended.idle_since! + IGNORED_GRACE_MS)).toStartWith(`${id} seen +`);
  }, 30_000);
});
