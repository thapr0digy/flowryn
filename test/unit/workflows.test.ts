import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlowrynError } from "../../src/api/errors.ts";
import { resolveRunItems } from "../../src/attention/items.ts";
import { parseConfig } from "../../src/config/config.ts";
import { capacityConfig, DEFAULT_WORKFLOWS, defaultAutonomy, schedTiming, styleBlock, workflowConfigProblems, workflowFor, workflowsConfig, type WorkflowDef } from "../../src/config/workflows.ts";
import { contractRevision } from "../../src/contracts/revision.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { STYLE_BLOCK, workerContract } from "../../src/harness/contract-text.ts";
import { escalateOperation, requestOperation } from "../../src/lifecycle/operations.ts";
import { parsePlan } from "../../src/lifecycle/plans.ts";
import { changesTarget, flowLine, positionOf, stageInstructions } from "../../src/lifecycle/stages.ts";
import { environments, parseDockerPs } from "../../src/reconcile/docker.ts";
import { judgeHost, parseVmStat, type HostVerdict } from "../../src/sched/host.ts";
import { fullPools, grantJobLease, grantLeases, liveCounts, liveJobLeases, OverCapacity, poolHolders, recordJobProcess, releaseJobLeases, releaseLeases, runLeases } from "../../src/sched/pools.ts";
import { EXIT_BACKOFF_MAX_MS, Scheduler } from "../../src/sched/scheduler.ts";
import { claimProbe, clearUsageLimit, noteUsageLimit, RESUME_COMMAND, usageGate, usagePause } from "../../src/sched/usage.ts";
import { skillPath, STAGE_SKILLS, writeStageSkills } from "../../src/skills/stages.ts";

const HOME = "/tmp/fw-m5";
const cfg = (text: string) => parseConfig(text, HOME);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("workflows (design section 11)", () => {
  test("the built-in workflows; only feature-ui carries visual QA, and a ship's ends in the merge gate", () => {
    const wf = workflowsConfig(cfg(""));
    expect(Object.keys(wf).toSorted()).toEqual(["feature", "feature-ui", "fix", "scout"]);
    expect(flowLine(wf.feature!)).toBe("design (review) → build → ship (merge)");
    expect(flowLine(wf["feature-ui"]!)).toBe("design (review) → build → qa (review) → ship (merge)");
    expect(flowLine(wf.fix!)).toBe("build → ship (merge)");
    expect(flowLine(wf.scout!)).toBe("investigate");
    expect(wf["feature-ui"]!.stages[2]).toMatchObject({ id: "qa", skill: "flowryn-visual-qa", pools: ["docker_env", "browser"] });
    expect(workflowFor(cfg(""), "feature", "ship").id).toBe("feature");
    expect(workflowFor(cfg(""), "feature-ui", "ship").id).toBe("feature-ui");
    expect(() => workflowFor(cfg(""), "scout", "ship")).toThrow("cannot ship");
    expect(() => workflowFor(cfg(""), "fix", "scout")).toThrow("delivers a report");
    expect(() => workflowFor(cfg(""), "nope", "ship")).toThrow("no workflow nope");
  });

  test("a [workflows.<id>] table adds or replaces one; its shape is checked", () => {
    const wf = workflowsConfig(cfg('[workflows.docs]\nstages = [ { id = "write", skill = "flowryn-design", gate = "review" }, { id = "ship", gate = "merge" } ]\n'));
    expect(flowLine(wf.docs!)).toBe("write (review) → ship (merge)");
    expect(wf.fix).toEqual(DEFAULT_WORKFLOWS.fix!);
    const bad = [
      '[workflows.x]\nstages = [ { id = "a", gate = "merge" }, { id = "b" } ]',
      '[workflows.x]\nstages = [ { id = "a" }, { id = "a", gate = "merge" } ]',
      '[workflows.x]\nstages = [ { id = "a", pools = ["gpu"] } ]',
      '[workflows.x]\nstages = [ { id = "a", pools = ["worker"] } ]',
      '[workflows.x]\nstages = [ { id = "a", gate = "maybe" } ]',
      '[workflows.x]\nstages = [ { id = "a" }, { id = "b", gate = "review" } ]',
      '[workflows.x]\nstages = []',
      '[workflows.x]\nstages = [ { id = "a", colour = "red" } ]',
    ];
    for (const text of bad) expect(workflowConfigProblems(cfg(text)).length).toBeGreaterThan(0);
    // A pool defined in [capacity] may be used.
    expect(workflowsConfig(cfg('[capacity]\ngpu = 1\n[workflows.x]\nstages = [ { id = "a", pools = ["gpu"] }, { id = "b", gate = "merge" } ]')).x!.stages[0]!.pools).toEqual(["gpu"]);
  });

  test("changes go back to the nearest earlier stage without a review gate, else to the gated stage", () => {
    const feature = DEFAULT_WORKFLOWS.feature!;
    expect(feature.stages[changesTarget(feature, 2)]!.id).toBe("build");
    expect(feature.stages[changesTarget(feature, 0)]!.id).toBe("design");
  });
});

describe("capacity, autonomy, the scheduler's clocks, the style block", () => {
  test("pools and the host check default to the design's numbers; [capacity] overrides and adds", () => {
    expect(capacityConfig(cfg(""))).toEqual({ pools: { worker: 20, validation: 5, docker_env: 5, browser: 5 }, host: { min_free_mem_gb: 8, max_load_per_core: 1.5, probe: null }, quota: { floor: 5 } });
    const c = capacityConfig(cfg('[capacity]\nworker = 3\ngpu = 1\n[capacity.host]\nmin_free_mem_gb = 0\nprobe = "bin/probe"\n'));
    expect(c.pools).toMatchObject({ worker: 3, gpu: 1, validation: 5 });
    expect(c.host).toEqual({ min_free_mem_gb: 0, max_load_per_core: 1.5, probe: `${HOME}/bin/probe` });
    for (const text of ["[capacity]\nworker = 0", "[capacity]\nworker = 1.5", "[capacity]\nBad = 1", "[capacity.host]\nmax_load_per_core = 0", "[capacity.host]\nspeed = 1"]) {
      expect(workflowConfigProblems(cfg(text)).length).toBeGreaterThan(0);
    }
  });

  test("the quota floor defaults to 5%; 0 turns it off; it is a percentage", () => {
    expect(capacityConfig(cfg("[capacity.quota]\nfloor = 0")).quota).toEqual({ floor: 0 });
    expect(capacityConfig(cfg("[capacity.quota]\nfloor = 12.5")).quota).toEqual({ floor: 12.5 });
    expect(capacityConfig(cfg("[capacity.quota]\nfloor = 12.5")).pools).not.toHaveProperty("quota");
    for (const text of ["[capacity.quota]\nfloor = -1", "[capacity.quota]\nfloor = 101", '[capacity.quota]\nfloor = "5"', "[capacity.quota]\nprobe = 1"]) {
      expect(workflowConfigProblems(cfg(text)).length).toBeGreaterThan(0);
    }
  });

  test("autonomy defaults to plan; [sched] clocks default to the design's 30 minutes", () => {
    expect(defaultAutonomy(cfg(""))).toBe("plan");
    expect(defaultAutonomy(cfg('[autonomy]\ndefault = "manual"'))).toBe("manual");
    expect(() => defaultAutonomy(cfg('[autonomy]\ndefault = "yolo"'))).toThrow(FlowrynError);
    expect(schedTiming(cfg("")).wait_alert_ms).toBe(30 * 60_000);
    expect(schedTiming(cfg("[sched]\nwait_alert_ms = 500")).wait_alert_ms).toBe(500);
    expect(schedTiming(cfg(""))).toMatchObject({ usage_backoff_ms: 15 * 60_000, usage_backoff_max_ms: 2 * 60 * 60_000, quota_cache_ms: 120_000 });
  });

  test("the style block is the design's by default, yours with text or file, and off with terse = false", () => {
    expect(styleBlock(cfg(""))).toBe(STYLE_BLOCK);
    expect(styleBlock(cfg("[style]\nterse = false"))).toBeNull();
    expect(styleBlock(cfg('[style]\ntext = "Answer in one line."'))).toBe("Answer in one line.");
    const dir = mkdtempSync(join(tmpdir(), "fw-style-"));
    dirs.push(dir);
    writeFileSync(join(dir, "style.md"), "Be brief.\n");
    expect(styleBlock(parseConfig(`[style]\nfile = "${join(dir, "style.md")}"`, dir))).toBe("Be brief.");
    expect(workflowConfigProblems(cfg('[style]\ntext = "a"\nfile = "b"')).length).toBe(1);
    expect(workflowConfigProblems(cfg(`[style]\ntext = "${"x".repeat(2_100)}"`)).length).toBe(1);
  });
});

describe("plans", () => {
  test("one ## section per phase, directives first, each phase after the one before unless after says otherwise", () => {
    const plan = parsePlan("# Checkout\n\n## Phase 1: Cart API\nworkflow: fix\nharness: pi\nBuild the cart endpoints.\n\n## Phase 2: Cart page\nThe page.\n\n## Docs\nafter: 1\nWrite docs.\n");
    expect(plan.title).toBe("Checkout");
    expect(plan.phases).toEqual([
      { title: "Cart API", body: "Build the cart endpoints.", workflow: "fix", harness: "pi", account: null, after: null },
      { title: "Cart page", body: "The page.", workflow: null, harness: null, account: null, after: null },
      { title: "Docs", body: "Write docs.", workflow: null, harness: null, account: null, after: [1] },
    ]);
  });

  test("a plan without phases, a phase after a later one, or a bad directive is refused", () => {
    expect(() => parsePlan("just text")).toThrow("no phases");
    expect(() => parsePlan("## A\nafter: 2\nx\n## B\ny")).toThrow("not an earlier phase");
    expect(() => parsePlan("## A\nharness: codex\nx")).toThrow("claude or pi");
    expect(() => parsePlan("## A\nworkflow: Not An Id\nx")).toThrow("not a workflow id");
    expect(() => parsePlan(Array.from({ length: 21 }, (_, i) => `## P${i}\nx`).join("\n"))).toThrow("at most 20");
  });
});

describe("the host check", () => {
  const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               12769.
Pages active:                            618564.
Pages inactive:                          611881.
Pages speculative:                         6430.
Pages wired down:                        179331.
`;

  test("available memory is free + inactive + speculative pages, not os.freemem()", () => {
    expect(parseVmStat(VM_STAT)!).toBeCloseTo(((12769 + 611881 + 6430) * 16384) / 1024 ** 3, 5);
    expect(parseVmStat("garbage")).toBeNull();
  });

  test("it fails on low memory or a high load per core, and says why", () => {
    const host = { min_free_mem_gb: 8, max_load_per_core: 1.5, probe: null };
    expect(judgeHost({ free_mem_gb: 9.6, load_per_core: 0.4, source: "vm_stat" }, host)).toMatchObject({ ok: true, reason: "ok" });
    expect(judgeHost({ free_mem_gb: 2, load_per_core: 0.4, source: "probe" }, host).reason).toBe("2.0 GB available, under 8 GB");
    expect(judgeHost({ free_mem_gb: 20, load_per_core: 2.25, source: "probe" }, host)).toMatchObject({ ok: false, reason: "load 2.25 per core, over 1.5" });
  });
});

describe("Docker label evidence", () => {
  test("docker ps lines become labelled containers; one compose project is one environment", () => {
    const list = parseDockerPs("a1\tweb-1\tr01\tflowryn-r01\nb2\tdb-1\tr01\tflowryn-r01\nc3\tsolo\tr01\t\n\nd4\tnolabel\t\t\n");
    expect(list.map((c) => c.name)).toEqual(["web-1", "db-1", "solo"]);
    expect(environments(list)).toBe(2);
    expect(environments(list.slice(0, 2))).toBe(1);
  });
});

function scratchDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "fw-pools-"));
  dirs.push(dir);
  const db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  tx(db, () => {
    db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', '', '/tmp/web', 'main', 'local-only')").run();
    for (const [task, run] of [["t1", "r1"], ["t2", "r2"], ["t3", "r3"]] as const) {
      db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES (?1, 'web', 'ship', 'local-only', 0, 'feature', 0)").run(task);
      db.query(
        `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
         VALUES (?1, ?2, 'claude', '1', 'running', 'busy', 'feature', 'qa', '/tmp/wt', 'b', 'x', 'h', 0, 0)`,
      ).run(run, task);
    }
  });
  return db;
}

describe("capacity pools (design sections 11 and 14)", () => {
  test("a grant never overfills a pool, and takes nothing when any pool is full", () => {
    const db = scratchDb();
    const caps = { worker: 3, docker_env: 1, browser: 2 };
    tx(db, () => grantLeases(db, "r1", "t1", "qa", ["worker", "docker_env", "browser"], caps, 1));
    expect(liveCounts(db)).toEqual({ worker: 1, docker_env: 1, browser: 1 });
    expect(fullPools(db, caps, ["docker_env", "browser"])).toEqual(["docker_env"]);
    expect(() => tx(db, () => grantLeases(db, "r2", "t2", "qa", ["worker", "docker_env", "browser"], caps, 2))).toThrow(OverCapacity);
    expect(runLeases(db, "r2")).toEqual([]);
    // A second grant of a pool a run already holds takes nothing more.
    tx(db, () => grantLeases(db, "r1", "t1", "qa", ["worker", "docker_env"], caps, 3));
    expect(liveCounts(db).worker).toBe(1);
    expect(tx(db, () => releaseLeases(db, "r1", "t1", { keepWorker: true }, "stage qa done", 4)).toSorted()).toEqual(["browser", "docker_env"]);
    expect(runLeases(db, "r1").map((l) => l.pool)).toEqual(["worker"]);
    tx(db, () => grantLeases(db, "r2", "t2", "qa", ["worker", "docker_env"], caps, 5));
    expect(liveCounts(db)).toEqual({ worker: 2, docker_env: 1 });
    db.close();
  });
});

function events(db: Db, kind: string): Record<string, unknown>[] {
  return (db.query("SELECT payload FROM events WHERE kind = ?1 ORDER BY seq").all(kind) as { payload: string }[]).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
}

describe("job leases: a verify in the validation pool (docs/notes/2026-10-12-next-steps-md-64.md)", () => {
  const v1 = { kind: "verify" as const, id: "v1", taskId: "t9" };
  const v2 = { kind: "verify" as const, id: "v2", taskId: null };

  test("assumption: a job's slot and a run's slot count against the same cap, so neither admission overfills the other", () => {
    const db = scratchDb();
    const caps = { worker: 3, validation: 2 };
    tx(db, () => grantLeases(db, "r1", "t1", "ship", ["validation"], caps, 1));
    tx(db, () => grantJobLease(db, v1, "validation", caps, 2));
    expect(liveCounts(db)).toEqual({ validation: 2 });
    expect(fullPools(db, caps, ["validation"])).toEqual(["validation"]);
    // A run's grant re-counts the job's slot, and a job's grant the run's: both refuse and take nothing.
    expect(() => tx(db, () => grantLeases(db, "r2", "t2", "ship", ["validation"], caps, 3))).toThrow(OverCapacity);
    expect(() => tx(db, () => grantJobLease(db, v2, "validation", caps, 3))).toThrow(OverCapacity);
    expect(runLeases(db, "r2")).toEqual([]);
    expect(liveJobLeases(db).map((l) => l.job_id)).toEqual(["v1"]);
    expect(poolHolders(db, "validation")).toBe("t1 (ship), v1 (verify)");
    // The job ends: its slot goes to the waiting run.
    expect(tx(db, () => releaseJobLeases(db, v1, "verification v1 ended", 4))).toEqual(["validation"]);
    tx(db, () => grantLeases(db, "r2", "t2", "ship", ["validation"], caps, 5));
    expect(liveCounts(db)).toEqual({ validation: 2 });
    expect(events(db, "pool.granted").filter((e) => e.job === "v1")).toEqual([{ job: "v1", kind: "verify", pools: ["validation"] }]);
    db.close();
  });

  test("a job lease is released exactly once: a second release finds nothing and records nothing", () => {
    const db = scratchDb();
    const caps = { validation: 1 };
    tx(db, () => grantJobLease(db, v1, "validation", caps, 1));
    expect(tx(db, () => releaseJobLeases(db, v1, "verification v1 ended", 2))).toEqual(["validation"]);
    expect(tx(db, () => releaseJobLeases(db, v1, "recovered at startup", 3))).toEqual([]);
    expect(events(db, "pool.released")).toEqual([{ job: "v1", kind: "verify", pools: ["validation"], reason: "verification v1 ended" }]);
    expect(db.query("SELECT released_at, released_by FROM job_leases").all()).toEqual([{ released_at: 2, released_by: "verification v1 ended" }]);
    expect(liveCounts(db)).toEqual({});
    db.close();
  });

  test("a step's process is recorded only on a live lease, with its event", () => {
    const db = scratchDb();
    tx(db, () => grantJobLease(db, v1, "validation", { validation: 1 }, 1));
    const proc = { pid: 4242, start: 1_000, exe: "/bin/sh" };
    expect(tx(db, () => recordJobProcess(db, v1, proc, 2))).toBe(true);
    expect(liveJobLeases(db)[0]).toMatchObject({ proc_pid: 4242, proc_start: 1_000, proc_exe: "/bin/sh" });
    tx(db, () => releaseJobLeases(db, v1, "verification v1 ended", 3));
    expect(tx(db, () => recordJobProcess(db, v1, { ...proc, pid: 4343 }, 4))).toBe(false);
    expect(events(db, "pool.job_process")).toEqual([{ job: "v1", kind: "verify", pid: 4242 }]);
    db.close();
  });
});

describe("stage text", () => {
  test("a stage's instructions name its skill file, its pools and what ends it", () => {
    const dir = mkdtempSync(join(tmpdir(), "fw-skills-"));
    dirs.push(dir);
    const files = writeStageSkills(dir);
    for (const skill of STAGE_SKILLS) expect(Bun.file(skillPath(dir, skill.name)!).size).toBeGreaterThan(100);
    expect(Bun.file(join(files.claudePlugin, ".claude-plugin", "plugin.json")).size).toBeGreaterThan(10);
    const feature = DEFAULT_WORKFLOWS["feature-ui"]!;
    const delivery = { kind: "ship" as const, mode: "local-only" as const, defaultBranch: "main" };
    const qa = stageInstructions({ def: feature, index: 2, stage: feature.stages[2]!, last: false }, { stateDir: dir, delivery });
    expect(qa).toContain("Flowryn stage qa (3 of 4; workflow feature-ui");
    expect(qa).toContain(`read ${join(dir, "skills", "flowryn-visual-qa", "SKILL.md")} first`);
    expect(qa).toContain("slot of docker_env and browser");
    expect(qa).toContain("stage done --review <lavish url>");
    const ship = stageInstructions({ def: feature, index: 3, stage: feature.stages[3]!, last: true }, { stateDir: dir, delivery });
    expect(ship).toContain("This is the last stage.");
    expect(ship).toContain("deliver --local");
  });

  test("a no-mistakes ship's emitted text starts its own last stage before the pipeline, and not again inside it", () => {
    const release: WorkflowDef = {
      id: "release",
      stages: [
        { id: "code", skill: null, gate: "none", pools: [], fresh: false },
        { id: "publish", skill: null, gate: "merge", pools: [], fresh: false },
      ],
    };
    const delivery = { kind: "ship" as const, mode: "no-mistakes" as const, defaultBranch: "main", lastStage: { id: "publish", pools: [] } };
    const contract = workerContract("claude", null, delivery);
    expect(contract).toContain("Before the pipeline: $FLOWRYN_BIN stage begin publish.");
    expect(contract).not.toContain("stage_waiting");
    const code = stageInstructions({ def: release, index: 0, stage: release.stages[0]!, last: false }, { stateDir: "/none", delivery });
    expect(code).toContain("it runs in stage publish, once that stage has started");
    const publish = stageInstructions({ def: release, index: 1, stage: release.stages[1]!, last: true }, { stateDir: "/none", delivery });
    expect(publish).toContain("run its pipeline");
    expect(publish).not.toContain("stage begin");

    const pooled = workerContract("pi", null, { ...delivery, lastStage: { id: "ship", pools: ["validation"] } });
    expect(pooled).toContain("stage begin ship; it holds a slot of validation.");
    expect(pooled).toContain("On stage_waiting, end your turn");
  });

  test("a run with no frozen workflow falls back to its workflow's default, and an unknown stage to the first", () => {
    const db = scratchDb();
    const pos = positionOf(db, { id: "r1", workflow: "feature-ui", stage: "qa" }, "ship");
    expect(pos).toMatchObject({ index: 2, last: false });
    expect(positionOf(db, { id: "r1", workflow: "nope", stage: "zzz" }, "scout").stage.id).toBe("investigate");
    db.close();
  });
});

function usageItem(db: Db): { state: string; line: string; resolved_by: string | null } {
  return db.query("SELECT state, line, resolved_by FROM items WHERE kind = 'usage_limit'").get() as { state: string; line: string; resolved_by: string | null };
}

function usageEvents(db: Db): string[] {
  return (db.query("SELECT kind FROM events WHERE kind LIKE 'sched.usage%' ORDER BY seq").all() as { kind: string }[]).map((e) => e.kind);
}

describe("the Claude usage-limit pause (design section 16)", () => {
  const BACKOFF = { usage_backoff_ms: 1_000, usage_backoff_max_ms: 3_000 };

  test("it expires after the backoff and lets exactly one probe through; a rate_limit after expiry re-arms it, doubling to the max", () => {
    const db = scratchDb();
    const M = 60_000;
    const minutes = { usage_backoff_ms: 15 * M, usage_backoff_max_ms: 60 * M };
    const t0 = new Date(2026, 8, 24, 10, 0).getTime();
    expect(usageGate(db, t0, "r1")).toBe("open");
    expect(tx(db, () => noteUsageLimit(db, "r1", "429", t0, minutes))).toBe(true);
    expect(tx(db, () => noteUsageLimit(db, "r2", "429", t0 + M, minutes))).toBe(false);
    expect(usagePause(db)).toMatchObject({ since: t0, until: t0 + 15 * M, backoff_ms: 15 * M, probe: null });
    expect(usageItem(db).line).toContain("until 10:15");
    expect(usageItem(db).line).toContain(RESUME_COMMAND);
    expect(usageGate(db, t0 + 15 * M - 1, "r1")).toBe("paused");
    expect(usageGate(db, t0 + 15 * M, "r1")).toBe("probe");
    tx(db, () => claimProbe(db, "r1", t0 + 15 * M));
    expect(usageGate(db, t0 + 16 * M, "r1")).toBe("open");
    expect(usageGate(db, t0 + 16 * M, "r2")).toBe("paused");
    expect(usageGate(db, t0 + 16 * M, null)).toBe("paused");
    // The probe hits the limit again: the next backoff, the same P1 with the new expiry.
    expect(tx(db, () => noteUsageLimit(db, "r1", "429", t0 + 20 * M, minutes))).toBe(true);
    expect(usagePause(db)).toMatchObject({ since: t0, until: t0 + 50 * M, backoff_ms: 30 * M, probe: null });
    expect(usageItem(db)).toMatchObject({ state: "open" });
    expect(usageItem(db).line).toContain("until 10:50");
    expect(usageGate(db, t0 + 49 * M, "r1")).toBe("paused");
    tx(db, () => noteUsageLimit(db, "r1", "429", t0 + 50 * M, minutes));
    expect(usagePause(db)!.backoff_ms).toBe(60 * M);
    tx(db, () => noteUsageLimit(db, "r1", "429", t0 + 110 * M, minutes));
    expect(usagePause(db)!.backoff_ms).toBe(60 * M);
    expect((db.query("SELECT COUNT(*) AS n FROM items WHERE kind = 'usage_limit'").get() as { n: number }).n).toBe(1);
    db.close();
  });

  test("a probe that died, or outlived the backoff, frees the probe for another run", () => {
    const db = scratchDb();
    tx(db, () => noteUsageLimit(db, "r1", "429", 0, BACKOFF));
    tx(db, () => claimProbe(db, "r1", 1_000));
    expect(usageGate(db, 1_500, "r2")).toBe("paused");
    expect(usageGate(db, 2_000, "r2")).toBe("probe");
    db.query("UPDATE runs SET liveness = 'dead' WHERE id = 'r1'").run();
    expect(usageGate(db, 1_500, "r2")).toBe("probe");
    db.close();
  });

  test("a normal Stop after the probe, or you, lifts it: the P1 resolves and the event says who", () => {
    const db = scratchDb();
    tx(db, () => noteUsageLimit(db, "r1", "429", 0, BACKOFF));
    expect(tx(db, () => clearUsageLimit(db, "a turn of r1 ended normally", 2_000))).toBe(true);
    expect(usagePause(db)).toBeNull();
    expect(usageGate(db, 2_000, "r2")).toBe("open");
    tx(db, () => noteUsageLimit(db, "r2", "429", 3_000, BACKOFF));
    expect(usagePause(db)).toMatchObject({ since: 3_000, backoff_ms: 1_000 });
    expect(tx(db, () => clearUsageLimit(db, "lifted by you", 3_100, "cli"))).toBe(true);
    expect(tx(db, () => clearUsageLimit(db, "again", 3_200, "cli"))).toBe(false);
    expect(usageEvents(db)).toEqual(["sched.usage_limit", "sched.usage_resumed", "sched.usage_limit", "sched.usage_resumed"]);
    expect((db.query("SELECT source FROM events WHERE kind = 'sched.usage_resumed' ORDER BY seq DESC LIMIT 1").get() as { source: string }).source).toBe("cli");
    expect(usageItem(db)).toMatchObject({ state: "resolved" });
    db.close();
  });
});

describe("a fresh stage replaces its worker only on a verified exit (docs/notes/2026-10-12-next-steps-md-we.md)", () => {
  const FRESH_CONFIG = `[tools]\nclaude = "/bin/true"\n[workflows.twopass]\nstages = [ { id = "build" }, { id = "check", fresh = true }, { id = "ship", gate = "merge" } ]`;

  type Exit = { ok: boolean; detail?: string } | Error;

  /**
   * The runs named (r1 and r2 by default) wait for a fresh check stage, each
   * with a live old worker and its worker slot; `wait` puts another there
   * later. `exits` answers each run's exit attempt in turn. The launch stand-in
   * does what the launcher does: the new worker's identity, and pending_launch
   * cleared. The clock ticks once per read; `advance` moves it on.
   */
  function freshStage(exits: Record<string, Exit[]>, runs: string[] = ["r1", "r2"]) {
    const db = scratchDb();
    const config = cfg(FRESH_CONFIG);
    const def = JSON.stringify(workflowFor(config, "twopass", "ship"));
    const caps = capacityConfig(config).pools;
    const wait = (run: string) =>
      tx(db, () => {
        db.query(
          `UPDATE runs SET workflow = 'twopass', workflow_def = ?2, stage = 'check', stage_state = 'waiting', pending_launch = 'stage', waiting_since = 1,
             liveness = 'idle', proc_pid = ?3, proc_start = 1, proc_exe = 'claude', agent_session = ?4 WHERE id = ?1`,
        ).run(run, def, 4100 + Number(run.slice(1)), `old-${run}`);
        grantLeases(db, run, run.replace("r", "t"), "build", ["worker"], caps, 1);
      });
    tx(db, () => db.query("INSERT INTO harness_contracts (harness, version, revision, passed_at) VALUES ('claude', '1', ?1, 0)").run(contractRevision("claude")));
    for (const run of runs) wait(run);
    const launches: string[] = [];
    const launchOps: string[] = [];
    const exitCalls: string[] = [];
    let clock = 10;
    const scheduler = new Scheduler({
      db,
      config: () => config,
      now: () => ++clock,
      log: () => {},
      launch: (runId, mode, operation) => {
        launches.push(`${runId}:${mode}`);
        launchOps.push(operation ?? "-");
        db.query("UPDATE runs SET pending_launch = NULL, proc_pid = 5000, proc_start = 2, proc_exe = 'claude' WHERE id = ?1").run(runId);
      },
      isLaunching: () => false,
      exitWorker: async (runId) => {
        exitCalls.push(runId);
        const next = exits[runId]?.shift() ?? { ok: true };
        if (next instanceof Error) throw next;
        return next;
      },
      notify: () => {},
      startDeps: { db, config: () => config, runtime: () => null, harnessVersion: async () => "1", git: async () => null, now: () => clock },
      kickJournal: () => {},
      host: async () => ({ ok: true, reason: "test" }) as HostVerdict,
    });
    const row = (runId: string) =>
      db.query("SELECT proc_pid, agent_session, stage_state, pending_launch FROM runs WHERE id = ?1").get(runId) as { proc_pid: number | null; agent_session: string; stage_state: string; pending_launch: string | null };
    const kinds = (runId: string) => (db.query("SELECT kind FROM events WHERE run_id = ?1 ORDER BY seq").all(runId) as { kind: string }[]).map((e) => e.kind);
    const workerLeases = (runId: string) => runLeases(db, runId).filter((l) => l.pool === "worker").length;
    const openExitItems = (runId: string) => (db.query("SELECT COUNT(*) AS n FROM items WHERE kind = 'worker_not_exited' AND run_id = ?1 AND state IN ('open','presented')").get(runId) as { n: number }).n;
    const advance = (ms: number) => {
      clock += ms;
    };
    const attempts = (runId: string) => exitCalls.filter((r) => r === runId).length;
    return { db, scheduler, launches, launchOps, exitCalls, attempts, wait, advance, row, kinds, workerLeases, openExitItems };
  }

  test("a false exit result resets no identity and launches nothing; the run keeps its slot and its pending replacement, and other work still goes", async () => {
    const f = freshStage({ r1: [{ ok: false, detail: "timeout" }] });
    await f.scheduler.passNow();
    expect(f.row("r1")).toEqual({ proc_pid: 4101, agent_session: "old-r1", stage_state: "active", pending_launch: "stage" });
    expect(f.kinds("r1")).not.toContain("run.fresh_worker");
    expect(f.kinds("r1")).toContain("run.fresh_worker_refused");
    expect(f.workerLeases("r1")).toBe(1);
    // The refused candidate did not hold up r2, granted in the same pass.
    expect(f.launches).toEqual(["r2:stage"]);
    expect(f.row("r2")).toMatchObject({ proc_pid: 5000, pending_launch: null });
    expect(f.row("r2").agent_session).not.toBe("old-r2");
    f.db.close();
  });

  test("an exit attempt that throws counts as unverified, and does not stop the pass", async () => {
    const f = freshStage({ r1: [new Error("ps failed")] });
    await f.scheduler.passNow();
    expect(f.row("r1")).toEqual({ proc_pid: 4101, agent_session: "old-r1", stage_state: "active", pending_launch: "stage" });
    const refused = f.db.query("SELECT payload FROM events WHERE run_id = 'r1' AND kind = 'run.fresh_worker_refused'").get() as { payload: string };
    expect(JSON.parse(refused.payload)).toMatchObject({ stage: "check", detail: "ps failed", attempts: 1 });
    expect(f.launches).toEqual(["r2:stage"]);
    f.db.close();
  });

  test("a later verified exit, on a scheduler pass, replaces the worker exactly once and keeps one worker slot", async () => {
    const f = freshStage({ r1: [{ ok: false }] });
    await f.scheduler.passNow();
    expect(f.launches).toEqual(["r2:stage"]);
    f.advance(schedTiming(cfg(FRESH_CONFIG)).pass_ms);
    await f.scheduler.passNow();
    expect(f.launches).toEqual(["r2:stage", "r1:stage"]);
    expect(f.row("r1")).toMatchObject({ proc_pid: 5000, pending_launch: null, stage_state: "active" });
    expect(f.row("r1").agent_session).not.toBe("old-r1");
    await f.scheduler.passNow();
    expect(f.launches).toEqual(["r2:stage", "r1:stage"]);
    expect(f.kinds("r1").filter((k) => k === "run.fresh_worker")).toHaveLength(1);
    expect(f.workerLeases("r1")).toBe(1);
    expect(f.exitCalls.filter((r) => r === "r1")).toHaveLength(2);
    f.db.close();
  });

  test("a refusal that persists opens one P1 for the run; the verified exit resolves it", async () => {
    const f = freshStage({ r1: [{ ok: false }, { ok: false }, { ok: false }, { ok: false }] });
    const retry = async () => {
      f.advance(EXIT_BACKOFF_MAX_MS);
      await f.scheduler.passNow();
    };
    await f.scheduler.passNow();
    await retry();
    expect(f.openExitItems("r1")).toBe(0);
    await retry();
    expect(f.openExitItems("r1")).toBe(1);
    await retry();
    expect(f.openExitItems("r1")).toBe(1);
    expect(f.attempts("r1")).toBe(4);
    // One refusal event per episode; each attempt is still an exit attempt.
    expect(f.kinds("r1").filter((k) => k === "run.fresh_worker_refused")).toHaveLength(1);
    expect(f.launches).toEqual(["r2:stage"]);
    await retry();
    expect(f.launches).toEqual(["r2:stage", "r1:stage"]);
    expect(f.openExitItems("r1")).toBe(0);
    f.db.close();
  });
  test("a refused replacement backs off: its run is skipped until its next attempt, one pass doubling to the cap, while other work is granted at once", async () => {
    const pass = schedTiming(cfg(FRESH_CONFIG)).pass_ms;
    const f = freshStage({ r1: [{ ok: false }, { ok: false }, { ok: false }, { ok: false }, { ok: false }] }, ["r1"]);
    await f.scheduler.passNow();
    expect(f.attempts("r1")).toBe(1);
    // Another run becomes eligible: the next pass grants it and makes no exit attempt for r1 inside its backoff.
    f.wait("r3");
    await f.scheduler.passNow();
    expect(f.launches).toEqual(["r3:stage"]);
    expect(f.exitCalls).toEqual(["r1", "r3"]);
    // Each wait is a pass doubled per refusal, up to EXIT_BACKOFF_MAX_MS; the attempt runs only once it is over.
    for (const [attempt, backoff] of [[2, pass], [3, 2 * pass], [4, 4 * pass], [5, 8 * pass], [6, EXIT_BACKOFF_MAX_MS]] as const) {
      expect(backoff).toBeLessThanOrEqual(EXIT_BACKOFF_MAX_MS);
      f.advance(backoff - 100);
      await f.scheduler.passNow();
      expect(f.attempts("r1")).toBe(attempt - 1);
      f.advance(100);
      await f.scheduler.passNow();
      expect(f.attempts("r1")).toBe(attempt);
    }
    // The sixth attempt was verified: one replacement, the P1 opened at the third refusal resolved.
    expect(f.launches).toEqual(["r3:stage", "r1:stage"]);
    expect(f.openExitItems("r1")).toBe(0);
    expect(f.kinds("r1")).toContain("run.worker_not_exited");
    f.db.close();
  });

  test("the grant's replacement is one launch operation, named to the launcher; a refused exit keeps the same one for the retry", async () => {
    const f = freshStage({ r1: [{ ok: false }] });
    const operationsOf = (runId: string) => f.db.query("SELECT id, kind, mode, phase FROM operations WHERE run_id = ?1").all(runId) as { id: string; kind: string; mode: string; phase: string }[];
    await f.scheduler.passNow();
    const [r2] = operationsOf("r2");
    expect(r2).toMatchObject({ kind: "launch", mode: "stage", phase: "requested" });
    expect(f.launchOps).toEqual([r2!.id]);
    const [r1] = operationsOf("r1");
    expect(r1).toMatchObject({ kind: "launch", mode: "stage", phase: "requested" });
    f.advance(schedTiming(cfg(FRESH_CONFIG)).pass_ms);
    await f.scheduler.passNow();
    expect(f.launches).toEqual(["r2:stage", "r1:stage"]);
    expect(f.launchOps).toEqual([r2!.id, r1!.id]);
    expect(operationsOf("r1")).toHaveLength(1);
    f.db.close();
  });

  test("a run whose cancel is open, or whose launch was issued, is never granted: no exit attempt, no launch", async () => {
    const f = freshStage({});
    tx(f.db, () => {
      const at = Date.now();
      f.db.query("INSERT INTO operations (id, run_id, task_id, kind, generation, desired, phase, requested_by, created_at, updated_at) VALUES ('oc', 'r1', 't1', 'cancel', 1, 'run_cancelled', 'requested', 'leader', ?1, ?1)").run(at);
      f.db.query("INSERT INTO operations (id, run_id, task_id, kind, mode, generation, desired, phase, requested_by, pane_id, issued_at, attempts, created_at, updated_at) VALUES ('ol', 'r2', 't2', 'launch', 'stage', 2, 'worker_running', 'effect_issued', 'scheduler', 'w:2', ?1, 1, ?1, ?1)").run(at);
    });
    await f.scheduler.passNow();
    expect(f.exitCalls).toEqual([]);
    expect(f.launches).toEqual([]);
    expect(f.row("r1")).toMatchObject({ proc_pid: 4101, pending_launch: "stage" });
    f.db.close();
  });

  test("an escalated stage replacement is held, even once its P1 is resolved or dismissed: no exit attempt, no launch; a newer operation you open releases it", async () => {
    const f = freshStage({}, ["r1"]);
    tx(f.db, () => {
      const at = Date.now();
      f.db.query("INSERT INTO operations (id, run_id, task_id, kind, mode, generation, desired, phase, requested_by, pane_id, issued_at, attempts, created_at, updated_at) VALUES ('oe', 'r1', 't1', 'launch', 'stage', 1, 'worker_running', 'effect_issued', 'scheduler', 'w:1', ?1, 3, ?1, ?1)").run(at);
      expect(escalateOperation(f.db, { id: "oe", attempts: 3 }, "the agent never appeared after 3 issues", "daemon", at)).not.toBeNull();
    });
    await f.scheduler.passNow();
    await f.scheduler.passNow();
    expect(f.exitCalls).toEqual([]);
    expect(f.launches).toEqual([]);
    expect(f.row("r1")).toMatchObject({ proc_pid: 4101, pending_launch: "stage" });
    tx(f.db, () => resolveRunItems(f.db, "r1", ["operation_escalated"], "human", Date.now()));
    await f.scheduler.passNow();
    expect(f.exitCalls).toEqual([]);
    expect(f.launches).toEqual([]);
    // What `flowryn resume` opens on it: a newer operation in the replacement's own mode, which the grant launches once.
    const again = tx(f.db, () => requestOperation(f.db, { run: { id: "r1", task_id: "t1" }, kind: "launch", mode: "stage", requestedBy: "human", source: "cli", now: Date.now() }));
    await f.scheduler.passNow();
    await f.scheduler.passNow();
    expect(f.exitCalls).toEqual(["r1"]);
    expect(f.launches).toEqual(["r1:stage"]);
    expect(f.launchOps).toEqual([again.id]);
    f.db.close();
  });

  test("an open requested operation of another mode is never launched under: the grant is refused with why, no exit, no launch", async () => {
    const f = freshStage({}, ["r1"]);
    const op = tx(f.db, () => requestOperation(f.db, { run: { id: "r1", task_id: "t1" }, kind: "resume", mode: "resume", requestedBy: "human", source: "cli", now: Date.now() }));
    await f.scheduler.passNow();
    await f.scheduler.passNow();
    expect(f.exitCalls).toEqual([]);
    expect(f.launches).toEqual([]);
    expect(f.row("r1")).toMatchObject({ proc_pid: 4101, pending_launch: "stage" });
    expect(f.db.query("SELECT rule, operation FROM explanations WHERE run_id = 'r1' AND closed_at IS NULL").all()).toEqual([{ rule: "capacity.operation_mode", operation: op.id }]);
    f.db.close();
  });
});
