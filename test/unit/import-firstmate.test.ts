import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mapMode, parseItems, parseProjects, projectOf, selectDecisions } from "../../src/import/firstmate.ts";
import { REPO_ROOT } from "../helpers/harness.ts";

const DATA = join(REPO_ROOT, "fixtures/firstmate-home/data");
const read = (f: string) => readFileSync(join(DATA, f), "utf8");

describe("the Firstmate home", () => {
  test("projects: name, mode, yolo; prose ignored", () => {
    expect(parseProjects(read("projects.md"))).toEqual([
      { name: "corp", mode: "local-only", yolo: false, description: "Internal tool on the corporate network (added 2026-08-17)" },
      { name: "alpha", mode: "no-mistakes-prod-only", yolo: true, description: "Alpha service (added 2026-09-06)" },
      { name: "beta", mode: "direct-PR", yolo: false, description: "Beta library (added 2026-09-10)" },
    ]);
    expect(mapMode("no-mistakes-prod-only")).toBe("no-mistakes");
  });

  test("items: sections, tags, bare blocked-by, body lines, archive dates", () => {
    const backlog = parseItems(read("backlog.md"));
    expect(backlog.map((i) => [i.id, i.section, i.checked])).toEqual([
      ["fm-lock-fix", "in flight", false],
      ["alpha-amend-q1", "queued", false],
      ["beta-docs-z2", "queued", false],
      ["corp-cleanup-q1", "queued", false],
      ["beta-release-q3", "queued", false],
      ["alpha-arch-r2-decision-approval", "done", true],
    ]);
    expect(backlog[2]!.tags).toMatchObject({ repo: "beta", kind: "ship", priority: "3", "blocked-by": "alpha-amend-q1" });
    expect(backlog[2]!.title).toBe("Document the API");
    const archive = parseItems(read("note-archive.md"));
    expect(archive[0]).toMatchObject({ id: "alpha-arch-r1-decision-approval", archived: "2026-09-08", body: expect.arrayContaining(["Origin: alpha-arch-r1", "Decision key: approval"]) });
  });

  test("repo values map to project ids", () => {
    const projects = new Set(["alpha", "beta"]);
    expect(projectOf("thapr0digy/alpha", projects)).toBe("alpha");
    expect(projectOf("alpha", projects)).toBe("alpha");
    expect(projectOf("firstmate", projects)).toBeNull();
  });

  test("decisions: keyed captain items only; resolved and superseded skipped; the rest for review", () => {
    const projects = new Set(["alpha", "beta"]);
    const { decisions, skipped, review } = selectDecisions(parseItems(read("backlog.md")), parseItems(read("note-archive.md")), projects);
    expect(decisions).toEqual([
      { id: "alpha-arch-r2-decision-retention", project: "alpha", origin: "alpha-arch-r2", key: "retention", question: "Confirm 365-day retention and accept the loss of re-verification", context: "retention trade-off", archived: "2026-09-20" },
    ]);
    expect(skipped).toEqual(
      expect.arrayContaining([
        { id: "alpha-arch-r1-decision-approval", reason: "resolved (alpha-arch-r2-decision-approval is done)" },
        { id: "alpha-arch-r1-decision-retention", reason: "superseded by alpha-arch-r2-decision-retention" },
        { id: "fm-procevent-x", reason: "repo firstmate is not imported" },
      ]),
    );
    expect(review).toEqual(
      expect.arrayContaining([
        { id: "alpha-design-decisions", reason: "a captain item with no Decision key" },
        { id: "alpha-p0-scope", reason: "a held ship, not a decision" },
      ]),
    );
  });
});
