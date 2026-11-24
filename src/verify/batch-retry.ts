import type { Db } from "../db/db.ts";
import type { HostVerdict } from "../sched/host.ts";
import type { BatchRow } from "./batch-store.ts";
import type { LandingRow } from "./landing-queue.ts";
import { verifyVerdict } from "./route.ts";
import type { Verification } from "./store.ts";

/**
 * How a red landing batch is judged and what verifies next (docs/notes/2026-11-21-landing-batches-one-27.md
 * "Split and retry"). Plain code: the verdict, the event log, one host sample and a fixed list of
 * test-runner timeout lines; no model. Pure reads: src/verify/landing-batch.ts writes.
 *
 * - A failure that looks environmental (a step deadline, a verify error, a test runner's own
 *   timeout, the host over its load limit while it ran) is verified again after a backoff, at most
 *   MAX_AUTO_RETRIES times per batch head; the verify queue starts it only under the host check.
 * - Anything else, or the retries used up, splits the batch in halves (in line order). The halves
 *   still to verify are the batch's split stack, carried to the batch verified next.
 */

/** Automatic retries of one batch head whose failure looks environmental, before it counts as red. */
export const MAX_AUTO_RETRIES = 2;
/** How long each automatic retry waits after the failure, by attempt (the first, then the second). */
export const RETRY_BACKOFF_MS = [5 * 60_000, 15 * 60_000] as const;

/** Why a verify failed: a cause other than `red` looks environmental. */
export type FailureCause = "timeout" | "error" | "test_timeout" | "load" | "red";

/**
 * A test runner's own timeout, read from the failing step's log tail: Go's per-package panic
 * (`panic: test timed out after 5m0s`) and bun's per-test line under its `(fail)` line
 * (`  ^ this test timed out after 5000ms.`, bun 1.4.4).
 */
export const TEST_TIMEOUT_LINES: readonly RegExp[] = [/^panic: test timed out after \S+/m, /^\s*\^ this test timed out after \d+m?s\./m];

/** The host check's reason when load, not memory or a probe, refused it (src/sched/host.ts judgeHost). */
const LOAD_REASON = /\bload [\d.]+ per core, over\b/;

/** Whether the host check refused on load at any moment of the verification: the state at its start, or a flip during it. */
function loadDuring(db: Db, v: Verification): boolean {
  const end = v.finished_at ?? v.started_at;
  const before = db.query("SELECT kind, payload FROM events WHERE kind IN ('sched.host_ok','sched.host_blocked') AND ts <= ?1 ORDER BY seq DESC LIMIT 1").get(v.started_at) as { kind: string; payload: string } | null;
  if (before?.kind === "sched.host_blocked" && LOAD_REASON.test(before.payload)) return true;
  const during = db.query("SELECT payload FROM events WHERE kind = 'sched.host_blocked' AND ts > ?1 AND ts <= ?2").all(v.started_at, end) as { payload: string }[];
  return during.some((e) => LOAD_REASON.test(e.payload));
}

/**
 * Why `v` failed, first match wins: a step at its deadline (`timeout`), a verify error or a review
 * with no verdict (`error`), a test runner's timeout line in the failing step's `tail`
 * (`test_timeout`), the host over its load limit during the verify or now (`host`, the check
 * sampled as the red is judged; null when it could not be read) (`load`), else `red`.
 */
export function envCause(db: Db, v: Verification, host: HostVerdict | null, tail: string): FailureCause {
  const verdict = verifyVerdict(v);
  if ("rerun" in verdict) return "timeout";
  if ("hold" in verdict) return "error";
  if (TEST_TIMEOUT_LINES.some((line) => line.test(tail))) return "test_timeout";
  if (loadDuring(db, v) || (host !== null && !host.ok && LOAD_REASON.test(host.reason))) return "load";
  return "red";
}

/** A batch's split stack: when its first red was judged, and the halves still to verify (landing ids, in line order). */
export interface SplitStack {
  since: number;
  halves: string[][];
}

export function splitStack(batch: Pick<BatchRow, "split_rest">): SplitStack | null {
  if (!batch.split_rest) return null;
  try {
    const parsed = JSON.parse(batch.split_rest) as SplitStack;
    return Array.isArray(parsed.halves) && typeof parsed.since === "number" ? parsed : null;
  } catch {
    return null;
  }
}

/** The JSON a batch row keeps, or null for no stack. A spent stack (no halves) is kept for its `since`. */
export function stackJson(stack: SplitStack | null): string | null {
  return stack ? JSON.stringify(stack) : null;
}

/** A red batch's members in line order, split: the first half (rounded up) and the rest. */
export function halve<T>(members: T[]): { first: T[]; rest: T[] } {
  const cut = Math.ceil(members.length / 2);
  return { first: members.slice(0, cut), rest: members.slice(cut) };
}

/**
 * What the next batch takes from the entries that may join one (`eligible`, line order): the
 * first half of the project's split stack whose members still wait at their heads, with the rest
 * of the stack carried; nothing else joins while the stack has a half. With no stack, the first
 * `max` entries, as before.
 */
export function nextBatchMembers(stack: SplitStack | null, eligible: LandingRow[], max: number): { members: LandingRow[]; stack: SplitStack | null } {
  if (stack) {
    for (const [i, half] of stack.halves.entries()) {
      const members = half.map((id) => eligible.find((r) => r.id === id)).filter((r): r is LandingRow => r !== undefined);
      if (members.length > 0) return { members: members.slice(0, max), stack: { since: stack.since, halves: stack.halves.slice(i + 1) } };
    }
  }
  return { members: eligible.slice(0, max), stack: null };
}
