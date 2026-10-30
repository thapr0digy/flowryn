import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../util/fsx.ts";
import { ANSWER_MARK } from "./poll-output.ts";
import { OTHER_ANSWER, type DecidedChoice, type QuestionKind } from "./questions.ts";

/**
 * The question widget (lavish-axi's input playbook): Flowryn writes
 * `flowryn-questions.js` next to the review page, and the page mounts it with
 * `<section id="flowryn-questions"></section><script src="flowryn-questions.js"></script>`.
 * The file is a fixed renderer plus the gate's state as JSON, so every page
 * asks the same way: radios with the recommendation preselected, checkboxes
 * for a multi choice, an "Other" choice beside the options (the user says what
 * in the question's note), a text field for a free answer, one "anything else
 * for the worker" box, and one Send that queues a single prompt carrying every
 * answer (`flowryn-answers v2 <token>`) and sends it. "Send and pass" adds a
 * pass: with the field for the pass code empty it asks for one (the daemon
 * sends it to your notifications, and opens the leader's pass request); with
 * the code typed in, the daemon passes the gate (src/policy/page-pass.ts).
 * Flowryn rewrites the file whenever a question's
 * state changes; a page whose root carries data-lavish-live-reload-root
 * reloads, and an answered question shows locked, whichever channel answered.
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
(function (S, MARK, OTHER) {
  var mount = document.getElementById("flowryn-questions");
  if (!mount) return;
  var css = ".fq{font:inherit;color:inherit;display:grid;gap:1rem}.fq h3{margin:0;font-size:1.15em}" +
    ".fq .fq-q{border-left:3px solid currentColor;padding:.2rem 0 .2rem .9rem;display:grid;gap:.35rem}" +
    ".fq .fq-q.fq-done{opacity:.75;border-left-style:dashed}.fq .fq-meta{font-size:.8em;opacity:.75}" +
    ".fq label{display:flex;gap:.5rem;align-items:center;cursor:pointer}.fq .fq-rec{font-size:.72em;border:1px solid currentColor;border-radius:999px;padding:0 .45em;opacity:.8}" +
    ".fq input[type=text],.fq textarea{font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in oklab,currentColor 35%,transparent);border-radius:.4rem;padding:.35rem .5rem;width:100%;max-width:36rem}" +
    ".fq .fq-actions{display:flex;flex-wrap:wrap;gap:.6rem}" +
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
  var asking = openCount > 0 && S.gateState === "open";
  form.appendChild(el("h3", { text: S.gateState !== "open" ? "Questions, review closed" : openCount > 0 ? "Questions for you" : "Questions, all answered" }));
  form.appendChild(el("div", { "class": "fq-meta", text: "Only you can answer these. The recommended answer is picked already: change any you disagree with, then press Send once for all of them. You can also answer in chat with your leader; the first answer counts." }));
  form.appendChild(el("div", { "class": "fq-meta", text: "The " + S.stage + " review, gate " + S.gate + "." }));
  if (S.decided.length) {
    form.appendChild(el("div", { "class": "fq-meta", text: "Already decided by the worker (send the review back if you disagree):" }));
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
      var type = q.kind === "multi" ? "checkbox" : "radio";
      q.options.forEach(function (o) {
        var rec = q.recommend.indexOf(o) >= 0;
        box.appendChild(el("label", {}, [
          el("input", { type: type, name: q.id, value: o, checked: rec }),
          el("span", { text: o }),
          rec ? el("span", { "class": "fq-rec", text: "recommended" }) : null,
        ]));
      });
      box.appendChild(el("label", {}, [el("input", { type: type, name: q.id, value: OTHER }), el("span", { text: "Other: say what in the note below" })]));
    }
    box.appendChild(el("input", { type: "text", name: q.id + "-note", placeholder: q.kind === "text" ? "Optional note for the worker" : "Note for the worker, or your own answer when you pick Other", "aria-label": "Note on " + q.id }));
    form.appendChild(box);
  });
  var status = el("div", { "class": "fq-status", role: "status" });
  var commentBox = null, codeBox = null;
  if (asking) {
    form.appendChild(el("label", { "class": "fq-meta", "for": "fq-comment-" + S.gate, text: "Anything else for the worker (optional)" }));
    commentBox = form.appendChild(el("textarea", { id: "fq-comment-" + S.gate, name: "fq-comment", rows: "3", "aria-label": "Anything else for the worker" }));
    form.appendChild(el("label", { "class": "fq-meta", "for": "fq-code-" + S.gate, text: "Pass code (from your notification)" }));
    codeBox = form.appendChild(el("input", { type: "text", id: "fq-code-" + S.gate, name: "fq-code", maxlength: "8", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", "aria-label": "Pass code", style: "max-width:8rem;text-transform:uppercase;letter-spacing:.2em" }));
    form.appendChild(el("div", { "class": "fq-actions" }, [
      el("button", { type: "submit", value: "send", text: "Send answers" }),
      el("button", { type: "submit", value: "pass", "data-pass": true, text: "Send and pass" }),
    ]));
    form.appendChild(el("div", { "class": "fq-meta", text: "To pass here: press Send and pass with the code empty, and Flowryn sends a 4-letter code to your notifications; type it in and press Send and pass again. Without a code, your leader asks you to confirm the pass instead." }));
  }
  form.appendChild(status);
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var pass = !!(event.submitter && event.submitter.getAttribute && event.submitter.getAttribute("data-pass") !== null);
    if (!window.lavish || !window.lavish.queuePrompt) {
      status.textContent = "Open this page through Lavish to answer here, or tell your leader your answers.";
      return;
    }
    var data = new FormData(form), answers = [], lines = [], shown = [], empty = [], problems = [];
    S.questions.forEach(function (q) {
      if (q.state !== "open") return;
      var choice = q.kind === "text" ? [String(data.get(q.id) || "").trim()].filter(Boolean) : data.getAll(q.id).map(String);
      var note = String(data.get(q.id + "-note") || "").trim();
      if (!choice.length) { empty.push(q.id); return; }
      if (choice.indexOf(OTHER) >= 0 && !note) { problems.push(q.id + ": say what Other means in its note"); return; }
      answers.push({ d: q.id, c: choice, n: note });
      lines.push("- " + q.id + " (" + q.question + "): " + choice.join(", ") + (note ? " — " + note : ""));
      shown.push(q.id + ": " + choice.join(", "));
    });
    var comment = String(data.get("fq-comment") || "").trim();
    var code = pass ? String(data.get("fq-code") || "").trim().toUpperCase() : "";
    if (problems.length) { status.textContent = "Nothing sent. " + problems.join("; ") + "."; return; }
    if (pass && empty.length) { status.textContent = "Nothing sent. A pass needs every question answered: " + empty.join(", ") + " is empty."; return; }
    if (!answers.length && !comment && !pass) { status.textContent = "Nothing to send: every open question is empty."; return; }
    var text = "Answers for the " + S.stage + " review (gate " + S.gate + "):\n" + (lines.length ? lines.join("\n") : "- (no answers)") +
      (comment ? "\nAnything else: " + comment : "") + (pass ? (code ? "\nPass this review (with the pass code)." : "\nPlease pass this review; send me a pass code.") : "") +
      "\n" + MARK + " " + b64url(JSON.stringify(code ? { g: S.gate, a: answers, m: comment, p: pass, k: code } : { g: S.gate, a: answers, m: comment, p: pass }));
    window.lavish.queuePrompt(text, {
      tag: "choice", text: (shown.length ? shown.join("; ") : "No answers") + (pass ? (code ? " · pass with code" : " · pass code requested") : ""), queueKey: "flowryn:" + S.gate, target: { type: "flowryn-answers", gate: S.gate },
    });
    if (commentBox) commentBox.value = "";
    if (codeBox) codeBox.value = "";
    if (window.lavish.sendQueuedPrompts) window.lavish.sendQueuedPrompts();
    status.textContent = "Sent to Flowryn: " + (shown.length ? shown.join("; ") : "no answers") + (comment ? "; your note for the worker" : "") +
      (pass ? (code ? "; your pass code (Flowryn checks it and replies here)" : "; a pass request (a code goes to your notifications)") : "") + ". Each question locks here once recorded." + (empty.length ? " Still open: " + empty.join(", ") + "." : "");
  });
  mount.replaceChildren(form);
})`;

/** The widget file for a gate's state. */
export function renderWidget(state: WidgetState): string {
  return `// Written by Flowryn for gate ${state.gate}; it is rewritten when a question's state changes.\n${RENDERER.trim()}(${JSON.stringify(state)}, ${JSON.stringify(ANSWER_MARK)}, ${JSON.stringify(OTHER_ANSWER)});\n`;
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
