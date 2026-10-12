import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { RELAY_HEADER } from "../../src/attention/router.ts";
import type { FleetEnv } from "../helpers/fleet-env.ts";
import { waitUntil } from "../helpers/harness.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";

/**
 * A validation slot held with no progress (task stuck-validations-become-y6),
 * end to end: a no-mistakes ship through the real CLI, the fake Herdr and
 * worker, the fake GitHub and the test homes' no-mistakes stand-in (it prints
 * $FLOWRYN_HOME/nm-status). A quiet step opens one validation_stuck P1, a
 * Claude leader's Stop carries its line once, and the item resolves when the
 * step moves; a run that ended with the slot still held opens it too, and the
 * delivery resolves it.
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
    '  id: "01NMSTUCK"',
    `  branch: ${branch}`,
    "  status: running",
    "  head: abc",
    '  pr: ""',
    `  active_steps[${steps.length}]{step,status,active_for,last_activity,agent_pid,round}:`,
    ...steps.map((s) => `    ${s}`),
    "",
  ].join("\n");
}

function rows<T>(f: FleetEnv, sql: string, ...params: string[]): T[] {
  const db = f.h.db();
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

interface StuckItem {
  id: string;
  line: string;
  state: string;
  resolved_by: string | null;
}

function stuckItems(f: FleetEnv, run: string): StuckItem[] {
  return rows<StuckItem>(f, "SELECT id, line, state, resolved_by FROM items WHERE kind = 'validation_stuck' AND run_id = ?1 ORDER BY opened_at, rowid", run);
}

/** A ship holding its validation slot, the pipeline running under it, the worker waiting for `go` before it delivers. */
async function validatingShip(e: ShipEnv, step: string): Promise<{ task: string; run: string; branch: string }> {
  const f = e.fleet;
  const steps = ["Ships past a stall", "FAKE: commit b.txt b", "FAKE: verb stage begin ship", "FAKE: wait-file go", "FAKE: push", `FAKE: pr ${e.github.apiUrl} acme/web`, "FAKE: deliver-pr", "FAKE: sleep 600000"].join("\n");
  const { task, run } = await f.dispatch(steps, { kind: "ship" });
  const started = await f.waitRun(run, (r) => r.stage === "ship" && r.stage_state === "active", "the ship stage");
  writeFileSync(join(f.h.home, "nm-status"), nmStatus(started.branch, [step]));
  await f.waitRun(run, (r) => r.state === "validating", "validating", 10_000);
  return { task, run, branch: started.branch };
}

describe("a validation slot held with no progress", () => {
  test(
    "a quiet step opens one P1, the leader's Stop carries its line once, and the step moving resolves it",
    async () => {
      ship = await makeShipEnv({ mode: "no-mistakes" });
      const e = ship;
      const f = e.fleet;
      const { task, run, branch } = await validatingShip(e, 'review,running,3m,"20s ago: agent: reading src/a.ts",81234,1');
      expect(stuckItems(f, run)).toEqual([]);

      // A leader mid-turn: the stall opens while it works.
      const lead = await e.claude();
      await lead.start();
      await lead.promptBusy("busy");

      writeFileSync(join(f.h.home, "nm-status"), nmStatus(branch, ['review,running,50m,"45m ago: agent: thinking",81234,1', 'ci,running,3m,"","",starting']));
      await waitUntil(() => stuckItems(f, run).length === 1, 15_000, "the validation_stuck item");
      const [item] = stuckItems(f, run);
      expect(item!.state).toBe("open");
      expect(item!.line).toContain(`(web): no-mistakes step review quiet for 45m; flowryn show ${task}`);
      expect(item!.line).toStartWith("Validation stuck: ");

      // The leader's turn end carries it, once.
      await lead.finishBusy();
      const relayed = lead.seen.filter((s) => s.via === "Stop" && s.text.includes(RELAY_HEADER));
      expect(relayed).toHaveLength(1);
      expect(relayed[0]!.text).toContain(`- [${item!.id}] ${item!.line}`);
      await lead.prompt("next");
      expect(lead.seen.filter((s) => s.text.includes("no-mistakes step review quiet for 45m"))).toHaveLength(1);

      // Further reads of the same stall open nothing more.
      await waitUntil(() => rows(f, "SELECT 1 FROM run_evidence WHERE run_id = ?1 AND source = 'nomistakes' AND observed_at > (SELECT opened_at FROM items WHERE id = ?2)", run, item!.id).length === 1, 15_000, "another status read");
      expect(stuckItems(f, run)).toHaveLength(1);

      // The step moves: the item resolves.
      writeFileSync(join(f.h.home, "nm-status"), nmStatus(branch, ['review,running,51m,"5s ago: agent: wrote src/a.ts",81234,1']));
      await waitUntil(() => stuckItems(f, run)[0]!.state === "resolved", 15_000, "the item to resolve");
      expect(stuckItems(f, run)).toEqual([{ ...item!, state: "resolved", resolved_by: "step moved" }]);
      expect(f.events(run).filter((k) => k.startsWith("run.validation_"))).toEqual(["run.validation_stuck", "run.validation_moving"]);
    },
    T,
  );

  test(
    "a run that ended with the slot still held and nothing delivered opens the P1, and the delivery resolves it",
    async () => {
      ship = await makeShipEnv({ mode: "no-mistakes", extraConfig: "[sched]\nvalidation_stuck_ms = 4000" });
      const e = ship;
      const f = e.fleet;
      const { task, run, branch } = await validatingShip(e, 'review,running,1s,"0s ago: agent: starting",81234,1');

      writeFileSync(join(f.h.home, "nm-status"), `run:\n  id: "01NMSTUCK"\n  branch: ${branch}\n  status: completed\n  head: abc\n  pr: ""\noutcome: passed\n`);
      await f.waitRun(run, (r) => r.state === "running", "running again", 15_000);
      await waitUntil(() => stuckItems(f, run).length === 1, 20_000, "the validation_stuck item");
      const [item] = stuckItems(f, run);
      expect(item!.line).toContain(`(web): no-mistakes run 01NMSTUCK ended (passed), quiet for `);
      expect(item!.line).toEndWith(` with the slot held and nothing delivered; flowryn show ${task}`);

      // The worker delivers: the slot is released, and the item with it.
      writeFileSync(join(f.h.dataDir, task, "go"), "");
      await f.waitRun(run, (r) => r.state === "ready" && r.stage_state === "done", "the delivery", 30_000);
      expect(stuckItems(f, run)).toEqual([{ ...item!, state: "resolved", resolved_by: "slot released: stage ship delivered" }]);
    },
    T,
  );

  test(
    "a quiet CI wait: the stall's P1 closes once the CI-wait question asks about it, stays closed, and a later non-CI stall opens a new one",
    async () => {
      ship = await makeShipEnv({ mode: "no-mistakes" });
      const e = ship;
      const f = e.fleet;
      e.github.repo("acme/web").defaultChecks = [];
      const steps = ["Waits on CI quietly", "FAKE: commit b.txt b", "FAKE: verb stage begin ship", "FAKE: push", `FAKE: pr ${e.github.apiUrl} acme/web`, "FAKE: wait-file go", "FAKE: deliver-pr", "FAKE: sleep 600000"].join("\n");
      const { run } = await f.dispatch(steps, { kind: "ship" });
      await waitUntil(() => e.github.repo("acme/web").prs.length === 1, 30_000, "the PR");
      const branch = f.run(run).branch;
      const pr = `pr: "${e.github.prUrl("acme/web", 1)}"`;
      const ciWait = (activeFor: string, quiet: string): string => nmStatus(branch, [`ci,running,${activeFor},"${quiet} ago: log: waiting for checks to register","",starting`]).replace('pr: ""', pr);

      // Quiet past validation_stuck_ms (30 min) but under ci_wait_alert (60 min): only the stall's P1.
      writeFileSync(join(f.h.home, "nm-status"), ciWait("40m", "35m"));
      await waitUntil(() => stuckItems(f, run).length === 1, 15_000, "the validation_stuck item");
      expect(rows(f, "SELECT id FROM decisions WHERE origin = 'ci-wait' AND run_id = ?1", run)).toEqual([]);

      // Past the alert: the CI-wait question opens and the stall's P1 closes in its name.
      writeFileSync(join(f.h.home, "nm-status"), ciWait("1h30m", "1h25m"));
      await waitUntil(() => rows(f, "SELECT id FROM decisions WHERE origin = 'ci-wait' AND run_id = ?1", run).length === 1, 30_000, "the CI-wait question");
      const [q] = rows<{ id: string }>(f, "SELECT id FROM decisions WHERE origin = 'ci-wait' AND run_id = ?1", run);
      const [closed] = stuckItems(f, run);
      expect(closed).toMatchObject({ state: "resolved", resolved_by: `covered by the CI-wait question ${q!.id}` });

      // Later reads of the same wait open nothing.
      await waitUntil(() => rows(f, "SELECT 1 FROM run_evidence WHERE run_id = ?1 AND source = 'nomistakes' AND observed_at > (SELECT created_at FROM decisions WHERE id = ?2)", run, q!.id).length === 1, 15_000, "another status read");
      expect(stuckItems(f, run)).toHaveLength(1);

      // The pipeline moves past CI and stalls elsewhere: a new P1.
      writeFileSync(join(f.h.home, "nm-status"), nmStatus(branch, ['review,running,50m,"45m ago: agent: thinking",81234,1']).replace('pr: ""', pr));
      await waitUntil(() => stuckItems(f, run).length === 2, 15_000, "a second validation_stuck item");
      expect(stuckItems(f, run).map((i) => i.state)).toEqual(["resolved", "open"]);
      expect(f.events(run).filter((k) => k.startsWith("run.validation_"))).toEqual(["run.validation_stuck", "run.validation_covered", "run.validation_stuck"]);
    },
    T,
  );
});
