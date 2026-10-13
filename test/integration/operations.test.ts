/**
 * Durable lifecycle operations end to end (docs/notes/2026-10-13-next-steps-md-rz.md):
 * the daemon is killed with SIGKILL at a lifecycle boundary and restarted over
 * the same home, against the fake Herdr. The boundary is held deterministically:
 * the fake Herdr's `holdStarts` answers agent.start and keeps the harness back,
 * and a worker that ignores SIGTERM keeps a cancel's stop in its grace period.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Envelope, Reply } from "../../src/api/envelope.ts";
import { socketPath } from "../../src/config/paths.ts";
import { tx } from "../../src/db/db.ts";
import { requestCancel, type OperationRow } from "../../src/lifecycle/operations.ts";
import { request } from "../../src/transport/unix.ts";
import { ulid } from "../../src/util/ulid.ts";
import { PROTO } from "../../src/version.ts";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { waitUntil } from "../helpers/harness.ts";

const envs: FleetEnv[] = [];
afterEach(async () => {
  for (const f of envs.splice(0)) await f.cleanup();
});

async function fleet(timing: Record<string, number> = {}): Promise<FleetEnv> {
  const f = await makeFleetEnv({ timing: { launch_timeout_ms: 4_000, ...timing } });
  envs.push(f);
  return f;
}

function operations(f: FleetEnv, runId: string): OperationRow[] {
  const db = f.h.db();
  try {
    return db.query("SELECT * FROM operations WHERE run_id = ?1 ORDER BY created_at, rowid").all(runId) as OperationRow[];
  } finally {
    db.close();
  }
}

function agentStarts(f: FleetEnv): number {
  return f.herdr.calls.filter((c) => c.method === "agent.start").length;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** One envelope with a fixed ULID, sent as the CLI would: the same call twice is the same request. */
function call(f: FleetEnv, envelope: Envelope): Promise<Reply> {
  return request(socketPath(f.h.home, f.h.env), envelope, { connectMs: 1_000, replyMs: 30_000 }) as Promise<Reply>;
}

describe("a daemon killed right after agent.start", () => {
  test("the restart adopts the candidate in the recorded pane: one agent.start, one confirmed operation", async () => {
    const f = await fleet();
    f.herdr.holdStarts = true;
    const { run } = await f.dispatch("FAKE: stall\n");
    await waitUntil(() => operations(f, run)[0]?.phase === "effect_issued" && agentStarts(f) === 1, 15_000, "the launch to issue agent.start");
    await f.daemon.kill9();
    // The start the dead daemon sent comes up now, with no daemon watching it.
    f.herdr.releaseStarts();
    await f.restartDaemon();
    const adopted = await f.waitRun(run, (r) => r.state === "running" && r.proc_pid !== null, "the candidate adopted");
    expect(adopted.proc_pid).toBe(f.herdr.harnessPid(adopted.pane_id!)!);
    expect(agentStarts(f)).toBe(1);
    const ops = operations(f, run);
    expect(ops.map((o) => [o.kind, o.phase, o.attempts])).toEqual([["launch", "confirmed", 1]]);
    expect(ops[0]!.detail).toContain("recovered candidate");
    expect(ops[0]!.proc_pid).toBe(adopted.proc_pid);
  }, 90_000);

  test("a start that never came up is issued again once the launch timeout passes, under the same operation", async () => {
    const f = await fleet();
    f.herdr.holdStarts = true;
    const { run } = await f.dispatch("FAKE: stall\n");
    await waitUntil(() => operations(f, run)[0]?.phase === "effect_issued" && agentStarts(f) === 1, 15_000, "the launch to issue agent.start");
    await f.daemon.kill9();
    // The held start never spawns: its pane shows only the shell.
    f.herdr.holdStarts = false;
    await f.restartDaemon();
    const started = await f.waitRun(run, (r) => r.state === "running" && r.proc_pid !== null, "the launch issued again", 30_000);
    expect(started.proc_pid).toBe(f.herdr.harnessPid(started.pane_id!)!);
    expect(agentStarts(f)).toBe(2);
    expect(operations(f, run).map((o) => [o.kind, o.phase, o.attempts])).toEqual([["launch", "confirmed", 2]]);
    expect(f.events(run)).toContain("operation.reissued");
  }, 90_000);
});

describe("a cancel that lands while the launcher waits for its agent", () => {
  test("the launcher stops the worker it started, and the cancel finishes: no worker survives a cancelled run", async () => {
    const f = await fleet();
    f.herdr.holdStarts = true;
    const { run } = await f.dispatch("FAKE: stall\n");
    await waitUntil(() => operations(f, run)[0]?.phase === "effect_issued" && agentStarts(f) === 1, 15_000, "the launch to issue agent.start");
    // A cancel's intent commits now (what its apply writes); its stop has not run yet.
    const db = f.h.db();
    try {
      tx(db, () => requestCancel(db, { id: run, task_id: f.run(run).task_id }, { id: ulid(), by: "leader", reason: "test", source: "cli", now: Date.now() }));
    } finally {
      db.close();
    }
    f.herdr.releaseStarts();
    const pane = f.run(run).pane_id!;
    await f.waitRun(run, (r) => r.state === "cancelled", "the cancel to finish");
    await waitUntil(() => f.herdr.harnessPid(pane) === null, 10_000, "the superseded worker stopped");
    expect(f.events(run)).toContain("run.launch_superseded");
    expect(operations(f, run).map((o) => [o.kind, o.phase])).toEqual([
      ["launch", "failed"],
      ["cancel", "confirmed"],
    ]);
  }, 90_000);
});

describe("a daemon killed while a cancel stops the worker", () => {
  test("the restart finishes the cancel: the worker is stopped, the run cancelled and never resumed", async () => {
    const f = await fleet({ exit_grace_ms: 4_000 });
    const { run, task } = await f.dispatch("FAKE: ignore-term\nFAKE: stall\n");
    const live = await f.waitRun(run, (r) => r.proc_pid !== null && r.worker_started_at !== null, "the worker to start");
    const pid = live.proc_pid!;
    const cancelling = f.json(["cancel", task]);
    // The intent is committed and the stop is issued; the worker shrugs off SIGTERM, so the stop waits out its grace.
    await waitUntil(() => operations(f, run).some((o) => o.kind === "cancel" && o.phase === "effect_issued"), 10_000, "the cancel's stop");
    await f.daemon.kill9();
    await cancelling;
    expect(alive(pid)).toBe(true);
    expect(f.run(run).state).toBe("running");

    await f.restartDaemon();
    await f.waitRun(run, (r) => r.state === "cancelled", "the cancel finished after the restart", 30_000);
    await waitUntil(() => !alive(pid), 10_000, "the worker gone");
    expect(f.events(run)).not.toContain("run.auto_resumed");
    expect(agentStarts(f)).toBe(1);
    const cancel = operations(f, run).find((o) => o.kind === "cancel")!;
    expect(cancel.phase).toBe("confirmed");
    expect(cancel.attempts).toBeGreaterThanOrEqual(2);
  }, 90_000);
});

describe("the same resume request twice", () => {
  test("concurrent, and replayed after a restart, it starts exactly one worker", async () => {
    const f = await fleet();
    const { run, task } = await f.dispatch("FAKE: stall\n");
    const first = await f.waitRun(run, (r) => r.proc_pid !== null && r.worker_started_at !== null, "the worker to start");
    // Two deaths: the one automatic resume, then the run waits for you.
    f.herdr.killHarness(first.pane_id!);
    const second = await f.waitRun(run, (r) => r.resume_count === 1 && r.proc_pid !== null && r.proc_pid !== first.proc_pid && r.worker_started_at !== null, "the automatic resume");
    f.herdr.killHarness(second.pane_id!);
    await f.waitRun(run, (r) => r.liveness === "dead", "the second death");
    const startsBefore = agentStarts(f);

    const envelope: Envelope = { proto: PROTO, ulid: ulid(), verb: "resume", token: f.leader, args: { target: task } };
    const [a, b] = await Promise.all([call(f, envelope), call(f, envelope)]);
    expect(a.ok).toBe(true);
    expect(b).toEqual(a);
    const resumed = await f.waitRun(run, (r) => r.proc_pid !== null && r.proc_pid !== second.proc_pid && r.liveness !== "dead", "the resume");
    expect(agentStarts(f)).toBe(startsBefore + 1);

    await f.daemon.kill9();
    await f.restartDaemon();
    const replay = await call(f, envelope);
    expect(replay.ok).toBe(true);
    expect((replay.data as { operation: string }).operation).toBe(envelope.ulid);
    // A full reconciler pass after the replay: the run is still the one worker it was.
    await waitUntil(() => f.events(run).includes("run.reattached"), 15_000, "the restarted daemon to reattach the worker");
    expect(agentStarts(f)).toBe(startsBefore + 1);
    expect(f.run(run).proc_pid).toBe(resumed.proc_pid);
    const mine = operations(f, run).filter((o) => o.id === envelope.ulid);
    expect(mine.map((o) => [o.kind, o.phase, o.attempts])).toEqual([["resume", "confirmed", 1]]);
  }, 120_000);
});
