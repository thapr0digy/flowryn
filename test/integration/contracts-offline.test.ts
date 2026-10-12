/**
 * The harness contract suite, offline, on every PR: `flowryn doctor
 * --contracts` runs the real steps (src/contracts/suite.ts) through the real
 * runner and its scratch daemon (src/contracts/runner.ts), in the fake Herdr,
 * against fakes that follow the suite's instructions by rule
 * (test/helpers/fake-contract-claude.ts runs the real per-run Claude hooks;
 * test/helpers/fake-contract-pi.ts hosts the real Pi worker extension and
 * plays the scripted provider's FLOWRYN-SCRIPT). No model, no network, no
 * terminal of yours: a change to the worker path that breaks a step (as the
 * turn-end guard in #32 broke "idle") fails here, naming the step. The
 * passing version is recorded in the test home's database only. Each run's
 * TMPDIR is a directory of this test's own, so the scratch home it must leave
 * nothing of is its own: a `doctor --contracts` elsewhere on the machine (another
 * worker's suite, the leader's merge check) makes its fwc-* homes in the shared
 * tmpdir and cannot fail this check.
 *
 * The Pi gate runs the scripted model whatever `[workers.pi]` says (the test
 * home sets openrouter/free, as the user's did): the fake Pi plays the script
 * only when launched that way (docs/notes/2026-10-11-make-the-pi-rv.md).
 * `--model` on Pi adds an informational real-model pass; the fake then plays a
 * model that ignores steers, so that pass stops at its first steer with the
 * named cause, as a warning that leaves doctor's exit code and the record alone.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contractSteps } from "../../src/contracts/suite.ts";
import type { HarnessId } from "../../src/harness/types.ts";
import { FAKE_VERSION, makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { REPO_ROOT } from "../helpers/harness.ts";
import { Pty } from "../helpers/pty.ts";

/** Each step's wait, capped: the fakes answer in seconds, so a broken step fails fast. */
const MAX_WAIT_MS = 15_000;

let fleet: FleetEnv;
/** The doctor's TMPDIR: the runner makes its scratch home here and nowhere else. */
let scratchRoot: string;
/** The test home's own Pi agent dir, as `[workers.pi] agent_dir`: only ever read. */
let piAgent: string;
beforeAll(async () => {
  scratchRoot = mkdtempSync(join(tmpdir(), "fwt-"));
  piAgent = join(scratchRoot, "pi-agent-own");
  mkdirSync(piAgent, { recursive: true });
  writeFileSync(join(piAgent, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "test-only" } }));
  fleet = await makeFleetEnv({
    contracts: false,
    extraConfig: ["[workers.pi]", 'model = "openrouter/free"', `agent_dir = ${JSON.stringify(piAgent)}`].join("\n"),
    harnessScripts: { claude: `${import.meta.dir}/../helpers/fake-contract-claude.ts`, pi: `${import.meta.dir}/../helpers/fake-contract-pi.ts` },
  });
  // claude-in-chrome on, as on this Mac: the toolkit step must then see it hidden, not skip the check.
  writeFileSync(join(fleet.claudeStore, ".claude.json"), JSON.stringify({ claudeInChromeDefaultEnabled: true }));
});
afterAll(async () => {
  await fleet.cleanup();
  if (process.env.FLOWRYN_TEST_KEEP !== "1") rmSync(scratchRoot, { recursive: true, force: true });
});

interface Check {
  check: string;
  status: string;
  detail: string;
}

/**
 * Run the suite for one harness as you would, in the test home, in a terminal:
 * doctor is human only, and recording the passing version needs your own one.
 */
async function doctorContracts(harness: HarnessId, extra: string[] = []): Promise<{ code: number; checks: Check[]; screen: string }> {
  const keep = process.env.FLOWRYN_TEST_KEEP === "1" ? ["--keep"] : [];
  const argv = ["bun", join(REPO_ROOT, "src/main.ts"), "doctor", "--contracts", "--harness", harness, "--herdr-socket", fleet.herdr.socket, ...extra, ...keep, "--json"];
  const pty = Pty.spawn(argv, { ...fleet.h.env, TMPDIR: scratchRoot, FLOWRYN_CONTRACT_MAX_WAIT_MS: String(MAX_WAIT_MS) }, REPO_ROOT);
  try {
    const [line] = await pty.waitFor(/^\{"ok".*\}\s*$/m, 80_000);
    const code = await pty.exited;
    return { code, checks: (JSON.parse(line) as { data: { checks: Check[] } }).data.checks, screen: pty.text() };
  } finally {
    pty.kill();
  }
}

function recorded(harness: HarnessId): { version: string; report_path: string | null }[] {
  const db = fleet.h.db();
  try {
    return db.query("SELECT version, report_path FROM harness_contracts WHERE harness = ?1").all(harness) as { version: string; report_path: string | null }[];
  } finally {
    db.close();
  }
}

/** Scratch homes this test's runs made and did not remove. */
function scratchHomes(): string[] {
  return readdirSync(scratchRoot).filter((name) => name.startsWith("fwc-"));
}

describe("the harness contract suite against fakes", () => {
  for (const [harness, extra] of [
    ["claude", []],
    ["pi", []],
  ] as [HarnessId, string[]][]) {
    test(`${harness}: every step passes and the version is recorded`, async () => {
      const before = new Set(scratchHomes());
      const { code, checks, screen } = await doctorContracts(harness, extra);
      const steps = checks.filter((c) => c.check.startsWith(`contract ${harness} `));
      const failed = checks.filter((c) => c.status !== "ok");
      expect(failed, `failed checks:\n${JSON.stringify(failed, null, 2)}\n${screen}`).toEqual([]);
      expect(steps.map((c) => c.check)).toEqual(contractSteps(harness).map((s) => `contract ${harness} ${s.name}`));
      expect(checks.at(-1)).toMatchObject({ check: `contract ${harness}`, status: "ok" });
      expect(code).toBe(0);
      expect(recorded(harness).map((r) => r.version)).toEqual([FAKE_VERSION]);
      expect(fleet.herdr.livePanes()).toEqual([]);
      if (process.env.FLOWRYN_TEST_KEEP !== "1") expect(scratchHomes().filter((name) => !before.has(name))).toEqual([]);
    }, 90_000);
  }

  test("pi: --model adds an informational real-model pass that names the ignored steer and gates nothing", async () => {
    const before = new Set(scratchHomes());
    const auth = readFileSync(join(piAgent, "auth.json"), "utf8");
    const model = "openrouter/test-model:free";
    const { code, checks, screen } = await doctorContracts("pi", ["--model", model]);
    const gate = checks.filter((c) => (c.check === "contract pi" || c.check.startsWith("contract pi ")) && !c.check.startsWith("contract pi model "));
    expect(gate.filter((c) => c.status !== "ok"), screen).toEqual([]);
    expect(gate.at(-1)).toMatchObject({ check: "contract pi", status: "ok" });
    const real = checks.filter((c) => c.check.startsWith(`contract pi model ${model}`));
    const stopped = real.find((c) => c.status === "warn");
    expect(stopped, screen).toMatchObject({ check: `contract pi model ${model} deliver while busy` });
    expect(stopped!.detail).toMatch(/^m1 seen \+[\d.]+m?s, turn ended without ack \(model ignored the steer\); m1 carried \+/);
    expect(real.at(-1)).toMatchObject({ check: `contract pi model ${model}`, status: "info" });
    expect(real.at(-1)!.detail).toStartWith("informational, not gating: stopped at deliver while busy");
    expect(checks.some((c) => c.status === "fail")).toBe(false);
    expect(code).toBe(0);
    expect(recorded("pi").map((r) => r.version)).toEqual([FAKE_VERSION]);
    expect(readFileSync(join(piAgent, "auth.json"), "utf8")).toBe(auth);
    expect(readdirSync(piAgent)).toEqual(["auth.json"]);
    expect(fleet.herdr.livePanes()).toEqual([]);
    if (process.env.FLOWRYN_TEST_KEEP !== "1") expect(scratchHomes().filter((name) => !before.has(name))).toEqual([]);
  }, 150_000);
});
