/**
 * The turn-end guard (autonomy spec 2, ship A), end to end: fake Claude and
 * Pi workers drive the real daemon through the real CLI. A turn that ends
 * with no outcome gets one reminder per episode (a Claude Stop continuation,
 * a Pi follow-up); a worker that ignores it gets the worker_idle pointer
 * worded so; each reminder is settled as obeyed or ignored.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TURN_END_REMINDER } from "../../src/harness/contract-text.ts";
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

function idleLines(env: FleetEnv, runId: string): string[] {
  const db = env.h.db();
  try {
    return (db.query("SELECT line FROM items WHERE run_id = ?1 AND kind = 'worker_idle' ORDER BY opened_at").all(runId) as { line: string }[]).map((r) => r.line);
  } finally {
    db.close();
  }
}

/** The reminders the fake worker received ($FLOWRYN_REPORT_DIR/fake-reminders.txt). */
function received(env: FleetEnv, task: string): string[] {
  const file = join(env.h.dataDir, task, "fake-reminders.txt");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
}

const stopped = (r: { liveness: string; idle_since: number | null }) => r.liveness === "idle" && r.idle_since !== null;

for (const harness of ["claude", "pi"] as const) {
  describe(`the turn-end guard (${harness})`, () => {
    test("a worker that ends its turn with no outcome is reminded once; ignoring it is recorded and the idle pointer says so", async () => {
      const env = await fleet({ timing: { idle_alert_ms: 300 } });
      const { task, run } = await env.dispatch("Build\nFAKE: sleep 50", { harness });
      await waitUntil(() => payloads(env, run, "run.turn_end_reminder_result").length === 1, 15_000, "the reminder settled");
      await env.waitRun(run, stopped, "idle after its second Stop");
      expect(received(env, task)).toEqual([TURN_END_REMINDER]);
      expect(payloads(env, run, "run.turn_end_reminder")).toMatchObject([{ harness }]);
      expect(payloads(env, run, "run.turn_end_reminder_result")).toMatchObject([{ obeyed: false, outcome: null }]);
      await waitUntil(() => idleLines(env, run).length === 1, 10_000, "the worker_idle pointer");
      expect(idleLines(env, run)[0]).toMatch(/ignored the turn-end reminder and has been idle \d+m without an outcome/);
      expect(payloads(env, run, "run.idle_alert")).toMatchObject([{ ignored_reminder: true }]);
    }, 30_000);

    test("a worker that obeys (report progress) settles it obeyed, gets no second one, and an ordinary idle pointer", async () => {
      const env = await fleet({ timing: { idle_alert_ms: 300 } });
      const { task, run } = await env.dispatch("Build\nFAKE: stop-no-outcome\nFAKE: report progress\nFAKE: sleep 50", { harness });
      await waitUntil(() => payloads(env, run, "run.turn_end_reminder_result").length === 1, 15_000, "the reminder settled");
      await env.waitRun(run, stopped, "idle after its Stop");
      expect(received(env, task)).toEqual([TURN_END_REMINDER]);
      expect(payloads(env, run, "run.turn_end_reminder_result")).toMatchObject([{ obeyed: true, outcome: "worker.report" }]);
      await waitUntil(() => idleLines(env, run).length === 1, 10_000, "the worker_idle pointer");
      expect(idleLines(env, run)[0]).not.toContain("turn-end reminder");
      expect(payloads(env, run, "run.turn_end_reminder")).toHaveLength(1);
    }, 30_000);
  });
}

describe("the turn-end guard's episodes", () => {
  test("a steer starts a new episode: a worker that ignored one reminder gets another after the next instruction", async () => {
    const env = await fleet();
    const { task, run } = await env.dispatch("Build\nFAKE: stop-no-outcome\nFAKE: stop-no-outcome\nFAKE: sleep 50");
    // The first stop is reminded and continues; the second is silent: the turn ends, the rest waits for a steer.
    await waitUntil(() => payloads(env, run, "run.turn_end_reminder_result").length === 1, 15_000, "the first reminder settled");
    await env.waitRun(run, stopped, "idle after the silent stop");
    expect(received(env, task)).toHaveLength(1);
    const steered = await env.json(["steer", run, "--body-file", "-"], { stdin: "carry on" });
    expect(steered.code).toBe(0);
    await waitUntil(() => payloads(env, run, "run.turn_end_reminder").length === 2, 15_000, "a reminder in the new episode");
    expect(received(env, task)).toEqual([TURN_END_REMINDER, TURN_END_REMINDER]);
  }, 30_000);

  test("a worker at its review gate is never reminded", async () => {
    const env = await fleet();
    await env.json(["project", "set", "web", "--workflow", "feature"]);
    const { task, run } = await env.dispatch("Feature\nFAKE: stage-done --review https://lavish.test/x\nFAKE: sleep 60000", { kind: "ship" });
    await env.waitRun(run, (r) => r.stage_state === "review" && r.liveness === "idle", "idle at the review gate");
    await Bun.sleep(500);
    expect(payloads(env, run, "run.turn_end_reminder")).toEqual([]);
    expect(received(env, task)).toEqual([]);
  }, 30_000);
});
