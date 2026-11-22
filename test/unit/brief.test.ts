import { describe, expect, test } from "bun:test";
import { DOC_SECTIONS, docProblems, parseSections, REPORT_FIRST_SCREEN_BYTES_MAX, REPORT_SHORT_ANSWER_LINES_MAX, reportProblems, type DocKind } from "../../src/lifecycle/brief.ts";
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
      // A ship's optional ## Spec, a report's ## Proposals and ## Evidence: template slots too.
      const optional = { ship: 1, report: 2 }[kind as string] ?? 0;
      expect(problems.length).toBe(DOC_SECTIONS[kind].length + optional);
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

/** `n` non-blank lines of text. */
const lines = (n: number, word = "point") => Array.from({ length: n }, (_, i) => `- ${word} ${i + 1}`).join("\n");
/** A report whose first screen is `bytes` long once the tail after `## Evidence` is cut away. */
function reportWithFirstScreen(bytes: number, evidence = "see evidence.md"): string {
  const head = "# Cache\n\n## Short answer\nThe cache evicts too early.\n\n## Proposals\n";
  return `${head}${"x".repeat(bytes - head.length - 1)}\n## Evidence\n${evidence}\n`;
}

describe("reportProblems", () => {
  test("the report template, filled, passes", () => {
    expect(reportProblems(filled("report"))).toEqual([]);
  });

  test(`a short answer of ${REPORT_SHORT_ANSWER_LINES_MAX} non-blank lines passes; one more is refused naming the rule`, () => {
    expect(reportProblems(`## Short answer\n${lines(REPORT_SHORT_ANSWER_LINES_MAX)}\n\n\n## Evidence\n${lines(200)}`)).toEqual([]);
    expect(reportProblems(`## Short answer\n${lines(REPORT_SHORT_ANSWER_LINES_MAX + 1)}\n## Evidence\nfile.md`)).toEqual([
      `"## Short answer" is ${REPORT_SHORT_ANSWER_LINES_MAX + 1} lines: keep it to ${REPORT_SHORT_ANSWER_LINES_MAX} or fewer and move the rest to linked evidence files`,
    ]);
  });

  test("a report over 15 lines with no short answer is refused; a report of 15 lines or fewer is its own short answer", () => {
    expect(reportProblems(`# Cache\n${lines(REPORT_SHORT_ANSWER_LINES_MAX - 1)}`)).toEqual([]);
    expect(reportProblems("contract ok\n")).toEqual([]);
    expect(reportProblems(`# Cache\n${lines(REPORT_SHORT_ANSWER_LINES_MAX)}`)).toEqual([`no "## Short answer" section: a report over ${REPORT_SHORT_ANSWER_LINES_MAX} lines opens with one of at most ${REPORT_SHORT_ANSWER_LINES_MAX} lines`]);
  });

  test("an empty or placeholder short answer is refused", () => {
    expect(reportProblems(`## Short answer\n\n## Evidence\n${lines(20)}`)).toEqual(['section "Short answer" is empty']);
    expect(reportProblems("## Short answer\n{{At most 15 lines}}\n")).toEqual(['section "Short answer" still holds a template placeholder']);
  });

  test(`a first screen of exactly ${REPORT_FIRST_SCREEN_BYTES_MAX} bytes passes; one byte more is refused naming the rule`, () => {
    expect(reportProblems(reportWithFirstScreen(REPORT_FIRST_SCREEN_BYTES_MAX))).toEqual([]);
    expect(reportProblems(reportWithFirstScreen(REPORT_FIRST_SCREEN_BYTES_MAX + 1))).toEqual([
      'the first screen (the start through the section after "## Short answer") is 6145 bytes: keep it to 6144 (6 KB) and move evidence into linked files',
    ]);
  });

  test("assumption: the first screen ends where the second section after the short answer starts, so evidence below it is free", () => {
    expect(reportProblems(reportWithFirstScreen(REPORT_FIRST_SCREEN_BYTES_MAX, "y".repeat(500_000)))).toEqual([]);
  });

  test("assumption: the first screen starts at the top, so a short answer buried under evidence is refused", () => {
    const buried = `# Cache\n\n## Evidence\n${"y".repeat(REPORT_FIRST_SCREEN_BYTES_MAX)}\n\n## Short answer\nIt evicts early.\n`;
    expect(reportProblems(buried)[0]).toStartWith("the first screen");
  });

  test("assumption: bytes are UTF-8, not characters", () => {
    const head = "## Short answer\n";
    expect(reportProblems(`${head}${"é".repeat(REPORT_FIRST_SCREEN_BYTES_MAX / 2)}`)[0]).toStartWith("the first screen");
  });

  test("assumption: a short answer heading inside a fenced code block is text", () => {
    expect(reportProblems(`# Cache\n\`\`\`md\n## Short answer\nfake\n\`\`\`\n${lines(20)}`)[0]).toStartWith('no "## Short answer"');
  });

  test("a TL;DR or Summary heading counts as the short answer", () => {
    expect(reportProblems(`## TL;DR\nIt evicts early.\n## Evidence\n${lines(30)}`)).toEqual([]);
    expect(reportProblems(`## Summary\nIt evicts early.\n## Evidence\n${lines(30)}`)).toEqual([]);
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
