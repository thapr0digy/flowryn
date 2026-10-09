import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonInfo } from "../../src/api/verbs.ts";
import { composeBriefing } from "../../src/attention/briefing.ts";
import { parseConfig, type FlowrynConfig } from "../../src/config/config.ts";
import { AutoContractChecker, autoFailureLine, parseHandoff, type AutoJob, type AutoOutcome, type AutoProcess } from "../../src/contracts/auto.ts";
import { dataDirReport } from "../../src/contracts/report.ts";
import { restartGuards } from "../../src/daemon/restart.ts";
import { getMeta, migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import type { HarnessId } from "../../src/harness/types.ts";
import { autoAttempt, gateHarness, harnessRefusal, unverifiedVersion, type HarnessCheck } from "../../src/lifecycle/harness-gate.ts";
import { noteUsageLimit } from "../../src/sched/usage.ts";

/**
 * The daemon's automatic contract check (src/contracts/auto.ts), against a
 * fake runner that writes the report a `doctor --contracts --for-daemon` run
 * would. The real child, the fake Herdr and the contract fakes run in
 * test/integration/auto-contract.test.ts.
 */

const BUILD = "ab12cd34ef56";
let dir: string;
let db: Db;
let config: FlowrynConfig;
let build: string | null;
let versions: Record<HarnessId, string>;
let busy: boolean;
let herdr: string | null;
let passes: number;
let jobs: AutoJob[];
let script: (job: AutoJob) => { passed?: boolean; build?: string | null; mode?: "record" | "verify-only"; report?: boolean; hold?: boolean };
let held: { resolve: () => void; terminated: boolean }[];

function useConfig(mode: "strict" | "relaxed"): void {
  config = parseConfig(`data_dir = ${JSON.stringify(join(dir, "data"))}\n[tools]\nclaude = "/x/claude"\npi = "/x/pi"\n[policy]\nmode = "${mode}"\n`, dir);
}

function info(): DaemonInfo {
  return { pid: 1, version: "t", proto: 1, instance: "i", startedAt: 0, execPath: "/x/flowryn", build, socket: "/s", stateDir: dir };
}

/** The pinned copy of the running build, as the daemon writes it at startup (src/daemon/caller-binary.ts). */
function pin(id: string): void {
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", `flowryn-${id}`), "#!/bin/sh\n");
}

/** A fake run: writes the report the child would (or none), and prints its handoff. */
function fakeRun(job: AutoJob): AutoProcess {
  jobs.push(job);
  const plan = script(job);
  const report =
    plan.report === false
      ? null
      : dataDirReport(config, { harness: job.harness, version: versions[job.harness], passed: plan.passed ?? true, steps: [], scratch: "/tmp/x" }, { mode: plan.mode ?? "record", build: plan.build === undefined ? BUILD : plan.build, by: "daemon" });
  const outcome: AutoOutcome = {
    exitCode: plan.passed === false ? 1 : 0,
    stdout: JSON.stringify({ ok: true, data: { checks: [], summary: "", report: report ?? "-", version: versions[job.harness] } }) + "\n",
    timedOut: false,
  };
  if (!plan.hold) return { done: Promise.resolve(outcome), terminate: () => {}, kill: () => {} };
  const latch = { resolve: () => {}, terminated: false };
  const done = new Promise<AutoOutcome>((resolve) => {
    latch.resolve = () => resolve(outcome);
  });
  held.push(latch);
  return {
    done,
    terminate: () => {
      latch.terminated = true;
      latch.resolve();
    },
    kill: () => latch.resolve(),
  };
}

function checker(): AutoContractChecker {
  return new AutoContractChecker({
    db,
    config: () => config,
    env: { FLOWRYN_TOKEN: "leader-token", PATH: "/bin" },
    now: Date.now,
    log: () => {},
    info,
    harnessVersion: async (harness) => versions[harness],
    restartBusy: () => busy,
    herdrDown: () => herdr,
    afterPass: () => {
      passes++;
    },
    run: fakeRun,
  });
}

/** What a dispatch does: the gate, against the installed version. */
function gate(harness: HarnessId): Promise<HarnessCheck> {
  return gateHarness(db, config, harness, async (h) => versions[h], "cli", "dispatch", Date.now);
}

function items(kind: string): { line: string; state: string; class: string }[] {
  return db.query("SELECT line, state, class FROM items WHERE kind = ?1 ORDER BY opened_at, id").all(kind) as { line: string; state: string; class: string }[];
}

function recorded(): { harness: string; version: string }[] {
  return db.query("SELECT harness, version FROM harness_contracts ORDER BY harness").all() as { harness: string; version: string }[];
}

function events(kind: string): Record<string, unknown>[] {
  return (db.query("SELECT payload FROM events WHERE kind = ?1 ORDER BY seq").all(kind) as { payload: string }[]).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
}

function briefing(): string {
  return composeBriefing(db, { now: Date.now(), ageMs: 0, markMorning: false, session: null, morningHour: 25 }).text;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-auto-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  useConfig("relaxed");
  build = BUILD;
  pin(BUILD);
  versions = { claude: "2.1.300", pi: "0.90.0" };
  busy = false;
  herdr = null;
  passes = 0;
  jobs = [];
  held = [];
  script = () => ({});
});

afterEach(() => {
  for (const h of held) h.resolve();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("relaxed: the daemon runs the recording check itself", () => {
  test("a new version is flagged without a P1, checked from the pinned build, and recorded by the daemon", async () => {
    const auto = checker();
    auto.init();
    expect(getMeta(db, "contract_auto_build")).toBe(BUILD);
    const check = await gate("claude");
    expect(check).toMatchObject({ state: "unverified", version: "2.1.300" });
    expect(items("harness_unverified")).toEqual([]);
    expect(events("harness.unverified")).toEqual([expect.objectContaining({ harness: "claude", version: "2.1.300", auto: true })]);

    await auto.tick();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ harness: "claude", version: "2.1.300", binary: join(dir, "bin", `flowryn-${BUILD}`) });
    // The child answers as your own shell would: no agent identity reaches it.
    expect(jobs[0]!.env.FLOWRYN_TOKEN).toBeUndefined();
    expect(jobs[0]!.logPath).toStartWith(join(dir, "data", "contracts", "auto-claude-2.1.300-"));
    expect(recorded()).toEqual([{ harness: "claude", version: "2.1.300" }]);
    expect(events("contract.passed")).toEqual([expect.objectContaining({ harness: "claude", version: "2.1.300", by: "daemon", build: BUILD })]);
    const [item] = items("contract_recorded");
    expect(item).toMatchObject({ class: "info", state: "open" });
    expect(item!.line).toStartWith(`claude 2.1.300 passed, recorded automatically (build ${BUILD}); report ${join(dir, "data", "contracts", "claude-2.1.300-")}`);
    expect(items("harness_unverified")).toEqual([]);
    expect(autoAttempt(db, "claude")).toMatchObject({ version: "2.1.300", state: "passed", build: BUILD });
    expect(unverifiedVersion(db, "claude")).toBeNull();
    expect(passes).toBe(1);
    expect(briefing()).toMatch(new RegExp(`Contract \\d\\d:\\d\\d: claude 2\\.1\\.300 passed, recorded automatically \\(build ${BUILD}\\)\\.`));
    expect(await gate("claude")).toMatchObject({ state: "verified" });
  });

  test("once per version: a failure opens one P1 naming the report and is not retried; a newer version runs again", async () => {
    const auto = checker();
    auto.init();
    script = () => ({ passed: false });
    await gate("claude");
    await auto.tick();
    const open = items("harness_unverified");
    expect(open).toHaveLength(1);
    expect(open[0]!.line).toStartWith(`claude 2.1.300 failed its automatic contract check: ${join(dir, "data", "contracts", "claude-2.1.300-")}`);
    expect(recorded()).toEqual([]);
    expect(events("contract.auto_failed")).toEqual([expect.objectContaining({ harness: "claude", version: "2.1.300", build: BUILD, detail: "the report is not a passing run" })]);

    await gate("claude");
    await auto.tick();
    await auto.tick();
    expect(jobs).toHaveLength(1);
    expect(items("harness_unverified")).toHaveLength(1);

    versions.claude = "2.1.301";
    script = () => ({});
    await gate("claude");
    await auto.tick();
    expect(jobs.map((j) => j.version)).toEqual(["2.1.300", "2.1.301"]);
    expect(recorded()).toEqual([{ harness: "claude", version: "2.1.301" }]);
    // The superseded version's P1 closed with it.
    expect(items("harness_unverified").filter((i) => i.state === "open")).toEqual([]);
  });

  test("a run that wrote no report fails, naming its log", async () => {
    const auto = checker();
    auto.init();
    script = () => ({ passed: false, report: false });
    await gate("pi");
    await auto.tick();
    const [p1] = items("harness_unverified");
    expect(p1!.line).toStartWith(`pi 0.90.0 failed its automatic contract check: ${join(dir, "data", "contracts", "auto-pi-0.90.0-")}`);
    expect(events("contract.auto_failed")[0]).toMatchObject({ detail: "it wrote no report (exit 1)", report: null });
  });

  test("a report from another build, or a verify-only one, is not recorded", async () => {
    const auto = checker();
    auto.init();
    script = () => ({ build: "0f0f0f0f0f0f" });
    await gate("claude");
    await auto.tick();
    expect(recorded()).toEqual([]);
    expect(items("harness_unverified")).toHaveLength(1);
    expect(events("contract.auto_failed")[0]).toMatchObject({ detail: "the report was written by build 0f0f0f0f0f0f" });

    script = () => ({ mode: "verify-only" });
    await gate("pi");
    await auto.tick();
    expect(recorded()).toEqual([]);
    expect(events("contract.auto_failed")[1]).toMatchObject({ detail: "the report is a verify-only run, not a recording one" });
  });

  test("one check at a time, listed as a restart guard while it runs; the dispatch refusal says it is running", async () => {
    const auto = checker();
    auto.init();
    script = () => ({ hold: true });
    await gate("claude");
    await gate("pi");
    const first = auto.tick();
    await Bun.sleep(20);
    expect(jobs.map((j) => j.harness)).toEqual(["claude"]);
    await auto.tick();
    expect(jobs).toHaveLength(1);
    const guards = restartGuards(db, { mergesInFlight: [], cleanups: [], launching: [], approvalTasks: [], contractChecks: auto.running() }, Date.now());
    expect(guards).toEqual([expect.objectContaining({ kind: "contract_check", detail: expect.stringContaining("automatic contract check claude 2.1.300 running for") })]);
    expect(briefing()).toMatch(/Contract check running: claude 2\.1\.300 since \d\d:\d\d \(automatic\)\./);
    const refusal = harnessRefusal({ harness: "claude", state: "unverified", version: "2.1.300" }, db);
    expect(refusal.code).toBe("contract_unverified");
    expect(refusal.help).toContain("an automatic contract check is running");

    held[0]!.resolve();
    await first;
    expect(auto.running()).toEqual([]);
    const second = auto.tick();
    await Bun.sleep(20);
    expect(jobs.map((j) => j.harness)).toEqual(["claude", "pi"]);
    held[1]!.resolve();
    await second;
    expect(recorded()).toEqual([
      { harness: "claude", version: "2.1.300" },
      { harness: "pi", version: "0.90.0" },
    ]);
  });

  test("waits, without a P1, while a restart is pending, Herdr is down or Claude is usage-paused", async () => {
    const auto = checker();
    auto.init();
    await gate("claude");
    busy = true;
    await auto.tick();
    expect(jobs).toEqual([]);
    expect(autoAttempt(db, "claude")).toMatchObject({ state: "waiting", wait: "a daemon restart" });
    expect(briefing()).toContain("Contract check queued: claude 2.1.300, waiting for a daemon restart (automatic).");
    expect(harnessRefusal({ harness: "claude", state: "unverified", version: "2.1.300" }, db).help).toContain("queued (a daemon restart)");
    await auto.tick();
    expect(events("contract.auto_waiting")).toHaveLength(1);

    busy = false;
    herdr = "connect ENOENT";
    await auto.tick();
    expect(autoAttempt(db, "claude")).toMatchObject({ state: "waiting", wait: "Herdr (connect ENOENT)" });

    herdr = null;
    tx(db, () => noteUsageLimit(db, "r1", "rate_limit", Date.now(), { usage_backoff_ms: 3_600_000, usage_backoff_max_ms: 7_200_000 }));
    await auto.tick();
    expect(autoAttempt(db, "claude")).toMatchObject({ state: "waiting", wait: "the Claude usage pause" });
    expect(jobs).toEqual([]);
    expect(items("harness_unverified")).toEqual([]);

    // Pi does not wait on Claude's usage.
    await gate("pi");
    await auto.tick();
    expect(jobs.map((j) => j.harness)).toEqual(["pi"]);
  });

  test("a check a stopping daemon cut off runs again at the next start", async () => {
    const auto = checker();
    auto.init();
    script = () => ({ hold: true });
    await gate("claude");
    const running = auto.tick();
    await Bun.sleep(20);
    await auto.stop();
    await running;
    expect(held[0]!.terminated).toBe(true);
    expect(autoAttempt(db, "claude")).toMatchObject({ state: "running" });
    expect(recorded()).toEqual([]);
    expect(items("harness_unverified")).toEqual([]);

    script = () => ({});
    const next = checker();
    next.init();
    expect(autoAttempt(db, "claude")).toMatchObject({ state: "waiting" });
    expect(events("contract.auto_interrupted")).toHaveLength(1);
    await next.tick();
    expect(recorded()).toEqual([{ harness: "claude", version: "2.1.300" }]);
  });

  test("a harness updated again since it was flagged: the installed version is the one checked", async () => {
    const auto = checker();
    auto.init();
    await gate("claude");
    versions.claude = "2.1.302";
    await auto.tick();
    expect(jobs.map((j) => j.version)).toEqual(["2.1.302"]);
    expect(recorded()).toEqual([{ harness: "claude", version: "2.1.302" }]);
  });
});

describe("strict, and daemons that cannot run the check", () => {
  test("strict: the gate opens the P1 and nothing runs", async () => {
    useConfig("strict");
    const auto = checker();
    auto.init();
    await gate("claude");
    await auto.tick();
    expect(jobs).toEqual([]);
    expect(items("harness_unverified")).toEqual([expect.objectContaining({ state: "open", line: expect.stringContaining("claude 2.1.300 has no passing contract run") })]);
    expect(harnessRefusal({ harness: "claude", state: "unverified", version: "2.1.300" }, db).help).toBe("run the contract suite: flowryn doctor --contracts --harness claude");
  });

  test("a development daemon (no build) opens the P1 as strict does", async () => {
    build = null;
    const auto = checker();
    auto.init();
    expect(getMeta(db, "contract_auto_build")).toBeFalsy();
    await gate("claude");
    expect(items("harness_unverified")).toHaveLength(1);
    await auto.tick();
    expect(jobs).toEqual([]);
    expect(items("harness_unverified")).toHaveLength(1);
  });

  test("assumption: the pinned copy of the build exists; without it, no check runs and the P1 opens", async () => {
    const auto = checker();
    auto.init();
    await gate("claude");
    rmSync(join(dir, "bin"), { recursive: true, force: true });
    expect(auto.pinnedBinary()).toBeNull();
    await auto.tick();
    expect(jobs).toEqual([]);
    expect(items("harness_unverified")).toEqual([expect.objectContaining({ line: expect.stringContaining("has no passing contract run") })]);
  });

  test("a reload to relaxed runs the check for the version strict flagged; its pass settles the P1", async () => {
    useConfig("strict");
    const auto = checker();
    auto.init();
    await gate("claude");
    expect(items("harness_unverified")).toHaveLength(1);
    useConfig("relaxed");
    await auto.tick();
    expect(recorded()).toEqual([{ harness: "claude", version: "2.1.300" }]);
    expect(items("harness_unverified")).toEqual([expect.objectContaining({ state: "resolved" })]);
  });

  test("a reload to strict while a check waits opens the P1 once", async () => {
    const auto = checker();
    auto.init();
    busy = true;
    await gate("claude");
    await auto.tick();
    expect(items("harness_unverified")).toEqual([]);
    useConfig("strict");
    await auto.tick();
    await auto.tick();
    expect(items("harness_unverified")).toHaveLength(1);
    expect(jobs).toEqual([]);
  });

  test("a pass that ends after a reload to strict is not recorded; the P1 says why", async () => {
    const auto = checker();
    auto.init();
    script = () => ({ hold: true });
    await gate("claude");
    const running = auto.tick();
    await Bun.sleep(20);
    useConfig("strict");
    held[0]!.resolve();
    await running;
    expect(recorded()).toEqual([]);
    expect(items("harness_unverified")).toHaveLength(1);
    expect(events("contract.auto_failed")[0]).toMatchObject({ detail: "[policy] mode is strict now, so the daemon did not record its pass" });
  });
});

describe("the failure line", () => {
  test("fits the 200-character item line whole, for a report under a real home", () => {
    const line = autoFailureLine("claude", "2.1.300", "/Users/somebody/.flowryn/data/contracts/claude-2.1.300-2026-10-09T00-55-08-590Z.json", "/Users/somebody");
    expect(line).toBe("claude 2.1.300 failed its automatic contract check: ~/.flowryn/data/contracts/claude-2.1.300-2026-10-09T00-55-08-590Z.json; rerun: flowryn doctor --contracts --harness claude");
    expect(line.length).toBeLessThanOrEqual(200);
    expect(autoFailureLine("pi", "0.90.0", "/opt/data/contracts/r.json", "/Users/somebody")).toContain(": /opt/data/contracts/r.json;");
  });
});

describe("the --for-daemon handoff", () => {
  test("reads the report and version from the doctor reply, and the failing check's detail", () => {
    expect(parseHandoff('{"ok":true,"data":{"report":"/d/r.json","version":"1.2.3","checks":[]}}\n')).toEqual({ report: "/d/r.json", version: "1.2.3", detail: null });
    expect(parseHandoff('{"ok":true,"data":{"report":"-","version":"-","checks":[{"status":"fail","detail":"no Herdr session"}]}}')).toEqual({ report: null, version: null, detail: "no Herdr session" });
    expect(parseHandoff("not json")).toEqual({ report: null, version: null, detail: null });
  });
});
