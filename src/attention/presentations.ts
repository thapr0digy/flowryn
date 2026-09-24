import type { Db } from "../db/db.ts";

/**
 * Presentations (design section 9). No harness can observe that the leader
 * saw something, so an item is `carried` when a hook or the extension hands
 * it over, and `presented` only when the same session's next turn end
 * follows. A turn with no turn end (an interrupt, a dropped hook, an API
 * error) leaves it carried, and the next turn start marks it `lost`, so it is
 * carried again. An informational item drops to the board after three
 * carries that were never presented.
 *
 * Each carry names the turn it expects to appear in: a digest and a Stop
 * continuation belong to the running turn; a waiter, a trigger and a
 * briefing to the next one.
 */

export type PresentationPath = "briefing" | "digest" | "continuation" | "waiter" | "trigger";

/** Paths that push a P0 by themselves; a P0 is leased to one of them at a time (unique index one_p0_path). */
export const P0_PATHS: readonly PresentationPath[] = ["continuation", "waiter", "trigger"];

/** Informational items are carried at most this many times before they drop to the board. */
export const MAX_INFO_ATTEMPTS = 3;

export interface Carry {
  itemId: string;
  session: string;
  turn: number;
  path: PresentationPath;
  now: number;
}

/**
 * Record a presentation row in `state` for the carry's turn. A row the same
 * session lost for that same turn (a /clear or a lease change before the turn
 * started) is reused; a live row for it, or a P0 already leased to another
 * push path (one_p0_path, one_p0_offer), refuses it.
 */
function record(db: Db, c: Carry, state: "carried" | "offered"): boolean {
  const revived = db
    .query("UPDATE OR IGNORE presentations SET path = ?4, state = ?5, carried_at = ?6, confirmed_at = NULL WHERE item_id = ?1 AND session_id = ?2 AND turn_no = ?3 AND state = 'lost'")
    .run(c.itemId, c.session, c.turn, c.path, state, c.now).changes;
  if (revived > 0) return true;
  return (
    db
      .query("INSERT OR IGNORE INTO presentations (item_id, session_id, turn_no, path, state, carried_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .run(c.itemId, c.session, c.turn, c.path, state, c.now).changes > 0
  );
}

/**
 * Record a carry. Call inside a transaction. False when the item already
 * rides in this turn, or when it is a P0 already leased to another push path,
 * which is what keeps a P0 from being delivered twice.
 */
export function carry(db: Db, c: Carry): boolean {
  if (!record(db, c, "carried")) return false;
  db.query("UPDATE items SET attempts = attempts + 1 WHERE id = ?1").run(c.itemId);
  return true;
}

/**
 * Offer a P0 to a Pi extension. Call inside a transaction. The offer holds
 * the item's push lease, but no turn end confirms it: the extension looks at
 * Pi first (a run may have just ended, a draft may have just been typed) and
 * reports whether and how it delivered. False when the lease is taken.
 */
export function offer(db: Db, c: Carry): boolean {
  return record(db, c, "offered");
}

/** The extension delivered an offered P0 by `path`: it is carried for `turn` from now on. */
export function acceptOffer(db: Db, itemId: string, session: string, path: PresentationPath, turn: number, now: number): boolean {
  const moved = db
    .query("UPDATE presentations SET state = 'carried', path = ?3, turn_no = ?4, carried_at = ?5 WHERE item_id = ?1 AND session_id = ?2 AND state = 'offered'")
    .run(itemId, session, path, turn, now).changes;
  if (moved === 0) return carry(db, { itemId, session, turn, path, now });
  db.query("UPDATE items SET attempts = attempts + 1 WHERE id = ?1").run(itemId);
  return true;
}

/** A push path declined the item (a Pi leader went idle, or you started typing); the lease is free again. */
export function releaseOffer(db: Db, itemId: string, session: string): void {
  db.query("DELETE FROM presentations WHERE item_id = ?1 AND session_id = ?2 AND state = 'offered'").run(itemId, session);
}

/**
 * The session's turn `turn` ended: every carry made for it or before it is
 * presented. Call inside a transaction, before recording anything carried at
 * this same turn end (a Stop continuation is confirmed by the next Stop).
 */
export function confirmTurn(db: Db, session: string, turn: number, now: number): string[] {
  const rows = db.query("SELECT item_id FROM presentations WHERE session_id = ?1 AND state = 'carried' AND turn_no <= ?2").all(session, turn) as { item_id: string }[];
  if (rows.length === 0) return [];
  db.query("UPDATE presentations SET state = 'presented', confirmed_at = ?3 WHERE session_id = ?1 AND state = 'carried' AND turn_no <= ?2").run(session, turn, now);
  const ids = [...new Set(rows.map((r) => r.item_id))];
  for (const id of ids) db.query("UPDATE items SET state = 'presented' WHERE id = ?1 AND state = 'open'").run(id);
  return ids;
}

/**
 * Carries (and offers) that will never be confirmed: those for turns before `beforeTurn`
 * (a new turn started without the old one ending), or all of the session's
 * when `beforeTurn` is null (the session ended or lost the lease). An
 * informational item that used its attempts drops to the board. Call inside a
 * transaction.
 */
export function loseCarried(db: Db, session: string, beforeTurn: number | null, now: number): string[] {
  const filter = beforeTurn === null ? "" : "AND turn_no < ?2";
  const params = beforeTurn === null ? [session] : [session, beforeTurn];
  const rows = db.query(`SELECT item_id FROM presentations WHERE session_id = ?1 AND state IN ('carried','offered') ${filter}`).all(...params) as { item_id: string }[];
  if (rows.length === 0) return [];
  db.query(`UPDATE presentations SET state = 'lost' WHERE session_id = ?1 AND state IN ('carried','offered') ${filter}`).run(...params);
  const ids = [...new Set(rows.map((r) => r.item_id))];
  for (const id of ids) {
    db.query("UPDATE items SET state = 'dropped', resolved_by = 'not presented after 3 attempts', resolved_at = ?2 WHERE id = ?1 AND class = 'info' AND state = 'open' AND attempts >= ?3").run(
      id,
      now,
      MAX_INFO_ATTEMPTS,
    );
  }
  return ids;
}

/** Presentations of one item, newest first, for `show` and tests. */
export function presentationsOf(db: Db, itemId: string): { session_id: string; turn_no: number; path: string; state: string }[] {
  return db.query("SELECT session_id, turn_no, path, state FROM presentations WHERE item_id = ?1 ORDER BY carried_at DESC, turn_no DESC").all(itemId) as {
    session_id: string;
    turn_no: number;
    path: string;
    state: string;
  }[];
}

/** Turns a P0 started in this session in the last hour (waiter wakes and Pi triggers), for the cap of design section 9. */
export function startedTurnsLastHour(db: Db, session: string, now: number): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM presentations WHERE session_id = ?1 AND path IN ('waiter','trigger') AND carried_at > ?2")
    .get(session, now - 3_600_000) as { n: number };
  return row.n;
}
