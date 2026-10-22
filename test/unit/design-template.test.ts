import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DESIGN_PLACEHOLDERS,
  DESIGN_SECTIONS,
  DESIGN_TEMPLATE,
  DESIGN_TEMPLATE_FILE,
  DESIGN_TLDR_WORDS_MAX,
  DESIGN_VISIBLE_WORDS_MAX,
  designPageProblems,
} from "../../src/skills/design-template.ts";
import { STAGE_SKILLS } from "../../src/skills/stages.ts";
import { filledDesignPage } from "../helpers/design-page.ts";

/** The design page of the task that brought in this standard: the first page written to it. */
const GOOD = readFileSync(join(import.meta.dir, "..", "..", "fixtures", "design-page", "good.html"), "utf8");

function filled(overrides: Record<string, string> = {}): string {
  let page = DESIGN_TEMPLATE;
  for (const slot of DESIGN_PLACEHOLDERS) page = page.replaceAll(slot, overrides[slot] ?? "Said in plain words.");
  return page;
}

const words = (n: number): string => Array.from({ length: n }, () => "word").join(" ");

describe("the design page template", () => {
  test("carries the seven parts in order, then the folded detail, and ships beside the design skill", () => {
    for (const slot of DESIGN_PLACEHOLDERS) expect(DESIGN_TEMPLATE).toContain(slot);
    const at = DESIGN_SECTIONS.map((s) => DESIGN_TEMPLATE.indexOf(`data-section="${s}"`));
    expect(at.every((i, n) => i > 0 && (n === 0 || i > at[n - 1]!))).toBe(true);
    expect(DESIGN_TEMPLATE.indexOf('<details data-section="detail">')).toBeGreaterThan(at[at.length - 1]!);
    const skill = STAGE_SKILLS.find((s) => s.name === "flowryn-design")!;
    expect(skill.files?.[DESIGN_TEMPLATE_FILE]).toBe(DESIGN_TEMPLATE);
    expect(skill.body).toContain(DESIGN_TEMPLATE_FILE);
  });

  test("unfilled, it is refused, naming every blank slot", () => {
    const problems = designPageProblems(DESIGN_TEMPLATE);
    expect(problems).toHaveLength(1);
    for (const slot of DESIGN_PLACEHOLDERS) expect(problems[0]).toContain(slot);
  });

  test("filled in plain words, it passes; so does the fake worker's page, with and without the question widget", () => {
    expect(designPageProblems(filled())).toEqual([]);
    expect(designPageProblems(filledDesignPage())).toEqual([]);
    expect(designPageProblems(filledDesignPage({ widget: true }), { widget: true })).toEqual([]);
  });

  test("the first page written to the standard passes it", () => {
    expect(designPageProblems(GOOD)).toEqual([]);
  });
});

describe("the design page check", () => {
  test("a page shaped like the old ones fails on outline, budget and code names", () => {
    const old = `<html><body><h1>Wake the idle leader</h1><h2>What changes</h2><table>${Array.from({ length: 60 }, (_, i) => `<tr><td>src/attention/items.ts</td><td>LEADER_WAKE_KINDS gains pr_ready; awayWakeSql and p0Candidate change ${i}</td></tr>`).join("")}</table></body></html>`;
    const problems = designPageProblems(old);
    expect(problems[0]).toContain("does not follow the design outline");
    expect(problems.some((p) => p.startsWith("the page shows") && p.includes(`keep it to ${DESIGN_VISIBLE_WORDS_MAX}`))).toBe(true);
    const named = problems.find((p) => p.startsWith("code names above the fold"))!;
    for (const term of ["src/attention/items.ts", "LEADER_WAKE_KINDS", "pr_ready", "awayWakeSql", "p0Candidate"]) expect(named).toContain(`"${term}"`);
  });

  test("a missing part, an empty one, and parts out of order are each named", () => {
    const missing = filled().replace(/<section data-section="alternatives">[\s\S]*?<\/section>/, "");
    expect(designPageProblems(missing)).toEqual(['the page is missing <section data-section="alternatives">; every part of design-template.html is required']);
    const empty = filled({ "{{RISKS}}": "<ul><li> </li></ul>" });
    expect(designPageProblems(empty)).toEqual(['the "risks" part is empty; say it in words']);
    const goals = /<section data-section="goals">[\s\S]*?<\/section>\n/.exec(filled())![0];
    const swapped = filled().replace(goals, "").replace('<section data-section="ask">', `${goals}<section data-section="ask">`);
    expect(designPageProblems(swapped)).toEqual([`the parts must come in this order: ${DESIGN_SECTIONS.join(", ")}`]);
  });

  test("nothing but the title and a subtitle may come before the summary", () => {
    const leading = filled().replace('<p class="sub">', "<table><tr><td>File</td></tr></table><p class=\"sub\">");
    expect(designPageProblems(leading)).toEqual(["only the title and one subtitle line may come before the summary (tldr)"]);
  });

  test("the summary and the visible part have word budgets; folded text and diagrams do not count", () => {
    expect(designPageProblems(filled({ "{{TLDR}}": words(DESIGN_TLDR_WORDS_MAX) }))).toEqual([]);
    expect(designPageProblems(filled({ "{{TLDR}}": words(DESIGN_TLDR_WORDS_MAX + 1) }))).toEqual([`the summary (tldr) is ${DESIGN_TLDR_WORDS_MAX + 1} words; keep it to ${DESIGN_TLDR_WORDS_MAX}`]);
    const over = designPageProblems(filled({ "{{HOW}}": words(DESIGN_VISIBLE_WORDS_MAX) }));
    expect(over).toHaveLength(1);
    expect(over[0]).toMatch(/^the page shows \d+ words before anything is unfolded; keep it to 500/);
    const folded = filled({ "{{DETAIL}}": `${words(3000)} src/x.ts LEADER_WAKE_KINDS <code>a_b</code><details><summary>more</summary>${words(500)}</details>` });
    expect(designPageProblems(folded)).toEqual([]);
    const diagram = filled({ "{{DIAGRAM}}": `<svg viewBox="0 0 10 10"><text>${words(800)}</text></svg>` });
    expect(designPageProblems(diagram)).toEqual([]);
  });

  test('"How it works" needs a figure', () => {
    const none = filled().replace(/<figure>[\s\S]*?<\/figure>/, "");
    expect(designPageProblems(none)).toEqual(['"How it works" needs a diagram: a <figure> holding an inline <svg>, an <img> or a drawn <pre>']);
  });

  test("the detail must be folded, closed and last", () => {
    const unfolded = filled().replace(/<details data-section="detail">[\s\S]*?<\/details>/, "<p>Files.</p>");
    expect(designPageProblems(unfolded)).toEqual(['the implementation detail must be folded, last: <details data-section="detail">']);
    expect(designPageProblems(filled().replace('<details data-section="detail">', '<details data-section="detail" open>'))).toEqual(["the implementation detail must start folded: drop open from its <details>"]);
    const risks = /<section data-section="risks">[\s\S]*?<\/section>\n/.exec(filled())![0];
    const early = filled().replace(risks, "").replace("</body>", `${risks}</body>`);
    expect(designPageProblems(early)).toEqual(["the folded implementation detail must come after every other part"]);
    const trailing = filled().replace("</body>", "<p>Appendix in plain words.</p></body>");
    expect(designPageProblems(trailing)).toEqual(["nothing a reader sees may follow the folded implementation detail: move it into the detail or above it"]);
    const scripted = filled().replace("</body>", '<!-- a note --><script src="extra.js"></script>\n</body>');
    expect(designPageProblems(scripted)).toEqual([]);
    const wrapped = filled().replace("<body>", "<body><main>").replace("</body>", "</main></body>");
    expect(designPageProblems(wrapped)).toEqual([]);
    expect(designPageProblems(filled().replace("</body>", ""))).toEqual([]);
    expect(designPageProblems(filled().replace("</body>", "<div><p></p></div></body>"))).toEqual([]);
    expect(designPageProblems(filled().replace("</body>", '<img src="extra.png"></body>'))).toEqual(["nothing a reader sees may follow the folded implementation detail: move it into the detail or above it"]);
    const unclosed = filled().replace("</details>", "");
    expect(designPageProblems(unclosed)).toEqual(["the implementation detail's <details> is never closed: end it with </details>"]);
  });

  test("code names above the fold are named; a <dfn> term, <kbd> text and product names pass", () => {
    const named = designPageProblems(filled({ "{{HOW}}": "The leaderPush call reads pr_ready from src/attention/items.ts, runs check() and takes --page; also MAX_WAKES and config.toml." }));
    expect(named).toEqual([`code names above the fold: "leaderPush", "pr_ready", "src/attention/items.ts", "check()", "--page", "MAX_WAKES", "config.toml"; say it in words, move it into the folded detail, or define it with <dfn>`]);
    const svg = designPageProblems(filled({ "{{DIAGRAM}}": "<svg><text>awayWakeSql</text></svg>" }));
    expect(svg[0]).toContain('"awayWakeSql"');
    const fine = filled({
      "{{HOW}}": "A <dfn>pr_ready</dfn> item means a pull request is ready; each pr_ready item wakes the leader. Run <kbd>flowryn approve --gate design</kbd>. It works on macOS, with GitHub, JavaScript and Node.js, before/after, e.g. today.",
    });
    expect(designPageProblems(fine)).toEqual([]);
  });

  test("<code> and <pre> above the fold are refused outside the figure", () => {
    expect(designPageProblems(filled({ "{{HOW}}": "<p>It runs <code>stage done</code>.</p>" }))).toEqual(['<code> or <pre> above the fold: "stage done"; move it into the folded detail']);
    expect(designPageProblems(filled({ "{{DIAGRAM}}": "<pre>worker -&gt; flowryn -&gt; you</pre>" }))).toEqual([]);
  });

  test("with questions, the widget must sit in What I need from you", () => {
    const widget = '<section id="flowryn-questions"></section><script src="flowryn-questions.js"></script>';
    const below = filled({ "{{RISKS}}": `Said in plain words. ${widget}` });
    expect(designPageProblems(below, { widget: true })).toEqual(['the question widget (<section id="flowryn-questions">) belongs in "What I need from you"']);
    expect(designPageProblems(filled({ "{{ASK}}": `Answer the questions below. ${widget}` }), { widget: true })).toEqual([]);
    const widgetFirst = filled().replace(/<h2>What I need from you<\/h2>\n\{\{ASK\}\}|<h2>What I need from you<\/h2>\n[^\n]*/, `<h2>What I need from you</h2>${widget}<p>Approve, or send changes; look at the retry choice.</p>`);
    expect(widgetFirst).toContain(`${widget}<p>Approve`);
    expect(designPageProblems(widgetFirst, { widget: true })).toEqual([]);
  });
});
