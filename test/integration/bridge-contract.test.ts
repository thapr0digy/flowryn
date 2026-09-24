import { afterEach, describe, expect, test } from "bun:test";
import { BRIDGE_STEPS } from "../../src/contracts/bridge-suite.ts";
import { makeLeaderEnv, type LeaderEnv } from "../helpers/leader-env.ts";

/**
 * The shared leader bridge contract suite (design section 17, M3), against
 * fake leaders that run the real bridge artifacts: the Claude leader settings
 * file's hook commands, and the Pi leader extension in a fake Pi.
 */
let env: LeaderEnv | null = null;

afterEach(async () => {
  await env?.cleanup();
  env = null;
});

describe("leader bridge contract", () => {
  for (const harness of ["claude", "pi"] as const) {
    test(
      `${harness} passes every step`,
      async () => {
        env = await makeLeaderEnv();
        const drivers = harness === "claude" ? [await env.claude(), await env.claude()] : [await env.pi(), await env.pi()];
        const bridge = env.bridgeEnv(harness, [drivers[0]!, drivers[1]!]);
        const done: string[] = [];
        for (const step of BRIDGE_STEPS) {
          try {
            done.push(`${step.name}: ${await step.run(bridge)}`);
          } catch (error) {
            throw new Error(`step "${step.name}" failed after [${done.join(" | ")}]: ${(error as Error).message}`, { cause: error });
          }
        }
        expect(done.length).toBe(BRIDGE_STEPS.length);
      },
      180_000,
    );
  }
});
