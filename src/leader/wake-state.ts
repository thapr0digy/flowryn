import { getMeta, setMeta, type Db } from "../db/db.ts";
import { clockLabel } from "../attention/away.ts";
import { allLeases, getLease, getSession, UNCONFIRMED_SCOPE } from "../lease/lease.ts";

/** The hourly budget a wake counts against: P0s and follow-ups, or worker question batches. */
export type WakeBudget = "p0" | "questions";

/** One typed rewake: when, and the budget of the push that caused it. */
export interface TypedRewake {
  at: number;
  budget: WakeBudget;
}

/**
 * What the leader rewake (src/leader/rewake.ts) last did, kept in the meta
 * table so `leader status` and the briefing read it without the daemon, and
 * so the hourly wake budget counts typed rewakes: the lease holder's session,
 * when the daemon typed into its pane in the last hour, and why it cannot
 * wake the leader now (null when nothing stops it).
 */
export interface RewakeState {
  session: string;
  /** When the daemon typed the rewake line, and for which budget, newest last, within the last hour. */
  typed: TypedRewake[];
  /** Why no rewake can reach the leader now, or null. */
  reason: string | null;
  /** Since when that reason holds. */
  since: number | null;
}

/** One state per lease holder: with a leader per scope, several sessions lead at once. */
function key(session: string): string {
  return `leader_rewake:${session}`;
}
const HOUR_MS = 3_600_000;

/** The stored state for `session`; a fresh one when the store names another session or nothing. */
export function rewakeState(db: Db, session: string): RewakeState {
  const raw = getMeta(db, key(session));
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as RewakeState;
      if (parsed.session === session) return { ...parsed, typed: Array.isArray(parsed.typed) ? parsed.typed.filter((r) => typeof r?.at === "number") : [] };
    } catch {
      // A malformed row reads as empty: the next write replaces it.
    }
  }
  return { session, typed: [], reason: null, since: null };
}

/** Store the state, keeping only the last hour's rewakes. Call inside a transaction that appends an event. */
export function saveRewakeState(db: Db, state: RewakeState, now: number): void {
  setMeta(db, key(state.session), JSON.stringify({ ...state, typed: state.typed.filter((r) => r.at > now - HOUR_MS) }));
}

/** When the daemon last typed a rewake into `session`'s pane, or null. */
export function lastRewakeAt(state: RewakeState): number | null {
  return state.typed.at(-1)?.at ?? null;
}

/** Rewakes typed into `session`'s pane in the last hour for a push on `budget`: each counts against that hourly budget. */
export function rewakesLastHour(db: Db, session: string, now: number, budget: WakeBudget): number {
  return rewakeState(db, session).typed.filter((r) => r.budget === budget && r.at > now - HOUR_MS).length;
}

/** The holders a wake line is about: the session's own scope's, or every scope's for your terminal. */
function holdersFor(db: Db, session: string | null): (string | null)[] {
  if (session === null) return allLeases(db).map((l) => l.session_id);
  const own = getSession(db, session);
  return own && own.scope !== UNCONFIRMED_SCOPE ? [getLease(db, own.scope).session_id] : [];
}

/** The first "no wake can reach the leader" line among the holders a reader cares about (`session` null: your terminal). */
export function wakeLineFor(db: Db, session: string | null, now: number): string | null {
  for (const holder of holdersFor(db, session)) {
    const line = wakeBlockedLine(db, holder, now);
    if (line) return line;
  }
  return null;
}

/** The one line `leader status`, `fleet` and the briefing carry while no wake can reach the lease holder, else null. */
export function wakeBlockedLine(db: Db, session: string | null, now: number): string | null {
  if (!session) return null;
  const state = rewakeState(db, session);
  if (!state.reason) return null;
  const since = state.since !== null ? ` since ${clockLabel(state.since, now)}` : "";
  return `Leader wake: not possible${since}: ${state.reason}.`;
}
