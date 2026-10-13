import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Args } from "../../src/api/verbs.ts";
import { explain, openExplanations, taskExplanations, type ExplanationRow, type NewExplanation } from "../../src/attention/explanations.ts";
import { resolveRunItems } from "../../src/attention/items.ts";
import { parseConfig } from "../../src/config/config.ts";
import { DEFAULT_TIMING } from "../../src/config/workers.ts";
import { workflowFor } from "../../src/config/workflows.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import type { HarnessCheck } from "../../src/lifecycle/harness-gate.ts";
import { LEADER_RUN_VERBS } from "../../src/lifecycle/leader-verbs.ts";
import { openBlockedPrompt } from "../../src/lifecycle/prompt-wedge.ts";
import { cancelRun, getRun } from "../../src/lifecycle/runs.ts";
import type { SteerBus } from "../../src/lifecycle/steers.ts";
import { Reconciler } from "../../src/reconcile/reconciler.ts";
import type { HerdrRuntime } from "../../src/runtime/herdr/runtime.ts";
import type { HostVerdict } from "../../src/sched/host.ts";
import { grantLeases, releaseLeases } from "../../src/sched/pools.ts";
import { Scheduler } from "../../src/sched/scheduler.ts";
import { noteUsageLimit, RESUME_COMMAND } from "../../src/sched/usage.ts";

/**
 * Wait explanations (docs/notes/2026-10-12-next-steps-md-wz.md): each decision
 * kind is driven through the code that decides it, then the database file is
 * closed and opened again and `flowryn show` explains the decision from the
 * table alone ("replayed offline").
 */

const HOME = "/tmp/fw-explain";
const PROC_START = new Date(2026, 9, 12, 10, 0, 0).getTime();
const PS_LINE = "999999 Mon Oct 12 10:00:00 2026 claude\n";
const CONFIG = `[tools]\nclaude = "/bin/true"\n[capacity]\ngpu = 1\n[workflows.twopass]\nstages = [ { id = "build" }, { id = "check", pools = ["gpu"] }, { id = "ship", gate = "merge" } ]`;

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-explain-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  tx(db, () => {
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', '', ?1, 'main', 'local-only')").run(dir);
    for (const [task, run] of [["t1", "r1"], ["t2", "r2"], ["t3", "r3"]] as const) {
      db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES (?1, 'web', 'ship', 'local-only', 0, 'fix', 0)").run(task);
      db.query(
        `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, pane_id, agent_session, worktree_path, branch, base_sha,
           proc_pid, proc_start, proc_exe, token_hash, started_at, updated_at)
         VALUES (?1, ?2, 'claude', '1', 'running', 'busy', 'fix', 'build', ?3, 'sess', ?4, 'b', 'abc', 999999, ?5, 'claude', 'h', ?5, ?5)`,
      ).run(run, task, `w:${run.slice(1)}`, dir, PROC_START);
    }
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The offline replay: nothing kept in memory, the database file opened again. */
function reopen(): void {
  db.close();
  db = openDb(join(dir, "flowryn.db"));
}

function show(target: string, flags: { why?: boolean; timeline?: boolean; full?: boolean } = {}, now = Date.now()): Record<string, unknown> {
  const spec = LEADER_RUN_VERBS.find((v) => v.name === "show")!;
  const args: Args = { target, ...flags };
  const ctx = { db, config: parseConfig("", HOME), now, caller: { role: "human" as const, runId: null, taskId: null } };
  return (spec.read!(ctx, args) as { data: Record<string, unknown> }).data;
}

const rows = (runId: string) => db.query("SELECT * FROM explanations WHERE run_id = ?1 ORDER BY id").all(runId) as ExplanationRow[];

function reconciler(opts: { now: () => number; launches?: string[]; harnessGate?: (h: "claude" | "pi") => Promise<HarnessCheck>; foreground?: number }) {
  const runtime = {
    processes: (paneId: string) => Promise.resolve({ paneId, shellPid: 1, foregroundGroup: opts.foreground ?? 1, processes: [] }),
    snapshotPanes: () => Promise.resolve([]),
    agentStatus: () => Promise.resolve(null),
  } as unknown as HerdrRuntime;
  return new Reconciler({
    db,
    runtime: () => runtime,
    launch: (runId, mode) => opts.launches?.push(`${runId}:${mode}`),
    isLaunching: () => false,
    bus: { notify() {} } as unknown as SteerBus,
    timing: () => DEFAULT_TIMING,
    log: () => {},
    now: opts.now,
    ps: () => Promise.resolve(opts.foreground ? PS_LINE : ""),
    ...(opts.harnessGate ? { harnessGate: opts.harnessGate } : {}),
  });
}

function scheduler(opts: { now: () => number; host?: HostVerdict; launches?: string[] }) {
  const config = parseConfig(CONFIG, HOME);
  return new Scheduler({
    db,
    config: () => config,
    now: opts.now,
    log: () => {},
    launch: (runId, mode) => {
      opts.launches?.push(`${runId}:${mode}`);
      db.query("UPDATE runs SET pending_launch = NULL WHERE id = ?1").run(runId);
    },
    isLaunching: () => false,
    exitWorker: async () => ({ ok: true }),
    notify: () => {},
    startDeps: { db, config: () => config, runtime: () => null, harnessVersion: async () => "1", git: async () => null, now: opts.now },
    kickJournal: () => {},
    host: async () => opts.host ?? ({ ok: true, reason: "test" } as HostVerdict),
    quota: async () => ({ state: "known", percent: 80, window: null, resets_at: null }),
  });
}

/** r2 waits to start the check stage, which needs the one gpu slot; `holder` holds it. */
function waitForGpu(holder: string | null, at: number, runId = "r2"): void {
  const def = JSON.stringify(workflowFor(parseConfig(CONFIG, HOME), "twopass", "ship"));
  tx(db, () => {
    db.query("UPDATE runs SET workflow = 'twopass', workflow_def = ?2, stage = 'check', stage_state = 'waiting', waiting_since = ?1 WHERE id = ?3").run(at, def, runId);
    if (holder) grantLeases(db, holder, holder.replace("r", "t"), "check", ["gpu"], { gpu: 1 }, at);
  });
}

/** One capacity explanation for r1, with what a test changes. */
const base = (over: Partial<NewExplanation> = {}): NewExplanation => ({
  run: { id: "r1", task_id: "t1", stage: "build" },
  kind: "capacity",
  rule: "capacity.pools_full",
  reason: "no free slot in gpu",
  facts: [{ name: "pool gpu", value: "1/1 held by t3", at: 100 }],
  unblock: [{ by: "flowryn", action: "grants when a slot frees" }],
  source: "daemon",
  now: 100,
  ...over,
});

describe("recording an explanation (dedupe)", () => {
  test("an unchanged observation read again writes nothing, even observed later; a changed fact supersedes the open row", () => {
    expect(tx(db, () => explain(db, base()))).toBe(1);
    expect(tx(db, () => explain(db, base({ now: 200, facts: [{ name: "pool gpu", value: "1/1 held by t3", at: 200 }] })))).toBeNull();
    expect(rows("r1")).toHaveLength(1);
    const second = tx(db, () => explain(db, base({ now: 300, facts: [{ name: "pool gpu", value: "1/1 held by t2", at: 300 }] })));
    expect(second).toBe(2);
    expect(rows("r1").map((r) => [r.id, r.closed_by, r.closed_at])).toEqual([
      [1, "superseded by x2", 300],
      [2, null, null],
    ]);
    // One event per row written, none for the unchanged read.
    expect(db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'run.explained' AND run_id = 'r1'").get()).toEqual({ n: 2 });
  });

  test("kinds are independent: a dialog row does not supersede a capacity row; a settled decision is recorded closed", () => {
    tx(db, () => explain(db, base()));
    tx(db, () => explain(db, base({ kind: "dialog", rule: "dialog.confirmed", reason: "a dialog" })));
    tx(db, () => explain(db, base({ kind: "resume", rule: "resume.auto", reason: "resumed", unblock: [], settled: "resumed" })));
    expect(openExplanations(db, "r1").map((r) => r.rule)).toEqual(["dialog.confirmed", "capacity.pools_full"]);
    expect(rows("r1").find((r) => r.rule === "resume.auto")).toMatchObject({ closed_by: "resumed" });
  });
});

describe("dialog: a blocked-dialog hold", () => {
  test("a confirmed dialog is explained offline with its prompt, pane and who can answer it; hook activity closes it with the item", () => {
    const t = Date.now();
    tx(db, () => openBlockedPrompt(db, getRun(db, "r1")!, { suspected: false, screen: "Bash command\n  rm -rf build\nDo you want to proceed?\n 1. Yes\n 2. No", harness: "claude", lastHook: t - 5_000 }, t));
    reopen();
    const view = show("t1", {}, t + 60_000);
    expect(view.waiting).toMatch(/^a confirmation dialog is up in pane w:1 \(since \d\d:\d\d\); next: answer the dialog in pane w:1 \(Flowryn never answers it\) \(captain\)$/);
    const [why] = show("t1", { why: true }, t + 60_000).waiting as Record<string, unknown>[];
    expect(why).toMatchObject({ id: "x1", kind: "dialog", rule: "dialog.confirmed", stage: "build", operation: "-" });
    expect(why!.facts).toEqual([expect.stringMatching(/^prompt: Bash command rm -rf build Do you want to proceed\? \(observed \d\d:\d\d:\d\d, 60s ago\)$/), expect.stringMatching(/^last hook: .* \(observed .*65s ago\)$/)]);
    expect(why!.unblock).toEqual(["captain: answer the dialog in pane w:1 (Flowryn never answers it)", "flowryn: clears it on the worker's next hook, or when Herdr reads the agent working (or settled on two passes)"]);

    tx(db, () => resolveRunItems(db, "r1", ["blocked_prompt"], "hook post-tool", t + 61_000));
    expect(show("t1").waiting).toBeUndefined();
    expect(show("t1", { timeline: true }).timeline).toEqual([expect.stringMatching(/^x1 \d\d:\d\d dialog\.confirmed \[build\]: a confirmation dialog is up in pane w:1 → hook post-tool \d\d:\d\d$/)]);
  });

  test("the trust wedge seen on every reconciler pass is one explanation; the worker-start hook closes it", async () => {
    let clock = Date.now();
    db.query("UPDATE runs SET launched_at = ?1, liveness = 'starting' WHERE id = 'r1'").run(clock);
    clock += DEFAULT_TIMING.trust_wedge_ms + 1_000;
    const rec = reconciler({ now: () => clock, foreground: 999999 });
    for (let pass = 0; pass < 3; pass++) {
      await rec.reconcileRun(getRun(db, "r1")!, "steady");
      clock += 10_000;
    }
    rec.stop();
    expect(rows("r1").map((r) => [r.rule, r.closed_at])).toEqual([["dialog.trust", null]]);
    reopen();
    const [why] = show("r1", { why: true }).waiting as Record<string, unknown>[];
    expect(why).toMatchObject({ rule: "dialog.trust", reason: "the worker has not started 30s after its launch; a dialog may hold pane w:1" });
    expect(why!.unblock).toEqual(["captain: accept or answer the dialog in pane w:1", "flowryn: clears it when the worker-start hook arrives"]);
    tx(db, () => resolveRunItems(db, "r1", ["trust_dialog"], "run.worker_started", clock));
    expect(rows("r1")[0]).toMatchObject({ closed_by: "run.worker_started" });
  });
});

describe("capacity: a scheduler wait", () => {
  test("a full pool over several passes is one explanation; a new holder is a second; the grant closes it, and the record replays offline", async () => {
    let clock = 1_000_000;
    const now = () => clock;
    waitForGpu("r3", clock);
    const s = scheduler({ now });
    for (let pass = 0; pass < 3; pass++) {
      await s.passNow();
      clock += 5_000;
    }
    expect(rows("r2").map((r) => [r.rule, r.reason, r.closed_at])).toEqual([["capacity.pools_full", "no free slot in gpu", null]]);
    s.stop();
    reopen();
    const [why] = show("t2", { why: true }, clock).waiting as Record<string, unknown>[];
    expect(why).toMatchObject({ kind: "capacity", rule: "capacity.pools_full", stage: "check" });
    expect(why!.facts).toEqual([expect.stringMatching(/^pool gpu: 1\/1 held by t3 \(observed \d\d:\d\d:\d\d, 15s ago\)$/)]);
    expect(why!.unblock).toEqual(["flowryn: grants when a slot in gpu frees (a holder's stage or run ends)", "captain: raise [capacity] gpu in config.toml"]);

    // The slot changes hands: a changed input, so one more row.
    tx(db, () => {
      releaseLeases(db, "r3", "t3", { keepWorker: true }, "test", clock);
      grantLeases(db, "r1", "t1", "check", ["gpu"], { gpu: 1 }, clock);
    });
    const s2 = scheduler({ now });
    await s2.passNow();
    expect(rows("r2").map((r) => [r.id, r.closed_by])).toEqual([
      [1, "superseded by x2"],
      [2, null],
    ]);
    expect(show("t2").waiting).toMatch(/^no free slot in gpu \(since \d\d:\d\d\); next: grants when a slot in gpu frees \(a holder's stage or run ends\) \(flowryn\)$/);

    tx(db, () => releaseLeases(db, "r1", "t1", { keepWorker: true }, "test", clock));
    clock += 5_000;
    await s2.passNow();
    s2.stop();
    expect(db.query("SELECT stage_state FROM runs WHERE id = 'r2'").get()).toEqual({ stage_state: "active" });
    expect(rows("r2").map((r) => r.closed_by)).toEqual(["superseded by x2", "granted"]);
    expect(show("t2").waiting).toBeUndefined();
    expect(show("t2", { timeline: true }).timeline).toEqual([expect.stringContaining("→ superseded by x2"), expect.stringContaining("→ granted")]);
    const full = show("t2", { timeline: true, full: true }).timeline as { facts: string[] }[];
    expect(full[0]!.facts[0]).toMatch(/^pool gpu: 1\/1 held by t3 /);
    expect(full[1]!.facts[0]).toMatch(/^pool gpu: 1\/1 held by t1 /);
  });

  test("the Claude usage pause: the captain's command is the way past it now; the host check: Flowryn grants once it passes", async () => {
    let clock = 2_000_000;
    waitForGpu(null, clock);
    tx(db, () => noteUsageLimit(db, "worker t1", "rate_limit", clock, { usage_backoff_ms: 60_000, usage_backoff_max_ms: 120_000 }));
    const s = scheduler({ now: () => clock });
    await s.passNow();
    s.stop();
    reopen();
    const [usage] = show("t2", { why: true }, clock).waiting as Record<string, unknown>[];
    expect(usage).toMatchObject({ rule: "capacity.usage_limit" });
    expect(usage!.reason).toMatch(/^the Claude usage limit pauses Claude starts until \d\d:\d\d$/);
    expect(usage!.unblock).toEqual([expect.stringMatching(/^flowryn: lets one Claude run probe it after \d\d:\d\d$/), `captain: ${RESUME_COMMAND}`]);

    db.query("UPDATE runs SET harness = 'pi' WHERE id = 'r2'").run();
    clock += 1_000;
    const blocked = scheduler({ now: () => clock, host: { ok: false, reason: "free memory 1 GB under 8 GB" } as HostVerdict });
    await blocked.passNow();
    blocked.stop();
    const open = openExplanations(db, "r2");
    expect(open.map((r) => [r.rule, r.reason])).toEqual([["capacity.host_check", "the host check fails: free memory 1 GB under 8 GB"]]);
    expect(JSON.parse(open[0]!.unblock)).toEqual([{ by: "flowryn", action: "grants once the host check passes (8 GB free, load per core under 1.5)" }]);
  });

  test("a run that stops waiting without a grant is swept on the next pass; a cancel closes its rows at once", async () => {
    let clock = 3_000_000;
    waitForGpu("r3", clock);
    waitForGpu(null, clock, "r1");
    const s = scheduler({ now: () => clock });
    await s.passNow();
    expect(openExplanations(db, "r1")).toHaveLength(1);
    expect(openExplanations(db, "r2")).toHaveLength(1);
    tx(db, () => cancelRun(db, getRun(db, "r1")!, "not needed", "cli", clock));
    expect(rows("r1")[0]).toMatchObject({ closed_by: "run.cancelled" });
    db.query("UPDATE runs SET stage_state = 'active' WHERE id = 'r2'").run();
    clock += 5_000;
    await s.passNow();
    s.stop();
    expect(rows("r2")[0]).toMatchObject({ closed_by: "no longer waiting" });
    expect(db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'run.explanations_closed'").get()).toEqual({ n: 1 });
  });
});

describe("resume: an automatic resume, deferred or refused", () => {
  test("the automatic resume is recorded as a settled decision, explained offline in the timeline", async () => {
    const launches: string[] = [];
    const rec = reconciler({ now: Date.now, launches });
    await rec.reconcileRun(getRun(db, "r1")!, "steady");
    rec.stop();
    expect(launches).toEqual(["r1:resume"]);
    reopen();
    expect(show("t1").waiting).toBeUndefined();
    const [entry] = show("t1", { timeline: true, full: true }).timeline as { line: string; facts: string[]; unblock: string[] }[];
    expect(entry!.line).toMatch(/^x1 \d\d:\d\d resume\.auto \[build\]: the worker died; resumed once from its stored session → resumed \d\d:\d\d$/);
    expect(entry!.facts).toEqual([
      expect.stringMatching(/^process: pid 999999 gone; the pane holds only its shell \(observed /),
      "session: sess (observed -)",
      "automatic resumes so far: 0 (observed -)",
    ]);
    expect(entry!.unblock).toEqual([]);
  });

  test("a resume deferred on an untested harness waits with the contract command; the scheduler's launch closes it", async () => {
    let clock = 4_000_000;
    const rec = reconciler({ now: () => clock, harnessGate: async (harness) => ({ harness, state: "unverified", version: "1" }) });
    await rec.reconcileRun(getRun(db, "r1")!, "steady");
    rec.stop();
    reopen();
    expect(show("t1", {}, clock).waiting).toMatch(
      /^the worker died; its one automatic resume waits: claude 1 has no passing contract run \(since \d\d:\d\d\); next: launches the resume once claude 1 passes its contract suite \(flowryn\)$/,
    );
    const [why] = show("t1", { why: true }, clock).waiting as Record<string, unknown>[];
    expect(why!.unblock).toEqual(["flowryn: launches the resume once claude 1 passes its contract suite", "captain: flowryn doctor --contracts --harness claude"]);

    db.query("INSERT INTO harness_contracts (harness, version, passed_at) VALUES ('claude', '1', 0)").run();
    clock += 1_000;
    const launches: string[] = [];
    const s = scheduler({ now: () => clock, launches });
    await s.passNow();
    s.stop();
    expect(launches).toEqual(["r1:resume"]);
    expect(rows("r1").map((r) => [r.rule, r.closed_by])).toEqual([["resume.deferred", "granted"]]);
  });

  test("a second death refuses another resume: the leader's commands are the way on, and flowryn resume closes it with the item", async () => {
    db.query("UPDATE runs SET resume_count = 1 WHERE id = 'r1'").run();
    const rec = reconciler({ now: Date.now });
    await rec.reconcileRun(getRun(db, "r1")!, "steady");
    rec.stop();
    reopen();
    expect(show("t1").waiting).toMatch(/^the worker died again after its one automatic resume; no second one \(since \d\d:\d\d\); next: flowryn resume t1 \(leader\)$/);
    const [why] = show("t1", { why: true }).waiting as Record<string, unknown>[];
    expect(why!.unblock).toEqual(["leader: flowryn resume t1", "leader: flowryn cancel t1"]);
    tx(db, () => resolveRunItems(db, "r1", ["failure_needs_you"], "run.resume_requested", Date.now()));
    expect(taskExplanations(db, "t1").map((r) => [r.rule, r.closed_by])).toEqual([["resume.refused", "run.resume_requested"]]);
  });
});
