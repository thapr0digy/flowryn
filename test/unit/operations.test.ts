import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashToken, mintToken } from "../../src/api/auth.ts";
import type { Envelope, Reply } from "../../src/api/envelope.ts";
import { Gateway } from "../../src/api/gateway.ts";
import type { DaemonServices } from "../../src/api/verbs.ts";
import { inertAttention } from "../../src/attention/services.ts";
import { defaultConfig, parseConfig } from "../../src/config/config.ts";
import { DEFAULT_TIMING } from "../../src/config/workers.ts";
import { inertRestart } from "../../src/daemon/restart.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import type { Verified } from "../../src/harness/types.ts";
import { Journal } from "../../src/journal/journal.ts";
import { BacklogWatcher } from "../../src/journal/watcher.ts";
import { inertLavish } from "../../src/lavish/services.ts";
import { inertFleet } from "../../src/lifecycle/fleet-services.ts";
import { launchable } from "../../src/lifecycle/launcher.ts";
import { LEADER_RUN_VERBS } from "../../src/lifecycle/leader-verbs.ts";
import { Operations } from "../../src/lifecycle/operation-recovery.ts";
import { claimOperation, getOperation, openOperation, requestOperation, type OperationRow } from "../../src/lifecycle/operations.ts";
import { getRun } from "../../src/lifecycle/runs.ts";
import type { SteerBus } from "../../src/lifecycle/steers.ts";
import { inertDelivery } from "../../src/policy/services.ts";
import { Reconciler } from "../../src/reconcile/reconciler.ts";
import { HerdrError } from "../../src/runtime/herdr/client.ts";
import type { HerdrRuntime, PaneProcesses } from "../../src/runtime/herdr/runtime.ts";
import { inertSched } from "../../src/sched/services.ts";
import { ulid } from "../../src/util/ulid.ts";
import { PROTO } from "../../src/version.ts";

/**
 * Durable lifecycle operations (docs/notes/2026-10-13-next-steps-md-rz.md).
 * A "daemon" here is one Gateway, Operations and Reconciler over the scratch
 * database. A daemon that dies at a boundary is one whose fake is parked on a
 * barrier that never opens; the restart is a fresh set of instances over the
 * same database. No sleeps: every wait is a barrier or an awaited promise.
 */

const PID = 999_999;
const START = new Date(2026, 9, 13, 10, 0, 0).getTime();
const PS_LINE = (pid: number) => `${pid} Tue Oct 13 10:00:00 2026 claude\n`;

let dir: string;
let db: Db;
let leaderToken: string;
/** The worker's process, as the fake ps sees it. */
let workerAlive: boolean;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-ops-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  leaderToken = mintToken("leader");
  workerAlive = true;
  const now = Date.now();
  tx(db, () => {
    db.query("INSERT INTO leader_lease (id, epoch, token_hash) VALUES (1, 1, ?1)").run(hashToken(leaderToken));
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', 'u', ?1, 'main', 'local-only')").run(dir);
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES ('t1', 'web', 'scout', 'local-only', 0, 'scout', ?1)").run(now);
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, pane_id, agent_session, worktree_path, branch, base_sha,
         proc_pid, proc_start, proc_exe, token_hash, started_at, updated_at, worker_started_at, last_hook_at, idle_since, launched_at)
       VALUES ('r1', 't1', 'claude', '1', 'running', 'idle', 'scout', 'investigate', 'w:1', 'sess', ?1, 'b', 'abc', ?2, ?3, 'claude', 'h', ?4, ?4, ?4, ?4, ?4, ?4)`,
    ).run(dir, PID, START, now - 60_000);
  });
});

afterEach(() => {
  for (const r of reconcilers.splice(0)) r.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const reconcilers: Reconciler[] = [];

/** A barrier: `reached` once something is parked on it, `open()` lets it through. Never opened, it is a daemon that died there. */
function barrier() {
  let open!: () => void;
  let reached!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const held = new Promise<void>((resolve) => (reached = resolve));
  return {
    reached: held,
    open,
    hold<T>(value: () => T): Promise<T> {
      reached();
      return opened.then(value);
    },
  };
}

interface DaemonOptions {
  /** The cancel's stop. Default: the worker exits at once. */
  exitRun?(runId: string): Promise<Verified>;
  processes?(paneId: string): Promise<PaneProcesses | null>;
  harnessGate?(): Promise<{ harness: "claude"; state: "verified"; version: string; revision: number }>;
  launching?: Set<string>;
  /** `flowryn resume`'s harness check passes: claude 1 is installed and has a passing contract. */
  verifiedHarness?: boolean;
  /** In place of the cancel's driver: a daemon that dies before its settle drives the operation. */
  driveCancel?(id: string): Promise<never>;
}

interface Daemon {
  gateway: Gateway;
  ops: Operations;
  reconciler: Reconciler;
  exits: string[];
  launches: string[];
  cancelled: string[];
}

/** The fake ps: the worker's line while it is alive, and any other pid asked about as alive. */
function ps(pids: number[]): Promise<string> {
  return Promise.resolve(pids.includes(PID) && workerAlive ? PS_LINE(PID) : pids.filter((p) => p !== PID).map((p) => PS_LINE(p)).join(""));
}

/** One daemon life over the shared database. */
function daemon(options: DaemonOptions = {}): Daemon {
  const exits: string[] = [];
  const launches: string[] = [];
  const cancelled: string[] = [];
  const launching = options.launching ?? new Set<string>();
  const stop = (runId: string): Promise<Verified> => {
    exits.push(runId);
    if (options.exitRun) return options.exitRun(runId);
    workerAlive = false;
    return Promise.resolve({ ok: true, evidence: "process", detail: "SIGTERM" });
  };
  const runtime = {
    processes: options.processes ?? ((paneId: string) => Promise.resolve(workerAlive ? { paneId, shellPid: 1, foregroundGroup: PID, processes: [{ pid: PID, cwd: "", name: "claude", argv0: "claude" }] } : { paneId, shellPid: 1, foregroundGroup: 1, processes: [] })),
    snapshotPanes: () => Promise.resolve([]),
    agentStatus: () => Promise.resolve(null),
  } as unknown as HerdrRuntime;
  const ops = new Operations({
    db,
    runtime: () => runtime,
    timing: () => ({ ...DEFAULT_TIMING, launch_timeout_ms: 5_000 }),
    now: Date.now,
    log: () => {},
    exitRun: stop,
    cancelled: async (runId) => void cancelled.push(runId),
    matchesHarness: () => (p) => p.name === "claude",
    isLaunching: (runId) => launching.has(runId),
    ps,
  });
  const reconciler = new Reconciler({
    db,
    runtime: () => runtime,
    launch: (runId, mode, operation) => launches.push(`${runId}:${mode}:${operation ?? "-"}`),
    recoverOperation: (run, op) => ops.recover(run, op),
    isLaunching: (runId) => launching.has(runId),
    bus: { notify() {}, hasWaiter: () => false, forget() {} } as unknown as SteerBus,
    timing: () => DEFAULT_TIMING,
    log: () => {},
    now: Date.now,
    ps,
    ...(options.harnessGate ? { harnessGate: options.harnessGate } : {}),
  });
  reconcilers.push(reconciler);
  const config = options.verifiedHarness ? parseConfig('[tools]\nclaude = "/x/claude"\n', dir) : defaultConfig(dir);
  if (options.verifiedHarness) tx(db, () => db.query("INSERT OR IGNORE INTO harness_contracts (harness, version, passed_at) VALUES ('claude', '1', 1)").run());
  const files = () => ({ backlog: join(dir, "b.md"), todos: join(dir, "t.md") });
  const journal = new Journal({ db, files, runner: () => null });
  const info = () => ({ pid: 1, version: "t", proto: PROTO, instance: "i", startedAt: 0, execPath: "/bin/flowryn", socket: "/s", stateDir: dir });
  const services: DaemonServices = {
    db,
    config: () => config,
    journal,
    watcher: new BacklogWatcher({ db, journal, files, runner: () => null }),
    now: Date.now,
    log: () => {},
    info,
    requestShutdown: () => {},
    runTool: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    fleet: inertFleet({
      driveCancel: (id) => (options.driveCancel ? options.driveCancel(id) : ops.driveCancel(id)),
      exitRun: stop,
      ...(options.verifiedHarness ? { harnessVersion: async () => "1" } : {}),
      launch: (runId, mode, operation) => launches.push(`${runId}:${mode}:${operation ?? "-"}`),
    }),
    attention: inertAttention(),
    delivery: inertDelivery(),
    sched: inertSched(),
    restart: inertRestart(db, info),
    lavish: inertLavish(),
  };
  const verbs = new Map(LEADER_RUN_VERBS.map((v) => [v.name, v]));
  const gateway = new Gateway({ services, lookup: (v) => verbs.get(v) });
  return { gateway, ops, reconciler, exits, launches, cancelled };
}

function envelope(verb: string, args: Record<string, unknown>): Envelope {
  return { proto: PROTO, ulid: ulid(), verb, token: leaderToken, args };
}

function operationRows(): OperationRow[] {
  return db.query("SELECT * FROM operations WHERE run_id = 'r1' ORDER BY created_at, rowid").all() as OperationRow[];
}

function eventKinds(): string[] {
  return (db.query("SELECT kind FROM events WHERE run_id = 'r1' ORDER BY seq").all() as { kind: string }[]).map((r) => r.kind);
}

/** Make the run a dead worker with a session to resume: the reconciler would resume it once. */
function deadRun(): void {
  workerAlive = false;
  tx(db, () => db.query("UPDATE runs SET liveness = 'dead' WHERE id = 'r1'").run());
}

describe("cancel: the intent is committed before the worker is stopped", () => {
  test("crash between the cancel's commit and its stop: the restart stops the worker and cancels, never resumes", async () => {
    const parked = barrier();
    const first = daemon({ driveCancel: () => parked.hold(() => undefined as never) });
    const cancel = envelope("cancel", { target: "t1" });
    void first.gateway.handle(cancel);
    await parked.reached;
    // The first daemon dies here: the intent is committed, the stop never went out...
    expect(operationRows().map((o) => [o.kind, o.phase])).toEqual([["cancel", "requested"]]);
    expect(first.exits).toEqual([]);
    expect(getRun(db, "r1")!.state).toBe("running");
    // ...and the worker dies on its own meanwhile: without the operation, the next pass would resume it.
    workerAlive = false;

    const second = daemon();
    await second.reconciler.reconcileRun(getRun(db, "r1")!, "startup");
    await second.ops.driveCancel(cancel.ulid);
    expect(getRun(db, "r1")!.state).toBe("cancelled");
    expect(second.launches).toEqual([]);
    expect(eventKinds()).not.toContain("run.auto_resumed");
    expect(operationRows().map((o) => [o.id, o.kind, o.phase])).toEqual([[cancel.ulid, "cancel", "confirmed"]]);
    expect(second.cancelled).toEqual(["r1"]);
  });

  test("crash right after the worker's termination: the restart confirms the cancel; nothing resumes it", async () => {
    const parked = barrier();
    // The stop happens (the worker is gone), then the daemon dies before the cancel's commit.
    const first = daemon({
      exitRun: () => {
        workerAlive = false;
        return parked.hold(() => ({ ok: true, evidence: "process" }) as Verified);
      },
    });
    const cancel = envelope("cancel", { target: "t1" });
    void first.gateway.handle(cancel);
    await parked.reached;
    expect(workerAlive).toBe(false);
    expect(getRun(db, "r1")!.state).toBe("running");
    expect(getOperation(db, cancel.ulid)!.phase).toBe("effect_issued");

    const second = daemon();
    await second.reconciler.reconcileRun(getRun(db, "r1")!, "startup");
    await second.ops.driveCancel(cancel.ulid);
    const run = getRun(db, "r1")!;
    expect([run.state, run.liveness, run.resume_count]).toEqual(["cancelled", "dead", 0]);
    expect(second.launches).toEqual([]);
    expect(eventKinds()).not.toContain("run.auto_resumed");
    expect(getOperation(db, cancel.ulid)).toMatchObject({ phase: "confirmed", attempts: 2 });
  });

  test("a replay of the stored cancel after a restart finishes it, and a replay of a finished one stops nothing", async () => {
    const parked = barrier();
    const first = daemon({ driveCancel: () => parked.hold(() => undefined as never) });
    const cancel = envelope("cancel", { target: "t1" });
    void first.gateway.handle(cancel);
    await parked.reached;

    const second = daemon();
    const replay = await second.gateway.handle(cancel);
    expect(replay).toMatchObject({ ok: true, data: { run: "r1", state: "cancelled", operation: cancel.ulid } });
    expect(second.exits).toEqual(["r1"]);

    const third = daemon();
    expect(await third.gateway.handle(cancel)).toMatchObject({ ok: true, data: { state: "cancelled" } });
    expect(third.exits).toEqual([]);
    expect(operationRows()).toHaveLength(1);
  });

  test("the same cancel twice at once (one ULID): one operation, one stop, the same reply", async () => {
    const gate = barrier();
    const d = daemon({
      exitRun: () =>
        gate.hold(() => {
          workerAlive = false;
          return { ok: true, evidence: "process" } as Verified;
        }),
    });
    const cancel = envelope("cancel", { target: "t1" });
    const a = d.gateway.handle(cancel);
    const b = d.gateway.handle(cancel);
    await gate.reached;
    gate.open();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toMatchObject({ ok: true, data: { state: "cancelled" } });
    expect(rb).toEqual(ra);
    expect(d.exits).toEqual(["r1"]);
    expect(operationRows().map((o) => o.kind)).toEqual(["cancel"]);
  });

  test("two cancels at once (two ULIDs) coalesce on one operation: one stop", async () => {
    const gate = barrier();
    const d = daemon({
      exitRun: () =>
        gate.hold(() => {
          workerAlive = false;
          return { ok: true, evidence: "process" } as Verified;
        }),
    });
    const first = envelope("cancel", { target: "t1" });
    const a = d.gateway.handle(first);
    await gate.reached;
    const b = d.gateway.handle(envelope("cancel", { target: "t1" }));
    gate.open();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toMatchObject({ ok: true, data: { operation: first.ulid, state: "cancelled" } });
    expect(rb).toMatchObject({ ok: true, data: { operation: first.ulid, state: "cancelled" } });
    expect(d.exits).toEqual(["r1"]);
    expect(operationRows()).toHaveLength(1);
  });

  test("a stop that fails on a live request: the error as before, nothing cancelled, and its replay stops nothing", async () => {
    const d = daemon({ exitRun: async () => ({ ok: false, evidence: "timeout", detail: "SIGKILL" }) });
    const cancel = envelope("cancel", { target: "t1" });
    const reply = await d.gateway.handle(cancel);
    expect(reply).toMatchObject({ ok: false, error: { code: "internal" } });
    expect(reply.error!.message).toContain("did not exit (SIGKILL); nothing was cancelled");
    expect(getRun(db, "r1")!.state).toBe("running");
    expect(getOperation(db, cancel.ulid)).toMatchObject({ phase: "failed", detail: "SIGKILL" });
    const replay = await daemon().gateway.handle(cancel);
    expect(replay.error!.message).toBe(reply.error!.message);
    expect(d.exits).toEqual(["r1"]);
  });

  test("a stop that fails during recovery escalates: one P1; the worker is still watched, and its death is noticed but never resumed", async () => {
    tx(db, () => requestOperation(db, { id: ulid(), run: { id: "r1", task_id: "t1" }, kind: "cancel", requestedBy: "leader", reason: "x", source: "cli", now: Date.now() }));
    const d = daemon({ exitRun: async () => ({ ok: false, evidence: "timeout", detail: "SIGKILL" }) });
    const op = operationRows()[0]!;
    await d.reconciler.reconcileRun(getRun(db, "r1")!, "startup");
    expect(await d.ops.driveCancel(op.id)).toMatchObject({ ok: false, phase: "escalated" });
    expect(db.query("SELECT kind, state FROM items WHERE run_id = 'r1'").all()).toEqual([{ kind: "operation_escalated", state: "open" }]);
    // The worker then dies: the death is noticed (liveness, a P0 to resume or cancel), and nothing resumes it.
    workerAlive = false;
    expect(await d.reconciler.reconcileRun(getRun(db, "r1")!, "steady")).toBe("dead");
    const run = getRun(db, "r1")!;
    expect([run.liveness, run.resume_count, run.state]).toEqual(["dead", 0, "running"]);
    expect(d.launches).toEqual([]);
    expect(eventKinds()).not.toContain("run.auto_resumed");
    expect(db.query("SELECT kind FROM items WHERE run_id = 'r1' AND state = 'open' ORDER BY kind").all()).toEqual([{ kind: "failure_needs_you" }, { kind: "operation_escalated" }]);
    // A cancel now finds the worker gone and finishes.
    const again = await daemon().gateway.handle(envelope("cancel", { target: "t1" }));
    expect(again).toMatchObject({ ok: true, data: { state: "cancelled" } });
  });

  test("a replay that joins the reconciler's attempt is a waiting caller: a stop that fails fails the cancel, no P1", async () => {
    const parked = barrier();
    const first = daemon({ driveCancel: () => parked.hold(() => undefined as never) });
    const cancel = envelope("cancel", { target: "t1" });
    void first.gateway.handle(cancel);
    await parked.reached;
    // After the restart the reconciler starts the stop; the CLI's retry of the same call joins it.
    const stop = barrier();
    const second = daemon({ exitRun: () => stop.hold(() => ({ ok: false, evidence: "timeout", detail: "SIGKILL" }) as Verified) });
    await second.reconciler.reconcileRun(getRun(db, "r1")!, "startup");
    await stop.reached;
    const replay = second.gateway.handle(cancel);
    await Promise.resolve();
    stop.open();
    expect(await replay).toMatchObject({ ok: false, error: { code: "internal" } });
    expect(getOperation(db, cancel.ulid)!.phase).toBe("failed");
    expect(db.query("SELECT kind FROM items WHERE run_id = 'r1'").all()).toEqual([]);
    expect(second.exits).toEqual(["r1"]);
  });
});

describe("one open operation per run", () => {
  test("a cancel supersedes a resume still waiting, and a resume is refused while the cancel is open", async () => {
    deadRun();
    const d = daemon({ exitRun: () => new Promise<Verified>(() => {}) });
    // A resume waiting for its grant (the automatic one, deferred on an unverified harness).
    const resumeOp = tx(db, () => requestOperation(db, { run: { id: "r1", task_id: "t1" }, kind: "resume", mode: "resume", requestedBy: "reconciler", source: "reconciler", now: Date.now() })).id;
    void d.gateway.handle(envelope("cancel", { target: "t1" }));
    await Promise.resolve();
    expect(getOperation(db, resumeOp)).toMatchObject({ phase: "failed" });
    expect(getOperation(db, resumeOp)!.detail).toContain("superseded by cancel");
    const again = await d.gateway.handle(envelope("resume", { target: "t1" }));
    expect(again).toMatchObject({ ok: false, error: { code: "run_not_active" } });
    expect(operationRows().filter((o) => o.phase === "requested" || o.phase === "effect_issued").map((o) => o.kind)).toEqual(["cancel"]);
  });

  test("a resume is refused while a launch of another mode is requested: no second operation", async () => {
    deadRun();
    tx(db, () => requestOperation(db, { run: { id: "r1", task_id: "t1" }, kind: "launch", mode: "stage", requestedBy: "scheduler", source: "daemon", now: Date.now() }));
    const reply = await daemon().gateway.handle(envelope("resume", { target: "t1" }));
    expect(reply).toMatchObject({ ok: false, error: { code: "bad_args" } });
    expect(reply.error!.message).toContain("stage launch");
    expect(operationRows().map((o) => [o.kind, o.mode, o.phase])).toEqual([["launch", "stage", "requested"]]);
  });

  test("the database refuses a second open operation for a run", () => {
    tx(db, () => requestOperation(db, { run: { id: "r1", task_id: "t1" }, kind: "resume", mode: "resume", requestedBy: "leader", source: "cli", now: Date.now() }));
    expect(() => tx(db, () => requestOperation(db, { run: { id: "r1", task_id: "t1" }, kind: "cancel", requestedBy: "leader", source: "cli", now: Date.now() }))).toThrow();
    expect(operationRows()).toHaveLength(1);
  });

  test("the launcher's guard: only a requested launch or resume (the named one, when named) is started", () => {
    expect(launchable(opRow({}), undefined, "fresh")).toBe(true);
    expect(launchable(opRow({}), "o1", "fresh")).toBe(true);
    expect(launchable(opRow({}), "o2", "fresh")).toBe(false);
    expect(launchable(opRow({ phase: "effect_issued" }), "o1", "fresh")).toBe(false);
    expect(launchable(opRow({ kind: "cancel" }), undefined, "fresh")).toBe(false);
    // One mode per operation: a launch never runs under an operation opened for another mode.
    expect(launchable(opRow({ mode: "stage" }), "o1", "resume")).toBe(false);
    // A replay names an operation that is no longer open: nothing starts, and no new one is opened.
    expect(launchable(null, "o1", "fresh")).toBe(false);
    expect(launchable(null, undefined, "fresh")).toBe(true);
  });
});

/** A launch interrupted after agent.start: the run is launching with no identity, its operation issued at `issuedAt`. */
function issuedLaunch(issuedAt: number, mode: "fresh" | "resume" = "fresh"): OperationRow {
  return tx(db, () => {
    db.query("UPDATE runs SET state = 'launching', liveness = 'starting', proc_pid = NULL, proc_start = NULL, proc_exe = NULL, worker_started_at = NULL WHERE id = 'r1'").run();
    const op = requestOperation(db, { run: { id: "r1", task_id: "t1" }, kind: mode === "resume" ? "resume" : "launch", mode, requestedBy: "scheduler", source: "daemon", now: issuedAt });
    return claimOperation(db, op.id, { paneId: "w:1", agentName: "flowryn-x" }, "daemon", issuedAt)!;
  });
}

function harness(pid: number): (paneId: string) => Promise<PaneProcesses> {
  return (paneId: string) => Promise.resolve({ paneId, shellPid: 1, foregroundGroup: pid, processes: [{ pid, cwd: "", name: "claude", argv0: "claude" }] } as PaneProcesses);
}

function shellOnly(paneId: string): Promise<PaneProcesses> {
  return Promise.resolve({ paneId, shellPid: 1, foregroundGroup: 1, processes: [] } as PaneProcesses);
}

function opRow(over: Partial<OperationRow>): OperationRow {
  return { id: "o1", kind: "launch", mode: "fresh", phase: "requested", ...over } as OperationRow;
}

describe("an issued launch with no launcher is judged against its recorded candidate", () => {
  test("the harness in the recorded pane, started after the launch was issued, is adopted: no second start", async () => {
    const op = issuedLaunch(START - 500);
    const d = daemon({ processes: harness(PID) });
    await d.reconciler.reconcileRun(getRun(db, "r1")!, "startup");
    const run = getRun(db, "r1")!;
    expect([run.state, run.proc_pid, run.proc_start]).toEqual(["running", PID, START]);
    expect(getOperation(db, op.id)).toMatchObject({ phase: "confirmed", proc_pid: PID });
    expect(d.launches).toEqual([]);
  });

  test("a harness that started before the launch was issued is not ours: escalated, never adopted", async () => {
    const op = issuedLaunch(START + 60_000);
    const d = daemon({ processes: harness(PID) });
    await d.reconciler.reconcileRun(getRun(db, "r1")!, "startup");
    expect(getRun(db, "r1")!.proc_pid).toBeNull();
    expect(getOperation(db, op.id)!.phase).toBe("escalated");
    expect(d.launches).toEqual([]);
    // The escalation holds the run: the next pass neither launches it nor opens anything new.
    await d.reconciler.reconcileRun(getRun(db, "r1")!, "steady");
    expect(d.launches).toEqual([]);
    expect(operationRows()).toHaveLength(1);
    // Dismissing its P1 does not release it: the process may still be in the pane.
    tx(db, () => db.query("UPDATE items SET state = 'dismissed' WHERE run_id = 'r1' AND kind = 'operation_escalated'").run());
    await d.reconciler.reconcileRun(getRun(db, "r1")!, "steady");
    expect(d.launches).toEqual([]);
    expect(operationRows()).toHaveLength(1);
    expect(db.query("SELECT line FROM items WHERE kind = 'operation_escalated'").get()).toMatchObject({ line: expect.not.stringContaining("dismiss") });
  });

  test("`flowryn resume` is the explicit way out of an escalated launch: one new operation, for the scheduler to grant", async () => {
    const op = issuedLaunch(START + 60_000);
    const d = daemon({ processes: harness(PID), verifiedHarness: true });
    await d.reconciler.reconcileRun(getRun(db, "r1")!, "startup");
    expect(getOperation(db, op.id)!.phase).toBe("escalated");
    const resume = envelope("resume", { target: "t1" });
    const reply = await d.gateway.handle(resume);
    // The run holds no worker slot here, so the resume waits for its grant like any other.
    expect(reply).toMatchObject({ ok: true, data: { operation: resume.ulid } });
    expect(getRun(db, "r1")!.pending_launch).toBe("resume");
    expect(operationRows().map((o) => [o.kind, o.phase])).toEqual([
      ["launch", "escalated"],
      ["resume", "requested"],
    ]);
    expect(db.query("SELECT state FROM items WHERE kind = 'operation_escalated'").get()).toEqual({ state: "resolved" });
  });

  test("`flowryn resume` on an escalated stage replacement starts it again in its own mode: one stage operation for the grant, nothing launched beside it", async () => {
    const op = tx(db, () => {
      const at = Date.now();
      db.query("UPDATE runs SET liveness = 'starting', proc_pid = NULL, proc_start = NULL, proc_exe = NULL, pending_launch = 'stage', stage_state = 'active', stage_note = 'checked' WHERE id = 'r1'").run();
      db.query("INSERT INTO pool_leases (pool, run_id, stage, granted_at) VALUES ('worker', 'r1', 'investigate', ?1)").run(at);
      const requested = requestOperation(db, { run: { id: "r1", task_id: "t1" }, kind: "launch", mode: "stage", requestedBy: "scheduler", source: "daemon", now: START + 60_000 });
      return claimOperation(db, requested.id, { paneId: "w:1", agentName: "flowryn-x" }, "daemon", START + 60_000)!;
    });
    const d = daemon({ processes: harness(PID), verifiedHarness: true });
    await d.reconciler.reconcileRun(getRun(db, "r1")!, "startup");
    expect(getOperation(db, op.id)!.phase).toBe("escalated");
    const resume = envelope("resume", { target: "t1" });
    expect(await d.gateway.handle(resume)).toMatchObject({ ok: true, data: { operation: resume.ulid } });
    expect(getOperation(db, resume.ulid)).toMatchObject({ kind: "launch", mode: "stage", phase: "requested" });
    expect(getRun(db, "r1")).toMatchObject({ pending_launch: "stage", stage_note: "checked" });
    expect(d.launches).toEqual([]);
    // A replay of the same call opens nothing more.
    await d.gateway.handle(resume);
    expect(operationRows().map((o) => [o.kind, o.mode, o.phase])).toEqual([
      ["launch", "stage", "escalated"],
      ["launch", "stage", "requested"],
    ]);
    expect(d.launches).toEqual([]);
  });

  test("another foreground process in the recorded pane: escalated", async () => {
    const op = issuedLaunch(Date.now() - 60_000);
    const d = daemon({ processes: (paneId) => Promise.resolve({ paneId, shellPid: 1, foregroundGroup: 77, processes: [{ pid: 77, cwd: "", name: "vim", argv0: "vim" }] } as PaneProcesses) });
    await d.reconciler.reconcileRun(getRun(db, "r1")!, "startup");
    expect(getOperation(db, op.id)!.phase).toBe("escalated");
    expect(db.query("SELECT kind FROM items WHERE run_id = 'r1' AND state = 'open'").all()).toEqual([{ kind: "operation_escalated" }]);
  });

  test("only the shell, within the launch timeout: it waits; past it, the same operation is issued again", async () => {
    const op = issuedLaunch(Date.now());
    const d = daemon({ processes: shellOnly });
    await d.reconciler.reconcileRun(getRun(db, "r1")!, "startup");
    expect(getOperation(db, op.id)!.phase).toBe("effect_issued");
    expect(d.launches).toEqual([]);

    tx(db, () => db.query("UPDATE operations SET issued_at = ?2 WHERE id = ?1").run(op.id, Date.now() - 10_000));
    await d.reconciler.reconcileRun(getRun(db, "r1")!, "steady");
    expect(getOperation(db, op.id)).toMatchObject({ phase: "requested", attempts: 1 });
    expect(d.launches).toEqual([`r1:fresh:${op.id}`]);
    expect(operationRows()).toHaveLength(1);
  });

  test("issued again at most three times, then escalated", async () => {
    const op = issuedLaunch(Date.now() - 10_000);
    tx(db, () => db.query("UPDATE operations SET attempts = 3 WHERE id = ?1").run(op.id));
    const d = daemon({ processes: shellOnly });
    await d.reconciler.reconcileRun(getRun(db, "r1")!, "startup");
    expect(getOperation(db, op.id)!.phase).toBe("escalated");
    expect(d.launches).toEqual([]);
  });

  test("Herdr away decides nothing: the operation stays issued", async () => {
    const op = issuedLaunch(Date.now() - 60_000);
    const d = daemon({ processes: () => Promise.reject(new HerdrError("unreachable", "no socket")) });
    await d.reconciler.reconcileRun(getRun(db, "r1")!, "startup");
    expect(getOperation(db, op.id)!.phase).toBe("effect_issued");
    expect(d.launches).toEqual([]);
  });

  test("an issued resume interrupted the same way is not read as a second death", async () => {
    tx(db, () => db.query("UPDATE runs SET resume_count = 1 WHERE id = 'r1'").run());
    const op = issuedLaunch(START - 500, "resume");
    tx(db, () => db.query("UPDATE runs SET state = 'running', proc_pid = 4242, proc_start = ?1, proc_exe = 'claude' WHERE id = 'r1'").run(START - 3_600_000));
    const d = daemon({ processes: harness(PID) });
    await d.reconciler.reconcileRun(getRun(db, "r1")!, "startup");
    const run = getRun(db, "r1")!;
    expect([run.state, run.proc_pid]).toEqual(["running", PID]);
    expect(getOperation(db, op.id)!.phase).toBe("confirmed");
    expect(db.query("SELECT kind FROM items WHERE run_id = 'r1' AND kind = 'failure_needs_you'").all()).toEqual([]);
  });

  test("a check that finds its operation changed during the Herdr read writes nothing but a stale event", async () => {
    const op = issuedLaunch(START - 500);
    const read = barrier();
    const d = daemon({ processes: (paneId) => read.hold(() => ({ paneId, shellPid: 1, foregroundGroup: PID, processes: [{ pid: PID, cwd: "", name: "claude", argv0: "claude" }] }) as PaneProcesses) });
    const pass = d.reconciler.reconcileRun(getRun(db, "r1")!, "startup");
    await read.reached;
    // Meanwhile a cancel supersedes the launch.
    tx(db, () => db.query("UPDATE operations SET phase = 'failed', detail = 'superseded' WHERE id = ?1").run(op.id));
    read.open();
    await pass;
    expect(getRun(db, "r1")!.proc_pid).toBeNull();
    expect(getOperation(db, op.id)!.phase).toBe("failed");
    expect(eventKinds()).toContain("run.operation_stale");
  });

  test("a launch interrupted before operations were recorded is checked against the run's own pane", async () => {
    tx(db, () => db.query("UPDATE runs SET state = 'launching', liveness = 'starting', proc_pid = NULL, proc_start = NULL, proc_exe = NULL, launched_at = ?1 WHERE id = 'r1'").run(START - 500));
    const d = daemon({ processes: harness(PID) });
    await d.reconciler.reconcileRun(getRun(db, "r1")!, "startup");
    expect(getRun(db, "r1")!.proc_pid).toBe(PID);
    expect(operationRows().map((o) => [o.kind, o.phase, o.requested_by])).toEqual([["launch", "confirmed", "reconciler"]]);
    expect(d.launches).toEqual([]);
  });
});

describe("a requested launch or resume no launcher claimed", () => {
  test("the automatic resume claimed before the daemon died is launched under its operation, not read as a second death", async () => {
    deadRun();
    const first = daemon();
    // The claim commits and its launch is recorded; that daemon dies before its launcher claimed the operation.
    await first.reconciler.reconcileRun(getRun(db, "r1")!, "steady");
    const [resume] = operationRows();
    expect(resume).toMatchObject({ kind: "resume", phase: "requested" });
    expect(first.launches).toEqual([`r1:resume:${resume!.id}`]);

    const second = daemon();
    await second.reconciler.reconcileRun(getRun(db, "r1")!, "startup");
    expect(second.launches).toEqual([`r1:resume:${resume!.id}`]);
    expect(operationRows()).toHaveLength(1);
    expect(db.query("SELECT kind FROM items WHERE run_id = 'r1' AND kind = 'failure_needs_you'").all()).toEqual([]);
    expect(db.query("SELECT operation FROM explanations WHERE run_id = 'r1' AND rule = 'resume.auto'").all()).toEqual([{ operation: resume!.id }]);
  });

  test("a cancel that lands during the harness check wins: no launch", async () => {
    deadRun();
    tx(db, () => requestOperation(db, { run: { id: "r1", task_id: "t1" }, kind: "resume", mode: "resume", requestedBy: "reconciler", source: "reconciler", now: Date.now() }));
    const gate = barrier();
    const d = daemon({ harnessGate: () => gate.hold(() => ({ harness: "claude", state: "verified", version: "1", revision: 1 }) as const) });
    const pass = d.reconciler.reconcileRun(getRun(db, "r1")!, "startup");
    await gate.reached;
    tx(db, () => {
      const open = openOperation(db, "r1")!;
      db.query("UPDATE operations SET phase = 'failed' WHERE id = ?1").run(open.id);
      requestOperation(db, { run: { id: "r1", task_id: "t1" }, kind: "cancel", requestedBy: "leader", source: "cli", now: Date.now() });
    });
    gate.open();
    await pass;
    expect(d.launches).toEqual([]);
  });
});

describe("show", () => {
  test("names the open operation, and --why the explanation's operation", async () => {
    deadRun();
    const d = daemon();
    await d.reconciler.reconcileRun(getRun(db, "r1")!, "steady");
    const resume = operationRows()[0]!;
    const shown: Reply = await d.gateway.handle({ ...envelope("show", { target: "t1" }) });
    expect((shown.data as { operation: string }).operation).toContain(`${resume.id} resume requested`);
  });
});
