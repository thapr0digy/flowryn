import { findOpenItem, openItem, resolveItems } from "../attention/items.ts";
import type { Db } from "../db/db.ts";
import { getMeta, setMeta } from "../db/db.ts";
import { appendEvent, type EventSource } from "../db/events.ts";
import { sanitizeLine } from "../util/sanitize.ts";

/**
 * Herdr unreachable (design section 16): detected by socket errors, the
 * event subscription failing to connect or a call refused; dispatch refuses,
 * liveness reads unknown, and launches and the subscription retry with
 * backoff. You hear one P1 per episode. An episode starts at the first failure
 * after Herdr answered (or at startup) and ends when it answers again. Its P1
 * opens once the episode has lasted [herdr] unreachable_alert_ms and something
 * needs Herdr: an open run, or a dispatch, launch or phase it held up. A P1
 * you dismiss is not reopened within the same episode. It resolves when
 * Herdr answers. The episode lives in meta, so a daemon restart mid-outage
 * continues it rather than starting a new one.
 */

const DOWN_SINCE = "herdr_down_since";
const DOWN_DETAIL = "herdr_down_detail";
/** The episode (its start) whose P1 has opened. */
const ALERTED = "herdr_alerted_episode";
/** When something last needed Herdr and was held up by it. */
const NEEDED_AT = "herdr_needed_at";

export interface HerdrEpisode {
  since: number;
  detail: string;
}

export function herdrEpisode(db: Db): HerdrEpisode | null {
  const since = Number(getMeta(db, DOWN_SINCE) ?? "");
  if (!Number.isFinite(since) || since <= 0) return null;
  return { since, detail: getMeta(db, DOWN_DETAIL) ?? "" };
}

/** A socket error: Herdr did not answer. Starts an episode unless one is running. Call inside a transaction. */
export function noteHerdrDown(db: Db, detail: string, source: EventSource, now: number): void {
  if (herdrEpisode(db)) return;
  const reason = sanitizeLine(detail, 120) || "no answer";
  setMeta(db, DOWN_SINCE, String(now));
  setMeta(db, DOWN_DETAIL, reason);
  appendEvent(db, { source, kind: "herdr.unreachable", payload: { detail: reason }, ts: now });
}

/** Something that needs Herdr was held up by it (a dispatch refused, a launch deferred). Call inside a transaction. */
export function noteHerdrNeeded(db: Db, detail: string, source: EventSource, now: number): void {
  noteHerdrDown(db, detail, source, now);
  setMeta(db, NEEDED_AT, String(now));
}

/** Herdr answered: the episode ends and its P1 resolves. Call inside a transaction. Returns whether an episode ended. */
export function noteHerdrUp(db: Db, source: EventSource, now: number): boolean {
  const episode = herdrEpisode(db);
  if (!episode) return false;
  setMeta(db, DOWN_SINCE, "");
  setMeta(db, DOWN_DETAIL, "");
  resolveItems(db, "herdr_unreachable", null, "Herdr answered again", now);
  appendEvent(db, { source, kind: "herdr.reachable", payload: { down_ms: now - episode.since }, ts: now });
  return true;
}

/**
 * Open the episode's one P1 when it is due: the outage has lasted `alertMs`
 * and an open run or a held-up request needs Herdr. Call inside a
 * transaction. Returns the item it opened.
 */
export function alertHerdrIfDue(db: Db, alertMs: number, now: number): string | null {
  const episode = herdrEpisode(db);
  if (!episode || now - episode.since < alertMs) return null;
  if (getMeta(db, ALERTED) === String(episode.since) || findOpenItem(db, "herdr_unreachable", null)) return null;
  const openRuns = (db.query("SELECT COUNT(*) AS n FROM runs WHERE state NOT IN ('cleaned','failed','cancelled')").get() as { n: number }).n;
  const neededAt = Number(getMeta(db, NEEDED_AT) ?? "");
  const heldUp = Number.isFinite(neededAt) && neededAt >= episode.since;
  if (openRuns === 0 && !heldUp) return null;
  setMeta(db, ALERTED, String(episode.since));
  const minutes = Math.max(1, Math.round((now - episode.since) / 60_000));
  const event = appendEvent(db, { source: "reconciler", kind: "herdr.unreachable_alert", payload: { since: episode.since, detail: episode.detail, open_runs: openRuns }, ts: now });
  const runs = openRuns > 0 ? `, ${openRuns} open run(s) read liveness unknown` : "";
  return openItem(db, {
    kind: "herdr_unreachable",
    eventSeq: event.seq,
    line: `Herdr is unreachable for ${minutes}m (${episode.detail}): dispatch is refused${runs}; flowrynd retries with backoff. Check: herdr session list`,
    now,
  });
}
