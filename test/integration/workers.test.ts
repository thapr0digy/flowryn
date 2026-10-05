/**
 * M2 runtime, workers and reconciler against a fake Herdr (test/helpers/
 * fake-herdr.ts) and a fake harness that plays a worker through the real
 * flowryn CLI hooks and worker verbs. The daemon, journal, tasks-axi and the
 * process table are real. The live runs against Herdr, Claude Code and Pi are
 * in scripts/lab/ (docs/m2-notes.md).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
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

function items(env: FleetEnv, runId: string): { id: string; kind: string; lane: string; state: string; line: string }[] {
  const db = env.h.db();
  try {
    return db.query("SELECT id, kind, lane, state, line FROM items WHERE run_id = ?1 ORDER BY opened_at").all(runId) as { id: string; kind: string; lane: string; state: string; line: string }[];
  } finally {
    db.close();
  }
}

async function backlogTask(env: FleetEnv, taskId: string) {
  const tasks = await listTasks(processRunner(realTasksAxi(), Bun.which("node")), env.h.backlog);
  return tasks.find((t) => t.id === taskId) ?? null;
}

/** A scout's report was delivered: the run landed with it, and is cleaned once its worktree is gone (design section 8). */
const delivered = (r: { state: string }) => r.state === "landed" || r.state === "cleaned";

describe("a scout end to end", () => {
  test(
    "claude: launch, worker-start with isolation, deliver --report, landed and cleaned, the task done with its report",
    async () => {
      const env = await fleet();
      const { task, run } = await env.dispatch("Scout the auth module\nFAKE: sleep 300\nFAKE: deliver summary.md auth is fine\nFAKE: sleep 30000");
      const landed = await env.waitRun(run, delivered, "the run to land with its report");
      expect(landed.pane_id).not.toBeNull();
      expect(landed.proc_pid).not.toBeNull();
      expect(landed.worker_started_at).not.toBeNull();
      const cleaned = await env.waitRun(run, (r) => r.state === "cleaned", "the scout cleaned up");
      expect(cleaned.cleanup).toBe("done");
      const events = env.events(run);
      expect(events).toEqual(expect.arrayContaining(["run.dispatched", "run.pane", "run.launching", "run.launched", "run.worker_started", "run.delivered", "run.landed", "cleanup.done", "run.cleaned"]));
      // The worktree went through the cleanup guard (a clean scout), the worker was stopped, its branch deleted.
      expect(existsSync(cleaned.worktree_path)).toBe(false);
      await waitUntil(() => env.herdr.harnessPid(cleaned.pane_id!) === null, 10_000, "the worker gone");
      expect(Bun.spawnSync(["git", "-C", env.repo, "rev-parse", "--verify", "--quiet", `refs/heads/${cleaned.branch}`]).exitCode).not.toBe(0);
      // Its report stays to be read: the P1 is open until dismissed, and fleet says so.
      expect(items(env, run).find((i) => i.kind === "report_ready")).toMatchObject({ lane: "P1", state: "open" });
      const fleetView = await env.json(["fleet"]);
      expect((fleetView.reply.data as { fleet: { id: string; needs: string }[] }).fleet.find((f) => f.id === task)).toMatchObject({ needs: "read" });
      await waitUntil(async () => (await backlogTask(env, task))?.state === "done", 10_000, "the backlog task done");
      expect((await backlogTask(env, task))?.links ?? []).toContain(`report:data/${task}/report.md`);
      expect(readFileSync(join(env.h.dataDir, task, "report.md"), "utf8")).toContain("auth is fine");
      // The pane got the run's identity through pane.split env (M0 h04), and Herdr never saw a control character.
      const split = env.herdr.calls.find((c) => c.method === "pane.split")!;
      expect((split.params.env as Record<string, string>).FLOWRYN_RUN).toBe(run);
      expect((split.params.env as Record<string, string>).CLAUDECODE).toBe("");
      const start = env.herdr.calls.find((c) => c.method === "agent.start")!;
      expect((start.params.args as string[]).every((a) => !/[\n\t]/.test(a))).toBe(true);
      expect(start.params.kind).toBe("claude");
      expect(env.run(run).liveness).toBe("dead");
      // Read, it needs nothing more.
      const report = items(env, run).find((i) => i.kind === "report_ready")!;
      expect((await env.json(["dismiss", report.id])).code).toBe(0);
      const after = await env.json(["fleet"]);
      expect((after.reply.data as { fleet: { id: string; needs: string }[] }).fleet.find((f) => f.id === task)).toMatchObject({ state: "cleaned", needs: "-" });
    },
    { timeout: 45_000 },
  );

  test(
    "a scout that leaves uncommitted work lands with its report, but the guard refuses its cleanup: a P1, the worktree kept",
    async () => {
      const env = await fleet();
      const { task, run } = await env.dispatch("Scout\nFAKE: scratch debug.log some scratch output\nFAKE: deliver notes.md found it\nFAKE: sleep 30000");
      await env.waitRun(run, (r) => r.state === "landed" && r.cleanup === "refused", "the refused cleanup");
      const refused = items(env, run).find((i) => i.kind === "cleanup_refused")!;
      expect(refused.line).toStartWith("Report delivered, but cleanup refused");
      expect(refused.line).toContain("(dirty)");
      expect(existsSync(env.run(run).worktree_path)).toBe(true);
      // The task is not done until the worktree goes: landed is not cleaned.
      expect((await backlogTask(env, task))?.state).toBe("in_flight");
    },
    { timeout: 45_000 },
  );
});

function steers(env: FleetEnv, runId: string): { id: string; rings: number; seen_at: number | null; acked_at: number | null }[] {
  const db = env.h.db();
  try {
    return db.query("SELECT id, rings, seen_at, acked_at FROM messages WHERE run_id = ?1 ORDER BY created_at").all(runId) as { id: string; rings: number; seen_at: number | null; acked_at: number | null }[];
  } finally {
    db.close();
  }
}

/** One steer's ring state, as the daemon recorded it. */
function ringOf(env: FleetEnv, id: string): { ring_state: string; seen_at: number | null; rings: number } {
  const db = env.h.db();
  try {
    return db.query("SELECT ring_state, seen_at, rings FROM messages WHERE id = ?1").get(id) as { ring_state: string; seen_at: number | null; rings: number };
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
      await env.waitRun(run, delivered, "the pi run to land with its report");
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
      // Seen: the hook after the PostToolUse carry, and the woken turn's UserPromptSubmit.
      expect(steers(env, run).every((m) => m.seen_at !== null && m.seen_at <= m.acked_at!)).toBe(true);
      const shown = await env.json(["show", run]);
      const delivery = (shown.reply.data as { steers: { id: string; delivery: string }[] }).steers.map((m) => m.delivery);
      expect(delivery).toHaveLength(2);
      for (const line of delivery) expect(line).toMatch(/^carried \+\d+(ms|\.\ds), seen \+.*, acked \+/);
    },
    { timeout: 45_000 },
  );

  test(
    "a woken turn's UserPromptSubmit is not seen: a StopFailure before its first inference loses the steer, a PreToolUse first keeps it seen",
    async () => {
      const env = await fleet();
      // A worker that sends no hooks of its own: the test plays Claude's hooks with the run's token.
      const { run } = await env.dispatch("Build\nFAKE: no-start");
      const launched = await env.waitRun(run, (r) => r.pane_id !== null && r.proc_pid !== null, "launched");
      const pane = env.herdr.panes.get(launched.pane_id!)!;
      const worker = { env: { FLOWRYN_TOKEN: pane.env.FLOWRYN_TOKEN! } };
      const hook = (name: string) => env.cli(["hook", name, "--harness", "claude"], { ...worker, stdin: "{}" });
      const state = (id: string) => ringOf(env, id);

      // The waiter wakes the idle worker; the woken turn starts and fails before the model reads anything.
      const lost = await steer(env, run, "first");
      expect((await hook("wait-steer")).code).toBe(2);
      await hook("prompt");
      expect(state(lost)).toMatchObject({ ring_state: "carried", seen_at: null });
      await hook("stop-failure");
      expect(state(lost)).toMatchObject({ ring_state: "lost", seen_at: null, rings: 1 });
      // It rings again at once, through the next waiter.
      const again = await hook("wait-steer");
      expect(again.code).toBe(2);
      expect(again.stderr).toContain(lost);
      expect(state(lost)).toMatchObject({ ring_state: "carried", rings: 2 });

      // This time the model reaches a tool call: the PreToolUse proves it read the wake, so a later failure keeps it seen.
      await hook("prompt");
      await hook("pre-tool");
      expect(state(lost)).toMatchObject({ ring_state: "seen" });
      await hook("stop-failure");
      expect(state(lost).ring_state).toBe("seen");
      const events = env.events(run);
      expect(events.filter((e) => e === "steer.lost")).toHaveLength(1);
      expect(events.filter((e) => e === "steer.seen")).toHaveLength(1);
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
      const ready = await env.waitRun(run, delivered, "the resumed run to deliver", 30_000);
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
      const resumed = await env.json(["resume", run]);
      expect(resumed.code).toBe(0);
      expect(items(env, run).find((i) => i.kind === "failure_needs_you")?.state).toBe("resolved");
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
      const ready = await env.waitRun(run, delivered, "the spooled deliver to be ingested");
      expect(ready.resume_count).toBe(0);
      expect(ready.proc_pid).toBe(busy.proc_pid);
      // Spool ingest runs before the reconciler's startup pass (design section 6, steps 3 then 6).
      await waitUntil(() => env.events(run).includes("run.reattached"), 10_000, "the reattach");
      expect(env.events(run)).not.toContain("run.auto_resumed");
    },
    { timeout: 60_000 },
  );
});

interface FakeReply {
  args: string[];
  code: number;
  reply: { ok?: boolean; error?: { code: string; hint?: string } };
}

async function fakeReplies(env: FleetEnv, task: string, count: number): Promise<FakeReply[]> {
  const file = join(env.h.dataDir, task, "fake-replies.jsonl");
  const read = () =>
    existsSync(file)
      ? readFileSync(file, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const raw = JSON.parse(line) as { args: string[]; code: number; reply: string };
            return { args: raw.args, code: raw.code, reply: JSON.parse(raw.reply) } as FakeReply;
          })
      : [];
  await waitUntil(() => read().length >= count, 20_000, `${count} worker verb replies`);
  return read();
}

describe("deliver matches the task kind", () => {
  test(
    "a ship's deliver --report is refused with bad_args, and a local-only ship's --pr too",
    async () => {
      const env = await fleet();
      const { task, run } = await env.dispatch("Build\nFAKE: verb deliver --report notes.md\nFAKE: verb deliver --pr https://github.com/o/r/pull/1\nFAKE: sleep 30000", { kind: "ship" });
      const [report, pr] = await fakeReplies(env, task, 2);
      expect(report!.code).toBe(3);
      expect(report!.reply.error).toMatchObject({ code: "bad_args" });
      expect(pr!.reply.error).toMatchObject({ code: "bad_args" });
      expect(env.run(run).state).toBe("running");
      expect(env.events(run)).not.toContain("run.delivered");
    },
    { timeout: 45_000 },
  );

  test(
    "a scout's deliver --pr is refused with bad_args",
    async () => {
      const env = await fleet();
      const { task, run } = await env.dispatch("Scout\nFAKE: verb deliver --pr https://github.com/o/r/pull/1\nFAKE: sleep 30000");
      const [pr] = await fakeReplies(env, task, 1);
      expect(pr!.code).toBe(3);
      expect(pr!.reply.error).toMatchObject({ code: "bad_args" });
      expect(env.run(run).state).toBe("running");
      expect(env.events(run)).not.toContain("run.delivered");
    },
    { timeout: 45_000 },
  );

  test(
    "a symlink the worker planted at the report destination is replaced, never written through",
    async () => {
      const env = await fleet();
      const victim = join(env.h.home, "victim.txt");
      writeFileSync(victim, "untouched\n");
      const { task, run } = await env.dispatch(`Scout\nFAKE: symlink report.md ${victim}\nFAKE: deliver notes.md the real report`);
      await env.waitRun(run, delivered, "the run to land with its report");
      expect(readFileSync(victim, "utf8")).toBe("untouched\n");
      const artifact = join(env.h.dataDir, task, "report.md");
      expect(lstatSync(artifact).isSymbolicLink()).toBe(false);
      expect(readFileSync(artifact, "utf8")).toContain("the real report");
    },
    { timeout: 45_000 },
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
    "interrupt on claude is refused while Herdr reads a dialog: Escape would answer it, so no key is sent",
    async () => {
      const env = await fleet();
      const { task, run } = await env.dispatch("Build\nFAKE: sleep 30000");
      const busy = await env.waitRun(run, (r) => r.liveness === "busy", "busy");
      env.herdr.setStatus(busy.pane_id!, "blocked");
      const result = await env.json(["interrupt", task]);
      expect(result.code).not.toBe(0);
      expect(result.reply).toMatchObject({ ok: false, error: { code: "interrupt_refused" } });
      expect(env.herdr.calls.some((c) => c.method === "pane.send_keys")).toBe(false);
      expect(env.events(run)).toContain("run.interrupt_refused");
      expect(env.herdr.harnessPid(busy.pane_id!)).toBe(busy.proc_pid);
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
