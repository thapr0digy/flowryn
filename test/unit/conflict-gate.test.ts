import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import type { Forge } from "../../src/forge/types.ts";
import { isConflictGate, parseFindings, parseNmStatus } from "../../src/policy/nomistakes.ts";
import { DeliveryWatcher } from "../../src/watch/delivery.ts";

/**
 * A no-mistakes run parked at its `ci` gate on a merge conflict alone (with
 * `auto_fix.ci: 0` the CI monitor reports a conflicting PR this way instead of
 * rebasing it) is the conflict nudge's: once the nudge acted on that head, the
 * run is not validating, and no item opens for it. Read through the delivery
 * watcher and a stand-in no-mistakes that prints a status file.
 */

const HEAD = "4f3c2b1a0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b";
const CONFLICT_ROW = 'ci-1,error,"",,auto-fix,PR has merge conflicts with the base branch';

/**
 * `axi status` of a run parked at a gate, by default in the v1.84.0 shape
 * (the gate nested as an object, no category column, a free-text help list);
 * `flat` puts `gate: <step>` and the findings table at the top level.
 */
function parked(gate: string, rows: string[], header = "{id,severity,file,line,action,description}", branch = "b", shape: "nested" | "flat" = "nested"): string {
  const gateBlock =
    shape === "flat"
      ? [`gate: ${gate}`, `findings[${rows.length}]${header}:`, ...rows.map((r) => `  ${r}`)]
      : ["gate:", `  step: ${gate}`, "  status: awaiting_approval", '  note: "the step found issues"', `  findings[${rows.length}]${header}:`, ...rows.map((r) => `    ${r}`)];
  return [
    "run:",
    '  id: "01NMCONFLICT"',
    `  branch: ${branch}`,
    "  status: awaiting_approval",
    "  awaiting_agent: parked 4m",
    `  head: ${HEAD.slice(0, 8)}`,
    `  head_sha: ${HEAD}`,
    '  pr: "https://github.com/acme/web/pull/7"',
    ...gateBlock,
    "help[2]:",
    "  Run `no-mistakes axi respond --action approve` to accept this step and continue",
    "  Run `no-mistakes axi logs --step ci --full` to read the full step log",
    "",
  ].join("\n");
}

describe("a parked conflict gate", () => {
  test("the findings table reads by column name, around a help list that is not strict TOON", () => {
    expect(parseFindings(parked("ci", [CONFLICT_ROW, 'ci-2,error,"",,auto-fix,"Check test failed, see log"']))).toEqual([
      { id: "ci-1", action: "auto-fix", description: "PR has merge conflicts with the base branch", category: "", severity: "error", file: "", line: "" },
      { id: "ci-2", action: "auto-fix", description: "Check test failed, see log", category: "", severity: "error", file: "", line: "" },
    ]);
    const nm = parseNmStatus(parked("ci", [CONFLICT_ROW]))!;
    expect(nm).toMatchObject({ gateStep: "ci", headSha: HEAD, head: HEAD.slice(0, 8), gate: true });
    expect(parseFindings('run:\n  id: "x"\n')).toBeNull();
  });

  test("the flat shape (a top-level `gate: <step>` and findings table) still reads", () => {
    const flat = parked("ci", [CONFLICT_ROW], undefined, undefined, "flat");
    expect(parseFindings(flat)).toEqual([{ id: "ci-1", action: "auto-fix", description: "PR has merge conflicts with the base branch", category: "", severity: "error", file: "", line: "" }]);
    expect(parseNmStatus(flat)).toMatchObject({ gateStep: "ci", gate: true });
    expect(isConflictGate(parseNmStatus(flat)!)).toBe(true);
    expect(isConflictGate(parseNmStatus(parked("review", [CONFLICT_ROW], undefined, undefined, "flat"))!)).toBe(false);
  });

  test("is a ci gate whose every finding is a merge conflict", () => {
    expect(isConflictGate(parseNmStatus(parked("ci", [CONFLICT_ROW]))!)).toBe(true);
    // A later version's category column decides on its own.
    const withCategory = "{id,severity,file,line,action,category,description}";
    expect(isConflictGate(parseNmStatus(parked("ci", ['ci-1,error,"",,auto-fix,ci-merge-conflict,"Conflicts, rebase needed"'], withCategory))!)).toBe(true);
    expect(isConflictGate(parseNmStatus(parked("ci", ['ci-1,error,"",,auto-fix,ci-failure,PR has merge conflicts with the base branch'], withCategory))!)).toBe(false);
  });

  test("is not one beside another finding, at another gate, with no findings, or once ended", () => {
    expect(isConflictGate(parseNmStatus(parked("ci", [CONFLICT_ROW, 'ci-2,error,"",,auto-fix,Check test failed']))!)).toBe(false);
    expect(isConflictGate(parseNmStatus(parked("review", [CONFLICT_ROW]))!)).toBe(false);
    expect(isConflictGate(parseNmStatus(parked("ci", []))!)).toBe(false);
    expect(isConflictGate({ ...parseNmStatus(parked("ci", [CONFLICT_ROW]))!, outcome: "cancelled" })).toBe(false);
  });
});

describe("the delivery watcher and a conflict gate", () => {
  let dir: string;
  let db: Db;
  let status: string;
  let watcher: DeliveryWatcher;
  const now = 5_000_000;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fw-conflict-gate-"));
    db = openDb(join(dir, "flowryn.db"));
    migrate(db);
    status = join(dir, "nm-status");
    const noMistakes = join(dir, "no-mistakes");
    writeFileSync(noMistakes, `#!/bin/sh\ncat "${status}"\n`);
    chmodSync(noMistakes, 0o755);
    const worktree = join(dir, "w");
    mkdirSync(worktree);
    tx(db, () => {
      db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('p', 'u', '/p', 'main', 'no-mistakes')").run();
      db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES ('t1', 'p', 'ship', 'no-mistakes', 0, 'fix', ?1)").run(now);
      db.query(
        `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, stage_state, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
         VALUES ('r1', 't1', 'claude', 'v', 'running', 'busy', 'fix', 'ship', 'waiting', ?1, 'b', 's', 'r1', ?2, ?2)`,
      ).run(worktree, now);
    });
    watcher = new DeliveryWatcher({
      db,
      forge: () => ({}) as Forge,
      webUrl: () => "https://github.com",
      git: async () => ({ code: 0, stdout: "", stderr: "" }),
      noMistakes: () => noMistakes,
      nmTimeoutMs: () => 5_000,
      validationStuckMs: () => 30 * 60_000,
      pollMs: () => 60_000,
      ciWaitAlertMin: () => 0,
      inFlight: new Set(),
      cleanup: () => {},
      log: () => {},
      now: () => now,
      nudgeConflicts: () => true,
      kickScheduler: () => {},
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function nudged(kind: "run.conflict_nudged" | "pr.conflict", head: string): void {
    tx(db, () => appendEvent(db, { source: "github", kind, runId: "r1", taskId: "t1", payload: { head }, ts: now - 1_000 }));
  }

  function state(): string {
    return (db.query("SELECT state FROM runs WHERE id = 'r1'").get() as { state: string }).state;
  }

  function openItems(): string[] {
    return (db.query("SELECT kind FROM items WHERE run_id = 'r1' AND state IN ('open','presented')").all() as { kind: string }[]).map((r) => r.kind);
  }

  function evidence(): Record<string, unknown> {
    return JSON.parse((db.query("SELECT value FROM run_evidence WHERE run_id = 'r1' AND source = 'nomistakes'").get() as { value: string }).value) as Record<string, unknown>;
  }

  test("a run the nudge sent back stays running: no validating, no item, and the evidence says what covers it", async () => {
    nudged("run.conflict_nudged", HEAD);
    writeFileSync(status, parked("ci", [CONFLICT_ROW]));
    await watcher.pass();
    expect(state()).toBe("running");
    expect(openItems()).toEqual([]);
    expect(evidence()).toMatchObject({ id: "01NMCONFLICT", conflict_gate: "conflict_nudged" });
    expect(db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'run.validating'").get()).toEqual({ n: 0 });
  });

  test("the flat status shape is covered the same way", async () => {
    nudged("run.conflict_nudged", HEAD);
    writeFileSync(status, parked("ci", [CONFLICT_ROW], undefined, undefined, "flat"));
    await watcher.pass();
    expect(state()).toBe("running");
    expect(evidence()).toMatchObject({ conflict_gate: "conflict_nudged" });
  });

  test("once the nudges are spent, the pr_conflict covers it", async () => {
    nudged("pr.conflict", HEAD);
    writeFileSync(status, parked("ci", [CONFLICT_ROW]));
    await watcher.pass();
    expect(state()).toBe("running");
    expect(evidence()).toMatchObject({ conflict_gate: "pr_conflict" });
  });

  test("not covered as today: no nudge, a nudge for another head, or another finding beside the conflict", async () => {
    writeFileSync(status, parked("ci", [CONFLICT_ROW]));
    await watcher.pass();
    expect(state()).toBe("validating");
    expect(evidence()).toMatchObject({ conflict_gate: null });

    tx(db, () => db.query("UPDATE runs SET state = 'running' WHERE id = 'r1'").run());
    nudged("run.conflict_nudged", "0".repeat(40));
    await watcher.pass();
    expect(state()).toBe("validating");

    tx(db, () => db.query("UPDATE runs SET state = 'running' WHERE id = 'r1'").run());
    nudged("run.conflict_nudged", HEAD);
    writeFileSync(status, parked("ci", [CONFLICT_ROW, 'ci-2,error,"",,auto-fix,Check test failed']));
    await watcher.pass();
    expect(state()).toBe("validating");
  });

  test("a run it had made validating goes back to running once the nudge covers the gate", async () => {
    writeFileSync(status, parked("ci", [CONFLICT_ROW]));
    await watcher.pass();
    expect(state()).toBe("validating");
    nudged("run.conflict_nudged", HEAD);
    await watcher.pass();
    expect(state()).toBe("running");
    const validated = db.query("SELECT payload FROM events WHERE kind = 'run.validated' ORDER BY seq DESC LIMIT 1").get() as { payload: string };
    expect(JSON.parse(validated.payload)).toMatchObject({ nm_run: "01NMCONFLICT", conflict_gate: "conflict_nudged" });
  });
});
