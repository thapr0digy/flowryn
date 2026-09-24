import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { REPO_ROOT, realTasksAxi, waitUntil } from "../helpers/harness.ts";
import { Pty } from "../helpers/pty.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";

/**
 * The M5 exit test (design section 17): a two-phase feature runs design,
 * review, build, visual QA, review, ship and merge, and phase 2 starts by
 * itself once phase 1 has landed. The design stage hands in a phase plan with
 * its review page; approving the design approves the plan. The leaders are
 * the M3 fakes that run the real bridge files, the workers M2's fake workers
 * through the real CLI; the review gates pass through each human channel:
 * Claude's prompt, `flowryn approve --gate` in a real pty, Pi's confirm and
 * the board. The live run in a Herdr lab session is scripts/lab/m5-live.sh.
 */

let env: ShipEnv | null = null;
const ptys: Pty[] = [];
const MAIN = join(REPO_ROOT, "src/main.ts");

afterEach(async () => {
  for (const pty of ptys.splice(0)) pty.kill();
  await env?.cleanup();
  env = null;
});

function query<T>(e: ShipEnv, sql: string, ...params: string[]): T[] {
  const db = e.fleet.h.db();
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

function backlogShow(e: ShipEnv, task: string): string {
  return Bun.spawnSync([realTasksAxi(), "show", task, "--file", e.fleet.h.backlog]).stdout.toString();
}

const PHASE_ONE = (name: string) =>
  [
    `Checkout ${name}`,
    `FAKE: plan-phase ${name} phase two`,
    `FAKE: stage-done --review https://lavish.test/${name}/design --plan-file $FLOWRYN_REPORT_DIR/plan.md`,
    `FAKE: commit ${name}-api.txt api`,
    "FAKE: stage-done",
    `FAKE: docker-up ${name}-web flowryn-${name}`,
    "FAKE: sleep 500",
    `FAKE: docker-down ${name}-web`,
    `FAKE: stage-done --review https://lavish.test/${name}/qa`,
    "FAKE: deliver-local",
    "FAKE: sleep 600000",
  ].join("\n");

async function dispatchPhaseOne(e: ShipEnv, name: string): Promise<{ task: string; run: string }> {
  expect((await e.fleet.json(["project", "set", "web", "--workflow", "feature"], { env: { FLOWRYN_TOKEN: e.leaderToken() } })).code).toBe(0);
  const r = await e.fleet.json(["dispatch", "web", "--kind", "ship", "--body-file", "-"], { env: { FLOWRYN_TOKEN: e.leaderToken() }, stdin: PHASE_ONE(name) });
  expect(r.code).toBe(0);
  return r.reply.data as { task: string; run: string };
}

/** The design review opened with the plan pending on it: nothing of phase 2 is in the backlog yet. */
async function designReviewWithPlan(e: ShipEnv, run: string): Promise<{ plan: string }> {
  await e.fleet.waitRun(run, (r) => r.stage === "design" && r.stage_state === "review", "the design review");
  const plan = query<{ id: string; state: string }>(e, "SELECT id, state FROM plans")[0]!;
  expect(plan.state).toBe("pending");
  const phase = query<{ task_id: string }>(e, "SELECT task_id FROM plan_phases WHERE plan_id = ?1", plan.id)[0]!;
  expect(backlogShow(e, phase.task_id)).toContain("NOT_FOUND");
  return { plan: plan.id };
}

/** Phase 2 is filed Queued behind phase 1 once the design passed, and does not start before phase 1 lands. */
async function phaseTwoQueued(e: ShipEnv, plan: string, phaseOne: string): Promise<string> {
  expect(query<{ state: string }>(e, "SELECT state FROM plans WHERE id = ?1", plan)[0]!.state).toBe("approved");
  const phase2 = query<{ task_id: string }>(e, "SELECT task_id FROM plan_phases WHERE plan_id = ?1", plan)[0]!.task_id;
  await waitUntil(() => /state:\s*queued/.test(backlogShow(e, phase2)), 15_000, "phase 2 in the backlog");
  expect(backlogShow(e, phase2)).toContain(phaseOne);
  return phase2;
}

async function merged(e: ShipEnv, run: string, task: string): Promise<void> {
  await e.fleet.waitRun(run, (r) => r.state === "cleaned", `${task} cleaned`, 30_000);
  await waitUntil(() => /^\s*state:\s*done/m.test(backlogShow(e, task)), 20_000, `${task} done`);
}

describe("M5 exit: a two-phase feature, phase 2 by itself", () => {
  test(
    "Claude leader: design (Claude's prompt), build, visual QA (flowryn approve --gate in your terminal), ship, merge; then phase 2 starts by itself",
    async () => {
      env = await makeShipEnv({ mode: "local-only" });
      const e = env;
      const leader = await e.claude();
      await leader.start();
      const { task, run } = await dispatchPhaseOne(e, "alpha");
      const { plan } = await designReviewWithPlan(e, run);

      const pass = await leader.runBash(`flowryn gate pass ${task} --json`, { approve: true });
      expect(pass).toMatchObject({ prompted: true, ran: true, code: 0 });
      // Approving the design approves the plan it carries: the prompt says so.
      expect(leader.prompts.at(-1)).toContain(`it also approves plan ${plan}, 1 phase`);
      expect(JSON.parse(pass.stdout).data).toMatchObject({ stage: "design", channel: "claude-ask", plan });
      const phase2 = await phaseTwoQueued(e, plan, task);

      await e.fleet.waitRun(run, (r) => r.stage === "qa" && r.stage_state === "review", "the QA review");
      const pty = Pty.spawn(["bun", MAIN, "approve", task, "--gate", "qa"], e.fleet.h.env, REPO_ROOT);
      ptys.push(pty);
      const [, code] = await pty.waitFor(/Type ([A-Z]{4}) to approve/);
      expect(pty.text()).toContain(`Pass the qa review of ${task}`);
      expect(pty.text()).toContain("https://lavish.test/alpha/qa");
      await pty.type(`${code}\n`);
      expect(await pty.exited).toBe(0);

      await e.fleet.waitRun(run, (r) => r.state === "ready", "phase 1 delivered");
      // Delivered is not landed: phase 2 never builds on unmerged work.
      await Bun.sleep(1_000);
      expect(query(e, "SELECT 1 FROM runs WHERE task_id = ?1", phase2)).toEqual([]);
      const merge1 = await leader.runBash(`flowryn merge ${task} --json`, { approve: true });
      expect(merge1.code).toBe(0);
      await merged(e, run, task);

      // Phase 2 starts by itself, with one informational line, and ships the same way.
      await waitUntil(() => query(e, "SELECT 1 FROM runs WHERE task_id = ?1", phase2).length === 1, 20_000, "phase 2 to start by itself");
      const started = query<{ line: string; class: string }>(e, "SELECT line, class FROM items WHERE kind = 'phase_started' AND task_id = ?1", phase2)[0]!;
      expect(started.class).toBe("info");
      expect(started.line).toContain(`Phase 2 of 2 in "`);
      expect(started.line).toContain("started by itself");
      const run2 = query<{ id: string; workflow: string }>(e, "SELECT id, workflow FROM runs WHERE task_id = ?1", phase2)[0]!;
      expect(run2.workflow).toBe("fix");
      expect(query<{ kind: string }>(e, "SELECT kind FROM events WHERE task_id = ?1 AND kind = 'phase.started'", phase2)).toHaveLength(1);
      await e.fleet.waitRun(run2.id, (r) => r.state === "ready", "phase 2 delivered");
      const merge2 = await leader.runBash(`flowryn merge ${phase2} --json`, { approve: true });
      expect(merge2.code).toBe(0);
      await merged(e, run2.id, phase2);
      const shown = await e.fleet.json(["show", plan], { env: { FLOWRYN_TOKEN: e.leaderToken() } });
      expect(JSON.stringify(shown.reply.data)).toContain("cleaned");
    },
    { timeout: 180_000 },
  );

  test(
    "Pi leader: the shell cannot pass a gate; the flowryn_gate_pass confirm does (no leaves it open); the board passes the QA review",
    async () => {
      env = await makeShipEnv({ mode: "local-only" });
      const e = env;
      const leader = await e.pi();
      await leader.start();
      const { task, run } = await dispatchPhaseOne(e, "beta");
      const { plan } = await designReviewWithPlan(e, run);

      expect((await leader.bash(`flowryn gate pass ${task}`)).blocked).toBe(true);
      const no = await leader.callTool("flowryn_gate_pass", { task }, false);
      expect(no).toContain("declined");
      expect(leader.confirms.at(-1)!.message).toContain("https://lavish.test/beta/design");
      expect(leader.confirms.at(-1)!.message).toContain(`also approves plan ${plan}, 1 phase`);
      expect(e.fleet.run(run).stage_state).toBe("review");
      const yes = await leader.callTool("flowryn_gate_pass", { task }, true);
      expect(yes).toContain(`Passed the design review of ${task}`);
      await phaseTwoQueued(e, plan, task);

      await e.fleet.waitRun(run, (r) => r.stage === "qa" && r.stage_state === "review", "the QA review");
      const board = Pty.spawn(["bun", MAIN, "board"], e.fleet.h.env, REPO_ROOT);
      ptys.push(board);
      await board.waitFor(/a approve a merge or review/);
      await board.type("a");
      await board.waitFor(new RegExp(`1\\. ${task}.*\\(qa review\\)`));
      await board.type("1\r");
      const [, code] = await board.waitFor(/Type ([A-Z]{4}) to approve/);
      await board.type(`${code}\r`);
      await board.waitFor(/The qa review passed/);
      await board.type("\r");
      await board.waitFor(/a approve a merge or review[\s\S]*a approve a merge or review/);
      await board.type("q");
      expect(await board.exited).toBe(0);

      await e.fleet.waitRun(run, (r) => r.state === "ready", "phase 1 delivered");
      const channels = query<{ stage: string; channel: string }>(e, "SELECT g.stage, a.channel FROM gates g JOIN approvals a ON a.id = g.approval_id WHERE g.run_id = ?1 AND g.kind = 'review' ORDER BY g.opened_at", run);
      expect(channels).toEqual([
        { stage: "design", channel: "pi-confirm" },
        { stage: "qa", channel: "board" },
      ]);
    },
    { timeout: 180_000 },
  );
});
