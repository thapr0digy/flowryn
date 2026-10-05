import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitUntil } from "../helpers/harness.ts";
import { makeFleetEnv, type FleetEnv } from "../helpers/fleet-env.ts";

/**
 * The M5 capacity exit (design section 17, "20 workers under the caps"),
 * proven with M2's fake workers (real processes through the real CLI, no
 * model calls) on the fake Herdr: 24 ships against a 20-worker cap, the
 * design's pools (5 validation, 5 Docker environments, 5 browsers), the host
 * check fed by a probe file, and the queue. A sampler reads flowryn.db every
 * 50 ms and fails the test if any pool ever holds more live leases than its
 * cap. The live-Herdr version of this run is scripts/lab/m5-live.sh capacity.
 */

let env: FleetEnv | null = null;
const dirs: string[] = [];

afterEach(async () => {
  await env?.cleanup();
  env = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CAPS = { worker: 20, validation: 5, docker_env: 5, browser: 5 };

/** A probe the host check runs instead of vm_stat: the test writes what the host "has". */
function hostProbe(): { probe: string; set(freeGb: number, load?: number): void } {
  const dir = mkdtempSync(join(tmpdir(), "fw-probe-"));
  dirs.push(dir);
  const file = join(dir, "host.json");
  const probe = join(dir, "probe");
  writeFileSync(probe, `#!/bin/sh\ncat ${JSON.stringify(file)}\n`);
  chmodSync(probe, 0o755);
  const set = (freeGb: number, load = 0.2) => writeFileSync(file, JSON.stringify({ free_mem_gb: freeGb, load_per_core: load }));
  set(64);
  return { probe, set };
}

function query<T>(e: FleetEnv, sql: string, ...params: (string | number)[]): T[] {
  const db = e.h.db();
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

function counts(e: FleetEnv): Record<string, number> {
  return Object.fromEntries(query<{ pool: string; n: number }>(e, "SELECT pool, COUNT(*) AS n FROM pool_leases WHERE released_at IS NULL GROUP BY pool").map((r) => [r.pool, r.n]));
}

/** Samples the live leases until stopped; any sample over a cap is recorded. */
function sampler(e: FleetEnv): { stop(): Promise<{ max: Record<string, number>; over: string[]; samples: number }> } {
  const max: Record<string, number> = {};
  const over: string[] = [];
  let samples = 0;
  const state = { running: true };
  const loop = (async () => {
    while (state.running) {
      const now = counts(e);
      samples++;
      for (const [pool, n] of Object.entries(now)) {
        max[pool] = Math.max(max[pool] ?? 0, n);
        const cap = CAPS[pool as keyof typeof CAPS];
        if (cap !== undefined && n > cap) over.push(`${pool} ${n}/${cap}`);
      }
      await Bun.sleep(50);
    }
  })();
  return {
    async stop() {
      state.running = false;
      await loop;
      return { max, over, samples };
    },
  };
}

function release(e: FleetEnv, task: string, name: string): void {
  const dir = join(e.h.dataDir, task);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), "");
}

const LOAD = (n: number) =>
  [
    `Load ${n}`,
    "FAKE: wait-file go-build",
    "FAKE: stage-done",
    `FAKE: docker-up qa-${n} flowryn-load-${n}`,
    "FAKE: wait-file go-qa",
    `FAKE: docker-down qa-${n}`,
    "FAKE: stage-done",
    "FAKE: wait-file go-ship",
    `FAKE: commit load-${n}.txt done`,
    "FAKE: deliver-local",
    "FAKE: sleep 600000",
  ].join("\n");

describe("M5 exit: 20 workers under the caps, the host check and the queue", () => {
  test(
    "24 ships against 20 worker slots: the caps hold, the host check gates every grant, and the queue drains in order",
    async () => {
      const host = hostProbe();
      env = await makeFleetEnv({
        timing: { pass_ms: 400, wait_poll_ms: 2_000 },
        extraConfig: [
          "[capacity]",
          ...Object.entries(CAPS).map(([k, v]) => `${k} = ${v}`),
          "[capacity.host]",
          "min_free_mem_gb = 8",
          "max_load_per_core = 1.5",
          `probe = ${JSON.stringify(host.probe)}`,
          "[sched]",
          "pass_ms = 300",
          "host_cache_ms = 100",
          "wait_alert_ms = 3000",
          "[workflows.load]",
          'stages = [ { id = "build" }, { id = "qa", pools = ["docker_env", "browser"] }, { id = "ship", pools = ["validation"], gate = "merge" } ]',
        ].join("\n"),
      });
      const e = env;
      expect((await e.json(["project", "set", "web", "--workflow", "load"])).code).toBe(0);
      const watch = sampler(e);
      const tasks: { task: string; run: string }[] = [];
      const dispatch = async (n: number) => {
        const r = await e.json(["dispatch", "web", "--kind", "ship", "--harness", n % 2 === 0 ? "claude" : "pi", "--body-file", "-"], { stdin: LOAD(n) });
        expect(r.code).toBe(0);
        const data = r.reply.data as { task: string; run: string; state: string };
        tasks.push({ task: data.task, run: data.run });
        return data;
      };
      const live = () => query<{ n: number }>(e, "SELECT COUNT(*) AS n FROM runs WHERE proc_pid IS NOT NULL AND state NOT IN ('cleaned','failed','cancelled')")[0]!.n;
      const waiting = () => query<{ task_id: string }>(e, "SELECT task_id FROM runs WHERE state NOT IN ('cleaned','failed','cancelled') AND (stage_state = 'waiting' OR pending_launch IS NOT NULL) ORDER BY waiting_since").map((r) => r.task_id);

      // 1 · The host check refuses: nothing new is granted, the capacity view says why, and a wait over the alert opens one P1.
      host.set(2);
      for (let n = 1; n <= 3; n++) expect((await dispatch(n)).state).toBe("waiting for capacity");
      const blocked = await e.json(["capacity"]);
      expect(JSON.stringify(blocked.reply.data)).toContain("blocked: 2.0 GB available, under 8 GB");
      await waitUntil(() => query(e, "SELECT 1 FROM items WHERE kind = 'capacity_wait' AND state IN ('open','presented')").length === 1, 15_000, "the capacity P1");
      expect(live()).toBe(0);

      // 2 · The host recovers: the queue starts, and the P1 closes.
      host.set(64);
      await waitUntil(() => live() === 3, 30_000, "the first three workers");
      await waitUntil(() => query(e, "SELECT 1 FROM items WHERE kind = 'capacity_wait' AND state = 'resolved'").length === 1, 15_000, "the capacity P1 to close");

      // 3 · 24 ships, 20 worker slots: 20 run, 4 wait for a worker.
      for (let n = 4; n <= 24; n++) await dispatch(n);
      await waitUntil(() => live() === 20, 60_000, "20 live workers");
      await Bun.sleep(1_000);
      expect(live()).toBe(20);
      expect(counts(e).worker).toBe(20);
      expect(waiting()).toEqual(tasks.slice(20).map((t) => t.task));
      const queued = await e.json(["capacity"]);
      expect(JSON.stringify(queued.reply.data)).toContain("full: worker");

      // 4 · Every running worker finishes its build: only 5 get QA (Docker environment + browser); 15 wait.
      const started = tasks.slice(0, 20);
      for (const t of started) release(e, t.task, "go-build");
      await waitUntil(() => (counts(e).docker_env ?? 0) === 5 && waiting().length === 4 + 15, 60_000, "5 in QA and 15 waiting for it");
      const inQa = query<{ task_id: string }>(e, "SELECT r.task_id FROM runs r JOIN pool_leases l ON l.run_id = r.id WHERE l.pool = 'docker_env' AND l.released_at IS NULL").map((r) => r.task_id);
      expect(inQa.length).toBe(5);
      await waitUntil(() => query(e, "SELECT 1 FROM run_evidence WHERE source = 'docker'").length >= 5, 15_000, "Docker evidence for the QA runs");

      // 5 · QA finishes in waves of 5; each wave moves to ship (validation 5) and frees QA for the next.
      const holdingQa = () => query<{ task_id: string }>(e, "SELECT r.task_id FROM runs r JOIN pool_leases l ON l.run_id = r.id WHERE l.pool = 'docker_env' AND l.released_at IS NULL").map((r) => r.task_id);
      const done = new Set<string>();
      for (let wave = 0; wave < 4; wave++) {
        // One snapshot for both the check and the wave: a slot freed between two queries would let a wave of 4 through.
        let qa: string[] = [];
        await waitUntil(
          () => {
            qa = holdingQa();
            return qa.length === 5 && qa.every((t) => !done.has(t));
          },
          90_000,
          `QA wave ${wave + 1}`,
        );
        for (const task of qa) {
          done.add(task);
          release(e, task, "go-qa");
        }
        // Only 5 validate at once: the first wave ships; the later ones wait for validation.
        await waitUntil(() => (counts(e).validation ?? 0) === 5, 60_000, "5 validating");
      }
      await waitUntil(() => (counts(e).docker_env ?? 0) === 0, 90_000, "QA done");

      // 6 · The 5 validating ship: their slots pass to the next 5 waiting to ship, oldest first.
      const shipping = query<{ task_id: string }>(e, "SELECT r.task_id FROM runs r JOIN pool_leases l ON l.run_id = r.id WHERE l.pool = 'validation' AND l.released_at IS NULL").map((r) => r.task_id);
      for (const task of shipping) release(e, task, "go-ship");
      await waitUntil(() => query(e, "SELECT 1 FROM runs WHERE state = 'ready'").length === 5, 60_000, "5 delivered");
      await waitUntil(() => (counts(e).validation ?? 0) === 5, 30_000, "the next 5 validating");

      // 7 · Two runs end: two of the four waiting for a worker start, the oldest first.
      const firstWaiting = tasks.slice(20, 22).map((t) => t.task);
      for (const t of started.slice(0, 2)) expect((await e.json(["cancel", t.task])).code).toBe(0);
      await waitUntil(() => firstWaiting.every((task) => query(e, "SELECT 1 FROM runs WHERE task_id = ?1 AND proc_pid IS NOT NULL", task).length === 1), 30_000, "the two oldest waiting to start");
      expect(waiting().filter((task) => tasks.slice(20).some((t) => t.task === task))).toEqual(tasks.slice(22).map((t) => t.task));

      const seen = await watch.stop();
      expect(seen.over).toEqual([]);
      expect(seen.max).toMatchObject({ worker: 20, docker_env: 5, browser: 5, validation: 5 });
      expect(seen.samples).toBeGreaterThan(100);
    },
    { timeout: 300_000 },
  );

  test(
    "drain before fill: a stage closer to shipping gets a freed slot before older work that is further back",
    async () => {
      env = await makeFleetEnv({
        extraConfig: ['[capacity]', "cpu = 1", "[workflows.order]", 'stages = [ { id = "build", pools = ["cpu"] }, { id = "ship", pools = ["cpu"], gate = "merge" } ]'].join("\n"),
      });
      const e = env;
      const a = await e.json(["dispatch", "web", "--kind", "ship", "--workflow", "order", "--body-file", "-"], { stdin: "Near\nFAKE: wait-file go\nFAKE: stage-done\nFAKE: sleep 600000" });
      const aRun = String((a.reply.data as { run: string }).run);
      const aTask = String((a.reply.data as { task: string }).task);
      await e.waitRun(aRun, (r) => r.stage_state === "active" && r.proc_pid !== null, "A building");
      const b = await e.json(["dispatch", "web", "--kind", "ship", "--workflow", "order", "--body-file", "-"], { stdin: "Far\nFAKE: sleep 600000" });
      expect((b.reply.data as { state: string }).state).toBe("waiting for capacity");
      const bRun = String((b.reply.data as { run: string }).run);
      // B has waited longer than A's ship stage will, but A is one stage from shipping.
      release(e, aTask, "go");
      await e.waitRun(aRun, (r) => r.stage === "ship" && r.stage_state === "active", "A shipping");
      expect(e.run(bRun).pending_launch).toBe("fresh");
    },
    { timeout: 90_000 },
  );

  test(
    "Docker evidence: environments beyond a run's lease are a divergence; containers left without one are listed, never removed",
    async () => {
      env = await makeFleetEnv({ extraConfig: ["[workflows.qa]", 'stages = [ { id = "qa", pools = ["docker_env"] }, { id = "ship", gate = "merge" } ]'].join("\n") });
      const e = env;
      const greedy = await e.json(["dispatch", "web", "--kind", "ship", "--workflow", "qa", "--body-file", "-"], { stdin: "Greedy\nFAKE: docker-up one proj-a\nFAKE: docker-up two proj-b\nFAKE: sleep 600000" });
      const gRun = String((greedy.reply.data as { run: string }).run);
      await waitUntil(() => query(e, "SELECT 1 FROM divergences WHERE run_id = ?1 AND summary LIKE '%2 Docker environments%'", gRun).length === 1, 20_000, "the over-lease divergence");
      const sloppy = await e.json(["dispatch", "web", "--kind", "ship", "--workflow", "qa", "--body-file", "-"], { stdin: "Sloppy\nFAKE: docker-up left proj-c\nFAKE: stage-done\nFAKE: sleep 600000" });
      const sRun = String((sloppy.reply.data as { run: string }).run);
      await waitUntil(() => query(e, "SELECT 1 FROM items WHERE kind = 'docker_leftover' AND run_id = ?1", sRun).length === 1, 20_000, "the leftover P1");
      const line = query<{ line: string }>(e, "SELECT line FROM items WHERE kind = 'docker_leftover' AND run_id = ?1", sRun)[0]!.line;
      expect(line).toContain("docker rm -f left");
    },
    { timeout: 90_000 },
  );
});
