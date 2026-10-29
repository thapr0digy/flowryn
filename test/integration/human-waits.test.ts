import { afterEach, describe, expect, test } from "bun:test";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { waitUntil } from "../helpers/harness.ts";

/**
 * Wait explanations for questions and reviews, end to end through the real
 * daemon, CLI and a fake worker (docs/notes/2026-10-29-why-waiting-covers-fy.md):
 * the scheduler's pass records them, `show --why` names who acts and the
 * command, and they close when the question is answered and the gate closes.
 */

const envs: FleetEnv[] = [];
afterEach(async () => {
  for (const env of envs.splice(0)) await env.cleanup();
});

interface Why {
  rule: string;
  reason: string;
  unblock: string[];
}

async function why(env: FleetEnv, task: string): Promise<Why[]> {
  const shown = await env.json(["show", task, "--why"]);
  return ((shown.reply.data as { waiting?: Why[] }).waiting ?? []) as Why[];
}

async function timeline(env: FleetEnv, task: string): Promise<string[]> {
  const shown = await env.json(["show", task, "--timeline"]);
  return (shown.reply.data as { timeline?: string[] }).timeline ?? [];
}

describe("waits on you or the leader", () => {
  test(
    "a worker's question, then its design review, each named with who acts and the command; each closes when it ends",
    async () => {
      const env = await makeFleetEnv();
      envs.push(env);
      expect((await env.json(["project", "set", "web", "--workflow", "feature-ui"])).code).toBe(0);
      const asking = await env.dispatch("Ask\nFAKE: ask postgres,sqlite which database\nFAKE: sleep 120000", { kind: "ship" });
      const reviewing = await env.dispatch("Design\nFAKE: stage-done --review lavish:design/design.html\nFAKE: sleep 120000", { kind: "ship" });

      let waits: Why[] = [];
      await waitUntil(async () => (waits = await why(env, asking.task)).some((w) => w.rule === "decision.leader"), 20_000, "the question explained");
      const question = waits.find((w) => w.rule === "decision.leader")!;
      expect(question.reason).toBe("waiting for the leader to answer q1 (the worker is blocked)");
      expect(question.unblock[0]).toBe("leader: flowryn decide q1 <choice> --rationale -");
      expect((await env.json(["answer", "q1", "sqlite"])).code).toBe(0);
      await waitUntil(async () => (await timeline(env, asking.task)).some((l) => l.includes("decision.leader") && l.includes("→ answered by ")), 20_000, "the question row closed");
      expect(await why(env, asking.task)).toEqual([]);

      await waitUntil(async () => (waits = await why(env, reviewing.task)).some((w) => w.rule === "gate.review"), 20_000, "the review explained");
      const review = waits.find((w) => w.rule === "gate.review")!;
      expect(review.reason).toMatch(/^waiting for your design review \(g\d+\)$/);
      expect(review.unblock[0]).toMatch(/^captain: answer on the review page http:\/\/127\.0\.0\.1:4387\/session\//);
      expect(review.unblock[1]).toBe(`captain: in your shell: flowryn approve ${reviewing.task} --gate design, or flowryn gate changes ${reviewing.task} --body-file -`);
      expect((await env.json(["gate", "changes", reviewing.task, "--body-file", "-"], { stdin: "Use postgres after all" })).code).toBe(0);
      await waitUntil(async () => (await timeline(env, reviewing.task)).some((l) => l.includes("gate.review") && l.includes("→ gate changes")), 20_000, "the review row closed");
    },
    { timeout: 60_000 },
  );
});
