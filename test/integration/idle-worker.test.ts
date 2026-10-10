/**
 * An idle worker (live, 2026-10-05): the worker_idle pointer opens once per
 * idle episode and never while the worker waits on you, and a due steer
 * reaches an idle Claude worker whose waiter is gone (expired after 8 h, or
 * died with an old daemon) through the idle-carry fallback: its pointer typed
 * into the pane once no dialog can be up (src/lifecycle/idle-carry.ts).
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

function idleItems(env: FleetEnv, runId: string): { id: string; state: string; line: string }[] {
  const db = env.h.db();
  try {
    return db.query("SELECT id, state, line FROM items WHERE run_id = ?1 AND kind = 'worker_idle' ORDER BY opened_at").all(runId) as { id: string; state: string; line: string }[];
  } finally {
    db.close();
  }
}

function eventPayloads(env: FleetEnv, runId: string, kind: string): Record<string, unknown>[] {
  const db = env.h.db();
  try {
    return (db.query("SELECT payload FROM events WHERE run_id = ?1 AND kind = ?2 ORDER BY seq").all(runId, kind) as { payload: string }[]).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
  } finally {
    db.close();
  }
}

function ackedAt(env: FleetEnv, id: string): number | null {
  const db = env.h.db();
  try {
    return (db.query("SELECT acked_at FROM messages WHERE id = ?1").get(id) as { acked_at: number | null } | null)?.acked_at ?? null;
  } finally {
    db.close();
  }
}

async function steer(env: FleetEnv, target: string, text: string): Promise<string> {
  const result = await env.json(["steer", target, "--body-file", "-"], { stdin: text });
  expect(result.code).toBe(0);
  return String((result.reply.data as { steer: string }).steer);
}

/** Idle after the turn's Stop, not the brief idle reading between worker-start and the first prompt. */
const stopped = (r: { liveness: string; idle_since: number | null }) => r.liveness === "idle" && r.idle_since !== null;

function typed(env: FleetEnv): string[] {
  return env.herdr.calls.filter((c) => c.method === "pane.send_text").map((c) => String(c.params.text));
}

describe("the worker_idle pointer", () => {
  test("opens once per idle episode: dismissed, it stays closed through later passes, and comes back only after idle_realert_ms", async () => {
    const env = await fleet({ timing: { idle_alert_ms: 300, idle_realert_ms: 4_000 } });
    const { run } = await env.dispatch("Build\nFAKE: sleep 100");
    await env.waitRun(run, stopped, "idle after its Stop");
    await waitUntil(() => idleItems(env, run).length === 1, 10_000, "the first idle item");
    const first = idleItems(env, run)[0]!;
    expect(first.line).toMatch(/has been idle \d+m without an outcome/);
    expect((await env.json(["dismiss", first.id])).code).toBe(0);
    // pass_ms is 250: many passes (and kicks) go by, none reopens it or records another alert.
    await Bun.sleep(2_000);
    expect(idleItems(env, run)).toHaveLength(1);
    expect(eventPayloads(env, run, "run.idle_alert")).toHaveLength(1);
    await waitUntil(() => idleItems(env, run).length === 2, 10_000, "the re-alert after the backoff");
    expect(eventPayloads(env, run, "run.idle_alert")).toHaveLength(2);
  }, 30_000);

  test("a worker waiting on its review gate gets none, and an open one is resolved when the gate opens", async () => {
    const env = await fleet({ timing: { idle_alert_ms: 300 } });
    await env.json(["project", "set", "web", "--workflow", "feature"]);
    const { run } = await env.dispatch("Feature\nFAKE: stage-done --review lavish:x.html\nFAKE: sleep 60000", { kind: "ship" });
    await env.waitRun(run, (r) => r.stage_state === "review" && r.liveness === "idle", "idle at the review gate");
    await Bun.sleep(1_500);
    expect(idleItems(env, run)).toHaveLength(0);
    expect(eventPayloads(env, run, "run.idle_alert")).toHaveLength(0);
  }, 30_000);
});

describe("a due steer for an idle claude worker with no waiter", () => {
  test("is typed into its pane after waiter_grace_ms while Herdr reads idle, and the woken turn acks it", async () => {
    const env = await fleet({ timing: { waiter_grace_ms: 1_000 } });
    const { run } = await env.dispatch("Build\nFAKE: no-waiter\nFAKE: sleep 100");
    const idle = await env.waitRun(run, stopped, "idle after its Stop");
    env.herdr.setStatus(idle.pane_id!, "idle");
    const id = await steer(env, run, "now write the docs");
    await waitUntil(() => ackedAt(env, id) !== null, 15_000, `steer ${id} acked`);
    expect(typed(env)).toEqual([`Flowryn: steer ${id} from your leader is waiting. Run $FLOWRYN_BIN inbox, act on it, then $FLOWRYN_BIN ack ${id}.`]);
    const enter = env.herdr.calls.findIndex((c) => c.method === "pane.send_keys" && (c.params.keys as string[]).includes("Enter"));
    expect(enter).toBeGreaterThan(env.herdr.calls.findIndex((c) => c.method === "pane.send_text"));
    expect(eventPayloads(env, run, "steer.rung")).toEqual([{ steer: id, ring: 1, path: "keys", idle: true }]);
  }, 30_000);

  test("is never typed while Herdr reads blocked (a dialog) or the worker is mid-tool; it goes once the pane settles", async () => {
    const env = await fleet({ timing: { waiter_grace_ms: 500 } });
    const { run } = await env.dispatch("Build\nFAKE: no-waiter\nFAKE: sleep 100");
    const idle = await env.waitRun(run, stopped, "idle after its Stop");
    env.herdr.setStatus(idle.pane_id!, "blocked");
    const id = await steer(env, run, "hold on");
    await Bun.sleep(2_000);
    env.herdr.setStatus(idle.pane_id!, "working");
    await Bun.sleep(1_500);
    expect(typed(env)).toEqual([]);
    env.herdr.setStatus(idle.pane_id!, "idle");
    await waitUntil(() => ackedAt(env, id) !== null, 15_000, `steer ${id} acked once the pane settled`);
    expect(typed(env)).toHaveLength(1);
  }, 30_000);

  test("a live waiter takes it: nothing is typed", async () => {
    const env = await fleet({ timing: { waiter_grace_ms: 500 } });
    const { run } = await env.dispatch("Build\nFAKE: sleep 100");
    const idle = await env.waitRun(run, stopped, "idle after its Stop");
    env.herdr.setStatus(idle.pane_id!, "idle");
    await Bun.sleep(1_500);
    const id = await steer(env, run, "now write the docs");
    await waitUntil(() => ackedAt(env, id) !== null, 15_000, `steer ${id} acked`);
    expect(typed(env)).toEqual([]);
    expect(eventPayloads(env, run, "steer.rung").map((p) => p.path)).toEqual(["waiter"]);
  }, 30_000);

  test("after a daemon restart, a steer queued to an idle worker whose waiter died is delivered", async () => {
    const env = await fleet({ timing: { waiter_grace_ms: 1_000 } });
    const { run } = await env.dispatch("Build\nFAKE: no-waiter\nFAKE: sleep 100");
    const idle = await env.waitRun(run, stopped, "idle after its Stop");
    // A dialog holds it while the old daemon runs, so the steer is still queued at the restart.
    env.herdr.setStatus(idle.pane_id!, "blocked");
    const id = await steer(env, run, "the ship stage has started");
    await Bun.sleep(1_500);
    expect(ackedAt(env, id)).toBeNull();
    await env.daemon.stop();
    env.herdr.setStatus(idle.pane_id!, "idle");
    await env.restartDaemon();
    await waitUntil(() => ackedAt(env, id) !== null, 20_000, `steer ${id} acked after the restart`);
    expect(eventPayloads(env, run, "steer.rung").map((p) => p.path)).toEqual(["keys"]);
  }, 40_000);
  test("flowryn daemon restart never strands a steer: one queued to an idle worker just before the restart is delivered by the new daemon", async () => {
    // waiter_grace_ms is long enough that the old daemon cannot deliver it before the restart.
    const env = await fleet({ timing: { waiter_grace_ms: 4_000 }, supervised: true });
    const { run } = await env.dispatch("Build\nFAKE: no-waiter\nFAKE: sleep 100");
    const idle = await env.waitRun(run, stopped, "idle after its Stop");
    env.herdr.setStatus(idle.pane_id!, "idle");
    const id = await steer(env, run, "a new build is live");
    const restarted = await env.json(["daemon", "restart"]);
    expect(restarted.code).toBe(0);
    expect(ackedAt(env, id)).toBeNull();
    await waitUntil(() => ackedAt(env, id) !== null, 20_000, `steer ${id} acked after daemon restart`);
    expect(eventPayloads(env, run, "steer.rung").map((p) => p.path)).toEqual(["keys"]);
    const db = env.h.db();
    try {
      expect((db.query("SELECT payload FROM events WHERE kind = 'daemon.restarted'").all() as { payload: string }[]).map((r) => JSON.parse(r.payload).by)).toEqual(["leader"]);
    } finally {
      db.close();
    }
  }, 40_000);
});
