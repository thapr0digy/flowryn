import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonInfo } from "../../src/api/verbs.ts";
import { composeBriefing } from "../../src/attention/briefing.ts";
import { parseConfig, type FlowrynConfig } from "../../src/config/config.ts";
import { AUTO_STOP_GRACE_MS, AutoContractChecker, autoFailureLine, autoLeftoverLine, autoUnrecordedLine, parseHandoff, type AutoJob, type AutoOutcome, type AutoProcess } from "../../src/contracts/auto.ts";
import { writeManifest, type CleanupOutcome, type OwnedResources } from "../../src/contracts/owned.ts";
import { CONTRACT_CLEANUP_BUDGET_MS } from "../../src/contracts/runner.ts";
import { dataDirReport } from "../../src/contracts/report.ts";
import { BASELINE_REVISION, CONTRACT_REVISIONS, contractRevision, type RevisionMap } from "../../src/contracts/revision.ts";
import { recordPass } from "../../src/contracts/verbs.ts";
import { restartGuards } from "../../src/daemon/restart.ts";
import { getMeta, migrate, openDb, setMeta, tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { openItem, resolveItems } from "../../src/attention/items.ts";
import type { HarnessId } from "../../src/harness/types.ts";
import { autoAttempt, gateHarness, harnessRefusal, saveAutoAttempt, unverifiedVersion, type HarnessCheck } from "../../src/lifecycle/harness-gate.ts";
import { recordQuota } from "../../src/sched/quota.ts";
import { clearUsageLimit, noteUsageLimit } from "../../src/sched/usage.ts";

/**
 * The daemon's automatic contract check (src/contracts/auto.ts), against a
 * fake runner that writes the report a `doctor --contracts --for-daemon` run
 * would. The real child, the fake Herdr and the contract fakes run in
 * test/integration/auto-contract.test.ts.
 */

const BUILD = "ab12cd34ef56";
const CLAUDE_REVISION = contractRevision("claude");
const CONTEXT = { platform: "darwin-arm64 25.3.0", herdr: "0.7.5", launch_profile: "model=default effort=default permission_mode=auto pretrust=register" };
let dir: string;
let db: Db;
let config: FlowrynConfig;
let build: string | null;
let versions: Record<HarnessId, string>;
let busy: boolean;
let herdr: string | null;
let passes: number;
let jobs: AutoJob[];
let script: (job: AutoJob) => {
  passed?: boolean;
  build?: string | null;
  mode?: "record" | "verify-only";
  /** The contract revision the child's report says it proved (default: this build's). */
  revision?: number;
  report?: boolean;
  hold?: boolean;
  /** A held child that keeps running after SIGTERM (it ends only on SIGKILL). */
  ignoreTerm?: boolean;
  /** The ownership manifest the child leaves: none, one whose cleanup it recorded, or one it never finished. */
  manifest?: "none" | "clean" | "unfinished";
};
let held: { resolve: () => void; terminated: boolean }[];
/** The signals each fake child received, with when. */
let signals: { signal: "TERM" | "KILL"; at: number }[];
/** The manifests the checker asked to release, and what that release reports. */
let recovered: string[];
let recovery: CleanupOutcome;
let probe: Promise<void> | null;

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

function ownedBy(job: AutoJob, cleanup: CleanupOutcome | null): OwnedResources {
  return { runner: null, home: join(dir, "fwc-x"), herdr_socket: "/s", branch_prefix: "flowryn/contract-00000000-", project: null, daemon: null, workspaces: ["w7"], harnesses: [], cleanup };
}

/** A fake run: writes the report the child would (or none), and prints its handoff. */
function fakeRun(job: AutoJob): AutoProcess {
  jobs.push(job);
  const plan = script(job);
  if (plan.manifest === "clean") writeManifest(job.manifest, ownedBy(job, { ok: true, problems: [], by: "runner", at: Date.now() }));
  if (plan.manifest === "unfinished") writeManifest(job.manifest, ownedBy(job, null));
  const report =
    plan.report === false
      ? null
      : dataDirReport(
          config,
          {
            harness: job.harness,
            version: versions[job.harness],
            revision: plan.revision ?? contractRevision(job.harness),
            context: CONTEXT,
            passed: plan.passed ?? true,
            steps: [],
            scratch: "/tmp/x",
            cleanup: { ok: true, problems: [], by: "runner", at: 0 },
          },
          { mode: plan.mode ?? "record", build: plan.build === undefined ? BUILD : plan.build, by: "daemon" },
        );
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
      signals.push({ signal: "TERM", at: Date.now() });
      latch.terminated = true;
      if (!plan.ignoreTerm) latch.resolve();
    },
    kill: () => {
      signals.push({ signal: "KILL", at: Date.now() });
      latch.resolve();
    },
  };
}

function checker(options: { maxRunMs?: number; stopGraceMs?: number; daemonStopWaitMs?: number; onRecover?: (manifest: string) => void; revisions?: RevisionMap } = {}): AutoContractChecker {
  const { onRecover, ...timing } = options;
  return new AutoContractChecker({
    ...timing,
    recover: async (manifest) => {
      onRecover?.(manifest);
      recovered.push(manifest);
      return recovery;
    },
    db,
    config: () => config,
    env: { FLOWRYN_TOKEN: "leader-token", PATH: "/bin" },
    now: Date.now,
    log: () => {},
    info,
    harnessVersion: async (harness) => {
      if (probe) await probe;
      return versions[harness];
    },
    restartBusy: () => busy,
    herdrDown: () => herdr,
    afterPass: () => {
      passes++;
    },
    run: fakeRun,
  });
}

/** What a dispatch does: the gate, against the installed version (at `revisions`: this build's, or a test's bump). */
function gate(harness: HarnessId, revisionMap?: RevisionMap): Promise<HarnessCheck> {
  return gateHarness(db, config, harness, async (h) => versions[h], "cli", "dispatch", Date.now, revisionMap);
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
  return composeBriefing(db, { now: Date.now(), ageMs: 0, markMorning: false, session: null, morningHour: 25, config }).text;
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
  probe = null;
  signals = [];
  recovered = [];
  recovery = { ok: true, problems: [], by: "daemon", at: Date.now() };
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
    const guards = restartGuards(db, { mergesInFlight: [], cleanups: [], launching: [], challenges: [], contractChecks: auto.running() }, Date.now());
    expect(guards).toEqual([expect.objectContaining({ kind: "contract_check", detail: expect.stringContaining("automatic contract check claude 2.1.300 running for") })]);
    expect(briefing()).toMatch(/Contract check running: claude 2\.1\.300 since \d\d:\d\d \(automatic\)\./);
    const refusal = harnessRefusal({ harness: "claude", state: "unverified", version: "2.1.300", revision: CLAUDE_REVISION, stale: [] }, db, config);
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
    expect(harnessRefusal({ harness: "claude", state: "unverified", version: "2.1.300", revision: CLAUDE_REVISION, stale: [] }, db, config).help).toContain("queued (a daemon restart)");
    await auto.tick();
    expect(events("contract.auto_waiting")).toHaveLength(1);

    busy = false;
    herdr = "connect ENOENT";
    await auto.tick();
    expect(autoAttempt(db, "claude")).toMatchObject({ state: "waiting", wait: "Herdr (connect ENOENT)" });

    herdr = null;
    tx(db, () => noteUsageLimit(db, "claude", "r1", "rate_limit", Date.now(), { usage_backoff_ms: 3_600_000, usage_backoff_max_ms: 7_200_000 }));
    await auto.tick();
    expect(autoAttempt(db, "claude")).toMatchObject({ state: "waiting", wait: "the usage pause on account claude" });
    expect(jobs).toEqual([]);
    expect(items("harness_unverified")).toEqual([]);

    // Pi does not wait on Claude's usage.
    await gate("pi");
    await auto.tick();
    expect(jobs.map((j) => j.harness)).toEqual(["pi"]);
  });

  test("with declared Claude accounts, waits while any of them is usage-paused or under the quota floor", async () => {
    config = parseConfig(
      `data_dir = ${JSON.stringify(join(dir, "data"))}\n[tools]\nclaude = "/x/claude"\npi = "/x/pi"\n[policy]\nmode = "relaxed"\n[accounts.personal]\nharness = "claude"\n[accounts.work]\nharness = "claude"\nconfig_dir = "/x/work"\n`,
      dir,
    );
    const auto = checker();
    auto.init();
    await gate("claude");
    tx(db, () => noteUsageLimit(db, "personal", "leader", "rate_limit", Date.now(), { usage_backoff_ms: 3_600_000, usage_backoff_max_ms: 7_200_000 }));
    await auto.tick();
    expect(jobs).toEqual([]);
    expect(autoAttempt(db, "claude")).toMatchObject({ state: "waiting", wait: "the usage pause on account personal" });

    tx(db, () => {
      clearUsageLimit(db, "personal", "test", Date.now());
      recordQuota(db, "work", { state: "known", percent: 1, window: null, resets_at: null }, 5, Date.now());
      recordQuota(db, "personal", { state: "known", percent: 2, window: null, resets_at: null }, 5, Date.now());
    });
    await auto.tick();
    expect(jobs).toEqual([]);
    expect(autoAttempt(db, "claude")).toMatchObject({ state: "waiting", wait: "the quota floor on accounts personal, work" });

    tx(db, () => {
      recordQuota(db, "work", { state: "known", percent: 50, window: null, resets_at: null }, 5, Date.now());
      recordQuota(db, "personal", { state: "known", percent: 50, window: null, resets_at: null }, 5, Date.now());
    });
    await auto.tick();
    expect(jobs.map((j) => j.harness)).toEqual(["claude"]);
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

  test("a stop during the version probe starts no check; the probe is a restart guard, and a restart pending after it makes the check wait", async () => {
    let release = () => {};
    probe = new Promise<void>((resolve) => {
      release = resolve;
    });
    const auto = checker();
    auto.init();
    await gate("claude");
    const stopped = auto.tick();
    await Bun.sleep(20);
    expect(restartGuards(db, { mergesInFlight: [], cleanups: [], launching: [], challenges: [], contractChecks: auto.running() }, Date.now())).toEqual([
      expect.objectContaining({ kind: "contract_check" }),
    ]);
    await auto.stop();
    release();
    await stopped;
    expect(jobs).toEqual([]);
    expect(auto.running()).toEqual([]);

    probe = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = checker();
    next.init();
    const ticked = next.tick();
    await Bun.sleep(20);
    busy = true;
    release();
    await ticked;
    expect(jobs).toEqual([]);
    expect(autoAttempt(db, "claude")).toMatchObject({ state: "waiting", wait: "a daemon restart" });
    expect(next.running()).toEqual([]);
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
    expect(harnessRefusal({ harness: "claude", state: "unverified", version: "2.1.300", revision: CLAUDE_REVISION, stale: [] }, db, config).help).toBe("run the contract suite: flowryn doctor --contracts --harness claude");
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
    // Nothing will run now: the help names the doctor command, and the briefing lists no queued check.
    expect(harnessRefusal({ harness: "claude", state: "unverified", version: "2.1.300", revision: CLAUDE_REVISION, stale: [] }, db, config).help).toBe("run the contract suite: flowryn doctor --contracts --harness claude");
    expect(briefing()).not.toContain("Contract check queued");
  });

  test("a pass that ends after a reload to strict is left unrecorded with a P1 saying so; a reload to relaxed runs it again", async () => {
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
    expect(events("contract.auto_failed")).toEqual([]);
    expect(events("contract.auto_unrecorded")).toEqual([expect.objectContaining({ harness: "claude", version: "2.1.300", detail: "[policy] mode is strict now, so the daemon did not record its pass" })]);
    expect(autoAttempt(db, "claude")).toMatchObject({ version: "2.1.300", state: "unrecorded" });
    const [p1] = items("harness_unverified");
    expect(p1).toMatchObject({ state: "open" });
    expect(p1!.line).toStartWith(`claude 2.1.300 passed, not recorded as [policy] is strict now: ${join(dir, "data", "contracts", "claude-2.1.300-")}`);

    await auto.tick();
    expect(jobs).toHaveLength(1);
    expect(recorded()).toEqual([]);

    useConfig("relaxed");
    script = () => ({});
    await auto.tick();
    expect(jobs).toHaveLength(2);
    expect(recorded()).toEqual([{ harness: "claude", version: "2.1.300" }]);
    expect(items("harness_unverified")).toEqual([expect.objectContaining({ state: "resolved" })]);
  });
});

describe("one owner, one budget: the check's deadline and its cleanup", () => {
  test("assumption: the stop grace covers the runner's whole cleanup budget", () => {
    expect(AUTO_STOP_GRACE_MS).toBeGreaterThan(CONTRACT_CLEANUP_BUDGET_MS);
    // cancel 16 s, scratch daemon 20 s, a workspace 5 s, a harness 12 s, worktrees 5 s, the scratch home 10.5 s.
    expect(CONTRACT_CLEANUP_BUDGET_MS).toBe(68_500);
  });

  test("assumption: past its deadline the child gets SIGTERM and the stop grace before SIGKILL; it fails, and the checker releases what it left", async () => {
    script = () => ({ hold: true, ignoreTerm: true, manifest: "unfinished" });
    const auto = checker({ maxRunMs: 30, stopGraceMs: 200 });
    auto.init();
    await gate("claude");
    await auto.tick();
    expect(signals.map((s) => s.signal)).toEqual(["TERM", "KILL"]);
    expect(signals[1]!.at - signals[0]!.at).toBeGreaterThanOrEqual(190);
    expect(autoAttempt(db, "claude")).toMatchObject({ state: "failed", detail: expect.stringContaining("did not finish within"), cleanup: "ok", manifest: jobs[0]!.manifest });
    expect(jobs[0]!.manifest).toStartWith(join(dir, "data", "contracts", "auto-claude-2.1.300-"));
    expect(jobs[0]!.manifest).toEndWith(".owned.json");
    expect(recovered).toEqual([jobs[0]!.manifest]);
    expect(events("contract.auto_cleanup")).toEqual([expect.objectContaining({ harness: "claude", version: "2.1.300", ok: true, by: "daemon" })]);
    expect(items("contract_leftover")).toEqual([]);
  });

  test("a child that stops on SIGTERM within the grace is never killed", async () => {
    script = () => ({ hold: true, manifest: "clean" });
    const auto = checker({ maxRunMs: 30, stopGraceMs: 5_000 });
    auto.init();
    await gate("claude");
    await auto.tick();
    expect(signals.map((s) => s.signal)).toEqual(["TERM"]);
    expect(autoAttempt(db, "claude")).toMatchObject({ state: "failed", cleanup: "ok" });
    expect(recovered).toEqual([]);
  });

  test("assumption: contract success and cleanup success are recorded apart: a pass that left something is recorded, with one P1 naming it", async () => {
    script = () => ({ manifest: "unfinished" });
    recovery = { ok: false, problems: ["Herdr workspace w7 not closed: Herdr did not answer"], by: "daemon", at: Date.now() };
    const auto = checker();
    auto.init();
    await gate("claude");
    await auto.tick();
    expect(recorded()).toEqual([{ harness: "claude", version: "2.1.300" }]);
    expect(autoAttempt(db, "claude")).toMatchObject({ state: "passed", cleanup: "failed", cleanup_detail: "Herdr workspace w7 not closed: Herdr did not answer" });
    expect(events("contract.auto_cleanup_failed")).toEqual([expect.objectContaining({ harness: "claude", version: "2.1.300", by: "daemon", problems: recovery.problems, manifest: jobs[0]!.manifest })]);
    const [item] = items("contract_leftover");
    expect(item).toMatchObject({ state: "open", class: "actionable" });
    expect(item!.line).toContain("w7 not closed");
    expect(items("harness_unverified")).toEqual([]);

    // And a failed check whose cleanup was clean is still a failure, with no leftover P1.
    versions.claude = "2.1.301";
    script = () => ({ passed: false, manifest: "clean" });
    await gate("claude");
    await auto.tick();
    expect(autoAttempt(db, "claude")).toMatchObject({ version: "2.1.301", state: "failed", cleanup: "ok" });
    expect(items("contract_leftover")).toHaveLength(1);
  });

  test("a runner that recorded a clean cleanup is taken at its word; nothing is released again", async () => {
    script = () => ({ manifest: "clean" });
    const auto = checker();
    auto.init();
    await gate("claude");
    await auto.tick();
    expect(recovered).toEqual([]);
    expect(events("contract.auto_cleanup")).toEqual([expect.objectContaining({ ok: true, by: "runner" })]);
  });

  test("assumption: no manifest means the run recorded nothing it owned: cleanup none, no release, no P1", async () => {
    const auto = checker();
    auto.init();
    await gate("claude");
    await auto.tick();
    expect(autoAttempt(db, "claude")).toMatchObject({ state: "passed", cleanup: "none" });
    expect(recovered).toEqual([]);
    expect(events("contract.auto_cleanup")).toEqual([expect.objectContaining({ ok: null, detail: expect.stringContaining("no manifest") })]);
    expect(items("contract_leftover")).toEqual([]);
  });

  test("assumption: a daemon stop never kills the child; the next start releases its manifest before any new check starts", async () => {
    const auto = checker({ daemonStopWaitMs: 50 });
    auto.init();
    script = () => ({ hold: true, ignoreTerm: true, manifest: "unfinished" });
    await gate("claude");
    const running = auto.tick();
    await Bun.sleep(20);
    await auto.stop();
    expect(signals.map((s) => s.signal)).toEqual(["TERM"]);
    // The child finishes on its own later; the stopped checker records nothing of it.
    for (const h of held.splice(0)) h.resolve();
    await running;
    const manifest = jobs[0]!.manifest;
    expect(autoAttempt(db, "claude")).toMatchObject({ state: "running", manifest });
    expect(events("contract.auto_cleanup")).toEqual([]);

    const order: string[] = [];
    script = () => {
      order.push("check");
      return {};
    };
    const next = checker({ onRecover: (path) => order.push(`release ${path}`) });
    next.init();
    expect(events("contract.auto_interrupted")).toEqual([expect.objectContaining({ manifest })]);
    await next.tick();
    expect(order).toEqual([`release ${manifest}`, "check"]);
    // The cut-off run's release, then the rerun's own (it kept no manifest).
    expect(events("contract.auto_cleanup")).toEqual([expect.objectContaining({ manifest, ok: true, by: "daemon" }), expect.objectContaining({ ok: null })]);
    expect(recorded()).toEqual([{ harness: "claude", version: "2.1.300" }]);
  });

  test("a start that stops again before its release finishes leaves the manifest for the next start", async () => {
    const auto = checker({ daemonStopWaitMs: 50 });
    auto.init();
    script = () => ({ hold: true, ignoreTerm: true, manifest: "unfinished" });
    await gate("claude");
    const running = auto.tick();
    await Bun.sleep(20);
    await auto.stop();
    for (const h of held.splice(0)) h.resolve();
    await running;
    const manifest = jobs[0]!.manifest;

    const cutOff = checker();
    cutOff.init();
    expect(autoAttempt(db, "claude")).toMatchObject({ state: "waiting", manifest });

    const order: string[] = [];
    script = () => {
      order.push("check");
      return {};
    };
    const next = checker({ onRecover: (path) => order.push(`release ${path}`) });
    next.init();
    expect(events("contract.auto_interrupted")).toHaveLength(1);
    await next.tick();
    expect(order).toEqual([`release ${manifest}`, "check"]);
    expect(events("contract.auto_cleanup")[0]).toMatchObject({ manifest, ok: true, by: "daemon" });
    expect(recorded()).toEqual([{ harness: "claude", version: "2.1.300" }]);

    const after = checker({ onRecover: (path) => order.push(`release ${path}`) });
    after.init();
    await after.tick();
    expect(order).toEqual([`release ${manifest}`, "check"]);
  });

  test("an attempt from before manifests reruns with nothing released", async () => {
    tx(db, () => saveAutoAttempt(db, "claude", { version: "2.1.300", state: "running", started_at: 1, build: BUILD, log: "/x.log" }));
    const next = checker();
    next.init();
    await gate("claude");
    await next.tick();
    expect(recovered).toEqual([]);
    expect(recorded()).toEqual([{ harness: "claude", version: "2.1.300" }]);
  });

  test("the leftover line names what was left and the manifest under ~", () => {
    const line = autoLeftoverLine("claude", "2.1.300", ["Herdr workspace w7 not closed: timeout"], "/Users/me/.flowryn/data/contracts/auto-claude-2.1.300-x.owned.json", "/Users/me");
    expect(line).toBe("claude 2.1.300's automatic contract check left resources behind (Herdr workspace w7 not closed: timeout); manifest ~/.flowryn/data/contracts/auto-claude-2.1.300-x.owned.json");
  });
});

describe("the failure line", () => {
  test("fits the 200-character item line whole, for a report under a real home", () => {
    const line = autoFailureLine("claude", "2.1.300", "/Users/somebody/.flowryn/data/contracts/claude-2.1.300-2026-10-09T00-55-08-590Z.json", "/Users/somebody");
    expect(line).toBe("claude 2.1.300 failed its automatic contract check: ~/.flowryn/data/contracts/claude-2.1.300-2026-10-09T00-55-08-590Z.json; rerun: flowryn doctor --contracts --harness claude");
    expect(line.length).toBeLessThanOrEqual(200);
    expect(autoFailureLine("pi", "0.90.0", "/opt/data/contracts/r.json", "/Users/somebody")).toContain(": /opt/data/contracts/r.json;");
  });

  test("the unrecorded-pass line fits too", () => {
    const line = autoUnrecordedLine("claude", "2.1.300", "/Users/somebody/.flowryn/data/contracts/claude-2.1.300-2026-10-09T00-55-08-590Z.json", "/Users/somebody");
    expect(line).toBe("claude 2.1.300 passed, not recorded as [policy] is strict now: ~/.flowryn/data/contracts/claude-2.1.300-2026-10-09T00-55-08-590Z.json; record it: flowryn doctor --contracts --harness claude");
    expect(line.length).toBeLessThanOrEqual(200);
  });
});

describe("the --for-daemon handoff", () => {
  test("reads the report and version from the doctor reply, and the failing check's detail", () => {
    expect(parseHandoff('{"ok":true,"data":{"report":"/d/r.json","version":"1.2.3","checks":[]}}\n')).toEqual({ report: "/d/r.json", version: "1.2.3", detail: null });
    expect(parseHandoff('{"ok":true,"data":{"report":"-","version":"-","checks":[{"status":"fail","detail":"no Herdr session"}]}}')).toEqual({ report: null, version: null, detail: "no Herdr session" });
    expect(parseHandoff("not json")).toEqual({ report: null, version: null, detail: null });
  });
});

/** A pass as recordPass writes it, at `revision`, from `passBuild`. */
function seedPass(harness: HarnessId, version: string, revision: number, passBuild: string | null = BUILD): void {
  tx(db, () =>
    recordPass(
      db,
      { harness, version, revision, report: null, by: "human", build: passBuild, session: null, source: "cli", platform: null, herdr_version: null, launch_profile: null },
      Date.now(),
    ),
  );
}

function revisions(harness: HarnessId): number[] {
  return (db.query("SELECT revision FROM harness_contracts WHERE harness = ?1 ORDER BY revision").all(harness) as { revision: number }[]).map((r) => r.revision);
}

/** Every harness at the baseline revision: the build that introduced revisions, before any bump. */
const AT_BASELINE: RevisionMap = { claude: BASELINE_REVISION, pi: BASELINE_REVISION };

/** This build's revisions with one harness bumped, as the PR that changes its proven behaviour would. */
function bumped(harness: HarnessId): RevisionMap {
  return { ...CONTRACT_REVISIONS, [harness]: CONTRACT_REVISIONS[harness] + 1 };
}

describe("contract revision (docs/notes/2026-10-12-next-steps-md-ez.md)", () => {
  test("a pass at the current revision from another build is reused: a docs-only rebuild runs no check", async () => {
    seedPass("claude", "2.1.300", CLAUDE_REVISION, "0f0f0f0f0f0f");
    const auto = checker();
    auto.init();
    expect(await gate("claude")).toEqual({ harness: "claude", state: "verified", version: "2.1.300", revision: CLAUDE_REVISION });
    await auto.tick();
    expect(jobs).toEqual([]);
    expect(events("harness.unverified")).toEqual([]);
  });

  test("a bump makes the pass at the old revision stale: the gate refuses, naming both revisions, and opens one P1 under strict", async () => {
    useConfig("strict");
    seedPass("claude", "2.1.300", CLAUDE_REVISION);
    const next = CLAUDE_REVISION + 1;
    const check = await gate("claude", bumped("claude"));
    expect(check).toEqual({ harness: "claude", state: "unverified", version: "2.1.300", revision: next, stale: [CLAUDE_REVISION] });
    expect(harnessRefusal(check as Extract<HarnessCheck, { state: "unverified" }>).message).toBe(`claude 2.1.300 passed only at contract revision ${CLAUDE_REVISION}, not revision ${next}`);
    expect(events("harness.unverified")).toEqual([expect.objectContaining({ version: "2.1.300", revision: next, stale: [CLAUDE_REVISION] })]);
    expect(items("harness_unverified")).toEqual([
      expect.objectContaining({
        state: "open",
        line: `claude 2.1.300 passed only at contract revision ${CLAUDE_REVISION}, not revision ${next}, so dispatch and resume on claude are refused until it passes: flowryn doctor --contracts --harness claude`,
      }),
    ]);
    await gate("claude", bumped("claude"));
    expect(items("harness_unverified")).toHaveLength(1);
    // The other harness, and an unbumped build, still reuse their passes.
    seedPass("pi", "0.90.0", CONTRACT_REVISIONS.pi);
    expect(await gate("pi", bumped("claude"))).toMatchObject({ state: "verified" });
    expect(await gate("claude")).toMatchObject({ state: "verified" });
  });

  test("a pass at another revision is stale: under relaxed the daemon re-records the version at its own", async () => {
    seedPass("claude", "2.1.300", CLAUDE_REVISION + 1);
    const auto = checker();
    auto.init();
    const check = await gate("claude");
    expect(check).toEqual({ harness: "claude", state: "unverified", version: "2.1.300", revision: CLAUDE_REVISION, stale: [CLAUDE_REVISION + 1] });
    expect(events("harness.unverified")).toEqual([expect.objectContaining({ version: "2.1.300", revision: CLAUDE_REVISION, stale: [CLAUDE_REVISION + 1], auto: true })]);
    expect(unverifiedVersion(db, "claude")).toBe("2.1.300");

    await auto.tick();
    expect(jobs.map((j) => j.version)).toEqual(["2.1.300"]);
    expect(revisions("claude")).toEqual([CLAUDE_REVISION, CLAUDE_REVISION + 1]);
    expect(events("contract.passed").at(-1)).toMatchObject({ version: "2.1.300", revision: CLAUDE_REVISION, by: "daemon", platform: CONTEXT.platform, herdr_version: CONTEXT.herdr, launch_profile: CONTEXT.launch_profile });
    expect(autoAttempt(db, "claude")).toMatchObject({ version: "2.1.300", revision: CLAUDE_REVISION, state: "passed" });
    expect(await gate("claude")).toMatchObject({ state: "verified" });
    expect(items("harness_unverified")).toEqual([]);
  });

  test("a check that failed at another revision does not settle the daemon's: it runs once more, then is final", async () => {
    tx(db, () => saveAutoAttempt(db, "claude", { version: "2.1.300", revision: CLAUDE_REVISION + 1, state: "failed", ended_at: 1, detail: "a failure at another revision" }));
    const auto = checker();
    auto.init();
    script = () => ({ passed: false });
    await gate("claude");
    await auto.tick();
    await auto.tick();
    expect(jobs).toHaveLength(1);
    expect(autoAttempt(db, "claude")).toMatchObject({ revision: CLAUDE_REVISION, state: "failed" });
    expect(events("contract.auto_failed")).toEqual([expect.objectContaining({ version: "2.1.300", revision: CLAUDE_REVISION })]);
  });

  // Both harnesses are past the baseline revision now, so these pin the checker to it.
  test("a check that failed before revisions is at the baseline: still final for that version, so an upgrade runs nothing again", async () => {
    tx(db, () => saveAutoAttempt(db, "pi", { version: "0.90.0", state: "failed", ended_at: 1, detail: "an old failure" }));
    // The build that introduced revisions, still at the baseline: a later bump makes the old failure stale, as it should.
    const auto = checker({ revisions: AT_BASELINE });
    auto.init();
    await gate("pi", AT_BASELINE);
    await auto.tick();
    expect(jobs).toEqual([]);
  });

  test("a report that proves another revision is not recorded by the daemon", async () => {
    const auto = checker();
    auto.init();
    script = () => ({ revision: CLAUDE_REVISION + 1 });
    await gate("claude");
    await auto.tick();
    expect(recorded()).toEqual([]);
    expect(events("contract.auto_failed")[0]).toMatchObject({ detail: `the report proves contract revision ${CLAUDE_REVISION + 1}, not this daemon's revision ${CLAUDE_REVISION}` });
  });

  test("strict: a flag and P1 from before revisions are at the baseline: the upgrade opens no second P1 for the same version", async () => {
    useConfig("strict");
    // What the gate left before revisions: a plain-version flag and a P1 whose event names no revision, dismissed since.
    tx(db, () => {
      setMeta(db, "harness_flagged:pi", "0.90.0");
      const event = appendEvent(db, { source: "daemon", kind: "harness.unverified", payload: { harness: "pi", version: "0.90.0", where: "startup" } });
      openItem(db, { kind: "harness_unverified", eventSeq: event.seq, taskId: "harness:pi", line: "old", now: 1 });
      resolveItems(db, "harness_unverified", "harness:pi", "dismissed before revisions", 2);
    });
    const auto = checker({ revisions: AT_BASELINE });
    auto.init();
    await gate("pi", AT_BASELINE);
    await auto.tick();
    expect(jobs).toEqual([]);
    expect(events("harness.unverified")).toHaveLength(1);
    expect(items("harness_unverified").filter((i) => i.state === "open")).toEqual([]);
  });

  test("strict: only a pass at the daemon's revision settles the P1; one at another revision does not", async () => {
    useConfig("strict");
    seedPass("claude", "2.1.300", CLAUDE_REVISION + 1);
    await gate("claude");
    expect(items("harness_unverified").filter((i) => i.state === "open")).toHaveLength(1);
    seedPass("claude", "2.1.300", CLAUDE_REVISION + 2);
    expect(items("harness_unverified").filter((i) => i.state === "open")).toHaveLength(1);
    expect(JSON.parse(getMeta(db, "harness_flagged:claude")!)).toEqual({ version: "2.1.300", revision: CLAUDE_REVISION });
    seedPass("claude", "2.1.300", CLAUDE_REVISION);
    expect(items("harness_unverified").filter((i) => i.state === "open")).toEqual([]);
    expect(await gate("claude")).toMatchObject({ state: "verified" });
  });

  test("strict: a pass at the current revision settles a P1 still flagged in the plain-version format from before revisions", () => {
    useConfig("strict");
    tx(db, () => {
      setMeta(db, "harness_flagged:claude", "2.1.300");
      const event = appendEvent(db, { source: "daemon", kind: "harness.unverified", payload: { harness: "claude", version: "2.1.300", where: "startup" } });
      openItem(db, { kind: "harness_unverified", eventSeq: event.seq, taskId: "harness:claude", line: "old", now: 1 });
    });
    seedPass("claude", "2.1.300", CLAUDE_REVISION + 1);
    expect(items("harness_unverified").filter((i) => i.state === "open")).toHaveLength(1);
    expect(getMeta(db, "harness_flagged:claude")).toBe("2.1.300");
    seedPass("claude", "2.1.300", CLAUDE_REVISION);
    expect(items("harness_unverified").filter((i) => i.state === "open")).toEqual([]);
    expect(unverifiedVersion(db, "claude")).toBeNull();
  });
});
