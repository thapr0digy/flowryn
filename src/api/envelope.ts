import type { ErrorBody } from "./errors.ts";

/** Every socket call: `{proto, ulid, verb, token, args}` (design section 12). */
export interface Envelope {
  proto: number;
  ulid: string;
  verb: string;
  token?: string | null;
  /**
   * "tty" when a token-less CLI verified it runs in your own terminal (no
   * FLOWRYN_* identity, a TTY). Confused-agent-grade, like the approve challenge.
   */
  channel?: "tty" | null;
  args: Record<string, unknown>;
}

/** Every reply: `{ok, data | error, hints}`. */
export interface Reply {
  ok: boolean;
  data?: unknown;
  error?: ErrorBody;
  hints?: string[];
  /** The daemon's protocol version, sent with protocol_mismatch. */
  proto?: number;
}

export const MAX_HINTS = 2;

export function okReply(data: unknown, hints: string[] = []): Reply {
  const reply: Reply = { ok: true, data };
  if (hints.length > 0) reply.hints = hints.slice(0, MAX_HINTS);
  return reply;
}

export function errorReply(error: ErrorBody, extra: Partial<Reply> = {}): Reply {
  return { ok: false, error, ...extra };
}

export function parseEnvelope(value: unknown): Envelope | string {
  if (typeof value !== "object" || value === null) return "envelope is not an object";
  const env = value as Record<string, unknown>;
  if (typeof env.proto !== "number") return "envelope.proto must be a number";
  if (typeof env.ulid !== "string") return "envelope.ulid must be a string";
  if (typeof env.verb !== "string" || env.verb.length === 0) return "envelope.verb must be a non-empty string";
  if (env.token !== undefined && env.token !== null && typeof env.token !== "string") return "envelope.token must be a string";
  if (env.channel !== undefined && env.channel !== null && env.channel !== "tty") return "envelope.channel must be \"tty\"";
  if (typeof env.args !== "object" || env.args === null || Array.isArray(env.args)) return "envelope.args must be an object";
  return env as unknown as Envelope;
}
