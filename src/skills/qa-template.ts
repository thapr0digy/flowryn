/**
 * The QA evidence page's fixed template and its check. Every QA page opens
 * with one plain-language card (what changed, what was checked, the verdict,
 * what the user must decide); commands, tables, raw output and screenshot
 * detail sit below it in folded sections. The worker copies the template and
 * fills its {{SLOTS}}; `stage done` in the QA stage refuses a page whose card
 * is missing, unfilled, not first, or has a verdict outside the three.
 * Plain code: the check proves the card was filled, your review judges how well.
 */

export const QA_TEMPLATE_FILE = "evidence-template.html";

/** The verdict words a card may carry, in `data-verdict`. */
export const QA_VERDICTS = ["works", "works-with-caveats", "broken"] as const;

/** The card's slots, as `data-slot` names, in the order the card shows them. */
export const QA_CARD_SLOTS = ["what-changed", "what-checked", "verdict", "decisions"] as const;

/** Every placeholder the template carries; a filled page has none of them left. */
export const QA_PLACEHOLDERS = ["{{TITLE}}", "{{WHAT_CHANGED}}", "{{WHAT_CHECKED}}", "{{VERDICT}}", "{{VERDICT_DETAIL}}", "{{DECISIONS}}", "{{HOW_CHECKED}}", "{{FLOWS}}", "{{RAW_OUTPUT}}"] as const;

export const QA_TEMPLATE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QA: {{TITLE}}</title>
<!--
  Fill every {{SLOT}}; stage done refuses the page while one is left.
  The card is for someone who has not read the code: plain words, no commands, no jargon.
  WHAT_CHANGED   one or two sentences on what a person would notice; "Nothing visible." is a fine answer.
  WHAT_CHECKED   what was tried, in words: "All 792 tests pass; every combination of the new rules was tried."
  VERDICT        exactly one of: works | works-with-caveats | broken (the label is drawn from it).
  VERDICT_DETAIL each caveat or failure spelled out, or "No caveats."
  DECISIONS      each question with your recommendation (an <ol> of <li>), or "Nothing to decide."; for questions
                 only the user can answer, "Answer the questions below." and the gate-question widget right after the card
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

function textOf(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .trim();
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
  return problems;
}
