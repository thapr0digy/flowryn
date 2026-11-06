/**
 * The automatic contract check end to end (spec 3, phase 2): a compiled
 * daemon (only a compiled build may vouch for a version) in a fleet whose
 * fake Herdr starts the instruction-following contract fakes
 * (test/helpers/fake-contract-claude.ts, as in contracts-offline.test.ts). The
 * stand-in Claude reports a new version and a dispatch trips the gate; under
 * relaxed policy the daemon runs `doctor --contracts --for-daemon` from its
 * pinned build and records the pass itself, under strict it only opens the P1.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_VERSION, makeFleetEnv, setHarnessVersion, type FleetEnv } from "../helpers/fleet-env.ts";
import { REPO_ROOT, waitUntil } from "../helpers/harness.ts";
import { readManifest, type OwnedResources } from "../../src/contracts/owned.ts";
import { contractRevision } from "../../src/contracts/revision.ts";
import { isAlive } from "../../src/runtime/proc.ts";
import { request } from "../../src/transport/unix.ts";
import { ulid } from "../../src/util/ulid.ts";
import { PROTO } from "../../src/version.ts";

const NEW_VERSION = "9.9.10";
let buildDir: string;
let bin: string;

beforeAll(() => {
  buildDir = mkdtempSync(join(tmpdir(), "fw-autobin-"));
  bin = join(buildDir, "flowryn");
  const built = Bun.spawnSync([join(REPO_ROOT, "scripts/build.sh"), bin], { cwd: REPO_ROOT, env: { ...process.env, BUN_TMPDIR: process.env.BUN_TMPDIR ?? process.env.TMPDIR } });
  if (built.exitCode !== 0) throw new Error(`build failed: ${built.stdout.toString()}${built.stderr.toString()}`);
}, 120_000);

afterAll(() => rmSync(buildDir, { recursive: true, force: true }));

const envs: FleetEnv[] = [];
afterEach(async () => {
  for (const env of envs.splice(0)) await env.cleanup();
});

async function fleet(mode: "strict" | "relaxed", contractsAt?: number, options: { extraConfig?: string; stepWaitMs?: number } = {}): Promise<FleetEnv> {
  const env = await makeFleetEnv({
    contractsAt,
    extraConfig: `[policy]\nmode = "${mode}"${options.extraConfig ? `\n${options.extraConfig}` : ""}`,
    daemonProgram: [bin, "daemon", "run"],
    // Each contract step's wait, capped: the fakes answer in seconds, so a broken step fails fast.
    daemonEnv: { FLOWRYN_CONTRACT_MAX_WAIT_MS: String(options.stepWaitMs ?? 15_000) },
    harnessScripts: { claude: `${import.meta.dir}/../helpers/fake-contract-claude.ts`, pi: `${import.meta.dir}/../helpers/fake-contract-pi.ts` },
  });
  envs.push(env);
  return env;
}

function query<T>(env: FleetEnv, sql: string, ...params: string[]): T[] {
  const db = env.h.db();
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

const versions = (env: FleetEnv) => query<{ version: string }>(env, "SELECT version FROM harness_contracts WHERE harness = 'claude' ORDER BY version").map((r) => r.version);
const items = (env: FleetEnv, kind: string) => query<{ state: string; line: string; class: string }>(env, "SELECT state, line, class FROM items WHERE kind = ?1", kind);
const events = (env: FleetEnv, kind: string) => query<{ payload: string }>(env, "SELECT payload FROM events WHERE kind = ?1 ORDER BY seq", kind).map((r) => JSON.parse(r.payload) as Record<string, unknown>);

/** A dispatch on Claude: the gate reads the installed version; strict refuses an untested one, relaxed queues it on the automatic check. */
async function dispatchClaude(env: FleetEnv): Promise<{ code: number; error: { code?: string }; data: Record<string, unknown> }> {
  const result = await env.json(["dispatch", "web", "--kind", "scout", "--harness", "claude", "--body-file", "-"], { stdin: "look around" });
  return { code: result.code, error: (result.reply.error ?? {}) as { code?: string }, data: (result.reply.data ?? {}) as Record<string, unknown> };
}

interface RunView {
  id: string;
  harness_version: string;
  pending_launch: string | null;
  launched_at: number | null;
}
const runOf = (env: FleetEnv, id: string) => query<RunView>(env, "SELECT id, harness_version, pending_launch, launched_at FROM runs WHERE id = ?1", id)[0]!;
const seqOf = (env: FleetEnv, kind: string, where = "1=1") => query<{ seq: number }>(env, `SELECT seq FROM events WHERE kind = ?1 AND ${where} ORDER BY seq`, kind).map((r) => r.seq);

/** A relaxed dispatch on an untested version: accepted, waiting on the automatic check, never launched yet. */
async function dispatchWaiting(env: FleetEnv, version: string): Promise<string> {
  const reply = await dispatchClaude(env);
  expect(reply.code).toBe(0);
  expect(reply.data).toMatchObject({ state: "waiting", waits: `waits on the automatic contract check for claude ${version}; starts by itself once it passes` });
  const run = String(reply.data.run);
  expect(runOf(env, run)).toMatchObject({ pending_launch: "fresh", launched_at: null });
  return run;
}

/** A worker up in its pane with a stored session. */
const live = (r: { liveness: string; agent_session: string | null; pane_id: string | null }) => r.liveness !== "starting" && r.liveness !== "dead" && r.agent_session !== null && r.pane_id !== null;

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

  for (const [signal, releasedBy] of [
    ["SIGKILL", "daemon"],
    ["SIGTERM", "runner"],
  ] as const) {
    test(
      `assumption: a check stopped mid-suite by ${signal} leaves nothing: the ${releasedBy} releases exactly what the manifest names; the failure and the cleanup are recorded apart`,
      async () => {
        // The version poll trips the gate, so no dispatch's worker shares the fake Herdr with the check.
        const env = await fleet("relaxed", undefined, { extraConfig: "[contracts]\nversion_poll_ms = 10000" });
        // A workspace that is not the contract run's: it must stay.
        const unrelated = env.herdr.addPaneWithStatus(env.repo, "working");
        setHarnessVersion(env.h, "claude", NEW_VERSION);

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
        // The cut-off check is a first failure: not final (its retry runs on a later pass).
        expect(events(env, "contract.auto_failed")[0]).toEqual(expect.objectContaining({ harness: "claude", version: NEW_VERSION, try: 1, final: false }));
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

  test(
    "strict: the same bump only opens the P1; nothing runs",
    async () => {
      const env = await fleet("strict");
      setHarnessVersion(env.h, "claude", NEW_VERSION);
      expect(await dispatchClaude(env)).toMatchObject({ error: { code: "contract_unverified" } });
      // Two of the checker's 5 s passes.
      await Bun.sleep(11_000);
      expect(items(env, "harness_unverified")).toEqual([expect.objectContaining({ state: "open", line: expect.stringContaining(`claude ${NEW_VERSION} has no passing contract run`) })]);
      expect(events(env, "contract.auto_started")).toEqual([]);
      expect(versions(env)).toEqual([FAKE_VERSION]);
    },
    60_000,
  );
});
