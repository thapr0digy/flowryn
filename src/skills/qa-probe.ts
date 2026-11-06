/**
 * The visual QA stage's measuring script (docs/notes/2026-11-06-make-the-visual-nx.md):
 * one function expression the QA worker runs in the page under test with
 * `chrome-devtools-axi eval "$(cat qa-probe.js)"`, written next to the skill's
 * SKILL.md. Plain code, no model: it reads geometry, computed styles and
 * accessible names, and returns one JSON object of what it measured
 * (overflow, clipping, overlaps, images, contrast, names, focus, the style
 * inventory and, when the worker set `window.__flowrynTokens` from DESIGN.md,
 * the values outside those tokens). It reads no cookies or storage and makes
 * no requests; page text comes back only as 60-character snippets.
 *
 * The helpers are one JavaScript source, `PROBE_HELPERS`, that both the probe
 * and the unit tests run, so the tests check the code the page runs.
 */

export const QA_PROBE_FILE = "qa-probe.js";

/** The global the worker sets from its tokens file before running the probe. */
export const QA_TOKENS_GLOBAL = "__flowrynTokens";

/** How many entries each list keeps; the rest are counted in `truncated`. */
export const QA_PROBE_LIST_MAX = 50;

/** How many characters of page text a finding quotes. */
export const QA_PROBE_SNIPPET_MAX = 60;

/** Pure helpers, plain JavaScript: colour parsing, WCAG contrast, the token comparison. */
const PROBE_HELPERS = String.raw`
function parseColor(input) {
  if (typeof input !== "string") return null;
  const s = input.trim().toLowerCase();
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? Math.round((n(6) / 255) * 1000) / 1000 : 1 };
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    let a = 1;
    if (m[4] !== undefined) a = m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: Math.round(+m[1]), g: Math.round(+m[2]), b: Math.round(+m[3]), a: Math.round(a * 1000) / 1000 };
  }
  return null;
}

function colorKey(c) {
  return "rgba(" + c.r + ", " + c.g + ", " + c.b + ", " + c.a + ")";
}

function blend(top, bottom) {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (t, b) => Math.round((t * top.a + b * bottom.a * (1 - top.a)) / a);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: Math.round(a * 1000) / 1000 };
}

function relativeLuminance(c) {
  const ch = (v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

function contrastRatio(fg, bg) {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function isLargeText(px, weight) {
  return px >= 24 || (px >= 18.66 && weight >= 700);
}

function requiredContrast(px, weight) {
  return isLargeText(px, weight) ? 3 : 4.5;
}

function primaryFamily(stack) {
  const first = String(stack).split(",")[0] || "";
  return first.trim().replace(/^["']|["']$/g, "").toLowerCase();
}

function normLength(v) {
  const s = String(v).trim().toLowerCase();
  const m = /^(-?[\d.]+)(px|rem)?$/.exec(s);
  if (!m) return s;
  const n = m[2] === "rem" ? parseFloat(m[1]) * 16 : parseFloat(m[1]);
  return Math.round(n * 100) / 100 + "px";
}

function normWeight(v) {
  const s = String(v).trim().toLowerCase();
  if (s === "normal") return "400";
  if (s === "bold") return "700";
  return s;
}

const TOKEN_KINDS = {
  colors: (v) => { const c = parseColor(v); return c ? colorKey(c) : String(v).trim().toLowerCase(); },
  fontFamilies: primaryFamily,
  fontSizes: normLength,
  fontWeights: normWeight,
  radii: normLength,
  spacing: normLength,
};

function offTokens(inventory, tokens) {
  if (!tokens || typeof tokens !== "object") return null;
  const out = [];
  for (const kind of Object.keys(TOKEN_KINDS)) {
    const allowed = tokens[kind];
    if (!Array.isArray(allowed) || !inventory[kind]) continue;
    const norm = TOKEN_KINDS[kind];
    const set = new Set(allowed.map((v) => norm(v)));
    for (const entry of inventory[kind]) {
      if (!set.has(norm(entry.value))) out.push({ kind: kind, value: entry.value, count: entry.count, examples: entry.examples });
    }
  }
  return out;
}
`;

/** The page walk: everything that needs a DOM. Runs after the helpers, inside the probe's function. */
const PROBE_WALK = String.raw`
const MAX = ${QA_PROBE_LIST_MAX};
const SNIP = ${QA_PROBE_SNIPPET_MAX};
const errors = [];
const lists = { overflow: [], clipped: [], overlaps: [], images: [], contrast: [], contrastUnknown: [], names: [] };
const snippet = (t) => String(t || "").replace(/\s+/g, " ").trim().slice(0, SNIP);
const ownSelector = (el) => {
  let s = el.tagName.toLowerCase();
  if (el.id) s += "#" + el.id;
  const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : [];
  if (cls.length) s += "." + cls.join(".");
  return s;
};
const selectorOf = (el) => {
  if (!el || !el.tagName) return "";
  const parent = el.parentElement;
  return ((parent && parent !== document.body && parent.tagName ? ownSelector(parent) + " > " : "") + ownSelector(el)).slice(0, 100);
};
const visible = (el, cs) => {
  if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
};
const vw = window.innerWidth;
const vh = window.innerHeight;
const inv = { colors: new Map(), fontFamilies: new Map(), fontSizes: new Map(), fontWeights: new Map(), radii: new Map(), spacing: new Map() };
const lastNoted = new Map();
const note = (kind, value, el) => {
  if (value === "" || value === undefined || value === null) return;
  const key = kind + "|" + value;
  if (lastNoted.get(key) === el) return;
  lastNoted.set(key, el);
  const m = inv[kind];
  const e = m.get(value) || { value: value, count: 0, examples: [] };
  e.count++;
  const sel = selectorOf(el);
  if (e.examples.length < 3 && !e.examples.includes(sel)) e.examples.push(sel);
  m.set(value, e);
};
const scrollsX = (el) => {
  for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
    const o = getComputedStyle(p).overflowX;
    if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") return true;
  }
  return false;
};
const interactive = [];
const all = Array.from(document.body ? document.body.querySelectorAll("*") : []).slice(0, 5000);
if (document.body && document.body.querySelectorAll("*").length > 5000) errors.push("walked the first 5000 elements only");
for (const el of all) {
  try {
    const cs = getComputedStyle(el);
    if (!visible(el, cs)) continue;
    const r = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    if ((r.right > vw + 1 || r.left < -1) && !scrollsX(el)) lists.overflow.push({ selector: selectorOf(el), left: Math.round(r.left), right: Math.round(r.right), viewport: vw });
    const ownText = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
    const hidesX = cs.overflowX === "hidden" || cs.overflowX === "clip";
    const hidesY = cs.overflowY === "hidden" || cs.overflowY === "clip";
    if ((hidesX && el.scrollWidth > el.clientWidth + 1) || (hidesY && el.scrollHeight > el.clientHeight + 1)) {
      if (el.textContent && el.textContent.trim()) lists.clipped.push({ selector: selectorOf(el), text: snippet(el.textContent), ellipsis: cs.textOverflow === "ellipsis", scroll: [el.scrollWidth, el.scrollHeight], box: [el.clientWidth, el.clientHeight] });
    }
    if (ownText) {
      note("fontFamilies", primaryFamily(cs.fontFamily), el);
      note("fontSizes", normLength(cs.fontSize), el);
      note("fontWeights", normWeight(cs.fontWeight), el);
      const fg = parseColor(cs.color);
      if (fg && fg.a > 0) note("colors", colorKey(fg), el);
      let bg = { r: 0, g: 0, b: 0, a: 0 };
      let unknown = null;
      for (let p = el; p; p = p.parentElement) {
        const ps = getComputedStyle(p);
        if (ps.backgroundImage && ps.backgroundImage !== "none") { unknown = "background image or gradient under the text"; break; }
        const c = parseColor(ps.backgroundColor);
        if (c && c.a > 0) bg = blend(bg, c);
        if (bg.a >= 1) break;
      }
      if (!unknown && bg.a < 1) bg = blend(bg, { r: 255, g: 255, b: 255, a: 1 });
      const px = parseFloat(cs.fontSize);
      const weight = parseInt(normWeight(cs.fontWeight), 10) || 400;
      const need = requiredContrast(px, weight);
      if (unknown) lists.contrastUnknown.push({ selector: selectorOf(el), text: snippet(ownText), reason: unknown });
      else if (fg) {
        const ratio = contrastRatio(blend(fg, bg), bg);
        if (ratio < need) lists.contrast.push({ selector: selectorOf(el), text: snippet(ownText), ratio: Math.round(ratio * 100) / 100, required: need, fg: colorKey(fg), bg: colorKey(bg), fontSize: cs.fontSize, fontWeight: cs.fontWeight });
      }
    }
    const bgc = parseColor(cs.backgroundColor);
    if (bgc && bgc.a > 0) note("colors", colorKey(bgc), el);
    for (const side of ["Top", "Right", "Bottom", "Left"]) {
      if (parseFloat(cs["border" + side + "Width"]) > 0 && cs["border" + side + "Style"] !== "none") {
        const bc = parseColor(cs["border" + side + "Color"]);
        if (bc && bc.a > 0) note("colors", colorKey(bc), el);
      }
    }
    for (const corner of ["TopLeft", "TopRight", "BottomRight", "BottomLeft"]) {
      const v = cs["border" + corner + "Radius"];
      if (v && parseFloat(v) > 0) note("radii", normLength(v), el);
    }
    for (const prop of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "rowGap", "columnGap"]) {
      const v = cs[prop];
      if (v && parseFloat(v) > 0) note("spacing", normLength(v), el);
    }
    if (tag === "img") {
      if (el.complete && el.naturalWidth === 0) lists.images.push({ selector: selectorOf(el), problem: "broken: the image did not load" });
      else if (!el.hasAttribute("width") && !el.hasAttribute("height") && (cs.aspectRatio === "auto" || !cs.aspectRatio)) lists.images.push({ selector: selectorOf(el), problem: "no width or height attribute and no aspect ratio: the layout shifts as it loads" });
      if (!el.hasAttribute("alt")) lists.names.push({ selector: selectorOf(el), problem: "image without alt (use alt=\"\" for a decorative one)" });
    }
    const role = el.getAttribute("role");
    const isControl = (tag === "input" && el.type !== "hidden") || tag === "select" || tag === "textarea";
    const isAction = tag === "button" || (tag === "a" && el.hasAttribute("href")) || role === "button" || role === "link";
    if (isControl || isAction || el.hasAttribute("tabindex")) interactive.push({ el: el, r: r });
    const named = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.getAttribute("title");
    if (isControl && !named) {
      const labelled = (el.labels && el.labels.length > 0) || el.closest("label");
      if (!labelled && !["submit", "button", "reset", "image"].includes(el.type)) lists.names.push({ selector: selectorOf(el), problem: el.getAttribute("placeholder") ? "form field labelled by its placeholder only" : "form field without a label" });
    }
    if (isAction && !named) {
      const text = (el.innerText || "").trim();
      const imgAlt = Array.from(el.querySelectorAll("img[alt], svg[aria-label]")).some((i) => (i.getAttribute("alt") || i.getAttribute("aria-label") || "").trim());
      if (!text && !imgAlt) lists.names.push({ selector: selectorOf(el), problem: tag === "a" ? "link with no accessible name" : "button with no accessible name" });
    }
  } catch (e) {
    errors.push(String(e && e.message ? e.message : e).slice(0, 120));
  }
}
const pairs = interactive.slice(0, 300);
for (let i = 0; i < pairs.length; i++) {
  for (let j = i + 1; j < pairs.length; j++) {
    const a = pairs[i], b = pairs[j];
    if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
    const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
    const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
    if (w > 2 && h > 2) lists.overlaps.push({ a: selectorOf(a.el), b: selectorOf(b.el), overlap: [Math.round(w), Math.round(h)] });
  }
}
const active = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
const acs = active ? getComputedStyle(active) : null;
const focus = active ? { selector: selectorOf(active), text: snippet(active.innerText || active.getAttribute("aria-label") || ""), outline: acs.outlineStyle + " " + acs.outlineWidth + " " + acs.outlineColor, boxShadow: acs.boxShadow } : null;
const inventory = {};
for (const kind of Object.keys(inv)) inventory[kind] = Array.from(inv[kind].values()).sort((x, y) => y.count - x.count);
const tokens = window[${JSON.stringify(QA_TOKENS_GLOBAL)}];
const off = offTokens(inventory, tokens);
const truncated = {};
const capped = {};
for (const k of Object.keys(lists)) {
  capped[k] = lists[k].slice(0, MAX);
  if (lists[k].length > MAX) truncated[k] = lists[k].length - MAX;
}
for (const kind of Object.keys(inventory)) {
  if (inventory[kind].length > MAX) truncated["inventory." + kind] = inventory[kind].length - MAX;
  inventory[kind] = inventory[kind].slice(0, MAX);
}
const page = document.documentElement;
return {
  url: location.origin + location.pathname,
  viewport: { width: vw, height: vh, dpr: window.devicePixelRatio },
  theme: window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  pageOverflow: page.scrollWidth > vw + 1 ? { scrollWidth: page.scrollWidth, viewport: vw } : null,
  overflow: capped.overflow,
  clipped: capped.clipped,
  overlaps: capped.overlaps,
  images: capped.images,
  contrast: capped.contrast,
  contrastUnknown: capped.contrastUnknown,
  names: capped.names,
  focus: focus,
  inventory: inventory,
  offToken: off ? off.slice(0, MAX) : null,
  truncated: truncated,
  errors: errors.slice(0, 20),
};
`;

/** The probe, as written to qa-probe.js: a function expression that never throws. */
export const QA_PROBE = `() => {
  // Flowryn visual QA probe: measures the page; reads no cookies or storage, makes no requests.
  // Run: chrome-devtools-axi eval "$(cat qa-probe.js)". Set window.${QA_TOKENS_GLOBAL} first to compare with DESIGN.md's tokens.
  try {
${PROBE_HELPERS}
${PROBE_WALK}
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
}
`;

export interface ProbeColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface InventoryEntry {
  value: string;
  count: number;
  examples: string[];
}

export type TokenKind = "colors" | "fontFamilies" | "fontSizes" | "fontWeights" | "radii" | "spacing";

export interface ProbeHelpers {
  parseColor(input: string): ProbeColor | null;
  colorKey(c: ProbeColor): string;
  blend(top: ProbeColor, bottom: ProbeColor): ProbeColor;
  relativeLuminance(c: ProbeColor): number;
  contrastRatio(fg: ProbeColor, bg: ProbeColor): number;
  isLargeText(px: number, weight: number): boolean;
  requiredContrast(px: number, weight: number): number;
  primaryFamily(stack: string): string;
  normLength(v: string): string;
  offTokens(inventory: Partial<Record<TokenKind, InventoryEntry[]>>, tokens: Partial<Record<TokenKind, string[]>> | null | undefined): { kind: TokenKind; value: string; count: number; examples: string[] }[] | null;
}

/** The probe's own helpers, for tests: the same source the page runs. */
export function probeHelpers(): ProbeHelpers {
  return new Function(`${PROBE_HELPERS}\nreturn { parseColor, colorKey, blend, relativeLuminance, contrastRatio, isLargeText, requiredContrast, primaryFamily, normLength, offTokens };`)() as ProbeHelpers;
}
