# Visual QA checks the build against DESIGN.md and the approved design

- Status: done
- Open: not yet run by a real QA stage against appsec-signal (it has no DESIGN.md yet, so its first run checks against the design page and mockups)

The `flowryn-visual-qa` skill (the `feature-ui` workflow's `qa` stage) used to walk the flows the design names, screenshot them and keep console and network errors. It compared nothing with a design. It now does, without a second skill and without changing the workflows, pools or the review gate.

## What the QA worker does

The skill body (`src/skills/stages.ts`, `QA_BODY`) holds the ordered steps; the method behind them is `qa-method.md` (`src/skills/qa-method.ts`), written next to SKILL.md like the evidence template, so the body stays within its 1.5k-token budget.

0. **References and the checklist.** It reads `DESIGN.md` (repo root, else `docs/DESIGN.md`), the approved design page the task file's carried context names, and any mockups that page, the spec or the project docs name. It writes `$FLOWRYN_REPORT_DIR/qa/checklist.md`: numbered, testable expectations, each ending `(source: …)`, and `qa/tokens.json` from DESIGN.md's tokens. With no DESIGN.md it says so on the page and uses the design page and mockups.
1. **Coverage matrix.** Each changed screen at 1440x900 (primary, covered first), 768x1024 and 390x844 (`emulate --viewport`, `resize`), light and dark when the app has both (`emulate --color-scheme`), and the states empty, loading (`--network "Slow 3G"`), error (`--network Offline` or a seeded failure), overflow, hover, focus and disabled where reachable, plus keyboard tab order and visible focus. Screenshots are `<screen>-<WxH>-<theme>-<state>.png` (`inbox-1440x900-light-default.png`).
2. **Measure.** At each cell it runs the probe, `chrome-devtools-axi eval "$(cat <skill dir>/qa-probe.js)"`, after setting `window.__flowrynTokens` from `tokens.json`.
3. **Judge.** Only what the probe cannot settle: each screen beside its mockup at the same size and theme, rated match, drift or mismatch with a reason. This is the only model judgement in the stage.
4. **Findings.** Each failed check: an id, a severity (blocker, major, minor, nit), the checklist item, viewport, theme and state, the screenshot, expected vs actual.
5. **Evidence page.** The plain-words card stays first; below it, four new folded parts: what it was checked against, the checklist's pass or fail table, findings by severity, and the coverage matrix (what was not exercised, and why).

A change with no frontend surface says "Nothing visible." and the reason in the card, and skips the checklist and the matrix.

## The probe

`src/skills/qa-probe.ts` builds `qa-probe.js`: one function expression that never throws (an error comes back as `{error}`). Plain code, no model. It returns one JSON object: page and element overflow past the viewport (outside scrolling containers), text clipped by an `overflow: hidden` box (with whether it ellipsizes), overlapping interactive elements, broken or unsized images, text below WCAG AA (4.5:1, 3:1 for 24px or 18.66px bold; text over a background image or gradient is "unknown", never a pass), images without alt, form fields without a label (placeholder-only is flagged), unnamed buttons and links, the focused element's outline and shadow, an inventory of colours, font families, sizes, weights, radii and padding/gap in use (counted per element, three example selectors each), and, with tokens set, every inventory value outside them. Lists stop at 50 entries with a `truncated` count; text comes back as 60-character snippets. It reads no cookies or storage and makes no requests (a unit test checks the source).

The helpers (colour parsing, blending, WCAG luminance and contrast, the large-text rule, the token comparison) are one JavaScript source that the probe embeds and the unit tests run (`probeHelpers()`), so the tests check the code the page runs. The DOM walk was run by hand against a test page in Chrome through chrome-devtools-axi at 390x844: it reported the overflow, clipping, overlap, broken image, 1.92:1 text, missing names and off-token values the page was built with. `bun test` cannot run it (no browser).

## What stage done checks

`qaPageProblems` (`src/skills/qa-template.ts`) and `checkQaPage` (`src/lifecycle/stages.ts`) add, all refused as `qa_page_invalid` with one line per problem:

- the four parts (`<details data-qa="references|conformance|findings|coverage">`) are present and have words (their own summary does not count);
- every `data-severity` is blocker, major, minor or nit (comments and styles are skipped);
- the verdict follows the worst finding: a blocker means broken; a major means works-with-caveats or broken; minors and nits leave it to the worker;
- unless the card's what-changed entry starts "Nothing visible.", `qa/checklist.md` exists as a regular file inside the report dir (no symlink, at most 256 KB) with at least one numbered item ending `(source: …)`.

The contract suite does not exercise the QA stage, so `CONTRACT_REVISIONS` is unchanged.
