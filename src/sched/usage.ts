import { findOpenItem, openItem, resolveItems } from "../attention/items.ts";
import type { Db } from "../db/db.ts";
import { getMeta, setMeta } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";

/**
 * The Claude usage limit (design sections 11 and 16): a Claude turn that ends
 * in StopFailure with error `rate_limit` (the documented error type for a
 * claude.ai usage limit) pauses every Claude launch and grant, and a P1 says
 * so once. Claude's own Notification `quota_auto_resume_fired` (it continued
 * after the reset), or any later Claude turn that ends normally, proves usage
 * is available again and lifts the pause. Autonomy pauses with it.
 */

const KEY = "claude_usage_limit_since";

export function usageLimitSince(db: Db): number | null {
  const value = getMeta(db, KEY);
  return value && value !== "0" ? Number(value) : null;
}

/** A Claude turn hit the usage limit. Call inside a transaction; true when this started the pause. */
export function noteUsageLimit(db: Db, who: string, detail: string, now: number): boolean {
  if (usageLimitSince(db) !== null) return false;
  setMeta(db, KEY, String(now));
  const event = appendEvent(db, { source: "hook", kind: "sched.usage_limit", payload: { who, detail }, ts: now });
  if (!findOpenItem(db, "usage_limit", null)) {
    openItem(db, { kind: "usage_limit", eventSeq: event.seq, line: `Claude usage limit reached (${who}); Claude launches and stage starts pause until it resets`, now });
  }
  return true;
}

/** Usage is available again. Call inside a transaction; true when this lifted the pause. */
export function clearUsageLimit(db: Db, why: string, now: number): boolean {
  const since = usageLimitSince(db);
  if (since === null) return false;
  setMeta(db, KEY, "0");
  appendEvent(db, { source: "hook", kind: "sched.usage_resumed", payload: { why, paused_ms: now - since }, ts: now });
  resolveItems(db, "usage_limit", null, `usage resumed: ${why}`, now);
  return true;
}
