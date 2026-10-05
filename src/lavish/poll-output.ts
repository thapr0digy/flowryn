/**
 * What `lavish-axi poll <page>` printed, read by fixed patterns (no model).
 * Measured on lavish-axi 0.1.65 (docs/m5-notes.md, "Gate questions"): the
 * output is TOON; `status: feedback` with `prompts[N]` (or `prompts[N]{…}:`
 * when every prompt has the same fields), `session_ended: true` on the last
 * batch before the user ended the session, and `status: ended` after it. The
 * question widget ends each answer's prompt text with one line
 * `flowryn-answer v1 <base64url JSON>`, which survives any quoting the
 * encoder applies, so the answers never depend on the TOON layout.
 */

import { decode as decodeToon } from "@toon-format/toon";

export const ANSWER_MARK = "flowryn-answer v1";
const ANSWER_LINE = /flowryn-answer v1 ([A-Za-z0-9_-]{4,8000})/g;
const PROMPT_COUNT = /^prompts\[(\d+)\]/m;
const MAX_ANSWERS = 50;

export interface LavishAnswer {
  gate: string;
  decision: string;
  choice: string[];
  note: string | null;
}

export interface PollOutput {
  status: "feedback" | "ended" | "waiting" | "unknown";
  /** The user ended the session (this batch is the last one). */
  ended: boolean;
  answers: LavishAnswer[];
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
    if (typeof text !== "string" || text.includes(ANSWER_MARK)) continue;
    const trimmed = text.trim();
    if (trimmed.length > 0) texts.push(trimmed.slice(0, MAX_FEEDBACK_CHARS));
    if (texts.length >= MAX_FEEDBACK) break;
  }
  return texts;
}

function decode(token: string): LavishAnswer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.g !== "string" || !/^g\d{1,9}$/.test(p.g)) return null;
  if (typeof p.d !== "string" || !/^q\d{1,9}$/.test(p.d)) return null;
  if (!Array.isArray(p.c) || p.c.length > 20 || p.c.some((c) => typeof c !== "string" || c.length > 1_000)) return null;
  const note = typeof p.n === "string" && p.n.trim().length > 0 ? p.n.slice(0, 2_000) : null;
  return { gate: p.g, decision: p.d, choice: p.c as string[], note };
}

/** Encode an answer the way the widget does (tests and the doctor's contract check). */
export function encodeAnswer(a: LavishAnswer): string {
  return Buffer.from(JSON.stringify({ g: a.gate, d: a.decision, c: a.choice, n: a.note ?? "" }), "utf8").toString("base64url");
}

export function parsePollOutput(stdout: string): PollOutput {
  const statusMatch = /^\s{0,4}status: (\w+)/m.exec(stdout);
  const raw = statusMatch?.[1] ?? "unknown";
  const status = raw === "feedback" || raw === "ended" || raw === "waiting" ? raw : "unknown";
  const ended = status === "ended" || /^\s{0,4}session_ended: true$/m.test(stdout);
  const seen = new Set<string>();
  const answers: LavishAnswer[] = [];
  let malformed = 0;
  for (const match of stdout.matchAll(ANSWER_LINE)) {
    const token = match[1]!;
    if (seen.has(token)) continue;
    seen.add(token);
    if (answers.length >= MAX_ANSWERS) break;
    const answer = decode(token);
    if (answer) answers.push(answer);
    else malformed += 1;
  }
  const count = Number(PROMPT_COUNT.exec(stdout)?.[1] ?? "0");
  return { status, ended, answers, malformed, otherPrompts: Math.max(0, count - answers.length - malformed), feedback: feedbackTexts(stdout) };
}
