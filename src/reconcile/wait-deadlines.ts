import { FlowrynError } from "../api/errors.ts";
import { table, type FlowrynConfig } from "../config/config.ts";

/**
 * The wait registry's deadline table (src/reconcile/waits.ts,
 * docs/notes/2026-11-06-no-silent-waits-vj.md), and its `[waits]` overrides.
 */

const MIN = 60_000;

export const WAIT_KINDS = ["verify_queue", "capacity", "host", "harness_check", "phase_start", "auto_merge", "landing"] as const;
export type WaitKind = (typeof WAIT_KINDS)[number];

/**
 * The deadlines. verify_queue counts from the request's expected start (the
 * last move of a request ahead of it, or the expected end of the verifies not
 * started from a request behind it);
 * phase_start from its last blocker's landing or cleanup (it is ready once cleaned); auto_merge from its last state
 * change, except a PR waiting on checks: pending checks are due at the auto-merger's checks limit, and a head
 * that moved 30 min after the auto-merger first saw it move; the others from when the wait began.
 */
export const WAIT_DEADLINES_MS: Readonly<Record<WaitKind, number>> = {
  verify_queue: 20 * MIN,
  capacity: 10 * MIN,
  host: 10 * MIN,
  harness_check: 20 * MIN,
  phase_start: 10 * MIN,
  auto_merge: 30 * MIN,
  landing: 30 * MIN,
};

/** `[waits] <kind>_min` overrides: whole minutes, at least this many, at most a day. */
export const MIN_WAIT_MIN = 1;
export const MAX_WAIT_MIN = 24 * 60;

/** `[waits]`: each kind's deadline in ms, the table's unless the file sets `<kind>_min`. Throws config_invalid on a bad value. */
export function waitDeadlines(config: FlowrynConfig): Record<WaitKind, number> {
  const raw = table(config.extra.waits, "[waits]");
  const keys = WAIT_KINDS.map((k) => `${k}_min`);
  for (const key of Object.keys(raw)) if (!keys.includes(key)) throw new FlowrynError("config_invalid", `[waits] ${key} is not a known setting (${keys.join(", ")})`);
  const out = { ...WAIT_DEADLINES_MS };
  for (const kind of WAIT_KINDS) {
    const value = raw[`${kind}_min`];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_WAIT_MIN || value > MAX_WAIT_MIN) {
      throw new FlowrynError("config_invalid", `[waits] ${kind}_min must be a whole number of minutes from ${MIN_WAIT_MIN} to ${MAX_WAIT_MIN}`);
    }
    out[kind] = value * MIN;
  }
  return out;
}

