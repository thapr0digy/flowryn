import { FlowrynError } from "../api/errors.ts";
import type { HandlerCtx, HandlerResult } from "../api/verbs.ts";
import { awaySuggestion, expireAway, getAway, takePendingBrief, type AwayPosture } from "../attention/away.ts";
import { composeBriefing, composeReturnBrief, readOnlyBanner } from "../attention/briefing.ts";
import { acceptOffer, carry, confirmTurn, loseCarried, offer, releaseOffer, startedTurnsLastHour, type PresentationPath } from "../attention/presentations.ts";
import { QUESTION_KINDS } from "../attention/items.ts";
import { composeDigest, digestCandidates, isQuestionWake, isWakePrompt, p0Candidate, p0Line, questionBatch, questionsText, questionWakeLine, type RankedItem } from "../attention/router.ts";
import { tx, type Db } from "../db/db.ts";
import { awayConfig } from "../config/leader.ts";
import { localDate } from "../lifecycle/dates.ts";
import { appendEvent } from "../db/events.ts";
import { claim, getLease, getSession, heartbeat, closeSession, isHolder, leaseState, type Claimed, type LeaderSessionRow } from "../lease/lease.ts";
import { transcriptShowsInterrupt, transcriptSize } from "../lifecycle/control.ts";
import { hashToken, mintToken } from "../api/auth.ts";
import { decisionRef } from "../lifecycle/decision-verbs.ts";
import { getDecision } from "../lifecycle/decisions.ts";
import { approvalRef, deliveredOf, prEvidence } from "../lifecycle/delivery.ts";
import { findRun, taskTitle } from "../lifecycle/runs.ts";
import { openGate } from "../lifecycle/stages.ts";
import { pendingPlanLine } from "../lifecycle/plans.ts";
import { gateQuestionsLine } from "../lifecycle/gate-questions.ts";
import { isRoutineMerge, recordAttempt, voidPendingAttempts, type ApprovalAction } from "../policy/approvals.ts";
import { recordToolkitDenied, type ToolkitDenial } from "../policy/toolkit-event.ts";
import { sanitizeLine } from "../util/sanitize.ts";
import { readShellWords } from "../util/shell-word.ts";

/**
 * The leader side of the hook verbs (design sections 5, 9 and 10). The
 * Claude leader's hooks and the Pi leader extension call the same `flowryn
 * hook` verbs as a worker's, with the leader session's token; these handlers
 * turn them into busy, idle and activity state, presentations and P0 pushes.
 * The bridges decide nothing: every choice below is reproducible with the CLI.
 */

export interface LeaderHookInput {
  /** The harness's own session id. */
  session_id?: string | null;
  transcript_path?: string | null;
  cwd?: string | null;
  /** Claude SessionStart source, Pi session_start reason, or "compact"; for prompt, Pi's "user" or "run". */
  source?: string | null;
  prompt?: string | null;
  notification_type?: string | null;
  /** Pi: the extension's own activity check (idle, empty composer, no input for inactive_ms). */
  inactive?: boolean;
  /** Pi: false without the TUI, where a P0 never starts a turn. */
  has_ui?: boolean;
  /** Pi: overflow recovery retries as a fresh run after this compaction (M0 p06). */
  will_retry?: boolean;
  /** Claude SessionEnd reason, Pi session_shutdown reason. */
  reason?: string | null;
  stop_hook_active?: boolean;
  /** Pi `delivered`: the pushed item, the path the extension used, and whether it delivered. */
  item?: string;
  mode?: string;
  ok?: boolean;
  /** Claude PreToolUse: the tool, its input, its call id and the session's permission mode (M0 c09). */
  tool_name?: string;
  tool_input?: { command?: unknown } | null;
  tool_use_id?: string;
  permission_mode?: string;
  /** Pi merge-summary and gate-summary: the task the tool was asked about. */
  task?: string;
  /** Claude StopFailure: the error type (rate_limit for a claude.ai usage limit) and its details. */
  error?: string | null;
  error_details?: string | null;
}

/** At most two consecutive Stop continuations, far below Claude's cap of 8 (design section 5). */
export const MAX_LEADER_CONTINUATIONS = 2;

/** Session-end reasons after which the same process carries on (a /clear, a Pi session switch). */
const CONTINUES = new Set(["clear", "reload", "new", "resume", "fork"]);

/** A pushed P0: the Claude waiter wakes an idle session; the Pi extension follows up (busy) or triggers a turn (idle). */
export type PushMode = "waiter" | "continuation" | "trigger";

export function leaderSession(ctx: HandlerCtx): LeaderSessionRow {
  const id = ctx.caller.session;
  const session = id ? getSession(ctx.db, id) : null;
  if (!session || session.ended_at !== null) throw new FlowrynError("not_found", "this leader session has ended", "start a new one with flowryn lead");
  return session;
}

function busyNow(s: LeaderSessionRow, now: number): boolean {
  return s.busy === 1 && s.busy_until !== null && s.busy_until > now;
}

function ageMs(ctx: HandlerCtx): number {
  return ctx.attention.timing().age_ms;
}

function setSession(db: Db, id: string, fields: Record<string, number | string | null>): void {
  const keys = Object.keys(fields);
  db.query(`UPDATE leader_sessions SET ${keys.map((k, i) => `${k} = ?${i + 2}`).join(", ")} WHERE session_id = ?1`).run(id, ...keys.map((k) => fields[k]!));
}

/** A new turn: carries still waiting on an earlier turn end will never get one. Inside a transaction. */
function startTurn(ctx: HandlerCtx, s: LeaderSessionRow, now: number, source: string): number {
  const turn = s.turn_no + 1;
  setSession(ctx.db, s.session_id, { turn_no: turn, busy: 1, busy_until: now + ctx.attention.timing().busy_lease_ms, continuations: 0, last_event_at: now });
  const lost = loseCarried(ctx.db, s.session_id, turn, now);
  appendEvent(ctx.db, { source: "hook", kind: "leader.turn_started", payload: { session: s.session_id, turn, source, lost }, ts: now });
  s.turn_no = turn;
  s.busy = 1;
  return turn;
}

function refreshBusy(ctx: HandlerCtx, s: LeaderSessionRow, now: number): void {
  setSession(ctx.db, s.session_id, { busy: 1, busy_until: now + ctx.attention.timing().busy_lease_ms, last_event_at: now });
}

function markIdle(ctx: HandlerCtx, s: LeaderSessionRow, now: number, signal: string): void {
  setSession(ctx.db, s.session_id, { busy: 0, busy_until: null, continuations: 0, last_event_at: now });
  appendEvent(ctx.db, { source: "hook", kind: "leader.turn_ended", payload: { session: s.session_id, turn: s.turn_no, signal }, ts: now });
}

/**
 * Busy is a lease: an interrupt fires no hook and no idle_prompt (M0 c04), so
 * a lease nothing refreshed expires, and what the interrupted turn carried is
 * carried again. Inside a transaction.
 */
export function expireBusy(db: Db, s: LeaderSessionRow, now: number, reason: string): boolean {
  if (s.busy !== 1 || (s.busy_until !== null && s.busy_until > now)) return false;
  db.query("UPDATE leader_sessions SET busy = 0, busy_until = NULL, continuations = 0 WHERE session_id = ?1").run(s.session_id);
  const lost = loseCarried(db, s.session_id, s.turn_no + 1, now);
  appendEvent(db, { source: "daemon", kind: "leader.busy_expired", payload: { session: s.session_id, turn: s.turn_no, reason, lost }, ts: now });
  s.busy = 0;
  s.busy_until = null;
  return true;
}

/**
 * M0 finding 6: Claude writes the interrupt marker to its transcript at once,
 * so a turn interrupted by you ends in seconds instead of when the lease
 * expires. Only the part written since this turn started counts.
 */
function interruptedByTranscript(ctx: HandlerCtx, s: LeaderSessionRow): boolean {
  if (s.harness !== "claude" || s.busy !== 1 || !s.transcript_path) return false;
  const offset = ctx.attention.turnOffsets.get(s.session_id);
  return offset !== undefined && transcriptShowsInterrupt(s.transcript_path, offset);
}

/**
 * How a push would reach this session now, or null when nothing may be
 * pushed to it. Away counts as inactive: your remote-control chat never
 * fires idle_prompt on the Mac.
 */
function pushMode(s: LeaderSessionRow, now: number, away: AwayPosture | null): PushMode | null {
  if (busyNow(s, now)) return s.harness === "pi" ? "continuation" : null;
  if (s.user_inactive_since === null && away === null) return null;
  if (s.harness === "pi" && s.has_ui !== 1) return null;
  return s.harness === "pi" ? "trigger" : "waiter";
}

export interface Push {
  /** What the push carries: one P0, or a batch of worker questions. */
  items: RankedItem[];
  mode: PushMode;
  questions: boolean;
  /** Questions left for the next push. */
  more: number;
}

/**
 * Should something be pushed to this session now, and how (design section 9)?
 * Busy: Claude's Stop continuation takes it (not a waiter), Pi's extension
 * follows up. Idle and you inactive: a Claude waiter wakes the session, a Pi
 * extension triggers a turn if it has the TUI. Idle and you active: nothing
 * is pushed; it tops your next digest. A P0 goes first, one at a time. Worker
 * questions go as a batch, and start a turn only once the oldest has waited
 * question_batch_ms (`dueAt` says when, so the waiter wakes then). Started
 * turns are capped per hour, P0s and question batches each on their own budget.
 * While you are away, items only you can move count as P0s (p0Candidate) and
 * the P0 budget is [away] max_wakes_per_hour.
 */
export function leaderPush(ctx: HandlerCtx, s: LeaderSessionRow, now: number): { push: Push | null; dueAt: number | null } {
  if (!isHolder(ctx.db, s.session_id)) return { push: null, dueAt: null };
  const away = getAway(ctx.db, now);
  const mode = pushMode(s, now, away);
  const startsTurn = mode === "waiter" || mode === "trigger";
  const budgets = ctx.attention.notify();
  const p0Budget = away ? awayConfig(ctx.config()).max_wakes_per_hour : budgets.max_triggered_turns_per_hour;
  if (mode) {
    const item = p0Candidate(ctx.db, s.session_id, now, ageMs(ctx), away?.since ?? null);
    if (item && !(startsTurn && startedTurnsLastHour(ctx.db, s.session_id, now, "p0") >= p0Budget)) {
      return { push: { items: [item], mode, questions: false, more: 0 }, dueAt: null };
    }
  }
  const batch = questionBatch(ctx.db, s.session_id, ctx.attention.timing().question_batch_ms);
  if (!batch) return { push: null, dueAt: null };
  if (!mode) return { push: null, dueAt: batch.dueAt };
  if (startsTurn && now < batch.dueAt) return { push: null, dueAt: batch.dueAt };
  if (startsTurn && startedTurnsLastHour(ctx.db, s.session_id, now, "questions") >= budgets.max_question_wakes_per_hour) return { push: null, dueAt: null };
  return { push: { items: batch.items, mode, questions: true, more: batch.more }, dueAt: null };
}

function pushTurn(s: LeaderSessionRow, mode: PushMode): number {
  return mode === "continuation" ? s.turn_no : s.turn_no + 1;
}

/** The text a push hands over: the P0 line, or for questions the wake line (Claude's waiter) or every question's line. */
function pushText(push: Push, items: RankedItem[], harness: string): string {
  if (!push.questions) return p0Line(items[0]!);
  return push.mode === "waiter" && harness === "claude" ? questionWakeLine(items) : questionsText(items, push.more);
}

/** The questions a question wake carried into `turn`, for that turn's prompt hook. */
function wokenQuestions(db: Db, session: string, turn: number): RankedItem[] {
  return db
    .query(
      `SELECT i.* FROM presentations s JOIN items i ON i.id = s.item_id
       WHERE s.session_id = ?1 AND s.turn_no = ?2 AND s.path = 'waiter' AND s.state = 'carried' AND i.kind IN (${QUESTION_KINDS.map((k) => `'${k}'`).join(", ")})
       ORDER BY i.opened_at, i.rowid`,
    )
    .all(session, turn) as RankedItem[];
}

/** Compose the holder's briefing and carry every item it lists for `turn`. Inside a transaction. */
function brief(ctx: HandlerCtx, s: LeaderSessionRow, turn: number, now: number): { text: string; listed: number } {
  const briefing = composeBriefing(ctx.db, { session: s.session_id, now, morningHour: ctx.config().morning_hour, ageMs: ageMs(ctx), markMorning: true, config: ctx.config() });
  for (const item of briefing.listed) carry(ctx.db, { itemId: item.id, session: s.session_id, turn, path: "briefing", now });
  setSession(ctx.db, s.session_id, { brief_pending: 0 });
  return { text: briefing.text, listed: briefing.listed.length };
}

// --- session start ------------------------------------------------------------------------

export async function prepareSessionStart(ctx: HandlerCtx): Promise<{ state: string; epoch: number }> {
  const s = leaderSession(ctx);
  return leaseState(ctx.db, s.session_id, ctx.now(), ctx.attention.timing().stale_ms, ctx.attention.ps);
}

/**
 * A leader session started, resumed, cleared or compacted. It claims the
 * lease when it is vacant or stale; the holder gets the briefing (which
 * re-lists every open actionable item, so it also re-grounds a compacted
 * session), anyone else one read-only banner line.
 */
export function sessionStart(ctx: HandlerCtx, input: LeaderHookInput, prepared: { state: string; epoch: number }): HandlerResult {
  const s = leaderSession(ctx);
  const now = ctx.now();
  const source = input.source ?? "startup";
  const compact = source === "compact";
  setSession(ctx.db, s.session_id, {
    harness_session: input.session_id ?? s.harness_session,
    transcript_path: input.transcript_path ?? s.transcript_path,
    cwd: input.cwd ?? s.cwd,
    has_ui: input.has_ui === undefined ? s.has_ui : input.has_ui ? 1 : 0,
    last_event_at: now,
  });
  if (!compact) {
    // A new, resumed or cleared conversation starts idle; nothing it carried before can be confirmed now.
    setSession(ctx.db, s.session_id, { busy: 0, busy_until: null, continuations: 0 });
    loseCarried(ctx.db, s.session_id, null, now);
    s.busy = 0;
  }
  const lease = getLease(ctx.db);
  const holderRow = lease.session_id ? getSession(ctx.db, lease.session_id) : null;
  let claimed: Claimed | null = null;
  if (!lease.session_id || !holderRow || holderRow.ended_at !== null) claimed = claim(ctx.db, s.session_id, "vacant", now);
  else if (lease.session_id !== s.session_id && prepared.state === "stale" && prepared.epoch === lease.epoch) claimed = claim(ctx.db, s.session_id, "stale", now);
  heartbeat(ctx.db, s.session_id, now);
  const holder = isHolder(ctx.db, s.session_id);
  let context: string;
  let listed = 0;
  if (!holder) {
    context = readOnlyBanner(ctx.db);
    setSession(ctx.db, s.session_id, { banner: null });
  } else {
    const turn = compact && busyNow(s, now) ? s.turn_no : s.turn_no + 1;
    const briefing = brief(ctx, s, turn, now);
    listed = briefing.listed;
    context = briefing.text;
  }
  const epoch = getLease(ctx.db).epoch;
  appendEvent(ctx.db, { source: "hook", kind: "leader.session_started", payload: { session: s.session_id, source, holder, epoch, listed, claimed: claimed !== null }, ts: now });
  const data: Record<string, unknown> = { session: s.session_id, holder, epoch, context };
  if (claimed?.previous) data.previous = claimed.previous;
  // The approval key goes only to a Pi extension, over its own hook call; never into an environment (design section 7).
  if (claimed && s.harness === "pi") data.approval_key = claimed.approvalKey;
  return { data };
}

// --- prompt and busy ------------------------------------------------------------------------

/**
 * The digest's hand-over deadline: the hook process start plus the budget.
 * The daemon alone decides: it carries nothing it applies past the deadline,
 * so a hook that ran too slow for Claude to use never counts as carried, and
 * the CLI prints whatever context it is handed (Claude's hook timeout is far
 * longer than the budget). Null when the start is unknown.
 */
export function digestDeadline(ctx: HandlerCtx, startedAt: number | undefined): number | null {
  return startedAt === undefined ? null : startedAt + ctx.attention.timing().digest_budget_ms;
}

/**
 * A turn started. Claude: UserPromptSubmit (also for a woken turn). Pi:
 * before_agent_start for your prompt (source "user"), agent_start for any run
 * (source "run"), which repeats on retries and so is idempotent while busy
 * (M0 p04). A prompt you typed makes you active and gets the P1 digest.
 */
export function prompt(ctx: HandlerCtx, input: LeaderHookInput, deadline: number | null): HandlerResult {
  const s = leaderSession(ctx);
  const now = ctx.now();
  // Fail-closed (design section 7): your next message also kills a declined attempt the Claude
  // leader is still holding, the same as the next Bash call does.
  if (s.harness === "claude") voidPendingAttempts(ctx.db, s.session_id, now);
  const late = deadline !== null && now > deadline;
  if (s.harness === "pi" && input.source === "run") {
    if (busyNow(s, now)) refreshBusy(ctx, s, now);
    else startTurn(ctx, s, now, "run");
    heartbeat(ctx.db, s.session_id, now);
    return { data: {} };
  }
  const turn = startTurn(ctx, s, now, input.source ?? "prompt");
  if (!isWakePrompt(input.prompt) && s.user_inactive_since !== null) {
    setSession(ctx.db, s.session_id, { user_inactive_since: null });
    appendEvent(ctx.db, { source: "hook", kind: "leader.user_active", payload: { session: s.session_id }, ts: now });
  }
  if (s.harness === "claude" && s.transcript_path) ctx.attention.turnOffsets.set(s.session_id, transcriptSize(s.transcript_path));
  heartbeat(ctx.db, s.session_id, now);
  if (late) {
    appendEvent(ctx.db, { source: "hook", kind: "leader.digest_late", payload: { session: s.session_id, turn }, ts: now });
    return { data: {} };
  }
  const lines: string[] = [];
  if (s.banner) {
    lines.push(s.banner);
    setSession(ctx.db, s.session_id, { banner: null });
  }
  if (isHolder(ctx.db, s.session_id)) {
    // Taken over mid-conversation: the full briefing first, then whatever it does not list.
    if (s.brief_pending === 1) lines.push(brief(ctx, s, turn, now).text);
    // A question wake's line names the questions; the woken turn gets each one in full.
    if (isQuestionWake(input.prompt)) {
      const woken = wokenQuestions(ctx.db, s.session_id, turn);
      if (woken.length > 0) lines.push(questionsText(woken));
    }
    if (!isWakePrompt(input.prompt)) lines.push(...awayLines(ctx, s, now));
    const digest = composeDigest(digestCandidates(ctx.db, s.session_id, now, ageMs(ctx)));
    if (digest) {
      for (const item of digest.shown) carry(ctx.db, { itemId: item.id, session: s.session_id, turn, path: "digest", now });
      lines.push(digest.text);
    }
  }
  if (lines.length === 0) return { data: {} };
  return { data: deadline === null ? { context: lines.join("\n") } : { context: lines.join("\n"), deadline } };
}

/**
 * What your own message carries about away mode: an expired away's return
 * brief, once, or the idle suggestion. Your messages never end away (you
 * answer from the remote-control chat while away): only `flowryn back` and
 * the expiry do. Inside a transaction.
 */
function awayLines(ctx: HandlerCtx, s: LeaderSessionRow, now: number): string[] {
  expireAway(ctx.db, now);
  const ended = takePendingBrief(ctx.db, now);
  if (ended) return [composeReturnBrief(ctx.db, { since: ended.since, until: ended.ended_at, now, ageMs: ageMs(ctx), reason: ended.reason })];
  const suggestion = awaySuggestion(ctx.db, {
    inactiveSince: s.user_inactive_since,
    now,
    suggestAfterMs: awayConfig(ctx.config()).suggest_after_min * 60_000,
    today: localDate(new Date(now)),
  });
  return suggestion ? [suggestion] : [];
}

/** Pre/PostToolUse: refresh the busy lease, and the heartbeat. A tool never starts a turn. */
export function toolActivity(ctx: HandlerCtx): HandlerResult {
  const s = leaderSession(ctx);
  const now = ctx.now();
  refreshBusy(ctx, s, now);
  heartbeat(ctx.db, s.session_id, now);
  return { data: {} };
}

export interface GatedCommand {
  action: ApprovalAction;
  task: string;
  /** decide only: more than one captain answer appears in this one command; refuse all of them by construction (no attempt is ever recorded for it). */
  tooMany?: boolean;
  /** merge only: the one red check this merge asks to waive, exactly as the shell will pass it. */
  allowRed?: string;
  /** merge only: a waiver is asked but its check cannot be read exactly; refused by construction (no attempt is recorded). */
  unreadable?: string;
}

export type WaiverArg = { kind: "none" } | { kind: "check"; check: string } | { kind: "unreadable"; why: string };

const ALLOW_RED = "--allow-red";
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * The `--allow-red <check>` of the merge whose arguments start at `from`, read
 * the way the shell will pass it (src/util/shell-word.ts). The prompt shows
 * this name and the attempt binds it, so anything that could reach the verb
 * as a different string is unreadable instead: an expansion or glob, a value
 * that looks like a flag (the CLI strips a bare --json or --help first), a
 * repeat, an empty name or a control character. A misread can only refuse:
 * the verb matches the attempt by the name it actually received.
 */
export function mergeWaiver(command: string, from: number): WaiverArg {
  const words = readShellWords(command, from);
  const found: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word.exact && word.text === "--") break;
    if (word.text === ALLOW_RED) {
      const value = words[i + 1];
      if (!word.exact || !value) return { kind: "unreadable", why: "--allow-red has no value" };
      if (!value.exact) return { kind: "unreadable", why: "the check name has shell expansion or unsafe characters" };
      if (value.text.startsWith("-")) return { kind: "unreadable", why: "a check name starting with - must be given as --allow-red=<check>" };
      found.push(value.text);
      i++;
    } else if (word.text.startsWith(`${ALLOW_RED}=`)) {
      if (!word.exact) return { kind: "unreadable", why: "the check name has shell expansion or unsafe characters" };
      found.push(word.text.slice(ALLOW_RED.length + 1));
    } else if (word.text.includes("allow-red") && !word.exact) {
      return { kind: "unreadable", why: "--allow-red is built from shell expansion" };
    }
  }
  if (found.length === 0) return { kind: "none" };
  if (found.length > 1) return { kind: "unreadable", why: "--allow-red is given more than once" };
  const check = found[0]!;
  if (check.length === 0) return { kind: "unreadable", why: "the check name is empty" };
  if (CONTROL.test(check)) return { kind: "unreadable", why: "the check name has a control character" };
  return { kind: "check", check };
}

const MERGE_COMMAND = /(?:^|[\s;&|()`'"])(?:[^\s;&|()`'"]*\/)?flowryn\s+merge\s+([A-Za-z0-9][\w.-]*)/g;
const DISCARD_COMMAND = /(?:^|[\s;&|()`'"])(?:[^\s;&|()`'"]*\/)?flowryn\s+cleanup\s+([A-Za-z0-9][\w.-]*)[^;&|\n]*?--discard\b/g;
const GATE_COMMAND = /(?:^|[\s;&|()`'"])(?:[^\s;&|()`'"]*\/)?flowryn\s+gate\s+pass\s+([A-Za-z0-9][\w.-]*)/g;
const FLOWRYN_WORD = /\bflowryn\b/;
const CAPTAIN_WORD = /\bcaptain\b/;
const DECIDE_WORD = /\bdecide\b/g;
const DECISION_ID = /\b([kq]\d+)\b/;

/** `\` immediately before a newline is a shell line continuation: treat it as a plain space before scanning. */
function joinContinuations(command: string): string {
  return command.replace(/\\\r?\n/g, " ");
}

/**
 * Every decision id a `decide` word in the line is followed by, left to right, when the line also
 * names `flowryn` and `captain` somewhere. This over-matches by design (the controller's ruling): a
 * precise per-spelling regex anchored on `--by captain` misses `--by=captain`, flags reordered before
 * the positionals, quoted forms and a backslash-newline continuation — all of which the CLI parser
 * (src/cli/argv.ts) accepts. One `decide` with no id after it (malformed) still gates, with an empty
 * id, so it refuses rather than runs unprompted.
 */
function captainDecideIds(command: string): string[] {
  const normalized = joinContinuations(command);
  if (!FLOWRYN_WORD.test(normalized) || !CAPTAIN_WORD.test(normalized)) return [];
  const ids: string[] = [];
  let anyDecide = false;
  for (const m of normalized.matchAll(DECIDE_WORD)) {
    anyDecide = true;
    const id = DECISION_ID.exec(normalized.slice(m.index + m[0].length))?.[1];
    if (id) ids.push(id);
  }
  return anyDecide && ids.length === 0 ? [""] : ids;
}

/** The Flowryn commands in a shell line that need your word: merges, discards, review gate passes and captain answers. */
export function gatedCommands(command: string): GatedCommand[] {
  const found: GatedCommand[] = [];
  for (const match of command.matchAll(MERGE_COMMAND)) {
    const waiver = mergeWaiver(command, match.index + match[0].length);
    const extra = waiver.kind === "check" ? { allowRed: waiver.check } : waiver.kind === "unreadable" ? { unreadable: waiver.why } : {};
    found.push({ action: "merge", task: match[1]!, ...extra });
  }
  for (const match of command.matchAll(DISCARD_COMMAND)) found.push({ action: "discard", task: match[1]! });
  for (const match of command.matchAll(GATE_COMMAND)) found.push({ action: "gate", task: match[1]! });
  const decideIds = captainDecideIds(command);
  if (decideIds.length === 1) found.push({ action: "decide", task: decideIds[0]! });
  else if (decideIds.length > 1) found.push({ action: "decide", task: decideIds[0]!, tooMany: true });
  return found;
}

/** What the prompt names, from what flowrynd already knows (a hook must answer fast, so no network). */
function promptFacts(ctx: HandlerCtx, gated: GatedCommand, command: string): { line: string; prUrl: string | null; head: string | null } {
  if (gated.action === "decide") {
    if (gated.tooMany) return { line: `more than one captain answer in one command: "${sanitizeLine(command, 300)}"; only one flowryn decide … --by captain is allowed per command, so none of them will be recorded`, prUrl: null, head: null };
    const d = gated.task ? getDecision(ctx.db, gated.task) : null;
    if (!d || d.state !== "open") return { line: `record an answer to ${gated.task || "?"} from: "${sanitizeLine(command, 300)}": no open decision; it will be refused`, prUrl: null, head: null };
    return { line: `RECORD as the user's own answer to ${d.id} ("${sanitizeLine(d.question, 120)}"): ${sanitizeLine(command, 300)}`, prUrl: decisionRef(d.id), head: null };
  }
  const run = findRun(ctx.db, gated.task);
  if (!run) return { line: `${gated.action} ${gated.task}: no such task; it will be refused`, prUrl: null, head: null };
  const title = taskTitle(ctx.db, run.task_id);
  if (gated.action === "discard") return { line: `DISCARD the unlanded work of ${run.task_id} (${title}) in ${run.worktree_path}`, prUrl: null, head: null };
  if (gated.action === "gate") {
    const gate = openGate(ctx.db, run.id, "review");
    if (!gate) return { line: `pass a review gate of ${run.task_id} (${title}): none is open; it will be refused`, prUrl: null, head: null };
    const plan = pendingPlanLine(ctx.db, gate.id);
    const questions = gateQuestionsLine(ctx.db, gate.id);
    return { line: `PASS the ${gate.stage} review of ${run.task_id} (${title}), review page ${gate.review_url ?? "none"}${plan ? `; it also approves ${plan}` : ""}${questions ? `; its questions: ${questions}` : ""}; the next stage starts at once`, prUrl: `gate:${gate.id}`, head: null };
  }
  if (gated.unreadable !== undefined) {
    return { line: `merge ${run.task_id} (${title}) waiving a red check Flowryn cannot read exactly (${gated.unreadable}): it will be refused; name the check as one quoted word`, prUrl: null, head: null };
  }
  const waive = gated.allowRed !== undefined ? `WAIVE the red check ${JSON.stringify(gated.allowRed)} and ` : "";
  const shipped = deliveredOf(ctx.db, run.task_id);
  if (!shipped) return { line: `${waive}merge ${run.task_id} (${title}): nothing delivered yet; it will be refused`, prUrl: null, head: null };
  const evidence = shipped.kind === "pr" ? prEvidence(ctx.db, run.id) : null;
  const head = evidence?.head ?? shipped.head;
  const where = shipped.kind === "pr" ? `PR ${shipped.ref} at ${head.slice(0, 8)}, checks ${evidence?.checks?.line ?? "unknown"}` : `branch ${run.branch} at ${head.slice(0, 8)} into local main`;
  const agrees = gated.allowRed === undefined ? "" : waiverAgreement(gated.allowRed, shipped.kind === "pr" ? (evidence?.checks?.red ?? null) : []);
  return { line: `${waive}merge ${run.task_id} (${title}): ${where}${agrees}`, prUrl: approvalRef(shipped), head };
}

/**
 * Whether the checks flowrynd last read agree with the waiver the prompt
 * names. Advice only: the merge gate reads the checks fresh and refuses
 * unless the named check is the only one failing then.
 */
function waiverAgreement(check: string, red: string[] | null): string {
  if (red === null) return `; flowrynd has not read the checks yet, so it is refused unless ${JSON.stringify(check)} is the only failing check when it runs`;
  if (red.length === 1 && red[0] === check) return "";
  const failing = red.length > 0 ? red.map((name) => JSON.stringify(name)).join(", ") : "none";
  return `; flowrynd last read failing: ${failing}, so it is refused unless ${JSON.stringify(check)} is the only failing check when it runs`;
}

/** A yolo, non-sensitive merge: no prompt and no attempt, so the merge gate records yolo. */
function routineMerge(ctx: HandlerCtx, ref: string): boolean {
  const run = findRun(ctx.db, ref);
  return run !== null && isRoutineMerge(ctx.db, run.task_id);
}

/**
 * Claude PreToolUse (design section 7): a Bash call that runs `flowryn
 * merge` (or a cleanup --discard) is recorded as an attempt (session, tool
 * use id, arguments, permission mode, and the PR and head the prompt names)
 * and answered with "ask", so Claude puts it in front of you even in auto
 * mode (M0 c08). The merge that follows matches this attempt; without one,
 * it is refused. A routine merge (yolo, not sensitive) is the exception: it
 * is neither asked nor recorded, and the gate takes the yolo posture.
 *
 * Fail-closed root cause fix: every tool call of a Claude leader session,
 * gated or not and whatever the tool, first voids every one of this
 * session's unmatched attempts (`voidPendingAttempts`), before the
 * Bash-only gating and recording below. Without this, a declined attempt
 * stays claimable for its whole five-minute window by any later call the
 * gate itself cannot see as the same command — a spelling the regex misses,
 * a `tooMany` line, a wrong or empty id, or a non-Bash tool that can still
 * run a shell command (Monitor, PowerShell) and so is not covered by the
 * `Bash(...)` ask rules at all. An attempt now survives only from the call
 * that recorded it to the very next tool call; `stop` and `prompt` void the
 * same way, so a decline that ends the turn or your next message also
 * kills it.
 */
export function preToolUse(ctx: HandlerCtx, input: LeaderHookInput, denied: ToolkitDenial | null = null): HandlerResult {
  const result = toolActivity(ctx);
  const s = leaderSession(ctx);
  if (s.harness !== "claude") return result;
  const now = ctx.now();
  voidPendingAttempts(ctx.db, s.session_id, now);
  // The hook process denied this call by the toolkit rules: it never runs, so nothing is gated or recorded as an attempt.
  if (denied) {
    recordToolkitDenied(ctx.db, denied, { session: s.session_id, harness: "claude", toolName: String(input.tool_name ?? "") }, now);
    return result;
  }
  if (input.tool_name !== "Bash") return result;
  const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
  const gated = gatedCommands(command);
  if (gated.length === 0) return result;
  const lines: string[] = [];
  for (const g of gated) {
    // A waiver is never routine: only your word can make one, so it is always asked.
    const waiverAsked = g.allowRed !== undefined || g.unreadable !== undefined;
    if (g.action === "merge" && !waiverAsked && routineMerge(ctx, g.task)) continue;
    const facts = promptFacts(ctx, g, command);
    // Refusal by construction: a line naming more than one captain decide, or a waiver whose check
    // cannot be read exactly, is gated and prompted, but no attempt is ever recorded for it, so the
    // calls it runs can never find one to match.
    if (!(g.action === "decide" && g.tooMany) && g.unreadable === undefined) {
      recordAttempt(ctx.db, {
        session: s.session_id,
        toolUseId: String(input.tool_use_id ?? ""),
        action: g.action,
        task: g.task,
        permissionMode: String(input.permission_mode ?? "unknown"),
        prUrl: facts.prUrl,
        head: facts.head,
        allowRed: g.allowRed ?? null,
        now,
      });
    }
    lines.push(facts.line);
  }
  if (lines.length === 0) return result;
  return { data: { permission: "ask", reason: `Flowryn needs your word: ${lines.join("; ")}. Approve only if you want this.` } };
}

/** Pi: the leader extension's tool call that `hook tool-check` denied by the toolkit rules. */
export function toolDenied(ctx: HandlerCtx, input: LeaderHookInput, denied: ToolkitDenial | null, harness: "claude" | "pi"): HandlerResult {
  const s = leaderSession(ctx);
  if (denied) recordToolkitDenied(ctx.db, denied, { session: s.session_id, harness, toolName: String(input.tool_name ?? "") }, ctx.now());
  return { data: { recorded: denied !== null } };
}

/**
 * Pi: a fresh approval key for the lease holder's extension, over its own
 * hook call and never into an environment (design section 7). A session that
 * took the lease after it started (leader claim) gets its key this way; a
 * new key replaces the old one.
 */
export function approvalKey(ctx: HandlerCtx): HandlerResult {
  const s = leaderSession(ctx);
  if (s.harness !== "pi") throw new FlowrynError("role_refused", "only a Pi leader's extension holds an approval key");
  if (!isHolder(ctx.db, s.session_id)) throw new FlowrynError("not_leader", "this session does not hold the lease", "flowryn leader claim");
  const key = mintToken("key");
  ctx.db.query("UPDATE leader_lease SET approval_key_hash = ?2 WHERE id = 1 AND session_id = ?1").run(s.session_id, hashToken(key));
  appendEvent(ctx.db, { source: "hook", kind: "leader.approval_key", payload: { session: s.session_id }, ts: ctx.now() });
  return { data: { key } };
}

// --- turn end -------------------------------------------------------------------------------

/**
 * The turn ended (Claude Stop, Pi agent_settled): what it carried is
 * presented. A busy-time P0 continues a Claude turn, at most twice in a row;
 * Stop asks once, and a P0 that arrives after goes to the waiter.
 */
export function stop(ctx: HandlerCtx): HandlerResult {
  const s = leaderSession(ctx);
  const now = ctx.now();
  // Fail-closed (design section 7): a declined prompt that ends the turn here, rather than at the
  // next Bash call, must not leave its attempt live for the rest of its five-minute window.
  if (s.harness === "claude") voidPendingAttempts(ctx.db, s.session_id, now);
  const presented = confirmTurn(ctx.db, s.session_id, s.turn_no, now);
  heartbeat(ctx.db, s.session_id, now);
  if (s.harness === "claude" && s.continuations < MAX_LEADER_CONTINUATIONS && isHolder(ctx.db, s.session_id)) {
    const item = p0Candidate(ctx.db, s.session_id, now, ageMs(ctx), getAway(ctx.db, now)?.since ?? null);
    if (item && carry(ctx.db, { itemId: item.id, session: s.session_id, turn: s.turn_no, path: "continuation", now })) {
      setSession(ctx.db, s.session_id, { continuations: s.continuations + 1, busy: 1, busy_until: now + ctx.attention.timing().busy_lease_ms });
      appendEvent(ctx.db, { source: "hook", kind: "leader.p0_pushed", payload: { session: s.session_id, item: item.id, path: "continuation", turn: s.turn_no }, ts: now });
      return { data: { context: p0Line(item), item: item.id, presented } };
    }
    // Worker questions ride the turn that is ending at once: the batch window only holds back a wake.
    const batch = questionBatch(ctx.db, s.session_id, ctx.attention.timing().question_batch_ms);
    const carried = (batch?.items ?? []).filter((q) => carry(ctx.db, { itemId: q.id, session: s.session_id, turn: s.turn_no, path: "continuation", now }));
    if (carried.length > 0) {
      setSession(ctx.db, s.session_id, { continuations: s.continuations + 1, busy: 1, busy_until: now + ctx.attention.timing().busy_lease_ms });
      appendEvent(ctx.db, { source: "hook", kind: "leader.questions_pushed", payload: { session: s.session_id, items: carried.map((q) => q.id), path: "continuation", turn: s.turn_no }, ts: now });
      return { data: { context: questionsText(carried, batch!.more), item: carried[0]!.id, presented } };
    }
  }
  markIdle(ctx, s, now, "stop");
  return { data: { presented } };
}

/** The turn ended in an API error: no turn end, so nothing it carried counts as presented (design section 9). */
export function stopFailure(ctx: HandlerCtx): HandlerResult {
  const s = leaderSession(ctx);
  const now = ctx.now();
  markIdle(ctx, s, now, "stop-failure");
  heartbeat(ctx.db, s.session_id, now);
  return { data: {} };
}

/** The harness session ended. A /clear or a Pi session switch carries on in the same process; anything else closes the session and releases the lease. */
export function sessionEnd(ctx: HandlerCtx, input: LeaderHookInput): HandlerResult {
  const s = leaderSession(ctx);
  const now = ctx.now();
  const reason = input.reason ?? "other";
  if (CONTINUES.has(reason)) {
    markIdle(ctx, s, now, `session-end:${reason}`);
    return { data: { closed: false } };
  }
  const { released } = closeSession(ctx.db, s.session_id, `session-end:${reason}`, now);
  return { data: { closed: true, released } };
}

/**
 * You went inactive or came back. Claude: Notification idle_prompt, about 60 s
 * after a normal turn end with no typing (M0 c03); nothing clears it but your
 * next prompt. Pi: the extension's own check of the composer and keystrokes
 * (M0 p09), reported both ways.
 */
export function notify(ctx: HandlerCtx, input: LeaderHookInput): HandlerResult {
  const s = leaderSession(ctx);
  const now = ctx.now();
  const inactive = s.harness === "claude" ? input.notification_type === "idle_prompt" : input.inactive;
  if (inactive === true && s.user_inactive_since === null) {
    setSession(ctx.db, s.session_id, { user_inactive_since: now });
    appendEvent(ctx.db, { source: "hook", kind: "leader.user_inactive", payload: { session: s.session_id, via: s.harness === "claude" ? "idle_prompt" : "extension" }, ts: now });
  } else if (inactive === false && s.harness === "pi" && s.user_inactive_since !== null) {
    setSession(ctx.db, s.session_id, { user_inactive_since: null });
    appendEvent(ctx.db, { source: "hook", kind: "leader.user_active", payload: { session: s.session_id }, ts: now });
  }
  heartbeat(ctx.db, s.session_id, now);
  return { data: {} };
}

// --- the P0 waiter --------------------------------------------------------------------------

export interface WaitOutcome {
  exit?: boolean;
  wait?: boolean;
  push?: { item: string; mode: PushMode };
}

/**
 * `hook wait-p0`: the Claude asyncRewake waiter (armed at SessionStart and
 * every Stop, 8 h timeout) and the Pi extension's long poll. It holds for at
 * most wait_poll_ms; a newer waiter for the session supersedes it. A session
 * that does not hold the lease gets no pushes: its waiter keeps waiting while
 * the lease is vacant (its own session-start may be about to claim it, racing
 * this waiter), and exits once another open session holds it.
 */
export async function waitForP0(ctx: HandlerCtx, waiter: string): Promise<WaitOutcome> {
  const sessionId = ctx.caller.session ?? "";
  const bus = ctx.attention.bus;
  if (!waiter || !bus.register(sessionId, waiter)) return { exit: true };
  const deadline = ctx.now() + ctx.fleet.timing().wait_poll_ms;
  let beat = true;
  for (;;) {
    if (bus.closed) return { wait: true };
    const s = getSession(ctx.db, sessionId);
    if (!s || s.ended_at !== null || !bus.isCurrent(sessionId, waiter) || heldByAnother(ctx.db, sessionId)) return { exit: true };
    const now = ctx.now();
    const push = tx(ctx.db, () => {
      if (beat) heartbeat(ctx.db, sessionId, now);
      if (interruptedByTranscript(ctx, s)) {
        setSession(ctx.db, s.session_id, { busy_until: now });
        s.busy_until = now;
        expireBusy(ctx.db, s, now, "interrupt marker in the transcript");
      } else expireBusy(ctx.db, s, now, "busy lease expired");
      return leaderPush(ctx, s, now);
    });
    beat = false;
    if (push.push) return { push: { item: push.push.items[0]!.id, mode: push.push.mode } };
    let remaining = deadline - now;
    if (remaining <= 0) return { wait: true };
    // Wake when a batch of questions comes due.
    if (push.dueAt !== null && push.dueAt > now) remaining = Math.min(remaining, push.dueAt - now);
    // Wake for the lease expiry, and poll the transcript while a Claude turn runs.
    if (s.busy === 1 && s.busy_until !== null) remaining = Math.min(remaining, Math.max(50, s.busy_until - now));
    if (s.busy === 1 && s.harness === "claude") remaining = Math.min(remaining, 2_000);
    const outcome = await bus.wait(sessionId, waiter, remaining);
    if (outcome === "superseded") return { exit: true };
  }
}

function heldByAnother(db: Db, sessionId: string): boolean {
  const holder = getLease(db).session_id;
  if (!holder || holder === sessionId) return false;
  const row = getSession(db, holder);
  return row !== null && row.ended_at === null;
}

/** Record the push the waiter found, re-checked inside the transaction; the per-item lease keeps it single. */
export function takeP0(ctx: HandlerCtx, outcome: WaitOutcome): HandlerResult {
  if (!outcome.push) return { data: { ...outcome } };
  const s = leaderSession(ctx);
  const now = ctx.now();
  const { push } = leaderPush(ctx, s, now);
  if (!push || push.items[0]!.id !== outcome.push.item) return { data: { wait: true } };
  const path: PresentationPath = push.mode;
  const turn = pushTurn(s, push.mode);
  // Claude's waiter wakes the session by itself; the Pi extension decides after it looks at Pi, so it gets an offer.
  const taken = push.items.filter((item) => {
    const c = { itemId: item.id, session: s.session_id, turn, path, now };
    return s.harness === "pi" ? offer(ctx.db, c) : carry(ctx.db, c);
  });
  if (taken.length === 0) return { data: { wait: true } };
  const ids = taken.map((item) => item.id);
  if (push.questions) appendEvent(ctx.db, { source: "hook", kind: "leader.questions_pushed", payload: { session: s.session_id, items: ids, path, turn }, ts: now });
  else appendEvent(ctx.db, { source: "hook", kind: "leader.p0_pushed", payload: { session: s.session_id, item: ids[0], path, turn }, ts: now });
  return { data: { fire: { id: ids[0], items: ids, line: pushText(push, taken, s.harness), mode: push.mode } } };
}

/**
 * Pi: the extension re-checks what it sees before it sends (a draft typed a
 * moment ago wins), then reports the path it used, or that it declined and
 * the item stays for your next digest.
 */
export function delivered(ctx: HandlerCtx, input: LeaderHookInput): HandlerResult {
  const s = leaderSession(ctx);
  const now = ctx.now();
  const item = String(input.item ?? "");
  if (input.ok === false) {
    releaseOffer(ctx.db, item, s.session_id);
    appendEvent(ctx.db, { source: "hook", kind: "leader.p0_declined", payload: { session: s.session_id, item }, ts: now });
    return { data: { item, declined: true } };
  }
  // The extension reports before it sends, in order with its other hooks, so the session's turn is Pi's turn now:
  // a followUp rides in the running turn, a triggered turn is the next one.
  const mode: PushMode = input.mode === "trigger" ? "trigger" : "continuation";
  const items = acceptOffer(ctx.db, item, s.session_id, mode, pushTurn(s, mode), now);
  const recorded = items.length > 0;
  appendEvent(ctx.db, { source: "hook", kind: "leader.p0_delivered", payload: { session: s.session_id, item, items, path: mode, recorded }, ts: now });
  return { data: { item, recorded } };
}
