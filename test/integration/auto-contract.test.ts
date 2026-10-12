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
import { contractRevision, LEGACY_REVISION } from "../../src/contracts/revision.ts";
import { isAlive } from "../../src/runtime/proc.ts";

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

async function fleet(mode: "strict" | "relaxed", contractsAt?: number): Promise<FleetEnv> {
  const env = await makeFleetEnv({
    contractsAt,
    extraConfig: `[policy]\nmode = "${mode}"`,
    daemonProgram: [bin, "daemon", "run"],
    // Each contract step's wait, capped: the fakes answer in seconds, so a broken step fails fast.
    daemonEnv: { FLOWRYN_CONTRACT_MAX_WAIT_MS: "15000" },
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

/** A dispatch on Claude: the gate reads the installed version, and refuses an untested one. */
async function dispatchClaude(env: FleetEnv): Promise<{ code: number; error: { code?: string } }> {
  const result = await env.json(["dispatch", "web", "--kind", "scout", "--harness", "claude", "--body-file", "-"], { stdin: "look around" });
  return { code: result.code, error: (result.reply.error ?? {}) as { code?: string } };
}

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
    "relaxed: a pass from before revisions (as migration 20 leaves it) is re-run by the daemon and recorded at this build's revision, with its context, and no P1",
    async () => {
      const env = await fleet("relaxed", LEGACY_REVISION);
      const revision = contractRevision("claude");
      const refused = await env.json(["dispatch", "web", "--kind", "scout", "--harness", "claude", "--body-file", "-"], { stdin: "look around" });
      expect(refused.reply.error).toMatchObject({ code: "contract_unverified", message: `claude ${FAKE_VERSION} passed only at contract revision 0 (before revisions), not revision ${revision}` });
      const revisions = () => query<{ revision: number }>(env, "SELECT revision FROM harness_contracts WHERE harness = 'claude' AND version = ?1 ORDER BY revision", FAKE_VERSION).map((r) => r.revision);
      try {
        await waitUntil(() => revisions().includes(revision), 120_000, `the daemon to record claude ${FAKE_VERSION} at revision ${revision}`);
      } catch (error) {
        throw new Error(`${(error as Error).message}; events: ${JSON.stringify(events(env, "contract.auto_failed"))}`, { cause: error });
      }
      expect(revisions()).toEqual([LEGACY_REVISION, revision]);
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
