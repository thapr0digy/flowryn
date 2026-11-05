import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { runBounded } from "../runtime/bounded.ts";
import { ensureDir, writeFileAtomic } from "../util/fsx.ts";
import { lavishSessionKey, lavishUrlKey } from "./session-key.ts";
import { WIDGET_FILE } from "./widget.ts";

/**
 * The review page the user sees is the daemon's copy, never the worker's file
 * (docs/notes/2026-11-05-one-click-approve-3y.md, "The snapshot"). A one-click
 * pass key reaches the page's frame as `document.referrer`, so any script on
 * the page could read it and Approve for the user. At `stage done`, and again
 * whenever the worker's page or its assets change while the gate is open, the
 * daemon checks the worker's page (`reviewPageProblems`: plain HTML and CSS,
 * Flowryn's widget the only script) and copies it, with its images, CSS and
 * Markdown, into `<state_dir>/review-pages/<run>/<path in the report dir>`,
 * which no worker can write. It writes the widget only there and hosts the
 * copy with lavish-axi, so the gate's review URL, its poll and the tab the
 * daemon opens are the copy's. A page that fails the check is refused at
 * `stage done`; a later revision that fails keeps the last good copy. Plain
 * code, no model.
 */

export const SNAPSHOT_ROOT = "review-pages";
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const ASSET_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".css", ".md"]);
const MAX_ASSETS = 200;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_ASSETS_TOTAL = 50 * 1024 * 1024;
const MAX_DEPTH = 4;
/** How long `lavish-axi <page> --no-open` may take: it starts the server when none runs. */
const HOST_TIMEOUT_MS = 30_000;
/** The daemon's own files beside a snapshot (the widget, the review's conversation): never taken from the worker's folder. */
const DAEMON_FILE = /^(review-.*\.md|lavish-notes-.*)$/;

// --- the page check ------------------------------------------------------------------------------

const FORBIDDEN_TAGS = new Set([
  "iframe", "frame", "frameset", "object", "embed", "applet", "base", "portal", "fencedframe", "foreignobject",
  // Raw-text elements whose content a browser and this check could split differently.
  "textarea", "xmp", "noembed", "noframes", "noscript", "plaintext",
]);
/** Elements whose content is raw text: allowed only when it holds no `<`, so it reads the same as markup or as text. */
const RAW_TEXT_TAGS = new Set(["style", "title"]);
const SCRIPT_SCHEMES = ["javascript:", "vbscript:", "data:text/html", "data:application/xhtml", "data:image/svg+xml", "data:text/xml", "data:application/xml"];
const SPACE = /[\t\n\f\r ]/;
const NAMED_ENTITIES: Record<string, string> = { colon: ":", Tab: "\t", NewLine: "\n", sol: "/", lpar: "(", rpar: ")", period: ".", comma: ",", equals: "=", nbsp: " " };

interface Tag {
  name: string;
  attrs: [string, string][];
  end: number;
}

/** Decode the character references a browser decodes in an attribute value (numeric with or without `;`, and the named ones a scheme can hide behind). */
function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => safeChar(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);?/g, (_, dec: string) => safeChar(Number.parseInt(dec, 10)))
    .replace(/&([A-Za-z]+);/g, (whole, name: string) => NAMED_ENTITIES[name] ?? whole);
}

function safeChar(code: number): string {
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "�";
}

function isBlank(code: number): boolean {
  return code <= 0x20 || (code >= 0x7f && code <= 0xa0) || (code >= 0x200b && code <= 0x200d) || code === 0x2028 || code === 0x2029 || code === 0xfeff;
}

/** A URL as a browser reads its scheme: entities decoded, blanks and control characters gone, lower case. */
function urlish(value: string): string {
  return [...decodeEntities(value)].filter((ch) => !isBlank(ch.codePointAt(0)!)).join("").toLowerCase();
}

function scriptScheme(value: string): string | null {
  const plain = urlish(value);
  return SCRIPT_SCHEMES.find((scheme) => plain.includes(scheme)) ?? null;
}

/** A tag from its name's first character, attributes split as a browser splits them; null when the page ends inside it. */
function readTag(html: string, start: number): Tag | null {
  const n = html.length;
  let i = start;
  while (i < n && !SPACE.test(html[i]!) && html[i] !== "/" && html[i] !== ">") i++;
  const name = html.slice(start, i).toLowerCase();
  const attrs: [string, string][] = [];
  for (;;) {
    while (i < n && (SPACE.test(html[i]!) || html[i] === "/")) i++;
    if (i >= n) return null;
    if (html[i] === ">") return { name, attrs, end: i + 1 };
    const nameStart = i;
    i++;
    while (i < n && !SPACE.test(html[i]!) && html[i] !== "/" && html[i] !== ">" && html[i] !== "=") i++;
    const attr = html.slice(nameStart, i).toLowerCase();
    while (i < n && SPACE.test(html[i]!)) i++;
    let value = "";
    if (html[i] === "=") {
      i++;
      while (i < n && SPACE.test(html[i]!)) i++;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, i + 1);
        if (close < 0) return null;
        value = html.slice(i + 1, close);
        i = close + 1;
      } else {
        const valueStart = i;
        while (i < n && !SPACE.test(html[i]!) && html[i] !== ">") i++;
        value = html.slice(valueStart, i);
      }
    }
    attrs.push([attr, value]);
  }
}

/** Where a comment opened at `from` (just past `<!--`) ends, as a browser ends it; -1 when it never does. */
function commentEnd(html: string, from: number): number {
  if (html.startsWith(">", from)) return from + 1;
  if (html.startsWith("->", from)) return from + 2;
  const ends = [html.indexOf("-->", from), html.indexOf("--!>", from)].filter((at) => at >= 0);
  if (ends.length === 0) return -1;
  const at = Math.min(...ends);
  return at + (html.startsWith("-->", at) ? 3 : 4);
}

function tagProblems(tag: Tag, problems: Set<string>): void {
  if (FORBIDDEN_TAGS.has(tag.name)) problems.add(`a <${tag.name}> element`);
  for (const [name, value] of tag.attrs) {
    if (name.startsWith("on")) problems.add(`an event handler attribute (${name}=)`);
    else if (name === "srcdoc") problems.add("a srcdoc attribute");
    else if (name === "formaction" || (name === "action" && tag.name === "form")) {
      if (value.trim() !== "") problems.add(`a form that posts elsewhere (${name}=)`);
    } else if (name === "http-equiv" && tag.name === "meta") problems.add("a <meta http-equiv>");
    else if (name === "rel" && tag.name === "link" && /(^|\s)import(\s|$)/.test(decodeEntities(value).toLowerCase()))problems.add('a <link rel="import">');
    else if (name === "attributename" && urlish(value).startsWith("on")) problems.add("an animated event handler (attributeName=on…)");
    const scheme = scriptScheme(value);
    if (scheme) problems.add(`a ${scheme} URL (${name}=)`);
  }
}

/** Is this the widget's mount script, exactly: `<script src="flowryn-questions.js"></script>`? */
function isWidgetScript(tag: Tag, content: string): boolean {
  return tag.attrs.length === 1 && tag.attrs[0]![0] === "src" && decodeEntities(tag.attrs[0]![1]) === WIDGET_FILE && content.trim() === "";
}

/**
 * What makes a page unsafe to show with a pass key in reach: any script other
 * than Flowryn's widget mount, an event handler, a script URL (entities and
 * blanks decoded), a frame, object or embed, a <base>, a <meta http-equiv>, a
 * <link rel="import">, an SVG <foreignObject>, a form that posts elsewhere,
 * and markup a browser could read differently from this check (a CDATA
 * section, a <style> or <title> holding `<`, a tag cut off). Empty: the page
 * is plain HTML and CSS around the widget.
 */
export function reviewPageProblems(html: string): string[] {
  const problems = new Set<string>();
  if (html.includes("\0")) problems.add("a NUL character");
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    i = lt + 1;
    if (html.startsWith("!--", i)) {
      const end = commentEnd(html, i + 3);
      if (end < 0) {
        problems.add("a comment that never closes");
        break;
      }
      i = end;
      continue;
    }
    if (html.startsWith("![CDATA[", i)) problems.add("a CDATA section");
    const c = html[i] ?? "";
    if (c === "!" || c === "?" || (c === "/" && !/[A-Za-z>]/.test(html[i + 1] ?? ""))) {
      const end = html.indexOf(">", i);
      if (end < 0) {
        if (c !== "/") problems.add(`a <${c} that never closes`);
        break;
      }
      i = end + 1;
      continue;
    }
    if (c === "/") {
      if (html[i + 1] === ">") {
        i += 2;
        continue;
      }
      const closing = readTag(html, i + 1);
      if (!closing) {
        problems.add("a tag cut off at the end of the page");
        break;
      }
      i = closing.end;
      continue;
    }
    if (!/[A-Za-z]/.test(c)) continue;
    const tag = readTag(html, i);
    if (!tag) {
      problems.add("a tag cut off at the end of the page");
      break;
    }
    i = tag.end;
    tagProblems(tag, problems);
    if (tag.name === "script") {
      const close = html.slice(i).search(/<\/script[\t\n\f\r />]/i);
      const content = close < 0 ? html.slice(i) : html.slice(i, i + close);
      if (!isWidgetScript(tag, content)) problems.add(`a <script> other than Flowryn's widget mount (<script src="${WIDGET_FILE}"></script>)`);
      if (close < 0) break;
      i += close;
    } else if (RAW_TEXT_TAGS.has(tag.name)) {
      const next = html.indexOf("<", i);
      const content = next < 0 ? html.slice(i) : html.slice(i, next);
      const closes = next >= 0 && new RegExp(`^</${tag.name}[\\t\\n\\f\\r />]`, "i").test(html.slice(next, next + tag.name.length + 3));
      if (!closes) problems.add(`a <${tag.name}> holding markup (write < as &lt;)`);
      if (tag.name === "style" && scriptScheme(content)) problems.add("a script URL in a <style>");
      if (next < 0) break;
      i = next;
    }
  }
  return [...problems];
}

// --- the copy ----------------------------------------------------------------------------------

interface Asset {
  rel: string;
  path: string;
  size: number;
  mtimeMs: number;
}

/** The page's images, CSS and Markdown under its folder: regular files only (no symlink is followed), bounded. */
function listAssets(root: string, page: string): Asset[] {
  const found: Asset[] = [];
  let total = 0;
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= MAX_ASSETS) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < MAX_DEPTH) walk(path, depth + 1);
      if (!entry.isFile() || path === page || entry.name === WIDGET_FILE || DAEMON_FILE.test(entry.name)) continue;
      if (!ASSET_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      let st;
      try {
        st = lstatSync(path);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size > MAX_ASSET_BYTES || total + st.size > MAX_ASSETS_TOTAL) continue;
      total += st.size;
      found.push({ rel: relative(root, path), path, size: st.size, mtimeMs: st.mtimeMs });
    }
  };
  walk(root, 1);
  return found;
}

/** A regular file's bytes, never through a symlink, at most `max` bytes; null otherwise. */
function readRegular(path: string, max: number): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeIfChanged(path: string, bytes: Uint8Array): boolean {
  if (existsSync(path)) {
    const before = readRegular(path, Number.MAX_SAFE_INTEGER);
    if (before && Buffer.compare(before, bytes) === 0) return false;
  }
  ensureDir(dirname(path), 0o700);
  writeFileAtomic(path, bytes, 0o644);
  return true;
}

/** Where a run's copy of a page under the report directory lives: the same path under `<state_dir>/review-pages/<run>`. */
export function snapshotPathFor(stateDir: string, runId: string, reportDir: string, page: string): string {
  const rel = relative(realpathSync(reportDir), page);
  if (rel === "" || rel.startsWith("..") || rel.split(sep).includes("..")) throw new Error(`${page} is not under ${reportDir}`);
  return join(stateDir, SNAPSHOT_ROOT, runId, rel);
}

/** A change to the worker's page or its assets changes this (sizes and times only, nothing read). */
export function sourceFingerprint(page: string): string | null {
  let st;
  try {
    st = lstatSync(page);
  } catch {
    return null;
  }
  const assets = listAssets(dirname(page), page).map((a) => `${a.rel}:${a.size}:${a.mtimeMs}`);
  return [`${st.isFile() ? "f" : "x"}:${st.size}:${st.mtimeMs}:${st.ino}`, ...assets].join("|");
}

export type Snapshot = { ok: true; page: string; changed: boolean } | { ok: false; problems: string[] };

/**
 * Check the worker's page and copy it, with its assets, to `dest`. The bytes
 * checked are the bytes written. Refused: nothing is written, and the last
 * good copy (if any) stays. Only what changed is written, so Lavish reloads
 * the tab only for a real revision.
 */
export function takeSnapshot(source: string, dest: string): Snapshot {
  const bytes = readRegular(source, MAX_PAGE_BYTES);
  if (!bytes) return { ok: false, problems: [`${source} is not a regular file of at most 5 MB`] };
  const problems = reviewPageProblems(new TextDecoder().decode(bytes));
  if (problems.length > 0) return { ok: false, problems };
  const root = dirname(source);
  const destRoot = dirname(dest);
  let changed = false;
  for (const asset of listAssets(root, source)) {
    const data = readRegular(asset.path, MAX_ASSET_BYTES);
    if (data && writeIfChanged(join(destRoot, asset.rel), data)) changed = true;
  }
  if (writeIfChanged(dest, bytes)) changed = true;
  return { ok: true, page: realpathSync(dest), changed };
}

/** What the review page refusal says, for `stage done` and the worker's steer. */
export function refusalText(problems: string[]): string {
  return `the review page carries ${problems.join("; ")}`;
}

export const REFUSAL_HINT = `a review page is plain HTML and CSS: Flowryn's widget (<script src="${WIDGET_FILE}"></script>) is its only script, with no event handlers, frames or script URLs`;

/** The copy's Lavish URL: the worker's URL (its host and port) naming the copy's session. */
export function snapshotUrl(workerUrl: string, page: string): string {
  return workerUrl.replace(/\/session\/[0-9a-f]{16}$/, `/session/${lavishSessionKey(page)}`);
}

/** Host the copy with lavish-axi (the session must exist before a poll), and check the URL it prints names the copy. */
export async function hostSnapshot(lavish: string, page: string): Promise<string> {
  const result = await runBounded([lavish, page, "--no-open"], { label: "lavish-axi host", timeoutMs: HOST_TIMEOUT_MS, env: { ...process.env, LAVISH_AXI_NO_OPEN: "1" } });
  if (result.code !== 0) throw new Error(`lavish-axi exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(0, 200)}`);
  const url = /https?:\/\/[^\s"'/?#]{1,253}\/session\/[0-9a-f]{16}/.exec(result.stdout)?.[0] ?? null;
  const expected = lavishSessionKey(page);
  if (!url || lavishUrlKey(url) !== expected) throw new Error(`lavish-axi did not print the copy's session ${expected}`);
  return url;
}

// --- the gate's copy ------------------------------------------------------------------------------

export interface SnapshotGate {
  id: string;
  run_id: string;
  task_id: string;
  page_path: string;
  source_page: string;
}

/** Open gates on live runs whose page is the daemon's copy of a worker's page. */
export function snapshotGates(db: Db): SnapshotGate[] {
  return db
    .query(
      `SELECT g.id, g.run_id, r.task_id, g.page_path, g.source_page FROM gates g JOIN runs r ON r.id = g.run_id
       WHERE g.state = 'open' AND r.state NOT IN ('cleaned','failed','cancelled') AND g.page_path IS NOT NULL AND g.source_page IS NOT NULL ORDER BY g.opened_at`,
    )
    .all() as SnapshotGate[];
}

export type Refresh = { outcome: "same" | "updated" | "gone" } | { outcome: "refused"; problems: string[] };

/**
 * Copy the worker's revised page over the gate's copy, or refuse it (event
 * gate.page_refused with the problems) and keep the last good copy. Call
 * inside a transaction.
 */
export function refreshSnapshot(db: Db, gate: Pick<SnapshotGate, "id" | "run_id" | "task_id" | "page_path" | "source_page">, now: number): Refresh {
  if (!existsSync(gate.source_page)) return { outcome: "gone" };
  const taken = takeSnapshot(gate.source_page, gate.page_path);
  if (!taken.ok) {
    appendEvent(db, { source: "daemon", kind: "gate.page_refused", runId: gate.run_id, taskId: gate.task_id, payload: { gate: gate.id, problems: taken.problems }, ts: now });
    return { outcome: "refused", problems: taken.problems };
  }
  if (!taken.changed) return { outcome: "same" };
  appendEvent(db, { source: "daemon", kind: "gate.page_copied", runId: gate.run_id, taskId: gate.task_id, payload: { gate: gate.id }, ts: now });
  return { outcome: "updated" };
}
