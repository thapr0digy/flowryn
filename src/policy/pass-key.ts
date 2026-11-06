import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";

/**
 * One-click approve (docs/notes/2026-11-05-one-click-approve-3y.md). When the
 * daemon opens a review page in your browser it mints a pass key (32 random
 * bytes) and adds it to the address it hands `open` as `?flowryn_pass=<key>`.
 * Lavish ignores the query, and its sandboxed frame reads the address it was
 * opened from as `document.referrer`, so the page's widget can send the key
 * with Approve. The daemon keeps only the key's SHA-256 on the gate
 * (`pass_key_hash`), never the key: a worker can read flowryn.db, the daemon
 * log, its env and lavish's files, but never the address the daemon opened.
 *
 * A key belongs to the tab (the run and its review URL): a page resubmitted
 * after changes reuses the tab, so its gate takes the earlier gate's hash. A
 * key that reaches the daemon is spent, passed or refused, because the Send
 * carrying it now sits in lavish's files; spending clears the hash on every
 * gate of that tab. A wrong key spends nothing, so a worker cannot spoil the
 * button. Plain code, no model.
 */

export const PASS_KEY_PARAM = "flowryn_pass";
/** 32 random bytes in base64url. */
export const PASS_KEY_LENGTH = 43;
const PASS_KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function mintPassKey(): { key: string; hash: string } {
  const key = randomBytes(32).toString("base64url");
  return { key, hash: hashPassKey(key) };
}

export function hashPassKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** Does the key the page sent match the gate's hash? Constant time over the hashes. */
export function passKeyMatches(hash: string | null, key: string): boolean {
  if (hash === null || !PASS_KEY_SHAPE.test(key)) return false;
  const given = Buffer.from(hashPassKey(key), "hex");
  const kept = Buffer.from(hash, "hex");
  return kept.length === given.length && timingSafeEqual(kept, given);
}

/** The address handed to the browser: the review URL with the key added (a lavish URL carries no query). */
export function keyedUrl(url: string, key: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}${PASS_KEY_PARAM}=${key}`;
}

/** Hide a key in text (an `open` error that echoes its argument). */
export function redactKey(text: string, key: string): string {
  return text.replaceAll(key, "****");
}

/** Spend the key of the gate's tab: clear the hash on every gate of the run with the same review URL. Call inside a transaction. */
export function spendPassKey(db: Db, gateId: string, why: string, now: number): boolean {
  const gate = db.query("SELECT g.run_id, g.review_url, g.pass_key_hash, r.task_id FROM gates g JOIN runs r ON r.id = g.run_id WHERE g.id = ?1").get(gateId) as {
    run_id: string;
    review_url: string | null;
    pass_key_hash: string | null;
    task_id: string;
  } | null;
  if (!gate || gate.pass_key_hash === null) return false;
  const changed = gate.review_url === null
    ? db.query("UPDATE gates SET pass_key_hash = NULL WHERE id = ?1").run(gateId).changes
    : db.query("UPDATE gates SET pass_key_hash = NULL WHERE run_id = ?1 AND review_url = ?2 AND pass_key_hash IS NOT NULL").run(gate.run_id, gate.review_url).changes;
  if (changed === 0) return false;
  appendEvent(db, { source: "daemon", kind: "gate.pass_key_spent", runId: gate.run_id, taskId: gate.task_id, payload: { gate: gateId, why }, ts: now });
  return true;
}
