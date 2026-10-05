import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../util/fsx.ts";
import { ANSWER_MARK } from "./poll-output.ts";
import type { DecidedChoice, QuestionKind } from "./questions.ts";

/**
 * The question widget (lavish-axi's input playbook): Flowryn writes
 * `flowryn-questions.js` next to the review page, and the page mounts it with
 * `<section id="flowryn-questions"></section><script src="flowryn-questions.js"></script>`.
 * The file is a fixed renderer plus the gate's state as JSON, so every page
 * asks the same way: radios with the recommendation preselected, checkboxes
 * for a multi choice, a text field for a free answer, an optional note each,
 * and one Submit that queues one prompt per answered question and sends them.
 * Flowryn rewrites the file whenever a question's state changes; a page whose
 * root carries data-lavish-live-reload-root reloads, and an answered question
 * shows locked, whichever channel answered it.
 */

export const WIDGET_FILE = "flowryn-questions.js";
export const WIDGET_MOUNT = 'id="flowryn-questions"';

export interface WidgetQuestion {
  id: string;
  key: string;
  kind: QuestionKind;
  question: string;
  options: string[];
  recommend: string[];
  blocks: string;
  why: string | null;
  state: "open" | "answered" | "dismissed";
  answer: string | null;
  via: string | null;
}

export interface WidgetState {
  gate: string;
  task: string;
  stage: string;
  gateState: "open" | "passed" | "changes";
  decided: DecidedChoice[];
  questions: WidgetQuestion[];
}

/** The mount the page must carry, as the refusal shows it. */
export const MOUNT_SNIPPET = `<section ${WIDGET_MOUNT}></section><script src="${WIDGET_FILE}"></script> (and data-lavish-live-reload-root on <html>)`;

/** Does the page mount the widget? */
export function pageMountsWidget(html: string): boolean {
  return html.includes(WIDGET_MOUNT) && html.includes(WIDGET_FILE);
}

export function widgetPath(pagePath: string): string {
  return join(dirname(pagePath), WIDGET_FILE);
}

// The renderer runs in the reviewer's browser, inside Lavish's sandboxed frame.
// It never reaches Flowryn: answers leave only through window.lavish.queuePrompt.
const RENDERER = String.raw`
(function (S, MARK) {
  var mount = document.getElementById("flowryn-questions");
  if (!mount) return;
  var css = ".fq{font:inherit;color:inherit;display:grid;gap:1rem}.fq h3{margin:0;font-size:1.15em}" +
    ".fq .fq-q{border-left:3px solid currentColor;padding:.2rem 0 .2rem .9rem;display:grid;gap:.35rem}" +
    ".fq .fq-q.fq-done{opacity:.75;border-left-style:dashed}.fq .fq-meta{font-size:.8em;opacity:.75}" +
    ".fq label{display:flex;gap:.5rem;align-items:center;cursor:pointer}.fq .fq-rec{font-size:.72em;border:1px solid currentColor;border-radius:999px;padding:0 .45em;opacity:.8}" +
    ".fq input[type=text],.fq textarea{font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in oklab,currentColor 35%,transparent);border-radius:.4rem;padding:.35rem .5rem;width:100%;max-width:36rem}" +
    ".fq button{font:inherit;padding:.4rem 1rem;border-radius:.5rem;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer}" +
    ".fq .fq-status{font-size:.85em;opacity:.85}.fq ul{margin:.2rem 0 0 1.1rem;padding:0}.fq code{font-size:.9em}";
  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  function el(tag, attrs, kids) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "text") node.textContent = attrs[k];
      else if (attrs[k] === true) node.setAttribute(k, "");
      else if (attrs[k] !== false && attrs[k] != null) node.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (kid) { if (kid) node.appendChild(kid); });
    return node;
  }
  function b64url(text) {
    var bytes = new TextEncoder().encode(text), bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  var form = el("form", { "class": "fq", "data-lavish-question": "flowryn-" + S.gate });
  var openCount = S.questions.filter(function (q) { return q.state === "open"; }).length;
  form.appendChild(el("h3", { text: (S.gateState !== "open" ? "Questions, review closed" : openCount > 0 ? "Open questions" : "Questions, all answered") + " (" + S.stage + " review, gate " + S.gate + ")" }));
  form.appendChild(el("div", { "class": "fq-meta", text: "Each is a Flowryn decision reserved for you. Answer here, or tell your leader (flowryn decide <id> <choice> --by captain); the first answer counts." }));
  if (S.decided.length) {
    form.appendChild(el("div", { "class": "fq-meta", text: "Decided by the worker (send the review back if you disagree):" }));
    form.appendChild(el("ul", {}, S.decided.map(function (d) {
      return el("li", { text: d.choice + ": " + d.picked + " (" + d.why + ")" });
    })));
  }
  S.questions.forEach(function (q) {
    var done = q.state !== "open" || S.gateState !== "open";
    var box = el("fieldset", { "class": "fq-q" + (done ? " fq-done" : ""), "data-decision": q.id });
    box.appendChild(el("legend", { text: q.id + " · " + q.question }));
    box.appendChild(el("div", { "class": "fq-meta", text: "Blocks: " + q.blocks + (q.why ? " · Why it matters: " + q.why : "") }));
    if (done) {
      var said = q.state === "answered" ? "Answered" + (q.via ? " via " + q.via : "") + ": " + q.answer : q.state === "dismissed" ? "Closed: the review was sent back" : "The review is closed";
      box.appendChild(el("div", { "class": "fq-status", text: said }));
      form.appendChild(box);
      return;
    }
    if (q.kind === "text") {
      box.appendChild(el("input", { type: "text", name: q.id, placeholder: q.recommend[0] || "", "aria-label": q.question }));
      box.appendChild(el("div", { "class": "fq-meta", text: "Leave it empty to keep it open; the worker's default: " + (q.recommend[0] || "-") }));
    } else {
      q.options.forEach(function (o) {
        var rec = q.recommend.indexOf(o) >= 0;
        box.appendChild(el("label", {}, [
          el("input", { type: q.kind === "multi" ? "checkbox" : "radio", name: q.id, value: o, checked: rec }),
          el("span", { text: o }),
          rec ? el("span", { "class": "fq-rec", text: "recommended" }) : null,
        ]));
      });
    }
    box.appendChild(el("input", { type: "text", name: q.id + "-note", placeholder: "Optional note for the worker", "aria-label": "Note on " + q.id }));
    form.appendChild(box);
  });
  var status = el("div", { "class": "fq-status", role: "status" });
  if (openCount > 0 && S.gateState === "open") form.appendChild(el("div", {}, [el("button", { type: "submit", text: "Submit answers" })]));
  form.appendChild(status);
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (!window.lavish || !window.lavish.queuePrompt) {
      status.textContent = "Open this page through Lavish to answer here, or tell your leader your answers.";
      return;
    }
    var data = new FormData(form), sent = [];
    S.questions.forEach(function (q) {
      if (q.state !== "open") return;
      var choice = q.kind === "text" ? [String(data.get(q.id) || "").trim()].filter(Boolean) : data.getAll(q.id).map(String);
      if (!choice.length) return;
      var note = String(data.get(q.id + "-note") || "").trim();
      var token = b64url(JSON.stringify({ g: S.gate, d: q.id, c: choice, n: note }));
      var shown = choice.join(", ");
      window.lavish.queuePrompt("Answer to " + q.id + " (" + q.question + "): " + shown + (note ? " (" + note + ")" : "") + "\n" + MARK + " " + token, {
        tag: "choice", text: q.id + ": " + shown, queueKey: "flowryn:" + q.id, target: { type: "flowryn-answer", decision: q.id },
      });
      sent.push(q.id + ": " + shown);
    });
    if (!sent.length) { status.textContent = "Nothing to send: every open question is empty."; return; }
    if (window.lavish.sendQueuedPrompts) window.lavish.sendQueuedPrompts();
    status.textContent = "Sent to Flowryn: " + sent.join("; ") + ". Each locks here once recorded.";
  });
  mount.replaceChildren(form);
})`;

/** The widget file for a gate's state. */
export function renderWidget(state: WidgetState): string {
  return `// Written by Flowryn for gate ${state.gate}; it is rewritten when a question's state changes.\n${RENDERER.trim()}(${JSON.stringify(state)}, ${JSON.stringify(ANSWER_MARK)});\n`;
}

/**
 * The page's directory is still the real one checked when the gate opened
 * (checkReviewPage stores the page's real path): the worker can write there,
 * so a directory swapped for a symlink must not move the daemon's writes.
 */
export function requirePageDir(pagePath: string): string {
  const dir = dirname(pagePath);
  if (realpathSync(dir) !== dir) throw new Error(`${dir} now resolves elsewhere (a symlink); not writing there`);
  return dir;
}

/** Write the widget next to the page when its content changed. Returns whether it wrote. */
export function writeWidget(pagePath: string, state: WidgetState): boolean {
  requirePageDir(pagePath);
  const path = widgetPath(pagePath);
  const content = renderWidget(state);
  if (existsSync(path) && readFileSync(path, "utf8") === content) return false;
  writeFileAtomic(path, content, 0o644);
  return true;
}
