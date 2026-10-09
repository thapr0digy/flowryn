import { FlowrynError } from "../api/errors.ts";
import { DECISION_KEY, DECISION_OPTION } from "../lifecycle/decisions.ts";
import { MAX_STORED_TEXT_CHARS, sanitizeBlock, sanitizeLine } from "../util/sanitize.ts";

/**
 * A review gate's questions (`stage done --questions-file`): what the worker
 * cannot decide by itself, and what it decided. The ask rule (design steers
 * m23, m24) is checked here in code, never by a model: a question names the
 * choice it blocks and carries a recommendation, so taking the default is one
 * click; a long list or two questions blocking the same choice are refused.
 */

export const QUESTION_KINDS = ["single", "multi", "text"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export const MAX_GATE_QUESTIONS = 5;
/**
 * The answer every choice question offers beside its options: the user's own
 * answer, said in their words (the page's note, or `decide --words`). It is
 * reserved, so no worker option may be called "other".
 */
export const OTHER_ANSWER = "other";
export const MAX_DECIDED = 30;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 8;
const MAX_QUESTION = MAX_STORED_TEXT_CHARS;
const MAX_WHY = 1_000;
const MIN_BLOCKS = 10;
const MAX_BLOCKS = 200;
const MAX_TEXT_RECOMMEND = 200;
const MAX_DECIDED_FIELD = 300;

export interface GateQuestion {
  key: string;
  kind: QuestionKind;
  question: string;
  options: string[];
  /** single and text: one value; multi: a subset of the options. */
  recommend: string[];
  blocks: string;
  why: string | null;
}

export interface DecidedChoice {
  choice: string;
  picked: string;
  why: string;
}

export interface GateQuestions {
  questions: GateQuestion[];
  decided: DecidedChoice[];
}

function bad(message: string): FlowrynError {
  return new FlowrynError("bad_args", `questions file: ${message}`, "see the flowryn-design skill for the questions.json shape");
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw bad(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, where: string, max: number, opts: { required: boolean; min?: number } = { required: true }): string | null {
  if (value === undefined || value === null) {
    if (opts.required) throw bad(`${where} is required`);
    return null;
  }
  if (typeof value !== "string") throw bad(`${where} must be a string`);
  const cleaned = sanitizeBlock(value).trim();
  if (cleaned.length === 0) {
    if (opts.required) throw bad(`${where} is empty`);
    return null;
  }
  if (cleaned.length > max) throw bad(`${where} is longer than ${max} characters`);
  if (opts.min !== undefined && cleaned.length < opts.min) throw bad(`${where} must say what it blocks in at least ${opts.min} characters`);
  return cleaned;
}

function options(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) throw bad(`${where} must be a list of ${MIN_OPTIONS} to ${MAX_OPTIONS} options`);
  const list = value.map((o, i) => {
    if (typeof o !== "string" || !DECISION_OPTION.test(o.trim())) throw bad(`${where}[${i}] must be short: letters, digits, spaces, _ . - (at most 40)`);
    if (o.trim().toLowerCase() === OTHER_ANSWER) throw bad(`${where}[${i}]: "${OTHER_ANSWER}" is reserved; every choice question already offers it, with the user's words`);
    return o.trim();
  });
  if (list.length < MIN_OPTIONS || list.length > MAX_OPTIONS) throw bad(`${where} needs ${MIN_OPTIONS} to ${MAX_OPTIONS} options; a question with one answer is a decision you make yourself`);
  if (new Set(list).size !== list.length) throw bad(`${where} lists an option twice`);
  return list;
}

function question(raw: unknown, index: number): GateQuestion {
  const where = `questions[${index}]`;
  const q = record(raw, where);
  const key = typeof q.key === "string" ? q.key.trim() : "";
  if (!DECISION_KEY.test(key)) throw bad(`${where}.key must be lowercase letters, digits and dashes`);
  const kind = (q.kind ?? "single") as QuestionKind;
  if (!QUESTION_KINDS.includes(kind)) throw bad(`${where}.kind must be one of ${QUESTION_KINDS.join(", ")}`);
  const body = text(q.question, `${where}.question`, MAX_QUESTION)!;
  const blocks = text(q.blocks, `${where}.blocks (the choice in your work that waits on this answer)`, MAX_BLOCKS, { required: true, min: MIN_BLOCKS })!;
  const why = text(q.why, `${where}.why`, MAX_WHY, { required: false });
  if (kind === "text") {
    if (q.options !== undefined) throw bad(`${where} is a text question; it takes no options`);
    const recommend = text(q.recommend, `${where}.recommend (your default answer)`, MAX_TEXT_RECOMMEND)!;
    return { key, kind, question: body, options: [], recommend: [recommend], blocks, why };
  }
  const opts = options(q.options, `${where}.options`);
  const rec = kind === "multi" ? q.recommend : [q.recommend];
  if (!Array.isArray(rec) || rec.length === 0 || rec.some((r) => typeof r !== "string" || !opts.includes(r.trim()))) {
    throw bad(kind === "multi" ? `${where}.recommend must be a non-empty list of its options` : `${where}.recommend must be one of its options`);
  }
  const recommend = [...new Set((rec as string[]).map((r) => r.trim()))];
  return { key, kind, question: body, options: opts, recommend, blocks, why };
}

function decided(raw: unknown, index: number): DecidedChoice {
  const where = `decided[${index}]`;
  const d = record(raw, where);
  return {
    choice: text(d.choice, `${where}.choice`, MAX_DECIDED_FIELD)!,
    picked: text(d.picked, `${where}.picked`, MAX_DECIDED_FIELD)!,
    why: text(d.why, `${where}.why`, MAX_DECIDED_FIELD)!,
  };
}

/** Parse and check a questions file; all or nothing. */
export function parseGateQuestions(source: string): GateQuestions {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    throw bad(`not JSON (${(error as Error).message})`);
  }
  const top = record(raw, "the file");
  const list = top.questions ?? [];
  if (!Array.isArray(list)) throw bad("questions must be a list");
  if (list.length > MAX_GATE_QUESTIONS) throw bad(`${list.length} questions; at most ${MAX_GATE_QUESTIONS}. Decide the rest yourself and list them under decided`);
  const questions = list.map(question);
  const keys = new Set<string>();
  const blocked = new Set<string>();
  for (const q of questions) {
    if (keys.has(q.key)) throw bad(`key ${q.key} is used twice`);
    keys.add(q.key);
    const norm = sanitizeLine(q.blocks).toLowerCase();
    if (blocked.has(norm)) throw bad(`two questions block the same choice ("${q.blocks}"); ask it once`);
    blocked.add(norm);
  }
  const decidedList = top.decided ?? [];
  if (!Array.isArray(decidedList)) throw bad("decided must be a list");
  if (decidedList.length > MAX_DECIDED) throw bad(`decided lists ${decidedList.length} choices; at most ${MAX_DECIDED}`);
  if (questions.length === 0) throw bad("no questions; leave out --questions-file when nothing needs the user");
  return { questions, decided: decidedList.map(decided) };
}

/**
 * Check an answer against its question: a single choice is one option, a
 * multi choice a non-empty set of options, a text answer up to 1,000 chars.
 * A choice question also takes "other" (alone, or among a multi choice's
 * options), only with the user's words, which are kept beside it verbatim.
 * Returns the answer as stored (multi: "a, b" in the options' order, "other" last).
 */
export function normalizeAnswer(kind: QuestionKind, opts: string[], given: string[], hasWords = false): string {
  const values = given.map((v) => v.trim()).filter((v) => v.length > 0);
  if (kind === "text") {
    const answer = sanitizeBlock(values.join("\n")).trim();
    if (answer.length === 0) throw new FlowrynError("bad_args", "the answer is empty");
    if (answer.length > 1_000) throw new FlowrynError("bad_args", "the answer is longer than 1,000 characters");
    return answer;
  }
  if (values.length === 0) throw new FlowrynError("bad_args", `choose ${kind === "multi" ? "at least one" : "one"} of: ${opts.join(", ")}, or ${OTHER_ANSWER} with your words`);
  const other = values.some((v) => v.toLowerCase() === OTHER_ANSWER);
  const picked = values.filter((v) => v.toLowerCase() !== OTHER_ANSWER);
  if (other && !hasWords) throw new FlowrynError("bad_args", `"${OTHER_ANSWER}" needs your words: say what you want in the note (decide: --words or --body-file)`);
  const unknown = picked.find((v) => !opts.includes(v));
  if (unknown !== undefined) throw new FlowrynError("bad_args", `"${sanitizeLine(unknown, 60)}" is not an option; choose from: ${opts.join(", ")}, or ${OTHER_ANSWER} with your words`);
  if (kind === "single") {
    if (new Set(values.map((v) => (v.toLowerCase() === OTHER_ANSWER ? OTHER_ANSWER : v))).size !== 1) throw new FlowrynError("bad_args", "this question takes one choice");
    return other ? OTHER_ANSWER : picked[0]!;
  }
  return [...opts.filter((o) => picked.includes(o)), ...(other ? [OTHER_ANSWER] : [])].join(", ");
}
