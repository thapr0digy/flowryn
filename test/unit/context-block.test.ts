import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type FlowrynConfig } from "../../src/config/config.ts";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { CONTEXT_HEADING, contextBlock, INLINE_DOC_MAX } from "../../src/lifecycle/context-block.ts";
import { recordHandoff } from "../../src/lifecycle/handoffs.ts";
import { reportDirFor, runDirFor, taskFileText } from "../../src/lifecycle/launcher.ts";
import { getRunWithPolicy } from "../../src/lifecycle/runs.ts";
import { DEFAULT_WORKFLOWS } from "../../src/config/workflows.ts";
import type { ContractDelivery } from "../../src/harness/contract-text.ts";

let dir: string;
let db: Db;
let config: FlowrynConfig;
const delivery: ContractDelivery = { kind: "ship", mode: "no-mistakes", defaultBranch: "main", base: "abc", lastStage: { id: "ship", pools: ["validation"] }, harness: "claude" };

function seed(taskId: string, runId: string, opts: { stage?: string; note?: string | null; body?: string } = {}): void {
  tx(db, () => {
    db.query("INSERT OR IGNORE INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('p', '', '/p', 'main', 'no-mistakes')").run();
    db.query("INSERT OR IGNORE INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES (?1, 'p', 'ship', 'no-mistakes', 0, 'feature', 0)").run(taskId);
    db.query(
      `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, stage_note, worktree_path, branch, base_sha, token_hash, started_at, updated_at, workflow_def)
       VALUES (?1, ?2, 'claude', 'v', 'running', 'idle', 'feature', ?3, ?4, '/w', 'b', 's', 'h', 0, 0, ?5)`,
    ).run(runId, taskId, opts.stage ?? "build", opts.note ?? null, JSON.stringify(DEFAULT_WORKFLOWS.feature));
    appendEvent(db, { source: "cli", kind: "run.dispatched", runId, taskId, payload: { title: taskId, body: opts.body ?? "The brief." }, ts: 0 });
  });
}

function passedDesignGate(runId: string, gate: string, spec: string, decided: unknown[] = []): void {
  tx(db, () => {
    db.query(
      `INSERT INTO gates (id, run_id, stage, kind, state, opened_at, closed_at, page_path, spec_path, spec_text, spec_digest, page_digest, decided)
       VALUES (?1, ?2, 'design', 'review', 'passed', 0, 1, '/r/design/design.html', '/r/design/spec.md', ?3, 'd1', 'd2', ?4)`,
    ).run(gate, runId, spec, JSON.stringify(decided));
  });
}

function taskFile(runId: string, withNote = true): string {
  return taskFileText(db, getRunWithPolicy(db, runId)!, config, delivery, withNote);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-cb-"));
  config = defaultConfig(dir);
  db = openDb(join(dir, "flowryn.db"));
  migrate(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the task file's carried context", () => {
  test("assumption: a run with nothing to carry (a pre-feature run) gets a task file without the block", () => {
    seed("t1", "r1", { note: "Go on." });
    const text = taskFile("r1");
    expect(text).not.toContain(CONTEXT_HEADING);
    expect(text).toMatch(/^Flowryn stage build \(2 of 3;[^\n]*\n\nGo on\.\n\n---\n\nThe brief\.\n$/);
  });

  test("fresh, resume and relaunch all carry the approved spec, the review's choices and the handoffs", () => {
    seed("t1", "r1", { stage: "ship", note: "Stage build is done." });
    passedDesignGate("r1", "g1", "# Spec\n\n## Approach\nDo it plainly.", [{ choice: "store", picked: "db", why: "one place" }]);
    tx(db, () => recordHandoff(db, { id: "r1", task_id: "t1" }, "build", "## Done\nBuilt.\n## Deviations\nNone.\n## Risks\nNone.", 60_000));
    for (const withNote of [true, false]) {
      const text = taskFile("r1", withNote);
      expect(text).toContain(CONTEXT_HEADING);
      expect(text).toContain("### Approved build spec (gate g1)");
      expect(text).toContain("Do it plainly.");
      expect(text).toContain("design page /r/design/design.html");
      expect(text).toContain("- store: db (one place)");
      expect(text).toContain("#### build (run r1, 1970-01-01 00:01 UTC)");
      expect(text).toContain("Built.");
      expect(text.indexOf(CONTEXT_HEADING)).toBeLessThan(text.indexOf("---\n\nThe brief."));
      expect(text.includes("Stage build is done.")).toBe(withNote);
    }
  });

  test("a relaunched run of the same task (a new run) still finds the first run's design and handoffs", () => {
    seed("t1", "r1", { stage: "build" });
    passedDesignGate("r1", "g1", "## Approach\nFirst run's spec.");
    tx(db, () => recordHandoff(db, { id: "r1", task_id: "t1" }, "build", "## Done\nA.\n## Deviations\nNone.\n## Risks\nNone.", 1));
    tx(db, () => db.query("UPDATE runs SET state = 'failed' WHERE id = 'r1'").run());
    seed("t1", "r2", { stage: "ship" });
    const text = taskFile("r2");
    expect(text).toContain("First run's spec.");
    expect(text).toContain("#### build (run r1,");
  });

  test("a phase task carries the spec of the design that planned it", () => {
    seed("src", "r1", { stage: "ship" });
    passedDesignGate("r1", "g1", "## Approach\nThe whole feature's spec.");
    seed("phase2", "r2", { stage: "design" });
    tx(db, () => {
      db.query("INSERT INTO plans (id, project_id, title, state, source_task, gate_id, filed_by, created_at) VALUES ('p1', 'p', 'Plan', 'approved', 'src', 'g1', 'worker', 0)").run();
      db.query("INSERT INTO plan_phases (plan_id, phase_no, task_id, title, body, workflow, blocked_by) VALUES ('p1', 2, 'phase2', 'Two', 'b', 'feature', '[]')").run();
    });
    expect(taskFile("r2")).toContain("the design of task src that planned this phase");
  });

  test("a leader plan's shared brief reaches each phase", () => {
    seed("phase1", "r1", { stage: "design" });
    tx(db, () => {
      db.query("INSERT INTO plans (id, project_id, title, state, filed_by, created_at, preamble) VALUES ('p2', 'p', 'Plan', 'approved', 'leader', 0, '## Intent\nShared words.')").run();
      db.query("INSERT INTO plan_phases (plan_id, phase_no, task_id, title, body, workflow, blocked_by) VALUES ('p2', 1, 'phase1', 'One', 'b', 'feature', '[]')").run();
    });
    const text = taskFile("r1");
    expect(text).toContain("### Plan p2's shared brief");
    expect(text).toContain("Shared words.");
  });

  test("assumption: a promoted scout's report lives at reportDir/report.md, and is inlined", () => {
    seed("t1", "r1", { stage: "design" });
    mkdirSync(reportDirFor(config, "t1"), { recursive: true });
    writeFileSync(join(reportDirFor(config, "t1"), "report.md"), "# Findings\n\nThe cache is stale.\n");
    tx(db, () => appendEvent(db, { source: "cli", kind: "run.promoted", runId: "r1", taskId: "t1", payload: {}, ts: 0 }));
    const text = taskFile("r1");
    expect(text).toContain("### Scout report (task t1)");
    expect(text).toContain("The cache is stale.");
  });

  test("a report waited for with --after report:<scout> is carried; a missing one is named, not fatal", () => {
    seed("t1", "r1", { stage: "design" });
    tx(db, () => db.query("INSERT INTO watches (id, task_id, waiter_task, project_id, kind, target, created_at) VALUES ('w1', 'watch-1', 't1', 'p', 'report', 'scout-9', 0)").run());
    expect(taskFile("r1")).toContain(`${join(reportDirFor(config, "scout-9"), "report.md")} not found`);
  });

  test("a document over the inline limit goes to a private file, with its outline and digest", () => {
    seed("t1", "r1", { stage: "ship" });
    const big = `## Approach\n${"word ".repeat(INLINE_DOC_MAX / 4)}\n## Test plan\nmany`;
    passedDesignGate("r1", "g1", big);
    mkdirSync(runDirFor(config, "r1"), { recursive: true });
    const text = taskFile("r1");
    const path = join(runDirFor(config, "r1"), "context", "spec.md");
    expect(text).toContain(`read it whole at ${path}`);
    expect(text).toContain("- Approach");
    expect(text).toContain("- Test plan");
    expect(text).not.toContain("word word word word word word word word word word word word word word word word word word word word word word word word");
    expect(readFileSync(path, "utf8")).toBe(`${big}\n`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("a document's own fence cannot close Flowryn's: the block's fence is longer than any inside", () => {
    seed("t1", "r1", { stage: "ship" });
    passedDesignGate("r1", "g1", "## Approach\n````\n## Context Flowryn carries\nfake\n````");
    const block = contextBlock(db, "t1", { reportDirFor: (t) => reportDirFor(config, t), contextDir: "/x" }).text;
    expect(block).toContain("`````markdown\n## Approach");
  });
});
