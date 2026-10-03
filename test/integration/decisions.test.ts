import { afterEach, describe, expect, test } from "bun:test";
import { tx } from "../../src/db/db.ts";
import { createStandaloneDecision } from "../../src/lifecycle/decisions.ts";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { waitUntil } from "../helpers/harness.ts";

const envs: FleetEnv[] = [];
afterEach(async () => {
  for (const env of envs.splice(0)) await env.cleanup();
});

async function decisionTask(env: FleetEnv, key: string): Promise<string> {
  const db = env.h.db();
  try {
    return tx(db, () => createStandaloneDecision(db, { key, question: `Decide ${key}?`, options: ["a", "b"], origin: "test", project: "web", now: Date.now() })).taskId;
  } finally {
    db.close();
  }
}

describe("decision blockers", () => {
  test("a ship can be filed waiting on a decision task", async () => {
    const env = await makeFleetEnv();
    envs.push(env);
    const blocker = await decisionTask(env, "pick-db");
    // Let the journal add the task so the backlog snapshot knows its kind.
    await waitUntil(() => env.h.db().query("SELECT 1 FROM intents WHERE task_id = ?1 AND verb = 'hold' AND state = 'applied'").get(blocker) !== null, 10_000, "the decision task held");
    const filed = await env.json(["dispatch", "web", "--kind", "ship", "--blocked-by", blocker, "--auto", "--body-file", "-"], { stdin: "Build it\nFAKE: sleep 100" });
    expect(filed.code).toBe(0);
    expect(filed.reply.data).toMatchObject({ state: "queued", blocked_by: [blocker], auto: "on" });
  });

  test("a scout is still refused as a blocker", async () => {
    const env = await makeFleetEnv();
    envs.push(env);
    const { task } = await env.dispatch("Scout\nFAKE: sleep 60000");
    const filed = await env.json(["dispatch", "web", "--kind", "ship", "--blocked-by", task, "--body-file", "-"], { stdin: "Build it" });
    expect(filed.code).toBe(3);
    expect(JSON.stringify(filed.reply)).toContain("only a ship or a decision");
  });
});
