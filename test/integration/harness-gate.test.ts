/**
 * The harness version gate (design sections 5 and 16): the daemon checks the
 * installed harness version at startup, at dispatch and before a resume or
 * launch. An untested version refuses (contract_unverified) and opens one P1
 * with the doctor command, once per version; a passing contract run settles it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASELINE_REVISION, contractRevision } from "../../src/contracts/revision.ts";
import type { HarnessId } from "../../src/harness/types.ts";
import { request } from "../../src/transport/unix.ts";
import { ulid } from "../../src/util/ulid.ts";
import { PROTO } from "../../src/version.ts";
import { FAKE_VERSION, makeFleetEnv, setHarnessVersion, type FleetEnv } from "../helpers/fleet-env.ts";
import { waitUntil } from "../helpers/harness.ts";

const envs: FleetEnv[] = [];
async function fleet(options: Parameters<typeof makeFleetEnv>[0] = {}): Promise<FleetEnv> {
  const env = await makeFleetEnv(options);
  envs.push(env);
  return env;
}
afterEach(async () => {
  for (const env of envs.splice(0)) await env.cleanup();
});

interface ItemView {
  id: string;
  kind: string;
  lane: string;
  state: string;
  line: string;
  task_id: string | null;
}

function harnessItems(env: FleetEnv): ItemView[] {
  const db = env.h.db();
  try {
    return db.query("SELECT id, kind, lane, state, line, task_id FROM items WHERE kind = 'harness_unverified' ORDER BY opened_at").all() as ItemView[];
  } finally {
    db.close();
  }
}

function eventKinds(env: FleetEnv, kind: string): Record<string, unknown>[] {
  const db = env.h.db();
  try {
    return (db.query("SELECT payload FROM events WHERE kind = ?1 ORDER BY seq").all(kind) as { payload: string }[]).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
  } finally {
    db.close();
  }
}

/** The report a passing run writes, proving `revision` (none: a report from before revisions). */
function passReport(env: FleetEnv, harness: HarnessId, version: string, revision: number | null): string {
  const path = join(env.h.home, `report-${harness}-${version}-${revision ?? "none"}.json`);
  const proved = revision === null ? {} : { revision, context: { platform: "darwin-arm64 25.3.0", herdr: "0.7.5", launch_profile: "scripted" } };
  writeFileSync(path, JSON.stringify({ harness, version, passed: true, mode: "record", build: null, by: "human", ...proved }));
  return path;
}

/** What `flowryn doctor --contracts` in your own terminal does once a suite passes: the daemon records the version at the revision its report proves (this build's by default). */
async function recordContract(env: FleetEnv, harness: HarnessId, version: string, revision: number | null = contractRevision(harness)): Promise<Record<string, unknown>> {
  const report = passReport(env, harness, version, revision);
  const answer = (await request(join(env.h.home, "run", "flowrynd.sock"), { proto: PROTO, ulid: ulid(), verb: "contracts.record", token: null, channel: "tty", args: { harness, version, report } }, { connectMs: 1_000, replyMs: 10_000 })) as {
    ok: boolean;
    data: Record<string, unknown>;
  };
  expect(answer.ok).toBe(true);
  return answer.data;
}

describe("the harness version gate", () => {
  // An executed binary rewritten in place is SIGKILLed on exec by macOS now and then, so the daemon read no version (docs/notes/2026-10-12-fix-the-flaky-8d.md).
  test("a harness update replaces the stand-in binary rather than rewriting it in place", async () => {
    const env = await fleet({ contracts: false });
    const binary = join(env.h.home, "bin", "claude");
    const before = statSync(binary).ino;
    setHarnessVersion(env.h, "claude", "9.9.10");
    expect(statSync(binary).ino).not.toBe(before);
    expect(new TextDecoder().decode(Bun.spawnSync([binary, "--version"]).stdout)).toContain("9.9.10");
  });

  test(
    "at startup an untested version in use opens one P1 with the doctor command; a restart does not repeat it; a passing run settles it",
    async () => {
      const env = await fleet({ contracts: false });
      // The project (harness claude) was added after the daemon started: the next start checks it.
      await env.daemon.stop();
      await env.restartDaemon();
      await waitUntil(() => harnessItems(env).length === 1, 10_000, "the P1 for claude");
      const [item] = harnessItems(env);
      expect(item).toMatchObject({ kind: "harness_unverified", lane: "P1", state: "open", task_id: "harness:claude" });
      expect(item!.line).toContain(`claude ${FAKE_VERSION} has no passing contract run`);
      expect(item!.line).toContain("flowryn doctor --contracts --harness claude");
      expect(eventKinds(env, "harness.checked")).toEqual(expect.arrayContaining([expect.objectContaining({ harness: "claude", state: "unverified", version: FAKE_VERSION })]));

      // Dismissed, it is not reopened for the same version, not even by the next startup.
      expect((await env.json(["dismiss", item!.id])).code).toBe(0);
      await env.daemon.stop();
      await env.restartDaemon();
      await waitUntil(() => eventKinds(env, "harness.checked").length >= 2, 10_000, "the second startup check");
      expect(harnessItems(env).map((i) => i.state)).toEqual(["dismissed"]);

      // An update to another untested version is a new P1; a passing run for it settles it.
      setHarnessVersion(env.h, "claude", "9.9.10");
      await env.daemon.stop();
      await env.restartDaemon();
      await waitUntil(() => harnessItems(env).length === 2, 10_000, "the P1 for 9.9.10");
      expect(harnessItems(env)[1]!.line).toContain("claude 9.9.10");
      await recordContract(env, "claude", "9.9.10");
      await waitUntil(() => harnessItems(env)[1]!.state === "resolved", 5_000, "the P1 resolved by the passing run");
    },
    { timeout: 60_000 },
  );

  test(
    "dispatch on an untested version refuses with the doctor command and opens the P1",
    async () => {
      const env = await fleet({ contracts: false });
      const refused = await env.json(["dispatch", "web", "--kind", "scout", "--body-file", "-"], { stdin: "Scout it" });
      expect(refused.code).toBe(2);
      expect(refused.reply.error).toMatchObject({ code: "contract_unverified", help: "run the contract suite: flowryn doctor --contracts --harness claude" });
      expect(harnessItems(env)).toHaveLength(1);
      // Once per version: a second refusal adds nothing.
      expect((await env.json(["dispatch", "web", "--kind", "scout", "--body-file", "-"], { stdin: "Scout it" })).code).toBe(2);
      expect(harnessItems(env)).toHaveLength(1);
    },
    { timeout: 30_000 },
  );

  test(
    "a worker that dies on an untested version is not resumed until the contract passes; resume refuses meanwhile",
    async () => {
      const env = await fleet();
      const { run } = await env.dispatch("Scout\nFAKE: sleep 3000\nFAKE: deliver r.md resumed after the contract passed");
      const busy = await env.waitRun(run, (r) => r.liveness === "busy", "busy");
      // Claude updates itself to a version no contract run covers, and the worker dies.
      setHarnessVersion(env.h, "claude", "9.9.11");
      env.herdr.killHarness(busy.pane_id!, "SIGKILL");
      const waiting = await env.waitRun(run, (r) => r.pending_launch === "resume" && r.liveness === "dead", "the resume to wait for the contract", 20_000);
      expect(waiting.resume_count).toBe(1);
      expect(env.events(run)).toContain("run.resume_deferred");
      expect(env.events(run)).not.toContain("run.auto_resumed");
      await waitUntil(() => harnessItems(env).some((i) => i.line.includes("claude 9.9.11") && i.state === "open"), 10_000, "the P1 for 9.9.11");
      // Nothing launches while it waits, and a manual resume is refused the same way.
      await Bun.sleep(1_500);
      expect(env.herdr.livePanes()).toHaveLength(0);
      const resume = await env.json(["resume", run]);
      expect(resume.code).toBe(2);
      expect(resume.reply.error).toMatchObject({ code: "contract_unverified" });
      const capacity = await env.json(["capacity"]);
      expect(JSON.stringify(capacity.reply.data)).toContain("claude 9.9.11 has no passing contract");

      // The contract passes: the scheduler launches the one resume, in the same session.
      await recordContract(env, "claude", "9.9.11");
      const done = await env.waitRun(run, (r) => r.state !== "running" && r.state !== "launching", "the resumed run to deliver", 30_000);
      expect(["landed", "cleaned"]).toContain(done.state);
      expect(done.resume_count).toBe(1);
      const start = env.herdr.calls.filter((c) => c.method === "agent.start").at(-1)!;
      expect(start.params.args as string[]).toContain("--resume");
      expect(harnessItems(env).find((i) => i.line.includes("9.9.11"))?.state).toBe("resolved");
    },
    { timeout: 60_000 },
  );

  test(
    "a pass from another contract revision is stale: startup and dispatch name its revision, and a pass at the current revision lets dispatch through",
    async () => {
      const env = await fleet({ contracts: false });
      const revision = contractRevision("claude");
      const other = revision + 1;
      // A pass recorded from a build at another revision (a PR that bumped it, run in your terminal).
      expect(await recordContract(env, "claude", FAKE_VERSION, other)).toMatchObject({ revision: other, current: false, required_revision: revision });
      await env.daemon.stop();
      await env.restartDaemon();
      await waitUntil(() => harnessItems(env).length === 1, 10_000, "the P1 for the stale pass");
      const stale = `claude ${FAKE_VERSION} passed only at contract revision ${other}, not revision ${revision}`;
      expect(harnessItems(env)[0]!.line).toStartWith(`${stale}, so dispatch and resume on claude are refused until it passes: flowryn doctor --contracts --harness claude`);
      expect(eventKinds(env, "harness.checked")).toEqual(expect.arrayContaining([expect.objectContaining({ harness: "claude", state: "unverified", version: FAKE_VERSION, revision })]));
      expect(eventKinds(env, "harness.unverified")).toEqual([expect.objectContaining({ version: FAKE_VERSION, revision, stale: [other] })]);

      const refused = await env.json(["dispatch", "web", "--kind", "scout", "--body-file", "-"], { stdin: "Scout it" });
      expect(refused.code).toBe(2);
      expect(refused.reply.error).toMatchObject({ code: "contract_unverified", message: stale });
      expect(harnessItems(env)).toHaveLength(1);

      // The same version passes again at this build's revision: the P1 settles and dispatch goes through.
      expect(await recordContract(env, "claude", FAKE_VERSION)).toMatchObject({ revision, current: true });
      await waitUntil(() => harnessItems(env)[0]!.state === "resolved", 5_000, "the P1 resolved by the current pass");
      const dispatched = await env.json(["dispatch", "web", "--kind", "scout", "--body-file", "-"], { stdin: "Scout it" });
      expect(dispatched.code).toBe(0);
    },
    { timeout: 60_000 },
  );

  test(
    "a pass recorded before revisions is at the baseline: the upgrade refuses nothing",
    async () => {
      const env = await fleet({ contracts: false });
      // A report from a flowryn before revisions names none: the baseline, which this build's revision is until a bump.
      expect(await recordContract(env, "claude", FAKE_VERSION, null)).toMatchObject({ revision: BASELINE_REVISION, current: BASELINE_REVISION === contractRevision("claude") });
      const dispatched = await env.json(["dispatch", "web", "--kind", "scout", "--body-file", "-"], { stdin: "Scout it" });
      expect(dispatched.code).toBe(BASELINE_REVISION === contractRevision("claude") ? 0 : 2);
      expect(harnessItems(env)).toHaveLength(BASELINE_REVISION === contractRevision("claude") ? 0 : 1);
    },
    { timeout: 30_000 },
  );
});
