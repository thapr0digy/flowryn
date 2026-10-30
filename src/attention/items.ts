import type { Db } from "../db/db.ts";
import { getMeta, setMeta, tx } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { sanitizeLine } from "../util/sanitize.ts";
import { closeItemExplanations } from "./explanations.ts";

export type Lane = "P0" | "P1" | "P2";
export type ItemClass = "actionable" | "info";

/**
 * The lane table (design section 9): an event kind decides lane and class.
 * Nothing scores items; project priority and due date only order within a lane.
 * M1 opened the backlog kinds, M2 the worker and run kinds, M3 the overdue
 * to-dos, M4 the delivery kinds (PR checks red, PR closed, cleanup refused,
 * no-mistakes unreachable), M5 the workflow kinds (a review gate ready, work
 * waiting over 30 min for capacity, Docker containers left without a lease, a
 * ready phase that cannot start, the Claude usage limit, a phase started by
 * itself, a no-mistakes pipeline started outside its validation slot), and the
 * v1 completion pass the section 16 failure P1s (a harness version with no
 * passing contract, Herdr unreachable, GitHub unavailable while a merge waits).
 * steer_unacked is the section 6 "re-ring up to 3 times, then a P1".
 * The cutover adds blocked_prompt: a worker stopped by a confirmation prompt mid-run.
 * restart_dropped: a `flowryn daemon restart` that will not happen (its binary
 * failed the check, its supervisor refused, or `--when-idle` expired).
 * restart_failed: a launchd restart that left flowrynd down until something
 * else brought it back (src/service/relaunch.ts); opened by the next daemon.
 * review_feedback: what you sent from a review page the daemon polls (before
 * review pages talked to their worker; nothing opens it any more).
 * review_summary: a review page's conversation ended while its gate is still
 * open, so the leader puts pass or changes to the user; review_recap, the same
 * summary once the gate had closed (informational); review_worker_gone, a page
 * message found the review's worker gone and no resume left to try
 * (src/lifecycle/review-chat.ts).
 * pass_requested: the user asked on a review page to pass its gate; the
 * leader confirms it with them through a human channel.
 * contract_recorded: the leader, or the daemon's automatic check, recorded a
 * harness contract pass (relaxed policy, installed build); informational, so
 * you see every one, until the harness's next record supersedes it (recordPass).
 * Info items never count in a P1 total and close a day after they were
 * presented (closeSeenInfoItems).
 * contract_leftover: the daemon's automatic contract check could not release
 * what a run created (a Herdr workspace, a process, a worktree, its scratch
 * home); the line and its event name each one and the run's manifest.
 * build_refused: the build watcher found an installed build it will not apply
 * (older than the running daemon, or failing its binary check).
 * build_held: an installed build the watcher leaves to you (unstamped, built
 * from a dirty tree, or not merged yet); informational.
 * worker_report: a worker's `flowryn report` whose status word opens an item
 * (REPORT_EFFECT in src/lifecycle/worker.ts), such as a finding or a blocker.
 * validation_stuck: a ship holds its validation slot with no progress (its
 * no-mistakes step quiet, or its run gone or ended with nothing delivered).
 * worker_not_exited: a fresh stage's old worker did not exit after several
 * scheduler attempts, so its replacement waits (src/sched/scheduler.ts).
 * operation_escalated: recovery of a launch, resume or cancel could not tell
 * from the evidence what happened (src/lifecycle/operation-recovery.ts), so the
 * run waits for you.
 * The upkeep hooks (src/upkeep/, spec 3 phase 3): build_failed, the daemon's
 * build after a Flowryn merge failed; checkout_unsynced, a primary checkout
 * the sync left alone (informational); conflict_nudged, a delivered PR that
 * conflicts sent its ship back to merge its base (informational); and
 * pr_conflict, one that still conflicts after its nudges.
 * Review feedback (src/reconcile/reviews.ts): review_steered, a delivered PR's
 * new reviews or comments sent its ship back to address them (informational);
 * review_unanswered, a review thread still unanswered after its sends, or more
 * feedback after the sends one delivered head may get.
 * The policy follow-through (src/upkeep/policy-follow.ts): policy_sent_back,
 * a delivered ship sent back to merge main's policy change (informational);
 * policy_behind, a ship delivered again still behind a policy change it was
 * already told to merge (informational).
 * review_channel: a review page's Lavish poll has failed for a while, so answers
 * sent on the page are not reaching Flowryn (src/lavish/channel.ts).
 * The leader follow-ups (src/attention/follow-up.ts): user_acted, something you
 * did outside the leader session (an approval, a decline, a gate pass) that the
 * leader follows up; landed, a merge proven outside the leader's own merge call.
 * watch_stuck: a task filed with `dispatch --after` waits for an event that
 * cannot happen as things stand (its PR closed unmerged, its scout failed or
 * dropped; src/lifecycle/watches.ts).
 * stack_base_lost: a stacked run's base task was dropped, failed or had its PR
 * closed unmerged, so the run cannot land as stacked (src/lifecycle/stacks.ts).
 */
export const LANE_TABLE = {
  worker_question_blocking: { lane: "P0", class: "actionable" },
  failure_needs_you: { lane: "P0", class: "actionable" },
  sensitive_action_waiting: { lane: "P0", class: "actionable" },
  pr_ready: { lane: "P1", class: "actionable" },
  gate_ready: { lane: "P1", class: "actionable" },
  pass_requested: { lane: "P1", class: "actionable" },
  review_channel: { lane: "P1", class: "actionable" },
  report_ready: { lane: "P1", class: "actionable" },
  worker_question: { lane: "P1", class: "actionable" },
  review_feedback: { lane: "P1", class: "actionable" },
  review_summary: { lane: "P1", class: "actionable" },
  review_worker_gone: { lane: "P1", class: "actionable" },
  divergence: { lane: "P1", class: "actionable" },
  worker_idle: { lane: "P1", class: "actionable" },
  unproven_merge: { lane: "P1", class: "actionable" },
  backlog_out_of_sync: { lane: "P1", class: "actionable" },
  trust_dialog: { lane: "P1", class: "actionable" },
  blocked_prompt: { lane: "P1", class: "actionable" },
  overdue_todo: { lane: "P1", class: "actionable" },
  steer_unacked: { lane: "P1", class: "actionable" },
  checkout_tangle: { lane: "P1", class: "actionable" },
  checks_red: { lane: "P1", class: "actionable" },
  pr_closed: { lane: "P1", class: "actionable" },
  cleanup_refused: { lane: "P1", class: "actionable" },
  nomistakes_down: { lane: "P1", class: "actionable" },
  capacity_wait: { lane: "P1", class: "actionable" },
  docker_leftover: { lane: "P1", class: "actionable" },
  contract_leftover: { lane: "P1", class: "actionable" },
  phase_blocked: { lane: "P1", class: "actionable" },
  watch_stuck: { lane: "P1", class: "actionable" },
  stack_base_lost: { lane: "P1", class: "actionable" },
  usage_limit: { lane: "P1", class: "actionable" },
  quota_low: { lane: "P1", class: "actionable" },
  account_signed_out: { lane: "P1", class: "actionable" },
  validation_outside_cap: { lane: "P1", class: "actionable" },
  validation_stuck: { lane: "P1", class: "actionable" },
  worker_not_exited: { lane: "P1", class: "actionable" },
  operation_escalated: { lane: "P1", class: "actionable" },
  harness_unverified: { lane: "P1", class: "actionable" },
  herdr_unreachable: { lane: "P1", class: "actionable" },
  forge_unavailable: { lane: "P1", class: "actionable" },
  restart_dropped: { lane: "P1", class: "actionable" },
  restart_failed: { lane: "P1", class: "actionable" },
  build_refused: { lane: "P1", class: "actionable" },
  worker_report: { lane: "P1", class: "actionable" },
  build_failed: { lane: "P1", class: "actionable" },
  user_acted: { lane: "P1", class: "actionable" },
  landed: { lane: "P1", class: "actionable" },
  pr_conflict: { lane: "P1", class: "actionable" },
  auto_merge_held: { lane: "P1", class: "actionable" },
  review_unanswered: { lane: "P1", class: "actionable" },
  yolo_merged: { lane: "P1", class: "info" },
  contract_recorded: { lane: "P1", class: "info" },
  build_held: { lane: "P1", class: "info" },
  checkout_unsynced: { lane: "P1", class: "info" },
  conflict_nudged: { lane: "P1", class: "info" },
  review_steered: { lane: "P1", class: "info" },
  policy_sent_back: { lane: "P1", class: "info" },
  policy_behind: { lane: "P1", class: "info" },
  phase_started: { lane: "P1", class: "info" },
  auto_resumed: { lane: "P1", class: "info" },
  steer_acked: { lane: "P1", class: "info" },
  review_recap: { lane: "P1", class: "info" },
  progress: { lane: "P2", class: "info" },
} as const satisfies Record<string, { lane: Lane; class: ItemClass }>;

export type ItemKind = keyof typeof LANE_TABLE;

/**
 * A worker's questions for you, blocking (P0) or not (P1), a review gate's,
 * and what you sent from a review page (its summary): they reach the leader as a batch
 * (questionBatch in router.ts), never one push each, so the P0 push path
 * leaves them alone.
 */
export const QUESTION_KINDS: readonly ItemKind[] = ["worker_question", "worker_question_blocking", "review_feedback", "review_summary"];

/**
 * Items the leader handles by relaying them to you or dismissing them: a
 * Claude leader's turn end carries each once (relayBatch in router.ts), so a
 * worker's report, a dropped restart or a stuck validation is not left for
 * your next message.
 */
export const RELAY_KINDS: readonly ItemKind[] = ["worker_report", "restart_dropped", "restart_failed", "validation_stuck", "user_acted", "landed", "pass_requested"];

/**
 * Items that wake an idle leader as a P0 would, though they are P1: what you
 * did outside the leader session (user_acted, and a pass you asked for on a
 * review page), a merge that landed without the leader's own merge call, and
 * a yolo task's PR ready for the leader to verify and merge (LEADER_WAKE_SQL),
 * and an auto-merge that was held. Each wakes it once (followUpBatch in router.ts).
 */
export const LEADER_WAKE_KINDS: readonly ItemKind[] = ["user_acted", "pass_requested", "landed", "pr_ready", "auto_merge_held"];

/**
 * SQL for "item `i` is a leader follow-up": a LEADER_WAKE_KINDS item, where a
 * pr_ready counts only when its task is yolo (the leader merges it with no
 * prompt) and no auto-merge is working on its run (the daemon merges it with
 * no leader turn; a held one wakes it as auto_merge_held). A pr_ready that
 * waits on you is not one: it wakes only while you are away (awayWakeSql in
 * away.ts). A pr_ready is never sensitive work, which opens
 * sensitive_action_waiting instead.
 */
export const LEADER_WAKE_SQL = `(i.kind IN (${LEADER_WAKE_KINDS.filter((k) => k !== "pr_ready")
  .map((k) => `'${k}'`)
  .join(", ")}) OR (i.kind = 'pr_ready' AND EXISTS (SELECT 1 FROM task_policy wp WHERE wp.task_id = i.task_id AND wp.yolo = 1)
    AND NOT EXISTS (SELECT 1 FROM auto_merges wa WHERE wa.run_id = i.run_id AND wa.state IN ('queued','verifying','waiting_checks','merging'))))`;

export interface ItemRow {
  id: string;
  event_seq: number;
  class: ItemClass;
  lane: Lane;
  kind: string;
  task_id: string | null;
  run_id: string | null;
  decision_id: string | null;
  line: string;
  /** The whole line when `line` was cut, else null. */
  full_line: string | null;
  state: string;
  resolved_by: string | null;
  opened_at: number;
  resolved_at: number | null;
}

function nextItemId(db: Db): string {
  const next = Number(getMeta(db, "next_item_no") ?? "1");
  setMeta(db, "next_item_no", String(next + 1));
  return `i${next}`;
}

export interface OpenItem {
  kind: ItemKind;
  eventSeq: number;
  line: string;
  taskId?: string | null;
  runId?: string | null;
  /** A due date (YYYY-MM-DD) that orders the item within its lane: overdue to-dos. */
  due?: string | null;
  now?: number;
}

/** The most of a cut item line kept for `show --full`. */
export const MAX_FULL_LINE_CHARS = 4_000;

/** An item's stored lines: the digest line, and its whole text only when the digest cut it. */
export function itemLines(text: string): { line: string; full_line: string | null } {
  const line = sanitizeLine(text);
  const whole = sanitizeLine(text, MAX_FULL_LINE_CHARS);
  return { line, full_line: whole === line ? null : whole };
}

/** Open an item for an event. Call inside the event's transaction. */
export function openItem(db: Db, item: OpenItem): string {
  const { lane, class: klass } = LANE_TABLE[item.kind];
  const id = nextItemId(db);
  const { line, full_line } = itemLines(item.line);
  db.query(
    `INSERT INTO items (id, event_seq, class, lane, kind, task_id, run_id, line, full_line, due, opened_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  ).run(id, item.eventSeq, klass, lane, item.kind, item.taskId ?? null, item.runId ?? null, line, full_line, item.due ?? null, item.now ?? Date.now());
  return id;
}

/** The newest item number handed out, so the attention pump can tell that something opened. */
export function lastItemNo(db: Db): number {
  return Number(getMeta(db, "next_item_no") ?? "1") - 1;
}

export function findOpenItem(db: Db, kind: ItemKind, taskId: string | null): ItemRow | null {
  return db
    .query("SELECT * FROM items WHERE kind = ?1 AND task_id IS ?2 AND state IN ('open','presented') ORDER BY opened_at LIMIT 1")
    .get(kind, taskId) as ItemRow | null;
}

/** Resolve open items of a kind for a task; an item closes only by its resolution, never by delivery. */
export function resolveItems(db: Db, kind: ItemKind, taskId: string | null, resolvedBy: string, now = Date.now()): number {
  const result = db
    .query(
      `UPDATE items SET state = 'resolved', resolved_by = ?3, resolved_at = ?4
       WHERE kind = ?1 AND task_id IS ?2 AND state IN ('open','presented')`,
    )
    .run(kind, taskId, resolvedBy, now);
  return result.changes;
}

/** Resolve the open items that carry one decision. */
export function resolveDecisionItems(db: Db, decisionId: string, resolvedBy: string, now = Date.now()): number {
  return db
    .query("UPDATE items SET state = 'resolved', resolved_by = ?2, resolved_at = ?3 WHERE decision_id = ?1 AND state IN ('open','presented')")
    .run(decisionId, resolvedBy, now).changes;
}

/** Open items of a kind for one run. */
export function findOpenRunItem(db: Db, kind: ItemKind, runId: string): ItemRow | null {
  return db
    .query("SELECT * FROM items WHERE kind = ?1 AND run_id = ?2 AND state IN ('open','presented') ORDER BY opened_at LIMIT 1")
    .get(kind, runId) as ItemRow | null;
}

/** Resolve a run's open items of the given kinds (all kinds when none are named), and close the wait explanations they carried. */
export function resolveRunItems(db: Db, runId: string, kinds: readonly ItemKind[] | null, resolvedBy: string, now = Date.now()): number {
  if (kinds && kinds.length === 0) return 0;
  const filter = kinds ? `AND kind IN (${kinds.map((_, i) => `?${i + 4}`).join(", ")})` : "";
  const resolved = db
    .query(`UPDATE items SET state = 'resolved', resolved_by = ?2, resolved_at = ?3 WHERE run_id = ?1 AND state IN ('open','presented') ${filter} RETURNING id`)
    .all(runId, resolvedBy, now, ...(kinds ?? [])) as { id: string }[];
  closeItemExplanations(db, resolved.map((r) => r.id), resolvedBy, now);
  return resolved.length;
}

export function openItems(db: Db): ItemRow[] {
  return db.query("SELECT * FROM items WHERE state IN ('open','presented') ORDER BY lane, opened_at").all() as ItemRow[];
}

/**
 * How long an informational item stays open once a leader turn has shown it.
 * A day, like the board's "UPDATES (last day)", which lists info items in any
 * state, so closing one never hides it from the board early.
 */
export const INFO_KEEP_MS = 86_400_000;

/** The resolved_by of an info item closed by its retention. */
export const INFO_KEPT_REASON = "presented, kept 1 day";

/**
 * Retention for informational items: each one a leader turn presented over
 * INFO_KEEP_MS ago (its newest confirmed presentation) is resolved, with one
 * `items.info_closed` event when any closed. Actionable items are never
 * touched, and an info item never presented stays for the digest (or drops
 * after its carries, loseCarried). Runs in its own transaction (the upkeep pass).
 */
export function closeSeenInfoItems(db: Db, now: number): string[] {
  return tx(db, () => {
    const closed = db
      .query(
        `UPDATE items SET state = 'resolved', resolved_by = ?2, resolved_at = ?1
         WHERE class = 'info' AND state = 'presented'
           AND (SELECT MAX(s.confirmed_at) FROM presentations s WHERE s.item_id = items.id AND s.state = 'presented') < ?1 - ?3
         RETURNING id`,
      )
      .all(now, INFO_KEPT_REASON, INFO_KEEP_MS) as { id: string }[];
    const ids = closed.map((r) => r.id);
    if (ids.length === 0) return ids;
    closeItemExplanations(db, ids, INFO_KEPT_REASON, now);
    appendEvent(db, { source: "daemon", kind: "items.info_closed", payload: { items: ids, keep_ms: INFO_KEEP_MS }, ts: now });
    return ids;
  });
}
