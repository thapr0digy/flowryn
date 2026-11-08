import { afterEach, describe, expect, test } from "bun:test";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { useIntegrationTimeout } from "../helpers/integration-timeout.ts";

useIntegrationTimeout();

/**
 * A stage's own effort and a review stage's model end to end (docs/notes/2026-11-06-effort-and-model-gn.md):
 * through the real CLI and daemon with a fake Herdr, each stage's launch flags follow the stage, a stage start
 * whose choice differs relaunches the worker's own session under the new flags, and show and fleet print them.
 */

const envs: FleetEnv[] = [];
afterEach(async () => {
  for (const env of envs.splice(0)) await env.cleanup();
});

const TIERED = `
[projects.web]
review_model = "sonnet"

[workflows.tiered]
stages = [
  { id = "look", effort = "high" },
  { id = "check", review = true, effort = "low" },
]

[workflows.firstreview]
stages = [{ id = "check", review = true, effort = "high" }]
`;

async function fleet(): Promise<FleetEnv> {
  const env = await makeFleetEnv({ extraConfig: TIERED });
  envs.push(env);
  return env;
}

function starts(env: FleetEnv): string[][] {
  return env.herdr.calls.filter((c) => c.method === "agent.start").map((c) => (c.params as { args: string[] }).args);
}

function flag(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1]!;
}

function eventPayloads(env: FleetEnv, runId: string, kind: string): Record<string, unknown>[] {
  const db = env.h.db();
  try {
    return (db.query("SELECT payload FROM events WHERE run_id = ?1 AND kind = ?2 ORDER BY seq").all(runId, kind) as { payload: string }[]).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
  } finally {
    db.close();
  }
}

describe("per-stage effort and the review model", () => {
  test("the first stage launches at its effort; the review stage relaunches the same session on review_model at its own effort", async () => {
    const env = await fleet();
    const sent = await env.json(["dispatch", "web", "--kind", "scout", "--harness", "claude", "--workflow", "tiered", "--body-file", "-"], {
      stdin: "look around\nFAKE: sleep 300\nFAKE: stage-done\nFAKE: sleep 60000",
    });
    expect(sent.code).toBe(0);
    const { run: runId, task } = sent.reply.data as { run: string; task: string };
    expect(sent.reply.data).toMatchObject({ effort: "high (stage look)", model: "default (harness default)" });
    const first = await env.waitRun(runId, (r) => r.proc_pid !== null, "the worker launched");
    const launch = starts(env)[0]!;
    expect(flag(launch, "--effort")).toBe("high");
    expect(launch).not.toContain("--model");

    const relaunched = await env.waitRun(runId, (r) => r.stage === "check" && r.proc_pid !== null && r.proc_pid !== first.proc_pid && r.pending_launch === null, "the relaunched worker", 30_000);
    const again = starts(env).at(-1)!;
    expect(again).toContain("--resume");
    expect(flag(again, "--resume")).toBe(first.agent_session);
    expect(flag(again, "--model")).toBe("sonnet");
    expect(flag(again, "--effort")).toBe("low");
    expect(relaunched).toMatchObject({ model: "sonnet", effort: "low", agent_session: first.agent_session });
    expect(eventPayloads(env, runId, "stage.requested").at(-1)).toMatchObject({ stage: "check", from: "look", relaunch: true });
    expect(eventPayloads(env, runId, "run.relaunch")).toHaveLength(1);
    expect(eventPayloads(env, runId, "run.launched").at(-1)).toMatchObject({ model_source: "review_model (stage check)", effort_source: "stage check" });

    const shown = await env.json(["show", task]);
    expect(shown.reply.data).toMatchObject({
      model: "sonnet (review_model (stage check))",
      effort: "low (stage check)",
      stages: ["look: default (harness default) · high (stage look)", "check: sonnet (review_model (stage check)) · low (stage check)"],
    });
    const listed = await env.json(["fleet"]);
    expect((listed.reply.data as { fleet: { id: string; model: string }[] }).fleet.find((r) => r.id === task)).toMatchObject({ model: "sonnet · low" });
  }, 60_000);

  test("a Pi worker at a review stage gets the stage's effort and no model: review_model is Claude's only", async () => {
    const env = await fleet();
    const sent = await env.json(["dispatch", "web", "--kind", "scout", "--harness", "pi", "--workflow", "firstreview", "--body-file", "-"], { stdin: "look\nFAKE: sleep 60000" });
    expect(sent.code).toBe(0);
    const runId = (sent.reply.data as { run: string }).run;
    await env.waitRun(runId, (r) => r.proc_pid !== null, "the Pi worker launched");
    const launch = starts(env).at(-1)!;
    expect(flag(launch, "--thinking")).toBe("high");
    expect(launch).not.toContain("--model");
  }, 30_000);
});
