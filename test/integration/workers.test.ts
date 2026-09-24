/**
 * M2 runtime, workers and reconciler against a fake Herdr (test/helpers/
 * fake-herdr.ts) and a fake harness that plays a worker through the real
 * flowryn CLI hooks and worker verbs. The daemon, journal, tasks-axi and the
 * process table are real. The live runs against Herdr, Claude Code and Pi are
 * in scripts/lab/ (docs/m2-notes.md).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { listTasks, processRunner } from "../../src/journal/tasks-axi.ts";
import { realTasksAxi, waitUntil } from "../helpers/harness.ts";

const envs: FleetEnv[] = [];
async function fleet(options: Parameters<typeof makeFleetEnv>[0] = {}): Promise<FleetEnv> {
  const env = await makeFleetEnv(options);
  envs.push(env);
  return env;
}
afterEach(async () => {
  for (const env of envs.splice(0)) await env.cleanup();
});

function items(env: FleetEnv, runId: string): { kind: string; lane: string; state: string; line: string }[] {
  const db = env.h.db();
  try {
    return db.query("SELECT kind, lane, state, line FROM items WHERE run_id = ?1 ORDER BY opened_at").all(runId) as { kind: string; lane: string; state: string; line: string }[];
  } finally {
    db.close();
  }
}

async function backlogTask(env: FleetEnv, taskId: string) {
  const tasks = await listTasks(processRunner(realTasksAxi(), Bun.which("node")), env.h.backlog);
  return tasks.find((t) => t.id === taskId) ?? null;
}

describe("a scout end to end", () => {
  test(
    "claude: launch, worker-start with isolation, deliver --report, ready, backlog updated",
    async () => {
      const env = await fleet();
      const { task, run } = await env.dispatch("Scout the auth module\nFAKE: sleep 300\nFAKE: deliver summary.md auth is fine");
      const ready = await env.waitRun(run, (r) => r.state === "ready", "the run to be ready");
      expect(ready.pane_id).not.toBeNull();
      expect(ready.proc_pid).not.toBeNull();
      expect(ready.worker_started_at).not.toBeNull();
      const events = env.events(run);
      expect(events).toEqual(expect.arrayContaining(["run.dispatched", "run.pane", "run.launching", "run.launched", "run.worker_started", "run.delivered"]));
      expect(items(env, run).find((i) => i.kind === "report_ready")).toMatchObject({ lane: "P1", state: "open" });
      await waitUntil(async () => (await backlogTask(env, task))?.state === "in_flight", 10_000, "the backlog task in flight");
      await waitUntil(async () => ((await backlogTask(env, task))?.links ?? []).includes(`report:data/${task}/report.md`), 10_000, "the report link in the backlog");
      expect(readFileSync(join(env.h.dataDir, task, "report.md"), "utf8")).toContain("auth is fine");
      // The pane got the run's identity through pane.split env (M0 h04), and Herdr never saw a control character.
      const split = env.herdr.calls.find((c) => c.method === "pane.split")!;
      expect((split.params.env as Record<string, string>).FLOWRYN_RUN).toBe(run);
      expect((split.params.env as Record<string, string>).CLAUDECODE).toBe("");
      const start = env.herdr.calls.find((c) => c.method === "agent.start")!;
      expect((start.params.args as string[]).every((a) => !/[\n\t]/.test(a))).toBe(true);
      expect(start.params.kind).toBe("claude");
      await env.waitRun(run, (r) => r.liveness === "idle", "the worker to go idle");
    },
    { timeout: 45_000 },
  );
});

function steers(env: FleetEnv, runId: string): { id: string; rings: number; acked_at: number | null }[] {
  const db = env.h.db();
  try {
    return db.query("SELECT id, rings, acked_at FROM messages WHERE run_id = ?1 ORDER BY created_at").all(runId) as { id: string; rings: number; acked_at: number | null }[];
  } finally {
    db.close();
  }
}

async function steer(env: FleetEnv, target: string, text: string): Promise<string> {
  const result = await env.json(["steer", target, "--body-file", "-"], { stdin: text });
  expect(result.code).toBe(0);
  return String((result.reply.data as { steer: string }).steer);
}

async function waitSteerAcked(env: FleetEnv, runId: string, id: string, timeoutMs = 20_000): Promise<void> {
  await waitUntil(() => steers(env, runId).some((m) => m.id === id && m.acked_at !== null), timeoutMs, `steer ${id} to be acknowledged; ${JSON.stringify(steers(env, runId))}`);
}

describe("pi worker", () => {
  test(
    "a pi scout runs end to end, and a steer sent while it works reaches it through the extension's long poll",
    async () => {
      const env = await fleet();
      const { run } = await env.dispatch("Scout the cache\nFAKE: sleep 4000\nFAKE: deliver notes.md cache is fine", { harness: "pi" });
      await env.waitRun(run, (r) => r.liveness === "busy", "the pi worker to be busy");
      const id = await steer(env, run, "also check eviction");
      await waitSteerAcked(env, run, id);
      await env.waitRun(run, (r) => r.state === "ready", "the pi run to be ready");
      const start = env.herdr.calls.find((c) => c.method === "agent.start")!;
      expect(start.params.kind).toBe("pi");
      const args = start.params.args as string[];
      expect(args[args.indexOf("-e") + 1]).toMatch(/flowryn-worker\.ts$/);
      expect(args).toContain("--append-system-prompt");
    },
    { timeout: 45_000 },
  );
});

describe("steers to a claude worker", () => {
  test(
    "while busy a steer rides back on PostToolUse; while idle the waiter wakes the worker",
    async () => {
      const env = await fleet();
      const { run } = await env.dispatch("Build\nFAKE: sleep 1500\nFAKE: sleep 1500");
      await env.waitRun(run, (r) => r.liveness === "busy", "busy");
      const busy = await steer(env, run, "use the new API");
      await waitSteerAcked(env, run, busy);
      await env.waitRun(run, (r) => r.liveness === "idle", "idle");
      const idle = await steer(env, run, "now write the docs");
      await waitSteerAcked(env, run, idle);
      const events = env.events(run);
      expect(events.filter((e) => e === "steer.rung").length).toBeGreaterThanOrEqual(2);
      expect(steers(env, run).every((m) => m.rings === 1)).toBe(true);
    },
    { timeout: 45_000 },
  );

  test(
    "an unacknowledged steer rings again, then becomes a P1",
    async () => {
      const env = await fleet();
      const { run } = await env.dispatch("Build\nFAKE: ignore-steers\nFAKE: sleep 200");
      await env.waitRun(run, (r) => r.liveness === "idle", "idle");
      const id = await steer(env, run, "please ack");
      await waitUntil(() => items(env, run).some((i) => i.kind === "steer_unacked" && i.state === "open"), 20_000, "the steer_unacked P1");
      const message = steers(env, run).find((m) => m.id === id)!;
      expect(message.rings).toBe(3);
      expect(message.acked_at).toBeNull();
    },
    { timeout: 45_000 },
  );
});

describe("safeguards at start", () => {
  test(
    "the isolation assertion fails a worker outside its worktree: interrupted, exited, failed, parked",
    async () => {
      const env = await fleet();
      const { task, run } = await env.dispatch(`Build\nFAKE: cwd ${env.repo}\nFAKE: sleep 30000`);
      const failed = await env.waitRun(run, (r) => r.state === "failed", "the run to fail");
      expect(env.events(run)).toContain("run.isolation_failed");
      expect(items(env, run).find((i) => i.kind === "failure_needs_you")).toMatchObject({ lane: "P0", state: "open" });
      await waitUntil(() => env.herdr.harnessPid(failed.pane_id!) === null, 10_000, "the worker process to exit");
      await waitUntil(async () => (await backlogTask(env, task))?.hold?.kind === "parked", 10_000, "the task parked");
      expect((await backlogTask(env, task))?.state).toBe("queued");
    },
    { timeout: 45_000 },
  );

  test(
    "a worker that never reports worker-start is blocked_dialog with a P1, and no keystroke is sent",
    async () => {
      const env = await fleet();
      const { run } = await env.dispatch("Build\nFAKE: no-start");
      await env.waitRun(run, (r) => r.liveness === "blocked_dialog", "blocked_dialog");
      expect(items(env, run).find((i) => i.kind === "trust_dialog")).toMatchObject({ lane: "P1", state: "open" });
      expect(env.herdr.calls.some((c) => c.method === "pane.send_keys")).toBe(false);
    },
    { timeout: 30_000 },
  );

  test(
    "claude trust is registered in the configured store for the worktree and the project",
    async () => {
      const env = await fleet();
      const { run } = await env.dispatch("Build\nFAKE: sleep 100");
      const r = await env.waitRun(run, (x) => x.proc_pid !== null, "launched");
      const store = JSON.parse(readFileSync(join(env.claudeStore, ".claude.json"), "utf8")) as { projects: Record<string, { hasTrustDialogAccepted?: boolean }> };
      const { realpathSync } = await import("node:fs");
      expect(store.projects[realpathSync(r.worktree_path)]?.hasTrustDialogAccepted).toBe(true);
      expect(store.projects[realpathSync(env.repo)]?.hasTrustDialogAccepted).toBe(true);
    },
    { timeout: 30_000 },
  );
});

describe("recovery", () => {
  test(
    "a worker killed mid-run is resumed once from its session and finishes",
    async () => {
      const env = await fleet();
      const { run } = await env.dispatch("Scout\nFAKE: sleep 3000\nFAKE: deliver r.md resumed fine");
      const busy = await env.waitRun(run, (r) => r.liveness === "busy", "busy");
      const firstPid = busy.proc_pid;
      env.herdr.killHarness(busy.pane_id!, "SIGKILL");
      const ready = await env.waitRun(run, (r) => r.state === "ready", "the resumed run to deliver", 30_000);
      expect(ready.resume_count).toBe(1);
      expect(ready.proc_pid).not.toBe(firstPid);
      expect(env.events(run)).toEqual(expect.arrayContaining(["run.auto_resumed", "run.launched"]));
      expect(items(env, run).find((i) => i.kind === "auto_resumed")).toMatchObject({ lane: "P1" });
      const start = env.herdr.calls.filter((c) => c.method === "agent.start").at(-1)!;
      expect(start.params.args as string[]).toContain("--resume");
    },
    { timeout: 45_000 },
  );

  test(
    "a second death is a P0 and nothing is resumed again",
    async () => {
      const env = await fleet();
      const { run } = await env.dispatch("Scout\nFAKE: sleep 20000");
      let r = await env.waitRun(run, (x) => x.liveness === "busy", "busy");
      env.herdr.killHarness(r.pane_id!, "SIGKILL");
      r = await env.waitRun(run, (x) => x.resume_count === 1 && x.liveness === "busy", "resumed and busy", 30_000);
      env.herdr.killHarness(r.pane_id!, "SIGKILL");
      await env.waitRun(run, (x) => x.liveness === "dead", "dead", 20_000);
      await waitUntil(() => items(env, run).some((i) => i.kind === "failure_needs_you" && i.lane === "P0"), 10_000, "the P0");
      await Bun.sleep(1_000);
      expect(env.run(run).resume_count).toBe(1);
      expect(env.herdr.livePanes()).toHaveLength(0);
    },
    { timeout: 60_000 },
  );

  test(
    "kill -9 of the daemon mid-run: the worker spools its deliver, the restarted daemon reattaches and ingests it",
    async () => {
      const env = await fleet();
      const { run } = await env.dispatch("Scout\nFAKE: sleep 4000\nFAKE: deliver r.md written while the daemon was down");
      const busy = await env.waitRun(run, (r) => r.liveness === "busy", "busy");
      await env.daemon.kill9();
      // The worker keeps working; its deliver spools (exit 75) while nothing answers.
      await waitUntil(() => {
        const { readdirSync, existsSync } = require("node:fs") as typeof import("node:fs");
        const dir = join(env.h.dataDir, "spool", run);
        return existsSync(dir) && readdirSync(dir).some((f: string) => f.endsWith(".json"));
      }, 20_000, "the spooled deliver");
      expect(env.herdr.harnessPid(busy.pane_id!)).toBe(busy.proc_pid);
      await env.restartDaemon();
      const ready = await env.waitRun(run, (r) => r.state === "ready", "the spooled deliver to be ingested");
      expect(ready.resume_count).toBe(0);
      expect(ready.proc_pid).toBe(busy.proc_pid);
      // Spool ingest runs before the reconciler's startup pass (design section 6, steps 3 then 6).
      await waitUntil(() => env.events(run).includes("run.reattached"), 10_000, "the reattach");
      expect(env.events(run)).not.toContain("run.auto_resumed");
    },
    { timeout: 60_000 },
  );
});

describe("questions, cancel and interrupt", () => {
  test(
    "ask opens a P0 and a captain hold; answer resolves it and reaches the worker as a steer",
    async () => {
      const env = await fleet();
      const { task, run } = await env.dispatch("Build\nFAKE: ask postgres,sqlite which database");
      await waitUntil(() => items(env, run).some((i) => i.kind === "worker_question_blocking" && i.state === "open"), 20_000, "the question");
      await waitUntil(async () => (await backlogTask(env, task))?.hold?.kind === "captain", 10_000, "the captain hold");
      const answered = await env.json(["answer", "q1", "sqlite"]);
      expect(answered.code).toBe(0);
      const id = String((answered.reply.data as { steer: string }).steer);
      await waitSteerAcked(env, run, id);
      expect(items(env, run).find((i) => i.kind === "worker_question_blocking")?.state).toBe("resolved");
      await waitUntil(async () => (await backlogTask(env, task))?.hold === null, 10_000, "the hold lifted");
    },
    { timeout: 45_000 },
  );

  test(
    "cancel exits the worker, parks the task and closes its workspace",
    async () => {
      const env = await fleet();
      const { task, run } = await env.dispatch("Build\nFAKE: sleep 30000");
      const busy = await env.waitRun(run, (r) => r.liveness === "busy", "busy");
      const result = await env.json(["cancel", task, "--reason", "no longer needed"]);
      expect(result.code).toBe(0);
      expect(env.run(run).state).toBe("cancelled");
      expect(env.herdr.harnessPid(busy.pane_id!)).toBeNull();
      await waitUntil(async () => (await backlogTask(env, task))?.hold?.kind === "parked", 10_000, "the task parked");
      await waitUntil(() => !env.herdr.workspaces.has(busy.workspace_id!), 5_000, "the workspace closed");
    },
    { timeout: 45_000 },
  );

  test(
    "interrupt on claude is the interrupt key, verified by the transcript; the worker stays alive and idle",
    async () => {
      const env = await fleet();
      const { task, run } = await env.dispatch("Build\nFAKE: sleep 30000");
      const busy = await env.waitRun(run, (r) => r.liveness === "busy", "busy");
      const result = await env.json(["interrupt", task]);
      expect(result.code).toBe(0);
      expect(result.reply.data).toMatchObject({ interrupted: true, evidence: "transcript" });
      expect(env.herdr.harnessPid(busy.pane_id!)).toBe(busy.proc_pid);
      await env.waitRun(run, (r) => r.liveness === "idle", "idle after the interrupt");
    },
    { timeout: 45_000 },
  );

  test(
    "interrupt on pi is the extension's abort, verified by the agent_settled that follows",
    async () => {
      const env = await fleet();
      const { task, run } = await env.dispatch("Build\nFAKE: sleep 30000", { harness: "pi" });
      const busy = await env.waitRun(run, (r) => r.liveness === "busy", "busy");
      const result = await env.json(["interrupt", task]);
      expect(result.reply).toMatchObject({ ok: true });
      expect(result.code).toBe(0);
      expect(result.reply.data).toMatchObject({ interrupted: true, evidence: "hook" });
      expect(env.herdr.harnessPid(busy.pane_id!)).toBe(busy.proc_pid);
      expect(env.herdr.calls.some((c) => c.method === "pane.send_keys")).toBe(false);
    },
    { timeout: 45_000 },
  );

  test(
    "fail opens a P0 and leaves the run to the leader",
    async () => {
      const env = await fleet();
      const { run } = await env.dispatch("Build\nFAKE: fail the tests need a database I cannot start");
      await waitUntil(() => items(env, run).some((i) => i.kind === "failure_needs_you" && i.lane === "P0"), 20_000, "the P0");
      expect(env.run(run).state).toBe("running");
    },
    { timeout: 30_000 },
  );
});

describe("dispatch refusals", () => {
  test(
    "no passing contract for the installed harness version: contract_unverified (exit 2)",
    async () => {
      const env = await fleet({ contracts: false });
      const result = await env.json(["dispatch", "web", "--kind", "scout", "--body-file", "-"], { stdin: "Scout" });
      expect(result.code).toBe(2);
      expect(result.reply.error).toMatchObject({ code: "contract_unverified" });
    },
    { timeout: 30_000 },
  );

  test(
    "a primary checkout off its default branch: refused with a P1, nothing changed",
    async () => {
      const env = await fleet();
      Bun.spawnSync(["git", "-C", env.repo, "checkout", "-q", "-b", "side"]);
      const result = await env.json(["dispatch", "web", "--kind", "scout", "--body-file", "-"], { stdin: "Scout" });
      expect(result.code).toBe(2);
      expect(result.reply.error).toMatchObject({ code: "primary_checkout_tangle" });
      const db = env.h.db();
      const tangles = db.query("SELECT COUNT(*) AS n FROM items WHERE kind = 'checkout_tangle'").get() as { n: number };
      const runs = db.query("SELECT COUNT(*) AS n FROM runs").get() as { n: number };
      db.close();
      expect(tangles.n).toBe(1);
      expect(runs.n).toBe(0);
    },
    { timeout: 30_000 },
  );
});

describe("never adopt by label", () => {
  test(
    "a pane labelled for a live run that is not its pane of record is a divergence, left alone",
    async () => {
      const env = await fleet();
      const { run } = await env.dispatch("Build\nFAKE: sleep 30000");
      const r = await env.waitRun(run, (x) => x.liveness === "busy", "busy");
      const foreign = env.herdr.addForeignPane({ flowryn_run: run }, r.worktree_path);
      await waitUntil(() => items(env, run).some((i) => i.kind === "divergence"), 10_000, "the divergence");
      expect(env.run(run).pane_id).toBe(r.pane_id);
      expect(env.herdr.panes.has(foreign)).toBe(true);
    },
    { timeout: 30_000 },
  );
});
