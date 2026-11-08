import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DOC_TEMPLATES } from "../../src/lifecycle/brief-templates.ts";
import { filledDesignPage } from "../helpers/design-page.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";
import { waitUntil } from "../helpers/harness.ts";
import { useIntegrationTimeout } from "../helpers/integration-timeout.ts";

useIntegrationTimeout();

/**
 * Rich briefs end to end on the fake fleet (docs/notes/2026-11-05-workers-get-rich-hx.md), with
 * [briefs] enforce on: a ship dispatch needs a structured brief, the design stage hands in a build
 * spec pinned with its page, build ends with a handoff, and the ship stage's task file carries the
 * approved spec and that handoff.
 */

let ship: ShipEnv | null = null;

afterEach(async () => {
  await ship?.cleanup();
  ship = null;
});

const ENFORCE = "[briefs]\nenforce = true\n";
const SPEC = "# Build spec\\n\\n## Approach\\nCache tokens in the database: FLOWRYN-SPEC-MARK.\\n\\n## Files and interfaces\\nsrc/cache.ts\\n\\n## Data and schema\\nOne table.\\n\\n## Error handling\\nRefuse loudly.\\n\\n## Security\\nNo token in logs.\\n\\n## Test plan\\nA unit test per path.\\n\\n## Rejected alternatives\\nNone: the only sane way.";
const HANDOFF = "## Done\\nBuilt the cache: FLOWRYN-HANDOFF-MARK.\\n\\n## Deviations\\nNone.\\n\\n## Risks\\nThe cache grows without bound.";
const PAGE = filledDesignPage().replace("</details>", '<a href="spec.md">The build spec</a></details>');

/** A filled ship brief whose Verification section carries the fake worker's steps. */
function brief(steps: string[]): string {
  return `Token cache\n\n${DOC_TEMPLATES.ship.replace(/^<one-line title>\n/, "").replace(/\{\{[^}]*\}\}/g, "Written in full by the leader.")}\n${steps.join("\n")}\n`;
}

function one<T>(e: ShipEnv, sql: string, ...params: string[]): T | null {
  const db = e.fleet.h.db();
  try {
    return (db.query(sql).get(...params) as T | null) ?? null;
  } finally {
    db.close();
  }
}

/** A message the user leaves on the review page, as lavish-axi's next poll reports it (its feedback output). */
function queueAnnotation(e: ShipEnv, text: string): void {
  const dir = join(e.fleet.h.home, "lavish-queue");
  mkdirSync(dir, { recursive: true });
  const prompt = `  - uid: x\n    prompt: ${JSON.stringify(text)}\n    selector: h1\n    tag: annotation\n    text: Design`;
  writeFileSync(join(dir, "001.out"), `session:\n  file: /x/design.html\n  status: feedback\nprompts[1]:\n${prompt}\nnext_step: "Apply the requested changes."\ndom_snapshot: ""\n`);
}

describe("rich briefs", () => {
  test("a free-text ship is refused with every missing section; your --loose dispatch goes through and keeps its reason; a leader's --loose is refused", async () => {
    ship = await makeShipEnv({ mode: "local-only", extraConfig: ENFORCE });
    const f = ship.fleet;
    const refused = await f.json(["dispatch", "web", "--kind", "ship", "--body-file", "-"], { env: { FLOWRYN_TOKEN: ship.leaderToken() }, stdin: "Fix it\nFAKE: sleep 1000" });
    expect(refused.code).toBe(3);
    expect(refused.reply.error).toMatchObject({ code: "brief_invalid" });
    expect((refused.reply.error as { message: string }).message).toContain("missing sections: ## Intent, ## Context, ## Requirements, ## Constraints, ## Security, ## Out of scope, ## Verification");
    const leaderLoose = await f.json(["dispatch", "web", "--kind", "ship", "--loose", "quick", "--body-file", "-"], { env: { FLOWRYN_TOKEN: ship.leaderToken() }, stdin: "Fix it" });
    expect(leaderLoose.reply.error).toMatchObject({ code: "bad_args" });
    // Your own terminal (no token, channel tty), the way the CLI calls from your shell.
    const loose = await ship.call("dispatch", { project: "web", kind: "ship", loose: "a one-line typo fix", body: "Fix the typo\nFAKE: sleep 120000" });
    expect(loose.ok).toBe(true);
    const task = (loose.data as { task: string }).task;
    expect(JSON.parse(one<{ payload: string }>(ship, "SELECT payload FROM events WHERE kind = 'brief.loose' AND task_id = ?1", task)!.payload)).toMatchObject({ reason: "a one-line typo fix", by: "human" });
    const template = await f.json(["template", "ship"]);
    expect((template.reply.data as { required: string[] }).required).toEqual(["Intent", "Context", "Requirements", "Constraints", "Security", "Out of scope", "Verification"]);
  });

  test("your --loose plan keeps its shared brief; a brief over the size cap is refused even with [briefs] enforce off", async () => {
    ship = await makeShipEnv({ mode: "local-only", extraConfig: ENFORCE });
    const planBody = "# Draft plan\n\n## Cache\nFAKE: sleep 120000\n";
    const loose = await ship.call("plan", { project: "web", body: planBody, brief: "Shared notes: FLOWRYN-LOOSE-BRIEF", loose: "a rough draft" });
    expect(loose.ok).toBe(true);
    const plan = (loose.data as { plan: string }).plan;
    expect(one<{ preamble: string }>(ship, "SELECT preamble FROM plans WHERE id = ?1", plan)!.preamble).toBe("Shared notes: FLOWRYN-LOOSE-BRIEF");
    await ship.cleanup();

    ship = await makeShipEnv({ mode: "local-only" });
    const oversized = await ship.call("plan", { project: "web", body: planBody, brief: "x".repeat(64_001) });
    expect(oversized.ok).toBe(false);
    expect(oversized.error).toMatchObject({ code: "bad_args" });
    expect(one<{ n: number }>(ship, "SELECT count(*) AS n FROM plans")!.n).toBe(0);
  });

  test(
    "design → build → ship: the spec is pinned, a changed spec cannot pass until the worker replies, and the ship stage's task file holds the spec and the build handoff",
    async () => {
      ship = await makeShipEnv({ mode: "local-only", extraConfig: ENFORCE });
      const e = ship;
      const f = e.fleet;
      expect((await f.json(["project", "set", "web", "--workflow", "feature"])).code).toBe(0);
      const steps = [
        `FAKE: write design/design.html ${PAGE}`,
        // No spec yet: refused.
        "FAKE: verb stage done --review lavish:design/design.html --page $FLOWRYN_REPORT_DIR/design/design.html",
        `FAKE: write design/spec.md ${SPEC}`,
        "FAKE: stage-done --review lavish:design/design.html --page $FLOWRYN_REPORT_DIR/design/design.html",
        // The user's page message wakes the worker, which replies on the page once the spec is revised.
        "FAKE: wait-file spec-revised",
        "FAKE: write reply.md Revised the spec: two tables.",
        "FAKE: verb review reply --body-file $FLOWRYN_REPORT_DIR/reply.md",
        "FAKE: wait-file build-go",
        "FAKE: commit cache.ts export const cache = 1;",
        // No handoff: refused.
        "FAKE: verb stage done",
        `FAKE: write handoff.md ${HANDOFF}`,
        "FAKE: stage-done --handoff-file $FLOWRYN_REPORT_DIR/handoff.md",
        "FAKE: deliver-local",
        "FAKE: sleep 120000",
      ];
      const dispatched = await f.json(["dispatch", "web", "--kind", "ship", "--body-file", "-"], { env: { FLOWRYN_TOKEN: e.leaderToken() }, stdin: brief(steps) });
      expect(dispatched.code).toBe(0);
      const { task, run } = dispatched.reply.data as { task: string; run: string };
      await f.waitRun(run, (r) => r.stage === "design" && r.stage_state === "review", "the design review");
      const [noSpec] = await e.replies(task, 1);
      expect((noSpec!.reply.error as { code: string }).code).toBe("spec_invalid");
      const gate = one<{ id: string; spec_digest: string; spec_text: string }>(e, "SELECT id, spec_digest, spec_text FROM gates WHERE run_id = ?1 AND state = 'open'", run)!;
      expect(gate.spec_text).toContain("FLOWRYN-SPEC-MARK");

      // The spec changes under the open review: the pass is refused until it is pinned again.
      const specPath = join(f.h.dataDir, task, "design", "spec.md");
      writeFileSync(specPath, readFileSync(specPath, "utf8").replace("One table.", "Two tables."));
      // The daemon copies the revision into the page the user sees (src/lavish/snapshot.ts); the pin checks that copy.
      const shownSpec = one<{ spec_path: string }>(e, "SELECT spec_path FROM gates WHERE id = ?1", gate.id)!.spec_path;
      expect(shownSpec).toBe(join(realpathSync(f.h.stateDir), "review-pages", run, "design", "spec.md"));
      await waitUntil(() => readFileSync(shownSpec, "utf8").includes("Two tables."), 10_000, "the spec copied");
      const drifted = await e.approve(task, { gate: "design" });
      expect(drifted.ok).toBe(false);
      expect(drifted.error).toMatchObject({ code: "design_changed" });
      queueAnnotation(e, "Use two tables, not one.");
      writeFileSync(join(f.h.dataDir, task, "spec-revised"), "");
      const [, , reply] = await e.replies(task, 3);
      expect(reply!.args.join(" ")).toStartWith("review reply");
      expect(reply!.reply.data).toMatchObject({ gate: gate.id, repinned: "design page and build spec" });
      expect(one<{ spec_text: string }>(e, "SELECT spec_text FROM gates WHERE id = ?1", gate.id)!.spec_text).toContain("Two tables.");
      expect((await e.approve(task, { gate: "design" })).ok).toBe(true);
      writeFileSync(join(f.h.dataDir, task, "build-go"), "");

      await f.waitRun(run, (r) => r.state === "ready", "the delivery", 60_000);
      const replies = await e.replies(task, 4);
      const noHandoff = replies.find((r) => r.args.join(" ") === "stage done")!;
      expect((noHandoff.reply.error as { code: string }).code).toBe("handoff_invalid");
      const taskFile = readFileSync(join(f.h.stateDir, "runs", run, "task.md"), "utf8");
      expect(taskFile).toStartWith("Flowryn stage ship (3 of 3;");
      expect(taskFile).toContain("## Context Flowryn carries");
      expect(taskFile).toContain(`### Approved build spec (gate ${gate.id})`);
      expect(taskFile).toContain("FLOWRYN-SPEC-MARK");
      expect(taskFile).toContain("Two tables.");
      expect(taskFile).toContain("#### build (run ");
      expect(taskFile).toContain("FLOWRYN-HANDOFF-MARK");
      // The stage start's note carries the handoff too, not only "Stage build is done."
      const steer = one<{ body: string }>(e, "SELECT body FROM messages WHERE run_id = ?1 AND body LIKE '%FLOWRYN-HANDOFF-MARK%'", run)!;
      expect(steer.body).toContain("Stage build is done. Its handoff");
    },
    { timeout: 150_000 },
  );

  test(
    "design → build → stage begin ship: refused without a handoff, then the ship stage's task file holds the build handoff",
    async () => {
      ship = await makeShipEnv({ mode: "local-only", extraConfig: ENFORCE });
      const e = ship;
      const f = e.fleet;
      expect((await f.json(["project", "set", "web", "--workflow", "feature"])).code).toBe(0);
      const steps = [
        `FAKE: write design/design.html ${PAGE}`,
        `FAKE: write design/spec.md ${SPEC}`,
        "FAKE: stage-done --review lavish:design/design.html --page $FLOWRYN_REPORT_DIR/design/design.html",
        "FAKE: wait-file build-go",
        "FAKE: commit cache.ts export const cache = 1;",
        // Straight to the last stage, the no-mistakes shortcut: no handoff, refused.
        "FAKE: verb stage begin ship",
        `FAKE: write handoff.md ${HANDOFF}`,
        "FAKE: verb stage begin ship --handoff-file $FLOWRYN_REPORT_DIR/handoff.md",
        "FAKE: deliver-local",
        "FAKE: sleep 120000",
      ];
      const dispatched = await f.json(["dispatch", "web", "--kind", "ship", "--body-file", "-"], { env: { FLOWRYN_TOKEN: e.leaderToken() }, stdin: brief(steps) });
      expect(dispatched.code).toBe(0);
      const { task, run } = dispatched.reply.data as { task: string; run: string };
      await f.waitRun(run, (r) => r.stage === "design" && r.stage_state === "review", "the design review");
      expect((await e.approve(task, { gate: "design" })).ok).toBe(true);
      writeFileSync(join(f.h.dataDir, task, "build-go"), "");

      await f.waitRun(run, (r) => r.state === "ready", "the delivery", 60_000);
      const replies = await e.replies(task, 3);
      const begins = replies.filter((r) => r.args.join(" ").startsWith("stage begin ship"));
      expect(begins.length).toBe(2);
      expect((begins[0]!.reply.error as { code: string }).code).toBe("handoff_invalid");
      expect((begins[0]!.reply.error as { help: string }).help).toContain("stage begin ship --handoff-file");
      expect(begins[1]!.reply.ok).toBe(true);
      const done = one<{ payload: string }>(e, "SELECT payload FROM events WHERE kind = 'stage.done' AND run_id = ?1 AND payload LIKE '%\"for\":\"begin\"%'", run)!;
      expect(JSON.parse(done.payload)).toMatchObject({ stage: "build", next: "ship", handoff: expect.any(Number) });
      const taskFile = readFileSync(join(f.h.stateDir, "runs", run, "task.md"), "utf8");
      expect(taskFile).toStartWith("Flowryn stage ship (3 of 3;");
      expect(taskFile).toContain("#### build (run ");
      expect(taskFile).toContain("FLOWRYN-HANDOFF-MARK");
    },
    { timeout: 150_000 },
  );

  test(
    "design → build → deliver --local straight from build: refused without a handoff, then kept and carried",
    async () => {
      ship = await makeShipEnv({ mode: "local-only", extraConfig: ENFORCE });
      const e = ship;
      const f = e.fleet;
      expect((await f.json(["project", "set", "web", "--workflow", "feature"])).code).toBe(0);
      const steps = [
        `FAKE: write design/design.html ${PAGE}`,
        `FAKE: write design/spec.md ${SPEC}`,
        "FAKE: stage-done --review lavish:design/design.html --page $FLOWRYN_REPORT_DIR/design/design.html",
        "FAKE: wait-file build-go",
        "FAKE: commit cache.ts export const cache = 1;",
        "FAKE: verb deliver --local",
        `FAKE: write handoff.md ${HANDOFF}`,
        "FAKE: verb deliver --local --handoff-file $FLOWRYN_REPORT_DIR/handoff.md",
        "FAKE: sleep 120000",
      ];
      const dispatched = await f.json(["dispatch", "web", "--kind", "ship", "--body-file", "-"], { env: { FLOWRYN_TOKEN: e.leaderToken() }, stdin: brief(steps) });
      expect(dispatched.code).toBe(0);
      const { task, run } = dispatched.reply.data as { task: string; run: string };
      await f.waitRun(run, (r) => r.stage === "design" && r.stage_state === "review", "the design review");
      expect((await e.approve(task, { gate: "design" })).ok).toBe(true);
      writeFileSync(join(f.h.dataDir, task, "build-go"), "");

      await f.waitRun(run, (r) => r.state === "ready", "the delivery", 60_000);
      const replies = await e.replies(task, 3);
      const delivers = replies.filter((r) => r.args.join(" ").startsWith("deliver --local"));
      expect(delivers.length).toBe(2);
      expect((delivers[0]!.reply.error as { code: string }).code).toBe("handoff_invalid");
      expect((delivers[0]!.reply.error as { help: string }).help).toContain("deliver --local --handoff-file");
      expect(delivers[1]!.reply.ok).toBe(true);
      const handoff = one<{ stage: string; text: string }>(e, "SELECT stage, text FROM stage_handoffs WHERE run_id = ?1", run)!;
      expect(handoff.stage).toBe("build");
      expect(handoff.text).toContain("FLOWRYN-HANDOFF-MARK");
      const taskFile = readFileSync(join(f.h.stateDir, "runs", run, "task.md"), "utf8");
      expect(taskFile).toContain("FLOWRYN-HANDOFF-MARK");
    },
    { timeout: 150_000 },
  );

  test(
    "a reply after a revision the copy refused pins nothing: the tab still shows the old page and spec, so the changed spec cannot pass",
    async () => {
      ship = await makeShipEnv({ mode: "local-only", extraConfig: ENFORCE });
      const e = ship;
      const f = e.fleet;
      expect((await f.json(["project", "set", "web", "--workflow", "feature"])).code).toBe(0);
      const handler = PAGE.replace("</details>", '<img src="x.png" onerror="go()"></details>');
      const steps = [
        `FAKE: write design/design.html ${PAGE}`,
        `FAKE: write design/spec.md ${SPEC}`,
        "FAKE: stage-done --review lavish:design/design.html --page $FLOWRYN_REPORT_DIR/design/design.html",
        "FAKE: wait-file spec-revised",
        `FAKE: write design/design.html ${handler}`,
        "FAKE: write reply.md Revised the spec: two tables.",
        "FAKE: verb review reply --body-file $FLOWRYN_REPORT_DIR/reply.md",
        "FAKE: sleep 120000",
      ];
      const dispatched = await f.json(["dispatch", "web", "--kind", "ship", "--body-file", "-"], { env: { FLOWRYN_TOKEN: e.leaderToken() }, stdin: brief(steps) });
      expect(dispatched.code).toBe(0);
      const { task, run } = dispatched.reply.data as { task: string; run: string };
      await f.waitRun(run, (r) => r.stage === "design" && r.stage_state === "review", "the design review");
      const gate = one<{ id: string; spec_digest: string }>(e, "SELECT id, spec_digest FROM gates WHERE run_id = ?1 AND state = 'open'", run)!;

      const specPath = join(f.h.dataDir, task, "design", "spec.md");
      writeFileSync(specPath, readFileSync(specPath, "utf8").replace("One table.", "Two tables."));
      queueAnnotation(e, "Use two tables, not one.");
      writeFileSync(join(f.h.dataDir, task, "spec-revised"), "");
      const [, reply] = await e.replies(task, 2);
      expect(reply!.args.join(" ")).toStartWith("review reply");
      expect(reply!.reply.data).toMatchObject({ gate: gate.id, page: "refused" });
      expect(reply!.reply.data).not.toHaveProperty("repinned");
      expect(one<{ spec_digest: string; spec_text: string }>(e, "SELECT spec_digest, spec_text FROM gates WHERE id = ?1", gate.id)).toMatchObject({ spec_digest: gate.spec_digest, spec_text: expect.stringContaining("One table.") });
      const refused = await e.approve(task, { gate: "design" });
      expect(refused.ok).toBe(false);
      expect(refused.error).toMatchObject({ code: "design_changed" });
    },
    { timeout: 150_000 },
  );
});
