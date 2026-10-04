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
  });

  test("local-only on a project that is not local-only is refused", async () => {
    const env = await makeFleetEnv({ mode: "no-mistakes", origin: true });
    envs.push(env);
    const refused = await env.json(["dispatch", "web", "--kind", "ship", "--mode", "local-only", "--mode-reason", "x", "--body-file", "-"], { stdin: "x" });
    expect(refused.code).toBe(2);
  });
});
