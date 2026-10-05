import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openItem } from "../../src/attention/items.ts";
import { tx, type Db } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { ANSWER_MARK, encodeAnswer, encodeSend, parsePollOutput } from "../../src/lavish/poll-output.ts";
import { normalizeAnswer, parseGateQuestions } from "../../src/lavish/questions.ts";
import { pageMountsWidget, renderWidget, WIDGET_FILE, writeWidget, type WidgetState } from "../../src/lavish/widget.ts";
import { LavishPoller } from "../../src/lavish/poller.ts";
import { answerDecision, lavishAnswer } from "../../src/lifecycle/decision-verbs.ts";
import { getDecision } from "../../src/lifecycle/decisions.ts";
import { checkReviewPage, dismissGateQuestions, gateAnswersNote, gateQuestionsLine, gatesToPoll, gatesWithWidget, openGateQuestions, recordGateComment, requestGatePass, requireGateAnswered, widgetState } from "../../src/lifecycle/gate-questions.ts";
import { cancelRun, failRun, getRun } from "../../src/lifecycle/runs.ts";
import { createRun } from "../../src/lifecycle/dispatch.ts";
import { getProject } from "../../src/lifecycle/projects.ts";
import { defaultConfig } from "../../src/config/config.ts";
import { DEFAULT_WORKFLOWS } from "../../src/config/workflows.ts";
import { makeHome, seedRun, waitUntil, type TestHome } from "../helpers/harness.ts";

/**
 * A review gate's questions (design: "A design's open questions become
 * Flowryn decisions"). The poll output samples are what lavish-axi 0.1.65
 * printed for a real session (a scratch LAVISH_AXI_STATE_DIR, prompts posted
 * to its API, then `lavish-axi poll --timeout-ms`), kept verbatim.
 */

const QUESTIONS = {
  questions: [
    { key: "token-store", kind: "single", question: "Where do cached tokens live?", options: ["db", "file"], recommend: "db", blocks: "which store TokenCache writes to", why: "db is transactional" },
    { key: "harnesses", kind: "multi", question: "Which harnesses first?", options: ["claude", "pi"], recommend: ["claude"], blocks: "which adapters the build touches" },
    { key: "verb-name", kind: "text", question: "What is the verb called?", recommend: "flowryn tokens", blocks: "the CLI name in code and docs" },
  ],
  decided: [{ choice: "poller home", picked: "src/lavish/poller.ts", why: "one child per gate" }],
};

function withQuestion(patch: Record<string, unknown>, index = 0): string {
  const copy = structuredClone(QUESTIONS) as { questions: Record<string, unknown>[] };
  copy.questions[index] = { ...copy.questions[index], ...patch };
  return JSON.stringify(copy);
}

describe("the questions file and the ask rule, checked in code", () => {
  test("a valid file parses, with the decided list", () => {
    const parsed = parseGateQuestions(JSON.stringify(QUESTIONS));
    expect(parsed.questions.map((q) => [q.key, q.kind, q.recommend])).toEqual([
      ["token-store", "single", ["db"]],
      ["harnesses", "multi", ["claude"]],
      ["verb-name", "text", ["flowryn tokens"]],
    ]);
    expect(parsed.decided).toEqual(QUESTIONS.decided);
  });

  test("a question must name the choice it blocks", () => {
    expect(() => parseGateQuestions(withQuestion({ blocks: undefined }))).toThrow(/blocks/);
    expect(() => parseGateQuestions(withQuestion({ blocks: "stuff" }))).toThrow(/at least 10/);
  });

  test("a choice needs 2 to 8 distinct options and a recommendation among them", () => {
    expect(() => parseGateQuestions(withQuestion({ options: ["db"] }))).toThrow(/decision you make yourself/);
    expect(() => parseGateQuestions(withQuestion({ options: ["db", "db"] }))).toThrow(/twice/);
    expect(() => parseGateQuestions(withQuestion({ recommend: "redis" }))).toThrow(/one of its options/);
    expect(() => parseGateQuestions(withQuestion({ recommend: undefined }))).toThrow(/one of its options/);
    expect(() => parseGateQuestions(withQuestion({ recommend: [] }, 1))).toThrow(/non-empty list/);
    expect(() => parseGateQuestions(withQuestion({ options: ["a,b", "c"] }))).toThrow(/short/);
  });

  test("a text question carries the worker's default answer and no options", () => {
    expect(() => parseGateQuestions(withQuestion({ recommend: undefined }, 2))).toThrow(/default answer/);
    expect(() => parseGateQuestions(withQuestion({ options: ["a", "b"] }, 2))).toThrow(/no options/);
  });

  test("at most five questions, one per blocked choice, unique keys", () => {
    const many = { questions: Array.from({ length: 6 }, (_, i) => ({ ...QUESTIONS.questions[0], key: `k${i}`, blocks: `choice number ${i} of six` })) };
    expect(() => parseGateQuestions(JSON.stringify(many))).toThrow(/at most 5/);
    expect(() => parseGateQuestions(withQuestion({ blocks: "which adapters the build touches" }))).toThrow(/same choice/);
    expect(() => parseGateQuestions(withQuestion({ key: "harnesses" }))).toThrow(/used twice/);
    expect(() => parseGateQuestions(JSON.stringify({ questions: [] }))).toThrow(/no questions/);
    expect(() => parseGateQuestions("not json")).toThrow(/not JSON/);
  });

  test("answers are checked against their question", () => {
    expect(normalizeAnswer("single", ["db", "file"], ["file"])).toBe("file");
    expect(() => normalizeAnswer("single", ["db", "file"], ["db", "file"])).toThrow(/one choice/);
    expect(() => normalizeAnswer("single", ["db", "file"], ["redis"])).toThrow(/not an option/);
    expect(normalizeAnswer("multi", ["claude", "pi"], ["pi", " claude"])).toBe("claude, pi");
    expect(() => normalizeAnswer("multi", ["claude", "pi"], [])).toThrow(/at least one/);
    expect(normalizeAnswer("text", [], ["  flowryn keys "])).toBe("flowryn keys");
    expect(() => normalizeAnswer("text", [], ["x".repeat(1_001)])).toThrow(/1,000/);
  });

  test("a choice question also takes other, only with the user's words; no option may be called other", () => {
    expect(() => normalizeAnswer("single", ["db", "file"], ["other"])).toThrow(/needs your words/);
    expect(normalizeAnswer("single", ["db", "file"], ["other"], true)).toBe("other");
    expect(normalizeAnswer("single", ["db", "file"], ["Other"], true)).toBe("other");
    expect(() => normalizeAnswer("single", ["db", "file"], ["db", "other"], true)).toThrow(/one choice/);
    expect(normalizeAnswer("multi", ["claude", "pi"], ["other", "pi"], true)).toBe("pi, other");
    expect(() => normalizeAnswer("multi", ["claude", "pi"], ["pi", "other"])).toThrow(/needs your words/);
    expect(normalizeAnswer("text", [], ["other"])).toBe("other");
    expect(() => parseGateQuestions(withQuestion({ options: ["db", "Other"] }))).toThrow(/"other" is reserved/);
  });
});

// Verbatim lavish-axi 0.1.65 output (the token is a real encoded answer for gate g1, q1).
const FEEDBACK = `session:
  file: /private/tmp/claude-501/lavx/p.html
  status: feedback
prompts[2]:
  - uid: ""
    prompt: "Answer q1: db\\nflowryn-answer v1 eyJnIjogImcxIiwgImQiOiAicTEiLCAiYyI6IFsiZGIiXSwgIm4iOiAiaXQncyBcInF1b3RlZFwiIn0"
    selector: ""
    tag: choice
    text: "q1: db"
    target:
      type: flowryn-answer
      v: eyJnIjogImcxIiwgImQiOiAicTEiLCAiYyI6IFsiZGIiXSwgIm4iOiAiaXQncyBcInF1b3RlZFwiIn0
  - uid: x
    prompt: "make the header bigger, \\"please\\""
    selector: h1
    tag: annotation
    text: Header
next_step: "Apply the requested changes."
dom_snapshot: ""
`;

const LAST_BATCH = `session:
  file: /private/tmp/claude-501/lavx/p.html
  status: feedback
  session_ended: true
  ended_by: user
prompts[1]{uid,prompt,selector,tag,text}:
  "",bye,"",chat,bye
next_step: This was the last feedback before the user ended the session.
dom_snapshot: ""
`;

const ENDED = `session:
  file: /private/tmp/claude-501/lavx/p.html
  status: ended
  ended_by: user
next_step: The user ended this Lavish Editor session.
`;

describe("what lavish-axi poll printed", () => {
  test("assumption: an answer's line survives the poll's TOON quoting, and other prompts are counted", () => {
    const out = parsePollOutput(FEEDBACK);
    expect(out).toMatchObject({ status: "feedback", ended: false, malformed: 0, otherPrompts: 1 });
    expect(out.answers).toEqual([{ gate: "g1", decision: "q1", choice: ["db"], note: 'it\'s "quoted"' }]);
  });

  test("the last batch before the user ended the session, and the ended reply", () => {
    expect(parsePollOutput(LAST_BATCH)).toMatchObject({ status: "feedback", ended: true, answers: [], otherPrompts: 1 });
    expect(parsePollOutput(ENDED)).toMatchObject({ status: "ended", ended: true, answers: [], otherPrompts: 0 });
  });

  test("a token that does not decode to an answer is counted, never recorded", () => {
    const bogus = Buffer.from(JSON.stringify({ g: "g1", d: "k1", c: ["db"] })).toString("base64url");
    const out = parsePollOutput(`status: feedback\nprompts[2]:\n  - prompt: "flowryn-answer v1 ${bogus}"\n  - prompt: "flowryn-answer v1 !!!!"\n`);
    expect(out.answers).toEqual([]);
    expect(out.malformed).toBe(1);
    expect(encodeAnswer({ gate: "g2", decision: "q9", choice: ["a"], note: null })).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("one Send carries every answer, the user's comment and the pass request in one prompt", () => {
    const token = encodeSend({ gate: "g4", comment: "line one\nline \"two\"", pass: true }, [
      { decision: "q1", choice: ["db"], note: null },
      { decision: "q2", choice: ["claude", "other"], note: "both, plus codex" },
    ]);
    const out = parsePollOutput(`status: feedback\nprompts[2]:\n  - prompt: ${JSON.stringify(`Answers:\n- q1: db\n${ANSWER_MARK} ${token}`)}\n  - prompt: chat\n`);
    expect(out.answers).toEqual([
      { gate: "g4", decision: "q1", choice: ["db"], note: null },
      { gate: "g4", decision: "q2", choice: ["claude", "other"], note: "both, plus codex" },
    ]);
    expect(out.sends).toEqual([{ gate: "g4", comment: 'line one\nline "two"', pass: true }]);
    expect(out).toMatchObject({ malformed: 0, otherPrompts: 1 });
  });

  test("a Send with one bad answer is malformed whole; the marks and versions go together", () => {
    const bad = Buffer.from(JSON.stringify({ g: "g4", a: [{ d: "q1", c: ["db"] }, { d: "k1", c: ["x"] }], m: "", p: true })).toString("base64url");
    expect(parsePollOutput(`status: feedback\nprompts[1]:\n  - prompt: "${ANSWER_MARK} ${bad}"\n`)).toMatchObject({ answers: [], sends: [], malformed: 1, otherPrompts: 0 });
    const v1 = encodeAnswer({ gate: "g1", decision: "q1", choice: ["db"], note: null });
    expect(parsePollOutput(`status: feedback\nprompts[1]:\n  - prompt: "flowryn-answer v2 ${v1}"\n`)).toMatchObject({ answers: [], malformed: 0, otherPrompts: 1 });
  });
});

// --- the widget, run against a small DOM stand-in -----------------------------------------------

class StubEl {
  children: StubEl[] = [];
  attrs: Record<string, string> = {};
  textContent = "";
  listeners: Record<string, (event: { preventDefault(): void }) => void> = {};
  constructor(readonly tag: string) {}
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  getAttribute(k: string): string | null {
    return k in this.attrs ? this.attrs[k]! : null;
  }
  appendChild(c: StubEl) {
    this.children.push(c);
    return c;
  }
  replaceChildren(...c: StubEl[]) {
    this.children = c;
  }
  addEventListener(name: string, fn: (event: { preventDefault(): void }) => void) {
    this.listeners[name] = fn;
  }
  all(): StubEl[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
  text(): string {
    return [this.textContent, ...this.children.map((c) => c.text())].join(" ");
  }
}

interface Queued {
  text: string;
  opts: Record<string, unknown>;
}

class StubFormData {
  private readonly inputs: StubEl[];
  constructor(form: StubEl) {
    this.inputs = form.all().filter((e) => e.tag === "input" || e.tag === "textarea");
  }
  private picked(name: string): StubEl[] {
    return this.inputs.filter((i) => i.attrs.name === name && ((i.attrs.type !== "radio" && i.attrs.type !== "checkbox") || "checked" in i.attrs));
  }
  get(name: string): string | null {
    return this.picked(name)[0]?.attrs.value ?? null;
  }
  getAll(name: string): string[] {
    return this.picked(name).map((i) => i.attrs.value ?? "");
  }
}

const DOM_GLOBALS = ["document", "window", "FormData"] as const;
let savedGlobals: Record<string, unknown> | null = null;

/** Run the widget file against a DOM stand-in; the globals stay until the test ends (restoreDom). */
function runWidget(state: WidgetState) {
  const g = globalThis as Record<string, unknown>;
  savedGlobals ??= Object.fromEntries(DOM_GLOBALS.map((k) => [k, g[k]]));
  const mount = new StubEl("section");
  const queued: Queued[] = [];
  const counter = { sent: 0 };
  g.document = { getElementById: (id: string) => (id === "flowryn-questions" ? mount : null), createElement: (tag: string) => new StubEl(tag), head: new StubEl("head") };
  g.window = { lavish: { queuePrompt: (text: string, opts: Record<string, unknown>) => queued.push({ text, opts }), sendQueuedPrompts: () => (counter.sent += 1) } };
  g.FormData = StubFormData;
  new Function(renderWidget(state))();
  const form = mount.children[0]!;
  return {
    mount,
    queued,
    counter,
    inputs: () => form.all().filter((e) => e.tag === "input" || e.tag === "textarea"),
    field: (name: string, value?: string) => form.all().find((e) => e.attrs.name === name && (value === undefined || e.attrs.value === value))!,
    status: () => form.all().find((e) => e.attrs.role === "status")!.textContent,
    /** Press Send, or "Send and request pass" (the submitter carries data-pass). */
    submit: (pass = false) => form.listeners.submit!({ preventDefault() {}, submitter: form.all().find((e) => e.tag === "button" && (pass ? "data-pass" in e.attrs : !("data-pass" in e.attrs))) } as never),
  };
}

afterEach(() => {
  if (!savedGlobals) return;
  Object.assign(globalThis as Record<string, unknown>, savedGlobals);
  savedGlobals = null;
});

const STATE: WidgetState = {
  gate: "g7",
  task: "web-x",
  stage: "design",
  gateState: "open",
  decided: [{ choice: "poller home", picked: "src/lavish/poller.ts", why: "one child per gate" }],
  questions: [
    { id: "q1", key: "token-store", kind: "single", question: "Where?", options: ["db", "file"], recommend: ["db"], blocks: "which store TokenCache writes to", why: "why", state: "open", answer: null, via: null },
    { id: "q2", key: "harnesses", kind: "multi", question: "Which?", options: ["claude", "pi"], recommend: ["claude"], blocks: "which adapters", why: null, state: "open", answer: null, via: null },
    { id: "q3", key: "verb-name", kind: "text", question: "Name?", options: [], recommend: ["flowryn tokens"], blocks: "the CLI name", why: null, state: "open", answer: null, via: null },
    { id: "q4", key: "alias", kind: "single", question: "Alias?", options: ["yes", "no"], recommend: ["yes"], blocks: "the old flag", why: null, state: "answered", answer: "no", via: "your leader" },
  ],
};

function decodeQueued(queued: Queued[]) {
  return parsePollOutput(`status: feedback\nprompts[${queued.length}]:\n${queued.map((q) => `  - prompt: ${JSON.stringify(q.text)}`).join("\n")}\n`);
}

describe("the question widget", () => {
  test("it renders radios with the recommendation checked and Other, checkboxes, a text field, the comment box and a locked answered question", () => {
    const { mount } = runWidget(STATE);
    const inputs = mount.all().filter((e) => e.tag === "input");
    const radio = inputs.filter((i) => i.attrs.name === "q1");
    expect(radio.map((i) => [i.attrs.type, i.attrs.value, "checked" in i.attrs])).toEqual([
      ["radio", "db", true],
      ["radio", "file", false],
      ["radio", "other", false],
    ]);
    expect(inputs.filter((i) => i.attrs.name === "q2").map((i) => [i.attrs.type, i.attrs.value])).toEqual([
      ["checkbox", "claude"],
      ["checkbox", "pi"],
      ["checkbox", "other"],
    ]);
    expect(inputs.find((i) => i.attrs.name === "q3")!.attrs).toMatchObject({ type: "text", placeholder: "flowryn tokens" });
    expect(inputs.some((i) => i.attrs.name === "q4")).toBe(false);
    expect(mount.all().filter((e) => e.tag === "textarea").map((e) => e.attrs.name)).toEqual(["fq-comment"]);
    expect(mount.text()).toContain("Answered via your leader: no");
    expect(mount.text()).toContain("poller home: src/lavish/poller.ts");
    expect(mount.all().filter((e) => e.tag === "button").map((b) => b.textContent)).toEqual(["Send answers", "Send and request pass"]);
  });

  test("assumption: one Send queues one prompt whose token decodes to every answer and the comment, then sends", () => {
    const run = runWidget(STATE);
    run.field("q2", "pi").attrs.checked = "";
    run.field("q1-note").attrs.value = "ünïcode note";
    run.field("fq-comment").attrs.value = "Keep it small.\nThanks";
    run.submit();
    expect(run.counter.sent).toBe(1);
    expect(run.queued).toHaveLength(1);
    expect(run.queued[0]!.opts.queueKey).toBe("flowryn:g7");
    expect(run.queued[0]!.text).toContain("Anything else: Keep it small.");
    const parsed = decodeQueued(run.queued);
    expect(parsed.answers).toEqual([
      { gate: "g7", decision: "q1", choice: ["db"], note: "ünïcode note" },
      { gate: "g7", decision: "q2", choice: ["claude", "pi"], note: null },
    ]);
    expect(parsed.sends).toEqual([{ gate: "g7", comment: "Keep it small.\nThanks", pass: false }]);
    expect(parsed.otherPrompts).toBe(0);
    expect(run.status()).toContain("Still open: q3");
  });

  test("Other needs its note: without one nothing is sent; with one it is the answer, the note its words", () => {
    const run = runWidget(STATE);
    delete run.field("q1", "db").attrs.checked;
    run.field("q1", "other").attrs.checked = "";
    run.submit();
    expect(run.queued).toHaveLength(0);
    expect(run.status()).toContain("q1: say what Other means in its note");
    run.field("q1-note").attrs.value = "redis, shared with the cache";
    run.submit();
    expect(decodeQueued(run.queued).answers[0]).toEqual({ gate: "g7", decision: "q1", choice: ["other"], note: "redis, shared with the cache" });
  });

  test("a pass request needs every question answered, and rides the same Send", () => {
    const run = runWidget(STATE);
    run.submit(true);
    expect(run.queued).toHaveLength(0);
    expect(run.status()).toContain("A pass needs every question answered: q3 is empty");
    run.field("q3").attrs.value = "flowryn keys";
    run.submit(true);
    expect(run.queued).toHaveLength(1);
    expect(run.queued[0]!.text).toContain("Please pass this review.");
    const parsed = decodeQueued(run.queued);
    expect(parsed.answers.map((a) => a.decision)).toEqual(["q1", "q2", "q3"]);
    expect(parsed.sends).toEqual([{ gate: "g7", comment: null, pass: true }]);
    expect(run.status()).toContain("a pass request");
  });

  test("a closed gate shows every question locked, with no Send, comment box or pass", () => {
    const { mount } = runWidget({ ...STATE, gateState: "passed" });
    expect(mount.all().filter((e) => e.tag === "button")).toHaveLength(0);
    expect(mount.all().filter((e) => e.tag === "input" || e.tag === "textarea")).toHaveLength(0);
  });

  test("the page must mount the widget", () => {
    expect(pageMountsWidget(`<section id="flowryn-questions"></section><script src="${WIDGET_FILE}"></script>`)).toBe(true);
    expect(pageMountsWidget("<section></section>")).toBe(false);
  });
});

// --- the decisions, the gate and the widget file ---------------------------------------------------

let h: TestHome;
let db: Db;
let reportDir: string;
let page: string;
let runId: string;
let taskId: string;
const NOW = 1_000_000;

beforeEach(() => {
  h = makeHome();
  const seeded = seedRun(h);
  runId = seeded.runId;
  taskId = seeded.taskId;
  db = h.db();
  mkdirSync(join(h.dataDir, taskId, "design"), { recursive: true });
  reportDir = realpathSync(join(h.dataDir, taskId));
  page = join(reportDir, "design", "design.html");
  writeFileSync(page, `<html data-lavish-live-reload-root><body><section id="flowryn-questions"></section><script src="${WIDGET_FILE}"></script></body></html>`);
  db.query("INSERT INTO gates (id, run_id, stage, kind, review_url, state, opened_at) VALUES ('g1', ?1, 'design', 'review', 'http://127.0.0.1:4387/session/x', 'open', ?2)").run(runId, NOW);
});
afterEach(() => {
  db.close();
  h.cleanup();
});

function open(): string[] {
  const run = getRun(db, runId)!;
  return tx(db, () => openGateQuestions(db, run, { id: "g1", stage: "design", review_url: null }, page, parseGateQuestions(JSON.stringify(QUESTIONS)), NOW));
}

const ctx = () => ({ db, now: () => NOW + 10 });

function scriptedLavish(body: string): string {
  const bin = join(h.home, "scripted-lavish");
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe("a gate's questions as decisions", () => {
  test("each question opens reserved for the user, bound to the gate, with a P1 that carries it", () => {
    expect(open()).toEqual(["q1", "q2", "q3"]);
    const q1 = getDecision(db, "q1")!;
    expect(q1).toMatchObject({ run_id: runId, gate_id: "g1", kind: "single", origin: "gate:g1", key: "token-store", recommendation: "db", reserved_reason: "a review question for the user", blocks: "which store TokenCache writes to", note: "db is transactional", state: "open", blocking: 0 });
    const items = db.query("SELECT kind, decision_id, line FROM items ORDER BY id").all() as { kind: string; decision_id: string; line: string }[];
    expect(items.map((i) => [i.kind, i.decision_id])).toEqual([
      ["worker_question", "q1"],
      ["worker_question", "q2"],
      ["worker_question", "q3"],
    ]);
    expect(items[0]!.line).toContain("flowryn decide q1 <choice> --by captain");
    expect(gatesToPoll(db)).toEqual([{ id: "g1", page_path: page }]);
  });

  test("a page answer is the user's (captain via lavish), held from the worker while the gate is open; the first answer counts", () => {
    open();
    expect(tx(db, () => lavishAnswer(ctx(), { gate: "g1", decision: "q2", choice: ["pi", "claude"], note: "pi later" }))).toBe("recorded");
    const q2 = getDecision(db, "q2")!;
    expect(q2).toMatchObject({ state: "answered", answer: "claude, pi", answered_by: "captain", answered_via: "lavish", rationale: "pi later" });
    expect(db.query("SELECT COUNT(*) AS n FROM messages WHERE run_id = ?1").get(runId)).toEqual({ n: 0 });
    // Only q2's item closed, not its siblings'.
    expect((db.query("SELECT decision_id FROM items WHERE state = 'open' ORDER BY id").all() as { decision_id: string }[]).map((i) => i.decision_id)).toEqual(["q1", "q3"]);
    expect(tx(db, () => lavishAnswer(ctx(), { gate: "g1", decision: "q2", choice: ["pi"], note: null }))).toBe("late");
    expect(getDecision(db, "q2")!.answer).toBe("claude, pi");
    expect(tx(db, () => lavishAnswer(ctx(), { gate: "g9", decision: "q1", choice: ["db"], note: null }))).toBe("stale");
    expect(tx(db, () => lavishAnswer(ctx(), { gate: "g1", decision: "q1", choice: ["redis"], note: null }))).toBe("invalid");
    expect(getDecision(db, "q1")!.state).toBe("open");
    const ignored = db.query("SELECT payload FROM events WHERE kind = 'decision.lavish_ignored' ORDER BY seq").all() as { payload: string }[];
    expect(ignored.map((e) => JSON.parse(e.payload).outcome)).toEqual(["late", "stale", "invalid"]);
  });

  test("the gate passes only once every question is answered, and the verdict carries the answers", () => {
    open();
    expect(() => requireGateAnswered(db, { id: "g1", stage: "design" })).toThrow(/3 open questions \(q1, q2, q3\)/);
    expect(gateQuestionsLine(db, "g1")).toBe("3 questions still open (q1, q2, q3); it will be refused");
    tx(db, () => {
      lavishAnswer(ctx(), { gate: "g1", decision: "q1", choice: ["file"], note: null });
      lavishAnswer(ctx(), { gate: "g1", decision: "q2", choice: ["claude"], note: null });
      lavishAnswer(ctx(), { gate: "g1", decision: "q3", choice: ["flowryn keys"], note: "short" });
    });
    expect(() => requireGateAnswered(db, { id: "g1", stage: "design" })).not.toThrow();
    expect(gateQuestionsLine(db, "g1")).toBe("answers q1 = file; q2 = claude; q3 = flowryn keys");
    expect(gateAnswersNote(db, "g1")).toBe("The user's answers to your review questions: q1 (token-store) = file; q2 (harnesses) = claude; q3 (verb-name) = flowryn keys [their note: short].");
  });

  test("changes close the open questions unanswered", () => {
    open();
    tx(db, () => lavishAnswer(ctx(), { gate: "g1", decision: "q1", choice: ["db"], note: null }));
    const run = getRun(db, runId)!;
    expect(tx(db, () => dismissGateQuestions(db, run, "g1", NOW, "gate changes", "cli"))).toEqual(["q2", "q3"]);
    expect(getDecision(db, "q2")!).toMatchObject({ state: "dismissed", answered_via: "gate changes" });
    expect(db.query("SELECT resolved_by FROM items WHERE decision_id = 'q2'").get()).toEqual({ resolved_by: "gate.changes g1" });
    expect(db.query("SELECT COUNT(*) AS n FROM items WHERE state = 'open'").get()).toEqual({ n: 0 });
    expect(gateAnswersNote(db, "g1")).toBe("The user's answers to your review questions: q1 (token-store) = db. Closed unanswered: q2, q3.");
  });

  test("the widget file follows the gate: written beside the page, rewritten only when the state changes", () => {
    open();
    const found = widgetState(db, "g1")!;
    expect(found.page).toBe(page);
    expect(found.state.questions.map((q) => [q.id, q.recommend, q.state])).toEqual([
      ["q1", ["db"], "open"],
      ["q2", ["claude"], "open"],
      ["q3", ["flowryn tokens"], "open"],
    ]);
    expect(writeWidget(found.page, found.state)).toBe(true);
    expect(writeWidget(found.page, found.state)).toBe(false);
    tx(db, () => lavishAnswer(ctx(), { gate: "g1", decision: "q1", choice: ["db"], note: null }));
    const after = widgetState(db, "g1")!;
    expect(after.state.questions[0]).toMatchObject({ state: "answered", answer: "db", via: "the review page" });
    expect(writeWidget(after.page, after.state)).toBe(true);
    expect(readFileSync(join(reportDir, "design", WIDGET_FILE), "utf8")).toContain('"answer":"db"');
  });

  test("without lavish-axi the questions stay open for the leader; a binary that cannot run backs off", async () => {
    open();
    const logs: string[] = [];
    const none = new LavishPoller({ db, lavish: () => null, log: (m) => logs.push(m), now: () => NOW });
    none.pass();
    none.pass();
    expect(none.polling()).toEqual([]);
    expect(logs.filter((l) => l.includes("not installed"))).toHaveLength(1);
    expect(existsSync(join(reportDir, "design", WIDGET_FILE))).toBe(true);
    none.stop();
    const broken = new LavishPoller({ db, lavish: () => join(h.home, "no-such-lavish"), log: (m) => logs.push(m), now: () => NOW });
    broken.pass();
    expect(logs.some((l) => /the poll of gate g1 failed \(cannot run .*\); again in 2 s/.test(l))).toBe(true);
    broken.stop();
    expect(getDecision(db, "q1")!.state).toBe("open");
  });

  test("a poll an earlier daemon left running is stopped before polling again; an unrelated pid is left alone", async () => {
    const pidDir = join(h.home, "lavish-polls");
    mkdirSync(pidDir, { recursive: true });
    const orphan = Bun.spawn(["/bin/sh", "-c", "sleep 30; exit 0", "lavish-axi", "poll", page], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    writeFileSync(join(pidDir, "g1.json"), JSON.stringify({ pid: orphan.pid, page }));
    writeFileSync(join(pidDir, "g2.json"), JSON.stringify({ pid: process.pid, page }));
    const logs: string[] = [];
    const poller = new LavishPoller({ db, lavish: () => null, log: (m) => logs.push(m), now: () => NOW, pidDir });
    poller.pass();
    const code = await Promise.race([orphan.exited, Bun.sleep(5_000).then(() => "still running")]);
    expect(code).not.toBe("still running");
    expect(logs.some((l) => l.includes(`stopped a poll an earlier daemon left running (pid ${orphan.pid}`))).toBe(true);
    expect(existsSync(join(pidDir, "g1.json"))).toBe(false);
    expect(existsSync(join(pidDir, "g2.json"))).toBe(false);
    poller.stop();
  });

  test("the review page must be a real .html under the report directory that mounts the widget", () => {
    expect(checkReviewPage(page, reportDir)).toContain("design.html");
    const outside = join(h.home, "elsewhere.html");
    writeFileSync(outside, readFileSync(page, "utf8"));
    expect(() => checkReviewPage(outside, reportDir)).toThrow(/outside/);
    const link = join(reportDir, "design", "link.html");
    symlinkSync(outside, link);
    expect(() => checkReviewPage(link, reportDir)).toThrow(/symlink/);
    const bare = join(reportDir, "design", "bare.html");
    writeFileSync(bare, "<html></html>");
    expect(() => checkReviewPage(bare, reportDir)).toThrow(/does not mount/);
    expect(() => checkReviewPage(join(reportDir, "nope.html"), reportDir)).toThrow(/cannot read/);
  });

  test("answering a plain question closes only its own item, not the gate's questions on the same task", () => {
    open();
    db.query("INSERT INTO decisions (id, task_id, run_id, question, options, blocking, state, created_at) VALUES ('q9', ?1, ?2, 'Plain?', '[\"a\",\"b\"]', 0, 'open', ?3)").run(taskId, runId, NOW);
    tx(db, () => {
      const event = appendEvent(db, { source: "cli", kind: "decision.opened", runId, taskId, payload: { decision: "q9" }, ts: NOW });
      const item = openItem(db, { kind: "worker_question", eventSeq: event.seq, taskId, runId, line: "Worker question q9", now: NOW });
      db.query("UPDATE items SET decision_id = 'q9' WHERE id = ?1").run(item);
    });
    tx(db, () => answerDecision(ctx(), getDecision(db, "q9")!, { choice: "a", words: null, by: "leader", via: "cli" }));
    expect((db.query("SELECT decision_id FROM items WHERE state = 'open' ORDER BY decision_id").all() as { decision_id: string }[]).map((i) => i.decision_id)).toEqual(["q1", "q2", "q3"]);
  });

  test("an Other answer keeps the user's words, and the comment reaches the verdict verbatim", () => {
    open();
    expect(tx(db, () => lavishAnswer(ctx(), { gate: "g1", decision: "q1", choice: ["other"], note: null }))).toBe("invalid");
    expect(tx(db, () => lavishAnswer(ctx(), { gate: "g1", decision: "q1", choice: ["other"], note: "redis" }))).toBe("recorded");
    expect(getDecision(db, "q1")!).toMatchObject({ answer: "other", rationale: "redis" });
    expect(tx(db, () => recordGateComment(db, "g1", "  keep \"it\" small\n\nthanks ", NOW))).toBe("recorded");
    expect(tx(db, () => recordGateComment(db, "g1", "and one more", NOW))).toBe("recorded");
    expect(tx(db, () => recordGateComment(db, "g1", "   ", NOW))).toBe("empty");
    expect(tx(db, () => recordGateComment(db, "g9", "x", NOW))).toBe("stale");
    const verdict = gateAnswersNote(db, "g1")!;
    expect(verdict).toContain("q1 (token-store) = other [their words: redis]");
    expect(verdict).toContain('The user also wrote on the review page: """keep "it" small\n\nthanks\n\nand one more"""');
    expect((db.query("SELECT payload FROM events WHERE kind = 'gate.comment' ORDER BY seq").all() as { payload: string }[]).map((e) => JSON.parse(e.payload).text)).toEqual(['keep "it" small\n\nthanks', "and one more"]);
    db.query("UPDATE gates SET state = 'passed' WHERE id = 'g1'").run();
    expect(tx(db, () => recordGateComment(db, "g1", "too late", NOW))).toBe("late");
  });

  test("a pass request from the page never passes the gate: once every question is answered it opens one P1 for the leader", () => {
    open();
    expect(tx(db, () => requestGatePass(db, "g1", NOW))).toEqual({ outcome: "questions_open", open: ["q1", "q2", "q3"] });
    expect(db.query("SELECT COUNT(*) AS n FROM items WHERE kind = 'pass_requested'").get()).toEqual({ n: 0 });
    tx(db, () => {
      lavishAnswer(ctx(), { gate: "g1", decision: "q1", choice: ["db"], note: null });
      lavishAnswer(ctx(), { gate: "g1", decision: "q2", choice: ["pi"], note: null });
      lavishAnswer(ctx(), { gate: "g1", decision: "q3", choice: ["flowryn keys"], note: null });
    });
    expect(tx(db, () => requestGatePass(db, "g1", NOW))).toEqual({ outcome: "requested" });
    expect(tx(db, () => requestGatePass(db, "g1", NOW))).toEqual({ outcome: "already" });
    const item = db.query("SELECT lane, line FROM items WHERE kind = 'pass_requested' AND state = 'open'").all() as { lane: string; line: string }[];
    expect(item).toHaveLength(1);
    expect(item[0]!.lane).toBe("P1");
    expect(item[0]!.line).toContain(`flowryn gate pass ${taskId} --gate-id g1`);
    expect(db.query("SELECT state, approval_id FROM gates WHERE id = 'g1'").get()).toEqual({ state: "open", approval_id: null });
    expect(db.query("SELECT COUNT(*) AS n FROM approvals").get()).toEqual({ n: 0 });
    expect(tx(db, () => requestGatePass(db, "g9", NOW))).toEqual({ outcome: "stale" });
    db.query("UPDATE gates SET state = 'changes' WHERE id = 'g1'").run();
    expect(tx(db, () => requestGatePass(db, "g1", NOW))).toEqual({ outcome: "late" });
  });

  test("the poller records one Send whole: answers, comment and pass request, and tells the user what happened", async () => {
    open();
    const token = encodeSend({ gate: "g1", comment: "ship it", pass: true }, [
      { decision: "q1", choice: ["file"], note: null },
      { decision: "q2", choice: ["claude"], note: null },
      { decision: "q3", choice: ["flowryn keys"], note: null },
    ]);
    const output = join(h.home, "send.out");
    writeFileSync(output, `session:\n  status: feedback\nprompts[1]:\n  - uid: ""\n    prompt: ${JSON.stringify(`Answers\n${ANSWER_MARK} ${token}`)}\n    tag: choice\n`);
    const calls = join(h.home, "calls.log");
    const logs: string[] = [];
    const poller = new LavishPoller({ db, lavish: () => scriptedLavish(`echo "$@" >> ${JSON.stringify(calls)}; case "$*" in *agent-reply*) exit 0;; esac; cat ${JSON.stringify(output)}`), log: (m) => logs.push(m), now: () => NOW });
    try {
      poller.pass();
      await waitUntil(() => logs.some((l) => l.startsWith("lavish: gate g1:")), 5_000, "the poll recorded");
      await waitUntil(() => existsSync(calls) && readFileSync(calls, "utf8").includes("--agent-reply"), 5_000, "the reply poll");
    } finally {
      poller.stop();
    }
    expect(["q1", "q2", "q3"].map((id) => getDecision(db, id)!.state)).toEqual(["answered", "answered", "answered"]);
    expect(logs.find((l) => l.startsWith("lavish: gate g1:"))).toContain("comment recorded, pass requested");
    expect(db.query("SELECT comment FROM gates WHERE id = 'g1'").get()).toEqual({ comment: "ship it" });
    expect(db.query("SELECT COUNT(*) AS n FROM items WHERE kind = 'pass_requested' AND state = 'open'").get()).toEqual({ n: 1 });
    const reply = readFileSync(calls, "utf8");
    expect(reply).toContain("Pass requested. This page cannot pass the review");
    expect(reply).toContain("Your note for the worker is kept");
  });

  test("a long free answer and note reach the verdict whole", () => {
    open();
    const answer = "a".repeat(900);
    const note = "n".repeat(1_800);
    tx(db, () => lavishAnswer(ctx(), { gate: "g1", decision: "q3", choice: [answer], note }));
    const verdict = gateAnswersNote(db, "g1")!;
    expect(verdict).toContain(`q3 (verb-name) = ${answer} [their note: ${note}]`);
  });

  test("a cancelled run's open questions close unanswered, labelled as such, and its page is neither polled nor rewritten", () => {
    open();
    tx(db, () => lavishAnswer(ctx(), { gate: "g1", decision: "q1", choice: ["db"], note: null }));
    tx(db, () => cancelRun(db, getRun(db, runId)!, "stop", "cli", NOW));
    expect(["q1", "q2", "q3"].map((id) => [getDecision(db, id)!.state, getDecision(db, id)!.answered_via])).toEqual([
      ["answered", "lavish"],
      ["dismissed", "run cancelled"],
      ["dismissed", "run cancelled"],
    ]);
    expect(db.query("SELECT resolved_by FROM items WHERE decision_id = 'q2'").get()).toEqual({ resolved_by: "run.cancelled g1" });
    expect(gatesToPoll(db)).toEqual([]);
    expect(gatesWithWidget(db, [])).toEqual([]);
  });

  test("a failed run keeps its questions open: not polled while it is down, and its gate still refuses once it is resumed", () => {
    open();
    tx(db, () => failRun(db, getRun(db, runId)!, "dead", "daemon", NOW));
    expect(["q1", "q2", "q3"].map((id) => getDecision(db, id)!.state)).toEqual(["open", "open", "open"]);
    expect(gatesToPoll(db)).toEqual([]);
    expect(gatesWithWidget(db, [])).toEqual([]);
    db.query("UPDATE runs SET state = 'running', liveness = 'busy', ended_at = NULL WHERE id = ?1").run(runId);
    expect(() => requireGateAnswered(db, { id: "g1", stage: "design" })).toThrow(/3 open questions/);
    expect(gatesToPoll(db)).toEqual([{ id: "g1", page_path: page }]);
  });

  test("a new run of the task ends a failed run's questions for good", () => {
    open();
    tx(db, () => failRun(db, getRun(db, runId)!, "dead", "daemon", NOW));
    const newRun = tx(db, () =>
      createRun(db, defaultConfig(h.home), { taskId, title: taskId, body: "again", project: getProject(db, "web")!, kind: "ship", harness: "claude", version: "2.1.281", base: "abc123", workflow: DEFAULT_WORKFLOWS.feature!, sensitive: false, existing: true, by: "leader", override: null, now: NOW }),
    );
    expect(newRun).not.toBe(runId);
    expect(["q1", "q2", "q3"].map((id) => [getDecision(db, id)!.state, getDecision(db, id)!.answered_via])).toEqual([
      ["dismissed", "run ended"],
      ["dismissed", "run ended"],
      ["dismissed", "run ended"],
    ]);
    expect(db.query("SELECT resolved_by FROM items WHERE decision_id = 'q1'").get()).toEqual({ resolved_by: "run.ended g1" });
    expect(db.query("SELECT DISTINCT source FROM events WHERE kind = 'decision.dismissed'").all()).toEqual([{ source: "cli" }]);
  });

  test("notes are never appended through a symlink the worker put beside the page", async () => {
    open();
    const victim = join(h.home, "victim.txt");
    writeFileSync(victim, "untouched\n");
    symlinkSync(victim, join(reportDir, "design", "lavish-notes-g1.txt"));
    const output = join(h.home, "feedback.out");
    writeFileSync(output, FEEDBACK);
    const logs: string[] = [];
    const poller = new LavishPoller({ db, lavish: () => scriptedLavish(`cat ${JSON.stringify(output)}`), log: (m) => logs.push(m), now: () => NOW });
    try {
      poller.pass();
      await waitUntil(() => logs.some((l) => l.startsWith("lavish: gate g1:")), 5_000, "the poll recorded");
    } finally {
      poller.stop();
    }
    expect(readFileSync(victim, "utf8")).toBe("untouched\n");
    expect(logs.some((l) => l.includes("cannot keep gate g1's notes"))).toBe(true);
    expect(getDecision(db, "q1")!.state).toBe("answered");
    expect(db.query("SELECT notes_path FROM gates WHERE id = 'g1'").get()).toEqual({ notes_path: null });
  });

  test("notes are kept beside the page, and the verdict points at them", async () => {
    open();
    const output = join(h.home, "feedback.out");
    writeFileSync(output, FEEDBACK);
    const logs: string[] = [];
    const poller = new LavishPoller({ db, lavish: () => scriptedLavish(`cat ${JSON.stringify(output)}`), log: (m) => logs.push(m), now: () => NOW });
    try {
      poller.pass();
      await waitUntil(() => logs.some((l) => l.startsWith("lavish: gate g1:")), 5_000, "the poll recorded");
    } finally {
      poller.stop();
    }
    const notes = join(reportDir, "design", "lavish-notes-g1.txt");
    expect(readFileSync(notes, "utf8")).toContain("make the header bigger");
    expect(gateAnswersNote(db, "g1")).toContain(`read ${notes}`);
  });

  test("a poll whose answers cannot be recorded is logged, not left as an unhandled rejection", async () => {
    open();
    const output = join(h.home, "feedback.out");
    writeFileSync(output, FEEDBACK);
    const go = join(h.home, "go");
    const logs: string[] = [];
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    const poller = new LavishPoller({ db, lavish: () => scriptedLavish(`while [ ! -f ${JSON.stringify(go)} ]; do sleep 0.05; done; cat ${JSON.stringify(output)}`), log: (m) => logs.push(m), now: () => NOW });
    try {
      poller.pass();
      expect(poller.polling()).toEqual(["g1"]);
      db.query("UPDATE decisions SET options = 'not json' WHERE id = 'q1'").run();
      writeFileSync(go, "");
      await waitUntil(() => logs.some((l) => l.includes("the poll of gate g1 could not be recorded")), 5_000, "the failure logged");
      await Bun.sleep(50);
    } finally {
      poller.stop();
      process.off("unhandledRejection", onRejection);
    }
    expect(rejections).toEqual([]);
    expect(getDecision(db, "q1")!.state).toBe("open");
  });
});
