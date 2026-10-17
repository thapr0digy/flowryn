import { getMeta, setMeta, type Db } from "../db/db.ts";
import { clockLabel } from "../attention/away.ts";

/**
 * What the leader rewake (src/leader/rewake.ts) last did, kept in the meta
 * table so `leader status` and the briefing read it without the daemon, and
 * so the hourly wake budget counts typed rewakes: the lease holder's session,
 * when the daemon typed into its pane in the last hour, and why it cannot
 * wake the leader now (null when nothing stops it).
 */
export interface RewakeState {
  session: string;
  /** When the daemon typed the rewake line, newest last, within the last hour. */
  typed: number[];
  /** Why no rewake can reach the leader now, or null. */
  reason: string | null;
  /** Since when that reason holds. */
  since: number | null;
}

const KEY = "leader_rewake";
const HOUR_MS = 3_600_000;

/** The stored state for `session`; a fresh one when the store names another session or nothing. */
export function rewakeState(db: Db, session: string): RewakeState {
  const raw = getMeta(db, KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as RewakeState;
      if (parsed.session === session) return parsed;
    } catch {
      // A malformed row reads as empty: the next write replaces it.
    }
  }
  return { session, typed: [], reason: null, since: null };
}

/** Store the state, keeping only the last hour's rewakes. Call inside a transaction that appends an event. */
export function saveRewakeState(db: Db, state: RewakeState, now: number): void {
  setMeta(db, KEY, JSON.stringify({ ...state, typed: state.typed.filter((at) => at > now - HOUR_MS) }));
}

/** Rewakes typed into `session`'s pane in the last hour: they count against the P0 wake budget. */
export function rewakesLastHour(db: Db, session: string, now: number): number {
  return rewakeState(db, session).typed.filter((at) => at > now - HOUR_MS).length;
}

/** The one line `leader status`, `fleet` and the briefing carry while no wake can reach the lease holder, else null. */
export function wakeBlockedLine(db: Db, session: string | null, now: number): string | null {
  if (!session) return null;
  const state = rewakeState(db, session);
  if (!state.reason) return null;
  const since = state.since !== null ? ` since ${clockLabel(state.since, now)}` : "";
  return `Leader wake: not possible${since}: ${state.reason}.`;
}
