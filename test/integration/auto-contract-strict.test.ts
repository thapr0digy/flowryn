/**
 * The automatic contract check under strict policy: a new Claude version only opens the P1.
 * The shared fleet and queries are in test/helpers/auto-contract.ts.
 */
import { describe, expect, test } from "bun:test";
import { AUTO_TEST_POLL_MS, autoContractSuite, dispatchClaude, events, items, NEW_VERSION, versions } from "../helpers/auto-contract.ts";
import { FAKE_VERSION, setHarnessVersion } from "../helpers/fleet-env.ts";
import { waitUntil } from "../helpers/harness.ts";
import { useIntegrationTimeout } from "../helpers/integration-timeout.ts";

useIntegrationTimeout();

const fleet = autoContractSuite();

describe("the automatic contract check", () => {
  test(
    "strict: the same bump only opens the P1; nothing runs",
    async () => {
      const env = await fleet("strict");
      setHarnessVersion(env.h, "claude", NEW_VERSION);
      expect(await dispatchClaude(env)).toMatchObject({ error: { code: "contract_unverified" } });
      await waitUntil(() => items(env, "harness_unverified").length > 0, 10_000, "the P1");
      // Nothing to wait on for "nothing runs": two more of the checker's passes (FLOWRYN_CONTRACT_POLL_MS) must start no check.
      await Bun.sleep(AUTO_TEST_POLL_MS * 2 + 250);
      expect(items(env, "harness_unverified")).toEqual([expect.objectContaining({ state: "open", line: expect.stringContaining(`claude ${NEW_VERSION} has no passing contract run`) })]);
      expect(events(env, "contract.auto_started")).toEqual([]);
      expect(versions(env)).toEqual([FAKE_VERSION]);
    },
    60_000,
  );
});
