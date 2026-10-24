import { findOpenItem, itemLines, openItem, resolveItems } from "../attention/items.ts";
import type { Db } from "../db/db.ts";
import { getMeta, setMeta } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { sanitizeLine } from "../util/sanitize.ts";

/**
 * The usage limit, per account (design sections 11 and 16;
 * docs/notes/2026-10-22-multiple-ai-provider-u9.md): a Claude turn that ends
 * in StopFailure with error `rate_limit` (the documented error type for a
 * claude.ai usage limit) pauses every launch and grant on that turn's
 * account, and a P1 says so; other accounts carry on. Claude's own
 * Notification `quota_auto_resume_fired` (it continued after the reset), or
 * any later turn on the account that ends normally, proves usage is available
 * again and lifts the pause. Autonomy on the account pauses with it.
 *
 * No hook input carries the reset time, so the pause expires after a backoff
 * (`[sched] usage_backoff_ms`, 15 min, doubling on each re-arm up to
 * `usage_backoff_max_ms`, 2 h). Once it expires, exactly one run on the
 * account is let through as a probe: its normal Stop lifts the pause, another
 * rate_limit re-arms it with the next backoff. `flowryn capacity resume
 * --account <id>` lifts it at once.
 */

const PREFIX = "usage_limit:";
/** Before accounts, one Claude pause for the whole home (moved by legacy.ts). */
export const LEGACY_KEY = "claude_usage_limit";

/** The account an item about its capacity is keyed by (items.task_id). */
export function accountKey(account: string): string {
  return `account:${account}`;
}

export function resumeCommand(account: string): string {
  return `flowryn capacity resume --account ${account}`;
}

export interface UsageBackoff {
  usage_backoff_ms: number;
  usage_backoff_max_ms: number;
}

export interface UsagePause {
  since: number;
  /** The pause expires here; after it, one probe may start. */
  until: number;
  backoff_ms: number;
  who: string;
  /** The run let through after expiry, and when. */
  probe: { run: string; at: number } | null;
}

/** Whether a start on the account may go now: no pause, the one probe after expiry, or not yet. */
export type UsageGate = "open" | "probe" | "paused";

export function usagePause(db: Db, account: string): UsagePause | null {
  const raw = getMeta(db, `${PREFIX}${account}`);
  return raw ? (JSON.parse(raw) as UsagePause) : null;
}

/** Every account's pause, by account id. */
export function usagePauses(db: Db): Map<string, UsagePause> {
  const rows = db.query("SELECT key, value FROM meta WHERE key LIKE 'usage_limit:%' AND value != '' ORDER BY key").all() as { key: string; value: string }[];
  return new Map(rows.map((r) => [r.key.slice(PREFIX.length), JSON.parse(r.value) as UsagePause]));
}

function savePause(db: Db, account: string, pause: UsagePause | null): void {
  setMeta(db, `${PREFIX}${account}`, pause ? JSON.stringify(pause) : "");
}

function clock(t: number): string {
  return new Date(t).toTimeString().slice(0, 5);
}

function pauseLine(account: string, pause: UsagePause): string {
  return `Account ${account}: usage limit reached (${pause.who}); launches and stage starts on ${account} pause until ${clock(pause.until)}, then one run probes it; ${resumeCommand(account)} lifts it now`;
}

/** A probe is out while its run is alive and younger than the backoff; a dead or finished probe frees the slot for another. */
function probeOut(db: Db, pause: UsagePause, now: number): boolean {
  if (!pause.probe || now - pause.probe.at >= pause.backoff_ms) return false;
  const run = db.query("SELECT state, liveness FROM runs WHERE id = ?1").get(pause.probe.run) as { state: string; liveness: string } | null;
  return run !== null && !["cleaned", "failed", "cancelled"].includes(run.state) && run.liveness !== "dead";
}

/** May this run (null: one not created yet) start on the account now? */
export function usageGate(db: Db, now: number, account: string, runId: string | null): UsageGate {
  const pause = usagePause(db, account);
  if (!pause) return "open";
  if (now < pause.until) return "paused";
  if (runId !== null && pause.probe?.run === runId) return "open";
  return probeOut(db, pause, now) ? "paused" : "probe";
}

/** The accounts whose usage pause holds starts now (not yet expired, or expired with its probe out). */
export function pausedAccounts(db: Db, now: number): string[] {
  return [...usagePauses(db).keys()].filter((a) => usageGate(db, now, a, null) === "paused");
}

/** This run is the account's probe after the pause expired. Call inside the transaction that starts it. */
export function claimProbe(db: Db, account: string, runId: string, now: number): void {
  const pause = usagePause(db, account);
  if (!pause) return;
  savePause(db, account, { ...pause, probe: { run: runId, at: now } });
  appendEvent(db, { source: "daemon", kind: "sched.usage_probe", runId, payload: { account, paused_ms: now - pause.since, backoff_ms: pause.backoff_ms }, ts: now });
}

/**
 * A turn on the account hit the usage limit. Call inside a transaction; true
 * when this started the pause or re-armed an expired one with the next backoff.
 */
export function noteUsageLimit(db: Db, account: string, who: string, detail: string, now: number, backoff: UsageBackoff): boolean {
  const current = usagePause(db, account);
  if (current && now < current.until) return false;
  const backoffMs = current ? Math.min(current.backoff_ms * 2, backoff.usage_backoff_max_ms) : Math.min(backoff.usage_backoff_ms, backoff.usage_backoff_max_ms);
  const pause: UsagePause = { since: current?.since ?? now, until: now + backoffMs, backoff_ms: backoffMs, who: sanitizeLine(who, 60), probe: null };
  savePause(db, account, pause);
  const event = appendEvent(db, { source: "hook", kind: "sched.usage_limit", payload: { account, who, detail, until: pause.until, backoff_ms: backoffMs, rearmed: current !== null }, ts: now });
  const key = accountKey(account);
  const open = findOpenItem(db, "usage_limit", key);
  if (open) {
    const lines = itemLines(pauseLine(account, pause));
    db.query("UPDATE items SET line = ?2, full_line = ?3 WHERE id = ?1").run(open.id, lines.line, lines.full_line);
  } else openItem(db, { kind: "usage_limit", eventSeq: event.seq, taskId: key, line: pauseLine(account, pause), now });
  return true;
}

/** Usage on the account is available again. Call inside a transaction; true when this lifted the pause. */
export function clearUsageLimit(db: Db, account: string, why: string, now: number, source: "hook" | "cli" | "daemon" = "hook"): boolean {
  const pause = usagePause(db, account);
  if (!pause) return false;
  savePause(db, account, null);
  appendEvent(db, { source, kind: "sched.usage_resumed", payload: { account, why, paused_ms: now - pause.since }, ts: now });
  resolveItems(db, "usage_limit", accountKey(account), `usage resumed: ${why}`, now);
  return true;
}
