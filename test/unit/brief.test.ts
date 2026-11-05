import { describe, expect, test } from "bun:test";
import { DOC_SECTIONS, docProblems, parseSections, type DocKind } from "../../src/lifecycle/brief.ts";
import { DOC_TEMPLATES } from "../../src/lifecycle/brief-templates.ts";
import { checkHandoff } from "../../src/lifecycle/handoffs.ts";
import { FlowrynError } from "../../src/api/errors.ts";

/** A template with every {{slot}} replaced by words: what a filled brief looks like. */
function filled(kind: DocKind): string {
  return DOC_TEMPLATES[kind].replace(/\{\{[^}]*\}\}/g, "Written in full by the leader.");
}

const SHIP = filled("ship");

describe("the section parser", () => {
  test("splits on ## headings, in order, keeping bodies trimmed", () => {
    expect(parseSections("title\n\n## A\none\n\n## B ##\ntwo\n### sub\nthree")).toEqual([
      { heading: "A", body: "one" },
      { heading: "B", body: "two\n### sub\nthree" },
    ]);
  });

  test("a heading inside a fenced code block is text, not a section", () => {
    const sections = parseSections("## Context\n```md\n## Intent\nfake\n```\nreal");
    expect(sections.map((s) => s.heading)).toEqual(["Context"]);
    expect(sections[0]!.body).toContain("## Intent");
  });
});

describe("docProblems", () => {
  for (const kind of Object.keys(DOC_TEMPLATES) as DocKind[]) {
    test(`the ${kind} template, filled, passes; unfilled, every slot is named`, () => {
      expect(docProblems(kind, filled(kind))).toEqual([]);
      const problems = docProblems(kind, DOC_TEMPLATES[kind]);
      expect(problems.length).toBe(DOC_SECTIONS[kind].length + (kind === "ship" ? 1 : 0));
      expect(problems.every((p) => p.includes("placeholder"))).toBe(true);
    });
  }

  test("a free-text ship body lists every missing section in one line", () => {
    expect(docProblems("ship", "Fix the login bug. Read report.md section 4.")).toEqual(["missing sections: ## Intent, ## Context, ## Requirements, ## Constraints, ## Security, ## Out of scope, ## Verification"]);
  });

  test("headings match case-insensitively and by alias; order is free", () => {
    const md = SHIP.replace("## Intent", "## USER'S INTENT").replace("## Security", "## Security bar");
    expect(docProblems("ship", md)).toEqual([]);
  });

  test("an empty section, a TODO and a bare None are refused; None with a reason passes where allowed", () => {
    expect(docProblems("ship", SHIP.replace(/## Requirements\n[^\n]*/, "## Requirements\n"))).toEqual(['section "Requirements" is empty']);
    expect(docProblems("ship", SHIP.replace(/## Verification\n[^\n]*/, "## Verification\nTBD"))).toEqual(['section "Verification" says only "TBD"; write it']);
    expect(docProblems("ship", SHIP.replace(/## Security\n[^\n]*/, "## Security\nNone."))).toEqual(['section "Security" says none: say why ("None: <reason>")']);
    expect(docProblems("ship", SHIP.replace(/## Security\n[^\n]*/, "## Security\nNone: a docs-only change."))).toEqual([]);
    expect(docProblems("ship", SHIP.replace(/## Context\n[^\n]*/, "## Context\nNone: nothing."))).toEqual(['section "Context" cannot be none']);
  });

  test("an optional section left as a placeholder is refused too", () => {
    expect(docProblems("ship", SHIP.replace(/## Spec\n[^\n]*/, "## Spec\n{{the leader's build instructions}}"))).toEqual(['section "Spec" still holds a template placeholder: fill it or drop the section']);
  });

  test("a scout brief needs its lighter set only", () => {
    expect(docProblems("scout", "## Intent\nx y\n## Context\nz\n## Questions\n1. why\n## Out of scope\nNone: read only")).toEqual([]);
    expect(docProblems("scout", "## Intent\nx")).toEqual(["missing sections: ## Context, ## Questions, ## Out of scope"]);
  });
});

describe("handoffs", () => {
  test("None. is a valid handoff section; a missing one is refused with every problem", () => {
    expect(checkHandoff("## Done\nBuilt it.\n## Deviations\nNone.\n## Risks\nNone.")).toContain("Built it.");
    try {
      checkHandoff("## Done\nBuilt it.");
      throw new Error("accepted");
    } catch (error) {
      expect((error as FlowrynError).code).toBe("handoff_invalid");
      expect((error as Error).message).toContain("## Deviations, ## Risks");
    }
  });

  test("an oversized or empty handoff is refused", () => {
    expect(() => checkHandoff("")).toThrow(/empty/);
    expect(() => checkHandoff(`## Done\n${"x".repeat(9000)}\n## Deviations\nNone.\n## Risks\nNone.`)).toThrow(/keep it to/);
  });
});
