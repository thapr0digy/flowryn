import { findOpenItem, openItem, resolveItems } from "../attention/items.ts";
import type { Db } from "../db/db.ts";
import { getMeta, setMeta } from "../db/db.ts";
import { appendEvent, type EventSource } from "../db/events.ts";
import { ForgeError } from "../forge/types.ts";
import { sanitizeLine } from "../util/sanitize.ts";

/**
 * GitHub unavailable or rate-limited (design section 16): the watchers back
 * off (ETags keep polling cheap) and merges refuse, since landing cannot be
 * proven; you hear one P1, and only if a merge is waiting: a delivered PR at
 * the merge gate (`ready`) or a merge waiting for its proof (`merging`). The
 * outage lives in meta from the first failed read until GitHub answers again;
 * its P1 resolves then, or as soon as no merge waits any more.
 */

const DOWN_SINCE = "forge_down_since";
/** The outage (its start) whose P1 has opened. */
const ALERTED = "forge_alerted_episode";

/** The failures that mean GitHub cannot be asked: down, rate-limited, refusing the token, or answering nonsense. */
export function isForgeOutage(error: unknown): error is ForgeError {
  return error instanceof ForgeError && (error.kind === "unreachable" || error.kind === "rate_limited" || error.kind === "auth" || error.kind === "protocol");
}

/** The ships whose merge waits on GitHub: a delivered PR at the merge gate, or a merge waiting for its proof. */
export function waitingMerges(db: Db): string[] {
  const rows = db
    .query(
      `SELECT r.task_id FROM runs r JOIN task_policy p ON p.task_id = r.task_id
       WHERE p.kind = 'ship' AND p.delivery_mode != 'local-only' AND r.state IN ('ready','merging') ORDER BY r.updated_at`,
    )
    .all() as { task_id: string }[];
  return rows.map((r) => r.task_id);
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function describe(error: ForgeError): string {
  if (error.kind === "rate_limited") return `rate-limited${error.retryAt ? ` until ${clock(error.retryAt)}` : ""}`;
  if (error.kind === "auth") return `refusing Flowryn's token (${sanitizeLine(error.message, 80)})`;
  return `unavailable (${sanitizeLine(error.message, 80)})`;
}

/**
 * GitHub failed a read. Starts the outage, and opens its one P1 when a merge
 * waits. Call inside a transaction. Returns the item it opened.
 */
export function noteForgeDown(db: Db, error: ForgeError, source: EventSource, now: number): string | null {
  let since = Number(getMeta(db, DOWN_SINCE) ?? "");
  if (!Number.isFinite(since) || since <= 0) {
    since = now;
    setMeta(db, DOWN_SINCE, String(now));
    appendEvent(db, { source, kind: "forge.unavailable", payload: { kind: error.kind, status: error.status, retry_at: error.retryAt, message: sanitizeLine(error.message, 200) }, ts: now });
  }
  const waiting = waitingMerges(db);
  if (waiting.length === 0 || getMeta(db, ALERTED) === String(since) || findOpenItem(db, "forge_unavailable", null)) return null;
  setMeta(db, ALERTED, String(since));
  const event = appendEvent(db, { source, kind: "forge.unavailable_alert", payload: { kind: error.kind, waiting }, ts: now });
  const named = waiting.slice(0, 3).join(", ") + (waiting.length > 3 ? ` +${waiting.length - 3}` : "");
  return openItem(db, {
    kind: "forge_unavailable",
    eventSeq: event.seq,
    line: `GitHub is ${describe(error)}: ${waiting.length} merge(s) wait (${named}); flowryn merge refuses until it answers, and the watcher retries with backoff`,
    now,
  });
}

/** GitHub answered: the outage ends and its P1 resolves. Call inside a transaction. */
export function noteForgeUp(db: Db, source: EventSource, now: number): void {
  const since = Number(getMeta(db, DOWN_SINCE) ?? "");
  if (!Number.isFinite(since) || since <= 0) return;
  setMeta(db, DOWN_SINCE, "");
  setMeta(db, ALERTED, "");
  resolveItems(db, "forge_unavailable", null, "GitHub answered again", now);
  appendEvent(db, { source, kind: "forge.available", payload: { down_ms: now - since }, ts: now });
}

/** No merge waits any more: the P1 has nothing left to say; a merge that comes to wait in the same outage raises it again. Call inside a transaction. */
export function settleForgeAlert(db: Db, now: number): void {
  if (!findOpenItem(db, "forge_unavailable", null) || waitingMerges(db).length > 0) return;
  setMeta(db, ALERTED, "");
  resolveItems(db, "forge_unavailable", null, "no merge waits", now);
}
