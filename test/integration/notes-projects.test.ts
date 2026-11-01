import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeShipEnv, type ShipEnv } from "../helpers/ship-env.ts";
import { sh } from "../helpers/scratch-git.ts";

/**
 * Notes projects (docs/notes/2026-10-30-notes-projects-non-8d.md), end to
 * end on the fake Herdr and a fake worker, in a repository with no remote:
 * the draft workflow renders the file as the review page, the approval binds
 * to its bytes, and the final stage lands exactly those bytes on local main.
 */

let ship: ShipEnv | null = null;

afterEach(async () => {
  await ship?.cleanup();
  ship = null;
});

function one<T>(e: ShipEnv, sql: string, ...params: string[]): T | null {
  const db = e.fleet.h.db();
  try {
    return (db.query(sql).get(...params) as T | null) ?? null;
  } finally {
    db.close();
  }
}

const PAGE = "$FLOWRYN_REPORT_DIR/draft/draft.html";

describe("notes projects", () => {
  test(
    "a draft in a repository with no remote: rendered, reviewed, then landed on local main exactly as approved",
    async () => {
      ship = await makeShipEnv({ origin: false, mode: "local-only" });
      const e = ship;
      const f = e.fleet;
      const project = one<{ path: string; repo_url: string }>(e, "SELECT path, repo_url FROM projects WHERE id = 'web'")!;
      expect(project.repo_url).toBe("");
      expect(sh(project.path, ["remote"])).toBe("");
      const kind = await f.json(["project", "set", "web", "--kind", "notes"]);
      expect(kind.code).toBe(0);
      expect(kind.reply.data).toMatchObject({ project: { kind: "notes", workflow: "draft" } });

      const steps = [
        "A plan for Q4",
        "FAKE: scratch q4.md Ship the notes kind.",
        "FAKE: verb draft render q4.md",
        // Edited after rendering: the page no longer shows the file, so stage done refuses it.
        "FAKE: scratch q4.md Ship the notes kind, and more.",
        `FAKE: stage-done --review lavish:draft/draft.html --page ${PAGE}`,
        "FAKE: verb draft render q4.md",
        `FAKE: stage-done --review lavish:draft/draft.html --page ${PAGE}`,
        // Final: a different file is refused; the approved bytes deliver.
        "FAKE: commit q4.md Something else entirely.",
        "FAKE: deliver-local",
        "FAKE: commit q4.md Ship the notes kind, and more.",
        // Another file on the branch is refused too: only the approved draft lands.
        "FAKE: commit other.md Nobody reviewed this.",
        "FAKE: deliver-local",
        "FAKE: uncommit other.md",
        // Main moved on while the draft was reviewed; the branch rebased onto it still delivers only the draft.
        "FAKE: rebase main",
        "FAKE: deliver-local",
        "FAKE: sleep 120000",
      ].join("\n");
      const { task, run } = await f.dispatch(steps, { kind: "ship" });
      expect(f.run(run)).toMatchObject({ stage: "draft" });

      await f.waitRun(run, (r) => r.stage === "draft" && r.stage_state === "review", "the draft review");
      const replies = await e.replies(task, 4);
      expect(replies[0]!.reply.data).toMatchObject({ draft: "q4.md" });
      expect(replies[1]!.code).toBe(3);
      expect((replies[1]!.reply.error as { code: string }).code).toBe("draft_page_invalid");
      const gate = one<{ id: string; draft_path: string; draft_blob: string; page_path: string }>(e, "SELECT id, draft_path, draft_blob, page_path FROM gates WHERE run_id = ?1 AND kind = 'review' AND state = 'open'", run)!;
      expect(gate.draft_path).toBe("q4.md");
      expect(gate.page_path.endsWith("/draft/draft.html")).toBe(true);
      const page = readFileSync(gate.page_path, "utf8");
      expect(page).toContain("Ship the notes kind, and more.");
      expect(page).toContain(gate.draft_blob.slice(0, 12));

      // The page changed under the open review (by hand, or a render of other text): what the user sees is not what the gate keeps.
      writeFileSync(gate.page_path, page.replace("and more.", "and less."));
      const tampered = await e.approve(task, { gate: "draft" });
      expect(tampered.ok).toBe(false);
      expect((tampered as { error: { code: string } }).error.code).toBe("draft_changed");
      expect(one(e, "SELECT 1 FROM gates WHERE id = ?1 AND state = 'open'", gate.id)).not.toBeNull();
      writeFileSync(gate.page_path, page);

      writeFileSync(join(project.path, "landed.md"), "Another task landed meanwhile.\n");
      sh(project.path, ["add", "landed.md"]);
      sh(project.path, ["commit", "-q", "-m", "another task"]);

      expect((await e.approve(task, { gate: "draft" })).ok).toBe(true);
      await f.waitRun(run, (r) => r.state === "ready" && r.stage === "final" && r.stage_state === "done", "the delivery");
      const delivered = (await e.replies(task, 7)).filter((r) => r.args.includes("--local"));
      expect(delivered[0]!.code).toBe(2);
      expect((delivered[0]!.reply.error as { code: string }).code).toBe("draft_changed");
      expect(delivered[1]!.code).toBe(2);
      expect(delivered[1]!.reply.error as { code: string; message: string }).toMatchObject({ code: "draft_changed", message: expect.stringContaining("other.md") });
      expect(delivered[2]!.code).toBe(0);
      // Nothing is held for validation: a draft has nothing to test.
      expect(one(e, "SELECT 1 FROM pool_leases WHERE run_id = ?1 AND pool = 'validation'", run)).toBeNull();

      expect((await e.approve(task)).ok).toBe(true);
      expect((await f.json(["merge", task])).code).toBe(0);
      await f.waitRun(run, (r) => r.state === "cleaned", "cleaned", 30_000);
      expect(sh(project.path, ["show", "main:q4.md"])).toBe("Ship the notes kind, and more.");
      expect(sh(project.path, ["rev-parse", "main:q4.md"])).toBe(gate.draft_blob);
      expect(sh(project.path, ["ls-tree", "--name-only", "main", "other.md"])).toBe("");
      expect(sh(project.path, ["show", "main:landed.md"])).toBe("Another task landed meanwhile.");
    },
    { timeout: 150_000 },
  );
});
