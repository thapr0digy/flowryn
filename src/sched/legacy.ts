import { defaultAccount } from "../config/accounts.ts";
import type { FlowrynConfig } from "../config/config.ts";
import { getMeta, setMeta, type Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { LEGACY_KEY as LEGACY_QUOTA } from "./quota.ts";
import { accountKey, LEGACY_KEY as LEGACY_USAGE } from "./usage.ts";

/**
 * Before accounts, one Claude quota state and one usage pause covered the
 * whole home (meta claude_quota and claude_usage_limit, and their P1s with no
 * key). They belong to the default Claude account now: moved once, at
 * scheduler start, with an event. A state the account already has wins; the
 * legacy one is dropped. Call inside a transaction; the account it moved to,
 * or null when there was nothing to move.
 */
export function moveLegacyCapacity(db: Db, config: FlowrynConfig, now: number): string | null {
  const quota = getMeta(db, LEGACY_QUOTA);
  const usage = getMeta(db, LEGACY_USAGE);
  const items = db.query("SELECT COUNT(*) AS n FROM items WHERE kind IN ('quota_low','usage_limit') AND task_id IS NULL AND state IN ('open','presented')").get() as { n: number };
  if (!quota && !usage && items.n === 0) return null;
  const account = defaultAccount(config, "claude").id;
  const moved: string[] = [];
  for (const [legacy, value, key] of [
    [LEGACY_QUOTA, quota, `quota:${account}`],
    [LEGACY_USAGE, usage, `usage_limit:${account}`],
  ] as const) {
    if (value === null) continue;
    if (value !== "" && !getMeta(db, key)) {
      setMeta(db, key, value);
      moved.push(key);
    }
    db.query("DELETE FROM meta WHERE key = ?1").run(legacy);
  }
  const rekeyed = db
    .query("UPDATE items SET task_id = ?1 WHERE kind IN ('quota_low','usage_limit') AND task_id IS NULL AND state IN ('open','presented')")
    .run(accountKey(account)).changes;
  appendEvent(db, { source: "daemon", kind: "sched.capacity_moved", payload: { account, moved, items: rekeyed }, ts: now });
  return account;
}
