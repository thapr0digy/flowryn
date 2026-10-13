import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TIMING, type Timing } from "../../src/config/workers.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { resolveRunItems } from "../../src/attention/items.ts";
import type { Verified } from "../../src/harness/types.ts";
import { openBlockedPrompt } from "../../src/lifecycle/prompt-wedge.ts";
import { getRun, setLiveness } from "../../src/lifecycle/runs.ts";
import { ackSteer, createSteer, dueUrgent, getMessage, loseUnseenUrgent, markRung, markSeen, noteDeliveryMode, preemptCandidate, steerBrief, steerStatus } from "../../src/lifecycle/steers.ts";
import { DeferralLog, piPreempt, ToolTracker, UrgentPreempter } from "../../src/lifecycle/urgent.ts";
import type { HerdrRuntime } from "../../src/runtime/herdr/runtime.ts";
import { waitUntil } from "../helpers/harness.ts";

/**
 * Urgent steers (Tier 2): the preempter cuts a Claude worker's tool once it
 * has run steer_preempt_after_ms, and never while a dialog may be open; the Pi
 * extension asks piPreempt the same question before its abort.
 */

const AFTER_MS = 150;
const timing: Timing = { ...DEFAULT_TIMING, steer_preempt_after_ms: AFTER_MS };

let dir: string;
let db: Db;
let interrupts: number;
let interruptResult: Verified;
let herdrStatus: string | null;
let statusDelayMs: number;
let statusGates: Barrier[];
let preempter: UrgentPreempter | null;

function seedRun(id: string, harness: "claude" | "pi"): void {
  tx(db, () => {
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES (?1, 'p', 'scout', 'local-only', 0, 'scout', 0)").run(`t-${id}`);
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at, pane_id, busy_until)
       VALUES (?1, ?2, ?3, 'v', 'running', 'busy', 'scout', 'investigate', '/w', 'b', 's', ?1, 0, 0, 'w1:p1', ?4)`,
    ).run(id, `t-${id}`, harness, Date.now() + 600_000);
  });
}

function urgentSteer(runId = "r1", body = "stop the migration") {
  return tx(db, () => createSteer(db, getRun(db, runId)!, body, Date.now(), null, true));
}

function events(kind: string): Record<string, unknown>[] {
  return (db.query("SELECT payload FROM events WHERE kind = ?1 ORDER BY seq").all(kind) as { payload: string }[]).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
}

type Barrier = ReturnType<typeof barrier>;

/** A barrier the fake parks an agentStatus read on: `reached` once it is held, `open()` lets it through. */
function barrier() {
  let open!: () => void;
  let reached!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const held = new Promise<void>((resolve) => (reached = resolve));
  return {
    reached: held,
    open,
    async hold(): Promise<void> {
      reached();
      await opened;
    },
  };
}

function makePreempter(): UrgentPreempter {
  const runtime = {
    agentStatus: async () => {
      const gate = statusGates.shift();
      if (gate) await gate.hold();
      if (statusDelayMs > 0) await Bun.sleep(statusDelayMs);
      return herdrStatus;
    },
  } as unknown as HerdrRuntime;
  preempter = new UrgentPreempter({
    db,
    timing: () => timing,
    now: () => Date.now(),
    runtime: () => runtime,
    interrupt: async () => {
      interrupts++;
      return interruptResult;
    },
    log: () => {},
    recheckMs: 30,
  });
  return preempter;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-urgent-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  interrupts = 0;
  interruptResult = { ok: true, evidence: "transcript" };
  herdrStatus = "working";
  statusDelayMs = 0;
  statusGates = [];
  preempter = null;
  tx(db, () => {
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('p', '', '/p', 'main', 'local-only')").run();
  });
  seedRun("r1", "claude");
});

afterEach(() => {
  preempter?.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the tool tracker", () => {
  test("the oldest running tool counts; an end removes one; a restart gives every running tool a fresh clock", () => {
    const tools = new ToolTracker();
    expect(tools.oldest("r")).toBeNull();
    tools.start("r", "a", 100);
    tools.start("r", "b", 50);
    tools.start("r", "a", 500);
    expect(tools.oldest("r")).toBe(50);
    tools.end("r", "b");
    expect(tools.oldest("r")).toBe(100);
    tools.restart("r", 900);
    expect(tools.oldest("r")).toBe(900);
    tools.clear("r");
    expect(tools.oldest("r")).toBeNull();
  });
});

describe("urgent steer rows", () => {
  test("an urgent steer is due for the block, a preemption candidate until seen, and shows as urgent", () => {
    const plain = tx(db, () => createSteer(db, getRun(db, "r1")!, "plain", Date.now()));
    expect(dueUrgent(db, "r1", Date.now(), timing)).toBeNull();
    const urgent = urgentSteer();
    expect(getMessage(db, urgent.id)!.urgent).toBe(1);
    expect(events("steer.created").at(-1)).toMatchObject({ steer: urgent.id, urgent: true });
    expect(dueUrgent(db, "r1", Date.now(), timing)!.id).toBe(urgent.id);
    expect(preemptCandidate(db, "r1")!.id).toBe(urgent.id);
    tx(db, () => markRung(db, urgent, getRun(db, "r1")!, "pre-tool", Date.now(), false, timing));
    expect(dueUrgent(db, "r1", Date.now(), timing)).toBeNull();
    expect(preemptCandidate(db, "r1")!.id).toBe(urgent.id);
    expect(steerStatus(getMessage(db, urgent.id)!, Date.now())).toStartWith("urgent, carried +");
    tx(db, () => ackSteer(db, getRun(db, "r1")!, getMessage(db, plain.id)!, Date.now()));
    expect(steerBrief(db, "r1", Date.now())).toStartWith(`${urgent.id} urgent unseen`);
    tx(db, () => markSeen(db, getRun(db, "r1")!, null, "post-tool", Date.now()));
    expect(preemptCandidate(db, "r1")).toBeNull();
  });

  test("a Pi turn that settles with an urgent steer it queued unseen loses it; one delivered to an idle agent stays carried", () => {
    seedRun("r2", "pi");
    const queued = urgentSteer("r2");
    const run = getRun(db, "r2")!;
    tx(db, () => markRung(db, queued, run, "extension", Date.now(), false, timing));
    tx(db, () => noteDeliveryMode(db, run, queued.id, "steer", Date.now()));
    const idle = urgentSteer("r2", "second");
    tx(db, () => markRung(db, idle, run, "extension", Date.now(), true, timing));
    tx(db, () => noteDeliveryMode(db, run, idle.id, "followUp", Date.now()));
    expect(tx(db, () => loseUnseenUrgent(db, run, Date.now()))).toEqual([queued.id]);
    expect(getMessage(db, queued.id)!.ring_state).toBe("lost");
    expect(getMessage(db, idle.id)!.ring_state).toBe("carried");
  });
});

describe("the Claude preempter", () => {
  test("a tool already past the threshold is cut at once; the steer has had its one cut", async () => {
    const steer = urgentSteer();
    const p = makePreempter();
    p.tools.start("r1", "toolu_1", Date.now() - 5_000);
    p.kick("r1");
    await waitUntil(() => interrupts === 1, 2_000, "the interrupt");
    await waitUntil(() => getMessage(db, steer.id)!.preempted_at !== null, 2_000, "preempted_at");
    expect(events("steer.preempted")[0]).toMatchObject({ steer: steer.id, via: "escape", verified: true });
    expect(Number(events("steer.preempted")[0]!.tool_ms)).toBeGreaterThanOrEqual(5_000);
    expect(steerStatus(getMessage(db, steer.id)!, Date.now())).toContain("cut a tool +");
    expect(p.tools.oldest("r1")).toBeNull();
    // A second kick finds nothing to cut for: one cut per urgent steer.
    p.tools.start("r1", "toolu_2", Date.now() - 5_000);
    p.kick("r1");
    await Bun.sleep(100);
    expect(interrupts).toBe(1);
  });

  test("a young tool is cut when it reaches the threshold, not before", async () => {
    urgentSteer();
    const p = makePreempter();
    const started = Date.now();
    p.tools.start("r1", "toolu_1", started);
    p.kick("r1");
    await Bun.sleep(AFTER_MS - 60);
    expect(interrupts).toBe(0);
    await waitUntil(() => interrupts === 1, 2_000, "the interrupt");
    expect(Date.now() - started).toBeGreaterThanOrEqual(AFTER_MS);
  });

  test("a tool that ends before the threshold is never cut; the normal carry at its end delivers the steer", async () => {
    urgentSteer();
    const p = makePreempter();
    p.tools.start("r1", "toolu_1", Date.now());
    p.kick("r1");
    p.tools.end("r1", "toolu_1");
    p.kick("r1");
    await Bun.sleep(AFTER_MS + 100);
    expect(interrupts).toBe(0);
  });

  test("a normal steer never cuts a tool, nor does an urgent one to a Pi run (its extension times that)", async () => {
    tx(db, () => createSteer(db, getRun(db, "r1")!, "plain", Date.now()));
    seedRun("r2", "pi");
    urgentSteer("r2");
    const p = makePreempter();
    p.tools.start("r1", "toolu_1", Date.now() - 5_000);
    p.tools.start("r2", "call_1", Date.now() - 5_000);
    p.kick("r1");
    p.kick("r2");
    await Bun.sleep(150);
    expect(interrupts).toBe(0);
  });

  test("dialog open (blocked_dialog): no interrupt at all, one deferral event, and the cut goes once the dialog is gone", async () => {
    const steer = urgentSteer();
    tx(db, () => setLiveness(db, getRun(db, "r1")!, "blocked_dialog", "hook", {}, Date.now()));
    const p = makePreempter();
    p.tools.start("r1", "toolu_1", Date.now() - 5_000);
    p.kick("r1");
    await Bun.sleep(250);
    expect(interrupts).toBe(0);
    expect(events("steer.preempt_deferred")).toEqual([{ steer: steer.id, reason: "the worker is blocked on a dialog; answer it in its pane" }]);
    tx(db, () => setLiveness(db, getRun(db, "r1")!, "busy", "hook", {}, Date.now()));
    await waitUntil(() => interrupts === 1, 2_000, "the interrupt after the dialog");
  });

  test("dialog open (blocked_prompt) with Herdr reading blocked: held; reading working releases it and the tool's clock restarts", async () => {
    const steer = urgentSteer();
    tx(db, () => openBlockedPrompt(db, getRun(db, "r1")!, { suspected: false, screen: "Do you want to proceed?", harness: "claude", lastHook: 0 }, Date.now()));
    herdrStatus = "blocked";
    const p = makePreempter();
    p.tools.start("r1", "toolu_1", Date.now() - 5_000);
    p.kick("r1");
    await Bun.sleep(200);
    expect(interrupts).toBe(0);
    expect(events("steer.preempt_deferred")).toHaveLength(1);
    herdrStatus = "working";
    const released = Date.now();
    await waitUntil(() => events("run.prompt_cleared").length === 1, 2_000, "the prompt cleared");
    expect(getRun(db, "r1")!.liveness).toBe("busy");
    await waitUntil(() => interrupts === 1, 2_000, "the interrupt");
    // The approved tool got its own threshold from the release, not from its PreToolUse.
    expect(Date.now() - released).toBeGreaterThanOrEqual(AFTER_MS - 40);
    expect(getMessage(db, steer.id)!.preempted_at).not.toBeNull();
  });

  test("a kick while an attempt reads Herdr (the hook that resolved the dialog) starts no second interrupt", async () => {
    const steer = urgentSteer();
    tx(db, () => openBlockedPrompt(db, getRun(db, "r1")!, { suspected: false, screen: "Do you want to proceed?", harness: "claude", lastHook: 0 }, Date.now()));
    herdrStatus = "blocked";
    statusDelayMs = 150;
    const p = makePreempter();
    p.tools.start("r1", "toolu_1", Date.now() - 5_000);
    p.kick("r1");
    await Bun.sleep(50);
    tx(db, () => {
      resolveRunItems(db, "r1", ["blocked_prompt"], "hook tool", Date.now());
      setLiveness(db, getRun(db, "r1")!, "busy", "hook", {}, Date.now());
    });
    p.kick("r1");
    await waitUntil(() => getMessage(db, steer.id)!.preempted_at !== null, 2_000, "the cut");
    await Bun.sleep(300);
    expect(interrupts).toBe(1);
    expect(events("steer.preempted")).toHaveLength(1);
  });

  test("a replacement worker started while the dialog-gone read was in flight keeps its own liveness; the re-plan releases on a fresh read", async () => {
    urgentSteer();
    tx(db, () => openBlockedPrompt(db, getRun(db, "r1")!, { suspected: false, screen: "Do you want to proceed?", harness: "claude", lastHook: 0 }, Date.now()));
    herdrStatus = "working";
    const stale = barrier();
    const replan = barrier();
    statusGates = [stale, replan];
    const p = makePreempter();
    p.tools.start("r1", "toolu_1", Date.now() - 5_000);
    p.kick("r1");
    await stale.reached;
    tx(db, () => db.query("UPDATE runs SET proc_pid = 4242, proc_start = ?1, launched_at = ?1, liveness = 'starting', busy_until = NULL WHERE id = 'r1'").run(Date.now()));
    stale.open();
    await replan.reached;
    expect(events("run.observation_stale")).toHaveLength(1);
    expect(events("run.observation_stale")[0]).toMatchObject({ transition: "dialog_gone" });
    expect(events("run.prompt_cleared")).toHaveLength(0);
    expect(getRun(db, "r1")!.liveness).toBe("starting");
    // The re-plan reads the replacement worker afresh: Herdr still reads working, so its release is current truth.
    replan.open();
    await waitUntil(() => events("run.prompt_cleared").length === 1, 2_000, "the fresh release");
    expect(getRun(db, "r1")!.liveness).toBe("busy");
    expect(getRun(db, "r1")!.proc_pid).toBe(4242);
    expect(events("run.observation_stale")).toHaveLength(1);
  });

  test("the interrupt gate refusing (Herdr saw a dialog) defers and tries again; a key sent but unverified is the one cut", async () => {
    const steer = urgentSteer();
    interruptResult = { ok: false, evidence: "refused", detail: "Herdr reads the worker blocked on a dialog; answer it in its pane" };
    const p = makePreempter();
    p.tools.start("r1", "toolu_1", Date.now() - 5_000);
    p.kick("r1");
    await waitUntil(() => interrupts >= 3, 2_000, "retries");
    expect(events("steer.preempt_deferred")).toHaveLength(1);
    expect(getMessage(db, steer.id)!.preempted_at).toBeNull();
    interruptResult = { ok: false, evidence: "timeout" };
    await waitUntil(() => getMessage(db, steer.id)!.preempted_at !== null, 2_000, "the cut");
    const count = interrupts;
    await Bun.sleep(150);
    expect(interrupts).toBe(count);
    expect(events("steer.preempted")[0]).toMatchObject({ verified: false });
  });
});

describe("hook preempt (Pi)", () => {
  function pi() {
    seedRun("r2", "pi");
    return getRun(db, "r2")!;
  }

  test("go marks the steer preempted; a second ask is refused", () => {
    const run = pi();
    const steer = urgentSteer("r2");
    const log = new DeferralLog();
    expect(tx(db, () => piPreempt(db, run, steer.id, 4_000, timing, log, Date.now()))).toEqual({ go: true });
    expect(events("steer.preempted")[0]).toMatchObject({ steer: steer.id, via: "abort", tool_ms: 4_000 });
    expect(tx(db, () => piPreempt(db, run, steer.id, 4_000, timing, log, Date.now()))).toMatchObject({ go: false });
  });

  test("a dialog may be open: defer, recorded once however often the extension asks", () => {
    const run = pi();
    const steer = urgentSteer("r2");
    tx(db, () => openBlockedPrompt(db, run, { suspected: true, screen: null, harness: "pi", lastHook: 0 }, Date.now()));
    const log = new DeferralLog();
    for (let i = 0; i < 3; i++) expect(tx(db, () => piPreempt(db, getRun(db, "r2")!, steer.id, 4_000, timing, log, Date.now()))).toHaveProperty("defer");
    expect(events("steer.preempt_deferred")).toHaveLength(1);
    expect(getMessage(db, steer.id)!.preempted_at).toBeNull();
  });

  test("no for a tool under the threshold, a seen or acknowledged steer, a normal steer, another run's steer", () => {
    const run = pi();
    const log = new DeferralLog();
    const steer = urgentSteer("r2");
    expect(tx(db, () => piPreempt(db, run, steer.id, AFTER_MS - 1, timing, log, Date.now()))).toMatchObject({ go: false });
    const plain = tx(db, () => createSteer(db, run, "plain", Date.now()));
    expect(tx(db, () => piPreempt(db, run, plain.id, 4_000, timing, log, Date.now()))).toMatchObject({ go: false });
    const other = urgentSteer("r1");
    expect(tx(db, () => piPreempt(db, run, other.id, 4_000, timing, log, Date.now()))).toMatchObject({ go: false });
    tx(db, () => markRung(db, steer, run, "extension", Date.now(), false, timing));
    tx(db, () => markSeen(db, run, [steer.id], "context", Date.now()));
    expect(tx(db, () => piPreempt(db, run, steer.id, 4_000, timing, log, Date.now()))).toMatchObject({ go: false, reason: "already seen" });
    expect(events("steer.preempted")).toEqual([]);
  });
});
