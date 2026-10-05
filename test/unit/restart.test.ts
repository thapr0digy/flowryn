import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeBriefing } from "../../src/attention/briefing.ts";
import { FlowrynError } from "../../src/api/errors.ts";
import type { Caller, DaemonInfo } from "../../src/api/verbs.ts";
import { getMeta, migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import {
  RESTART_COOLDOWN_MS,
  RestartController,
  buildIdOf,
  commandOf,
  localStamp,
  readPending,
  recordRestarted,
  restartGuards,
  smokeCheck,
  type InMemoryWork,
  type ProcResult,
  type Supervisor,
} from "../../src/daemon/restart.ts";
import { agentPid, launchdSupervisor, plistDrift, type LaunchdDeps, type PlistSpec } from "../../src/service/launchd.ts";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-restart-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  const now = Date.now();
  tx(db, () => {
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('p', 'u', '/p', 'main', 'no-mistakes')").run();
    for (const [task, run] of [
      ["t1", "r1"],
      ["t2", "r2"],
    ] as const) {
      db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES (?1, 'p', 'ship', 'no-mistakes', 0, 'fix', ?2)").run(task, now);
      db.query(
        `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
         VALUES (?1, ?2, 'claude', 'v', 'running', 'busy', 'fix', 'build', '/w', 'b', 's', ?1, ?3, ?3)`,
      ).run(run, task, now);
    }
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const NO_WORK: InMemoryWork = { mergesInFlight: [], cleanups: [], launching: [], approvalTasks: [] };
const LEADER: Caller = { role: "leader", runId: null, taskId: null, session: "L3" };

function info(build: string | null = "aaaaaaaaaaaa"): DaemonInfo {
  return { pid: 4411, version: "0.5.0", proto: 4, instance: "i", startedAt: Date.now() - 90_000, execPath: "/x/flowryn", build, socket: "/s", stateDir: dir };
}

function seedMerge(task: string, state: string): void {
  tx(db, () => {
    db.query("INSERT INTO approvals (id, task_id, pr_url, head_sha, channel, actor, created_at, expires_at) VALUES (?1, ?2, 'u', 'h', 'cli-tty', 'you', 1, 2)").run(`a-${task}`, task);
    db.query("INSERT INTO merges (id, task_id, pr_url, head_sha, approval_id, requested_at, state) VALUES (?1, ?2, 'u', 'h', ?3, ?4, ?5)").run(`m-${task}`, task, `a-${task}`, Date.now() - 12_000, state);
  });
}

describe("restart guards", () => {
  test("nothing in flight: no guard", () => {
    expect(restartGuards(db, NO_WORK, Date.now())).toEqual([]);
  });

  test("mid-merge: a requested merge, and one the daemon is asking GitHub about", () => {
    seedMerge("t1", "requested");
    seedMerge("t2", "merged");
    const guards = restartGuards(db, { ...NO_WORK, mergesInFlight: ["m-t2"] }, Date.now());
    expect(guards.map((g) => [g.kind, g.task])).toEqual([
      ["merging", "t1"],
      ["merging", "t2"],
    ]);
    expect(guards[0]!.detail).toContain("merge m-t1 requested");
  });

  test("a merge already proven or refused does not block", () => {
    seedMerge("t1", "merged");
    seedMerge("t2", "refused");
    expect(restartGuards(db, NO_WORK, Date.now())).toEqual([]);
  });

  test("blocked prompt: an open blocked_prompt item, or a run held at blocked_dialog, once per run", () => {
    tx(db, () => {
      const { seq } = appendEvent(db, { source: "hook", kind: "run.blocked_prompt", runId: "r1", taskId: "t1" });
      db.query("INSERT INTO items (id, event_seq, class, lane, kind, task_id, run_id, line, opened_at) VALUES ('i23', ?1, 'actionable', 'P1', 'blocked_prompt', 't1', 'r1', 'Do you want to proceed?', 1)").run(seq);
      db.query("UPDATE runs SET liveness = 'blocked_dialog' WHERE id IN ('r1','r2')").run();
    });
    const guards = restartGuards(db, NO_WORK, Date.now());
    expect(guards.map((g) => [g.kind, g.task])).toEqual([
      ["blocked_prompt", "t1"],
      ["blocked_prompt", "t2"],
    ]);
    expect(guards[0]!.detail).toBe("i23: Do you want to proceed?");
  });

  test("a finished run's dialog does not block", () => {
    tx(db, () => db.query("UPDATE runs SET liveness = 'blocked_dialog', state = 'failed' WHERE id = 'r1'").run());
    expect(restartGuards(db, NO_WORK, Date.now())).toEqual([]);
  });

  test("validation: a live validation lease blocks; a released one or another pool does not", () => {
    tx(db, () => {
      db.query("INSERT INTO pool_leases (pool, run_id, stage, granted_at) VALUES ('validation', 'r1', 'ship', ?1)").run(Date.now() - 60_000);
      db.query("INSERT INTO pool_leases (pool, run_id, stage, granted_at, released_at) VALUES ('validation', 'r2', 'ship', 1, 2)").run();
      db.query("INSERT INTO pool_leases (pool, run_id, stage, granted_at) VALUES ('worker', 'r2', 'build', 1)").run();
    });
    expect(restartGuards(db, NO_WORK, Date.now()).map((g) => [g.kind, g.task])).toEqual([["validation", "t1"]]);
  });

  test("in-memory work: a cleanup, a launch and an approval challenge", () => {
    const guards = restartGuards(db, { ...NO_WORK, cleanups: ["r1"], launching: ["r2"], approvalTasks: ["t2"] }, Date.now());
    expect(guards.map((g) => [g.kind, g.task])).toEqual([
      ["cleanup", "t1"],
      ["launching", "t2"],
      ["approval", "t2"],
    ]);
  });
});

function ok(stdout: string): ProcResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

describe("binary check", () => {
  const good = ok(JSON.stringify({ ok: true, data: { flowryn: "0.6.0", proto: 5 } }));

  test("commandOf strips the trailing daemon run", () => {
    expect(commandOf(["/d/flowryn", "daemon", "run"])).toEqual(["/d/flowryn"]);
    expect(commandOf(["bun", "/s/main.ts", "daemon", "run"])).toEqual(["bun", "/s/main.ts"]);
    expect(commandOf(["/d/flowryn"])).toEqual(["/d/flowryn"]);
  });

  test("buildIdOf hashes a compiled binary and has none for a development command", () => {
    const bin = join(dir, "flowryn");
    writeFileSync(bin, "one");
    const first = buildIdOf([bin]);
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    writeFileSync(bin, "two");
    expect(buildIdOf([bin])).not.toBe(first);
    expect(buildIdOf(["bun", bin])).toBeNull();
  });

  test("a sound target answers its version and protocol", async () => {
    const calls: string[][] = [];
    const result = await smokeCheck(["bun", join(dir, "flowryn.db")], { FLOWRYN_TOKEN: "secret", PATH: "/bin" }, async (argv, env) => {
      calls.push(argv);
      expect(env.FLOWRYN_TOKEN).toBeUndefined();
      return good;
    });
    expect(result).toEqual({ version: "0.6.0", proto: 5, build: null });
    expect(calls).toEqual([["bun", join(dir, "flowryn.db"), "version", "--json"]]);
  });

  for (const [name, reply, why] of [
    ["exits non-zero", { exitCode: 1, stdout: "", stderr: "Killed: 9\n", timedOut: false }, "version exited 1: Killed: 9"],
    ["prints no JSON", ok("flowryn 0.6.0"), "did not print JSON"],
    ["has no protocol", ok(JSON.stringify({ ok: true, data: { flowryn: "0.6.0" } })), "no version or protocol"],
    ["hangs", { exitCode: null, stdout: "", stderr: "", timedOut: true }, "did not answer within 10 s"],
  ] as const) {
    test(`a target that ${name} is refused as binary_broken`, async () => {
      const error = await smokeCheck(["bun", join(dir, "flowryn.db")], {}, async () => reply).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FlowrynError);
      expect((error as FlowrynError).code).toBe("binary_broken");
      expect((error as FlowrynError).message).toContain(why);
    });
  }

  test("a missing target is refused without running it", async () => {
    let ran = false;
    const error = await smokeCheck([join(dir, "nope")], {}, async () => {
      ran = true;
      return good;
    }).catch((e: unknown) => e);
    expect((error as FlowrynError).code).toBe("binary_broken");
    expect(ran).toBe(false);
  });

  test("assumption: the real binary answers version --json with a version and a protocol", async () => {
    const result = await smokeCheck(["bun", join(import.meta.dir, "../../src/main.ts")], process.env);
    expect(result.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Number.isInteger(result.proto)).toBe(true);
  });
});

function fakeSupervisor(opts: { supervised?: string | null; program?: string[]; restart?: { ok: boolean; detail: string } } = {}) {
  const calls = { restart: 0 };
  const supervisor: Supervisor = {
    name: "fake",
    supervised: async () => opts.supervised ?? null,
    target: async () => ({ program: opts.program ?? ["/d/flowryn", "daemon", "run"] }),
    restart: async () => {
      calls.restart++;
      return opts.restart ?? { ok: true, detail: "" };
    },
  };
  return { supervisor, calls };
}

function controller(opts: { supervisor?: Supervisor; build?: string | null; targetBuild?: string | null; smokeFails?: boolean; work?: InMemoryWork; now?: () => number } = {}) {
  const supervisor = opts.supervisor ?? fakeSupervisor().supervisor;
  return new RestartController({
    db,
    env: {},
    now: opts.now ?? Date.now,
    log: () => {},
    info: () => info(opts.build === undefined ? "aaaaaaaaaaaa" : opts.build),
    work: () => opts.work ?? NO_WORK,
    supervisor: () => supervisor,
    smoke: async (command) => {
      if (opts.smokeFails) throw new FlowrynError("binary_broken", `${command.join(" ")} failed its smoke check`);
      return { version: "0.5.0", proto: 4, build: opts.targetBuild === undefined ? "bbbbbbbbbbbb" : opts.targetBuild };
    },
  });
}

function events(kind: string): Record<string, unknown>[] {
  return (db.query("SELECT payload FROM events WHERE kind = ?1 ORDER BY seq").all(kind) as { payload: string }[]).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
}

function openItemsOf(kind: string): { line: string }[] {
  return db.query("SELECT line FROM items WHERE kind = ?1 AND state IN ('open','presented')").all(kind) as { line: string }[];
}

const BASE = { whenIdle: false, waitMin: 30, force: false, cancel: false };

describe("restart controller", () => {
  test("all clear: hands off to the new daemon with who asked, and kicks the supervisor once", async () => {
    const fake = fakeSupervisor();
    const c = controller({ supervisor: fake.supervisor });
    const preflight = await c.preflight(false);
    expect(preflight.target).toMatchObject({ build: "bbbbbbbbbbbb", program: ["/d/flowryn", "daemon", "run"] });
    const outcome = tx(db, () => c.request(LEADER, { ...BASE, preflight }));
    expect(outcome).toMatchObject({ restart: "restarting", supervisor: "fake", old: { pid: 4411, build: "aaaaaaaaaaaa", uptime_s: 90 } });
    expect(events("daemon.restart_requested")[0]).toMatchObject({ by: "leader", session: "L3", when_idle: false });
    expect(JSON.parse(getMeta(db, "restart_handoff")!)).toMatchObject({ by: "leader", session: "L3", old: { pid: 4411 } });
    c.kick();
    c.kick();
    await Bun.sleep(120);
    expect(fake.calls.restart).toBe(1);
    expect(c.inProgress).toBe(true);
    await expect(c.preflight(false)).rejects.toMatchObject({ code: "restart_in_progress" });
  });

  test("not supervised: refused with the reason, nothing recorded", async () => {
    const c = controller({ supervisor: fakeSupervisor({ supervised: "started by hand" }).supervisor });
    await expect(c.preflight(false)).rejects.toMatchObject({ code: "not_supervised" });
  });

  test("no_change when the target is the build already running; --force restarts anyway", async () => {
    const c = controller({ targetBuild: "aaaaaaaaaaaa" });
    await expect(c.preflight(false)).rejects.toMatchObject({ code: "no_change" });
    expect((await c.preflight(true)).target.build).toBe("aaaaaaaaaaaa");
    // A development command has no build id, so it never counts as unchanged.
    expect((await controller({ targetBuild: null, build: null }).preflight(false)).target.build).toBeNull();
  });

  test("a broken binary is refused before anything is recorded", async () => {
    await expect(controller({ smokeFails: true }).preflight(false)).rejects.toMatchObject({ code: "binary_broken" });
    expect(getMeta(db, "restart_handoff")).toBeNull();
  });

  test("blocked: refused with every guard named", () => {
    seedMerge("t1", "requested");
    const c = controller({ work: { ...NO_WORK, launching: ["r2"] } });
    let error: unknown;
    try {
      tx(db, () => c.request(LEADER, { ...BASE, preflight: null }));
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ code: "restart_blocked" });
    expect((error as Error).message).toContain("2 things");
    expect((error as Error).message).toContain("merging: t1");
    expect((error as Error).message).toContain("launching: t2");
    expect(getMeta(db, "restart_handoff")).toBeNull();
  });

  test("--when-idle parks the request; a second keeps the first deadline; --cancel drops it", () => {
    seedMerge("t1", "requested");
    let now = 1_000_000;
    const c = controller({ now: () => now });
    const first = tx(db, () => c.request(LEADER, { ...BASE, whenIdle: true, waitMin: 10, preflight: null }));
    expect(first).toMatchObject({ restart: "pending", expires_at: 1_000_000 + 600_000, expires: localStamp(1_600_000) });
    expect(localStamp(new Date(2026, 9, 5, 14, 32).getTime())).toBe("2026-10-05 14:32");
    expect(first.restart === "pending" && first.waiting_on[0]).toContain("merging: t1");
    now += 60_000;
    tx(db, () => c.request({ role: "human", runId: null, taskId: null }, { ...BASE, whenIdle: true, waitMin: 200, preflight: null }));
    expect(readPending(db)).toMatchObject({ by: "human", expires_at: 1_600_000 });
    expect(tx(db, () => c.request(LEADER, { ...BASE, cancel: true, preflight: null }))).toEqual({ restart: "cancelled", had_pending: true });
    expect(readPending(db)).toBeNull();
    expect(events("daemon.restart_cancelled")).toEqual([{ by: "leader", session: "L3", had_pending: true }]);
  });

  test("cooldown: a second restart within a minute of the last is refused", () => {
    tx(db, () => appendEvent(db, { source: "daemon", kind: "daemon.restarted", payload: {}, ts: Date.now() - 10_000 }));
    expect(() => tx(db, () => controller().request(LEADER, { ...BASE, preflight: null }))).toThrow(/restarted 10 s ago/);
  });

  test("cooldown: a restart longer ago than the cooldown does not block", () => {
    tx(db, () => appendEvent(db, { source: "daemon", kind: "daemon.restarted", payload: {}, ts: Date.now() - RESTART_COOLDOWN_MS - 1_000 }));
    expect(() => tx(db, () => controller().request(LEADER, { ...BASE, preflight: null }))).toThrow(/cleared a moment ago/);
  });

  test("pending: restarts once the guards clear, with the original requester", async () => {
    seedMerge("t1", "requested");
    const fake = fakeSupervisor();
    const c = controller({ supervisor: fake.supervisor });
    tx(db, () => c.request(LEADER, { ...BASE, whenIdle: true, preflight: null }));
    await c.tryPending();
    expect(fake.calls.restart).toBe(0);
    expect(readPending(db)).not.toBeNull();
    tx(db, () => db.query("UPDATE merges SET state = 'merged' WHERE id = 'm-t1'").run());
    await c.tryPending();
    await Bun.sleep(120);
    expect(fake.calls.restart).toBe(1);
    expect(readPending(db)).toBeNull();
    expect(JSON.parse(getMeta(db, "restart_handoff")!)).toMatchObject({ by: "leader", session: "L3" });
  });

  test("pending: a broken binary at the moment the guards clear drops it with a P1", async () => {
    seedMerge("t1", "requested");
    const fake = fakeSupervisor();
    const c = controller({ supervisor: fake.supervisor, smokeFails: true });
    tx(db, () => c.request(LEADER, { ...BASE, whenIdle: true, preflight: null }));
    tx(db, () => db.query("UPDATE merges SET state = 'merged' WHERE id = 'm-t1'").run());
    await c.tryPending();
    expect(fake.calls.restart).toBe(0);
    expect(readPending(db)).toBeNull();
    expect(openItemsOf("restart_dropped")[0]!.line).toContain("failed its smoke check");
  });

  test("pending: expires after its wait with a P1 naming what it waited on", async () => {
    seedMerge("t1", "requested");
    let now = Date.now();
    const c = controller({ now: () => now });
    tx(db, () => c.request(LEADER, { ...BASE, whenIdle: true, waitMin: 5, preflight: null }));
    now += 5 * 60_000;
    await c.tryPending();
    expect(readPending(db)).toBeNull();
    expect(events("daemon.restart_expired")[0]!.reason).toContain("merging: t1");
    expect(openItemsOf("restart_dropped")).toHaveLength(1);
  });

  test("a supervisor that refuses withdraws the handoff and opens a P1", async () => {
    const fake = fakeSupervisor({ restart: { ok: false, detail: "Could not find service" } });
    const c = controller({ supervisor: fake.supervisor });
    const preflight = await c.preflight(false);
    tx(db, () => c.request(LEADER, { ...BASE, preflight }));
    c.kick();
    await Bun.sleep(150);
    expect(getMeta(db, "restart_handoff")).toBeNull();
    expect(c.inProgress).toBe(false);
    expect(openItemsOf("restart_dropped")[0]!.line).toContain("Could not find service");
  });
});

describe("the new daemon's record", () => {
  test("recordRestarted writes daemon.restarted once, with who asked and both builds, and closes a dropped-restart P1", async () => {
    const c = controller({ supervisor: fakeSupervisor({ restart: { ok: false, detail: "first try failed" } }).supervisor });
    const preflight = await c.preflight(false);
    tx(db, () => c.request(LEADER, { ...BASE, preflight }));
    c.kick();
    await Bun.sleep(150);
    expect(openItemsOf("restart_dropped")).toHaveLength(1);
    const c2 = controller();
    tx(db, () => c2.request(LEADER, { ...BASE, preflight }));
    const payload = tx(db, () => recordRestarted(db, { pid: 9120, version: "0.5.0", proto: 4, build: "bbbbbbbbbbbb" }, Date.now()));
    expect(payload).toMatchObject({ by: "leader", session: "L3", old: { pid: 4411, build: "aaaaaaaaaaaa" }, new: { pid: 9120, build: "bbbbbbbbbbbb" } });
    expect(events("daemon.restarted")).toHaveLength(1);
    expect(openItemsOf("restart_dropped")).toHaveLength(0);
    expect(tx(db, () => recordRestarted(db, { pid: 9121, version: "0.5.0", proto: 4, build: null }, Date.now()))).toBeNull();
  });

  test("no handoff (a crash restart or a manual start): nothing recorded", () => {
    expect(tx(db, () => recordRestarted(db, { pid: 1, version: "0.5.0", proto: 4, build: null }, Date.now()))).toBeNull();
    expect(events("daemon.restarted")).toHaveLength(0);
  });

  test("the briefing shows a restart once: after the briefing that marks it, it is gone", () => {
    tx(db, () =>
      appendEvent(db, {
        source: "daemon",
        kind: "daemon.restarted",
        payload: { by: "leader", session: "L3", old: { pid: 1, version: "0.5.0", proto: 4, build: "3f9a1c22d0b1", uptime_s: 5 }, new: { pid: 2, version: "0.5.0", proto: 5, build: "a07e55c9e1f4" }, downtime_ms: 1800 },
      }),
    );
    const input = { session: null, now: Date.now() + 1, morningHour: 99, ageMs: 86_400_000, markMorning: true };
    const first = tx(db, () => composeBriefing(db, input)).text;
    expect(first).toMatch(/Daemon restarted \d\d:\d\d by the leader \(L3\): build 3f9a1c22d0b1→a07e55c9e1f4, 0\.5\.0, proto 4→5\./);
    const second = tx(db, () => composeBriefing(db, { ...input, now: input.now + 1 })).text;
    expect(second).not.toContain("Daemon restarted");
  });
});

function scripted(print: { exitCode: number; output: string }): LaunchdDeps {
  return {
    launchctl: async (args) => (args[0] === "print" ? print : { exitCode: 0, output: "" }),
    sleep: async () => {},
    unloadTimeoutMs: 0,
    unloadPollMs: 1,
    bootstrapBackoffMs: [],
  };
}

describe("launchd supervisor", () => {
  const spec: PlistSpec = { label: "dev.flowryn.flowrynd.test", program: ["/d/flowryn", "daemon", "run"], env: { PATH: "/bin", HOME: "/h" }, logDir: "/l", workingDir: "/w" };

  test("agentPid reads the pid from launchctl print, and null when not running or not loaded", async () => {
    expect(await agentPid("x", scripted({ exitCode: 0, output: "\tstate = running\n\tpid = 6421\n\tlast exit code = 0" }))).toBe(6421);
    expect(await agentPid("x", scripted({ exitCode: 0, output: "\tstate = not running\n" }))).toBeNull();
    expect(await agentPid("x", scripted({ exitCode: 113, output: "Could not find service" }))).toBeNull();
  });

  test("assumption: launchctl print reports the running pid as `pid = N` (live, when this machine runs the agent)", async () => {
    if (process.platform !== "darwin") return;
    const live = await agentPid("dev.flowryn.flowrynd");
    if (live !== null) expect(Number.isInteger(live) && live > 0).toBe(true);
  });

  test("supervised only when this process is the agent's running pid", async () => {
    const plist = join(dir, "agent.plist");
    writeFileSync(plist, "");
    const mine = launchdSupervisor(spec, {}, scripted({ exitCode: 0, output: `pid = ${process.pid}` }), plist);
    expect(await mine.supervised()).toBeNull();
    const other = launchdSupervisor(spec, {}, scripted({ exitCode: 0, output: "pid = 1" }), plist);
    expect(await other.supervised()).toContain("runs pid 1, not this daemon");
    const missing = launchdSupervisor(spec, {}, scripted({ exitCode: 0, output: `pid = ${process.pid}` }), join(dir, "none.plist"));
    expect(await missing.supervised()).toContain("no launchd agent is installed");
  });

  test("plist drift: the program, an environment variable or the working directory", () => {
    const same = { program: [...spec.program], env: { ...spec.env }, workingDir: spec.workingDir };
    expect(plistDrift(same, spec)).toEqual([]);
    expect(plistDrift({ ...same, program: ["/old/flowryn", "daemon", "run"] }, spec)[0]).toContain("program /old/flowryn");
    expect(plistDrift({ ...same, env: { PATH: "/usr/bin", HOME: "/h" } }, spec)).toEqual(["PATH differs"]);
    expect(plistDrift({ ...same, env: { ...spec.env, FLOWRYN_HOME: "/f" } }, spec)).toEqual(["FLOWRYN_HOME differs"]);
    expect(plistDrift({ ...same, workingDir: "/x" }, spec)).toEqual(["WorkingDirectory differs"]);
  });

  test("target reads the installed plist through plutil and refuses a stale one", async () => {
    if (process.platform !== "darwin") return;
    const plist = join(dir, "agent.plist");
    const { renderPlist } = await import("../../src/service/launchd.ts");
    writeFileSync(plist, renderPlist(spec));
    const deps = scripted({ exitCode: 0, output: "" });
    expect(await launchdSupervisor(spec, {}, deps, plist).target()).toEqual({ program: spec.program });
    const stale = await launchdSupervisor({ ...spec, program: ["/new/flowryn", "daemon", "run"] }, {}, deps, plist).target();
    expect("refusal" in stale && stale.refusal.code).toBe("plist_drift");
  });

  test("assumption: a detached helper outlives a SIGTERM to its parent's process group", async () => {
    // kickstart -k stops the daemon (and launchd may signal its process group); the helper runs in its own group.
    const marker = join(dir, "helper-done");
    const helper = join(dir, "helper.sh");
    writeFileSync(helper, `#!/bin/sh\nsleep 0.3\ntouch ${JSON.stringify(marker)}\n`);
    chmodSync(helper, 0o755);
    // The parent leads its own process group, as launchd's job does; the signal goes to that whole group.
    const parent = spawn("bun", ["-e", `const { detached } = await import(${JSON.stringify(join(import.meta.dir, "../../src/daemon/restart.ts"))}); void detached(${JSON.stringify(helper)}, [], process.env); setTimeout(() => {}, 5000);`], {
      detached: true,
      stdio: "ignore",
    });
    const exited = new Promise((resolve) => parent.on("exit", resolve));
    await Bun.sleep(150);
    process.kill(-parent.pid!, "SIGTERM");
    await exited;
    await Bun.sleep(500);
    expect(Bun.file(marker).size).toBe(0);
    expect(await Bun.file(marker).exists()).toBe(true);
  });
});
