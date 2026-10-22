/**
 * `flowryn promote` (design sections 4 and 12): a scout promoted to a ship in
 * place. A scout at work keeps its worker, worktree, branch and session (its
 * worker is relaunched into the same session under a ship's contract); a
 * scout whose run is over becomes a ship on the same task with a new run
 * that names its report. The worker is the fake harness.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listTasks, processRunner, type BacklogTask } from "../../src/journal/tasks-axi.ts";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { realTasksAxi, waitUntil } from "../helpers/harness.ts";
import { filledDesignPage } from "../helpers/design-page.ts";

const envs: FleetEnv[] = [];
async function fleet(options: Parameters<typeof makeFleetEnv>[0] = {}): Promise<FleetEnv> {
  const env = await makeFleetEnv(options);
  envs.push(env);
  return env;
}
afterEach(async () => {
  for (const env of envs.splice(0)) await env.cleanup();
});

async function backlogTask(env: FleetEnv, taskId: string): Promise<BacklogTask | null> {
  const tasks = await listTasks(processRunner(realTasksAxi(), Bun.which("node")), env.h.backlog);
  return tasks.find((t) => t.id === taskId) ?? null;
}

function policy(env: FleetEnv, taskId: string): { kind: string; delivery_mode: string; workflow: string } {
  const db = env.h.db();
  try {
    return db.query("SELECT kind, delivery_mode, workflow FROM task_policy WHERE task_id = ?1").get(taskId) as { kind: string; delivery_mode: string; workflow: string };
  } finally {
    db.close();
  }
}

function runDir(env: FleetEnv, runId: string): string {
  return join(env.h.stateDir, "runs", runId);
}

describe("a scout at work", () => {
  test(
    "is promoted with its run: the same worker session resumes as a ship, then builds, delivers and lands",
    async () => {
      const env = await fleet({ yolo: true });
      const { task, run } = await env.dispatch("Scout the login bug\nFAKE: sleep 400\nFAKE: wait-file go\nFAKE: commit fix.txt the fix\nFAKE: deliver-local\nFAKE: sleep 60000");
      const scouting = await env.waitRun(run, (r) => r.liveness === "busy" || r.liveness === "idle", "the scout at work");
      await Bun.sleep(600);
      const session = scouting.agent_session;
      const promoted = await env.json(["promote", task, "--body-file", "-"], { stdin: "Fix the redirect loop you found." });
      expect(promoted.code).toBe(0);
      expect(promoted.reply.data).toMatchObject({ task, run, kind: "ship", workflow: "fix", stage: "build", mode: "local-only" });
      expect(policy(env, task)).toMatchObject({ kind: "ship", delivery_mode: "local-only", workflow: "fix" });

      // The old process stops and the same session resumes, with a ship's contract and the promotion in its task file.
      const relaunched = await env.waitRun(run, (r) => r.proc_pid !== null && r.proc_pid !== scouting.proc_pid && r.pending_launch === null, "the relaunched worker", 20_000);
      expect(relaunched.agent_session).toBe(session);
      expect(relaunched.worktree_path).toBe(scouting.worktree_path);
      expect(relaunched).toMatchObject({ stage: "build", workflow: "fix", state: "running" });
      expect(env.events(run)).toEqual(expect.arrayContaining(["run.promoted", "stage.requested", "run.relaunch", "run.launched"]));
      const start = env.herdr.calls.filter((c) => c.method === "agent.start").at(-1)!;
      const args = start.params.args as string[];
      expect(args).toContain("--resume");
      expect(args.at(-1)).toContain("because your task changed");
      expect(readFileSync(join(runDir(env, run), "contract.md"), "utf8")).toContain("deliver --local");
      const taskFile = readFileSync(join(runDir(env, run), "task.md"), "utf8");
      expect(taskFile).toContain("Your leader promoted this scout to a ship");
      expect(taskFile).toContain("Fix the redirect loop you found.");
      await waitUntil(async () => (await backlogTask(env, task))?.kind === "ship", 10_000, "the backlog kind ship");

      // The ship goes on where the scout stopped: it commits, delivers locally, and merges under yolo.
      writeFileSync(join(env.h.dataDir, task, "go"), "");
      await env.waitRun(run, (r) => r.state === "ready", "the local delivery", 30_000);
      expect((await env.json(["merge", task])).code).toBe(0);
      await env.waitRun(run, (r) => r.state === "cleaned", "landed and cleaned", 30_000);
      await waitUntil(async () => (await backlogTask(env, task))?.state === "done", 10_000, "the task done");
    },
    { timeout: 90_000 },
  );
  test(
    "is refused while its worker is still launching, and promoted once it runs",
    async () => {
      const env = await fleet();
      env.herdr.holdStarts = true;
      const { task, run } = await env.dispatch("Scout the login bug\nFAKE: sleep 60000");
      await waitUntil(() => env.herdr.calls.some((c) => c.method === "agent.start"), 10_000, "the scout's agent.start");
      const early = await env.json(["promote", task]);
      expect(early.code).toBe(2);
      expect(early.reply.error).toMatchObject({ code: "not_ready" });
      expect(policy(env, task).kind).toBe("scout");

      env.herdr.releaseStarts();
      const scouting = await env.waitRun(run, (r) => r.proc_pid !== null && r.state === "running", "the scout running");
      expect(scouting).toMatchObject({ pending_launch: null, stage_note: null });
      const promoted = await env.json(["promote", task]);
      expect(promoted.code).toBe(0);
      await env.waitRun(run, (r) => r.proc_pid !== null && r.proc_pid !== scouting.proc_pid && r.pending_launch === null, "the relaunched worker", 20_000);
      expect(readFileSync(join(runDir(env, run), "task.md"), "utf8")).toContain("Your leader promoted this scout to a ship");
    },
    { timeout: 60_000 },
  );
});

describe("a scout whose run is over", () => {
  test(
    "is promoted as a task: the same id goes back In flight as a ship, and a new run starts that names the report",
    async () => {
      const env = await fleet();
      const { task, run } = await env.dispatch("Scout the cache\nFAKE: deliver notes.md the cache evicts too early\nFAKE: sleep 60000");
      const scout = await env.waitRun(run, (r) => r.state === "cleaned", "the scout cleaned");
      await waitUntil(async () => (await backlogTask(env, task))?.state === "done", 10_000, "the scout's task done");
      const promoted = await env.json(["promote", task, "--body-file", "-"], { stdin: "Raise the eviction threshold." });
      expect(promoted.code).toBe(0);
      const data = promoted.reply.data as { run: string; report: string };
      expect(data.run).not.toBe(run);
      expect(data.report).toBe(join(env.h.dataDir, task, "report.md"));
      const ship = await env.waitRun(data.run, (r) => r.worker_started_at !== null, "the ship's worker started", 20_000);
      expect(ship.task_id).toBe(task);
      expect(ship.worktree_path).toBe(scout.worktree_path);
      expect(existsSync(ship.worktree_path)).toBe(true);
      expect(policy(env, task).kind).toBe("ship");
      const taskFile = readFileSync(join(runDir(env, data.run), "task.md"), "utf8");
      expect(taskFile).toContain(`The scout's report is ${join(env.h.dataDir, task, "report.md")}`);
      expect(taskFile).toContain("Raise the eviction threshold.");
      expect(taskFile).toContain("Scout the cache");
      await waitUntil(async () => {
        const t = await backlogTask(env, task);
        return t?.state === "in_flight" && t.kind === "ship";
      }, 10_000, "the task In flight as a ship");
    },
    { timeout: 60_000 },
  );

  test(
    "has not landed as a blocker until its ship run lands: the scout's landed report does not count",
    async () => {
      const env = await fleet({ yolo: true, extraConfig: "[sched]\npass_ms = 250" });
      // Steps run once per session, so the ship's new session replays them: its --report is refused, and
      // it waits for `go` (the scout never gets there, its worker stops at cleanup) before it ships.
      const { task, run } = await env.dispatch("Scout the cache\nFAKE: deliver notes.md the cache evicts too early\nFAKE: wait-file go\nFAKE: commit fix.txt the fix\nFAKE: deliver-local\nFAKE: sleep 60000");
      await env.waitRun(run, (r) => r.state === "cleaned", "the scout cleaned");
      await waitUntil(async () => (await backlogTask(env, task))?.state === "done", 10_000, "the scout's task done");
      const promoted = await env.json(["promote", task]);
      expect(promoted.code).toBe(0);
      const ship = (promoted.reply.data as { run: string }).run;
      await env.waitRun(ship, (r) => r.worker_started_at !== null, "the ship's worker started", 20_000);

      const filed = await env.json(["dispatch", "web", "--kind", "ship", "--blocked-by", task, "--auto", "--body-file", "-"], { stdin: "After the cache fix\nFAKE: sleep 60000" });
      expect(filed.code).toBe(0);
      const dependent = (filed.reply.data as { task: string }).task;
      expect(filed.reply.data).toMatchObject({ state: "queued", blocked_by: [task], auto: "on" });
      const runsOf = (taskId: string) => {
        const db = env.h.db();
        try {
          return db.query("SELECT id FROM runs WHERE task_id = ?1").all(taskId) as { id: string }[];
        } finally {
          db.close();
        }
      };
      await waitUntil(async () => (await backlogTask(env, dependent)) !== null, 10_000, "the dependent in the backlog");
      await Bun.sleep(1_500);
      expect(runsOf(dependent)).toEqual([]);
      const refused = await env.json(["dispatch", "web", "--task", dependent]);
      expect(refused.code).toBe(2);
      expect(refused.reply.error).toMatchObject({ code: "blockers_not_landed" });

      // The ship lands (yolo merge of its local delivery): only now does the dependent start by itself.
      writeFileSync(join(env.h.dataDir, task, "go"), "");
      await env.waitRun(ship, (r) => r.state === "ready", "the ship's local delivery", 30_000);
      await Bun.sleep(500);
      expect(runsOf(dependent)).toEqual([]);
      expect((await env.json(["merge", task])).code).toBe(0);
      await env.waitRun(ship, (r) => r.state === "cleaned", "the ship landed and cleaned", 30_000);
      await waitUntil(() => runsOf(dependent).length === 1, 15_000, "the dependent started");
    },
    { timeout: 120_000 },
  );

  test(
    "refusals: a ship is not promoted; a landed scout waits for its cleanup; a kept worktree is cleaned up first",
    async () => {
      const env = await fleet();
      const ship = await env.dispatch("Build\nFAKE: sleep 60000", { kind: "ship" });
      const refused = await env.json(["promote", ship.task]);
      expect(refused.code).toBe(3);
      expect(refused.reply.error).toMatchObject({ code: "bad_args" });

      const dirty = await env.dispatch("Scout\nFAKE: scratch debug.log noise\nFAKE: deliver notes.md done\nFAKE: sleep 60000");
      await env.waitRun(dirty.run, (r) => r.state === "landed" && r.cleanup === "refused", "the refused cleanup");
      const landed = await env.json(["promote", dirty.task]);
      expect(landed.code).toBe(2);
      expect(landed.reply.error).toMatchObject({ code: "not_ready" });

      const cancelled = await env.dispatch("Scout\nFAKE: sleep 60000");
      await env.waitRun(cancelled.run, (r) => r.liveness === "busy", "busy");
      expect((await env.json(["cancel", cancelled.task])).code).toBe(0);
      const kept = await env.json(["promote", cancelled.task]);
      expect(kept.code).toBe(2);
      expect(kept.reply.error).toMatchObject({ code: "not_ready", help: `flowryn cleanup ${cancelled.task} (--discard needs your approval), then promote` });
    },
    { timeout: 60_000 },
  );
});

describe("a scout in a review with questions", () => {
  test(
    "is promoted: its open review questions close unanswered and its page is no longer polled",
    async () => {
      const page = filledDesignPage({ widget: true });
      const questions = JSON.stringify({ questions: [{ key: "store", kind: "single", question: "Where?", options: ["db", "file"], recommend: "db", blocks: "which store the cache writes to" }] });
      const env = await fleet({ extraConfig: ["[workflows.scout-review]", 'stages = [ { id = "design", gate = "review" }, { id = "investigate" } ]'].join("\n") });
      const dispatched = await env.json(["dispatch", "web", "--kind", "scout", "--workflow", "scout-review", "--body-file", "-"], {
        stdin: [
          "Scout the cache",
          `FAKE: write design/design.html ${page}`,
          `FAKE: write design/questions.json ${questions}`,
          "FAKE: stage-done --review lavish:design/design.html --page $FLOWRYN_REPORT_DIR/design/design.html --questions-file $FLOWRYN_REPORT_DIR/design/questions.json",
          "FAKE: sleep 60000",
        ].join("\n"),
      });
      expect(dispatched.code).toBe(0);
      const { task, run } = dispatched.reply.data as { task: string; run: string };
      await env.waitRun(run, (r) => r.stage_state === "review", "the scout's design review");
      const decisions = () => {
        const db = env.h.db();
        try {
          return db.query("SELECT d.id, d.gate_id, d.state, d.answered_via, (SELECT COUNT(*) FROM items i WHERE i.decision_id = d.id AND i.state = 'open') AS items, (SELECT i.resolved_by FROM items i WHERE i.decision_id = d.id) AS resolved_by FROM decisions d WHERE d.run_id = ?1").all(run);
        } finally {
          db.close();
        }
      };
      const gate = (decisions()[0] as { gate_id: string }).gate_id;
      expect(decisions()).toEqual([{ id: "q1", gate_id: gate, state: "open", answered_via: null, items: 1, resolved_by: null }]);
      expect((await env.json(["promote", task])).code).toBe(0);
      expect(decisions()).toEqual([{ id: "q1", gate_id: gate, state: "dismissed", answered_via: "promoted", items: 0, resolved_by: `run.promoted ${gate}` }]);
    },
    { timeout: 60_000 },
  );
});
