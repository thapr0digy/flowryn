import { FlowrynError } from "../api/errors.ts";
import { table, type FlowrynConfig } from "./config.ts";

/**
 * [ask]: the headless question-and-answer runner (docs/notes/2026-10-30-ask-a-lightweight-4v.md).
 *
 * - `max_usd`: the spend cap of one ask, in dollars (`dispatch --max-usd` lowers or raises it for one).
 * - `timeout_ms`: the deadline of one ask's model call.
 * - `max_concurrent`: asks running at once, across every project and account.
 * - `max_answer_bytes`: the most of an answer kept in the database; a longer one is cut there and kept whole on disk.
 */
export interface AskConfig {
  max_usd: number;
  timeout_ms: number;
  max_concurrent: number;
  max_answer_bytes: number;
}

export const DEFAULT_ASK: AskConfig = {
  max_usd: 1,
  timeout_ms: 600_000,
  max_concurrent: 2,
  max_answer_bytes: 8_192,
};

/** The highest cap one ask may be given, so a typo cannot authorise a large spend. */
export const MAX_ASK_USD = 20;

function positiveInt(value: unknown, key: keyof AskConfig): number {
  if (value === undefined) return DEFAULT_ASK[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new FlowrynError("config_invalid", `[ask] ${key} must be a positive whole number`);
  return value;
}

/** A spend cap in dollars: above 0, at most MAX_ASK_USD. */
export function checkUsd(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_ASK_USD) throw new FlowrynError(where.startsWith("[") ? "config_invalid" : "bad_args", `${where} must be a dollar amount above 0 and at most ${MAX_ASK_USD}`);
  return value;
}

export function askConfig(config: FlowrynConfig): AskConfig {
  const raw = table(config.extra.ask, "[ask]");
  for (const key of Object.keys(raw)) {
    if (!(key in DEFAULT_ASK)) throw new FlowrynError("config_invalid", `[ask] ${key} is not a known setting`);
  }
  return {
    max_usd: raw.max_usd === undefined ? DEFAULT_ASK.max_usd : checkUsd(raw.max_usd, "[ask] max_usd"),
    timeout_ms: positiveInt(raw.timeout_ms, "timeout_ms"),
    max_concurrent: positiveInt(raw.max_concurrent, "max_concurrent"),
    max_answer_bytes: positiveInt(raw.max_answer_bytes, "max_answer_bytes"),
  };
}
