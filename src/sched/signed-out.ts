import { findOpenItem, openItem, resolveItems } from "../attention/items.ts";
import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { accountKey } from "./usage.ts";

/**
 * A signed-out account (docs/notes/2026-10-22-multiple-ai-provider-u9.md):
 * its runs wait for a launch grant instead of refusing at dispatch, and one
 * P1 per account says how to sign it in, until its sign-in check passes.
 */

/** The account failed its sign-in check. Call inside a transaction; when the episode began. */
export function noteSignedOut(db: Db, account: string, detail: string, login: string, now: number): number {
  const key = accountKey(account);
  const open = findOpenItem(db, "account_signed_out", key);
  if (open) return open.opened_at;
  const event = appendEvent(db, { source: "daemon", kind: "sched.account_signed_out", payload: { account, detail }, ts: now });
  openItem(db, { kind: "account_signed_out", eventSeq: event.seq, taskId: key, line: `Account ${account} is signed out, so its runs wait; sign in with ${login}`, now });
  return now;
}

/** The account passed its sign-in check. Call inside a transaction; true when this closed an episode. */
export function noteSignedIn(db: Db, account: string, now: number): boolean {
  const key = accountKey(account);
  if (!findOpenItem(db, "account_signed_out", key)) return false;
  appendEvent(db, { source: "daemon", kind: "sched.account_signed_in", payload: { account }, ts: now });
  resolveItems(db, "account_signed_out", key, "signed in", now);
  return true;
}

/** The accounts with an open signed-out episode. */
export function signedOutAccounts(db: Db): string[] {
  const rows = db.query("SELECT task_id FROM items WHERE kind = 'account_signed_out' AND state IN ('open','presented') AND task_id LIKE 'account:%' ORDER BY opened_at").all() as { task_id: string }[];
  return [...new Set(rows.map((r) => r.task_id.slice("account:".length)))];
}
