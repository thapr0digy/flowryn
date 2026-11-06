import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlowrynError } from "../../src/api/errors.ts";
import type { HandlerCtx } from "../../src/api/verbs.ts";
import { parseConfig, type FlowrynConfig } from "../../src/config/config.ts";
import { migrate, openDb, type Db } from "../../src/db/db.ts";
import { handoffsOf } from "../../src/lifecycle/handoffs.ts";
import { getRunWithPolicy } from "../../src/lifecycle/runs.ts";
import type { WorkflowDef } from "../../src/config/workflows.ts";
import { beginLastStage, deliveryHandoff, recordStageDelivered, startPooledStages } from "../../src/lifecycle/stages.ts";

/**
 * `stage begin <last stage>`, and a direct-PR or local-only `deliver`, from a build stage owe
 * the same handoff as `stage done` (docs/notes/2026-11-05-workers-get-rich-hx.md, "Handoffs"):
 * refused without one, stored under the build stage with its stage event when given.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "fl-begin-handoff-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const HOME = join(root, "home");
for (const dir of [join(HOME, "flowryn", "data"), join(HOME, "flowryn", "state")]) mkdirSync(dir, { recursive: true });
const BASE = `data_dir = ${JSON.stringify(join(HOME, "flowryn", "data"))}\nstate_dir = ${JSON.stringify(join(HOME, "flowryn", "state"))}\n`;
const ENFORCED = parseConfig(`${BASE}[briefs]\nenforce = true\n`, HOME);
const LOOSE = parseConfig(`${BASE}[briefs]\nenforce = false\n`, HOME);

const HANDOFF = "## Done\nBuilt the cache.\n\n## Deviations\nNone.\n\n## Risks\nThe cache grows without bound.";
const RUN = "r01BEGIN";
const TASK = "web-cache-b1";

let db: Db;
let dbDir: string;

beforeEach(() => {
  dbDir = mkdtempSync(join(root, "db-"));
  db = openDb(join(dbDir, "flowryn.db"));
  migrate(db);
  db.query("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('web', '', '/tmp/web', 'main', 'no-mistakes')").run();
});

afterEach(() => {
  db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

/** A no-mistakes ship in its workflow's build stage; `startedAt` 0 is a run from before the rich-briefs migration. */
type Mode = "no-mistakes" | "direct-PR" | "local-only";

function seed(workflow: "feature" | "fix" | "pooled", opts: { startedAt?: number; stage?: string; stageState?: string; mode?: Mode; workflowDef?: WorkflowDef } = {}): void {
  const now = Date.now();
  db.query("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES (?1, 'web', 'ship', ?2, 0, ?3, ?4)").run(TASK, opts.mode ?? "no-mistakes", workflow, now);
  db.query(
    `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, workflow_def, stage, stage_state, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
     VALUES (?1, ?2, 'claude', '2.1.281', 'running', 'busy', ?3, ?8, ?4, ?5, '/tmp/wt', 'fm/x', 'abc123', 'h', ?6, ?7)`,
  ).run(RUN, TASK, workflow, opts.stage ?? "build", opts.stageState ?? "active", opts.startedAt ?? now + 1000, now, opts.workflowDef ? JSON.stringify(opts.workflowDef) : null);
}

function ctxFor(config: FlowrynConfig): HandlerCtx {
  const grantNow = async (runId: string) => {
    db.query("UPDATE runs SET stage_state = 'active', waiting_since = NULL, stage_started_at = ?2 WHERE id = ?1 AND stage_state = 'waiting'").run(runId, Date.now());
    return true;
  };
  const sched = { grantNow, kick: () => {} };
  return { db, config: () => config, now: () => Date.now(), via: "socket", caller: { role: "worker", runId: RUN, taskId: TASK }, sched } as unknown as HandlerCtx;
}

async function refusal(promise: Promise<unknown>): Promise<FlowrynError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof FlowrynError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

function stageOf(): { stage: string; stage_state: string } {
  return db.query("SELECT stage, stage_state FROM runs WHERE id = ?1").get(RUN) as { stage: string; stage_state: string };
}

function doneEvents(): Record<string, unknown>[] {
  return (db.query("SELECT payload FROM events WHERE kind = 'stage.done' ORDER BY seq").all() as { payload: string }[]).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
}

describe("stage begin from a build stage", () => {
  test("refuses without a handoff, with stage done's error shape, and nothing moves", async () => {
    seed("feature");
    const error = await refusal(beginLastStage(ctxFor(ENFORCED), RUN, "ship"));
    expect(error.code).toBe("handoff_invalid");
    expect(error.message).toBe("stage build ends with a handoff to the next stage: what you did, deviations from the spec and why, open risks");
    expect(error.help).toContain('$FLOWRYN_BIN stage begin ship --handoff-file "$TMPDIR/handoff.md"');
    expect(stageOf()).toEqual({ stage: "build", stage_state: "active" });
    expect(doneEvents()).toEqual([]);
    expect(handoffsOf(db, TASK)).toEqual([]);
  });

  test("keeps a given handoff under stage build, on its stage.done event", async () => {
    seed("feature");
    expect(await beginLastStage(ctxFor(ENFORCED), RUN, "ship", HANDOFF)).toEqual({ handoffIgnored: false });
    expect(stageOf().stage).toBe("ship");
    const kept = handoffsOf(db, TASK);
    expect(kept.map((h) => [h.stage, h.run_id, h.text])).toEqual([["build", RUN, HANDOFF]]);
    const id = (db.query("SELECT id FROM stage_handoffs").get() as { id: number }).id;
    expect(doneEvents()).toEqual([expect.objectContaining({ stage: "build", for: "begin", next: "ship", handoff: id })]);
  });

  test("refuses an incomplete handoff with every problem, and nothing moves", async () => {
    seed("feature");
    const error = await refusal(beginLastStage(ctxFor(ENFORCED), RUN, "ship", "## Done\nBuilt it."));
    expect(error.code).toBe("handoff_invalid");
    expect(error.message).toContain("Deviations");
    expect(error.message).toContain("Risks");
    expect(stageOf().stage).toBe("build");
  });

  test("assumption: a run started before the rich-briefs migration owes no handoff on this path either", async () => {
    seed("feature", { startedAt: 0 });
    await beginLastStage(ctxFor(ENFORCED), RUN, "ship");
    expect(stageOf().stage).toBe("ship");
    expect(handoffsOf(db, TASK)).toEqual([]);
  });

  test("[briefs] enforce off owes none, and still keeps one that is given", async () => {
    seed("feature");
    await beginLastStage(ctxFor(LOOSE), RUN, "ship", HANDOFF);
    expect(handoffsOf(db, TASK).map((h) => h.stage)).toEqual(["build"]);
  });

  test("a build stage without the build skill (the fix workflow's) owes none", async () => {
    seed("fix");
    await beginLastStage(ctxFor(ENFORCED), RUN, "ship");
    expect(stageOf().stage).toBe("ship");
    expect(doneEvents()).toEqual([expect.not.objectContaining({ handoff: expect.anything() })]);
  });

  test("a repeat call once the last stage has started keeps nothing new, and says so", async () => {
    seed("feature", { stage: "ship" });
    expect(await beginLastStage(ctxFor(ENFORCED), RUN, "ship", HANDOFF)).toEqual({ handoffIgnored: true });
    expect(handoffsOf(db, TASK)).toEqual([]);
    expect(doneEvents()).toEqual([]);
    const error = await refusal(beginLastStage(ctxFor(ENFORCED), RUN, "ship", "not a handoff"));
    expect(error.code).toBe("handoff_invalid");
  });
});

const DELIVERY: Record<"direct-PR" | "local-only", string> = { "direct-PR": "$FLOWRYN_BIN deliver --pr <url>", "local-only": "$FLOWRYN_BIN deliver --local" };

describe("a delivery straight from a build stage", () => {
  for (const mode of ["direct-PR", "local-only"] as const) {
    test(`${mode}: the pooled ship stage it starts is refused without a handoff, and nothing moves`, async () => {
      seed("feature", { mode });
      const error = await refusal(startPooledStages(ctxFor(ENFORCED), RUN));
      expect(error.code).toBe("handoff_invalid");
      expect(error.message).toBe("stage build ends with a handoff to the next stage: what you did, deviations from the spec and why, open risks");
      expect(error.help).toContain(`${DELIVERY[mode]} --handoff-file "$TMPDIR/handoff.md"`);
      expect(stageOf()).toEqual({ stage: "build", stage_state: "active" });
      expect(doneEvents()).toEqual([]);
    });

    test(`${mode}: a given handoff is kept under build, on the stage.done event of the stage it ends`, async () => {
      seed("feature", { mode });
      await startPooledStages(ctxFor(ENFORCED), RUN, HANDOFF);
      expect(stageOf().stage).toBe("ship");
      expect(handoffsOf(db, TASK).map((h) => [h.stage, h.text])).toEqual([["build", HANDOFF]]);
      const id = (db.query("SELECT id FROM stage_handoffs").get() as { id: number }).id;
      expect(doneEvents()).toEqual([expect.objectContaining({ stage: "build", for: "deliver", next: "ship", handoff: id })]);
      // The redelivery from ship, once it has started, owes none and keeps nothing new.
      expect(deliveryHandoff(ctxFor(ENFORCED), getRunWithPolicy(db, RUN)!, HANDOFF)).toBeNull();
    });

    test(`${mode}: a delivery that ends build at once (no pooled stage between) keeps it on stage.delivered`, () => {
      seed("feature", { mode });
      const run = getRunWithPolicy(db, RUN)!;
      expect(() => deliveryHandoff(ctxFor(ENFORCED), run, undefined)).toThrow(expect.objectContaining({ code: "handoff_invalid" }));
      const handoff = deliveryHandoff(ctxFor(ENFORCED), run, HANDOFF);
      expect(handoff).toEqual({ stage: "build", text: HANDOFF });
      recordStageDelivered(db, run, ["build", "ship"], Date.now(), handoff);
      const id = (db.query("SELECT id FROM stage_handoffs").get() as { id: number }).id;
      const delivered = db.query("SELECT payload FROM events WHERE kind = 'stage.delivered'").get() as { payload: string };
      expect(JSON.parse(delivered.payload)).toMatchObject({ stage: "ship", handoff: id });
      expect(handoffsOf(db, TASK).map((h) => h.stage)).toEqual(["build"]);
    });
  }

  test("assumption: a run started before the rich-briefs migration owes no handoff when it delivers either", async () => {
    seed("feature", { mode: "local-only", startedAt: 0 });
    await startPooledStages(ctxFor(ENFORCED), RUN);
    expect(stageOf().stage).toBe("ship");
    expect(handoffsOf(db, TASK)).toEqual([]);
  });

  test("a configured workflow with two pooled stages after build keeps the handoff once, under build", async () => {
    const step = (id: string, extra: Partial<WorkflowDef["stages"][number]> = {}) => ({ id, skill: null, gate: "none" as const, pools: ["validation"], fresh: false, ...extra });
    const workflowDef: WorkflowDef = { id: "pooled", stages: [step("build", { skill: "flowryn-build-test", pools: [] }), step("a"), step("ship", { gate: "merge" })] };
    seed("pooled", { mode: "direct-PR", workflowDef });
    expect(await startPooledStages(ctxFor(ENFORCED), RUN, HANDOFF)).toEqual({ handoffKept: true });
    expect(stageOf().stage).toBe("ship");
    expect(handoffsOf(db, TASK).map((h) => [h.stage, h.text])).toEqual([["build", HANDOFF]]);
    const id = (db.query("SELECT id FROM stage_handoffs").get() as { id: number }).id;
    expect(doneEvents()).toEqual([
      expect.objectContaining({ stage: "build", next: "a", handoff: id }),
      expect.not.objectContaining({ handoff: expect.anything() }),
    ]);
    expect(doneEvents()[1]).toMatchObject({ stage: "a", next: "ship" });
  });

  test("the fix workflow's build (no build skill) owes none", async () => {
    seed("fix", { mode: "direct-PR" });
    await startPooledStages(ctxFor(ENFORCED), RUN);
    expect(stageOf().stage).toBe("ship");
  });
});
