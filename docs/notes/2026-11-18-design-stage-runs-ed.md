# Design stage runs a gap check before the review gate

- Status: done
- Open: not yet seen on a live design run

Every Flowryn design stage, Claude or Pi, any project, now checks its own design for gaps before it reaches the user, the way the leader reviewed the custom-rules mockups (ten real gaps found by cross-checking the mockups against their report, the user's decisions, the code and the named reference product).

## What the worker does

The flowryn-design skill gains step 5, before hosting the page: run `design-gap-check.md` (written next to the skill's SKILL.md, so any harness reads it) on the page, the spec and the plan. The file holds the checklist the leader's user skill uses, adapted to the stage:

- gather the page, spec and named mockups read whole, the user's words and carried decisions from the task file, the code the design builds on (verify every capability claim; look for ones it forgot), and landed or in-flight work that changes its data;
- run 13 checks, writing "none" when clean: source fidelity, decisions honoured, code truth, stale data, unknown and failure states, lifecycle completeness, exceptions and ownership, where results surface, reference parity, reuse and fit, security and abuse, getting started, layout and accessibility;
- fold each accepted finding into the page, spec or plan phase; a finding only the user can settle becomes a question in `questions.json`; a substantial one means revise and check again.

## What `stage done` checks

The design template has a new folded part, `<details data-section="gaps">` ("Gaps checked"), between the risks part and the implementation detail, filled from the `{{GAPS}}` slot. `stage done` in a design stage (`design_page_invalid`) refuses a page when the part:

- is missing, starts open, or sits outside its place;
- is empty;
- has no verdict line: `Verdict: ready`, `Verdict: ready with the fixes below` or `Verdict: needs another design pass`;
- says `needs another design pass` (revise first; the page is not ready for review);
- does not name every one of the 13 checks (a clean check still lists them, each "none").

The findings' quality (evidence, what each changed) is the worker's judgement and the reviewer's to judge; the check proves only the shape, like the rest of the design page check. Plain code, no model.

## Choices

- One list of checks, `DESIGN_GAP_CHECKS` in `src/skills/design-gap-check.ts`, renders the file's table and drives the page check, so the two cannot drift.
- The checklist is a file next to the skill (as `qa-method.md` is for QA), not inline: the design skill body stays within its budget. The body's size limit in `test/unit/prompts-that-keep.test.ts` moved from 3,900 to 4,200 characters for the new step.
- The gaps part is folded and its summary is two words, so it costs the visible 500-word budget almost nothing.
- The leader's user skill (`~/.claude/skills/design-gap-check`) stays for scouts' mockups and the leader's own reviews; the stage file does not depend on it.
- `CONTRACT_REVISIONS` is unchanged: the contract suite does not exercise design pages.

## Tests

`test/unit/design-template.test.ts` (missing, empty, unfolded, misplaced, no verdict, revise verdict, skipped checks; a clean check and one with findings pass; the file ships beside the skill and the step comes before hosting), `test/unit/workflows.test.ts` (the file is written beside the design SKILL.md and in the Claude plugin), `test/unit/prompts-that-keep.test.ts` (budget). `test/helpers/design-page.ts` fills a clean gap check, so every integration test's fake design page passes.
