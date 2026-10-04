import { afterEach, describe, expect, test } from "bun:test";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";

const envs: FleetEnv[] = [];
afterEach(async () => {
  for (const env of envs.splice(0)) await env.cleanup();
});

describe("dispatch --mode", () => {
  test("a no-mistakes project sends internal work direct-PR with a reason", async () => {
    const env = await makeFleetEnv({ mode: "no-mistakes", origin: true });
    envs.push(env);
    const noReason = await env.json(["dispatch", "web", "--kind", "ship", "--mode", "direct-PR", "--body-file", "-"], { stdin: "CI tweak\nFAKE: sleep 60000" });
    expect(noReason.code).toBe(3);
    const ok = await env.json(["dispatch", "web", "--kind", "ship", "--mode", "direct-PR", "--mode-reason", "internal CI config only", "--body-file", "-"], { stdin: "CI tweak\nFAKE: sleep 60000" });
    expect(ok.code).toBe(0);
    expect(ok.reply.data).toMatchObject({ mode: "direct-PR" });
    const task = (ok.reply.data as { task: string }).task;
    const shown = await env.json(["show", task]);
    expect(shown.reply.data).toMatchObject({ mode: "direct-PR (internal CI config only)" });
    // cutover C3 fix: the override is part of the dispatch event's audit trail, not just the live task_policy row.
    const run = (ok.reply.data as { run: string }).run;
    const db = env.h.db();
    const event = db.query("SELECT payload FROM events WHERE kind = 'run.dispatched' AND run_id = ?1").get(run) as { payload: string };
    db.close();
    expect(JSON.parse(event.payload)).toMatchObject({ mode: "direct-PR", mode_reason: "internal CI config only" });
  });

  test("dispatch with no --mode carries no mode/mode_reason in the dispatch event", async () => {
    const env = await makeFleetEnv({ mode: "no-mistakes", origin: true });
    envs.push(env);
    const ok = await env.json(["dispatch", "web", "--kind", "ship", "--body-file", "-"], { stdin: "plain task\nFAKE: sleep 60000" });
    expect(ok.code).toBe(0);
    const run = (ok.reply.data as { run: string }).run;
    const db = env.h.db();
    const event = db.query("SELECT payload FROM events WHERE kind = 'run.dispatched' AND run_id = ?1").get(run) as { payload: string };
    db.close();
    expect(JSON.parse(event.payload)).not.toHaveProperty("mode");
    expect(JSON.parse(event.payload)).not.toHaveProperty("mode_reason");
  });

  test("local-only on a project that is not local-only is refused", async () => {
    const env = await makeFleetEnv({ mode: "no-mistakes", origin: true });
    envs.push(env);
    const refused = await env.json(["dispatch", "web", "--kind", "ship", "--mode", "local-only", "--mode-reason", "x", "--body-file", "-"], { stdin: "x" });
    expect(refused.code).toBe(2);
  });
});
