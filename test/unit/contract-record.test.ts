import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { hashToken, mintToken } from "../../src/api/auth.ts";
import type { Envelope } from "../../src/api/envelope.ts";
import { Gateway } from "../../src/api/gateway.ts";
import type { DaemonServices } from "../../src/api/verbs.ts";
import { inertAttention } from "../../src/attention/services.ts";
import { composeBriefing } from "../../src/attention/briefing.ts";
import { defaultConfig, parseConfig, type FlowrynConfig } from "../../src/config/config.ts";
import { DEFAULT_POLICY_MODE, policyMode } from "../../src/config/policy.ts";
import { workerConfigProblems } from "../../src/config/workers.ts";
import { checkLeaderReport, recordGrant, type GrantInput } from "../../src/contracts/grant.ts";
import { dataDirReport } from "../../src/contracts/report.ts";
import { CONTRACT_VERBS } from "../../src/contracts/verbs.ts";
import { inertRestart } from "../../src/daemon/restart.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { policyCheck } from "../../src/doctor/doctor.ts";
import { Journal } from "../../src/journal/journal.ts";
import { BacklogWatcher } from "../../src/journal/watcher.ts";
import { inertLavish } from "../../src/lavish/services.ts";
import { inertFleet } from "../../src/lifecycle/fleet-services.ts";
import { inertDelivery } from "../../src/policy/services.ts";
import { inertSched } from "../../src/sched/services.ts";
import { ulid } from "../../src/util/ulid.ts";
import { PROTO } from "../../src/version.ts";
import { writeLeaderFiles } from "../../src/bridges/files.ts";
import { configStaticLayers } from "../../src/policy/static.ts";

const INSTALLED = "ab12cd34ef56";
const PR_BUILD = "0f0f0f0f0f0f";

function refusal(input: GrantInput): string | null {
  try {
    recordGrant(input);
    return null;
  } catch (error) {
    return (error as { code: string }).code;
  }
}

describe("[policy] mode", () => {
  test("a missing key is strict; strict and relaxed parse; anything else is config_invalid", () => {
    const home = "/h";
    expect(DEFAULT_POLICY_MODE).toBe("strict");
    expect(policyMode(defaultConfig(home))).toBe("strict");
    expect(policyMode(parseConfig('[policy]\nmode = "relaxed"\n', home))).toBe("relaxed");
    expect(policyMode(parseConfig('[policy]\nmode = "strict"\n', home))).toBe("strict");
    expect(() => policyMode(parseConfig('[policy]\nmode = "lax"\n', home))).toThrow('[policy] mode must be "strict" or "relaxed"');
    expect(() => policyMode(parseConfig("[policy]\nmode = 1\n", home))).toThrow("[policy] mode must be");
    expect(() => policyMode(parseConfig('[policy]\nrecord = "yes"\n', home))).toThrow("[policy] record is not a known setting");
  });

  test("a bad mode is a config problem: the daemon refuses it at startup and on SIGHUP, and doctor fails it", () => {
    expect(workerConfigProblems(parseConfig('[policy]\nmode = "lax"\n', "/h"))).toContain('[policy] mode must be "strict" or "relaxed"');
    expect(workerConfigProblems(parseConfig('[policy]\nmode = "relaxed"\n', "/h"))).toEqual([]);
  });

  test("doctor shows the mode in force", () => {
    expect(policyCheck(defaultConfig("/h"))).toMatchObject({ check: "policy", status: "ok" });
    expect(policyCheck(defaultConfig("/h"))!.detail).toStartWith("strict: only your own terminal records");
    expect(policyCheck(parseConfig('[policy]\nmode = "relaxed"\n', "/h"))!.detail).toStartWith("relaxed: the daemon checks a new harness version itself and the leader may record");
  });
});

describe("recordGrant: who may record a contract pass", () => {
  test("your own terminal records in both modes, whatever build runs", () => {
    for (const mode of ["strict", "relaxed"] as const) {
      expect(refusal({ role: "human", mode, callerBuild: null, daemonBuild: null })).toBeNull();
      expect(refusal({ role: "human", mode, callerBuild: PR_BUILD, daemonBuild: INSTALLED })).toBeNull();
    }
  });

  test("a worker never records, in either mode, even with the installed build", () => {
    for (const mode of ["strict", "relaxed"] as const) expect(refusal({ role: "worker", mode, callerBuild: INSTALLED, daemonBuild: INSTALLED })).toBe("worker_token");
  });

  test("a read-only session or an anonymous caller never records", () => {
    expect(refusal({ role: "reader", mode: "relaxed", callerBuild: INSTALLED, daemonBuild: INSTALLED })).toBe("human_only");
    expect(refusal({ role: "anonymous", mode: "relaxed", callerBuild: INSTALLED, daemonBuild: INSTALLED })).toBe("human_only");
  });

  test("strict: the leader never records, even with the installed build", () => {
    expect(refusal({ role: "leader", mode: "strict", callerBuild: INSTALLED, daemonBuild: INSTALLED })).toBe("human_only");
  });

  test("relaxed: the leader records only when its build is the daemon's build", () => {
    expect(refusal({ role: "leader", mode: "relaxed", callerBuild: INSTALLED, daemonBuild: INSTALLED })).toBeNull();
    expect(refusal({ role: "leader", mode: "relaxed", callerBuild: PR_BUILD, daemonBuild: INSTALLED })).toBe("not_installed_build");
    expect(refusal({ role: "leader", mode: "relaxed", callerBuild: null, daemonBuild: INSTALLED })).toBe("not_installed_build");
  });

  test("relaxed: a development daemon has no build id, so the leader never records there", () => {
    expect(refusal({ role: "leader", mode: "relaxed", callerBuild: null, daemonBuild: null })).toBe("not_installed_build");
  });
});

let dir: string;
let db: Db;
let config: FlowrynConfig;
let gateway: Gateway;
let leaderToken: string;
let readerToken: string;
let runToken: string;
let daemonBuild: string | null;

function useConfig(text: string): void {
  config = parseConfig(`data_dir = ${JSON.stringify(join(dir, "data"))}\n${text}`, dir);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-record-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  leaderToken = mintToken("leader");
  readerToken = mintToken("leader");
  runToken = mintToken("run");
  daemonBuild = INSTALLED;
  useConfig('[policy]\nmode = "relaxed"\n');
  const now = Date.now();
  tx(db, () => {
    db.query("INSERT INTO leader_lease (id, session_id, epoch, token_hash) VALUES (1, 'L1', 1, ?1)").run(hashToken(leaderToken));
    db.query("INSERT INTO leader_sessions (session_id, harness, token_hash, started_at) VALUES ('L1', 'claude', ?1, ?3), ('L2', 'claude', ?2, ?3)").run(hashToken(leaderToken), hashToken(readerToken), now);
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('p', 'u', '/p', 'main', 'no-mistakes')").run();
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES ('t1', 'p', 'ship', 'no-mistakes', 0, 'fix', ?1)").run(now);
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
       VALUES ('r1', 't1', 'claude', 'v', 'running', 'busy', 'fix', 'build', '/w', 'b', 's', ?1, ?2, ?2)`,
    ).run(hashToken(runToken), now);
  });
  const journal = new Journal({ db, files: () => ({ backlog: join(dir, "b.md"), todos: join(dir, "t.md") }), runner: () => null });
  const watcher = new BacklogWatcher({ db, journal, files: () => ({ backlog: join(dir, "b.md"), todos: join(dir, "t.md") }), runner: () => null });
  const info = () => ({ pid: 1, version: "t", proto: PROTO, instance: "i", startedAt: 0, execPath: "/bin/flowryn", build: daemonBuild, socket: "/s", stateDir: dir });
  const services: DaemonServices = {
    db,
    config: () => config,
    journal,
    watcher,
    now: Date.now,
    log: () => {},
    info,
    requestShutdown: () => {},
    runTool: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    fleet: inertFleet(),
    attention: inertAttention(),
    delivery: inertDelivery(),
    sched: inertSched(),
    restart: inertRestart(db, info),
    lavish: inertLavish(),
  };
  const verbs = new Map(CONTRACT_VERBS.map((v) => [v.name, v]));
  gateway = new Gateway({ services, lookup: (v) => verbs.get(v) });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A report as `flowryn doctor --contracts` writes it. */
function writeReport(stamp: { mode: "record" | "verify-only"; build: string | null }, overrides: Record<string, unknown> = {}): string {
  const result = { harness: "claude" as const, version: "2.1.300", passed: true, steps: [], scratch: "/tmp/x", ...overrides };
  return dataDirReport(config, result as never, { ...stamp, by: "leader" });
}

function record(token: string | null, args: Record<string, unknown>, channel: "tty" | null = null) {
  const envelope: Envelope = { proto: PROTO, ulid: ulid(), verb: "contracts.record", token, channel, args: { harness: "claude", version: "2.1.300", ...args } };
  return gateway.handle(envelope);
}

function mayRecord(token: string | null, args: Record<string, unknown>, channel: "tty" | null = null) {
  return gateway.handle({ proto: PROTO, ulid: ulid(), verb: "contracts.may_record", token, channel, args });
}

function recorded(): { harness: string; version: string }[] {
  return db.query("SELECT harness, version FROM harness_contracts").all() as { harness: string; version: string }[];
}

function passedEvents(): Record<string, unknown>[] {
  return (db.query("SELECT payload FROM events WHERE kind = 'contract.passed' ORDER BY seq").all() as { payload: string }[]).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
}

function recordedItems(): { line: string; class: string; lane: string }[] {
  return db.query("SELECT line, class, lane FROM items WHERE kind = 'contract_recorded'").all() as { line: string; class: string; lane: string }[];
}

describe("contracts.record and contracts.may_record", () => {
  test("your own terminal records as before: no build, no report check, no item", async () => {
    useConfig("");
    const reply = await record(null, { report: "/anywhere.json" }, "tty");
    expect(reply).toMatchObject({ ok: true, data: { recorded: true, by: "human" } });
    expect(recorded()).toEqual([{ harness: "claude", version: "2.1.300" }]);
    expect(passedEvents()).toEqual([{ harness: "claude", version: "2.1.300", report: "/anywhere.json", by: "human", build: null, session: null }]);
    expect(recordedItems()).toEqual([]);
    expect((await mayRecord(null, {}, "tty")).ok).toBe(true);
  });

  test("a worker token is refused and records nothing", async () => {
    const report = writeReport({ mode: "record", build: INSTALLED });
    expect((await record(runToken, { report, build: INSTALLED })).error!.code).toBe("worker_token");
    expect((await mayRecord(runToken, { build: INSTALLED })).error!.code).toBe("worker_token");
    expect(recorded()).toEqual([]);
  });

  test("a read-only leader session is refused", async () => {
    const report = writeReport({ mode: "record", build: INSTALLED });
    expect((await record(readerToken, { report, build: INSTALLED })).error!.code).toBe("not_leader");
    expect(recorded()).toEqual([]);
  });

  test("strict: the leader is refused, even from the installed build", async () => {
    useConfig("");
    const report = writeReport({ mode: "record", build: INSTALLED });
    const pre = await mayRecord(leaderToken, { build: INSTALLED });
    expect(pre.error).toMatchObject({ code: "human_only", message: expect.stringContaining("strict policy") });
    expect((await record(leaderToken, { report, build: INSTALLED })).error!.code).toBe("human_only");
    expect(recorded()).toEqual([]);
    expect(passedEvents()).toEqual([]);
  });

  test("relaxed, installed build: the leader records, with the event, an info item for your digest and a briefing line", async () => {
    expect((await mayRecord(leaderToken, { build: INSTALLED })).data).toEqual({ may_record: true, by: "leader" });
    const report = writeReport({ mode: "record", build: INSTALLED });
    const reply = await record(leaderToken, { report, build: INSTALLED });
    expect(reply).toMatchObject({ ok: true, data: { recorded: true, by: "leader" } });
    expect(recorded()).toEqual([{ harness: "claude", version: "2.1.300" }]);
    expect(passedEvents()).toEqual([{ harness: "claude", version: "2.1.300", report, by: "leader", build: INSTALLED, session: "L1" }]);
    expect(recordedItems()).toEqual([{ line: `claude 2.1.300 passed, recorded by the leader (build ${INSTALLED})`, class: "info", lane: "P1" }]);
    const briefing = composeBriefing(db, { session: null, now: Date.now(), morningHour: 5, ageMs: 0, markMorning: false });
    expect(briefing.text).toContain(`claude 2.1.300 passed, recorded by the leader (build ${INSTALLED}).`);
  });

  test("relaxed, another binary: a PR build, a development command or a rebuilt one is refused and records nothing", async () => {
    for (const build of [PR_BUILD, undefined]) {
      const report = writeReport({ mode: "record", build: build ?? null });
      expect((await mayRecord(leaderToken, build ? { build } : {})).error!.code).toBe("not_installed_build");
      expect((await record(leaderToken, { report, ...(build ? { build } : {}) })).error!.code).toBe("not_installed_build");
    }
    // A development daemon has no build id, so nothing the leader claims matches it.
    daemonBuild = null;
    expect((await mayRecord(leaderToken, { build: INSTALLED })).error!.code).toBe("not_installed_build");
    expect(recorded()).toEqual([]);
    expect(recordedItems()).toEqual([]);
  });

  test("relaxed: the leader's record must name its own passing, recording run's report", async () => {
    const elsewhere = join(dir, "elsewhere.json");
    writeFileSync(elsewhere, readFileSync(writeReport({ mode: "record", build: INSTALLED }), "utf8"));
    // Each report is written just before its record: two in the same millisecond share a file name.
    const cases: [() => Record<string, unknown>, string][] = [
      [() => ({}), "no --report"],
      [() => ({ report: join(dir, "data", "contracts", "missing.json") }), "does not exist"],
      [() => ({ report: elsewhere }), "is not in"],
      [() => ({ report: writeReport({ mode: "verify-only", build: INSTALLED }) }), "verify-only run"],
      [() => ({ report: writeReport({ mode: "record", build: INSTALLED }, { passed: false }) }), "not a passing run"],
      [() => ({ report: writeReport({ mode: "record", build: INSTALLED }, { version: "2.1.299" }) }), "is for claude 2.1.299"],
      [() => ({ report: writeReport({ mode: "record", build: PR_BUILD }) }), `written by build ${PR_BUILD}`],
    ];
    for (const [args, why] of cases) {
      const reply = await record(leaderToken, { build: INSTALLED, ...args() });
      expect(reply.error).toMatchObject({ code: "not_installed_build", message: expect.stringContaining(why) });
    }
    expect(recorded()).toEqual([]);
  });

  test("the daemon reads the mode per call, so a SIGHUP reload applies at once", async () => {
    const report = writeReport({ mode: "record", build: INSTALLED });
    useConfig("");
    expect((await record(leaderToken, { report, build: INSTALLED })).error!.code).toBe("human_only");
    useConfig('[policy]\nmode = "relaxed"\n');
    expect((await record(leaderToken, { report, build: INSTALLED })).ok).toBe(true);
  });
});

describe("contract reports", () => {
  test("a verify-only report says so in its name and its body; a recording one carries mode, build and caller", () => {
    useConfig("");
    const verify = writeReport({ mode: "verify-only", build: PR_BUILD });
    expect(basename(verify)).toMatch(/^claude-2\.1\.300-.+-verify-only\.json$/);
    expect(JSON.parse(readFileSync(verify, "utf8"))).toMatchObject({ mode: "verify-only", build: PR_BUILD, by: "leader", passed: true });
    const rec = writeReport({ mode: "record", build: INSTALLED });
    expect(basename(rec)).not.toContain("verify-only");
    expect(JSON.parse(readFileSync(rec, "utf8"))).toMatchObject({ mode: "record", build: INSTALLED });
  });

  test("checkLeaderReport resolves symlinks: a link in data_dir/contracts to a file elsewhere is refused", () => {
    useConfig("");
    const outside = join(dir, "outside.json");
    writeFileSync(outside, readFileSync(writeReport({ mode: "record", build: INSTALLED }), "utf8"));
    const link = join(config.data_dir, "contracts", "link.json");
    symlinkSync(outside, link);
    expect(() => checkLeaderReport(config.data_dir, link, { harness: "claude", version: "2.1.300", build: INSTALLED })).toThrow("is not in");
  });

  test("checkLeaderReport names the missing contracts directory, not the report, when data_dir/contracts is gone", () => {
    useConfig("");
    const report = join(dir, "report.json");
    writeFileSync(report, "{}");
    const contractsDir = join(config.data_dir, "contracts");
    expect(existsSync(contractsDir)).toBe(false);
    expect(() => checkLeaderReport(config.data_dir, report, { harness: "claude", version: "2.1.300", build: INSTALLED })).toThrow(`${contractsDir} does not exist`);
    expect(() => checkLeaderReport(config.data_dir, join(dir, "missing.json"), { harness: "claude", version: "2.1.300", build: INSTALLED })).toThrow(`${join(dir, "missing.json")} does not exist`);
  });
});

describe("the leader skill", () => {
  test("the SKILL.md written for both harnesses runs a worker-path PR's build verify-only itself, and the recording check after a harness update, asking the user only when refused", async () => {
    const files = await writeLeaderFiles({ home: dir, command: ["flowryn"], socket: join(dir, "s"), style: null, toolkit: configStaticLayers(defaultConfig(dir)) });
    for (const path of [join(files.skillDir, "SKILL.md"), join(files.claudePlugin, "skills", basename(files.skillDir), "SKILL.md")]) {
      const skill = readFileSync(path, "utf8");
      expect(skill).toContain("bun <worktree>/src/main.ts doctor --contracts --verify-only");
      expect(skill).toContain("doctor --contracts --harness <h>");
      expect(skill).toContain("on `human_only` (strict policy) or `not_installed_build`, ask the user to run it");
      expect(skill).not.toContain("ask the user to run `flowryn doctor --contracts` in their own terminal and merge");
    }
  });
});
