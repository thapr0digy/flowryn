/**
 * Plain-code checks shared by the review pages a human reads (the design
 * page, src/skills/design-template.ts, and the QA card, qa-template.ts):
 * what part of a page is visible before anything is unfolded, how many words
 * it holds, and which words in it are shaped like code. Shape, not meaning:
 * plain-English jargon passes, and the reviewer judges it. No model is used.
 */

/** Product names whose mixed case is not code. */
const MIXED_CASE_NAMES = new Set(["macOS", "iOS", "iPadOS", "watchOS", "tvOS", "visionOS", "iPhone", "iPad", "iCloud", "eBay"]);

/** File extensions that mark a bare file name as code (".js" is left out: "Node.js" is a product). */
const CODE_FILE = /^[\w.-]+\.(?:ts|tsx|mts|cts|mjs|cjs|jsx|py|go|rs|rb|sh|sql|toml|ya?ml|json|jsonl|md|html|css|lock)$/i;

/** A web address: a word with a URL scheme, or a host with a top-level domain followed by a path with no file extension. */
const WEB_ADDRESS = /^(?:[a-z][a-z\d+.-]*:\/\/\S+|(?:[\w-]+\.)+[a-z]{2,}(?:\/[^./]*)+)$/i;

/** How many offending terms a problem line names before it says how many more. */
const MAX_NAMED = 10;

export function textOf(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]*>/g, " "),
  ).trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** Drop every `<tag …>…</tag>` element, nested ones included (a `<details>` inside a `<details>`). */
export function dropElements(html: string, tag: string): string {
  const token = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  let out = "";
  let depth = 0;
  let from = 0;
  for (const m of html.matchAll(token)) {
    const closing = m[1] === "/";
    if (!closing) {
      if (depth === 0) out += html.slice(from, m.index);
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0) from = m.index + m[0].length;
    }
  }
  return depth > 0 ? out : out + html.slice(from);
}

/**
 * The markup a reader sees before unfolding anything: comments, `<style>`,
 * `<script>` and every `<details>` removed. `<svg>` stays (its labels are
 * read); `withoutDiagrams` drops it for the word count, since a diagram does
 * not count toward the budget.
 */
export function visibleMarkup(html: string, opts: { withoutDiagrams?: boolean } = {}): string {
  let out = html.replace(/<!--[\s\S]*?-->/g, " ");
  for (const tag of ["style", "script", "details"]) out = dropElements(out, tag);
  if (opts.withoutDiagrams) out = dropElements(out, "svg");
  return out;
}

/** The words a page defines with `<dfn>`: those may appear anywhere on it. */
export function definedTerms(html: string): Set<string> {
  const terms = new Set<string>();
  for (const m of html.matchAll(/<dfn\b[^>]*>([\s\S]*?)<\/dfn>/gi)) {
    const term = textOf(m[1] ?? "");
    if (term.length === 0) continue;
    terms.add(term);
    for (const word of term.split(/\s+/)) terms.add(trimPunctuation(word));
  }
  return terms;
}

function trimPunctuation(word: string): string {
  return word.replace(/^[("'“‘[{<«]+/u, "").replace(/[)"'”’\]}>».,;:!?…]+$/u, "");
}

/** Whether one word is shaped like code. */
function looksLikeCode(raw: string): boolean {
  // An unfilled template slot is reported as blank, not as code.
  if (/^\{\{\w+\}\}/.test(raw)) return false;
  if (/\w\(\)/.test(raw)) return true;
  const word = trimPunctuation(raw);
  if (word.length < 2 || MIXED_CASE_NAMES.has(word) || WEB_ADDRESS.test(word)) return false;
  return (
    /^--[a-z]/i.test(word) ||
    /[\p{L}\p{N}]_[\p{L}\p{N}]/u.test(word) ||
    /^[a-z][a-z0-9]*[A-Z]/.test(word) ||
    /\/.*\.[a-z]{1,5}$/i.test(word) ||
    CODE_FILE.test(word)
  );
}

/**
 * The code-shaped words in what a reader sees first: an inner underscore, a
 * lowercase start with a capital inside, a file path, a leading `--`, a
 * trailing `()`. `<kbd>` (what the user types) and `<dfn>`-defined terms are
 * allowed. Each word once, in page order.
 */
export function codeShapedTerms(visible: string, defined: Set<string>): string[] {
  const text = textOf(dropElements(visible, "kbd"));
  const found: string[] = [];
  for (const raw of text.split(/\s+/)) {
    if (raw.length === 0 || !looksLikeCode(raw)) continue;
    const word = /[\w.]+\(\)/.exec(raw)?.[0] ?? (trimPunctuation(raw) || raw);
    if (defined.has(word) || defined.has(raw)) continue;
    if (!found.includes(word)) found.push(word);
  }
  return found;
}

/** The `<code>` and `<pre>` elements in visible markup outside its figures, unless their text is a defined term. */
export function codeElements(visible: string, defined: Set<string>): string[] {
  const outside = dropElements(visible, "figure");
  const found: string[] = [];
  for (const m of outside.matchAll(/<(code|pre)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = textOf(m[2] ?? "").replace(/\s+/g, " ");
    if (text.length === 0 || defined.has(text)) continue;
    const shown = text.length > 40 ? `${text.slice(0, 40)}…` : text;
    if (!found.includes(shown)) found.push(shown);
  }
  return found;
}

/** "a, b, c and 4 more": a problem line's list of offending terms. */
export function nameSome(terms: string[]): string {
  const named = terms.slice(0, MAX_NAMED).map((t) => `"${t}"`).join(", ");
  return terms.length > MAX_NAMED ? `${named} and ${terms.length - MAX_NAMED} more` : named;
}
