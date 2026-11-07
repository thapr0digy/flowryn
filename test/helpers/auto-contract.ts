/**
 * Shared by the automatic contract check's end-to-end files (auto-contract-*.test.ts, spec 3, phase 2):
 * a compiled daemon (only a compiled build may vouch for a version) in a fleet whose fake
 * Herdr starts the instruction-following contract fakes (test/helpers/fake-contract-claude.ts,
 * as in contracts-offline.test.ts). Each file builds its own binary in its beforeAll, so the
 * files run in parallel without sharing a build directory.
 */
import { afterAll, afterEach, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFleetEnv, type FleetEnv } from "./fleet-env.ts";
import { REPO_ROOT } from "./harness.ts";

export const NEW_VERSION = "9.9.10";

/** Build the daemon once for the file and clean up every fleet after each test; returns the fleet maker. */
export function autoContractSuite(): (mode: "strict" | "relaxed", contractsAt?: number) => Promise<FleetEnv> {
  let buildDir = "";
  let bin = "";
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
  return async (mode, contractsAt) => {
    const env = await makeFleetEnv({
      contractsAt,
      extraConfig: `[policy]\nmode = "${mode}"`,
      daemonProgram: [bin, "daemon", "run"],
      // Each contract step's wait, capped: the fakes answer in seconds, so a broken step fails fast.
      // The checker's pass every 500 ms, not 5 s: a test that proves nothing runs waits two passes.
      daemonEnv: { FLOWRYN_CONTRACT_MAX_WAIT_MS: "15000", FLOWRYN_CONTRACT_POLL_MS: String(AUTO_TEST_POLL_MS) },
      harnessScripts: { claude: `${import.meta.dir}/fake-contract-claude.ts`, pi: `${import.meta.dir}/fake-contract-pi.ts` },
    });
    envs.push(env);
    return env;
  };
}

/** The checker's pass in these tests (FLOWRYN_CONTRACT_POLL_MS). */
export const AUTO_TEST_POLL_MS = 500;

export function query<T>(env: FleetEnv, sql: string, ...params: string[]): T[] {
  const db = env.h.db();
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

export const versions = (env: FleetEnv) => query<{ version: string }>(env, "SELECT version FROM harness_contracts WHERE harness = 'claude' ORDER BY version").map((r) => r.version);
export const items = (env: FleetEnv, kind: string) => query<{ state: string; line: string; class: string }>(env, "SELECT state, line, class FROM items WHERE kind = ?1", kind);
export const events = (env: FleetEnv, kind: string) => query<{ payload: string }>(env, "SELECT payload FROM events WHERE kind = ?1 ORDER BY seq", kind).map((r) => JSON.parse(r.payload) as Record<string, unknown>);

/** A dispatch on Claude: the gate reads the installed version, and refuses an untested one. */
export async function dispatchClaude(env: FleetEnv): Promise<{ code: number; error: { code?: string } }> {
  const result = await env.json(["dispatch", "web", "--kind", "scout", "--harness", "claude", "--body-file", "-"], { stdin: "look around" });
  return { code: result.code, error: (result.reply.error ?? {}) as { code?: string } };
}
