/**
 * The automatic contract check, relaxed policy: a new Claude version, and a pass at another
 * contract revision, are checked by the daemon from its pinned build and recorded.
 * The shared fleet and queries are in test/helpers/auto-contract.ts.
 */
import { describe, expect, test } from "bun:test";
import { autoContractSuite, dispatchClaude, events, items, NEW_VERSION, query, versions } from "../helpers/auto-contract.ts";
import { FAKE_VERSION, setHarnessVersion } from "../helpers/fleet-env.ts";
import { waitUntil } from "../helpers/harness.ts";
import { contractRevision } from "../../src/contracts/revision.ts";

const fleet = autoContractSuite();

describe("the automatic contract check", () => {
  test(
    "relaxed: a new Claude version is checked by the daemon from its pinned build and recorded, with no P1",
    async () => {
      const env = await fleet("relaxed");
      setHarnessVersion(env.h, "claude", NEW_VERSION);
      const refused = await dispatchClaude(env);
      expect(refused.error.code).toBe("contract_unverified");
      try {
        await waitUntil(() => versions(env).includes(NEW_VERSION), 120_000, `the daemon to record claude ${NEW_VERSION}`);
      } catch (error) {
        throw new Error(`${(error as Error).message}; events: ${JSON.stringify(events(env, "contract.auto_failed"))}; daemon: ${await Promise.race([env.daemon.output(), Bun.sleep(100).then(() => "")])}`, { cause: error });
      }
      expect(versions(env).toSorted()).toEqual([FAKE_VERSION, NEW_VERSION].toSorted());
      const [started] = events(env, "contract.auto_started");
      expect(started).toMatchObject({ harness: "claude", version: NEW_VERSION });
      const build = String(started!.build);
      expect(build).toMatch(/^[0-9a-f]{12}$/);
      expect(events(env, "contract.passed")).toEqual([expect.objectContaining({ harness: "claude", version: NEW_VERSION, by: "daemon", build })]);
      expect(items(env, "contract_recorded")).toEqual([expect.objectContaining({ class: "info", line: expect.stringContaining(`claude ${NEW_VERSION} passed, recorded automatically (build ${build})`) })]);
      expect(items(env, "harness_unverified")).toEqual([]);
      expect(env.herdr.livePanes()).toEqual([]);
    },
    180_000,
  );

  test(
    "relaxed: a pass at another revision (as after a bump) is re-run by the daemon and recorded at this build's revision, with its context, and no P1",
    async () => {
      const revision = contractRevision("claude");
      const env = await fleet("relaxed", revision + 1);
      const refused = await env.json(["dispatch", "web", "--kind", "scout", "--harness", "claude", "--body-file", "-"], { stdin: "look around" });
      expect(refused.reply.error).toMatchObject({ code: "contract_unverified", message: `claude ${FAKE_VERSION} passed only at contract revision ${revision + 1}, not revision ${revision}` });
      const revisions = () => query<{ revision: number }>(env, "SELECT revision FROM harness_contracts WHERE harness = 'claude' AND version = ?1 ORDER BY revision", FAKE_VERSION).map((r) => r.revision);
      try {
        await waitUntil(() => revisions().includes(revision), 120_000, `the daemon to record claude ${FAKE_VERSION} at revision ${revision}`);
      } catch (error) {
        throw new Error(`${(error as Error).message}; events: ${JSON.stringify(events(env, "contract.auto_failed"))}`, { cause: error });
      }
      expect(revisions()).toEqual([revision, revision + 1]);
      expect(events(env, "contract.auto_started")).toEqual([expect.objectContaining({ harness: "claude", version: FAKE_VERSION, revision })]);
      const [passed] = events(env, "contract.passed");
      expect(passed).toMatchObject({ harness: "claude", version: FAKE_VERSION, revision, by: "daemon", herdr_version: "0.7.5-test" });
      expect(String(passed!.platform)).toStartWith(`${process.platform}-${process.arch} `);
      expect(String(passed!.launch_profile)).toStartWith("model=");
      expect(items(env, "harness_unverified")).toEqual([]);
      expect((await dispatchClaude(env)).code).toBe(0);
    },
    180_000,
  );

});
