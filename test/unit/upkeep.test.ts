import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_UPKEEP, type UpkeepConfig } from "../../src/config/upkeep.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { MAX_CONFLICT_NUDGES, conflictAction } from "../../src/reconcile/delivery.ts";
import type { BuildPass } from "../../src/upkeep/build.ts";
import { sweepCandidates } from "../../src/upkeep/sweep.ts";
import { Upkeep, type UpkeepDeps } from "../../src/upkeep/upkeep.ts";
import { lastReproved, recordReproof, reproveDue, reproveDueAt, REPROVE_WINDOW_MS } from "../../src/verify/reprove.ts";
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
  /** Projects re-proved, in order. */
  reproved: string[];
  busy: string | null;
  config: UpkeepConfig;
  /** The projects' ids. */
  projects: string[];
}

function loop(over: Partial<UpkeepConfig> = {}, build: BuildPass = { outcome: "skipped", reason: "the daemon runs this commit" }, reprove?: UpkeepDeps["reprove"]): Loop {
  const l: Loop = { upkeep: null as unknown as Upkeep, calls: [], reproved: [], busy: null, config: { ...DEFAULT_UPKEEP, ...over }, projects: ["web"] };
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
    projects: () => l.projects.map((id) => ({ id, path: join(dir, "missing"), default_branch: "main" }) as never),
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
    reprove: async (project, signal) => {
      if (reprove) return reprove(project, signal);
      l.reproved.push(project.id);
      return { project: project.id, head: "abc123", skipped: null, laws: [{ rule: "Tests stay", state: "unproven", detail: "bun test ./a.test.ts passes at 1a2b3c4: it no longer fails where the mistake was" }] };
    },
  });
  return l;
}

describe("the upkeep pass", () => {
  test("the weekly corrections pass runs on the first pass, then waits a week without reading events again (src/leader/corrections.ts)", async () => {
    const l = loop();
    const first = await l.upkeep.pass();
    expect(first.corrections).toEqual({ since: 100 * HOUR - 7 * 24 * HOUR, until: 100 * HOUR, filed: [], skipped: [], swept: [] });
    expect((await l.upkeep.pass()).corrections).toBeNull();
    expect(db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'corrections.pass'").get()).toEqual({ n: 1 });
  });

  test("the weekly pass and the class check never run in one pass; the class check then runs at most hourly", async () => {
    const l = loop();
    const first = await l.upkeep.pass();
    expect(first.repeats).toBeNull();
    expect((await l.upkeep.pass()).repeats).toEqual({ filed: [] });
    expect((await l.upkeep.pass()).repeats).toBeNull();
  });

  test("laws are re-proved after the sweep, once a week: one event per project, an item for a law no longer proven; not while busy (src/verify/reprove.ts)", async () => {
    const l = loop();
    l.busy = "a cleanup is running";
    expect((await l.upkeep.pass()).reproving).toBeUndefined();
    expect(l.reproved).toEqual([]);
    l.busy = null;
    const report = await l.upkeep.pass();
    expect(l.reproved).toEqual(["web"]);
    expect((await report.reproving)!.map((r) => r.project)).toEqual(["web"]);
    expect(db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'laws.reproved'").get()).toEqual({ n: 1 });
    const item = db.query("SELECT kind, line FROM items WHERE kind = 'laws_unproven'").get() as { kind: string; line: string };
    expect(item.line).toStartWith("Laws no longer proven in web (1 of 1, re-proved at abc123): Tests stay: bun test ./a.test.ts passes at 1a2b3c4");
    expect((await l.upkeep.pass()).reproving).toBeUndefined();
    expect(l.reproved).toEqual(["web"]);
  });

  test("a re-prove runs on past its pass: later passes sweep and build meanwhile (a restart keeps the projects done), and start no second re-prove", async () => {
    let finish!: () => void;
    const held = new Promise<void>((resolve) => (finish = resolve));
    let starts = 0;
    const l = loop({}, undefined, async (project) => {
      starts++;
      await held;
      return { project: project.id, head: "abc123", skipped: null, laws: [] };
    });
    const first = await l.upkeep.pass();
    expect(first.reproving).toBeDefined();
    expect(l.calls.filter((c) => c === "build")).toHaveLength(1);
    seedRun("a", "cancelled", 0);
    const second = await l.upkeep.pass();
    expect(second.swept.map((s) => s.run)).toEqual(["a"]);
    expect(second.build).toEqual({ outcome: "skipped", reason: "the daemon runs this commit" });
    expect(l.calls.filter((c) => c === "build")).toHaveLength(2);
    expect(second.reproving).toBeUndefined();
    finish();
    expect(await first.reproving).toEqual([{ project: "web", head: "abc123", skipped: null, laws: [] }]);
    expect(starts).toBe(1);
  });

  test("each project's result is recorded as it finishes: a restart after web finished re-proves only api, and nothing more this week", async () => {
    let started!: () => void;
    const apiStarted = new Promise<void>((resolve) => (started = resolve));
    const before = loop({}, undefined, async (project, signal) => {
      before.reproved.push(project.id);
      if (project.id === "api") {
        started();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      }
      return { project: project.id, head: "abc123", skipped: null, laws: [] };
    });
    before.projects = ["web", "api"];
    const report = await before.upkeep.pass();
    await apiStarted;
    await before.upkeep.stop();
    expect(await report.reproving).toBeUndefined();
    expect(before.reproved).toEqual(["web", "api"]);
    const recorded = db.query("SELECT json_extract(payload, '$.project') AS project FROM events WHERE kind = 'laws.reproved'").all();
    expect(recorded).toEqual([{ project: "web" }]);

    const after = loop();
    after.projects = ["web", "api"];
    const restarted = await after.upkeep.pass();
    expect((await restarted.reproving)!.map((r) => r.project)).toEqual(["api"]);
    expect(after.reproved).toEqual(["api"]);
    expect((await after.upkeep.pass()).reproving).toBeUndefined();
    expect(after.reproved).toEqual(["api"]);
  });

  test("a project is due a week after its own last result; a whole-run event from before per-project results counts for each project it lists", () => {
    appendEvent(db, { source: "daemon", kind: "laws.reproved", payload: { projects: [{ project: "web", head: null, skipped: "no AGENTS.md", laws: [] }] }, ts: HOUR });
    recordReproof(db, { project: "api", head: "abc123", skipped: null, laws: [] }, 2 * HOUR);
    const last = lastReproved(db);
    expect([...last]).toEqual([["web", HOUR], ["api", 2 * HOUR]]);
    expect(reproveDue(last, "web", HOUR + REPROVE_WINDOW_MS - 1)).toBe(false);
    expect(reproveDue(last, "web", HOUR + REPROVE_WINDOW_MS)).toBe(true);
    expect(reproveDue(last, "new", 3 * HOUR)).toBe(true);
    expect(reproveDueAt(db, ["web", "api"], 3 * HOUR)).toBe(HOUR + REPROVE_WINDOW_MS);
    expect(reproveDueAt(db, ["web", "api", "new"], 3 * HOUR)).toBe(3 * HOUR);
    expect(reproveDueAt(db, [], 3 * HOUR)).toBe(3 * HOUR + REPROVE_WINDOW_MS);
  });

  test("a project's next re-prove replaces its unproven-laws item instead of adding one, and resolves it once its laws are proven", () => {
    const unproven = { project: "web", head: "abc123", skipped: null, laws: [{ rule: "Tests stay", state: "unproven" as const, detail: "it no longer fails" }] };
    const first = recordReproof(db, unproven, HOUR);
    const second = recordReproof(db, unproven, 2 * HOUR);
    expect(db.query("SELECT id FROM items WHERE kind = 'laws_unproven' AND state IN ('open','presented')").all()).toEqual([{ id: second! }]);
    expect(first).not.toEqual(second);
    recordReproof(db, { ...unproven, laws: [{ rule: "Tests stay", state: "proven", detail: "fails at 1a2b3c4, passes at HEAD" }] }, 3 * HOUR);
    expect(db.query("SELECT COUNT(*) AS n FROM items WHERE kind = 'laws_unproven' AND state IN ('open','presented')").get()).toEqual({ n: 0 });
  });

  test("a re-prove whose setup failed keeps the unproven-laws item open and opens a could-not-run item; the next clean re-prove resolves both", () => {
    const openLaws = () => db.query("SELECT id, line FROM items WHERE kind = 'laws_unproven' AND state IN ('open','presented') ORDER BY id").all() as { id: string; line: string }[];
    const unproven = recordReproof(db, { project: "web", head: "abc12345ff", skipped: null, laws: [{ rule: "Tests stay", state: "unproven", detail: "it no longer fails" }] }, HOUR);
    const unrunLaws = [
      { rule: "Tests stay", state: "unrun" as const, detail: "could not run: verify step make pg-test-up failed (exit 2): postgres unreachable" },
      { rule: "Docs stay", state: "holds" as const, detail: "README.md holds at HEAD" },
    ];
    const first = recordReproof(db, { project: "web", head: "def67890aa", skipped: null, laws: unrunLaws }, 2 * HOUR);
    const second = recordReproof(db, { project: "web", head: "def67890aa", skipped: null, laws: unrunLaws }, 3 * HOUR);
    expect(first).not.toEqual(second);
    expect(openLaws().map((i) => i.id).toSorted()).toEqual([unproven!, second!].toSorted());
    expect(openLaws().find((i) => i.id === second)!.line).toBe("Laws could not be re-proved in web (1 of 2, at def67890): verify step make pg-test-up failed (exit 2): postgres unreachable; flowryn laws web");
    recordReproof(db, { project: "web", head: "0123456789", skipped: null, laws: [{ rule: "Tests stay", state: "proven", detail: "fails at 1a2b3c4, passes at HEAD" }] }, 4 * HOUR);
    expect(openLaws()).toEqual([]);
  });

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
