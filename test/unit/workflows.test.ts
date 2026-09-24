import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlowrynError } from "../../src/api/errors.ts";
import { parseConfig } from "../../src/config/config.ts";
import { capacityConfig, DEFAULT_WORKFLOWS, defaultAutonomy, schedTiming, styleBlock, workflowConfigProblems, workflowFor, workflowsConfig, type WorkflowDef } from "../../src/config/workflows.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { STYLE_BLOCK, workerContract } from "../../src/harness/contract-text.ts";
import { parsePlan } from "../../src/lifecycle/plans.ts";
import { changesTarget, flowLine, positionOf, stageInstructions } from "../../src/lifecycle/stages.ts";
import { environments, parseDockerPs } from "../../src/reconcile/docker.ts";
import { judgeHost, parseVmStat } from "../../src/sched/host.ts";
import { fullPools, grantLeases, liveCounts, OverCapacity, releaseLeases, runLeases } from "../../src/sched/pools.ts";
import { skillPath, STAGE_SKILLS, writeStageSkills } from "../../src/skills/stages.ts";

const HOME = "/tmp/fw-m5";
const cfg = (text: string) => parseConfig(text, HOME);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("workflows (design section 11)", () => {
  test("the design's three workflows are the defaults; a ship's ends in the merge gate", () => {
    const wf = workflowsConfig(cfg(""));
    expect(flowLine(wf.feature!)).toBe("design (review) → build → qa (review) → ship (merge)");
    expect(flowLine(wf.fix!)).toBe("build → ship (merge)");
    expect(flowLine(wf.scout!)).toBe("investigate");
    expect(wf.feature!.stages[2]).toMatchObject({ id: "qa", skill: "flowryn-visual-qa", pools: ["docker_env", "browser"] });
    expect(workflowFor(cfg(""), "feature", "ship").id).toBe("feature");
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
    expect(capacityConfig(cfg(""))).toEqual({ pools: { worker: 20, validation: 5, docker_env: 5, browser: 5 }, host: { min_free_mem_gb: 8, max_load_per_core: 1.5, probe: null } });
    const c = capacityConfig(cfg('[capacity]\nworker = 3\ngpu = 1\n[capacity.host]\nmin_free_mem_gb = 0\nprobe = "bin/probe"\n'));
    expect(c.pools).toMatchObject({ worker: 3, gpu: 1, validation: 5 });
    expect(c.host).toEqual({ min_free_mem_gb: 0, max_load_per_core: 1.5, probe: `${HOME}/bin/probe` });
    for (const text of ["[capacity]\nworker = 0", "[capacity]\nworker = 1.5", "[capacity]\nBad = 1", "[capacity.host]\nmax_load_per_core = 0", "[capacity.host]\nspeed = 1"]) {
      expect(workflowConfigProblems(cfg(text)).length).toBeGreaterThan(0);
    }
  });

  test("autonomy defaults to plan; [sched] clocks default to the design's 30 minutes", () => {
    expect(defaultAutonomy(cfg(""))).toBe("plan");
    expect(defaultAutonomy(cfg('[autonomy]\ndefault = "manual"'))).toBe("manual");
    expect(() => defaultAutonomy(cfg('[autonomy]\ndefault = "yolo"'))).toThrow(FlowrynError);
    expect(schedTiming(cfg("")).wait_alert_ms).toBe(30 * 60_000);
    expect(schedTiming(cfg("[sched]\nwait_alert_ms = 500")).wait_alert_ms).toBe(500);
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
      { title: "Cart API", body: "Build the cart endpoints.", workflow: "fix", harness: "pi", after: null },
      { title: "Cart page", body: "The page.", workflow: null, harness: null, after: null },
      { title: "Docs", body: "Write docs.", workflow: null, harness: null, after: [1] },
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

describe("stage text", () => {
  test("a stage's instructions name its skill file, its pools and what ends it", () => {
    const dir = mkdtempSync(join(tmpdir(), "fw-skills-"));
    dirs.push(dir);
    const files = writeStageSkills(dir);
    for (const skill of STAGE_SKILLS) expect(Bun.file(skillPath(dir, skill.name)!).size).toBeGreaterThan(100);
    expect(Bun.file(join(files.claudePlugin, ".claude-plugin", "plugin.json")).size).toBeGreaterThan(10);
    const feature = DEFAULT_WORKFLOWS.feature!;
    const delivery = { kind: "ship" as const, mode: "local-only" as const, defaultBranch: "main" };
    const qa = stageInstructions({ def: feature, index: 2, stage: feature.stages[2]!, last: false }, { stateDir: dir, delivery });
    expect(qa).toContain("Flowryn stage qa (3 of 4; workflow feature");
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
    const pos = positionOf(db, { id: "r1", workflow: "feature", stage: "qa" }, "ship");
    expect(pos).toMatchObject({ index: 2, last: false });
    expect(positionOf(db, { id: "r1", workflow: "nope", stage: "zzz" }, "scout").stage.id).toBe("investigate");
    db.close();
  });
});
