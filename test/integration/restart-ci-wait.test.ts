import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RELAY_HEADER } from "../../src/attention/router.ts";
import { tx } from "../../src/db/db.ts";
import type { FleetEnv } from "../helpers/fleet-env.ts";
import { waitUntil } from "../helpers/harness.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";

/**
 * A restart past a validation that only waits on external CI (task
 * leader-stop-hook-yq), end to end: a no-mistakes ship through the real CLI,
 * the fake Herdr and worker, the fake GitHub, the test homes' no-mistakes
 * stand-in (it prints $FLOWRYN_HOME/nm-status) and the script supervisor
 * standing in for launchd. A CI wait does not block the restart, and the new
 * daemon picks the validation up where the old one left it; a step with a
 * local agent blocks, and a dropped `--when-idle` names it to the leader.
 */

let ship: ShipEnv | null = null;

afterEach(async () => {
  await ship?.cleanup();
  ship = null;
});

const T = 120_000;

function nmStatus(branch: string, steps: string[]): string {
  return [
    "run:",
    '  id: "01NMCI"',
    `  branch: ${branch}`,
    "  status: running",
    "  head: abc",
    '  pr: ""',
    `  active_steps[${steps.length}]{step,status,active_for,last_activity,agent_pid,round}:`,
    ...steps.map((s) => `    ${s}`),
    "",
  ].join("\n");
}

const CI_WAIT = 'ci,running,2h17m,"9m24s ago: log: waiting for checks to register","",starting';
const REVIEW = 'review,running,42m,"1m ago: agent: reading src/a.ts",81234,1';

function rows<T>(f: FleetEnv, sql: string, ...params: string[]): T[] {
  const db = f.h.db();
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

function liveValidation(f: FleetEnv): string[] {
  return rows<{ run_id: string }>(f, "SELECT run_id FROM pool_leases WHERE pool = 'validation' AND released_at IS NULL").map((r) => r.run_id);
}

function eventTs(f: FleetEnv, kind: string): number[] {
  return rows<{ ts: number }>(f, "SELECT ts FROM events WHERE kind = ?1 ORDER BY seq", kind).map((r) => r.ts);
}

/** A ship holding its validation slot, the pipeline running under it, the worker waiting for `go` before it delivers. */
async function validatingShip(e: ShipEnv, active: string[]): Promise<{ task: string; run: string; branch: string }> {
  const f = e.fleet;
  const steps = ["Ships past CI", "FAKE: commit b.txt b", "FAKE: verb stage begin ship", "FAKE: wait-file go", "FAKE: push", `FAKE: pr ${e.github.apiUrl} acme/web`, "FAKE: deliver-pr", "FAKE: sleep 600000"].join("\n");
  const { task, run } = await f.dispatch(steps, { kind: "ship" });
  const started = await f.waitRun(run, (r) => r.stage === "ship" && r.stage_state === "active", "the ship stage");
  writeFileSync(join(f.h.home, "nm-status"), nmStatus(started.branch, active));
  await f.waitRun(run, (r) => r.state === "validating", "validating", 10_000);
  expect(liveValidation(f)).toEqual([run]);
  return { task, run, branch: started.branch };
}

describe("a restart and a validation waiting on CI", () => {
  test(
    "assumption: a CI wait does not block, and the restarted daemon re-attaches to the pipeline and still sees the delivery release the slot",
    async () => {
      ship = await makeShipEnv({ mode: "no-mistakes", supervised: true });
      const e = ship;
      const f = e.fleet;
      const { task, run, branch } = await validatingShip(e, [CI_WAIT]);
      const oldPid = f.daemon.pid;

      const restarted = await f.json(["daemon", "restart"]);
      expect(restarted.code).toBe(0);
      await waitUntil(() => eventTs(f, "daemon.restarted").length === 1, 30_000, "the new daemon to record the restart");
      const at = eventTs(f, "daemon.restarted")[0]!;
      expect((await f.json(["daemon", "status"])).reply.data).toMatchObject({ daemon: "up" });
      expect((rows<{ payload: string }>(f, "SELECT payload FROM events WHERE kind = 'daemon.restarted'").map((r) => JSON.parse(r.payload).old.pid))).toEqual([oldPid]);

      // The slot, the run's state and its stage live in the database: the restart kept them.
      expect(liveValidation(f)).toEqual([run]);
      expect(f.run(run)).toMatchObject({ state: "validating", stage: "ship", stage_state: "active" });
      // The new daemon reads the pipeline's status again, and it flips nothing.
      await waitUntil(() => rows<{ observed_at: number }>(f, "SELECT observed_at FROM run_evidence WHERE run_id = ?1 AND source = 'nomistakes'", run)[0]!.observed_at > at, 15_000, "a status read by the new daemon");
      expect(f.events(run).filter((k) => k === "run.validated" || k === "run.validating")).toEqual(["run.validating"]);

      // CI passes, and the worker delivers: the new daemon releases the slot.
      writeFileSync(join(f.h.home, "nm-status"), `run:\n  id: "01NMCI"\n  branch: ${branch}\n  status: completed\n  head: abc\n  pr: ""\noutcome: passed\n`);
      await f.waitRun(run, (r) => r.state === "running", "running again", 15_000);
      writeFileSync(join(f.h.dataDir, task, "go"), "");
      await f.waitRun(run, (r) => r.state === "ready" && r.stage_state === "done", "the delivery", 30_000);
      expect(liveValidation(f)).toEqual([]);
      expect(rows<{ released_by: string }>(f, "SELECT released_by FROM pool_leases WHERE run_id = ?1 AND pool = 'validation'", run)[0]!.released_by).toBe("stage ship delivered");
    },
    T,
  );

  test(
    "assumption: flowrynd only reads no-mistakes, so a restart owns nothing of the pipeline (its daemon is its own launchd agent)",
    async () => {
      ship = await makeShipEnv({ mode: "no-mistakes", supervised: true });
      const e = ship;
      const f = e.fleet;
      await validatingShip(e, [CI_WAIT]);
      expect((await f.json(["daemon", "restart"])).code).toBe(0);
      await waitUntil(() => eventTs(f, "daemon.restarted").length === 1, 30_000, "the new daemon to record the restart");
      await waitUntil(() => readFileSync(join(f.h.home, "nm-calls.log"), "utf8").split("\n").filter(Boolean).length >= 3, 15_000, "status reads by both daemons");
      const calls = new Set(readFileSync(join(f.h.home, "nm-calls.log"), "utf8").split("\n").filter(Boolean));
      // `axi status` from the watcher (in the worktree, the default run); never a daemon start, a run, or an abort.
      expect([...calls]).toEqual(["axi status"]);
    },
    T,
  );

  test(
    "a step with a local agent blocks, naming the task, the step and its agent; a dropped --when-idle reaches the leader's Stop with that line",
    async () => {
      ship = await makeShipEnv({ mode: "no-mistakes", supervised: true });
      const e = ship;
      const f = e.fleet;
      const { task } = await validatingShip(e, [REVIEW, 'ci,running,3m,"","",starting']);

      const blocked = await f.json(["daemon", "restart"]);
      expect(blocked.code).toBe(2);
      expect(blocked.reply.error).toMatchObject({ code: "restart_blocked" });
      const message = (blocked.reply.error as { message: string }).message;
      expect(message).toContain(`validation: ${task}`);
      expect(message).toContain("no-mistakes step review, running 42m, agent pid 81234");

      // A leader mid-turn; its session start's briefing came before the drop.
      const lead = await e.claude();
      await lead.start();
      await lead.promptBusy("busy");

      // Park it, then let its deadline pass: the daemon drops it with the same line, as a P1 to relay.
      expect((await f.json(["daemon", "restart", "--when-idle"], { env: { FLOWRYN_TOKEN: e.leaderToken() } })).reply.data).toMatchObject({ restart: "pending" });
      const db = f.h.db();
      try {
        tx(db, () => {
          const row = db.query("SELECT value FROM meta WHERE key = 'restart_pending'").get() as { value: string };
          db.query("UPDATE meta SET value = ?1 WHERE key = 'restart_pending'").run(JSON.stringify({ ...JSON.parse(row.value), expires_at: Date.now() - 1 }));
        });
      } finally {
        db.close();
      }
      await waitUntil(() => rows(f, "SELECT 1 FROM items WHERE kind = 'restart_dropped' AND state = 'open'").length === 1, 20_000, "the dropped restart's item");
      const line = rows<{ line: string }>(f, "SELECT line FROM items WHERE kind = 'restart_dropped'")[0]!.line;
      expect(line).toStartWith(`Daemon restart dropped: still waiting on validation: ${task}`);
      expect(line).toContain("no-mistakes step review, running 42m, agent pid 81234");

      // The leader's turn end carries it, once.
      await lead.finishBusy();
      const relayed = lead.seen.filter((s) => s.via === "Stop" && s.text.includes(RELAY_HEADER));
      expect(relayed).toHaveLength(1);
      expect(relayed[0]!.text).toContain("no-mistakes step review, running 42m, agent pid 81234");
      await lead.prompt("next");
      expect(lead.seen.filter((s) => s.text.includes("agent pid 81234"))).toHaveLength(1);
    },
    T,
  );
});
