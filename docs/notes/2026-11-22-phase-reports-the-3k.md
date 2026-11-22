# Scout reports the leader reads in a minute

- Status: done

Plan p104, proposal 8. Scout reports had grown to 40 KB, and the leader had to read the whole file to find the answer. Now `deliver --report` refuses a report that does not put its answer first. Lauren Tan's worker rule caps a PR body at 40 lines and moves the evidence elsewhere; this is the same idea for reports.

## The two rules

`reportProblems` (`src/lifecycle/brief.ts`) checks the stored copy of the report. It is a plain parser with no model:

- **Short answer.** A `## Short answer` section (no other heading counts) of at most 15 non-blank lines. It must not be empty or a template slot. A report of 15 non-blank lines or fewer needs no heading, because the whole report is already the short answer.
- **First screen.** The first screen is everything from the top of the file to the second `## ` section after the short answer. In the template that is the title, the short answer and the proposals table. It must be 6 KB (6144 UTF-8 bytes) or less. Anything below it, such as an evidence section, is free, and so is anything in a linked file. A short answer buried under evidence fails this rule, because the first screen then runs from the top down past the evidence.

A refusal is `invalid_report` (exit 3), the same code as every other report refusal. The message names each rule the report breaks, and the hint is `$FLOWRYN_BIN template report`. On refusal the stored copy at `<data_dir>/<task>/report.md` is removed, so promote and follow-on context never carry a refused report; the run stays running and the worker delivers again. Headings inside fenced code blocks are text, as in briefs.

## Template and contract

`flowryn template report` prints the shape: `## Short answer`, an optional `## Proposals` table, and `## Evidence` with one relative link per detail file under `$FLOWRYN_REPORT_DIR`. A scout's contract "Finished" lines (`deliveryLines`, `src/harness/contract-text.ts`) now point to the template and state both limits. The scout workflow's one stage (`investigate`) has no stage skill, so these lines are the scout stage template that every scout sees.

## Choices

- The error code is `invalid_report`, not the `bad_args` the brief named, because every other report refusal (size, symlink, outside the worktree) already uses it.
- Short reports are exempt. The contract suite's one-line `contract ok` report and the fake harness's one-line reports still deliver, so no contract revision bump was needed. The fake harness's `deliver-decisions` report now opens with a `## Short answer`, so it stays deliverable once a decision spec pushes it past 15 lines (four decisions, or three with `Reserved` lines); its three-decision report sat at 14. The live lab scouts (`scripts/lab/m2-live.ts`, `scripts/lab/v1-live.ts`) put their 30-plus-line `ls src` listing under a one-line short answer.
- The brief's own model report (scout how-lauren-tan-rx) has a 6.1 KB first screen and would be refused by 0.1 KB. The 6 KB limit was kept, because its nine-row proposals table can lose a few words.

## Tests

- `test/unit/brief.test.ts` "reportProblems" checks:
  - both limits at the boundary;
  - the short-report exemption;
  - empty and placeholder short answers;
  - the assumption tests (evidence below the first screen is free, a buried short answer fails, bytes are UTF-8, fenced headings are text).
- `test/integration/workers.test.ts` checks a scout's 17-line report with no short answer through the real deliver: it is refused with `invalid_report`, then the same evidence under a short answer delivers and lands.
