import type { Role } from "../api/verbs.ts";
import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { openItem, resolveItems } from "./items.ts";

/**
 * The leader follow-ups (LEADER_WAKE_KINDS in items.ts). Something you did
 * outside the leader session, in your terminal or on the board, opens a
 * user_acted item, so an idle leader wakes once to follow it up: merge what
 * you approved, discard what you approved discarding, tell you the next stage
 * started. Only a human-role caller opens one: the leader's own actions never
 * wake it. A merge proven outside the leader's own merge call opens a landed
 * item (landRun in src/lifecycle/landing.ts), so the leader reports it.
 */

export type UserAction = "merge_approved" | "discard_approved" | "gate_passed" | "gate_changes" | "declined" | "merge_refused";

/**
 * Open a user_acted item for an action of yours, in the action's transaction.
 * A newer action on the same task supersedes an older follow-up still open.
 * Returns the item, or null when the caller is not you.
 */
export function openUserActed(db: Db, role: Role, input: { action: UserAction; taskId: string; runId: string | null; line: string; now: number }): string | null {
  if (role !== "human") return null;
  resolveItems(db, "user_acted", input.taskId, "a newer action of the user", input.now);
  const event = appendEvent(db, { source: "cli", kind: "user.acted", runId: input.runId, taskId: input.taskId, payload: { action: input.action }, ts: input.now });
  return openItem(db, { kind: "user_acted", eventSeq: event.seq, taskId: input.taskId, runId: input.runId, line: input.line, now: input.now });
}
