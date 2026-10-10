import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_UPKEEP, type UpkeepConfig } from "../../src/config/upkeep.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { MAX_CONFLICT_NUDGES, conflictAction } from "../../src/reconcile/delivery.ts";
import type { BuildPass } from "../../src/upkeep/build.ts";
import { sweepCandidates } from "../../src/upkeep/sweep.ts";
import { Upkeep } from "../../src/upkeep/upkeep.ts";
import { insertProject } from "../../src/lifecycle/projects.ts";
import { projectAt } from "../helpers/scratch-git.ts";

/**
 * The upkeep loop's own rules (spec 3, phase 3): which ended runs the sweep
 * asks to clean, the order and the waits of a pass, and when a conflicting PR
 * is nudged again or left to you. The hooks themselves have their own tests
 * (upkeep-sync, upkeep-build) and integration tests through the real daemon
 * (test/integration/upkeep.test.ts).
 */

const HOUR = 3_600_000;
let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-upkeep-"));
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  tx(db, () => insertProject(db, projectAt(join(dir, "p"), "p")));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedRun(id: string, state: string, updatedAt: number, opts: { cleanup?: string | null; worktree?: string; exists?: boolean } = {}): string {
  const worktree = opts.worktree ?? join(dir, "wt", id);
  if (opts.exists !== false) mkdirSync(worktree, { recursive: true });
  tx(db, () => {
    db.query("INSERT OR IGNORE INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES (?1, 'p', 'ship', 'direct-PR', 0, 'ship', 0)").run(`t-${id}`);
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at, cleanup)
       VALUES (?1, ?2, 'claude', 'v', ?3, 'dead', 'ship', 'ship', ?4, 'b', 's', ?1, 0, ?5, ?6)`,
    ).run(id, `t-${id}`, state, worktree, updatedAt, opts.cleanup ?? null);
  });
  return worktree;
}

describe("sweepCandidates", () => {
  test("failed and cancelled runs idle past the wait, with a worktree and no finished cleanup, oldest first", () => {
    const now = 100 * HOUR;
    seedRun("cancelled-old", "cancelled", now - 30 * HOUR);
    seedRun("failed-old", "failed", now - 25 * HOUR);
    seedRun("cancelled-young", "cancelled", now - 23 * HOUR);
    seedRun("landed-old", "landed", now - 30 * HOUR);
    seedRun("running-old", "running", now - 30 * HOUR);
    seedRun("cleaned-old", "cancelled", now - 30 * HOUR, { cleanup: "done" });
    seedRun("refused-old", "failed", now - 26 * HOUR, { cleanup: "refused" });
    seedRun("gone", "failed", now - 30 * HOUR, { exists: false });
    expect(sweepCandidates(db, now, 24)).toEqual(["cancelled-old", "refused-old", "failed-old"]);
  });

  test("0 hours turns the sweep off", () => {
    seedRun("cancelled-old", "cancelled", 0);
    expect(sweepCandidates(db, 100 * HOUR, 0)).toEqual([]);
  });

  test("a worktree an open run of the same path uses is never a candidate", () => {
    const shared = seedRun("old", "cancelled", 0);
    seedRun("live", "running", 0, { worktree: shared });
    expect(sweepCandidates(db, 100 * HOUR, 24)).toEqual([]);
  });
});

describe("conflictAction", () => {
  test("a new head is nudged; a head nudged before, or a run past the limit, is left to you", () => {
    expect(conflictAction([], "h1")).toBe("nudge");
    expect(conflictAction(["h1"], "h2")).toBe("nudge");
    expect(conflictAction(["h1"], "h1")).toBe("ask");
    expect(MAX_CONFLICT_NUDGES).toBe(3);
    expect(conflictAction(["h1", "h2"], "h3")).toBe("nudge");
    expect(conflictAction(["h1", "h2", "h3"], "h4")).toBe("ask");
  });
});

interface Loop {
  upkeep: Upkeep;
  calls: string[];
  busy: string | null;
  config: UpkeepConfig;
}

function loop(over: Partial<UpkeepConfig> = {}, build: BuildPass = { outcome: "skipped", reason: "the daemon runs this commit" }): Loop {
  const l: Loop = { upkeep: null as unknown as Upkeep, calls: [], busy: null, config: { ...DEFAULT_UPKEEP, ...over } };
  l.upkeep = new Upkeep({
    db,
    config: () => l.config,
    now: () => 100 * HOUR,
    log: () => {},
    // No project has a checkout here, so a sync is a quiet skip.
    git: async (args) => {
      l.calls.push(`git ${args[0]}`);
      return { code: 1, stdout: "", stderr: "" };
    },
    projects: () => [{ id: "web", path: join(dir, "missing"), default_branch: "main" } as never],
    builder: {
      pass: async () => {
        l.calls.push("build");
        return build;
      },
    },
    busy: () => l.busy,
    sweep: async (runId) => {
      l.calls.push(`sweep ${runId}`);
      return { outcome: "removed", reason: "landed", task: `t-${runId}` };
    },
  });
  return l;
}

describe("the upkeep pass", () => {
  test("in order: build after the syncs, then the sweep of each candidate", async () => {
    seedRun("a", "cancelled", 0);
    seedRun("b", "failed", HOUR);
    const l = loop();
    const report = await l.upkeep.pass();
    expect(l.calls).toEqual(["build", "sweep a", "sweep b"]);
    expect(report.swept).toEqual([
      { run: "a", outcome: "removed", reason: "landed" },
      { run: "b", outcome: "removed", reason: "landed" },
    ]);
  });

  test("each hook's switch: off means not asked", async () => {
    seedRun("a", "cancelled", 0);
    const l = loop({ build_after_merge: false, clean_ended_hours: 0, sync_primary: false });
    await l.upkeep.pass();
    expect(l.calls).toEqual([]);
  });

  test("a restart asked for, or a cleanup running, makes the pass wait", async () => {
    seedRun("a", "cancelled", 0);
    const l = loop();
    l.busy = "a restart is asked for or under way";
    const report = await l.upkeep.pass();
    expect(report.waited).toBe("a restart is asked for or under way");
    expect(l.calls).toEqual([]);
  });

  test("two asks at once run one pass", async () => {
    const l = loop();
    const [one, two] = [l.upkeep.pass(), l.upkeep.pass()];
    expect(one).toBe(two);
    await one;
    expect(l.calls).toEqual(["build"]);
  });

  test("a kick runs a pass soon; the timer runs one every interval", async () => {
    const l = loop({ interval_ms: 150 });
    l.upkeep.kick();
    await Bun.sleep(1_300);
    expect(l.calls).toEqual(["build"]);
    l.upkeep.start();
    await Bun.sleep(400);
    l.upkeep.stop();
    expect(l.calls.length).toBeGreaterThanOrEqual(3);
  });
});
