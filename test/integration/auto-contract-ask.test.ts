/**
 * An ask on an untested Claude version, end to end on a compiled relaxed daemon
 * (docs/notes/2026-11-06-a-claude-pi-y5.md "Ask"): `dispatch --kind ask` is accepted
 * with a `waits` line, the ask stays queued with no print-mode call while the
 * automatic check runs, and it is answered only after the daemon records the pass.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askCallLog, makeFleetEnv, setHarnessVersion, type FleetEnv } from "../helpers/fleet-env.ts";
import { REPO_ROOT, waitUntil } from "../helpers/harness.ts";

const NEW_VERSION = "9.9.10";
let buildDir: string;
let bin: string;
const envs: FleetEnv[] = [];

beforeAll(() => {
  buildDir = mkdtempSync(join(tmpdir(), "fw-askbin-"));
  bin = join(buildDir, "flowryn");
  const built = Bun.spawnSync([join(REPO_ROOT, "scripts/build.sh"), bin], { cwd: REPO_ROOT, env: { ...process.env, BUN_TMPDIR: process.env.BUN_TMPDIR ?? process.env.TMPDIR } });
  if (built.exitCode !== 0) throw new Error(`build failed: ${built.stdout.toString()}${built.stderr.toString()}`);
}, 120_000);
afterAll(() => rmSync(buildDir, { recursive: true, force: true }));
afterEach(async () => {
  for (const env of envs.splice(0)) await env.cleanup();
});

function q<T>(env: FleetEnv, sql: string, ...params: string[]): T[] {
  const db = env.h.db();
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}
// Only this ask's calls: the contract suite's own "ask" step makes a print-mode call of its own.
const QUESTION = "What is this?\nASK: reply A scratch project.";
const callCount = (env: FleetEnv) =>
  existsSync(askCallLog(env.h.home))
    ? readFileSync(askCallLog(env.h.home), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { stdin: string }).filter((c) => c.stdin === QUESTION).length
    : 0;

test("relaxed: an ask on an untested Claude version waits on the automatic check, makes no call, and is answered after the pass", async () => {
  const env = await makeFleetEnv({
    extraConfig: `[policy]\nmode = "relaxed"`,
    daemonProgram: [bin, "daemon", "run"],
    daemonEnv: { FLOWRYN_CONTRACT_MAX_WAIT_MS: "15000" },
    harnessScripts: { claude: `${import.meta.dir}/../helpers/fake-contract-claude.ts`, pi: `${import.meta.dir}/../helpers/fake-contract-pi.ts` },
  });
  envs.push(env);
  setHarnessVersion(env.h, "claude", NEW_VERSION);
  const queued = await env.json(["dispatch", "web", "--kind", "ask", "--harness", "claude", "--body-file", "-"], { stdin: QUESTION });
  console.log("DISPATCH REPLY:", JSON.stringify(queued.reply));
  expect(queued.code).toBe(0);
  const data = queued.reply.data as { ask: string; waits?: string };
  expect(data.waits).toBe(`waits on the automatic contract check for claude ${NEW_VERSION}; starts by itself once it passes`);
  const id = String(data.ask);
  const state = () => q<{ state: string; answer: string | null }>(env, "SELECT state, answer FROM asks WHERE id = ?1", id)[0]!;
  const passed = () => q<{ version: string }>(env, "SELECT version FROM harness_contracts WHERE harness = 'claude' AND version = ?1", NEW_VERSION).length > 0;
  // Before the pass: never called, still queued (sampled through the check).
  const deadline = Date.now() + 150_000;
  while (!passed()) {
    if (Date.now() > deadline) throw new Error("the automatic check never recorded a pass");
    if (!passed()) {
      expect(state().state).toBe("queued");
      expect(callCount(env)).toBe(0);
    }
    await Bun.sleep(250);
  }
  console.log("PASS RECORDED; ask state at pass:", JSON.stringify(state()));
  await waitUntil(() => state().state === "answered", 60_000, "the ask to be answered after the pass");
  console.log("ASK AFTER PASS:", JSON.stringify(state()), "calls:", callCount(env));
  expect(state().answer).toBe("A scratch project.");
  expect(callCount(env)).toBe(1);
  expect(q<{ n: number }>(env, "SELECT count(*) AS n FROM items WHERE kind = 'harness_unverified' AND state = 'open'")[0]!.n).toBe(0);
}, 240_000);

test("relaxed: the daemon's version poll finds a Claude update with no dispatch and passes it automatically", async () => {
  const env = await makeFleetEnv({
    extraConfig: `[policy]\nmode = "relaxed"\n[contracts]\nversion_poll_ms = 10000`,
    daemonProgram: [bin, "daemon", "run"],
    daemonEnv: { FLOWRYN_CONTRACT_MAX_WAIT_MS: "15000" },
    harnessScripts: { claude: `${import.meta.dir}/../helpers/fake-contract-claude.ts`, pi: `${import.meta.dir}/../helpers/fake-contract-pi.ts` },
  });
  envs.push(env);
  setHarnessVersion(env.h, "claude", NEW_VERSION);
  await waitUntil(() => q(env, "SELECT 1 FROM harness_contracts WHERE harness = 'claude' AND version = ?1", NEW_VERSION).length > 0, 150_000, "the polled version to pass");
  const ev = q<{ kind: string; payload: string }>(env, "SELECT kind, payload FROM events WHERE kind IN ('harness.unverified','contract.auto_started','contract.passed') ORDER BY seq");
  console.log("EVENTS:", JSON.stringify(ev));
  expect(JSON.parse(ev.find((e) => e.kind === "harness.unverified")!.payload)).toMatchObject({ harness: "claude", version: NEW_VERSION, where: "poll" });
  expect(q(env, "SELECT 1 FROM runs").length).toBe(0);
  expect(q(env, "SELECT 1 FROM items WHERE kind = 'harness_unverified' AND state = 'open'").length).toBe(0);
}, 240_000);
