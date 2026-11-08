/**
 * Relaxed policy: work on an untested Claude version waits on the automatic check instead of
 * being refused (docs/notes/2026-11-06-a-claude-pi-y5.md): a failing check retries once and
 * opens one P1, a plan phase and a resume wait, and an update while waiting is gated again.
 * The shared fleet and queries are in test/helpers/auto-contract.ts.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { autoContractSuite, dispatchClaude, dispatchWaiting, events, items, live, NEW_VERSION, query, runOf, seqOf, versions } from "../helpers/auto-contract.ts";
import { setHarnessVersion } from "../helpers/fleet-env.ts";
import { waitUntil } from "../helpers/harness.ts";
import { contractRevision } from "../../src/contracts/revision.ts";
import { request } from "../../src/transport/unix.ts";
import { ulid } from "../../src/util/ulid.ts";
import { PROTO } from "../../src/version.ts";
import { useIntegrationTimeout } from "../helpers/integration-timeout.ts";

useIntegrationTimeout();

const fleet = autoContractSuite();

describe("the automatic contract check", () => {
  test(
    "relaxed: a failing check keeps the waiting run waiting, retries once, opens one P1; a later manual pass releases it",
    async () => {
      // A step wait of a few ms: every suite run fails at its first wait.
      const env = await fleet("relaxed", undefined, { stepWaitMs: 5 });
      setHarnessVersion(env.h, "claude", NEW_VERSION);
      const run = await dispatchWaiting(env, NEW_VERSION);
      await waitUntil(() => items(env, "harness_unverified").length > 0, 120_000, "the final failure's P1");
      expect(events(env, "contract.auto_failed")).toEqual([expect.objectContaining({ try: 1, final: false }), expect.objectContaining({ try: 2, final: true })]);
      const [p1] = items(env, "harness_unverified");
      expect(p1).toMatchObject({ state: "open", line: expect.stringContaining(`claude ${NEW_VERSION} failed its automatic contract check`) });
      // The line also ends with the doctor command; a test home's long temp path cuts it at 200 characters (the unit test pins the whole line).
      // Two more checker passes: nothing runs again, and the run is still waiting.
      await Bun.sleep(11_000);
      expect(events(env, "contract.auto_started")).toHaveLength(2);
      expect(runOf(env, run)).toMatchObject({ pending_launch: "fresh", launched_at: null });
      const again = await dispatchClaude(env);
      expect(String(again.data.waits)).toStartWith(`waits for claude ${NEW_VERSION} to pass its contract suite: the automatic check failed`);

      // A pass from your own terminal settles the P1 and releases both runs.
      const report = join(env.h.home, "report.json");
      await Bun.write(report, JSON.stringify({ harness: "claude", version: NEW_VERSION, passed: true, mode: "record", build: null, by: "human", revision: contractRevision("claude"), context: { platform: "darwin-arm64 25.3.0", herdr: "0.7.5", launch_profile: "scripted" } }));
      const recorded = (await request(join(env.h.home, "run", "flowrynd.sock"), { proto: PROTO, ulid: ulid(), verb: "contracts.record", token: null, channel: "tty", args: { harness: "claude", version: NEW_VERSION, report } }, { connectMs: 1_000, replyMs: 10_000 })) as { ok: boolean };
      expect(recorded.ok).toBe(true);
      await waitUntil(() => runOf(env, run).launched_at !== null, 30_000, "the waiting run to launch after the manual pass");
      expect(items(env, "harness_unverified").filter((i) => i.state === "open")).toEqual([]);
    },
    240_000,
  );

  test(
    "relaxed: a ready plan phase on an untested version starts its run waiting on the check, with no phase_blocked P1, and launches after the pass",
    async () => {
      const env = await fleet("relaxed");
      setHarnessVersion(env.h, "claude", NEW_VERSION);
      const plan = await env.json(["plan", "web", "--harness", "claude", "--body-file", "-"], { stdin: "## Phase 1: look\nlook around\n" });
      expect(plan.reply.error ?? null).toBeNull();
      await waitUntil(() => query<{ id: string }>(env, "SELECT id FROM runs").length > 0, 120_000, "the phase's run");
      const run = query<{ id: string }>(env, "SELECT id FROM runs")[0]!.id;
      expect(items(env, "phase_blocked")).toEqual([]);
      await waitUntil(() => runOf(env, run).launched_at !== null, 170_000, "the phase's run to launch after the pass");
      expect(versions(env)).toContain(NEW_VERSION);
      expect(items(env, "phase_blocked")).toEqual([]);
    },
    200_000,
  );

  test(
    "relaxed: a resume on an untested version replies waiting and launches only after the automatic pass",
    async () => {
      const env = await fleet("relaxed");
      const dispatched = await dispatchClaude(env);
      expect(dispatched.code).toBe(0);
      const run = String(dispatched.data.run);
      const first = await env.waitRun(run, live, "the worker running", 60_000);
      // The first death is resumed by the reconciler on the tested version; the second is yours to resume.
      env.herdr.killHarness(first.pane_id!, "SIGKILL");
      await env.waitRun(run, (r) => r.resume_count === 1 && live(r), "the automatic resume running", 60_000);
      setHarnessVersion(env.h, "claude", NEW_VERSION);
      env.herdr.killHarness(env.run(run).pane_id!, "SIGKILL");
      await env.waitRun(run, (r) => r.liveness === "dead" && r.pending_launch === null, "the second death left for you", 60_000);
      const launchesBefore = seqOf(env, "run.launched", `run_id = '${run}'`).length;

      const resumed = await env.json(["resume", run]);
      expect(resumed.code).toBe(0);
      expect(resumed.reply.data).toMatchObject({ state: "waiting", waits: `waits on the automatic contract check for claude ${NEW_VERSION}; starts by itself once it passes` });
      expect(runOf(env, run).pending_launch).toBe("resume");
      await waitUntil(() => seqOf(env, "run.launched", `run_id = '${run}'`).length > launchesBefore, 170_000, "the resume to launch after the pass");
      const newerPass = seqOf(env, "contract.passed", `json_extract(payload, '$.version') = '${NEW_VERSION}'`)[0]!;
      expect(newerPass).toBeLessThan(seqOf(env, "run.launched", `run_id = '${run}'`).at(-1)!);
      expect(runOf(env, run).harness_version).toBe(NEW_VERSION);
    },
    300_000,
  );

  test(
    "relaxed: Claude updating again while a run waits is gated again at the grant: it launches only on the newer version's pass, and records that version",
    async () => {
      const env = await fleet("relaxed");
      setHarnessVersion(env.h, "claude", NEW_VERSION);
      const run = await dispatchWaiting(env, NEW_VERSION);
      const NEWER = "9.9.11";
      setHarnessVersion(env.h, "claude", NEWER);
      await waitUntil(() => runOf(env, run).launched_at !== null, 170_000, "the waiting run to launch on the newer version");
      expect(versions(env)).toContain(NEWER);
      expect(runOf(env, run).harness_version).toBe(NEWER);
      expect(events(env, "run.harness_version")).toEqual([expect.objectContaining({ harness: "claude", from: NEW_VERSION, to: NEWER })]);
      const newerPass = seqOf(env, "contract.passed", `json_extract(payload, '$.version') = '${NEWER}'`)[0]!;
      expect(newerPass).toBeLessThan(seqOf(env, "run.launching", `run_id = '${run}'`)[0]!);
    },
    240_000,
  );
});
