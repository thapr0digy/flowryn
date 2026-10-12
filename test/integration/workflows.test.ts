import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, waitUntil } from "../helpers/harness.ts";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { Pty } from "../helpers/pty.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";
import { M4_SHIP_WORKFLOW } from "../../src/db/schema.ts";
import { lavishSessionKey } from "../../src/lavish/session-key.ts";
import { readIdentity, type ProcIdentity, type PsRunner } from "../../src/runtime/proc.ts";

/**
 * Workflows, review gates, capacity grants and the usage-limit pause (design
 * section 11), end to end on the M2 fake Herdr and fake workers: each fake
 * worker runs `flowryn stage done` and carries on when the steer that starts
 * its next stage arrives, the way the worker contract tells a real one to.
 */

const MAIN = join(REPO_ROOT, "src/main.ts");

let ship: ShipEnv | null = null;
let fleet: FleetEnv | null = null;
const ptys: Pty[] = [];

afterEach(async () => {
  for (const pty of ptys.splice(0)) pty.kill();
  await ship?.cleanup();
  await fleet?.cleanup();
  ship = null;
  fleet = null;
});

function rows<T>(e: FleetEnv, sql: string, ...params: (string | number)[]): T[] {
  const db = e.h.db();
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

function one<T>(e: FleetEnv, sql: string, ...params: (string | number)[]): T | null {
  return rows<T>(e, sql, ...params)[0] ?? null;
}

async function until(e: FleetEnv, what: string, check: () => boolean, timeoutMs = 30_000): Promise<void> {
  await waitUntil(check, timeoutMs, what);
}

const FEATURE = (name: string) =>
  [
    `Feature ${name}`,
    `FAKE: stage-done --review lavish:${name}/design.html`,
    `FAKE: commit ${name}.txt built`,
    "FAKE: stage-done",
    `FAKE: docker-up ${name}-web flowryn-${name}`,
    "FAKE: sleep 1500",
    `FAKE: docker-down ${name}-web`,
    "FAKE: qa-page",
    `FAKE: stage-done --review lavish:qa/evidence.html`,
    "FAKE: deliver-local",
    "FAKE: sleep 120000",
  ].join("\n");

describe("workflow stages and review gates", () => {
  test(
    "a feature runs design, review, build, visual QA, review and ship; a gate passes only with a human word",
    async () => {
      ship = await makeShipEnv({ mode: "local-only" });
      const e = ship;
      const f = e.fleet;
      expect((await f.json(["project", "set", "web", "--workflow", "feature-ui"])).code).toBe(0);
      const leader = await e.claude();
      await leader.start();
      const dispatched = await f.json(["dispatch", "web", "--kind", "ship", "--body-file", "-"], { env: { FLOWRYN_TOKEN: e.leaderToken() }, stdin: FEATURE("one") });
      expect(dispatched.code).toBe(0);
      const { task, run } = dispatched.reply.data as { task: string; run: string };

      // Design: the worker hands in its page; a P1 names the link; nothing moves without your word.
      await f.waitRun(run, (r) => r.stage === "design" && r.stage_state === "review", "the design review");
      const gate = one<{ id: string; review_url: string; page_path: string }>(f, "SELECT id, review_url, page_path FROM gates WHERE run_id = ?1 AND kind = 'review' AND state = 'open'", run)!;
      // The review URL is lavish's for the page the worker hosted, so the daemon listens on that page.
      expect(gate.page_path.endsWith("/one/design.html")).toBe(true);
      expect(gate.review_url).toBe(`http://127.0.0.1:4387/session/${lavishSessionKey(gate.page_path)}`);
      expect(one<{ line: string }>(f, "SELECT line FROM items WHERE kind = 'gate_ready' AND run_id = ?1 AND state IN ('open','presented')", run)!.line).toContain(gate.review_url);
      // Your own terminal without a record, and the leader without your prompt, are refused.
      const bare = await e.call("gate pass", { task });
      expect(bare.error?.code).toBe("approval_required");
      const no = await leader.runBash(`flowryn gate pass ${task} --json`, { approve: false });
      expect(no).toMatchObject({ prompted: true, ran: false });
      expect(leader.prompts.at(-1)).toContain("PASS the design review");
      expect(f.run(run).stage_state).toBe("review");
      const yes = await leader.runBash(`flowryn gate pass ${task} --json`, { approve: true });
      expect(yes).toMatchObject({ prompted: true, ran: true, code: 0 });
      expect(JSON.parse(yes.stdout).data).toMatchObject({ stage: "design", next: "build", channel: "claude-ask" });

      // Build, then QA: the QA stage holds a Docker environment and a browser slot while it runs.
      await f.waitRun(run, (r) => r.stage === "qa" && r.stage_state === "active", "the QA stage");
      const held = rows<{ pool: string }>(f, "SELECT pool FROM pool_leases WHERE run_id = ?1 AND released_at IS NULL ORDER BY pool", run).map((l) => l.pool);
      expect(held).toEqual(["browser", "docker_env", "worker"]);
      await until(f, "the Docker evidence", () => one(f, "SELECT 1 FROM run_evidence WHERE run_id = ?1 AND source = 'docker'", run) !== null);
      await f.waitRun(run, (r) => r.stage === "qa" && r.stage_state === "review", "the QA review");
      expect(rows<{ pool: string }>(f, "SELECT pool FROM pool_leases WHERE run_id = ?1 AND released_at IS NULL", run).map((l) => l.pool)).toEqual(["worker"]);

      // QA passes in your shell (flowryn approve --gate qa); ship delivers; the merge gate is the M4 one.
      const passed = await e.approve(task, { gate: "qa" });
      expect(passed.ok).toBe(true);
      expect(passed.data).toMatchObject({ stage: "qa", next: "ship", channel: "cli-tty" });
      await f.waitRun(run, (r) => r.state === "ready" && r.stage === "ship" && r.stage_state === "done", "the delivery");
      const merged = await leader.runBash(`flowryn merge ${task} --json`, { approve: true });
      expect(merged.code).toBe(0);
      await f.waitRun(run, (r) => r.state === "cleaned", "cleaned", 30_000);

      const gates = rows<{ kind: string; stage: string; state: string; channel: string | null }>(
        f,
        "SELECT g.kind, g.stage, g.state, a.channel FROM gates g LEFT JOIN approvals a ON a.id = g.approval_id WHERE g.run_id = ?1 ORDER BY g.opened_at",
        run,
      );
      expect(gates).toEqual([
        { kind: "review", stage: "design", state: "passed", channel: "claude-ask" },
        { kind: "review", stage: "qa", state: "passed", channel: "cli-tty" },
        { kind: "merge", stage: "ship", state: "passed", channel: "claude-ask" },
      ]);
      expect(rows(f, "SELECT 1 FROM pool_leases WHERE run_id = ?1 AND released_at IS NULL", run)).toEqual([]);
      const events = f.events(run);
      const count = (kind: string) => events.filter((k) => k === kind).length;
      expect([count("stage.started"), count("stage.done"), count("gate.opened"), count("gate.passed"), count("stage.delivered")]).toEqual([4, 3, 3, 3, 1]);
    },
    { timeout: 150_000 },
  );

  test(
    "changes at the QA review send the run back to build with your words; a worker cannot skip a gate or its QA page",
    async () => {
      ship = await makeShipEnv({ mode: "local-only" });
      const e = ship;
      const f = e.fleet;
      expect((await f.json(["project", "set", "web", "--workflow", "feature-ui"])).code).toBe(0);
      const steps = [
        "Feature two",
        "FAKE: verb deliver --local",
        "FAKE: stage-done --review lavish:two/design.html",
        "FAKE: commit two.txt first try",
        "FAKE: stage-done",
        "FAKE: verb stage done --review lavish:qa/evidence.html",
        "FAKE: qa-page",
        "FAKE: stage-done --review lavish:qa/evidence.html",
        "FAKE: commit two.txt second try",
        "FAKE: stage-done",
        "FAKE: qa-page works-with-caveats",
        "FAKE: stage-done --review lavish:qa/evidence.html",
        "FAKE: deliver-local",
        "FAKE: sleep 120000",
      ].join("\n");
      const { task, run } = await f.dispatch(steps, { kind: "ship" });
      // Delivering from the design stage is refused: a review gate stands before the delivery.
      const [refused] = await e.replies(task, 1);
      expect(refused!.code).toBe(2);
      expect((refused!.reply.error as { code: string }).code).toBe("wrong_stage");

      await f.waitRun(run, (r) => r.stage === "design" && r.stage_state === "review", "the design review");
      expect((await e.approve(task, { gate: "design" })).ok).toBe(true);
      await f.waitRun(run, (r) => r.stage === "qa" && r.stage_state === "review", "the first QA review");
      // The QA review needs its page: without qa/evidence.html and its filled card, stage done is refused.
      const noPage = (await e.replies(task, 5)).find((r) => r.args.includes("lavish:qa/evidence.html"))!;
      expect(noPage.code).toBe(3);
      expect((noPage.reply.error as { code: string }).code).toBe("qa_page_invalid");
      const changes = await f.json(["gate", "changes", task, "--body-file", "-"], { stdin: "The button is off-screen on a phone." });
      expect(changes.code).toBe(0);
      expect(changes.reply.data).toMatchObject({ state: "changes", to: "build" });
      const steer = one<{ body: string }>(f, "SELECT body FROM messages WHERE run_id = ?1 AND body LIKE '%off-screen%'", run)!;
      expect(steer.body).toContain("Changes requested at the qa review: The button is off-screen on a phone. Back to stage build.");
      expect(steer.body).toContain("Flowryn stage build (2 of 4");

      await f.waitRun(run, (r) => r.stage === "qa" && r.stage_state === "review" && one(f, "SELECT 1 FROM gates WHERE run_id = ?1 AND stage = 'qa' AND state = 'open' AND (SELECT COUNT(*) FROM gates WHERE run_id = ?1 AND stage = 'qa') = 2", run) !== null, "the second QA review");
      expect((await e.approve(task, { gate: "qa" })).ok).toBe(true);
      await f.waitRun(run, (r) => r.state === "ready", "the delivery");
      const gates = rows<{ stage: string; state: string; feedback: string | null }>(f, "SELECT stage, state, feedback FROM gates WHERE run_id = ?1 AND kind = 'review' ORDER BY opened_at", run);
      expect(gates.map((g) => `${g.stage}:${g.state}`)).toEqual(["design:passed", "qa:changes", "qa:passed"]);
      expect(gates[1]!.feedback).toBe("The button is off-screen on a phone.");
    },
    { timeout: 150_000 },
  );

  test(
    "a gate pass binds to the gate you were shown: a prompt for an earlier gate, or another gate id, is refused",
    async () => {
      ship = await makeShipEnv({ mode: "local-only" });
      const e = ship;
      const f = e.fleet;
      expect((await f.json(["project", "set", "web", "--workflow", "feature-ui"])).code).toBe(0);
      const leader = await e.claude();
      await leader.start();
      const steps = ["Feature three", "FAKE: stage-done --review lavish:three/design-1.html", "FAKE: stage-done --review lavish:three/design-2.html", "FAKE: sleep 120000"].join("\n");
      const dispatched = await f.json(["dispatch", "web", "--kind", "ship", "--body-file", "-"], { env: { FLOWRYN_TOKEN: e.leaderToken() }, stdin: steps });
      const { task, run } = dispatched.reply.data as { task: string; run: string };
      await f.waitRun(run, (r) => r.stage_state === "review", "the first design review");
      const first = one<{ id: string }>(f, "SELECT id FROM gates WHERE run_id = ?1 AND state = 'open'", run)!.id;

      // You were prompted for the first gate; it is sent back and a second one opens before the pass runs.
      const prompted = await leader.runBash(`flowryn gate pass ${task} --json`, { approve: false });
      expect(prompted).toMatchObject({ prompted: true, ran: false });
      expect((await f.json(["gate", "changes", task, "--body-file", "-"], { env: { FLOWRYN_TOKEN: e.leaderToken() }, stdin: "Try again." })).code).toBe(0);
      await f.waitRun(run, (r) => r.stage_state === "review" && one(f, "SELECT 1 FROM gates WHERE run_id = ?1 AND state = 'open' AND id != ?2", run, first) !== null, "the second design review");
      const second = one<{ id: string }>(f, "SELECT id FROM gates WHERE run_id = ?1 AND state = 'open'", run)!.id;

      const stale = await f.json(["gate", "pass", task], { env: { FLOWRYN_TOKEN: e.leaderToken() } });
      expect(stale.reply.error).toMatchObject({ code: "approval_required" });
      expect((stale.reply.error as { message: string }).message).toContain(`showed gate ${first}`);
      const otherId = await f.json(["gate", "pass", task, "--gate-id", first], { env: { FLOWRYN_TOKEN: e.leaderToken() } });
      expect(otherId.reply.error).toMatchObject({ code: "not_ready" });
      expect(one<{ state: string }>(f, "SELECT state FROM gates WHERE id = ?1", second)!.state).toBe("open");

      const yes = await leader.runBash(`flowryn gate pass ${task} --gate-id ${second} --json`, { approve: true });
      expect(yes).toMatchObject({ ran: true, code: 0 });
      expect(JSON.parse(yes.stdout).data).toMatchObject({ gate: second, channel: "claude-ask" });
    },
    { timeout: 90_000 },
  );

  test(
    "a stage with fresh = true starts a new worker session in the same worktree",
    async () => {
      fleet = await makeFleetEnv({
        extraConfig: '[workflows.twopass]\nstages = [ { id = "build" }, { id = "check", fresh = true }, { id = "ship", gate = "merge" } ]',
      });
      const f = fleet;
      const steps = ["Two passes", "FAKE: commit a.txt one", "FAKE: stage-done", "FAKE: deliver-local", "FAKE: sleep 120000"].join("\n");
      const dispatched = await f.json(["dispatch", "web", "--kind", "ship", "--workflow", "twopass", "--body-file", "-"], { stdin: steps });
      expect(dispatched.code).toBe(0);
      const run = String((dispatched.reply.data as { run: string }).run);
      const first = await f.waitRun(run, (r) => r.agent_session !== null && r.worker_started_at !== null, "the first worker");
      const later = await f.waitRun(run, (r) => r.stage === "ship" && r.worker_started_at !== null && r.agent_session !== first.agent_session, "the fresh worker", 30_000);
      expect(f.events(run)).toContain("run.fresh_worker");
      expect(later.worktree_path).toBe(first.worktree_path);
      await f.waitRun(run, (r) => r.state === "ready", "the delivery");
    },
    { timeout: 90_000 },
  );

  test(
    "a fresh stage whose old worker does not exit keeps it and its slots, and replaces it once when it does",
    async () => {
      // The host probe holds the check stage's grant (its browser pool needs the host check) while the test swaps the worker.
      const probeDir = mkdtempSync(join(tmpdir(), "fw-fresh-probe-"));
      const hostFile = join(probeDir, "host.json");
      const probe = join(probeDir, "probe");
      writeFileSync(probe, `#!/bin/sh\ncat ${JSON.stringify(hostFile)}\n`);
      chmodSync(probe, 0o755);
      const setHost = (freeGb: number) => writeFileSync(hostFile, JSON.stringify({ free_mem_gb: freeGb, load_per_core: 0.2 }));
      setHost(64);
      // Not a group leader: exitRun signals the group the recorded pid leads, finds none, and the process outlives it.
      const stubborn = Bun.spawn(["sleep", "600"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      try {
        fleet = await makeFleetEnv({
          extraConfig: [
            "[capacity.host]",
            `probe = ${JSON.stringify(probe)}`,
            "[sched]",
            "pass_ms = 250",
            "host_cache_ms = 50",
            "[workflows.twopass]",
            'stages = [ { id = "build" }, { id = "check", fresh = true, pools = ["browser"] }, { id = "ship", gate = "merge" } ]',
          ].join("\n"),
        });
        const f = fleet;
        const steps = ["Two passes", "FAKE: commit a.txt one", "FAKE: wait-file go", "FAKE: stage-done", "FAKE: deliver-local", "FAKE: sleep 120000"].join("\n");
        const dispatched = await f.json(["dispatch", "web", "--kind", "ship", "--workflow", "twopass", "--body-file", "-"], { stdin: steps });
        expect(dispatched.code).toBe(0);
        const { task, run } = dispatched.reply.data as { task: string; run: string };
        await f.waitRun(run, (r) => r.proc_pid !== null && r.worker_started_at !== null, "the first worker");
        setHost(2);
        await Bun.write(join(f.h.dataDir, task, "go"), "");
        // Waiting for its grant, the run is the scheduler's: the reconciler leaves its recorded worker alone.
        await f.waitRun(run, (r) => r.stage === "check" && r.stage_state === "waiting" && r.pending_launch === "stage", "the fresh stage waiting for the host");
        const identity = await waitForIdentity(stubborn.pid);
        const db = f.h.db();
        db.query("UPDATE runs SET proc_pid = ?2, proc_start = ?3, proc_exe = ?4 WHERE id = ?1").run(run, identity.pid, identity.start, identity.exe);
        db.close();
        const session = f.run(run).agent_session;
        setHost(64);

        await until(f, "the refused exits' P1", () => one(f, "SELECT 1 FROM items WHERE kind = 'worker_not_exited' AND run_id = ?1 AND state = 'open'", run) !== null);
        expect(f.run(run)).toMatchObject({ stage: "check", stage_state: "active", pending_launch: "stage", proc_pid: identity.pid, agent_session: session });
        expect(f.events(run)).toContain("run.fresh_worker_refused");
        expect(f.events(run)).not.toContain("run.fresh_worker");
        expect(rows<{ pool: string }>(f, "SELECT pool FROM pool_leases WHERE run_id = ?1 AND released_at IS NULL", run).map((l) => l.pool).toSorted()).toEqual(["browser", "worker"]);

        stubborn.kill("SIGKILL");
        await stubborn.exited;
        await f.waitRun(run, (r) => r.agent_session !== session && r.worker_started_at !== null && r.pending_launch === null, "the fresh worker", 30_000);
        await f.waitRun(run, (r) => r.state === "ready", "the delivery");
        expect(f.events(run).filter((k) => k === "run.fresh_worker")).toHaveLength(1);
        expect(f.events(run).filter((k) => k === "run.launched")).toHaveLength(2);
        expect(one<{ state: string }>(f, "SELECT state FROM items WHERE kind = 'worker_not_exited' AND run_id = ?1", run)).toEqual({ state: "resolved" });
      } finally {
        stubborn.kill("SIGKILL");
        rmSync(probeDir, { recursive: true, force: true });
      }
    },
    { timeout: 90_000 },
  );
});

/** ps as the daemon runs it: TZ=UTC (the test home's env), so lstart, in local time, parses to the same start. */
const utcPs: PsRunner = async (pids) => {
  const proc = Bun.spawn(["/bin/ps", "-o", "pid=,lstart=,comm=", "-p", pids.join(",")], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return out;
};

/** The process's identity as the daemon reads it. */
async function waitForIdentity(pid: number): Promise<ProcIdentity> {
  let identity: ProcIdentity | null = null;
  await waitUntil(async () => (identity = await readIdentity(pid, utcPs)) !== null, 5_000, `the identity of pid ${pid}`);
  return identity!;
}
