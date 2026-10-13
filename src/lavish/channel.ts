import { openItem } from "../attention/items.ts";
import type { Db } from "../db/db.ts";
import { tx } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { LIVE_RUN } from "../lifecycle/gate-questions.ts";
import { sanitizeLine } from "../util/sanitize.ts";

/**
 * A review gate's channel health (docs/notes/2026-10-12-next-steps-md-7b.md): whether the
 * daemon's `lavish-axi poll` of the gate's page is delivering. Each failed poll is persisted on
 * the gate with why and when it tries again; healthy is written only when it changes. A channel
 * failing for `[review] channel_alert_ms` and at least MIN_FAILURES polls opens one
 * `review_channel` item, resolved on recovery or once the gate is no longer polled. Nothing here
 * touches the gate's state, a decision or an approval: recovery never passes a gate.
 */

/** Consecutive failed polls the item needs too, so one failure after a long daemon outage is not enough. */
export const MIN_FAILURES = 2;
const MAX_REASON_CHARS = 160;

export interface ChannelColumns {
  channel_ok_at?: number | null;
  channel_failing_since?: number | null;
  channel_failures?: number | null;
  channel_reason?: string | null;
  channel_retry_at?: number | null;
  channel_item?: string | null;
}

interface ChannelGate extends ChannelColumns {
  id: string;
  run_id: string;
  stage: string;
  task_id: string;
  page_path: string | null;
}

/** The gate, while it is open and its run live: a poll's verdict for any other gate is recorded nowhere. */
function channelGate(db: Db, gateId: string): ChannelGate | null {
  return db
    .query(
      `SELECT g.id, g.run_id, g.stage, r.task_id, g.page_path, g.channel_ok_at, g.channel_failing_since, g.channel_failures,
              g.channel_reason, g.channel_retry_at, g.channel_item
       FROM gates g JOIN runs r ON r.id = g.run_id WHERE g.id = ?1 AND g.state = 'open' AND ${LIVE_RUN}`,
    )
    .get(gateId) as ChannelGate | null;
}

function itemOpen(db: Db, itemId: string | null | undefined): boolean {
  if (!itemId) return false;
  return db.query("SELECT 1 FROM items WHERE id = ?1 AND state IN ('open','presented')").get(itemId) !== null;
}

/** Consecutive failed polls recorded for the gate (the backoff counts from it, across restarts). */
export function channelFailures(db: Db, gateId: string): number {
  return (db.query("SELECT channel_failures AS n FROM gates WHERE id = ?1").get(gateId) as { n: number | null } | null)?.n ?? 0;
}

/** Why a poll failed, as one line: lavish-axi's own `error:` line when it printed one. */
export function pollFailureReason(code: number, stdout: string, stderr: string): string {
  const text = `${stdout}\n${stderr}`;
  if (/NOT_FOUND/.test(text)) return "no Lavish session for the page";
  if (code < 0) return sanitizeLine(stderr.trim() || "cannot run lavish-axi", MAX_REASON_CHARS);
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const said = lines.find((l) => /^error:/i.test(l)) ?? stderr.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  return sanitizeLine(said ? `${said} (exit ${code})` : `exit ${code}`, MAX_REASON_CHARS);
}

/** What to do about a failing channel, by why it fails. */
export function channelHint(reason: string, page: string | null): string {
  if (reason.startsWith("no Lavish session")) return `the worker hosts the page again with lavish-axi --no-open ${page ?? "<page>"}`;
  if (reason.startsWith("cannot run")) return "check [tools] lavish_axi";
  return "restart Lavish (lavish-axi server --verbose; its log is ~/.lavish-axi/server.log)";
}

function clock(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 5);
}

export interface ChannelFailure {
  reason: string;
  retryAt: number;
  alertMs: number;
  now: number;
}

/**
 * Record one failed poll of a gate's page; open the gate's review_channel item once the channel
 * has failed long enough. Returns the item opened, if one was.
 */
export function recordChannelFailure(db: Db, gateId: string, failure: ChannelFailure): string | null {
  return tx(db, () => {
    const gate = channelGate(db, gateId);
    if (!gate) return null;
    const failures = (gate.channel_failures ?? 0) + 1;
    const since = gate.channel_failing_since ?? failure.now;
    db.query("UPDATE gates SET channel_failing_since = ?2, channel_failures = ?3, channel_reason = ?4, channel_retry_at = ?5 WHERE id = ?1").run(gateId, since, failures, failure.reason, failure.retryAt);
    appendEvent(db, { source: "daemon", kind: "gate.channel_failed", runId: gate.run_id, taskId: gate.task_id, payload: { gate: gateId, failures, reason: failure.reason, retry_at: failure.retryAt }, ts: failure.now });
    const degraded = failures >= MIN_FAILURES && failure.now - since >= failure.alertMs;
    // One item per failing episode: a dismissed one stays dismissed until the channel recovers or stops being polled.
    if (!degraded || gate.channel_item != null) return null;
    const event = appendEvent(db, { source: "daemon", kind: "gate.channel_degraded", runId: gate.run_id, taskId: gate.task_id, payload: { gate: gateId, since, failures, reason: failure.reason }, ts: failure.now });
    const line =
      `Review page not delivering answers: ${channelHint(failure.reason, gate.page_path)}. ` +
      `${gate.task_id} (${gate.stage} gate ${gateId}) since ${clock(since)}, ${failures} failed polls: ${failure.reason}; ` +
      `Flowryn retries by itself. Until then answer through the leader (flowryn decide)`;
    const item = openItem(db, { kind: "review_channel", eventSeq: event.seq, taskId: gate.task_id, runId: gate.run_id, line, now: failure.now });
    db.query("UPDATE gates SET channel_item = ?2 WHERE id = ?1").run(gateId, item);
    return item;
  });
}

/**
 * The gate's poll listens (still running a while after it started) or delivered: written only
 * when that is news (never seen healthy, or failing), and resolves the gate's channel item.
 */
export function recordChannelOk(db: Db, gateId: string, via: "listening" | "delivered", now: number): boolean {
  return tx(db, () => {
    const gate = channelGate(db, gateId);
    if (!gate) return false;
    const recovered = gate.channel_failing_since != null;
    if (!recovered && gate.channel_ok_at != null) return false;
    db.query("UPDATE gates SET channel_ok_at = ?2, channel_failing_since = NULL, channel_failures = 0, channel_reason = NULL, channel_retry_at = NULL, channel_item = NULL WHERE id = ?1").run(gateId, now);
    appendEvent(db, { source: "daemon", kind: "gate.channel_ok", runId: gate.run_id, taskId: gate.task_id, payload: { gate: gateId, via, recovered }, ts: now });
    const item = gate.channel_item;
    if (item && itemOpen(db, item)) {
      db.query("UPDATE items SET state = 'resolved', resolved_by = ?2, resolved_at = ?3 WHERE id = ?1").run(item, `gate.channel_ok ${gateId}`, now);
    }
    return true;
  });
}

/**
 * Clear the channel of every gate the poller no longer polls (closed, its run ended, the Lavish
 * session ended, or no lavish-axi): a channel nobody listens on is not degraded, so its failure
 * columns are cleared (its last healthy time kept) and its item resolves.
 */
export function clearUnpolledChannels(db: Db, polled: ReadonlySet<string>, why: (gateId: string) => string, now: number): string[] {
  const failing = db
    .query(
      `SELECT g.id, g.run_id, r.task_id, g.channel_item FROM gates g JOIN runs r ON r.id = g.run_id
       WHERE g.channel_failing_since IS NOT NULL
          OR EXISTS (SELECT 1 FROM items i WHERE i.id = g.channel_item AND i.state IN ('open','presented'))`,
    )
    .all() as { id: string; run_id: string; task_id: string; channel_item: string | null }[];
  const cleared: string[] = [];
  for (const gate of failing) {
    if (polled.has(gate.id)) continue;
    const reason = why(gate.id);
    tx(db, () => {
      const item = itemOpen(db, gate.channel_item) ? gate.channel_item : null;
      if (item) db.query("UPDATE items SET state = 'resolved', resolved_by = ?2, resolved_at = ?3 WHERE id = ?1").run(item, `gate.channel_cleared ${gate.id}`, now);
      db.query("UPDATE gates SET channel_failing_since = NULL, channel_failures = 0, channel_reason = NULL, channel_retry_at = NULL, channel_item = NULL WHERE id = ?1").run(gate.id);
      appendEvent(db, { source: "daemon", kind: "gate.channel_cleared", runId: gate.run_id, taskId: gate.task_id, payload: { gate: gate.id, item, why: reason }, ts: now });
    });
    cleared.push(gate.id);
  }
  return cleared;
}

/** The channel segment of an open review gate's `show` line; empty when the channel was never seen. */
export function channelView(gate: ChannelColumns, isItemOpen: (itemId: string) => boolean): string {
  if (gate.channel_failing_since != null) {
    const down = gate.channel_item != null;
    const failures = gate.channel_failures ?? 0;
    const reason = gate.channel_reason ? ` (${sanitizeLine(gate.channel_reason, MAX_REASON_CHARS)})` : "";
    const next = gate.channel_retry_at != null ? `; next try ${clock(gate.channel_retry_at)}` : "";
    return `; channel: ${down ? "DOWN" : "failing"} since ${clock(gate.channel_failing_since)}, ${failures} failed poll${failures === 1 ? "" : "s"}${reason}${next}${down ? `; item ${gate.channel_item}${isItemOpen(gate.channel_item!) ? "" : " (dismissed)"}` : ""}`;
  }
  if (gate.channel_ok_at != null) return `; channel: listening since ${clock(gate.channel_ok_at)}`;
  return "";
}
