import { describe, expect, test } from "bun:test";
import { codeElements, codeShapedTerms, definedTerms, dropElements, nameSome, textOf, visibleMarkup, wordCount } from "../../src/skills/review-page.ts";

describe("what a review page shows before anything is unfolded", () => {
  test("folded sections, nested ones included, styles, scripts and comments are dropped", () => {
    const html = "<p>one</p><details><summary>s</summary>two<details>three</details>four</details><p>five</p><style>p{}</style><script>x()</script><!-- six -->";
    expect(textOf(visibleMarkup(html)).split(/\s+/)).toEqual(["one", "five"]);
  });

  test("diagrams stay for the code-name check and leave the word count", () => {
    const html = "<p>a b</p><svg><text>c d e</text></svg>";
    expect(wordCount(textOf(visibleMarkup(html)))).toBe(5);
    expect(wordCount(textOf(visibleMarkup(html, { withoutDiagrams: true })))).toBe(2);
  });

  test("an unclosed element drops the rest of the page", () => {
    expect(dropElements("<p>a</p><details>b", "details")).toBe("<p>a</p>");
  });

  test("entities decode and punctuation-only words do not count", () => {
    expect(textOf("a&nbsp;b &amp; c")).toBe("a b & c");
    expect(wordCount("a – b — c")).toBe(3);
  });
});

describe("code-shaped words", () => {
  const none = new Set<string>();
  test("each shape is caught once, in page order", () => {
    expect(codeShapedTerms("<p>pr_ready (pr_ready) leaderPush, src/a/b.ts: run() --page MAX_X notes.md</p>", none)).toEqual(["pr_ready", "leaderPush", "src/a/b.ts", "run()", "--page", "MAX_X", "notes.md"]);
  });

  test("plain words, product names, numbers, slashes and template slots pass", () => {
    expect(codeShapedTerms("<p>GitHub macOS iPhone JavaScript Node.js before/after 550–900 e.g. a — b {{TLDR}} 2-minute</p>", none)).toEqual([]);
  });

  test("<kbd> text and <dfn> terms pass", () => {
    const html = "<p><dfn>pr_ready</dfn> then pr_ready, and <kbd>flowryn approve --gate design</kbd></p>";
    expect(codeShapedTerms(html, definedTerms(html))).toEqual([]);
  });

  test("<code> and <pre> outside figures are listed, long ones cut", () => {
    const html = `<p><code>a</code><code>${"x".repeat(50)}</code></p><figure><pre>drawn</pre></figure>`;
    expect(codeElements(html, none)).toEqual(["a", `${"x".repeat(40)}…`]);
  });

  test("a long list names ten and counts the rest", () => {
    expect(nameSome(Array.from({ length: 12 }, (_, i) => `t${i}`))).toBe('"t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9" and 2 more');
  });
});
