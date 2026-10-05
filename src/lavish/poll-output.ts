/**
 * What `lavish-axi poll <page>` printed, read by fixed patterns (no model).
 * Measured on lavish-axi 0.1.65 (docs/m5-notes.md, "Gate questions"): the
 * output is TOON; `status: feedback` with `prompts[N]` (or `prompts[N]{…}:`
 * when every prompt has the same fields), `session_ended: true` on the last
 * batch before the user ended the session, and `status: ended` after it. The
 * question widget's one Send queues one prompt that ends with one line
 * `flowryn-answers v2 <base64url JSON {g, a: [{d, c, n}], m, p}>`: every
 * answer, the user's "anything else" (m) and whether they asked to pass (p).
 * A page loaded before that widget still sends one prompt per answer, ending
 * `flowryn-answer v1 <base64url JSON {g, d, c, n}>`. Either line survives any
 * quoting the encoder applies, so the answers never depend on the TOON layout.
 */

import { decode as decodeToon } from "@toon-format/toon";

export const ANSWER_MARK = "flowryn-answers v2";
const ANSWER_LINE = /flowryn-answer(s?) v([12]) ([A-Za-z0-9_-]{4,60000})/g;
/** A prompt carrying either answer line (v2 Send or v1 answer), which is not the user's own feedback. */
const ANSWER_PROMPT = /flowryn-answer(s v2| v1) /;
const PROMPT_COUNT = /^prompts\[(\d+)\]/m;
const MAX_ANSWERS = 50;
const MAX_CHOICES = 20;
const MAX_CHOICE = 1_000;
const MAX_NOTE = 2_000;
const MAX_COMMENT = 4_000;

export interface LavishAnswer {
  gate: string;
  decision: string;
  choice: string[];
  note: string | null;
}

/** What one Send carried beside its answers. */
export interface LavishSend {
  gate: string;
  /** The user's "anything else for the worker", verbatim. */
  comment: string | null;
  /** The user asked to pass the review (a request: the gate passes only through a human channel). */
  pass: boolean;
}

export interface PollOutput {
  status: "feedback" | "ended" | "waiting" | "unknown";
  /** The user ended the session (this batch is the last one). */
  ended: boolean;
  answers: LavishAnswer[];
  /** Each v2 Send, in order (a v1 answer carries none). */
  sends: LavishSend[];
  /** Tokens that did not decode to an answer. */
  malformed: number;
  /** Prompts that are not answers: annotations, chat, layout fixes. */
  otherPrompts: number;
  /** The text of each prompt that is not an answer, as the user wrote it (empty when the output does not decode). */
  feedback: string[];
}

const MAX_FEEDBACK = 20;
const MAX_FEEDBACK_CHARS = 2_000;

/** The user's own words in each prompt that is not an answer, read through the TOON decoder; nothing when it does not decode. */
function feedbackTexts(stdout: string): string[] {
  let parsed: unknown;
  try {
    parsed = decodeToon(stdout);
  } catch {
    return [];
  }
  const prompts = (parsed as { prompts?: unknown } | null)?.prompts;
  if (!Array.isArray(prompts)) return [];
  const texts: string[] = [];
  for (const p of prompts) {
    const text = (p as { prompt?: unknown } | null)?.prompt;
    if (typeof text !== "string" || ANSWER_PROMPT.test(text)) continue;
    const trimmed = text.trim();
    if (trimmed.length > 0) texts.push(trimmed.slice(0, MAX_FEEDBACK_CHARS));
    if (texts.length >= MAX_FEEDBACK) break;
  }
  return texts;
}

const GATE_ID = /^g\d{1,9}$/;
const DECISION_ID = /^q\d{1,9}$/;

function parseToken(token: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function optionalText(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.slice(0, max) : null;
}

/** One answer ({d, c, n}) of a gate, or null when it is not one. */
function decodeAnswer(gate: string, p: Record<string, unknown>): LavishAnswer | null {
  if (typeof p.d !== "string" || !DECISION_ID.test(p.d)) return null;
  if (!Array.isArray(p.c) || p.c.length > MAX_CHOICES || p.c.some((c) => typeof c !== "string" || c.length > MAX_CHOICE)) return null;
  return { gate, decision: p.d, choice: p.c as string[], note: optionalText(p.n, MAX_NOTE) };
}

function decodeV1(token: string): LavishAnswer | null {
  const p = parseToken(token);
  if (!p || typeof p.g !== "string" || !GATE_ID.test(p.g)) return null;
  return decodeAnswer(p.g, p);
}

/** A whole Send, all or nothing: one bad answer makes the token malformed. */
function decodeV2(token: string): { answers: LavishAnswer[]; send: LavishSend } | null {
  const p = parseToken(token);
  if (!p || typeof p.g !== "string" || !GATE_ID.test(p.g)) return null;
  if (!Array.isArray(p.a) || p.a.length > MAX_ANSWERS) return null;
  const answers: LavishAnswer[] = [];
  for (const raw of p.a) {
    const answer = typeof raw === "object" && raw !== null ? decodeAnswer(p.g, raw as Record<string, unknown>) : null;
    if (!answer) return null;
    answers.push(answer);
  }
  if (p.m !== undefined && typeof p.m !== "string") return null;
  return { answers, send: { gate: p.g, comment: optionalText(p.m, MAX_COMMENT), pass: p.p === true } };
}

/** Encode an answer the way a v1 widget did (tests). */
export function encodeAnswer(a: LavishAnswer): string {
  return Buffer.from(JSON.stringify({ g: a.gate, d: a.decision, c: a.choice, n: a.note ?? "" }), "utf8").toString("base64url");
}

/** Encode a Send the way the widget does (tests and stand-ins). */
export function encodeSend(send: LavishSend, answers: Omit<LavishAnswer, "gate">[]): string {
  const a = answers.map((x) => ({ d: x.decision, c: x.choice, n: x.note ?? "" }));
  return Buffer.from(JSON.stringify({ g: send.gate, a, m: send.comment ?? "", p: send.pass }), "utf8").toString("base64url");
}

export function parsePollOutput(stdout: string): PollOutput {
  const statusMatch = /^\s{0,4}status: (\w+)/m.exec(stdout);
  const raw = statusMatch?.[1] ?? "unknown";
  const status = raw === "feedback" || raw === "ended" || raw === "waiting" ? raw : "unknown";
  const ended = status === "ended" || /^\s{0,4}session_ended: true$/m.test(stdout);
  const seen = new Set<string>();
  const answers: LavishAnswer[] = [];
  const sends: LavishSend[] = [];
  let tokens = 0;
  let malformed = 0;
  for (const match of stdout.matchAll(ANSWER_LINE)) {
    const [, plural, version, token] = match as unknown as [string, string, string, string];
    // The mark and its version go together: "flowryn-answer v1" or "flowryn-answers v2".
    if ((plural === "s") !== (version === "2")) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    if (version === "1") {
      const answer = decodeV1(token);
      if (answer) {
        if (answers.length < MAX_ANSWERS) answers.push(answer);
        tokens += 1;
      } else malformed += 1;
      continue;
    }
    const send = decodeV2(token);
    if (!send) {
      malformed += 1;
      continue;
    }
    answers.push(...send.answers.slice(0, MAX_ANSWERS - answers.length));
    sends.push(send.send);
    tokens += 1;
  }
  const count = Number(PROMPT_COUNT.exec(stdout)?.[1] ?? "0");
  return { status, ended, answers, sends, malformed, otherPrompts: Math.max(0, count - tokens - malformed), feedback: feedbackTexts(stdout) };
}
