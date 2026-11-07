/**
 * The automatic contract check stopped mid-suite (SIGKILL, SIGTERM): exactly what its
 * manifest names is released, and the failure and the cleanup are recorded apart.
 * The shared fleet and queries are in test/helpers/auto-contract.ts.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { autoContractSuite, dispatchClaude, events, items, NEW_VERSION, versions } from "../helpers/auto-contract.ts";
import { FAKE_VERSION, setHarnessVersion } from "../helpers/fleet-env.ts";
import { waitUntil } from "../helpers/harness.ts";
import { readManifest, type OwnedResources } from "../../src/contracts/owned.ts";
import { isAlive } from "../../src/runtime/proc.ts";

const fleet = autoContractSuite();

describe("the automatic contract check", () => {
  for (const [signal, releasedBy] of [
    ["SIGKILL", "daemon"],
    ["SIGTERM", "runner"],
  ] as const) {
    test(
      `assumption: a check stopped mid-suite by ${signal} leaves nothing: the ${releasedBy} releases exactly what the manifest names; the failure and the cleanup are recorded apart`,
      async () => {
        const env = await fleet("relaxed");
        // A workspace that is not the contract run's: it must stay.
        const unrelated = env.herdr.addPaneWithStatus(env.repo, "working");
        setHarnessVersion(env.h, "claude", NEW_VERSION);
        expect((await dispatchClaude(env)).error.code).toBe("contract_unverified");

        // The suite's worker is up in the fake Herdr, and the manifest names the scratch daemon.
        const contracts = join(env.h.dataDir, "contracts");
        let owned: OwnedResources | null = null;
        await waitUntil(
          () => {
            const file = existsSync(contracts) ? readdirSync(contracts).find((name) => name.endsWith(".owned.json")) : undefined;
            owned = file ? readManifest(join(contracts, file)).owned : null;
            return Boolean(owned?.runner && owned.daemon) && env.herdr.livePanes().length > 0;
          },
          90_000,
          "the contract worker running",
        );
        const { runner, daemon, home } = owned!;
        // SIGTERM: the runner cleans up itself. SIGKILL, as the deadline's escalation sends it: its whole group, the scratch daemon with it.
        process.kill(signal === "SIGKILL" ? -runner!.pid : runner!.pid, signal);

        await waitUntil(() => events(env, "contract.auto_cleanup").length + events(env, "contract.auto_cleanup_failed").length > 0, 60_000, "the cleanup recorded");
        expect(events(env, "contract.auto_cleanup_failed")).toEqual([]);
        expect(events(env, "contract.auto_cleanup")).toEqual([expect.objectContaining({ harness: "claude", version: NEW_VERSION, ok: true, by: releasedBy })]);
        expect(events(env, "contract.auto_failed")).toEqual([expect.objectContaining({ harness: "claude", version: NEW_VERSION })]);
        expect(versions(env)).toEqual([FAKE_VERSION]);
        expect(items(env, "contract_leftover")).toEqual([]);
        expect(env.herdr.livePanes()).toEqual([]);
        expect(await isAlive(daemon!)).toBe(false);
        expect(existsSync(home)).toBe(false);
        expect(env.herdr.panes.has(unrelated)).toBe(true);
      },
      180_000,
    );
  }

});
