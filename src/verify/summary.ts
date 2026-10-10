/**
 * The test counts in bun test's closing summary:
 *
 *    1843 pass
 *    4 skip
 *    0 fail
 *   5012 expect() calls
 *   Ran 1847 tests across 131 files. [212.40s]
 *
 * The last occurrence of each line wins, so test output that happens to
 * print a similar line earlier does not count.
 */

export interface TestCounts {
  pass: number;
  fail: number;
  skip: number;
  todo: number;
  /** "Ran N tests": null when the summary has no Ran line. */
  tests: number | null;
  files: number | null;
}

export function parseBunSummary(output: string): TestCounts | null {
  const counts: Record<"pass" | "fail" | "skip" | "todo", number | null> = { pass: null, fail: null, skip: null, todo: null };
  for (const match of output.matchAll(/^\s*(\d+) (pass|fail|skip|todo)\s*$/gm)) counts[match[2] as keyof typeof counts] = Number(match[1]);
  const ran = [...output.matchAll(/^Ran (\d+) tests? across (\d+) files?\./gm)].at(-1);
  if (counts.pass === null && counts.fail === null && !ran) return null;
  return {
    pass: counts.pass ?? 0,
    fail: counts.fail ?? 0,
    skip: counts.skip ?? 0,
    todo: counts.todo ?? 0,
    tests: ran ? Number(ran[1]) : null,
    files: ran ? Number(ran[2]) : null,
  };
}

/** "1843 pass · 0 fail · 4 skip · 131 files", for the progress line and `show`. */
export function countsLine(counts: TestCounts): string {
  const parts = [`${counts.pass} pass`, `${counts.fail} fail`];
  if (counts.skip > 0) parts.push(`${counts.skip} skip`);
  if (counts.todo > 0) parts.push(`${counts.todo} todo`);
  if (counts.files !== null) parts.push(`${counts.files} file${counts.files === 1 ? "" : "s"}`);
  return parts.join(" · ");
}
