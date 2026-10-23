import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findOpenItem } from "../../src/attention/items.ts";
import { recordRestartFailure } from "../../src/daemon/restart.ts";
import { migrate, openDb, tx } from "../../src/db/db.ts";
import { type LaunchctlResult, type LaunchdDeps, type PlistSpec, relaunchCommand } from "../../src/service/launchd.ts";
import { waitForRestart } from "../../src/cli/commands/daemon.ts";
import type { Reply } from "../../src/api/envelope.ts";
import { RELAUNCH_ANSWER_MS, RELAUNCH_BOOTSTRAP_BACKOFF_MS, RELAUNCH_BOUND_MS, RELAUNCH_POLL_MS, RELAUNCH_UNLOAD_TIMEOUT_MS, type RelaunchDeps, launchdState, relaunch } from "../../src/service/relaunch.ts";
import { RECOVERY_COMMAND, type RestartFailure, clearRestartFailure, failureLine, readRestartFailure, writeRestartFailure } from "../../src/service/restart-failure.ts";

const LABEL = "dev.flowryn.flowrynd.test";
const PLIST = "/tmp/dev.flowryn.flowrynd.test.plist";
const OLD_PID = 4100;
const NEW_PID = 4200;
const IO_ERROR: LaunchctlResult = { exitCode: 5, output: "Bootstrap failed: 5: Input/output error" };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type AgentState = "running-old" | "unloaded" | "running-new" | "spawn-scheduled";

/**
 * A scripted launchd and socket. The agent runs the old daemon; bootout stops
 * it; bootstrap answers from `bootstrapReplies` and then, when it loads,
 * leaves the agent in `afterBootstrap`; kickstart moves it to `afterKickstart`.
 * The probe answers the pid of whichever daemon runs. Time is the sum of the
 * sleeps, so the waits are exact.
 */
function scripted(opts: { bootoutStops?: boolean; bootstrapReplies?: LaunchctlResult[]; afterBootstrap?: AgentState; afterKickstart?: AgentState }) {
  let state: AgentState = "running-old";
  let clock = 0;
  const calls: string[] = [];
  const replies = [...(opts.bootstrapReplies ?? [])];
  const failures: RestartFailure[] = [];
  const notes: string[] = [];
  const launchd: LaunchdDeps = {
    async launchctl(args) {
      const verb = args[0]!;
      calls.push(args.join(" "));
      if (verb === "print") {
        if (state === "unloaded") return { exitCode: 113, output: "Could not find service" };
        const pid = state === "running-old" ? `\tpid = ${OLD_PID}\n` : state === "running-new" ? `\tpid = ${NEW_PID}\n` : "";
        const shown = state === "spawn-scheduled" ? "spawn scheduled" : "running";
        return { exitCode: 0, output: `${LABEL} = {\n\tstate = ${shown}\n${pid}\truns = 1470\n\tlast exit code = 78: EX_CONFIG\n\tproperties = managed LWCR | has LWCR | needs LWCR update\n\t\tstate = active\n}` };
      }
      if (verb === "bootout") {
        if (opts.bootoutStops !== false) state = "unloaded";
        return opts.bootoutStops === false ? { exitCode: 5, output: "Boot-out failed: 5: Input/output error" } : { exitCode: 0, output: "" };
      }
      if (verb === "bootstrap") {
        const reply = replies.shift() ?? (state === "unloaded" ? { exitCode: 0, output: "" } : IO_ERROR);
        if (reply.exitCode === 0) state = opts.afterBootstrap ?? "running-new";
        return reply;
      }
      if (verb === "kickstart") {
        if (opts.afterKickstart) state = opts.afterKickstart;
        return { exitCode: 0, output: "" };
      }
      throw new Error(`unexpected launchctl ${args.join(" ")}`);
    },
    async sleep(ms) {
      clock += ms;
    },
    unloadTimeoutMs: 1_000,
    unloadPollMs: 100,
    bootstrapBackoffMs: [250, 500],
  };
  const deps: RelaunchDeps = {
    launchd,
    probe: async () => (state === "running-old" ? OLD_PID : state === "running-new" ? NEW_PID : null),
    now: () => clock,
    log: () => {},
    notify: async (title, body) => {
      notes.push(`${title}: ${body}`);
    },
    recordFailure: (failure) => failures.push(failure),
    clearFailure: () => failures.splice(0),
    answerWaitMs: 3_000,
    pollMs: 250,
  };
  return { deps, calls, failures, notes, state: () => state, clock: () => clock };
}

const plan = { label: LABEL, plist: PLIST, oldPid: OLD_PID };

describe("the restart's relaunch helper", () => {
  test("assumption: a restart re-bootstraps the agent (bootout, then bootstrap), never kickstart -k", async () => {
    const fake = scripted({});
    const outcome = await relaunch(plan, fake.deps);
    expect(outcome).toMatchObject({ ok: true, pid: NEW_PID, via: "bootstrap" });
    const verbs = fake.calls.map((c) => c.split(" ")[0]);
    expect(verbs.indexOf("bootout")).toBeLessThan(verbs.indexOf("bootstrap"));
    expect(fake.calls.some((c) => c.startsWith("kickstart"))).toBe(false);
    expect(fake.calls).toContain(`bootstrap gui/${process.getuid!()} ${PLIST}`);
    expect(fake.failures).toEqual([]);
  });

  test("when the first bootstrap never loads the agent, the fallback bootstraps it again", async () => {
    const fake = scripted({ bootstrapReplies: [IO_ERROR, IO_ERROR, IO_ERROR] });
    const outcome = await relaunch(plan, fake.deps);
    expect(outcome).toMatchObject({ ok: true, pid: NEW_PID, via: "fallback" });
    expect(outcome.steps[0]).toContain("failed after 3 attempts");
    expect(outcome.steps.some((s) => s.startsWith("fallback bootstrap: loaded"))).toBe(true);
  });

  test("an agent loaded but stuck at spawn scheduled gets a kickstart as the fallback", async () => {
    const fake = scripted({ afterBootstrap: "spawn-scheduled", afterKickstart: "running-new" });
    const outcome = await relaunch(plan, fake.deps);
    expect(outcome).toMatchObject({ ok: true, via: "fallback" });
    expect(fake.calls).toContain(`kickstart gui/${process.getuid!()}/${LABEL}`);
    expect(fake.calls.some((c) => c.startsWith("kickstart -k"))).toBe(false);
  });

  test("assumption: a restart that cannot bring the daemon up within its bound leaves a failure record and a notification naming what to run", async () => {
    const fake = scripted({ afterBootstrap: "spawn-scheduled" });
    const outcome = await relaunch(plan, fake.deps);
    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ oldStillUp: false });
    expect(fake.failures).toHaveLength(1);
    const failure = fake.failures[0]!;
    expect(failure.run).toBe(RECOVERY_COMMAND);
    expect(failure.launchd).toContain("state = spawn scheduled");
    expect(failure.launchd).toContain("last exit code = 78: EX_CONFIG");
    expect(failureLine(failure)).toContain("run flowryn daemon install in your terminal");
    expect(fake.notes).toEqual(["Flowryn daemon is down: A restart did not bring it back. Run flowryn daemon install in your terminal."]);
    // Bounded: the unload wait, the bootstrap, then two answer waits; no endless retry.
    expect(fake.clock()).toBeLessThanOrEqual(fake.deps.launchd.unloadTimeoutMs + 2 * (fake.deps.answerWaitMs + fake.deps.pollMs) + 1_000);
  });

  test("a bootout that stopped nothing leaves the old daemon answering: no failure record, the old daemon takes its handoff back", async () => {
    const fake = scripted({ bootoutStops: false });
    const outcome = await relaunch(plan, fake.deps);
    expect(outcome).toMatchObject({ ok: false, oldStillUp: true });
    expect(fake.failures).toEqual([]);
    expect(fake.notes).toEqual([]);
    expect(fake.state()).toBe("running-old");
  });

  test("a daemon that comes up just after the failure record is written clears it: no notification, the restart succeeded", async () => {
    const fake = scripted({ afterBootstrap: "spawn-scheduled" });
    let late = false;
    const outcome = await relaunch(plan, {
      ...fake.deps,
      recordFailure: (failure) => {
        fake.deps.recordFailure(failure);
        late = true;
      },
      probe: async () => (late ? NEW_PID : fake.deps.probe()),
    });
    expect(outcome).toMatchObject({ ok: true, pid: NEW_PID, via: "fallback" });
    expect(fake.failures).toEqual([]);
    expect(fake.notes).toEqual([]);
  });

  test("a notifier or a record that fails never makes the helper throw", async () => {
    const fake = scripted({ afterBootstrap: "spawn-scheduled" });
    const outcome = await relaunch(plan, {
      ...fake.deps,
      notify: async () => {
        throw new Error("osascript exited 1");
      },
      recordFailure: () => {
        throw new Error("read-only");
      },
    });
    expect(outcome.ok).toBe(false);
  });

  test("launchdState keeps the state lines of launchctl print", async () => {
    const fake = scripted({ afterBootstrap: "spawn-scheduled" });
    expect(await launchdState(LABEL, fake.deps.launchd)).toEqual({
      loaded: true,
      summary: `state = running, pid = ${OLD_PID}, runs = 1470, last exit code = 78: EX_CONFIG, properties = managed LWCR | has LWCR | needs LWCR update`,
    });
    await fake.deps.launchd.launchctl(["bootout", "x"]);
    expect(await launchdState(LABEL, fake.deps.launchd)).toEqual({ loaded: false, summary: "not loaded" });
  });

  test("the supervisor's helper is the installed binary's daemon relaunch, with the old pid", () => {
    const spec: PlistSpec = { label: LABEL, program: ["/d/flowryn", "daemon", "run"], env: {}, logDir: "/l", workingDir: "/w" };
    expect(relaunchCommand(spec, PLIST, 77)).toEqual(["/d/flowryn", "daemon", "relaunch", "--old-pid", "77"]);
    expect(relaunchCommand({ ...spec, program: ["/b/bun", "/s/main.ts", "daemon", "run"] }, PLIST, 77)).toEqual(["/b/bun", "/s/main.ts", "daemon", "relaunch", "--old-pid", "77"]);
  });
});

describe("daemon restart's wait", () => {
  function withRealBounds(fake: ReturnType<typeof scripted>): RelaunchDeps {
    return { ...fake.deps, launchd: { ...fake.deps.launchd, unloadTimeoutMs: RELAUNCH_UNLOAD_TIMEOUT_MS, bootstrapBackoffMs: RELAUNCH_BOOTSTRAP_BACKOFF_MS }, answerWaitMs: RELAUNCH_ANSWER_MS, pollMs: RELAUNCH_POLL_MS };
  }

  test("outlasts the helper's slowest outcomes: a bootout that stopped nothing, and every bootstrap failing", async () => {
    const stuck = scripted({ bootoutStops: false });
    expect(await relaunch(plan, withRealBounds(stuck))).toMatchObject({ ok: false, oldStillUp: true });
    expect(stuck.clock()).toBeLessThan(RELAUNCH_BOUND_MS);
    const failing = scripted({ bootstrapReplies: Array.from({ length: 12 }, () => IO_ERROR) });
    expect(await relaunch(plan, withRealBounds(failing))).toMatchObject({ ok: false, oldStillUp: false });
    expect(failing.failures).toHaveLength(1);
    expect(failing.clock()).toBeLessThan(RELAUNCH_BOUND_MS);
  });

  const answer = (data: Record<string, unknown>): Reply => ({ ok: true, data }) as unknown as Reply;
  const failure = (at: number): RestartFailure => ({ at, label: LABEL, old_pid: OLD_PID, steps: ["still no daemon after the fallback (30 s)"], launchd: "not loaded", run: RECOVERY_COMMAND });

  test("stops as soon as the helper leaves a failure record newer than the request", async () => {
    const started = Date.now();
    let record: RestartFailure | null = null;
    setTimeout(() => (record = failure(Date.now())), 50);
    const waited = await waitForRestart(OLD_PID, started, { ping: async () => null, readFailure: () => record, timeoutMs: 10_000, pollMs: 10 });
    expect(waited).toMatchObject({ outcome: "failed", failure: { run: RECOVERY_COMMAND } });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("reports the new daemon when one answers just as the failure record appears", async () => {
    const started = Date.now();
    let pings = 0;
    const waited = await waitForRestart(OLD_PID, started, { ping: async () => (++pings > 1 ? answer({ pid: NEW_PID }) : null), readFailure: () => failure(Date.now()), timeoutMs: 10_000, pollMs: 10 });
    expect(waited.outcome).toBe("fresh");
  });

  test("ignores a failure record from an earlier restart and reports a new daemon", async () => {
    const started = Date.now();
    let pid = OLD_PID;
    setTimeout(() => (pid = NEW_PID), 50);
    const waited = await waitForRestart(OLD_PID, started, { ping: async () => answer({ pid, restart_handoff: true }), readFailure: () => failure(started - 60_000), timeoutMs: 10_000, pollMs: 10 });
    expect(waited.outcome).toBe("fresh");
    expect(waited.outcome === "fresh" && (waited.reply.data as { pid: number }).pid).toBe(NEW_PID);
  });

  test("reports a dropped restart when the old daemon withdraws its handoff, and times out when nothing happens", async () => {
    const started = Date.now();
    const dropped = await waitForRestart(OLD_PID, started, { ping: async () => answer({ pid: OLD_PID, restart_handoff: false, restart_dropped: { reason: "the old daemon (pid 4100) still answers", ts: started } }), readFailure: () => null, timeoutMs: 10_000, pollMs: 10 });
    expect(dropped).toEqual({ outcome: "dropped", reason: "the old daemon (pid 4100) still answers" });
    expect(await waitForRestart(OLD_PID, Date.now(), { ping: async () => null, readFailure: () => null, timeoutMs: 100, pollMs: 10 })).toEqual({ outcome: "timeout" });
  });
});

describe("the restart failure record", () => {
  const failure: RestartFailure = { at: Date.UTC(2026, 9, 23, 14, 23), label: LABEL, old_pid: OLD_PID, steps: ["bootout and bootstrap: loaded", "no new daemon answered within 30 s"], launchd: "state = spawn scheduled", run: RECOVERY_COMMAND };

  test("written, read back and cleared in the state directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "fw-relaunch-"));
    dirs.push(dir);
    expect(readRestartFailure(dir)).toBeNull();
    writeRestartFailure(dir, failure);
    expect(readRestartFailure(dir)).toEqual(failure);
    clearRestartFailure(dir);
    expect(existsSync(join(dir, "restart-failed.json"))).toBe(false);
  });

  test("the next daemon opens one restart_failed P1 that names what to run", () => {
    const dir = mkdtempSync(join(tmpdir(), "fw-relaunch-"));
    dirs.push(dir);
    const db = openDb(join(dir, "flowryn.db"));
    try {
      migrate(db);
      tx(db, () => recordRestartFailure(db, failure, failure.at + 120_000));
      tx(db, () => recordRestartFailure(db, failure, failure.at + 180_000));
      const items = db.query("SELECT lane, line FROM items WHERE kind = 'restart_failed'").all() as { lane: string; line: string }[];
      expect(items).toHaveLength(1);
      expect(items[0]!.lane).toBe("P1");
      expect(items[0]!.line).toContain("flowryn daemon install");
      expect(findOpenItem(db, "restart_failed", null)).not.toBeNull();
      const event = db.query("SELECT payload FROM events WHERE kind = 'daemon.restart_failed' ORDER BY seq LIMIT 1").get() as { payload: string };
      expect((JSON.parse(event.payload) as { downtime_ms: number }).downtime_ms).toBe(120_000);
    } finally {
      db.close();
    }
  });
});
