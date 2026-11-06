/**
 * The QA evidence page's fixed template and its check. Every QA page opens
 * with one plain-language card (what changed, what was checked, the verdict,
 * what the user must decide); commands, tables, raw output and screenshot
 * detail sit below it in folded sections. The worker copies the template and
 * fills its {{SLOTS}}; `stage done` in the QA stage refuses a page whose card
 * is missing, unfilled, not first, or has a verdict outside the three.
 * The card follows the design page's plain-language rule (review-page.ts):
 * no code-shaped words unless defined, and at most QA_CARD_WORDS_MAX words.
 * Below the card, four folded parts hold the comparison with the design
 * (docs/notes/2026-11-06-make-the-visual-nx.md): what the checks came from,
 * the pass or fail table per checklist item, the findings by severity, and
 * what was and was not exercised. The check also holds the verdict to the
 * worst finding: a blocker means broken, a major rules out works.
 * Plain code: the check proves the card was filled, your review judges how well.
 */

import { codeElements, codeShapedTerms, definedTerms, nameSome, textOf, wordCount } from "./review-page.ts";

export const QA_TEMPLATE_FILE = "evidence-template.html";

/** The card's words: a minute of reading. */
export const QA_CARD_WORDS_MAX = 200;

/** The verdict words a card may carry, in `data-verdict`. */
export const QA_VERDICTS = ["works", "works-with-caveats", "broken"] as const;

/** The card's slots, as `data-slot` names, in the order the card shows them. */
export const QA_CARD_SLOTS = ["what-changed", "what-checked", "verdict", "decisions"] as const;

/** A finding's severity, in `data-severity`, worst first. */
export const QA_SEVERITIES = ["blocker", "major", "minor", "nit"] as const;
export type QaSeverity = (typeof QA_SEVERITIES)[number];

/** The folded parts that compare the build with the design, as `data-qa` names, in page order. */
export const QA_SECTIONS = ["references", "conformance", "findings", "coverage"] as const;

/** The card's what-changed answer for a change with no frontend surface: no checklist, no matrix. */
export const QA_NOTHING_VISIBLE = "Nothing visible.";

/** The checklist the QA worker writes before exercising the app, under the report dir. */
export const QA_CHECKLIST = "qa/checklist.md";

/** The checklist is read whole; a longer one is not a checklist. */
export const QA_CHECKLIST_MAX_BYTES = 256 * 1024;

/** A checklist item: a numbered, testable expectation tagged with where it came from. */
export const QA_CHECKLIST_ITEM = /^\d+\.\s+\S.*\(source:\s*[^)\s][^)]*\)\s*$/m;

/** Every placeholder the template carries; a filled page has none of them left. */
export const QA_PLACEHOLDERS = [
  "{{TITLE}}",
  "{{WHAT_CHANGED}}",
  "{{WHAT_CHECKED}}",
  "{{VERDICT}}",
  "{{VERDICT_DETAIL}}",
  "{{DECISIONS}}",
  "{{REFERENCES}}",
  "{{CONFORMANCE}}",
  "{{FINDINGS}}",
  "{{COVERAGE}}",
  "{{HOW_CHECKED}}",
  "{{FLOWS}}",
  "{{RAW_OUTPUT}}",
] as const;

export const QA_TEMPLATE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QA: {{TITLE}}</title>
<!--
  Fill every {{SLOT}}; stage done refuses the page while one is left.
  The card is for someone who has not read the code: plain words, no commands, no jargon, at most ${QA_CARD_WORDS_MAX} words.
  No code names in it (an underscore, a lowercase start with a capital inside, a file path, a --flag, a call()) and no
  <code>: define a term you need with <dfn>term</dfn>; <kbd> marks what the user types.
  WHAT_CHANGED   one or two sentences on what a person would notice; "Nothing visible." (then the reason) is the answer
                 for a change with no frontend surface: the folded parts below then say why nothing was exercised.
  WHAT_CHECKED   what was tried, in words: "All 792 tests pass; every combination of the new rules was tried."
  VERDICT        exactly one of: works | works-with-caveats | broken (the label is drawn from it). It follows the worst
                 finding: any blocker means broken; any major means works-with-caveats or broken; minors and nits
                 leave it to you (nits alone are works).
  VERDICT_DETAIL each caveat or failure spelled out, or "No caveats."
  DECISIONS      each question with your recommendation (an <ol> of <li>), or "Nothing to decide."; for questions
                 only the user can answer, "Answer the questions below." and the gate-question widget right after the card
  REFERENCES     what the checks came from: DESIGN.md (or "No DESIGN.md in this project; checked against the design page
                 and mockups"), the approved design page, each mockup; and a link to checklist.md.
  CONFORMANCE    a table, one row per checklist item: <tr><td>3. Primary button uses the accent colour</td>
                 <td>fail</td><td><a href="inbox-1440x900-dark-default.png">screenshot</a>, F2</td></tr>; result is
                 pass, fail or not exercised (with why).
  FINDINGS       by severity, worst first, each one <li data-severity="major" id="F2">: the checklist item it violates,
                 viewport, theme and state, the screenshot, expected vs actual. Severity is blocker | major | minor | nit.
                 None: "No findings."
  COVERAGE       the matrix: each screen against 1440x900, 768x1024, 390x844, light and dark, and its states, marked
                 exercised or not exercised with why. Screenshots are named <screen>-<WxH>-<theme>-<state>.png.
  Everything else goes in the folded sections below the card. A section with nothing in it says "None."
-->
<style>
:root{--bg:#fbfaf7;--fg:#1d1d1b;--mut:#66635c;--card:#fff;--line:#e3e0d8;--ok:#1f7a4a;--warn:#9a6400;--bad:#b3261e;--on-badge:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#ecebe6;--mut:#a29f97;--card:#1f1f1c;--line:#34332f;--ok:#5cc28c;--warn:#e0a83a;--bad:#ef7b72;--on-badge:#161614}}
body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;max-width:860px;margin:0 auto;padding:24px 16px}
h1{font-size:1.4rem;margin:0 0 16px}
.card{border:2px solid var(--line);border-radius:10px;padding:14px 18px;background:var(--card);margin:0 0 20px}
.card dl{margin:0}.card dt{font-weight:700;margin-top:12px}.card dt:first-child{margin-top:0}.card dd{margin:2px 0 0}
.card ol,.card ul{margin:4px 0;padding-left:20px}
[data-verdict]::before{display:inline-block;margin-right:8px;padding:0 10px;border-radius:99px;font-weight:700;color:var(--on-badge)}
[data-verdict="works"]::before{content:"Works";background:var(--ok)}
[data-verdict="works-with-caveats"]::before{content:"Works with caveats";background:var(--warn)}
[data-verdict="broken"]::before{content:"Broken";background:var(--bad)}
details{border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin:8px 0;background:var(--card)}
summary{cursor:pointer;font-weight:600}
img{max-width:100%;height:auto}
.wrap,pre{overflow-x:auto}
table{border-collapse:collapse}td,th{border:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}
[data-severity]::before{display:inline-block;margin-right:6px;padding:0 8px;border-radius:99px;font-size:.85em;font-weight:700;color:var(--on-badge)}
[data-severity="blocker"]::before{content:"Blocker";background:var(--bad)}
[data-severity="major"]::before{content:"Major";background:var(--warn)}
[data-severity="minor"]::before{content:"Minor";background:var(--mut)}
[data-severity="nit"]::before{content:"Nit";background:var(--line);color:var(--fg)}
</style></head><body>
<h1>QA: {{TITLE}}</h1>
<section class="card" data-flowryn-card>
<dl>
<dt>What changed that you'd notice</dt>
<dd data-slot="what-changed">{{WHAT_CHANGED}}</dd>
<dt>What was checked</dt>
<dd data-slot="what-checked">{{WHAT_CHECKED}}</dd>
<dt>Verdict</dt>
<dd data-slot="verdict" data-verdict="{{VERDICT}}">{{VERDICT_DETAIL}}</dd>
<dt>For you to decide</dt>
<dd data-slot="decisions">{{DECISIONS}}</dd>
</dl>
</section>
<details data-qa="references"><summary>What it was checked against</summary>
{{REFERENCES}}
</details>
<details data-qa="conformance"><summary>Checklist: pass or fail</summary>
{{CONFORMANCE}}
</details>
<details data-qa="findings"><summary>Findings by severity</summary>
{{FINDINGS}}
</details>
<details data-qa="coverage"><summary>What was and was not exercised</summary>
{{COVERAGE}}
</details>
<details><summary>How it was checked</summary>
{{HOW_CHECKED}}
</details>
<details><summary>Flows and screenshots</summary>
{{FLOWS}}
</details>
<details><summary>Raw output and logs</summary>
{{RAW_OUTPUT}}
</details>
</body></html>
`;

/** The page is read whole; anything larger is not a review page (the gate-question page limit too). */
export const QA_PAGE_MAX_BYTES = 5 * 1024 * 1024;

/** Markup that belongs below the card; any of it above the card means the card is not first. */
const DETAIL_MARKUP = /<(?:details|table|pre|img|figure|iframe)\b/i;

/** The body of one folded part, `<details data-qa="…">`, to its closing tag (nested details included), without its own summary. */
function sectionBody(html: string, name: string): string | null {
  const open = new RegExp(`<details\\b[^>]*\\bdata-qa\\s*=\\s*["']${name}["'][^>]*>`, "i").exec(html);
  if (!open) return null;
  const rest = html.slice(open.index + open[0].length);
  let depth = 1;
  let end = rest.length;
  for (const m of rest.matchAll(/<(\/?)details\b[^>]*>/gi)) {
    depth += m[1] === "/" ? -1 : 1;
    if (depth === 0) {
      end = m.index;
      break;
    }
  }
  return rest.slice(0, end).replace(/<summary\b[^>]*>[\s\S]*?<\/summary>/i, "");
}

/** Every finding's severity on the page, as written (comments and styles left out). */
export function qaSeverities(html: string): string[] {
  const markup = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<style\b[\s\S]*?<\/style>/gi, "");
  return [...markup.matchAll(/<[a-z][^>]*?\sdata-severity\s*=\s*["']([^"']*)["']/gi)].map((m) => m[1]!.trim().toLowerCase());
}

/** The verdicts a page may carry given its worst finding. */
export function verdictsAllowed(worst: QaSeverity | null): readonly string[] {
  if (worst === "blocker") return ["broken"];
  if (worst === "major") return ["works-with-caveats", "broken"];
  return QA_VERDICTS;
}

/** Whether the card says the change has no frontend surface ("Nothing visible." first in what-changed). */
export function qaNothingVisible(html: string): boolean {
  const start = html.search(/<section\b[^>]*\bdata-flowryn-card\b/i);
  if (start === -1) return false;
  const found = slotBody(html.slice(start), "what-changed");
  return found !== null && textOf(found.body).startsWith(QA_NOTHING_VISIBLE);
}

/** What is wrong with a QA checklist's text; empty when it has at least one numbered item citing its source. */
export function qaChecklistProblems(text: string): string[] {
  if (QA_CHECKLIST_ITEM.test(text)) return [];
  return [`${QA_CHECKLIST} has no checklist item: write numbered, testable expectations, each ending with its source, e.g. "1. The primary button uses the accent colour (source: DESIGN.md Colours)"`];
}

/** The markup of one card slot: from its opening tag to the next <dt> or the end of the list. */
function slotBody(card: string, slot: string): { tag: string; body: string } | null {
  const open = new RegExp(`<dd\\b[^>]*\\bdata-slot\\s*=\\s*["']${slot}["'][^>]*>`, "i").exec(card);
  if (!open) return null;
  const rest = card.slice(open.index + open[0].length);
  const end = rest.search(/<dt\b|<\/dl>/i);
  return { tag: open[0], body: end === -1 ? rest : rest.slice(0, end) };
}

/**
 * What is wrong with a QA evidence page, as one line per problem the worker
 * can fix; empty when the card is there, first, filled and has a known verdict.
 */
export function qaPageProblems(html: string): string[] {
  const problems: string[] = [];
  const left = QA_PLACEHOLDERS.filter((p) => html.includes(p));
  if (left.length > 0) problems.push(`fill the template's slots: ${left.join(", ")} still blank`);
  const start = html.search(/<section\b[^>]*\bdata-flowryn-card\b/i);
  if (start === -1) return [...problems, `the page has no summary card (<section data-flowryn-card>); start from ${QA_TEMPLATE_FILE}`];
  const close = html.indexOf("</dl>", start);
  const card = close === -1 ? html.slice(start) : html.slice(start, close + "</dl>".length);
  const bodyStart = html.search(/<body\b/i);
  if (DETAIL_MARKUP.test(html.slice(Math.max(bodyStart, 0), start))) problems.push("the summary card must open the page; move tables, screenshots, raw output and folded sections below it");
  for (const slot of QA_CARD_SLOTS) {
    const found = slotBody(card, slot);
    if (!found) problems.push(`the card has no ${slot} entry (<dd data-slot="${slot}">)`);
    else if (!/\p{L}/u.test(textOf(found.body))) problems.push(`the card's ${slot} entry is empty; say it in words`);
    if (slot === "verdict" && found) {
      const verdict = /\bdata-verdict\s*=\s*["']([^"']*)["']/i.exec(found.tag)?.[1];
      if (!verdict || !(QA_VERDICTS as readonly string[]).includes(verdict)) problems.push(`the verdict must be data-verdict="${QA_VERDICTS.join('" | "')}"`);
    }
  }
  for (const name of QA_SECTIONS) {
    const body = sectionBody(html, name);
    if (body === null) problems.push(`the page has no ${name} part (<details data-qa="${name}">); start from ${QA_TEMPLATE_FILE}`);
    else if (!/\p{L}/u.test(textOf(body))) problems.push(`the ${name} part is empty; say it in words ("None." with the reason when there is nothing)`);
  }
  const severities = qaSeverities(html);
  const unknown = [...new Set(severities.filter((s) => !(QA_SEVERITIES as readonly string[]).includes(s)))];
  if (unknown.length > 0) problems.push(`unknown finding severity ${unknown.map((s) => `"${s}"`).join(", ")}: use data-severity="${QA_SEVERITIES.join('" | "')}"`);
  const worst = QA_SEVERITIES.find((s) => severities.includes(s)) ?? null;
  const verdict = /\bdata-verdict\s*=\s*["']([^"']*)["']/i.exec(slotBody(card, "verdict")?.tag ?? "")?.[1];
  if (worst && verdict && (QA_VERDICTS as readonly string[]).includes(verdict) && !verdictsAllowed(worst).includes(verdict)) {
    problems.push(`the verdict is ${verdict} but the page has a ${worst} finding: a ${worst} means ${verdictsAllowed(worst).join(" or ")}`);
  }
  const defined = definedTerms(html);
  const terms = codeShapedTerms(card, defined);
  if (terms.length > 0) problems.push(`code names in the card: ${nameSome(terms)}; say it in words, or move it into a folded section below`);
  const code = codeElements(card, defined);
  if (code.length > 0) problems.push(`<code> or <pre> in the card: ${nameSome(code)}; move it into a folded section below`);
  const words = wordCount(textOf(card));
  if (words > QA_CARD_WORDS_MAX) problems.push(`the card is ${words} words; keep it to ${QA_CARD_WORDS_MAX} and fold the rest below it`);
  return problems;
}
