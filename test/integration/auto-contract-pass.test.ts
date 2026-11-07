/**
 * The automatic contract check, relaxed policy: a new Claude version, and a pass at another
 * contract revision, are checked by the daemon from its pinned build and recorded; a dispatch
 * meanwhile waits on the check and launches after the pass.
 * The shared fleet and queries are in test/helpers/auto-contract.ts.
 */
import { describe, expect, test } from "bun:test";
import { autoContractSuite, dispatchClaude, dispatchWaiting, events, items, NEW_VERSION, query, runOf, seqOf, versions } from "../helpers/auto-contract.ts";
import { FAKE_VERSION, setHarnessVersion } from "../helpers/fleet-env.ts";
import { waitUntil } from "../helpers/harness.ts";
import { contractRevision } from "../../src/contracts/revision.ts";

const fleet = autoContractSuite();

describe("the automatic contract check", () => {
  test(
    "relaxed: a new Claude version is checked by the daemon from its pinned build and recorded, with no P1",
    async () => {
      // A capacity alert after 1s: the check takes longer, and a run waiting on it is the check's to report, never a capacity P1.
      const env = await fleet("relaxed", undefined, { extraConfig: "[sched]\npass_ms = 300\nwait_alert_ms = 1000" });
      setHarnessVersion(env.h, "claude", NEW_VERSION);
      const run = await dispatchWaiting(env, NEW_VERSION);
      const since = query<{ waiting_since: number }>(env, "SELECT waiting_since FROM runs WHERE id = ?1", run)[0]!.waiting_since;
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
      const passedAt = query<{ ts: number }>(env, "SELECT ts FROM events WHERE kind = 'contract.passed' ORDER BY seq LIMIT 1")[0]!.ts;
      expect(passedAt - since).toBeGreaterThan(1_000 + 2 * 300);
      expect(seqOf(env, "sched.waiting").filter((seq) => seq < seqOf(env, "contract.passed")[0]!)).toEqual([]);
      // The dispatch that waited launches by itself once the pass is recorded, never before it.
      await waitUntil(() => runOf(env, run).launched_at !== null, 30_000, "the waiting run to launch");
      expect(runOf(env, run).harness_version).toBe(NEW_VERSION);
      // launched_at is written with run.launching (run.launched follows once the worker process is up).
      expect(seqOf(env, "contract.passed")[0]!).toBeLessThan(seqOf(env, "run.launching", `run_id = '${run}'`)[0]!);
    },
    180_000,
  );

  test(
    "relaxed: a pass at another revision (as after a bump) is re-run by the daemon and recorded at this build's revision, with its context, and no P1",
    async () => {
      const revision = contractRevision("claude");
      const env = await fleet("relaxed", revision + 1);
      const waiting = await dispatchClaude(env);
      expect(waiting.data).toMatchObject({ state: "waiting", waits: `waits on the automatic contract check for claude ${FAKE_VERSION}; starts by itself once it passes` });
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
