import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlowrynError } from "../../src/api/errors.ts";
import { openExplanations } from "../../src/attention/explanations.ts";
import { parseConfig, type FlowrynConfig } from "../../src/config/config.ts";
import { configSectionProblems, effectiveConfig } from "../../src/config/effective.ts";
import { projectMaxWorkers, projectWorkerLimits } from "../../src/config/workflows.ts";
import { contractRevision } from "../../src/contracts/revision.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import type { HostVerdict } from "../../src/sched/host.ts";
import { grantJobLease, grantLeases, OverCapacity, ProjectAtLimit, projectWorkerHolders } from "../../src/sched/pools.ts";
import { Scheduler } from "../../src/sched/scheduler.ts";
import { verifyConfig } from "../../src/verify/config.ts";

/**
 * `[projects.<id>] max_workers` (docs/notes/2026-10-26-a-cap-on-dt.md): the
 * project's worker slots are counted at the scheduler's grant, after the
 * shared pools, and again inside the transaction that takes the slot. Driven
 * through the real scheduler with the account, harness and host checks stood in.
 */

const HOME = "/tmp/fw-project-limit";
const CONFIG = (extra = "[projects.web]\nmax_workers = 1\n") => `[tools]\nclaude = "/bin/true"\n${extra}`;

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-plimit-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  tx(db, () => {
    for (const p of ["web", "api"]) db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES (?1, '', ?2, 'main', 'local-only')").run(p, join(dir, p));
    db.query("INSERT INTO harness_contracts (harness, version, revision, passed_at) VALUES ('claude', '1', ?1, 0)").run(contractRevision("claude"));
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface RunSeed {
  project?: string;
  kind?: "scout" | "ship";
  /** The launch the run waits for; null: a live worker waiting for its next stage. */
  launch?: "fresh" | "resume" | null;
  at?: number;
}

/** A run waiting for a grant: a first launch by default. */
function waiting(run: string, seed: RunSeed = {}): void {
  const { project = "web", kind = "scout", launch = "fresh", at = 1 } = seed;
  const task = run.replace("r", "t");
  tx(db, () => {
    db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES (?1, ?2, ?3, 'local-only', 0, 'scout', 0)").run(task, project, kind);
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, model, state, liveness, workflow, stage, agent_session, worktree_path, branch, base_sha,
         token_hash, started_at, updated_at, stage_state, waiting_since, pending_launch)
       VALUES (?1, ?2, 'claude', '1', 'opus', 'launching', ?5, 'scout', 'scout', 'sess', ?3, 'b', 'abc', 'h', ?4, ?4, 'waiting', ?4, ?6)`,
    ).run(run, task, join(dir, task), at, launch === null ? "busy" : "starting", launch);
  });
}

/** A run of the project that holds a live worker slot. */
function holding(run: string, project = "web"): void {
  waiting(run, { project, launch: null });
  tx(db, () => {
    db.query("UPDATE runs SET stage_state = 'active', waiting_since = NULL WHERE id = ?1").run(run);
    db.query("INSERT INTO pool_leases (pool, run_id, stage, granted_at) VALUES ('worker', ?1, 'scout', 0)").run(run);
  });
}

const now = () => 1_000_000;

async function pass(config: FlowrynConfig = parseConfig(CONFIG(), HOME)): Promise<string[]> {
  const launches: string[] = [];
  const s = new Scheduler({
    db,
    config: () => config,
    now,
    log: () => {},
    launch: (runId, mode) => {
      launches.push(`${runId}:${mode}`);
      db.query("UPDATE runs SET pending_launch = NULL WHERE id = ?1").run(runId);
    },
    isLaunching: () => false,
    exitWorker: async () => ({ ok: true }),
    notify: () => {},
    startDeps: { db, config: () => config, runtime: () => null, harnessVersion: async () => "1", git: async () => null, signIn: async () => null, now },
    kickJournal: () => {},
    host: async () => ({ ok: true, reason: "test" }) as HostVerdict,
    quota: async () => ({ state: "known", percent: 80, window: "five_hour", resets_at: null }),
  });
  await s.passNow();
  await s.stop();
  return launches;
}

const reasons = (id: string) => openExplanations(db, id).map((r) => [r.rule, r.reason]);
const stageState = (id: string) => (db.query("SELECT stage_state FROM runs WHERE id = ?1").get(id) as { stage_state: string }).stage_state;

function refused(text: string): string | null {
  try {
    projectMaxWorkers(parseConfig(text, HOME), "web");
    return null;
  } catch (error) {
    return (error as FlowrynError).code;
  }
}

describe("[projects.<id>] max_workers in config", () => {

  test("absent is no limit; a positive integer is the limit", () => {
    expect(projectMaxWorkers(parseConfig(CONFIG(""), HOME), "web")).toBeNull();
    expect(projectMaxWorkers(parseConfig(CONFIG("[projects.web]\nverify = [\"true\"]\n"), HOME), "web")).toBeNull();
    expect(projectMaxWorkers(parseConfig(CONFIG("[projects.web]\nmax_workers = 2\n"), HOME), "web")).toBe(2);
    expect(projectWorkerLimits(parseConfig(CONFIG("[projects.web]\nmax_workers = 2\n[projects.api]\nverify = [\"true\"]\n"), HOME))).toEqual([{ project: "web", max: 2 }]);
  });

  test("zero, a negative, a fraction and a string are refused", () => {
    for (const value of ["0", "-1", "1.5", '"2"']) expect(refused(CONFIG(`[projects.web]\nmax_workers = ${value}\n`))).toBe("config_invalid");
  });

  test("assumption: a bad value is refused when the config loads, and a good one is a known project key", () => {
    expect(configSectionProblems(parseConfig(CONFIG("[projects.web]\nmax_workers = 0\n"), HOME), {})).toEqual(["[projects.web] max_workers must be a positive integer"]);
    const good = parseConfig(CONFIG("[projects.web]\nmax_workers = 3\n"), HOME);
    expect(configSectionProblems(good, {})).toEqual([]);
    expect(verifyConfig(good, "web")).toBeNull();
    expect((effectiveConfig(good, {}).sections.projects as Record<string, unknown>).web).toEqual({ verify: "none", max_workers: 3 });
  });
});

describe("counting a project's workers", () => {
  test("assumption: scouts and ships count; released slots, other projects' slots and job slots do not", () => {
    holding("r1");
    waiting("r2", { kind: "ship", launch: null });
    tx(db, () => db.query("INSERT INTO pool_leases (pool, run_id, stage, granted_at) VALUES ('worker', 'r2', 'scout', 1)").run());
    holding("r3", "api");
    waiting("r4", { launch: null });
    tx(db, () => {
      db.query("INSERT INTO pool_leases (pool, run_id, stage, granted_at, released_at, released_by) VALUES ('worker', 'r4', 'scout', 0, 5, 'test')").run();
      db.query("INSERT INTO pool_leases (pool, run_id, stage, granted_at) VALUES ('validation', 'r4', 'ship', 0)").run();
      grantJobLease(db, { kind: "verify", id: "v1", taskId: "t1" }, "worker", { worker: 20 }, 0);
    });
    expect(projectWorkerHolders(db, "web")).toEqual(["t1", "t2"]);
    expect(projectWorkerHolders(db, "api")).toEqual(["t3"]);
  });

  test("assumption: the grant re-counts in its transaction: a worker slot over the limit throws ProjectAtLimit and takes nothing", () => {
    holding("r1");
    waiting("r2");
    const limit = { project: "web", max: 1 };
    let thrown: unknown = null;
    try {
      tx(db, () => grantLeases(db, "r2", "t2", "scout", ["worker"], { worker: 20 }, 0, limit));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectAtLimit);
    expect(thrown).toBeInstanceOf(OverCapacity);
    expect(projectWorkerHolders(db, "web")).toEqual(["t1"]);
    // A stage pool alone is never held by the project's limit.
    tx(db, () => grantLeases(db, "r2", "t2", "ship", ["validation"], { worker: 20, validation: 5 }, 0, limit));
    // Under the limit the worker slot is taken.
    tx(db, () => grantLeases(db, "r2", "t2", "scout", ["worker"], { worker: 20 }, 0, { project: "web", max: 2 }));
    expect(projectWorkerHolders(db, "web")).toEqual(["t1", "t2"]);
  });
});

describe("the scheduler's grant", () => {
  test("a project at its limit holds its next start with the reason, and another project's run starts past it", async () => {
    waiting("r1", { at: 1 });
    waiting("r2", { at: 2 });
    waiting("r3", { project: "api", at: 3 });
    expect(await pass()).toEqual(["r1:fresh", "r3:fresh"]);
    expect(reasons("r2")).toEqual([["capacity.project_full", "project web is at its worker limit (1/1)"]]);
    expect(projectWorkerHolders(db, "web")).toEqual(["t1"]);
  });

  test("the waiting run starts once one of the project's workers ends", async () => {
    holding("r1");
    waiting("r2");
    expect(await pass()).toEqual([]);
    tx(db, () => db.query("UPDATE pool_leases SET released_at = 9, released_by = 'test' WHERE run_id = 'r1'").run());
    expect(await pass()).toEqual(["r2:fresh"]);
    expect(reasons("r2")).toEqual([]);
  });

  test("assumption: a live worker's next stage is never held at the limit: it keeps its slot", async () => {
    holding("r1");
    holding("r2");
    tx(db, () => db.query("UPDATE runs SET stage_state = 'waiting', waiting_since = 1 WHERE id = 'r2'").run());
    expect(await pass()).toEqual([]);
    expect(stageState("r2")).toBe("active");
    expect(reasons("r2")).toEqual([]);
  });

  test("assumption: a resume of a run whose worker died needs a new slot, so it is held at the limit", async () => {
    holding("r1");
    waiting("r2", { launch: "resume" });
    expect(await pass()).toEqual([]);
    expect(reasons("r2")).toEqual([["capacity.project_full", "project web is at its worker limit (1/1)"]]);
  });

  test("assumption: a limit lowered below what runs stops nothing; it only holds new starts", async () => {
    holding("r1");
    holding("r2");
    waiting("r3");
    expect(await pass()).toEqual([]);
    expect(projectWorkerHolders(db, "web")).toEqual(["t1", "t2"]);
    expect(reasons("r3")).toEqual([["capacity.project_full", "project web is at its worker limit (2/1)"]]);
  });

  test("without max_workers only the shared pool binds", async () => {
    holding("r1");
    waiting("r2");
    expect(await pass(parseConfig(CONFIG(""), HOME))).toEqual(["r2:fresh"]);
  });
});
