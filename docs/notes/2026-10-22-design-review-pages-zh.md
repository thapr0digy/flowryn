# Design review pages a human engineer can read and judge

- Status: done

The user found design pages hard to judge: code names before the idea, undefined internal terms, event counts in place of a problem statement, and the file table as the core of the page. Design pages now follow one fixed outline in plain words, and `stage done` checks it in plain code. No model judges readability: the check proves the shape, and the reviewer judges the writing.

## The design-page standard

The flowryn-design skill ships `design-template.html` beside its SKILL.md (`DESIGN_TEMPLATE` in `src/skills/design-template.ts`). The worker copies it to `$FLOWRYN_REPORT_DIR/design/design.html` and fills every `{{SLOT}}`. The parts, in order, each a `<section data-section="…">`:

1. `tldr` "In short": the problem and the change, at most 80 words (`DESIGN_TLDR_WORDS_MAX`, its heading aside).
2. `ask` "What I need from you": approve or send changes, and the two or three calls worth a look. With questions for the user, the question widget mounts here.
3. `change` "What changes for you": before and after, as the user would notice it.
4. `goals` "Goals and non-goals".
5. `how` "How it works": a `<figure>` (inline SVG, an image or a drawn `<pre>`), then a few steps in words.
6. `alternatives` "Other ways we could do it", doing nothing included.
7. `risks` "Risks, and how we'd know it's wrong".
8. `<details data-section="detail">`, folded and last: files, APIs, data and identifiers, the assumptions the build must test, every choice and why, sources, and what could not be checked.

The outline comes from Google design docs (context, goals and non-goals, alternatives considered, no pasted code), the Rust RFC template (one-paragraph summary, guide-level before reference-level, drawbacks, rationale and alternatives), PEP 12 (rejected ideas, open issues), Oxide RFD 1, Squarespace's "Yes, if" RFCs (the reviewer's ask up front), Nygard's ADRs (consequences, negative ones included), Gergely Orosz's survey of RFC templates, Will Larson ("start from the problem", minimal templates), Diátaxis (reference apart from explanation) and the US Federal Plain Language Guidelines. The design page under `~/.flowryn/data/design-review-pages-zh/design/` lists the links; it is also the passing fixture `fixtures/design-page/good.html`.

## The check

`stage done` on a review-gated stage whose skill is `flowryn-design` reads the page the review names (`checkDesignPage` in `src/lifecycle/stages.ts`, after the review URL check has resolved it to a regular `.html` file under the report directory) and refuses with `design_page_invalid` (exit 3), one fixable line per problem (`designPageProblems`):

- a template slot is left;
- a part is missing, empty or out of order, or anything but the title and a subtitle comes before the summary (each part runs to its own `</section>`, so a nested section such as the widget does not cut it short);
- the summary is over 80 words;
- more than 500 words (`DESIGN_VISIBLE_WORDS_MAX`) show before anything is unfolded: text outside `<details>`, `<svg>`, `<style>`, `<script>` and comments;
- "How it works" has no `<figure>`;
- the detail is not a closed `<details data-section="detail">` after every part, with nothing a reader sees after it (text or a content element such as an image or table; scripts, styles, comments, closing tags and empty wrappers are fine);
- a code-shaped word shows above the fold (SVG labels included): an inner underscore, a lowercase start with a capital inside, a path with a file extension (or a bare file name with a code extension), a leading `--`, a trailing `()`. Product names such as macOS and iPhone are allowed (`MIXED_CASE_NAMES` in `src/skills/review-page.ts`), and so is any term the page defines with `<dfn>`; `<kbd>` marks what the user types and is not checked. Up to 10 are named;
- a `<code>` or `<pre>` element shows above the fold outside the figure;
- with `--questions-file`, the widget is not inside "What I need from you".

Plain-English jargon ("digest", "follow-up batch") has no shape to catch. The skill forbids undefined internal terms, and the reviewer judges them.

A design run already in flight when this lands is checked at its next hand-in; the refusal names the template, which the daemon writes beside the skill when it starts.

## QA pages, the style, the widget and the leader

- QA evidence pages keep their card (`src/skills/qa-template.ts`) and gain the same plain-language rule in the card (code-shaped words and `<code>` refused unless defined) and a 200-word card budget (`QA_CARD_WORDS_MAX`). The folded sections are not checked.
- The worker contract's terse line now reads "Be terse in replies, reports and status: outcomes only, no recaps." followed by "Review pages are for a human reader: write them by your stage skill's page rules, not tersely." `STYLE_BLOCK` is unchanged, so the leader prompt and its cache are too.
- The question widget's copy is plainer: "Questions for you", what to do in one sentence, and the gate id on its own line.
- The leader skill asks the same of any page the leader writes for the user: lead with the ask, plain words, detail folded. Guidance only: there is no hand-in point to check it at.

## Choices

- **The page the review names, not a fixed path.** The design said the check would read `design/design.html` as the QA check reads `qa/evidence.html`. The review URL check already resolves the page (with or without `--page`), so the design check reads that one: same guarantee, and a worker that hosts its page elsewhere under the report directory is still checked.
- **Mixed case means a lowercase start.** "GitHub" and "JavaScript" are product names, and "awayWakeSql" and "p0Candidate" are code; a capital after a lowercase start catches the second kind without a long allow-list.
- **500 visible words.** About two minutes at 250 words a minute; the design pages before this ran 544 to 899.
- **No `CONTRACT_REVISIONS` bump.** The contract suite (`src/contracts/suite.ts`) has no step about the style lines or review pages, and the offline contract test passes unchanged.

## Tests

- `test/unit/design-template.test.ts`: the template's shape, a filled template and the fixture pass, the bare template fails on its slots, a page shaped like the old ones fails on outline, budget and code names, and each rule fails on its own.
- `test/unit/review-page.test.ts`: what counts as visible, the word count, and each code shape, with the allow-list, `<kbd>` and `<dfn>`.
- `test/unit/qa-template.test.ts`: the card's code-name rule and budget.
- `test/integration/gate-questions.test.ts`: through the real CLI, a design-stage hand-in with an old-style page is refused with `design_page_invalid` and the filled template opens the review.
- The fake worker writes a filled design page for any missing review page (`test/helpers/design-page.ts`), and the tests that write their own design pages use it.
