/**
 * The design stage's gap check (docs/notes/2026-11-18-design-stage-runs-ed.md):
 * before a design goes to review, its worker cross-checks its own page and
 * spec against their sources, the code, the user's decisions and the named
 * reference product, and records the numbered findings in the page's folded
 * "Gaps checked" part. Written next to the flowryn-design SKILL.md as
 * design-gap-check.md, harness-neutral, so Claude and Pi workers read the same
 * file. `stage done` checks the part's shape (design-template.ts); the
 * findings themselves are the worker's judgement.
 */

export const DESIGN_GAP_CHECK_FILE = "design-gap-check.md";

/**
 * The checks every gap check runs, in order; the page's gaps part names each one.
 * "Simplest secure option" runs first: an overcomplicated design wastes every later check.
 */
export const DESIGN_GAP_CHECKS = [
  { name: "Simplest secure option", ask: "Is there a simpler design that is still security conscious? Name every new piece of infrastructure, key, credential, service, setting or cross-repo change the design adds, and for each say why a simpler secure path (e.g. trust-on-first-use with pinned keys, reusing an existing table or flow) is not enough. If it is enough, the finding is 'simplify'. Write 'none' only when the design adds none of these: any finding here keeps the review the user's on a project whose gates pass on evidence." },
  { name: "Source fidelity", ask: "Does each screen or step show what the task and spec promise? Anything promised but missing, or shown but never asked for?" },
  { name: "Decisions honoured", ask: "Does it match every user decision so far (placement, naming, approvals, scope), including ones carried in the task file?" },
  { name: "Code truth", ask: "Is each capability it relies on real (open the code)? Does it ignore something that already exists? Does help text or a reference card omit supported syntax or options?" },
  { name: "Stale data", ask: "Do counts, examples or states predate a change that has landed or is landing?" },
  { name: "Unknown and failure states", ask: "Empty, loading, error, partial data, source not connected, permission denied, over budget. Does \"not read\" ever look like pass or fail? Does absence on an unread source read as cannot tell?" },
  { name: "Lifecycle completeness", ask: "Create, edit, test or preview, enable, disable, retire, history, audit, undo: which step has no screen or path?" },
  { name: "Exceptions and ownership", ask: "Can a person accept or except a result? Who owns it, who is notified, where does work route (team, ticket)?" },
  { name: "Where results surface", ask: "Are results visible where people already work (the resource's own page, the queue, reports), not only on the new page?" },
  { name: "Reference parity", ask: "Against the comparable product the task or user names: what does it do here that this lacks, and which are worth having? Name what to deliberately not copy." },
  { name: "Reuse and fit", ask: "Does it reuse existing components, tables and libraries (a requirement library, an approval flow), or invent a parallel one?" },
  { name: "Security and abuse", ask: "Who can do each action; can a person hide, widen or flood; are inputs bounded; can a model do something reserved for a person?" },
  { name: "Getting started", ask: "Can a first-time user start without reading docs: examples, templates, duplicate from existing, import and export?" },
  { name: "Layout and accessibility", ask: "Phone width, both themes, contrast, keyboard, long values, wrapping." },
] as const;

/** The verdicts a gaps part may give; the last sends the design back to you before review. */
export const DESIGN_GAP_VERDICTS = ["ready", "ready with the fixes below", "needs another design pass"] as const;

export const DESIGN_GAP_REVISE_VERDICT = DESIGN_GAP_VERDICTS[2];

const checksTable = DESIGN_GAP_CHECKS.map((c, i) => `| ${i + 1} | ${c.name} | ${c.ask} |`).join("\n");

export const DESIGN_GAP_CHECK = `# Design gap check

Run this on your own design page and spec after they are written and before you host the page. Reading your own screens finds polish; the gaps that matter come from cross-checking the design against its source, the system it will be built in, and the product it is compared with. Record the result in the page's folded "Gaps checked" part; \`stage done\` refuses a page without it.

## Gather first

1. Your page and spec, read whole as a reviewer would, and every mockup the task, spec or project docs name, read whole (not skimmed).
2. The user's own words in the task file, and every decision carried with it (review answers, recorded choices, the scout or report it came from). A design that contradicts a later decision is a finding.
3. The code the design builds on: open each module it names and confirm each claim it leans on (a grammar, a table, a capability). Search for capabilities it says are missing, and for ones it forgot exist.
4. Work landed or in flight that changes its data or assumptions: \`git log origin/main\` since your base, the project's backlog, other plans and migrations.

## The checks (run every one; write "none" when clean)

Check 1 runs first: an overcomplicated design wastes every later check.

| # | Check | Ask |
|---|---|---|
${checksTable}

## Record it on the page

In \`<details data-section="gaps">\` (folded, between the risks part and the implementation detail):

1. The verdict line: \`Verdict: ${DESIGN_GAP_VERDICTS.join("` or `Verdict: ")}\`.
2. A table of all ${DESIGN_GAP_CHECKS.length} checks by number and name, each with "none" or the numbers of its findings.
3. The findings, numbered continuously so the user can answer by number, grouped as Issues (wrong or contradictory), Gaps (missing) and Improvements (worth adding). Each: what it is; its evidence (file and line, mockup, decision, the reference product's page); the fix and which phase; and what it changed (the page part, spec section or plan phase you folded it into, or why you did not). A finding without evidence is a guess and says so.
4. "Not copying:" the reference product's features you deliberately left out, and why.

## Then

- Fold every accepted finding into the page, the spec or the plan phase it belongs to before \`stage done\`. One you cannot settle without the user becomes a question in questions.json, not a note.
- A finding that changes the design substantially means revise the design first, then check again. \`stage done\` refuses the verdict "${DESIGN_GAP_REVISE_VERDICT}".
- Specific gaps only: no generic advice (add tooltips). Take nothing the design says about the system on trust: open the code.
`;
