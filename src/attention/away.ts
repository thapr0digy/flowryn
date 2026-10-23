import type { Db } from "../db/db.ts";
import { getMeta, setMeta } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { getLease, getSession } from "../lease/lease.ts";
import { sanitizeLine } from "../util/sanitize.ts";
import type { ItemKind } from "./items.ts";

/**
 * Away mode (autonomy spec 2, ship B): `flowryn away` stores a posture, an
 * expiry and your words in the meta table; `flowryn back` or the expiry ends
 * it. While away, every new item that needs you wakes the leader as a P0
 * would, so it reaches you in the remote-control chat. It changes delivery
 * only: no approval, gate, merge or decision rule reads it. After `[away]
 * auto_after_min` with no input from you, the daemon starts it by itself
 * (autoAway, `by: "auto"`), and your next own message ends that one.
 */

const AWAY_KEY = "away";
const LAST_KEY = "away_last";

/** Your words are kept to one line of this many characters. */
export const AWAY_WORDS_MAX = 500;
/** `--until` reaches at most this far ahead. */
export const AWAY_MAX_MS = 7 * 24 * 60 * 60_000;

export interface AwayPosture {
  since: number;
  until: number;
  words: string | null;
  /** The role that ran `flowryn away`: human (your terminal) or leader (on your words in chat); AUTO_AWAY_BY when the daemon started it. */
  by: string;
  /** The start of an expired away whose unshown brief this one folded in: the return brief starts here. */
  brief_since?: number;
}

/** back: `flowryn back`; expired: its expiry; returned: your own message ended an automatic away. */
export type AwayEndReason = "back" | "expired" | "returned";

/** The `by` of an away the daemon started after your inactivity (autoAway). */
export const AUTO_AWAY_BY = "auto";

export interface AwayEnded {
  since: number;
  ended_at: number;
  reason: AwayEndReason;
  /** The return brief waits for your next message (an expiry, or your return); `back` prints it at once. */
  brief_pending: boolean;
}

/**
 * The items that wake the leader while you are away, on top of the P0 lane
 * and the worker-question batch (which wake already once you are inactive):
 * what only you can move. A yolo, non-sensitive PR merges without you, and a
 * report waits on you only when it opened a decision reserved for you. The
 * leader follow-ups (LEADER_WAKE_KINDS) wake it whether you are away or only
 * inactive; they are listed here so the away suggestion and brief count them.
 */
export const AWAY_WAKE_KINDS: readonly ItemKind[] = ["gate_ready", "pass_requested", "checks_red", "pr_ready", "report_ready", "user_acted", "landed"];

/**
 * SQL for "item `i` wakes the leader while away", with `?<since>` the away
 * start: only items opened since then.
 */
export function awayWakeSql(sinceParam: string): string {
  return `(${sinceParam} IS NOT NULL AND i.opened_at >= ${sinceParam} AND (
      i.kind IN ('gate_ready','pass_requested','checks_red','user_acted','landed')
      OR (i.kind = 'pr_ready' AND EXISTS (SELECT 1 FROM task_policy ap WHERE ap.task_id = i.task_id AND ap.yolo = 0))
      OR (i.kind = 'report_ready' AND EXISTS (SELECT 1 FROM decisions ad WHERE ad.origin = i.task_id AND ad.state = 'open' AND ad.reserved_reason IS NOT NULL))))`;
}

function parse<T>(raw: string | null): T | null {
  if (raw === null || raw === "") return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** The stored posture, expired or not. */
export function storedAway(db: Db): AwayPosture | null {
  return parse<AwayPosture>(getMeta(db, AWAY_KEY));
}

/** You are away now: a stored posture that has not expired. An expired one is ended by the next expireAway. */
export function getAway(db: Db, now: number): AwayPosture | null {
  const away = storedAway(db);
  return away && away.until > now ? away : null;
}

/** The last away that ended, for `back` (a reprint) and the next message (an expiry's brief). */
export function lastAway(db: Db): AwayEnded | null {
  return parse<AwayEnded>(getMeta(db, LAST_KEY));
}

/**
 * Start away, or extend it (a new expiry, words and `by`; the start stays). A
 * start after an expiry whose brief was never shown carries that away's start
 * for its brief. `since` backdates a new start (autoAway: when you went
 * inactive). Call inside a transaction.
 */
export function startAway(
  db: Db,
  input: { until: number; words: string | null; by: string; now: number; since?: number; source?: "cli" | "daemon" },
): { posture: AwayPosture; extended: boolean } {
  const current = getAway(db, input.now);
  const unshown = current ? null : foldPendingBrief(db, input.now);
  const words = input.words === null ? (current?.words ?? null) : sanitizeLine(input.words, AWAY_WORDS_MAX) || null;
  const briefSince = current ? current.brief_since : unshown?.since;
  const posture: AwayPosture = { since: current?.since ?? Math.min(input.since ?? input.now, input.now), until: input.until, words, by: input.by, ...(briefSince === undefined ? {} : { brief_since: briefSince }) };
  setMeta(db, AWAY_KEY, JSON.stringify(posture));
  const payload = { since: posture.since, until: posture.until, by: input.by, words, ...(unshown ? { folded: true } : {}) };
  appendEvent(db, { source: input.source ?? "cli", kind: current ? "away.extended" : "away.started", payload, ts: input.now });
  return { posture, extended: current !== null };
}

/**
 * Before a new away starts: end an expired one, and if an expired away's
 * brief was never shown, take it so the new away's one brief covers both.
 */
function foldPendingBrief(db: Db, now: number): AwayEnded | null {
  expireAway(db, now);
  const last = lastAway(db);
  if (!last?.brief_pending) return null;
  setMeta(db, LAST_KEY, JSON.stringify({ ...last, brief_pending: false }));
  return last;
}

/** End away. An expiry ends at its own time and leaves the brief for your next message. Call inside a transaction. */
export function endAway(db: Db, reason: AwayEndReason, now: number): AwayEnded | null {
  const away = storedAway(db);
  if (!away) return null;
  const ended: AwayEnded = { since: away.brief_since ?? away.since, ended_at: reason === "expired" ? Math.min(away.until, now) : now, reason, brief_pending: reason !== "back" };
  setMeta(db, AWAY_KEY, "");
  setMeta(db, LAST_KEY, JSON.stringify(ended));
  appendEvent(db, { source: END_SOURCE[reason], kind: "away.ended", payload: { since: ended.since, ended_at: ended.ended_at, reason }, ts: now });
  return ended;
}

const END_SOURCE: Record<AwayEndReason, "cli" | "daemon" | "hook"> = { back: "cli", expired: "daemon", returned: "hook" };

/**
 * Start away by itself once you have been inactive `afterMs` (`[away]
 * auto_after_min`; 0 never): the lease holder's `user_inactive_since`, set by
 * Claude's idle_prompt or the Pi extension, is at least that old and no away
 * is on. It starts when you went inactive, so what opened while you were
 * gone and still waits wakes the leader now, and the brief covers the whole
 * absence. It runs until your next own message (endAutoAway), `flowryn back`
 * or AWAY_MAX_MS. After `back` it stays off for the rest of that inactive
 * spell. Null when it did not start. Call inside a transaction.
 */
export function autoAway(db: Db, input: { afterMs: number; now: number }): AwayPosture | null {
  const inactiveSince = holderInactiveSince(db);
  if (input.afterMs <= 0 || inactiveSince === null || input.now - inactiveSince < input.afterMs) return null;
  if (getAway(db, input.now)) return null;
  const last = lastAway(db);
  if (last?.reason === "back" && last.ended_at >= inactiveSince) return null;
  return startAway(db, { until: input.now + AWAY_MAX_MS, words: null, by: AUTO_AWAY_BY, now: input.now, since: inactiveSince, source: "daemon" }).posture;
}

/** When you went inactive in the lease holder's session; null with no open holder (nobody could be woken) or while you are active. */
function holderInactiveSince(db: Db): number | null {
  const holder = getLease(db).session_id;
  const session = holder ? getSession(db, holder) : null;
  return session && session.ended_at === null ? session.user_inactive_since : null;
}

/** Your own message (or Pi's report that you are active) ends an automatic away; its brief rides your next message. A manual one stays. Call inside a transaction. */
export function endAutoAway(db: Db, now: number): AwayEnded | null {
  return getAway(db, now)?.by === AUTO_AWAY_BY ? endAway(db, "returned", now) : null;
}

/** End away if its expiry has passed (the daemon's pass, and any away verb). Call inside a transaction. */
export function expireAway(db: Db, now: number): AwayEnded | null {
  const away = storedAway(db);
  return away && away.until <= now ? endAway(db, "expired", now) : null;
}

/** The expired away whose brief waits for your next message, taken once. Call inside a transaction. */
export function takePendingBrief(db: Db, now: number): AwayEnded | null {
  const last = lastAway(db);
  if (!last?.brief_pending) return null;
  setMeta(db, LAST_KEY, JSON.stringify({ ...last, brief_pending: false }));
  appendEvent(db, { source: "hook", kind: "away.brief_shown", payload: { since: last.since, ended_at: last.ended_at }, ts: now });
  return last;
}

/**
 * Parse `--until`: `HH:MM` (the next time the clock reads it), `+8h`,
 * `+90m` or `2h30m` (from now), or a local date and time
 * (`2026-10-06 08:00`, `2026-10-06T08:00`). Null when it is none of these.
 */
export function parseUntil(text: string, now: number): number | null {
  const value = text.trim().toLowerCase();
  const clock = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (clock) {
    const [h, m] = [Number(clock[1]), Number(clock[2])];
    if (h > 23 || m > 59) return null;
    const d = new Date(now);
    const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
    return at > now ? at : new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, h, m).getTime();
  }
  const span = /^\+?(?:(\d{1,3})h)?(?:(\d{1,4})m)?$/.exec(value);
  if (span && (span[1] !== undefined || span[2] !== undefined)) return now + (Number(span[1] ?? 0) * 60 + Number(span[2] ?? 0)) * 60_000;
  const stamp = /^(\d{4})-(\d{2})-(\d{2})[t ](\d{2}):(\d{2})$/.exec(value);
  if (stamp) {
    const [y, mo, d, h, mi] = stamp.slice(1).map(Number) as [number, number, number, number, number];
    const at = new Date(y, mo - 1, d, h, mi);
    if (at.getFullYear() !== y || at.getMonth() !== mo - 1 || at.getDate() !== d || at.getHours() !== h || at.getMinutes() !== mi) return null;
    return at.getTime();
  }
  return null;
}

/** "22:41", or "Oct 6 08:00" when it is not on `now`'s day. */
export function clockLabel(ts: number, now: number): string {
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const n = new Date(now);
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay ? hm : `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${hm}`;
}

/** The one line the briefing and `fleet` carry while you are away. */
export function awayLine(away: AwayPosture, now: number): string {
  if (away.by === AUTO_AWAY_BY)
    return `Away (automatic: no input from the user since ${clockLabel(away.since, now)}); the user's next message ends it. Items that need the user wake the leader; flowryn back ends it.`;
  const words = away.words ? `: "${sanitizeLine(away.words, 120)}"` : "";
  return `Away since ${clockLabel(away.since, now)} until ${clockLabel(away.until, now)}${words}. Items that need the user wake the leader; flowryn back ends it.`;
}

const SUGGESTED_KEY = "away_suggested";

/**
 * The idle_prompt signal may suggest away, never set it: your first message
 * after `suggestAfterMs` inactive, while not away, when an item that would
 * have woken the leader opened in that time and still waits, gets one line,
 * at most once a day. Call inside a transaction (it records the day).
 */
export function awaySuggestion(db: Db, input: { inactiveSince: number | null; now: number; suggestAfterMs: number; today: string }): string | null {
  if (input.inactiveSince === null || input.now - input.inactiveSince < input.suggestAfterMs) return null;
  if (getAway(db, input.now) || getMeta(db, SUGGESTED_KEY) === input.today) return null;
  const waited = db
    .query(`SELECT COUNT(*) AS n FROM items i WHERE i.class = 'actionable' AND i.state IN ('open','presented') AND ${awayWakeSql("?1")}`)
    .get(input.inactiveSince) as { n: number };
  if (waited.n === 0) return null;
  setMeta(db, SUGGESTED_KEY, input.today);
  appendEvent(db, { source: "hook", kind: "away.suggested", payload: { waited: waited.n, inactive_since: input.inactiveSince }, ts: input.now });
  const minutes = Math.round((input.now - input.inactiveSince) / 60_000);
  const span = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
  return `Flowryn: the user was inactive ${span} while ${waited.n} item${waited.n === 1 ? "" : "s"} waited for them; \`flowryn away\` would have woken the leader for them (a fact; suggest it, never set it).`;
}
