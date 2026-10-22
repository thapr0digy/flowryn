# Design review pages a human engineer can read and judge

- Status: not built
- Open: the build (design approved first); the standard below is the design under review

The user found design pages hard to judge: code names before the idea, undefined internal terms, event counts in place of a problem statement, and the file table as the core of the page. This feature gives design pages one fixed outline in plain words and has `stage done` check it in plain code. No model judges readability.

## The design-page standard

A design page is the skill's template (`design-template.html`, beside the flowryn-design SKILL.md) filled in at `$FLOWRYN_REPORT_DIR/design/design.html`. Its parts, in order, each a `<section data-section="…">`:

1. `tldr` "In short": two to four plain sentences, at most 80 words.
2. `ask` "What I need from you": approve or send changes, the calls worth a look; the question widget mounts here.
3. `change` "What changes for you": before and after.
4. `goals` "Goals and non-goals".
5. `how` "How it works": holds a `<figure>` (a diagram).
6. `alternatives` "Other ways we could do it", doing nothing included.
7. `risks` "Risks, and how we'd know it's wrong".
8. `<details data-section="detail">`, folded and last: files, identifiers, the rules, tests, the assumptions the build tests, every choice and why, sources, what could not be checked.

Rules the check enforces, refusing `stage done` with `design_page_invalid` and one fixable line per problem:

- no template placeholder left; the seven parts present, with words, in order; the detail folded and last;
- at most 500 words outside `<details>`, `<svg>`, `<style>`, `<script>` and comments;
- no code-shaped term above the fold (inner underscore, lower-then-upper case outside a short allow-list, a path with a file extension, a leading `--`, a trailing `()`), and no `<code>` or `<pre>` outside the figure, unless the page defines the term with `<dfn>`; `<kbd>` marks what the user types.

Plain-English jargon has no shape to catch: the skill forbids undefined internal terms and the reviewer judges.

QA evidence pages keep their card and gain the code-name rule and a 200-word card budget. The worker contract's terse line now covers replies, reports and status, not review pages. The question widget's copy gets plainer, and the leader skill asks the same of pages the leader writes for the user (guidance only).

## Research

The outline draws on Google design docs (context, goals and non-goals, alternatives considered, no pasted code), the Rust RFC template (summary, guide-level before reference-level, drawbacks, rationale and alternatives), PEP 12 (rejected ideas, open issues), Oxide RFD 1, Squarespace's "Yes, if" RFCs (the reviewer's ask up front), Nygard's ADRs (consequences, negative ones included), Gergely Orosz's survey of RFC templates, Will Larson ("start from the problem", minimal templates), Diátaxis (reference apart from explanation) and the US Federal Plain Language Guidelines. The design page lists the links.

## Open questions

None for the user. Choices made, each open to change at review:

- Visible budget 500 words (about two minutes; existing pages run 544 to 899). Recommendation: keep.
- "What I need from you" second, after the summary. Recommendation: keep (the user's decision-first preference).
- Design runs already in flight are checked at their next hand-in. Recommendation: keep; the refusal names the template.
- `CONTRACT_REVISIONS` not bumped: the contract suite has no step about style or review pages. The build confirms it.
