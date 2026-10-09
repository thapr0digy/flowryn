import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FleetEnv } from "../helpers/fleet-env.ts";
import { waitUntil } from "../helpers/harness.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";

/**
 * The CI-wait watchdog end to end (task pipeline-watchdog-and-pt): a
 * no-mistakes ship through the real CLI, the fake Herdr and worker, a fake
 * GitHub whose PR has no checks (Actions off), and the test homes'
 * no-mistakes stand-in reporting the pipeline in its `ci` step past
 * `[validation] ci_wait_alert`. The daemon opens one decision reserved for
 * the user; the Claude leader relays the user's answer; the worker gets the
 * steer that carries it out.
 */

let ship: ShipEnv | null = null;

afterEach(async () => {
  await ship?.cleanup();
  ship = null;
});

const T = 120_000;

function rows<R>(f: FleetEnv, sql: string, ...params: string[]): R[] {
  const db = f.h.db();
  try {
    return db.query(sql).all(...params) as R[];
  } finally {
    db.close();
  }
}

interface Wait {
  id: string;
  state: string;
  answer: string | null;
  recommendation: string;
  question: string;
}

function ciWaits(f: FleetEnv, run: string): Wait[] {
  return rows<Wait>(f, "SELECT id, state, answer, recommendation, question FROM decisions WHERE origin = 'ci-wait' AND run_id = ?1 ORDER BY created_at", run);
}

function steers(f: FleetEnv, run: string): string[] {
  return rows<{ body: string }>(f, "SELECT body FROM messages WHERE run_id = ?1 ORDER BY created_at, id", run).map((m) => m.body);
}

/** A ship whose PR is open with no checks, its pipeline waiting in `ci` for 90 min, the worker waiting for `go` before it delivers. */
async function stalledShip(e: ShipEnv): Promise<{ task: string; run: string }> {
  const f = e.fleet;
  e.github.repo("acme/web").defaultChecks = [];
  const steps = ["Waits on CI", "FAKE: commit b.txt b", "FAKE: verb stage begin ship", "FAKE: push", `FAKE: pr ${e.github.apiUrl} acme/web`, "FAKE: wait-file go", "FAKE: deliver-pr", "FAKE: sleep 600000"].join("\n");
  const { task, run } = await f.dispatch(steps, { kind: "ship" });
  await waitUntil(() => e.github.repo("acme/web").prs.length === 1, 30_000, "the PR");
  const branch = f.run(run).branch;
  writeFileSync(
    join(f.h.home, "nm-status"),
    [
      "run:",
      '  id: "01NMSTALL"',
      `  branch: ${branch}`,
      "  status: running",
      "  head: abc",
      `  pr: "${e.github.prUrl("acme/web", 1)}"`,
      "  active_steps[1]{step,status,active_for,last_activity,agent_pid,round}:",
      '    ci,running,1h30m,"1m ago: log: waiting for checks to register","",starting',
      "",
    ].join("\n"),
  );
  await waitUntil(() => ciWaits(f, run).length === 1, 30_000, "the CI-wait decision");
  return { task, run };
}

describe("the CI-wait watchdog", () => {
  test(
    "a stalled ship asks the user once; the leader relays accept-without-ci; the worker is told to end the wait and deliver; the merge prompt names the answer",
    async () => {
      ship = await makeShipEnv({ mode: "no-mistakes" });
      const e = ship;
      const f = e.fleet;
      const { task, run } = await stalledShip(e);
      const leader = await e.claude();
      await leader.start();
      const [d] = ciWaits(f, run);
      expect(d).toMatchObject({ state: "open", recommendation: "keep-waiting" });
      expect(d!.question).toContain("waited 90 min in CI with no checks registered");
      const item = rows<{ id: string; kind: string; line: string }>(f, "SELECT id, kind, line FROM items WHERE decision_id = ?1", d!.id)[0]!;
      expect(item.kind).toBe("worker_question");

      // Reserved: the leader cannot answer it by itself.
      const alone = await leader.runBash(`flowryn decide ${d!.id} accept-without-ci --rationale "CI is off" --json`, { approve: true });
      expect(alone.code).toBe(2);
      expect(alone.stdout).toContain("reserved_decision");

      // The user's word, through Claude's prompt.
      const relayed = await leader.runBash(`flowryn decide ${d!.id} accept-without-ci --by captain --json`, { approve: true });
      expect(relayed).toMatchObject({ prompted: true, ran: true, code: 0 });
      await waitUntil(() => steers(f, run).length === 1, 15_000, "the steer");
      expect(steers(f, run)[0]).toContain("no-mistakes axi abort");
      expect(ciWaits(f, run)[0]).toMatchObject({ state: "answered", answer: "accept-without-ci" });

      // The worker ends the wait (the stand-in's run ends) and delivers a PR with no checks.
      writeFileSync(join(f.h.home, "nm-status"), "run: null\n");
      writeFileSync(join(f.h.dataDir, task, "go"), "");
      await f.waitRun(run, (r) => r.state === "ready", "the delivery", 30_000);
      const no = await leader.runBash(`flowryn merge ${task} --json`, { approve: false });
      expect(no).toMatchObject({ prompted: true, ran: false });
      expect(leader.prompts.at(-1)).toContain(`the user accepted it without CI (${d!.id})`);
      // No second question for the same pipeline run.
      expect(ciWaits(f, run)).toHaveLength(1);
    },
    T,
  );

  test(
    "a question the leader dismisses tells the worker nothing",
    async () => {
      ship = await makeShipEnv({ mode: "no-mistakes" });
      const e = ship;
      const f = e.fleet;
      const { run } = await stalledShip(e);
      const leader = await e.claude();
      await leader.start();
      const [d] = ciWaits(f, run);
      const item = rows<{ id: string }>(f, "SELECT id FROM items WHERE decision_id = ?1", d!.id)[0]!;
      const dismissed = await leader.runBash(`flowryn dismiss ${item.id} --json`, { approve: true });
      expect(dismissed.code).toBe(0);
      expect(ciWaits(f, run)[0]!.state).toBe("dismissed");
      expect(steers(f, run)).toEqual([]);
    },
    T,
  );
});
