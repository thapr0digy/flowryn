import type { Db } from "../db/db.ts";
import { appendEvent, type EventSource } from "../db/events.ts";
import { openItem } from "../attention/items.ts";

/**
 * The leader-wake runaway guard (task no-idle-workers-23). Leader wakes have
 * no hourly cap; a session that started [leader] wake_ceiling_per_hour turns
 * from pushes in the last hour is woken no more until the hour drains
 * (leaderPush's `ceiling`), and this opens one P0 so you hear of it: wakes
 * that often mean something loops. It stays open until you or the leader
 * dismiss it; while one is open for a session, no second opens for it.
 */

export const WAKE_CEILING_EVENT = "leader.wake_ceiling";

export interface CeilingHit {
  started: number;
  limit: number;
}

/** Open the runaway P0 for `session` unless one is open for it. Call inside the transaction. Returns the item opened, or null. */
export function syncWakeCeiling(db: Db, session: string, ceiling: CeilingHit | null, source: EventSource, now: number): string | null {
  if (!ceiling) return null;
  const open = db
    .query(
      `SELECT 1 FROM items i JOIN events e ON e.seq = i.event_seq
       WHERE i.kind = 'leader_wake_runaway' AND i.state IN ('open','presented') AND json_extract(e.payload, '$.session') = ?1`,
    )
    .get(session);
  if (open) return null;
  const event = appendEvent(db, { source, kind: WAKE_CEILING_EVENT, payload: { session, started: ceiling.started, limit: ceiling.limit }, ts: now });
  const line = `Leader session ${session} was woken ${ceiling.started} times in the last hour, the ceiling ([leader] wake_ceiling_per_hour = ${ceiling.limit}); no push wakes it until the hour drains. Something may be looping: flowryn fleet`;
  return openItem(db, { kind: "leader_wake_runaway", eventSeq: event.seq, line, now });
}
