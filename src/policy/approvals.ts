import { randomBytes, randomInt } from "node:crypto";
import type { Db } from "../db/db.ts";
import { getMeta, setMeta } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { sha256Hex } from "../util/hash.ts";
import { ulid } from "../util/ulid.ts";

/**
 * Approvals (design section 7): "your word" is a record only a human channel
 * can create, bound to the task, the canonical PR (or a local-only branch)
 * and the head SHA, single use, and void after 24 hours or once the head
 * moves. The four channels: Claude's own prompt (claude-ask, matched to the
 * attempt its PreToolUse hook recorded), your answer to the Claude leader's
 * AskUserQuestion (claude-chat, a chat-answer grant: src/policy/grants.ts),
 * Pi's ctx.ui.confirm (pi-confirm,
 * carried by the approval key only the extension holds), `flowryn approve`
 * in your shell (cli-tty) and the board (board), both behind a code read
 * from /dev/tty. yolo is a project posture, recorded too so every merge
 * names what allowed it.
 */

export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
/** A Claude merge must follow the PreToolUse attempt within this window (design section 7). */
export const ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
/** A /dev/tty challenge must be answered this soon. */
export const CHALLENGE_TTL_MS = 2 * 60 * 1000;

export type Channel = "claude-ask" | "claude-chat" | "pi-confirm" | "cli-tty" | "board" | "yolo";
export type ApprovalAction = "merge" | "discard" | "gate" | "decide";
export const HUMAN_CHANNELS: readonly Channel[] = ["claude-ask", "claude-chat", "pi-confirm", "cli-tty", "board"];

export interface ApprovalRow {
  id: string;
  task_id: string;
  pr_url: string;
  head_sha: string;
  channel: Channel;
  actor: string;
  action: ApprovalAction;
  allow_red_check: string | null;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

export interface AttemptRow {
  id: string;
  session_id: string;
  tool_use_id: string;
  args_hash: string;
  permission_mode: string;
  task_id: string | null;
  action: string;
  pr_url: string | null;
  head_sha: string | null;
  /** The one red check the prompt asked you to waive, if any. */
  allow_red_check: string | null;
  created_at: number;
  matched_at: number | null;
}

/**
 * The hash the Claude hook and the verb both compute for "this action on this
 * task" (and, for a merge that waives a red check, that exact check), so a
 * prompt for a plain merge never matches a waiver, nor the reverse.
 */
export function argsHash(action: ApprovalAction, task: string, allowRed: string | null = null): string {
  return sha256Hex(`flowryn-attempt:${action}\n${task}${allowRed === null ? "" : `\nallow-red:${allowRed}`}`);
}

function nextId(db: Db, key: string, prefix: string): string {
  const next = Number(getMeta(db, key) ?? "1");
  setMeta(db, key, String(next + 1));
  return `${prefix}${next}`;
}

export interface NewApproval {
  task: string;
  ref: string;
  head: string;
  channel: Channel;
  actor: string;
  action: ApprovalAction;
  allowRed?: string | null;
  now: number;
}

/** Record an approval. Call inside a transaction. */
export function insertApproval(db: Db, a: NewApproval): ApprovalRow {
  const id = nextId(db, "next_approval_no", "a");
  db.query(
    `INSERT INTO approvals (id, task_id, pr_url, head_sha, channel, actor, action, allow_red_check, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  ).run(id, a.task, a.ref, a.head, a.channel, a.actor, a.action, a.allowRed ?? null, a.now, a.now + APPROVAL_TTL_MS);
  appendEvent(db, {
    source: a.channel === "cli-tty" || a.channel === "board" ? "cli" : a.channel === "yolo" ? "daemon" : "hook",
    kind: "approval.recorded",
    taskId: a.task,
    payload: { approval: id, channel: a.channel, actor: a.actor, action: a.action, ref: a.ref, head: a.head, allow_red: a.allowRed ?? null },
    ts: a.now,
  });
  return db.query("SELECT * FROM approvals WHERE id = ?1").get(id) as ApprovalRow;
}

/**
 * A standing human record (cli-tty or board) for exactly this head, unexpired
 * and unused. Given `allowRed`, only a record waiving exactly that check.
 */
export function findHumanApproval(db: Db, q: { task: string; action: ApprovalAction; ref: string; head: string; now: number; allowRed?: string | null }): ApprovalRow | null {
  const waiver = q.allowRed ?? null;
  return db
    .query(
      `SELECT * FROM approvals WHERE task_id = ?1 AND action = ?2 AND pr_url = ?3 AND head_sha = ?4
         AND consumed_at IS NULL AND expires_at > ?5 AND channel IN ('cli-tty','board')
         AND (?6 IS NULL OR allow_red_check = ?6)
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(q.task, q.action, q.ref, q.head, q.now, waiver) as ApprovalRow | null;
}

/**
 * The human approval a live landing-queue entry merges under
 * (src/verify/landing-queue.ts): the record the merge verb stood up when it
 * queued the PR (any human channel), or your `flowryn approve`, for exactly
 * this head, unexpired and unused. Only the daemon's own merge looks here.
 */
export function findLandingApproval(db: Db, q: { task: string; ref: string; head: string; now: number }): ApprovalRow | null {
  return db
    .query(
      `SELECT a.* FROM approvals a JOIN landing_queue l ON l.approval_id = a.id
       WHERE l.task_id = ?1 AND l.state IN ('waiting','landing') AND a.action = 'merge' AND a.pr_url = ?2 AND a.head_sha = ?3
         AND a.consumed_at IS NULL AND a.expires_at > ?4
       LIMIT 1`,
    )
    .get(q.task, q.ref, q.head, q.now) as ApprovalRow | null;
}

/** Standing records for other heads: the reason a merge after a push asks again. */
export function staleApprovals(db: Db, q: { task: string; action: ApprovalAction; head: string; now: number }): ApprovalRow[] {
  return db
    .query("SELECT * FROM approvals WHERE task_id = ?1 AND action = ?2 AND head_sha != ?3 AND consumed_at IS NULL AND expires_at > ?4 AND channel IN ('cli-tty','board')")
    .all(q.task, q.action, q.head, q.now) as ApprovalRow[];
}

/** What a discard approval binds to: the worktree's branch (and, in the row, its HEAD when you approved). */
export function discardRef(run: { branch: string }): string {
  return `discard:${run.branch}`;
}

export function consumeApproval(db: Db, id: string, now: number, why: string): void {
  db.query("UPDATE approvals SET consumed_at = ?2 WHERE id = ?1 AND consumed_at IS NULL").run(id, now);
  appendEvent(db, { source: "daemon", kind: "approval.consumed", payload: { approval: id, why }, ts: now });
}

/** Void every standing approval of a task (the delivery was declined, or a new head was delivered). */
export function voidApprovals(db: Db, task: string, now: number, why: string): number {
  const rows = db.query("SELECT id FROM approvals WHERE task_id = ?1 AND consumed_at IS NULL AND expires_at > ?2").all(task, now) as { id: string }[];
  for (const row of rows) consumeApproval(db, row.id, now, why);
  return rows.length;
}

/**
 * A routine merge: the task's policy is yolo and not sensitive, so the merge
 * gate takes the yolo posture and no human word is needed. The Claude leader
 * neither prompts for it nor records an attempt, so it can never be counted
 * as claude-ask. Anything else (no policy, not yolo, or sensitive) still asks.
 */
export function isRoutineMerge(db: Db, task: string): boolean {
  const policy = db.query("SELECT yolo, sensitive FROM task_policy WHERE task_id = ?1").get(task) as { yolo: number; sensitive: number } | null;
  return policy?.yolo === 1 && policy.sensitive === 0;
}

export interface NewAttempt {
  session: string;
  toolUseId: string;
  action: ApprovalAction;
  task: string;
  permissionMode: string;
  prUrl: string | null;
  head: string | null;
  /** A merge that waives one red check: the check, as the prompt showed it. */
  allowRed?: string | null;
  now: number;
}

/**
 * The Claude leader's PreToolUse hook saw `flowryn merge <task>` (or a
 * discard) and put a prompt in front of you. A newer attempt for the same
 * action supersedes older unmatched ones. Call inside a transaction.
 */
export function recordAttempt(db: Db, a: NewAttempt): string {
  const allowRed = a.allowRed ?? null;
  const hash = argsHash(a.action, a.task, allowRed);
  db.query("UPDATE approval_attempts SET matched_at = -1 WHERE session_id = ?1 AND args_hash = ?2 AND matched_at IS NULL").run(a.session, hash);
  const id = ulid(a.now);
  db.query(
    `INSERT INTO approval_attempts (id, session_id, tool_use_id, args_hash, permission_mode, created_at, task_id, action, pr_url, head_sha, allow_red_check)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  ).run(id, a.session, a.toolUseId, hash, a.permissionMode, a.now, a.task, a.action, a.prUrl, a.head, allowRed);
  appendEvent(db, {
    source: "hook",
    kind: "approval.attempt",
    taskId: a.task,
    payload: { attempt: id, session: a.session, action: a.action, mode: a.permissionMode, head: a.head, allow_red: allowRed },
    ts: a.now,
  });
  return id;
}

/**
 * The attempt a Claude merge matches: same session and arguments (a waiver
 * only by the very check its prompt named), under five minutes old,
 * unmatched. Under bypassPermissions there is no prompt to trust, so such an
 * attempt never matches (design section 7, defense in depth).
 */
export function findAttempt(db: Db, q: { session: string; action: ApprovalAction; task: string; now: number; allowRed?: string | null }): AttemptRow | null {
  return db
    .query(
      `SELECT * FROM approval_attempts WHERE session_id = ?1 AND args_hash = ?2 AND matched_at IS NULL
         AND created_at > ?3 AND permission_mode != 'bypassPermissions' ORDER BY created_at DESC LIMIT 1`,
    )
    .get(q.session, argsHash(q.action, q.task, q.allowRed ?? null), q.now - ATTEMPT_WINDOW_MS) as AttemptRow | null;
}

export function matchAttempt(db: Db, id: string, now: number): void {
  db.query("UPDATE approval_attempts SET matched_at = ?2 WHERE id = ?1 AND matched_at IS NULL").run(id, now);
}

/**
 * Void every one of this session's unmatched attempts, across every action. An unmatched (declined,
 * or simply never run) attempt would otherwise stay valid for the rest of its five-minute window, so
 * any later Bash call the gate cannot see as the same command — a spelling the regex misses, a
 * `tooMany` line that records none of its own, a wrong or empty id — could still walk up to
 * `findAttempt` and claim it. Called at the top of every Claude Bash PreToolUse (design section 7,
 * fail-closed root-cause fix): an attempt now survives only from the PreToolUse call that recorded it
 * to the very next Bash call, gated or not. A legitimate attempt voided by a parallel Bash call
 * between the prompt and the command only produces a refusal, never an unapproved action.
 */
export function voidPendingAttempts(db: Db, session: string, now: number): number {
  const changes = db.query("UPDATE approval_attempts SET matched_at = -1 WHERE session_id = ?1 AND matched_at IS NULL").run(session).changes;
  if (changes > 0) appendEvent(db, { source: "hook", kind: "approval.attempts_voided", payload: { session, count: changes }, ts: now });
  return changes;
}

// --- the /dev/tty challenge ---------------------------------------------------------------------

const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

export interface Challenge {
  id: string;
  code: string;
  /** The task, or for a repin the leader session. */
  task: string;
  action: ApprovalAction | "repin";
  ref: string;
  head: string;
  allowRed: string | null;
  channel: "cli-tty" | "board";
  /** A repin (`flowryn leader repin`): exactly the pin you were shown. */
  repin?: { oldCwd: string | null; newCwd: string; transcript: string };
  expiresAt: number;
}

export type OpenChallenge = Pick<Challenge, "task" | "action">;

/**
 * Pending /dev/tty challenges, in the daemon's memory only: a challenge binds
 * what `approve` showed you (the PR and head) to the code you type back, and
 * is used once. A daemon restart forgets them; you run approve again.
 */
export class ChallengeStore {
  private readonly pending = new Map<string, Challenge>();

  create(c: Omit<Challenge, "id" | "code" | "expiresAt">, now: number): Challenge {
    for (const [id, old] of this.pending) if (old.expiresAt <= now) this.pending.delete(id);
    let code = "";
    for (let i = 0; i < 4; i++) code += CODE_LETTERS[randomInt(CODE_LETTERS.length)];
    const challenge: Challenge = { ...c, id: randomBytes(6).toString("hex"), code, expiresAt: now + CHALLENGE_TTL_MS };
    this.pending.set(challenge.id, challenge);
    return challenge;
  }

  /** Challenges still waiting for their code; a restart would forget them. */
  openChallenges(now: number): OpenChallenge[] {
    return [...this.pending.values()].filter((c) => c.expiresAt > now).map((c) => ({ task: c.task, action: c.action }));
  }

  /** The challenge, if the code matches and it is still fresh; it is used up either way. */
  take(id: string, code: string, now: number): Challenge | "expired" | "wrong" | "unknown" {
    const challenge = this.pending.get(id);
    if (!challenge) return "unknown";
    this.pending.delete(id);
    if (challenge.expiresAt <= now) return "expired";
    return challenge.code === code.trim().toUpperCase() ? challenge : "wrong";
  }
}
