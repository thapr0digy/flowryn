import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TIMING } from "../../src/config/workers.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import type { HarnessCheck } from "../../src/lifecycle/harness-gate.ts";
import { observedTransition, staleFields } from "../../src/lifecycle/observed.ts";
import { openBlockedPrompt } from "../../src/lifecycle/prompt-wedge.ts";
import { cancelRun, getRun, setLiveness, type RunRow } from "../../src/lifecycle/runs.ts";
import type { SteerBus } from "../../src/lifecycle/steers.ts";
import { contractRevision } from "../../src/contracts/revision.ts";
import { Reconciler } from "../../src/reconcile/reconciler.ts";
import { HerdrError } from "../../src/runtime/herdr/client.ts";
import type { HerdrRuntime, PaneProcesses } from "../../src/runtime/herdr/runtime.ts";

/**
 * Guarded observation transitions (docs/notes/2026-10-12-next-steps-md-s9.md):
 * each race pauses the reconciler's observation on an explicit barrier, lands
 * a newer hook, cancellation or replacement worker, then releases it. The old
 * observation must write nothing but a run.observation_stale event.
 */

const PID = 999_999;
const START = new Date(2026, 9, 12, 10, 0, 0).getTime();
const PS_ALIVE = `${PID} Mon Oct 12 10:00:00 2026 claude\n`;

const dirs: string[] = [];
const dbs: Db[] = [];
const reconcilers: Reconciler[] = [];
afterEach(() => {
  for (const r of reconcilers.splice(0)) r.stop();
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** One running claude run, its worker started, idle, with a resumable session. */
function runDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "fw-observed-"));
  dirs.push(dir);
  const db = openDb(join(dir, "flowryn.db"));
  dbs.push(db);
  migrate(db);
  const now = Date.now();
  db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', 'u', ?1, 'main', 'local-only')").run(dir);
  db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES ('t1', 'web', 'scout', 'local-only', 0, 'scout', ?1)").run(now);
  db.query(
    `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, pane_id, agent_session, worktree_path, branch, base_sha,
       proc_pid, proc_start, proc_exe, token_hash, started_at, updated_at, worker_started_at, last_hook_at, idle_since)
     VALUES ('r1', 't1', 'claude', '1', 'running', 'idle', 'scout', 'investigate', 'w:1', 'sess', ?1, 'b', 'abc', ?2, ?3, 'claude', 'h', ?4, ?4, ?4, ?4, ?4)`,
  ).run(dir, PID, START, now - 1_000);
  return db;
}

/** A barrier the fake parks an observation on: `reached` once it is held, `open()` lets it through. */
function barrier() {
  let open!: () => void;
  let reached!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const held = new Promise<void>((resolve) => (reached = resolve));
  return {
    reached: held,
    open,
    hold<T>(value: T | (() => T)): Promise<T> {
      reached();
      return opened.then(() => (typeof value === "function" ? (value as () => T)() : value));
    },
  };
}

interface Fakes {
  processes?(paneId: string): Promise<PaneProcesses | null>;
  agentStatus?(): Promise<string | null>;
  ps?(): Promise<string>;
  harnessGate?(): Promise<HarnessCheck>;
}

function reconcilerFor(db: Db, fakes: Fakes, launches: string[] = []): Reconciler {
  const runtime = {
    processes: fakes.processes ?? ((paneId: string) => Promise.resolve({ paneId, shellPid: 1, foregroundGroup: PID, processes: [{ pid: PID, cwd: "" }] })),
    snapshotPanes: () => Promise.resolve([]),
    agentStatus: fakes.agentStatus ?? (() => Promise.resolve(null)),
  } as unknown as HerdrRuntime;
  const reconciler = new Reconciler({
    db,
    runtime: () => runtime,
    launch: (runId, mode) => launches.push(`${runId}:${mode}`),
    isLaunching: () => false,
    bus: { notify() {}, hasWaiter: () => false } as unknown as SteerBus,
    timing: () => DEFAULT_TIMING,
    log: () => {},
    now: Date.now,
    ps: fakes.ps ?? (() => Promise.resolve(PS_ALIVE)),
    ...(fakes.harnessGate ? { harnessGate: fakes.harnessGate } : {}),
  });
  reconcilers.push(reconciler);
  return reconciler;
}

/** What markBusy writes for a pre-tool hook (src/lifecycle/hooks.ts), in its own transaction. */
function hookBusy(db: Db): void {
  const now = Date.now();
  tx(db, () => {
    db.query("UPDATE runs SET busy_until = ?2, idle_since = NULL, last_hook_at = ?3, updated_at = ?3 WHERE id = ?1").run("r1", now + DEFAULT_TIMING.busy_lease_ms, now);
    setLiveness(db, getRun(db, "r1")!, "busy", "hook", { signal: "tool" }, now);
  });
}

function cancel(db: Db): void {
  tx(db, () => cancelRun(db, getRun(db, "r1")!, "you cancelled it", "cli", Date.now()));
}

/** What the scheduler's fresh-stage replacement and the launcher's identity save write: a new worker generation. */
function replaceWorker(db: Db): void {
  const now = Date.now();
  tx(db, () =>
    db
      .query(
        `UPDATE runs SET agent_session = 'sess-2', proc_pid = 4242, proc_start = ?1, worker_started_at = NULL, launched_at = ?1,
           busy_until = NULL, idle_since = NULL, liveness = 'starting', updated_at = ?1 WHERE id = 'r1'`,
      )
      .run(now),
  );
}

/** The explanation rules written for r1: a stale observation must write none. */
function explanationRules(db: Db): string[] {
  return (db.query("SELECT rule FROM explanations WHERE run_id = 'r1' ORDER BY id").all() as { rule: string }[]).map((r) => r.rule);
}

function staleEvents(db: Db): { transition: string; changed: Record<string, unknown> }[] {
  return (db.query("SELECT payload FROM events WHERE kind = 'run.observation_stale' AND run_id = 'r1' ORDER BY seq").all() as { payload: string }[]).map(
    (row) => JSON.parse(row.payload) as { transition: string; changed: Record<string, unknown> },
  );
}

function eventKinds(db: Db): string[] {
  return (db.query("SELECT kind FROM events WHERE run_id = 'r1' ORDER BY seq").all() as { kind: string }[]).map((row) => row.kind);
}

const husk = (paneId: string): Promise<PaneProcesses> => Promise.resolve({ paneId, shellPid: 1, foregroundGroup: 1, processes: [] });

describe("the observation guard", () => {
  test("an unchanged run is not stale; a terminal one always is, even when every observed field matches", () => {
    const db = runDb();
    const seen = getRun(db, "r1")!;
    expect(staleFields(seen, getRun(db, "r1"))).toEqual({});
    expect(staleFields(seen, null)).toEqual({ run: { seen: "r1", current: null } });
    const terminal = { ...seen, state: "cancelled" } as RunRow;
    expect(Object.keys(staleFields(terminal, terminal))).toEqual(["state"]);
  });

  test("the hook watermark, lifecycle state and worker generation each make an observation stale", () => {
    const db = runDb();
    const seen = getRun(db, "r1")!;
    hookBusy(db);
    expect(Object.keys(staleFields(seen, getRun(db, "r1")))).toEqual(expect.arrayContaining(["last_hook_at", "busy_until", "idle_since", "liveness"]));
    const seenAgain = getRun(db, "r1")!;
    replaceWorker(db);
    expect(Object.keys(staleFields(seenAgain, getRun(db, "r1")))).toEqual(expect.arrayContaining(["proc_pid", "proc_start", "launched_at", "worker_started_at", "agent_session"]));
    const beforeCancel = getRun(db, "r1")!;
    cancel(db);
    expect(staleFields(beforeCancel, getRun(db, "r1")).state).toEqual({ seen: "running", current: "cancelled" });
  });

  test("a stale transition writes nothing but its event; a current one applies against the refreshed row", () => {
    const db = runDb();
    const seen = getRun(db, "r1")!;
    hookBusy(db);
    let applied = false;
    const stale = observedTransition(db, seen, "probe", "reconciler", Date.now(), () => (applied = true));
    expect(stale.applied).toBe(false);
    expect(applied).toBe(false);
    expect(staleEvents(db)).toEqual([{ transition: "probe", changed: expect.objectContaining({ liveness: { seen: "idle", current: "busy" } }) }]);

    const fresh = getRun(db, "r1")!;
    const result = observedTransition(db, fresh, "probe", "reconciler", Date.now(), (run) => run.liveness);
    expect(result).toEqual({ applied: true, value: "busy" });
  });
});

describe("reconciler observations racing newer truth", () => {
  test("a stale live-checks pass still records Herdr's status, so the next pass's second settled read releases the dialog", async () => {
    const db = runDb();
    tx(db, () => openBlockedPrompt(db, getRun(db, "r1")!, { suspected: false, screen: "Do you want to proceed?", harness: "claude", lastHook: 0 }, Date.now()));
    const gate = barrier();
    const first = reconcilerFor(db, { agentStatus: () => gate.hold<string | null>("idle") });
    const pass = first.reconcileRun(getRun(db, "r1")!, "steady");
    await gate.reached;
    // A newer hook that leaves the prompt alone (what session-end writes).
    tx(db, () => db.query("UPDATE runs SET busy_until = NULL, last_hook_at = ?1, updated_at = ?1 WHERE id = 'r1'").run(Date.now()));
    gate.open();
    await pass;
    expect(staleEvents(db).map((e) => e.transition)).toEqual(["live_checks"]);
    expect(db.query("SELECT value FROM run_evidence WHERE run_id = 'r1' AND source = 'herdr'").get()).toEqual({ value: JSON.stringify({ agent_status: "idle" }) });
    expect(eventKinds(db)).not.toContain("run.prompt_cleared");

    await reconcilerFor(db, { agentStatus: () => Promise.resolve("idle") }).reconcileRun(getRun(db, "r1")!, "steady");
    expect(eventKinds(db)).toContain("run.prompt_cleared");
    expect(db.query("SELECT COUNT(*) AS n FROM items WHERE kind = 'blocked_prompt' AND state IN ('open','presented')").get()).toEqual({ n: 0 });
  });

  test("a hook that lands while the live checks read Herdr keeps its busy liveness", async () => {
    const db = runDb();
    const gate = barrier();
    const reconciler = reconcilerFor(db, { agentStatus: () => gate.hold<string | null>("idle") });
    const pass = reconciler.reconcileRun(getRun(db, "r1")!, "steady");
    await gate.reached;
    hookBusy(db);
    gate.open();
    await pass;

    expect(getRun(db, "r1")!.liveness).toBe("busy");
    expect(staleEvents(db).map((e) => e.transition)).toEqual(["live_checks"]);
    // Without the guard the old read (no lease) would have written idle over the hook's busy.
    const reconcilerLiveness = db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'run.liveness' AND source = 'reconciler'").get() as { n: number };
    expect(reconcilerLiveness.n).toBe(0);
  });

  test("a hook that lands while Herdr's read fails keeps its liveness rather than unknown", async () => {
    const db = runDb();
    const gate = barrier();
    const reconciler = reconcilerFor(db, {
      processes: () =>
        gate.hold<PaneProcesses | null>(() => {
          throw new HerdrError("timeout", "Herdr did not answer");
        }),
    });
    const pass = reconciler.reconcileRun(getRun(db, "r1")!, "steady");
    await gate.reached;
    hookBusy(db);
    gate.open();
    expect(await pass).toBe("unknown");

    expect(getRun(db, "r1")!.liveness).toBe("busy");
    expect(staleEvents(db).map((e) => e.transition)).toEqual(["unknown"]);
  });

  test("a cancellation while an orphan is observed opens no divergence", async () => {
    const db = runDb();
    const gate = barrier();
    const reconciler = reconcilerFor(db, { processes: () => gate.hold<PaneProcesses | null>(null) });
    const pass = reconciler.reconcileRun(getRun(db, "r1")!, "steady");
    await gate.reached;
    cancel(db);
    gate.open();
    expect(await pass).toBe("stale");

    expect(getRun(db, "r1")!).toMatchObject({ state: "cancelled", liveness: "dead" });
    expect(db.query("SELECT COUNT(*) AS n FROM divergences").get()).toEqual({ n: 0 });
    expect(staleEvents(db).map((e) => e.transition)).toEqual(["orphaned"]);
  });
});

describe("the automatic resume racing newer truth", () => {
  test("a cancellation during the harness check claims no resume and launches nothing", async () => {
    const db = runDb();
    const gate = barrier();
    const launches: string[] = [];
    const reconciler = reconcilerFor(db, { processes: husk, ps: () => Promise.resolve(""), harnessGate: () => gate.hold<HarnessCheck>({ harness: "claude", state: "verified", version: "1", revision: contractRevision("claude") }) }, launches);
    const pass = reconciler.reconcileRun(getRun(db, "r1")!, "steady");
    await gate.reached;
    cancel(db);
    gate.open();
    expect(await pass).toBe("stale");

    expect(launches).toEqual([]);
    expect(getRun(db, "r1")!).toMatchObject({ state: "cancelled", liveness: "dead", resume_count: 0 });
    expect(eventKinds(db)).not.toContain("run.auto_resumed");
    expect(db.query("SELECT COUNT(*) AS n FROM items WHERE kind = 'auto_resumed'").get()).toEqual({ n: 0 });
    expect(staleEvents(db)).toEqual([{ transition: "auto_resume", changed: expect.objectContaining({ state: { seen: "running", current: "cancelled" } }) }]);
    expect(explanationRules(db)).toEqual([]);
  });

  test("a replacement worker started while the old one's death was read is not resumed over", async () => {
    const db = runDb();
    const gate = barrier();
    const launches: string[] = [];
    const reconciler = reconcilerFor(db, { processes: husk, ps: () => gate.hold("") }, launches);
    const pass = reconciler.reconcileRun(getRun(db, "r1")!, "steady");
    await gate.reached;
    replaceWorker(db);
    gate.open();
    expect(await pass).toBe("stale");

    expect(launches).toEqual([]);
    expect(getRun(db, "r1")!).toMatchObject({ proc_pid: 4242, agent_session: "sess-2", liveness: "starting", resume_count: 0 });
    expect(staleEvents(db).map((e) => e.transition)).toEqual(["auto_resume"]);
    expect(Object.keys(staleEvents(db)[0]!.changed)).toEqual(expect.arrayContaining(["proc_pid", "proc_start", "agent_session"]));
  });

  test("a cancellation during an untested harness check defers no resume", async () => {
    const db = runDb();
    const gate = barrier();
    const reconciler = reconcilerFor(db, { processes: husk, ps: () => Promise.resolve(""), harnessGate: () => gate.hold<HarnessCheck>({ harness: "claude", state: "unverified", version: "9", revision: contractRevision("claude"), stale: [] }) });
    const pass = reconciler.reconcileRun(getRun(db, "r1")!, "steady");
    await gate.reached;
    cancel(db);
    gate.open();
    expect(await pass).toBe("stale");

    expect(getRun(db, "r1")!).toMatchObject({ state: "cancelled", pending_launch: null, resume_count: 0 });
    expect(eventKinds(db)).not.toContain("run.resume_deferred");
    expect(staleEvents(db).map((e) => e.transition)).toEqual(["auto_resume_deferred"]);
    expect(explanationRules(db)).toEqual([]);
  });

  test("a hook from the resumed worker while its predecessor's second death is read raises no failure", async () => {
    const db = runDb();
    db.query("UPDATE runs SET resume_count = 1 WHERE id = 'r1'").run();
    const gate = barrier();
    const reconciler = reconcilerFor(db, { processes: husk, ps: () => gate.hold("") });
    const pass = reconciler.reconcileRun(getRun(db, "r1")!, "steady");
    await gate.reached;
    hookBusy(db);
    gate.open();
    expect(await pass).toBe("stale");

    expect(getRun(db, "r1")!.liveness).toBe("busy");
    expect(eventKinds(db)).not.toContain("run.died");
    expect(db.query("SELECT COUNT(*) AS n FROM items WHERE kind = 'failure_needs_you'").get()).toEqual({ n: 0 });
    expect(staleEvents(db).map((e) => e.transition)).toEqual(["died"]);
    expect(explanationRules(db)).toEqual([]);
  });

  test("a delivered run's resumed worker is not marked dead by its predecessor's exit", async () => {
    const db = runDb();
    db.query("UPDATE runs SET state = 'ready' WHERE id = 'r1'").run();
    const gate = barrier();
    const reconciler = reconcilerFor(db, { processes: husk, ps: () => gate.hold("") });
    const pass = reconciler.reconcileRun(getRun(db, "r1")!, "steady");
    await gate.reached;
    replaceWorker(db);
    gate.open();
    expect(await pass).toBe("stale");

    expect(getRun(db, "r1")!.liveness).toBe("starting");
    expect(staleEvents(db).map((e) => e.transition)).toEqual(["exited_after_delivery"]);
  });

  test("with nothing newer, the same observation still claims the one resume", async () => {
    const db = runDb();
    const gate = barrier();
    const launches: string[] = [];
    const reconciler = reconcilerFor(db, { processes: husk, ps: () => gate.hold("") }, launches);
    const pass = reconciler.reconcileRun(getRun(db, "r1")!, "steady");
    await gate.reached;
    gate.open();
    expect(await pass).toBe("resumed");

    expect(launches).toEqual(["r1:resume"]);
    expect(getRun(db, "r1")!).toMatchObject({ resume_count: 1, liveness: "starting" });
    expect(staleEvents(db)).toEqual([]);
    expect(explanationRules(db)).toEqual(["resume.auto"]);
  });
});
