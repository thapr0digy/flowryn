import { FlowrynError } from "../api/errors.ts";
import type { HandlerCtx, HandlerResult } from "../api/verbs.ts";
import { composeBriefing, readOnlyBanner } from "../attention/briefing.ts";
import { acceptOffer, carry, confirmTurn, loseCarried, offer, releaseOffer, startedTurnsLastHour, type PresentationPath } from "../attention/presentations.ts";
import { composeDigest, digestCandidates, isWakePrompt, p0Candidate, p0Line, type RankedItem } from "../attention/router.ts";
import { tx, type Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { claim, getLease, getSession, heartbeat, closeSession, isHolder, leaseState, type Claimed, type LeaderSessionRow } from "../lease/lease.ts";
import { transcriptShowsInterrupt, transcriptSize } from "../lifecycle/control.ts";

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
 * Should a P0 be pushed to this session now, and how (design section 9)?
 * Busy: Claude's Stop continuation takes it (not a waiter), Pi's extension
 * follows up. Idle and you inactive: a Claude waiter wakes the session, a Pi
 * extension triggers a turn if it has the TUI. Idle and you active: nothing
 * is pushed; it tops your next digest. Started turns are capped per hour.
 */
export function p0Push(ctx: HandlerCtx, s: LeaderSessionRow, now: number): { item: RankedItem; mode: PushMode } | null {
  if (!isHolder(ctx.db, s.session_id)) return null;
  const item = p0Candidate(ctx.db, s.session_id, now, ageMs(ctx));
  if (!item) return null;
  const busy = busyNow(s, now);
  if (busy) return s.harness === "pi" ? { item, mode: "continuation" } : null;
  if (s.user_inactive_since === null) return null;
  if (s.harness === "pi" && s.has_ui !== 1) return null;
  if (startedTurnsLastHour(ctx.db, s.session_id, now) >= ctx.attention.notify().max_triggered_turns_per_hour) return null;
  return { item, mode: s.harness === "pi" ? "trigger" : "waiter" };
}

function pushTurn(s: LeaderSessionRow, mode: PushMode): number {
  return mode === "continuation" ? s.turn_no : s.turn_no + 1;
}

/** Compose the holder's briefing and carry every item it lists for `turn`. Inside a transaction. */
function brief(ctx: HandlerCtx, s: LeaderSessionRow, turn: number, now: number): { text: string; listed: number } {
  const briefing = composeBriefing(ctx.db, { session: s.session_id, now, morningHour: ctx.config().morning_hour, ageMs: ageMs(ctx), markMorning: true });
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
 * The daemon carries nothing past it, and the CLI prints nothing it receives
 * past it, so a hook that ran too slow for Claude to use (a timed-out hook's
 * context is dropped) never counts as carried. Null when the start is unknown.
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
    const digest = composeDigest(digestCandidates(ctx.db, s.session_id, now, ageMs(ctx)));
    if (digest) {
      for (const item of digest.shown) carry(ctx.db, { itemId: item.id, session: s.session_id, turn, path: "digest", now });
      lines.push(digest.text);
    }
  }
  if (lines.length === 0) return { data: {} };
  return { data: deadline === null ? { context: lines.join("\n") } : { context: lines.join("\n"), deadline } };
}

/** Pre/PostToolUse: refresh the busy lease, and the heartbeat. A tool never starts a turn. */
export function toolActivity(ctx: HandlerCtx): HandlerResult {
  const s = leaderSession(ctx);
  const now = ctx.now();
  refreshBusy(ctx, s, now);
  heartbeat(ctx.db, s.session_id, now);
  return { data: {} };
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
  const presented = confirmTurn(ctx.db, s.session_id, s.turn_no, now);
  heartbeat(ctx.db, s.session_id, now);
  if (s.harness === "claude" && s.continuations < MAX_LEADER_CONTINUATIONS && isHolder(ctx.db, s.session_id)) {
    const item = p0Candidate(ctx.db, s.session_id, now, ageMs(ctx));
    if (item && carry(ctx.db, { itemId: item.id, session: s.session_id, turn: s.turn_no, path: "continuation", now })) {
      setSession(ctx.db, s.session_id, { continuations: s.continuations + 1, busy: 1, busy_until: now + ctx.attention.timing().busy_lease_ms });
      appendEvent(ctx.db, { source: "hook", kind: "leader.p0_pushed", payload: { session: s.session_id, item: item.id, path: "continuation", turn: s.turn_no }, ts: now });
      return { data: { context: p0Line(item), item: item.id, presented } };
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
 * most wait_poll_ms; a newer waiter for the session supersedes it, and a
 * session that does not hold the lease gets no pushes, so its waiter exits.
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
    if (!s || s.ended_at !== null || !bus.isCurrent(sessionId, waiter) || !isHolder(ctx.db, sessionId)) return { exit: true };
    const now = ctx.now();
    const push = tx(ctx.db, () => {
      if (beat) heartbeat(ctx.db, sessionId, now);
      if (interruptedByTranscript(ctx, s)) {
        setSession(ctx.db, s.session_id, { busy_until: now });
        s.busy_until = now;
        expireBusy(ctx.db, s, now, "interrupt marker in the transcript");
      } else expireBusy(ctx.db, s, now, "busy lease expired");
      return p0Push(ctx, s, now);
    });
    beat = false;
    if (push) return { push: { item: push.item.id, mode: push.mode } };
    let remaining = deadline - now;
    if (remaining <= 0) return { wait: true };
    // Wake for the lease expiry, and poll the transcript while a Claude turn runs.
    if (s.busy === 1 && s.busy_until !== null) remaining = Math.min(remaining, Math.max(50, s.busy_until - now));
    if (s.busy === 1 && s.harness === "claude") remaining = Math.min(remaining, 2_000);
    const outcome = await bus.wait(sessionId, waiter, remaining);
    if (outcome === "superseded") return { exit: true };
  }
}

/** Record the push the waiter found, re-checked inside the transaction; the per-item lease keeps it single. */
export function takeP0(ctx: HandlerCtx, outcome: WaitOutcome): HandlerResult {
  if (!outcome.push) return { data: { ...outcome } };
  const s = leaderSession(ctx);
  const now = ctx.now();
  const push = p0Push(ctx, s, now);
  if (!push || push.item.id !== outcome.push.item) return { data: { wait: true } };
  const path: PresentationPath = push.mode;
  const c = { itemId: push.item.id, session: s.session_id, turn: pushTurn(s, push.mode), path, now };
  // Claude's waiter wakes the session by itself; the Pi extension decides after it looks at Pi, so it gets an offer.
  if (!(s.harness === "pi" ? offer(ctx.db, c) : carry(ctx.db, c))) return { data: { wait: true } };
  appendEvent(ctx.db, { source: "hook", kind: "leader.p0_pushed", payload: { session: s.session_id, item: push.item.id, path, turn: c.turn }, ts: now });
  return { data: { fire: { id: push.item.id, line: p0Line(push.item), mode: push.mode } } };
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
  const recorded = acceptOffer(ctx.db, item, s.session_id, mode, pushTurn(s, mode), now);
  appendEvent(ctx.db, { source: "hook", kind: "leader.p0_delivered", payload: { session: s.session_id, item, path: mode, recorded }, ts: now });
  return { data: { item, recorded } };
}
