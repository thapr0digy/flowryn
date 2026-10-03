import { describe, expect, test } from "bun:test";
import { parseOpenDecisions } from "../../src/lifecycle/report-decisions.ts";

const REPORT = `# Findings

Body text.

## Open decisions

### deployment-profile: Profile A or Profile B first?
Options: a, b
Recommendation: a
Why it matters: decides which driver ships first.

### drop-bucket: Delete the old evidence bucket?
Options: yes, no
Why it matters: frees 2 TB.
Reserved: destroys client evidence

### not a valid heading
Some text.

## Appendix
Ignored.
`;

describe("open decisions in a report", () => {
  test("each ### entry is a decision; a malformed one keeps its raw text", () => {
    const found = parseOpenDecisions(REPORT);
    expect(found).toHaveLength(3);
    expect(found[0]).toMatchObject({ key: "deployment-profile", question: "Profile A or Profile B first?", options: ["a", "b"], recommendation: "a", context: "decides which driver ships first.", reserved: null, warning: null });
    expect(found[1]).toMatchObject({ key: "drop-bucket", reserved: "destroys client evidence" });
    expect(found[2]!.warning).toMatch(/heading/);
    expect(found[2]!.key).toMatch(/^entry-3$/);
    expect(found[2]!.question).toContain("not a valid heading");
  });

  test("no section, no decisions", () => {
    expect(parseOpenDecisions("# Report\nNothing open.")).toEqual([]);
  });
});
