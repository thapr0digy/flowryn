import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DOC_TEMPLATES } from "../../src/lifecycle/brief-templates.ts";
import { filledDesignPage } from "../helpers/design-page.ts";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";

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
      const drifted = await e.approve(task, { gate: "design" });
      expect(drifted.ok).toBe(false);
      expect(drifted.error).toMatchObject({ code: "design_changed" });
      const db = f.h.db();
      try {
        // What the worker's review reply does: pin what the page and spec show now (src/lifecycle/design-spec.ts).
        const { repinDesign } = await import("../../src/lifecycle/design-spec.ts");
        const pinned = db.query("SELECT id, run_id, page_path, spec_path, spec_digest, page_digest FROM gates WHERE id = ?1").get(gate.id) as never;
        expect(repinDesign(db, pinned, join(f.h.dataDir, task), task, Date.now())).toBe(true);
      } finally {
        db.close();
      }
      expect((await e.approve(task, { gate: "design" })).ok).toBe(true);

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
});
