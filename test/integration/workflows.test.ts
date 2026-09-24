import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { waitUntil } from "../helpers/harness.ts";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";
import { M4_SHIP_WORKFLOW } from "../../src/db/schema.ts";

/**
 * Workflows, review gates, capacity grants and the usage-limit pause (design
 * section 11), end to end on the M2 fake Herdr and fake workers: each fake
 * worker runs `flowryn stage done` and carries on when the steer that starts
 * its next stage arrives, the way the worker contract tells a real one to.
 */

let ship: ShipEnv | null = null;
let fleet: FleetEnv | null = null;

afterEach(async () => {
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
    `FAKE: stage-done --review https://lavish.test/${name}/design`,
    `FAKE: commit ${name}.txt built`,
    "FAKE: stage-done",
    `FAKE: docker-up ${name}-web flowryn-${name}`,
    "FAKE: sleep 1500",
    `FAKE: docker-down ${name}-web`,
    `FAKE: stage-done --review https://lavish.test/${name}/qa`,
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
      expect((await f.json(["project", "set", "web", "--workflow", "feature"])).code).toBe(0);
      const leader = await e.claude();
      await leader.start();
      const dispatched = await f.json(["dispatch", "web", "--kind", "ship", "--body-file", "-"], { env: { FLOWRYN_TOKEN: e.leaderToken() }, stdin: FEATURE("one") });
      expect(dispatched.code).toBe(0);
      const { task, run } = dispatched.reply.data as { task: string; run: string };

      // Design: the worker hands in its page; a P1 names the link; nothing moves without your word.
      await f.waitRun(run, (r) => r.stage === "design" && r.stage_state === "review", "the design review");
      const gate = one<{ id: string; review_url: string }>(f, "SELECT id, review_url FROM gates WHERE run_id = ?1 AND kind = 'review' AND state = 'open'", run)!;
      expect(gate.review_url).toBe("https://lavish.test/one/design");
      expect(one<{ line: string }>(f, "SELECT line FROM items WHERE kind = 'gate_ready' AND run_id = ?1 AND state IN ('open','presented')", run)!.line).toContain("https://lavish.test/one/design");
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
    "changes at the QA review send the run back to build with your words; a worker cannot skip a gate",
    async () => {
      ship = await makeShipEnv({ mode: "local-only" });
      const e = ship;
      const f = e.fleet;
      expect((await f.json(["project", "set", "web", "--workflow", "feature"])).code).toBe(0);
      const steps = [
        "Feature two",
        "FAKE: verb deliver --local",
        "FAKE: stage-done --review https://lavish.test/two/design",
        "FAKE: commit two.txt first try",
        "FAKE: stage-done",
        "FAKE: stage-done --review https://lavish.test/two/qa-1",
        "FAKE: commit two.txt second try",
        "FAKE: stage-done",
        "FAKE: stage-done --review https://lavish.test/two/qa-2",
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
      const changes = await f.json(["gate", "changes", task, "--body-file", "-"], { stdin: "The button is off-screen on a phone." });
      expect(changes.code).toBe(0);
      expect(changes.reply.data).toMatchObject({ state: "changes", to: "build" });
      const steer = one<{ body: string }>(f, "SELECT body FROM messages WHERE run_id = ?1 AND body LIKE '%off-screen%'", run)!;
      expect(steer.body).toContain("Changes requested at the qa review: The button is off-screen on a phone. Back to stage build.");
      expect(steer.body).toContain("Flowryn stage build (2 of 4");

      await f.waitRun(run, (r) => r.stage === "qa" && r.stage_state === "review" && one(f, "SELECT 1 FROM gates WHERE run_id = ?1 AND review_url LIKE '%qa-2'", run) !== null, "the second QA review");
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
      expect((await f.json(["project", "set", "web", "--workflow", "feature"])).code).toBe(0);
      const leader = await e.claude();
      await leader.start();
      const steps = ["Feature three", "FAKE: stage-done --review https://lavish.test/three/design-1", "FAKE: stage-done --review https://lavish.test/three/design-2", "FAKE: sleep 120000"].join("\n");
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
});

describe("capacity is the contract for a delivery", () => {
  test(
    "no-mistakes: deliver --pr from build, without the ship stage started, is refused even with the pool free",
    async () => {
      ship = await makeShipEnv({ mode: "no-mistakes" });
      const e = ship;
      const f = e.fleet;
      // A worker that ignores its contract: it pushes and opens the PR from build, then delivers.
      const steps = ["Skips the slot", "FAKE: commit b.txt b", "FAKE: push", `FAKE: pr ${e.github.apiUrl} acme/web`, "FAKE: deliver-pr", "FAKE: sleep 600000"].join("\n");
      const { task, run } = await f.dispatch(steps, { kind: "ship" });
      const [refused] = await e.replies(task, 1);
      expect(refused!.reply.error).toMatchObject({ code: "stage_waiting", help: "$FLOWRYN_BIN stage begin ship, then run the pipeline and deliver" });
      expect(f.run(run)).toMatchObject({ state: "running", stage: "build", stage_state: "active" });
      expect(rows(f, "SELECT 1 FROM pool_leases WHERE run_id = ?1 AND pool = 'validation'", run)).toEqual([]);
      expect(rows(f, "SELECT 1 FROM artifacts WHERE task_id = ?1", task)).toEqual([]);
    },
    { timeout: 60_000 },
  );

  test(
    "no-mistakes: a pipeline that goes active before the ship stage holds its slot is observed and flagged as a P1",
    async () => {
      ship = await makeShipEnv({ mode: "no-mistakes" });
      const e = ship;
      const f = e.fleet;
      const { run } = await f.dispatch(["Runs the pipeline early", "FAKE: commit b.txt b", "FAKE: sleep 600000"].join("\n"), { kind: "ship" });
      const building = await f.waitRun(run, (r) => r.stage === "build" && r.stage_state === "active" && r.worker_started_at !== null, "the build stage");
      writeFileSync(join(f.h.home, "nm-status"), `run:\n  id: "01NM"\n  branch: ${building.branch}\n  status: running\n  head: "abc"\n  pr: ""\n`);
      await f.waitRun(run, (r) => r.state === "validating", "validating", 10_000);
      const item = one<{ lane: string; line: string }>(f, "SELECT lane, line FROM items WHERE kind = 'validation_outside_cap' AND run_id = ?1", run)!;
      expect(item.lane).toBe("P1");
      expect(item.line).toContain("Validation started outside the cap");
      expect(item.line).toContain("before stage ship holds its slot");
    },
    { timeout: 60_000 },
  );

  test(
    "a no-mistakes run open across the upgrade (frozen by migration 5) delivers without stage begin, under M4's contract",
    async () => {
      ship = await makeShipEnv({ mode: "no-mistakes" });
      const e = ship;
      const f = e.fleet;
      const steps = ["M4 contract", "FAKE: commit m4.txt m4", "FAKE: wait-file go", "FAKE: push", `FAKE: pr ${e.github.apiUrl} acme/web`, "FAKE: deliver-pr", "FAKE: sleep 600000"].join("\n");
      const { task, run } = await f.dispatch(steps, { kind: "ship" });
      const building = await f.waitRun(run, (r) => r.stage === "build" && r.stage_state === "active" && r.worker_started_at !== null, "the build stage");
      const db = f.h.db();
      try {
        db.query("UPDATE runs SET workflow_def = ?2 WHERE id = ?1").run(run, M4_SHIP_WORKFLOW);
      } finally {
        db.close();
      }
      const statusFile = join(f.h.home, "nm-status");
      writeFileSync(statusFile, `run:\n  id: "01NM"\n  branch: ${building.branch}\n  status: running\n  head: "abc"\n  pr: ""\n`);
      await f.waitRun(run, (r) => r.state === "validating", "validating", 10_000);
      writeFileSync(statusFile, `run:\n  id: "01NM"\n  branch: ${building.branch}\n  status: completed\n  head: "abc"\n  pr: ""\noutcome: passed\n`);
      await f.waitRun(run, (r) => r.state === "running", "running again", 10_000);
      writeFileSync(join(f.h.dataDir, task, "go"), "");
      await f.waitRun(run, (r) => r.state === "ready" && r.stage === "ship" && r.stage_state === "done", "the delivery");
      expect(one<{ released_by: string }>(f, "SELECT released_by FROM pool_leases WHERE run_id = ?1 AND pool = 'validation'", run)!.released_by).toBe("stage ship delivered");
      expect(rows(f, "SELECT 1 FROM items WHERE kind = 'validation_outside_cap' AND run_id = ?1", run)).toEqual([]);
    },
    { timeout: 90_000 },
  );

  test(
    "no-mistakes: stage begin waits while the validation cap is full, then holds the slot across the pipeline until the delivery",
    async () => {
      ship = await makeShipEnv({ mode: "no-mistakes", extraConfig: "[capacity]\nvalidation = 1" });
      const e = ship;
      const f = e.fleet;
      const holder = await f.dispatch(["Holds validation", "FAKE: commit a.txt a", "FAKE: stage-done", "FAKE: sleep 600000"].join("\n"), { kind: "ship" });
      await f.waitRun(holder.run, (r) => r.stage === "ship" && r.stage_state === "active", "the holder in its ship stage");
      const steps = [
        "Waits for its slot",
        "FAKE: commit b.txt b",
        "FAKE: verb stage begin ship",
        "FAKE: wait-file go",
        "FAKE: push",
        `FAKE: pr ${e.github.apiUrl} acme/web`,
        "FAKE: deliver-pr",
        "FAKE: sleep 600000",
      ].join("\n");
      const { task, run } = await f.dispatch(steps, { kind: "ship" });
      const validation = () => rows<{ run_id: string }>(f, "SELECT run_id FROM pool_leases WHERE pool = 'validation' AND released_at IS NULL").map((l) => l.run_id);

      // The cap is full: stage begin says stage_waiting, and the ship stage queues.
      const [waited] = await e.replies(task, 1);
      expect(waited!.reply.error).toMatchObject({ code: "stage_waiting" });
      expect(f.run(run)).toMatchObject({ state: "running", stage: "ship", stage_state: "waiting" });
      expect(validation()).toEqual([holder.run]);

      // The slot frees: the ship stage starts, and a steer says so.
      expect((await f.json(["cancel", holder.task])).code).toBe(0);
      const started = await f.waitRun(run, (r) => r.stage === "ship" && r.stage_state === "active", "the ship stage granted");
      expect(validation()).toEqual([run]);
      expect(one<{ body: string }>(f, "SELECT body FROM messages WHERE run_id = ?1 AND body LIKE '%Stage ship has started%'", run)!.body).toContain("Flowryn stage ship (2 of 2");

      // The pipeline runs (no-mistakes reports it active, then passed) under the slot; the delivery then releases it.
      const statusFile = join(f.h.home, "nm-status");
      writeFileSync(statusFile, `run:\n  id: "01NM"\n  branch: ${started.branch}\n  status: running\n  head: "abc"\n  pr: ""\n`);
      await f.waitRun(run, (r) => r.state === "validating", "validating", 10_000);
      expect(validation()).toEqual([run]);
      expect(rows(f, "SELECT 1 FROM items WHERE kind = 'validation_outside_cap'")).toEqual([]);
      writeFileSync(statusFile, `run:\n  id: "01NM"\n  branch: ${started.branch}\n  status: completed\n  head: "abc"\n  pr: ""\noutcome: passed\n`);
      await f.waitRun(run, (r) => r.state === "running", "running again", 10_000);
      expect(validation()).toEqual([run]);
      writeFileSync(join(f.h.dataDir, task, "go"), "");
      await f.waitRun(run, (r) => r.state === "ready" && r.stage_state === "done", "the delivery");
      expect(validation()).toEqual([]);
    },
    { timeout: 120_000 },
  );

  test(
    "with the pools free, a delivery from build takes its ship stage's slot at once and delivers",
    async () => {
      fleet = await makeFleetEnv();
      const f = fleet;
      const { run } = await f.dispatch(["Direct", "FAKE: commit c.txt c", "FAKE: deliver-local", "FAKE: sleep 600000"].join("\n"), { kind: "ship" });
      await f.waitRun(run, (r) => r.state === "ready", "the delivery");
      const started = rows<{ payload: string }>(f, "SELECT payload FROM events WHERE run_id = ?1 AND kind = 'stage.started' ORDER BY seq", run).map((r) => JSON.parse(r.payload) as { stage: string; steer: string | null });
      expect(started.map((s) => [s.stage, s.steer])).toEqual([["build", null], ["ship", null]]);
      expect(one<{ released_by: string }>(f, "SELECT released_by FROM pool_leases WHERE run_id = ?1 AND pool = 'validation'", run)!.released_by).toBe("stage ship delivered");
    },
    { timeout: 60_000 },
  );
});

describe("dispatch --blocked-by", () => {
  test(
    "a task can wait only for ships: a scout never lands, so it is refused as a blocker",
    async () => {
      fleet = await makeFleetEnv();
      const f = fleet;
      const scout = await f.dispatch("Look around\nFAKE: sleep 120000", { kind: "scout" });
      const refused = await f.json(["dispatch", "web", "--kind", "ship", "--blocked-by", scout.task, "--body-file", "-"], { stdin: "After the scout\nFAKE: sleep 120000" });
      expect(refused.code).not.toBe(0);
      expect(refused.reply.error).toMatchObject({ code: "bad_args" });
      expect((refused.reply.error as { message: string }).message).toContain(`${scout.task} is a scout`);
      expect(rows(f, "SELECT 1 FROM plans")).toEqual([]);
    },
    { timeout: 60_000 },
  );
});

describe("autonomy and the usage limit", () => {
  test(
    "a Claude usage limit pauses Claude launches until a Claude turn ends normally; Pi work carries on",
    async () => {
      fleet = await makeFleetEnv();
      const f = fleet;
      const a = await f.dispatch("Hits the limit\nFAKE: usage-limit\nFAKE: wait-file go", { kind: "scout", harness: "claude" });
      await until(f, "the pause", () => one(f, "SELECT 1 FROM items WHERE kind = 'usage_limit' AND state IN ('open','presented')") !== null);
      const b = await f.json(["dispatch", "web", "--kind", "scout", "--harness", "claude", "--body-file", "-"], { stdin: "Waits\nFAKE: sleep 120000" });
      expect((b.reply.data as { state: string }).state).toBe("waiting for capacity");
      const bRun = String((b.reply.data as { run: string }).run);
      const capacity = await f.json(["capacity"]);
      expect(JSON.stringify(capacity.reply.data)).toContain("Claude usage limit");
      const c = await f.dispatch("Pi goes on\nFAKE: sleep 120000", { kind: "scout", harness: "pi" });
      await f.waitRun(c.run, (r) => r.proc_pid !== null, "the Pi worker");
      expect(f.run(bRun).proc_pid).toBeNull();
      // The limiting turn ends normally: usage is available again, and the waiting Claude run starts.
      writeFileSync(join(f.h.dataDir, a.task, "go"), "");
      await f.waitRun(bRun, (r) => r.proc_pid !== null, "the paused Claude worker", 30_000);
      expect(one<{ state: string }>(f, "SELECT state FROM items WHERE kind = 'usage_limit'")!.state).toBe("resolved");
    },
    { timeout: 90_000 },
  );

  test(
    "a plan filed under manual autonomy waits for you; a phase never starts before its blockers land",
    async () => {
      fleet = await makeFleetEnv();
      const f = fleet;
      expect((await f.json(["project", "set", "web", "--autonomy", "manual"])).code).toBe(0);
      const filed = await f.json(["plan", "web", "--body-file", "-"], { stdin: "# Two steps\n## Phase 1: First\nFAKE: sleep 120000\n## Phase 2: Second\nFAKE: sleep 120000\n" });
      expect(filed.code).toBe(0);
      const data = filed.reply.data as { plan: string; phases: { task: string; blocked_by: string }[] };
      expect(data.phases[1]!.blocked_by).toBe(data.phases[0]!.task);
      await until(f, "the phases in the backlog", () => existsSync(f.h.backlog) && Bun.spawnSync(["grep", "-c", data.phases[1]!.task, f.h.backlog]).stdout.toString().trim() !== "0");
      await Bun.sleep(1_000);
      expect(rows(f, "SELECT 1 FROM runs")).toEqual([]);
      const second = await f.json(["dispatch", "web", "--task", data.phases[1]!.task]);
      expect(second.code).toBe(2);
      expect((second.reply.error as { code: string }).code).toBe("blockers_not_landed");
      const first = await f.json(["dispatch", "web", "--task", data.phases[0]!.task, "--sensitive"]);
      expect(first.code).toBe(0);
      expect(one<{ sensitive: number }>(f, "SELECT sensitive FROM task_policy WHERE task_id = ?1", data.phases[0]!.task)!.sensitive).toBe(1);
      const shown = await f.json(["show", data.plan]);
      expect(JSON.stringify(shown.reply.data)).toContain(`queued, waits for ${data.phases[0]!.task}`);
    },
    { timeout: 60_000 },
  );
});
