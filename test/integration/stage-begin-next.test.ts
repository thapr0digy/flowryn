import { afterEach, describe, expect, test } from "bun:test";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";
import { useIntegrationTimeout } from "../helpers/integration-timeout.ts";

useIntegrationTimeout();

/**
 * Build goes straight on (docs/notes/2026-11-06-prompts-that-keep-47.md): an
 * ungated stage ends with `stage begin <next>`, whose reply carries the next
 * stage's steps, so the worker carries on in the same turn. The whole run
 * here, build → check → ship, is one turn of the fake worker: no stage start
 * needs a steer, and the delivery follows at once.
 */

let ship: ShipEnv | null = null;

afterEach(async () => {
  await ship?.cleanup();
  ship = null;
});

const THREE_STAGES = '[workflows.steps]\nstages = [ { id = "build", skill = "flowryn-build-test" }, { id = "check" }, { id = "ship", gate = "merge" } ]\n';

function rows<T>(e: ShipEnv, sql: string, ...params: string[]): T[] {
  const db = e.fleet.h.db();
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

describe("stage begin <next>", () => {
  test(
    "build → check → ship in one turn: each stage begin starts the next stage under the call with its steps, no steer, and the delivery follows",
    async () => {
      ship = await makeShipEnv({ mode: "local-only", extraConfig: THREE_STAGES });
      const e = ship;
      const f = e.fleet;
      expect((await f.json(["project", "set", "web", "--workflow", "steps"])).code).toBe(0);
      const steps = ["Straight through", "FAKE: commit a.txt a", "FAKE: verb stage begin check", "FAKE: verb stage begin ship", "FAKE: deliver-local", "FAKE: sleep 120000"];
      const dispatched = await f.json(["dispatch", "web", "--kind", "ship", "--body-file", "-"], { stdin: steps.join("\n") });
      expect(dispatched.code).toBe(0);
      const { task, run } = dispatched.reply.data as { task: string; run: string };

      await f.waitRun(run, (r) => r.state === "ready", "the delivery", 60_000);
      const replies = await e.replies(task, 3);
      const begins = replies.filter((r) => r.args[0] === "stage" && r.args[1] === "begin");
      expect(begins.map((r) => r.reply.ok)).toEqual([true, true]);
      const [toCheck, toShip] = begins.map((r) => r.reply.data as { stage: string; state: string; steps: string });
      expect(toCheck).toMatchObject({ stage: "check", state: "active" });
      expect(toCheck!.steps).toContain("Flowryn stage check (2 of 3;");
      expect(toCheck!.steps).toContain("$FLOWRYN_BIN stage begin ship and go on at once");
      expect(toShip).toMatchObject({ stage: "ship", state: "active" });
      expect(toShip!.steps).toContain("This is the last stage.");
      // Every stage started under the worker's own call: no stage start was steered, so no turn had to end for one.
      const started = rows<{ payload: string }>(e, "SELECT payload FROM events WHERE run_id = ?1 AND kind = 'stage.started' ORDER BY seq", run).map((r) => JSON.parse(r.payload) as { stage: string; steer: string | null });
      expect(started.map((s) => s.stage)).toEqual(["build", "check", "ship"]);
      expect(started.every((s) => s.steer === null)).toBe(true);
      expect(rows(e, "SELECT id FROM messages WHERE run_id = ?1", run)).toEqual([]);
    },
    { timeout: 120_000 },
  );

  test(
    "stage begin names only the next or the last stage",
    async () => {
      ship = await makeShipEnv({ mode: "local-only", extraConfig: THREE_STAGES });
      const e = ship;
      const f = e.fleet;
      expect((await f.json(["project", "set", "web", "--workflow", "steps"])).code).toBe(0);
      const steps = ["Wrong stage", "FAKE: verb stage begin nope", "FAKE: commit a.txt a", "FAKE: deliver-local", "FAKE: sleep 120000"];
      const dispatched = await f.json(["dispatch", "web", "--kind", "ship", "--body-file", "-"], { stdin: steps.join("\n") });
      const { task } = dispatched.reply.data as { task: string };
      const [refused] = await e.replies(task, 1);
      expect(refused!.reply.error).toMatchObject({ code: "bad_args", message: "stage begin starts your next or last stage (check or ship), not nope" });
    },
    { timeout: 120_000 },
  );
});
