import { codeElements, codeShapedTerms, definedTerms, dropElements, nameSome, opensUnfolded, textOf, visibleMarkup, wordCount } from "./review-page.ts";
import { WIDGET_MOUNT } from "../lavish/widget.ts";

/**
 * The design page's fixed template and its check (docs/notes/2026-10-22-design-review-pages-zh.md).
 * A design page is for an engineer who has not read the code: seven parts
 * in plain words, in a fixed order, short enough to judge in about two
 * minutes, with files, identifiers and tests folded in one section at the
 * end. The worker copies the template and fills its {{SLOTS}}; `stage done`
 * in a design stage refuses a page that breaks the outline, the budget or
 * the plain-language rule. Plain code: the check proves the shape, the
 * reviewer judges the writing.
 */

export const DESIGN_TEMPLATE_FILE = "design-template.html";

/** The parts above the fold, as `data-section` names, in page order. */
export const DESIGN_SECTIONS = ["tldr", "ask", "change", "goals", "how", "alternatives", "risks"] as const;

/** The folded last part: files, identifiers, tests, choices, sources. */
export const DESIGN_DETAIL_SECTION = "detail";

/** Words a reader sees before unfolding anything, diagrams aside: about two minutes of reading. */
export const DESIGN_VISIBLE_WORDS_MAX = 500;

/** The summary's words, its heading aside. */
export const DESIGN_TLDR_WORDS_MAX = 80;

/** Every placeholder the template carries; a filled page has none of them left. */
export const DESIGN_PLACEHOLDERS = [
  "{{TITLE}}",
  "{{SUBTITLE}}",
  "{{TLDR}}",
  "{{ASK}}",
  "{{BEFORE_AFTER}}",
  "{{GOALS}}",
  "{{NON_GOALS}}",
  "{{DIAGRAM}}",
  "{{HOW}}",
  "{{ALTERNATIVES}}",
  "{{RISKS}}",
  "{{DETAIL}}",
] as const;

/** The fixed labels the template writes inside its parts; a part with nothing but these is empty. */
const CHANGE_HEADER = "<tr><th></th><th>Before</th><th>After</th></tr>";
const GOALS_LABEL = "<strong>Goals.</strong>";
const NON_GOALS_LABEL = "<strong>Not goals.</strong>";

export const DESIGN_TEMPLATE = `<!doctype html>
<html lang="en" data-lavish-live-reload-root><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{TITLE}}</title>
<!--
  Fill every {{SLOT}}; stage done refuses the page while one is left.
  Write for an engineer who has not read the code: plain words, short sentences, the idea before the mechanism.
  Above the fold (everything outside the folded <details>): no code names (an underscore, a lowercase start with a
  capital inside, a file path, a --flag, a call()), no <code> or <pre>, and no internal term the reader would not
  know. Define a term you need with <dfn>term</dfn> on first use; <kbd> marks what the user types.
  At most ${DESIGN_VISIBLE_WORDS_MAX} words above the fold (diagrams do not count); the summary at most ${DESIGN_TLDR_WORDS_MAX}.
  TITLE        what the change does, in words ("Wake the leader when a pull request is ready").
  SUBTITLE     one line: the task, and whether any part needs a model (and why).
  TLDR         two to four sentences: the problem, the change, what it means for the user.
  ASK          approve or send changes; the two or three calls worth a look. With questions for the user, put the
               question widget here: <section id="flowryn-questions"></section><script src="flowryn-questions.js"></script>
  BEFORE_AFTER table rows, <tr><td>what</td><td>before</td><td>after</td></tr>, as the user would notice it.
  GOALS        what the change must achieve.  NON_GOALS  what it could reasonably do but deliberately does not.
  DIAGRAM      an inline <svg> (both themes: use the colour tokens), an <img> or a drawn <pre>: the parts and the flow.
  HOW          the mechanism in a few numbered steps, in words.
  ALTERNATIVES the other ways, doing nothing included, and why each lost.
  RISKS        what could go wrong, the sign we would see, and what we would do.
  DETAIL       folded: files and identifiers, data and APIs, the assumptions the build must test, every choice you
               made and why, sources, and what you could not check (mark guesses as guesses).
-->
<style>
:root{--bg:#fbfaf7;--fg:#1d1d1b;--mut:#66635c;--card:#fff;--line:#e3e0d8;--acc:#2f6f5e;--code:#f1efe8}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#161614;--fg:#ecebe6;--mut:#a29f97;--card:#1f1f1c;--line:#34332f;--acc:#7cc4ad;--code:#262624}}
:root[data-theme="dark"]{--bg:#161614;--fg:#ecebe6;--mut:#a29f97;--card:#1f1f1c;--line:#34332f;--acc:#7cc4ad;--code:#262624}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:820px;margin:0 auto;padding:28px 16px 64px}
h1{font-size:1.5rem;margin:0 0 4px}h2{font-size:1.1rem;margin:30px 0 8px}
.sub{color:var(--mut);margin:0 0 20px}
section[data-section="tldr"]{font-size:1.06rem}
section[data-section="ask"]{border:2px solid var(--acc);border-radius:10px;padding:4px 18px 10px;background:var(--card)}
section[data-section="ask"] h2{color:var(--acc);margin-top:12px}
table{border-collapse:collapse;width:100%;font-size:.95em}
th,td{border-bottom:1px solid var(--line);text-align:left;padding:7px 8px;vertical-align:top}
th{color:var(--mut);font-weight:600}
.wrap,figure{overflow-x:auto}
figure{margin:12px 0}
svg text{fill:var(--fg)}
details{border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin:24px 0 0;background:var(--card)}
summary{cursor:pointer;font-weight:600}
code,pre{background:var(--code);border-radius:4px;font-size:.88em}
code{padding:1px 5px}pre{padding:10px;overflow-x:auto}
</style></head><body>
<h1>{{TITLE}}</h1>
<p class="sub">{{SUBTITLE}}</p>
<section data-section="tldr">
<h2>In short</h2>
<p>{{TLDR}}</p>
</section>
<section data-section="ask">
<h2>What I need from you</h2>
{{ASK}}
</section>
<section data-section="change">
<h2>What changes for you</h2>
<div class="wrap"><table>
${CHANGE_HEADER}
{{BEFORE_AFTER}}
</table></div>
</section>
<section data-section="goals">
<h2>Goals and non-goals</h2>
<p>${GOALS_LABEL} {{GOALS}}</p>
<p>${NON_GOALS_LABEL} {{NON_GOALS}}</p>
</section>
<section data-section="how">
<h2>How it works</h2>
<figure>{{DIAGRAM}}</figure>
{{HOW}}
</section>
<section data-section="alternatives">
<h2>Other ways we could do it</h2>
{{ALTERNATIVES}}
</section>
<section data-section="risks">
<h2>Risks, and how we’d know it’s wrong</h2>
{{RISKS}}
</section>
<details data-section="detail">
<summary>Implementation detail: files, tests, choices, sources</summary>
{{DETAIL}}
</details>
</body></html>
`;

interface Part {
  name: string;
  start: number;
  end: number;
}

function sectionOpen(name: string): RegExp {
  return new RegExp(`<section\\b[^>]*\\bdata-section\\s*=\\s*["']${name}["'][^>]*>`, "i");
}

/** Where the element whose opening tag starts at `from` ends, past its own matching close tag, or null if it never closes. */
function elementEnd(html: string, tag: string, from: number): number | null {
  const token = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  token.lastIndex = from;
  let depth = 0;
  for (let m = token.exec(html); m; m = token.exec(html)) {
    if (m[1] !== "/") depth++;
    else if (--depth === 0) return m.index + m[0].length;
  }
  return null;
}

/** A `<section data-section=name>` from its opening tag to its own `</section>`, or null. */
function findSection(html: string, name: string): Part | null {
  const open = sectionOpen(name).exec(html);
  if (!open) return null;
  return { name, start: open.index, end: elementEnd(html, "section", open.index) ?? html.length };
}

function findDetail(html: string): { start: number; end: number | null; tag: string } | null {
  const open = new RegExp(`<details\\b[^>]*\\bdata-section\\s*=\\s*["']${DESIGN_DETAIL_SECTION}["'][^>]*>`, "i").exec(html);
  return open ? { start: open.index, end: elementEnd(html, "details", open.index), tag: open[0] } : null;
}

/** Whether a reader would see anything after `from`: text or a content element, with comments, scripts, styles and closing tags aside. */
function showsAfter(html: string, from: number): boolean {
  let tail = html.slice(from).replace(/<!--[\s\S]*?-->/g, " ");
  for (const tag of ["script", "style"]) tail = dropElements(tail, tag);
  return /[\p{L}\p{N}]/u.test(textOf(tail)) || /<(?:img|svg|table|pre|figure|iframe|video|section|details|ul|ol)\b/i.test(tail);
}

/** A part's own words: its heading and the template's fixed labels aside. */
function withoutLabels(part: string): string {
  let out = part.replace(/<h2\b[\s\S]*?<\/h2>/i, " ");
  for (const label of [CHANGE_HEADER, GOALS_LABEL, NON_GOALS_LABEL]) out = out.replace(label, " ");
  return out;
}

/** The template's goals labels with no words between them and the next label (or the end of the part). */
function blankGoalLabels(part: string): string[] {
  const blank: string[] = [];
  for (const [label, next] of [[GOALS_LABEL, NON_GOALS_LABEL], [NON_GOALS_LABEL, GOALS_LABEL]] as const) {
    const at = part.indexOf(label);
    if (at === -1) continue;
    const rest = part.slice(at + label.length);
    const end = rest.indexOf(next);
    if (!/\p{L}/u.test(textOf(end === -1 ? rest : rest.slice(0, end)))) blank.push(textOf(label));
  }
  return blank;
}

/**
 * What is wrong with a design page, as one line per problem the worker can
 * fix; empty when the page passes. `widget`: the page carries questions for
 * the user, so the question widget must sit in "What I need from you".
 */
export function designPageProblems(html: string, opts: { widget?: boolean } = {}): string[] {
  const problems: string[] = [];
  const left = DESIGN_PLACEHOLDERS.filter((p) => html.includes(p));
  if (left.length > 0) problems.push(`fill the template's slots: ${left.join(", ")} still blank`);

  const parts = DESIGN_SECTIONS.map((name) => findSection(html, name));
  const missing = DESIGN_SECTIONS.filter((_, i) => parts[i] === null);
  if (missing.length === DESIGN_SECTIONS.length) problems.push(`the page does not follow the design outline (no <section data-section="tldr"> and the rest); start from ${DESIGN_TEMPLATE_FILE}`);
  else if (missing.length > 0) problems.push(`the page is missing ${missing.map((m) => `<section data-section="${m}">`).join(", ")}; every part of ${DESIGN_TEMPLATE_FILE} is required`);
  const found = parts.filter((p): p is Part => p !== null);
  const inOrder = found.every((p, i) => i === 0 || p.start > found[i - 1]!.start);
  if (!inOrder) problems.push(`the parts must come in this order: ${DESIGN_SECTIONS.join(", ")}`);
  for (const part of found) {
    const body = html.slice(part.start, part.end);
    if (!/\p{L}/u.test(textOf(withoutLabels(body)))) problems.push(`the "${part.name}" part is empty; say it in words`);
    else if (part.name === "goals") for (const label of blankGoalLabels(body)) problems.push(`the "${label}" line in the "goals" part is empty; say it in words`);
  }

  const first = found[0];
  if (first && first.name === "tldr") {
    const before = html.slice(0, first.start).replace(/<!--[\s\S]*?-->/g, " ");
    const bodyAt = before.search(/<body\b/i);
    const headEnd = /<\/head\s*>/i.exec(before);
    const start = bodyAt >= 0 ? bodyAt : headEnd ? headEnd.index + headEnd[0].length : 0;
    if (/<(?:section|details|table|pre|figure|img|ul|ol)\b/i.test(before.slice(start))) problems.push("only the title and one subtitle line may come before the summary (tldr)");
    const words = wordCount(textOf(html.slice(first.start, first.end).replace(/<h2\b[\s\S]*?<\/h2>/i, "")));
    if (words > DESIGN_TLDR_WORDS_MAX) problems.push(`the summary (tldr) is ${words} words; keep it to ${DESIGN_TLDR_WORDS_MAX}`);
  }

  const how = found.find((p) => p.name === "how");
  if (how && !/<figure\b/i.test(html.slice(how.start, how.end))) problems.push('"How it works" needs a diagram: a <figure> holding an inline <svg>, an <img> or a drawn <pre>');

  const detail = findDetail(html);
  const last = found[found.length - 1];
  if (!detail) {
    if (found.length > 0) problems.push(`the implementation detail must be folded, last: <details data-section="${DESIGN_DETAIL_SECTION}">`);
  } else {
    if (opensUnfolded(detail.tag)) problems.push("the implementation detail must start folded: drop open from its <details>");
    if (last && detail.start < last.end) problems.push("the folded implementation detail must come after every other part");
    else if (detail.end === null) problems.push("the implementation detail's <details> is never closed: end it with </details>");
    else if (showsAfter(html, detail.end)) problems.push("nothing a reader sees may follow the folded implementation detail: move it into the detail or above it");
  }

  const visible = visibleMarkup(html);
  const words = wordCount(textOf(visibleMarkup(html, { withoutDiagrams: true })));
  if (words > DESIGN_VISIBLE_WORDS_MAX) problems.push(`the page shows ${words} words before anything is unfolded; keep it to ${DESIGN_VISIBLE_WORDS_MAX} (diagrams aside): move detail into the folded section`);
  const defined = definedTerms(html);
  const terms = codeShapedTerms(visible, defined);
  if (terms.length > 0) problems.push(`code names above the fold: ${nameSome(terms)}; say it in words, move it into the folded detail, or define it with <dfn>`);
  const code = codeElements(visible, defined);
  if (code.length > 0) problems.push(`<code> or <pre> above the fold: ${nameSome(code)}; move it into the folded detail`);

  const ask = found.find((p) => p.name === "ask");
  if (opts.widget && ask && !html.slice(ask.start, ask.end).includes(WIDGET_MOUNT)) problems.push(`the question widget (<section ${WIDGET_MOUNT}>) belongs in "What I need from you"`);
  return problems;
}
