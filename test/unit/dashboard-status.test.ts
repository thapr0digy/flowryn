import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type FlowrynConfig } from "../../src/config/config.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { ETA_BASIS } from "../../src/dashboard/eta.ts";
import { buildStatus, type BatchItem, type LandingLine, type QueueItem, type VerifyItem } from "../../src/dashboard/status.ts";
import { insertVerification } from "../../src/verify/store.ts";
import { FLEET_TASKS, seedDashboardFleet } from "../helpers/dashboard-fleet.ts";

/** The dashboard's summary over a seeded fleet (docs/notes/2026-11-24-a-live-build-t8.md). */

const MIN = 60_000;
const NOW = 1_000 * 60 * MIN;

let dir: string;
let db: Db;
let config: FlowrynConfig;
let logged: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-dash-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  config = parseConfig("[capacity]\nvalidation = 2\n", dir);
  logged = [];
  seedDashboardFleet(db, NOW);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function status() {
  return buildStatus({ db, config, now: NOW, build: "b1", log: (line) => logged.push(line) });
}

describe("buildStatus", () => {
  test("a running verify: its steps, what runs now, elapsed and the estimate from the median of its history", () => {
    const verifies = status().verifies as VerifyItem[];
    expect(verifies).toHaveLength(1);
    const v = verifies[0]!;
    expect(v).toMatchObject({
      id: "v4",
      request: "vq1",
      project: "web",
      for: { kind: "task", id: FLEET_TASKS.running },
      pr: "https://github.com/acme/web/pull/211",
      head: "1a2b3c4d",
      elapsed_ms: 8 * MIN,
      current: ["bun test"],
      eta: { left_ms: 5 * MIN + MIN, basis: ETA_BASIS, over_ms: 0 },
      eta_why: null,
      show: "flowryn verify show v4",
    });
    expect(v.steps.map((s) => [s.name, s.state, s.usual_ms])).toEqual([
      ["bun install", "passed", MIN],
      ["bun run typecheck", "passed", 2 * MIN],
      ["bun test", "running", 10 * MIN],
      ["bun run docs", "waiting", MIN],
    ]);
    expect(v.steps[2]).toMatchObject({ elapsed_ms: 5 * MIN, approx: false });
  });

  test("the verify queue in order, with its reasons and when each should start", () => {
    const queue = status().verify_queue as QueueItem[];
    expect(queue.map((q) => [q.id, q.position, q.for.kind, q.for.id])).toEqual([
      ["vq2", 1, "task", FLEET_TASKS.queued],
      ["vq3", 2, "batch", "lb1"],
    ]);
    // One validation slot of two is free: vq2 starts now; vq3 takes the running verify's slot in about 6 min. A typical web verify is 14 min.
    expect(queue[0]!.eta).toEqual({ starts_in_ms: 0, done_in_ms: 14 * MIN });
    expect(queue[1]!.eta).toEqual({ starts_in_ms: 6 * MIN, done_in_ms: 20 * MIN });
    expect(queue[1]!.why).toBe("behind vq2");
    expect(queue[1]!.pr).toBeNull();
    expect(queue[0]!.show).toBe("flowryn verify show vq2");
  });

  test("a request waiting on its own PR gets its reason, not an estimate", () => {
    db.query("UPDATE verify_queue SET wait_reason = 'forge_outage', wait_ref = 'unavailable 502', wait_since = ?1 WHERE id = 'vq2'").run(NOW);
    const queue = status().verify_queue as QueueItem[];
    expect(queue[0]!.eta).toEqual({ starts_in_ms: null, why: "GitHub is unavailable (unavailable 502), so its PR cannot be read" });
    expect(queue[1]!.eta).toEqual({ starts_in_ms: 0, done_in_ms: 14 * MIN });
  });

  test("a failing host check holds every estimate with its reason", () => {
    db.query("INSERT INTO meta (key, value) VALUES ('sched_host', ?1)").run(JSON.stringify({ ok: false, reason: "load 3.1 per core", since: NOW - MIN, free_mem_gb: 2, load_per_core: 3.1 }));
    const s = status();
    expect((s.verify_queue as QueueItem[])[0]!.eta).toEqual({ starts_in_ms: null, why: "the host check fails (load 3.1 per core)" });
    expect(s.host).toMatchObject({ ok: false });
  });

  test("each project's landing line in order, with the board's own words", () => {
    const landing = status().landing as LandingLine[];
    expect(landing).toHaveLength(1);
    expect(landing[0]!.project).toBe("web");
    expect(landing[0]!.batches).toBe(true);
    expect(landing[0]!.entries.map((e) => [e.task, e.state, e.place])).toEqual([
      [FLEET_TASKS.first, "landing", "1 of 3"],
      [FLEET_TASKS.second, "landing", "2 of 3"],
      [FLEET_TASKS.waiting, "waiting", "3 of 3"],
    ]);
    expect(landing[0]!.entries[0]!.show).toBe(`flowryn show ${FLEET_TASKS.first}`);
    expect(landing[0]!.entries.every((e) => e.line.length > 0 && e.cell.length > 0)).toBe(true);
  });

  test("a live batch with its members, as show lb<N> has them", () => {
    const batches = status().batches as BatchItem[];
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ id: "lb1", project: "web", state: "verifying", show: "flowryn show lb1" });
    expect(batches[0]!.members).toEqual([
      { task: FLEET_TASKS.first, pos: 1, state: "landing" },
      { task: FLEET_TASKS.second, pos: 2, state: "landing" },
    ]);
    expect(batches[0]!.line).toContain("lb1");
  });

  test("pools from the capacity view, counting the running verify's slot", () => {
    const s = status();
    expect(s.pools).toContainEqual({ pool: "validation", used: 1, cap: 2 });
    expect(s.waiting).toEqual({ runs: [], more: null });
    expect(s).toMatchObject({ version: 1, build: "b1", now: NOW });
  });

  test("a section that cannot be read says so and the others still render", () => {
    tx(db, () => db.query("UPDATE verifications SET steps = 'not json' WHERE id = 'v4'").run());
    const s = status();
    expect(s.verifies).toEqual({ error: "could not read the running verifies" });
    expect(Array.isArray(s.landing)).toBe(true);
    expect(logged.some((l) => l.startsWith("dashboard: could not read the running verifies"))).toBe(true);
  });

  test("the summary carries no step output, detail text or path", () => {
    tx(db, () => db.query("UPDATE verifications SET detail = 'SECRET_TOKEN=abc' WHERE id = 'v4'").run());
    const text = JSON.stringify(status());
    expect(text).not.toContain("SECRET_TOKEN");
    expect(text).not.toContain("/tmp/");
    expect(text).not.toContain(".log");
  });

  test("assumption: a summary over 200 finished verifications builds in under 50 ms", () => {
    tx(db, () => {
      for (let i = 0; i < 200; i++) {
        insertVerification(db, { project_id: "web", pr_url: `https://github.com/acme/web/pull/${1000 + i}`, task_id: null, head_sha: "f".repeat(40), steps: [], policy_id: "p1", dir: () => "/tmp/x", worktree: () => "/tmp/x/wt", project_path: "/tmp/web", source: "cli", now: NOW - 200 * MIN + i });
      }
      db.query("UPDATE verifications SET state = 'passed', finished_at = started_at + 600000 WHERE state = 'running' AND id <> 'v4'").run();
    });
    status();
    const started = performance.now();
    status();
    expect(performance.now() - started).toBeLessThan(50);
  });
});
