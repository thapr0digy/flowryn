import { findOpenItem, openItem, resolveItems } from "../attention/items.ts";
import type { Db } from "../db/db.ts";
import { getMeta, setMeta } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { sanitizeLine } from "../util/sanitize.ts";

/**
 * The Claude usage limit (design sections 11 and 16): a Claude turn that ends
 * in StopFailure with error `rate_limit` (the documented error type for a
 * claude.ai usage limit) pauses every Claude launch and grant, and a P1 says
 * so. Claude's own Notification `quota_auto_resume_fired` (it continued
 * after the reset), or any later Claude turn that ends normally, proves usage
 * is available again and lifts the pause. Autonomy pauses with it.
 *
 * No hook input carries the reset time, so the pause expires after a backoff
 * (`[sched] usage_backoff_ms`, 15 min, doubling on each re-arm up to
 * `usage_backoff_max_ms`, 2 h). Once it expires, exactly one Claude run is let
 * through as a probe: its normal Stop lifts the pause, another rate_limit
 * re-arms it with the next backoff. `flowryn capacity resume --harness claude`
 * lifts it at once.
 */

const KEY = "claude_usage_limit";

export const RESUME_COMMAND = "flowryn capacity resume --harness claude";

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

/** Whether a Claude start may go now: no pause, the one probe after expiry, or not yet. */
export type UsageGate = "open" | "probe" | "paused";

export function usagePause(db: Db): UsagePause | null {
  const raw = getMeta(db, KEY);
  return raw ? (JSON.parse(raw) as UsagePause) : null;
}

export function usageLimitSince(db: Db): number | null {
  return usagePause(db)?.since ?? null;
}

function savePause(db: Db, pause: UsagePause | null): void {
  setMeta(db, KEY, pause ? JSON.stringify(pause) : "");
}

function clock(t: number): string {
  return new Date(t).toTimeString().slice(0, 5);
}

function pauseLine(pause: UsagePause): string {
  return `Claude usage limit reached (${pause.who}); Claude launches and stage starts pause until ${clock(pause.until)}, then one run probes it; ${RESUME_COMMAND} lifts it now`;
}

/** A probe is out while its run is alive and younger than the backoff; a dead or finished probe frees the slot for another. */
function probeOut(db: Db, pause: UsagePause, now: number): boolean {
  if (!pause.probe || now - pause.probe.at >= pause.backoff_ms) return false;
  const run = db.query("SELECT state, liveness FROM runs WHERE id = ?1").get(pause.probe.run) as { state: string; liveness: string } | null;
  return run !== null && !["cleaned", "failed", "cancelled"].includes(run.state) && run.liveness !== "dead";
}

/** May this Claude run (null: one not created yet) start now? */
export function usageGate(db: Db, now: number, runId: string | null): UsageGate {
  const pause = usagePause(db);
  if (!pause) return "open";
  if (now < pause.until) return "paused";
  if (runId !== null && pause.probe?.run === runId) return "open";
  return probeOut(db, pause, now) ? "paused" : "probe";
}

/** This run is the probe after the pause expired. Call inside the transaction that starts it. */
export function claimProbe(db: Db, runId: string, now: number): void {
  const pause = usagePause(db);
  if (!pause) return;
  savePause(db, { ...pause, probe: { run: runId, at: now } });
  appendEvent(db, { source: "daemon", kind: "sched.usage_probe", runId, payload: { paused_ms: now - pause.since, backoff_ms: pause.backoff_ms }, ts: now });
}

/**
 * A Claude turn hit the usage limit. Call inside a transaction; true when
 * this started the pause or re-armed an expired one with the next backoff.
 */
export function noteUsageLimit(db: Db, who: string, detail: string, now: number, backoff: UsageBackoff): boolean {
  const current = usagePause(db);
  if (current && now < current.until) return false;
  const backoffMs = current ? Math.min(current.backoff_ms * 2, backoff.usage_backoff_max_ms) : Math.min(backoff.usage_backoff_ms, backoff.usage_backoff_max_ms);
  const pause: UsagePause = { since: current?.since ?? now, until: now + backoffMs, backoff_ms: backoffMs, who: sanitizeLine(who, 60), probe: null };
  savePause(db, pause);
  const event = appendEvent(db, { source: "hook", kind: "sched.usage_limit", payload: { who, detail, until: pause.until, backoff_ms: backoffMs, rearmed: current !== null }, ts: now });
  const open = findOpenItem(db, "usage_limit", null);
  if (open) db.query("UPDATE items SET line = ?2 WHERE id = ?1").run(open.id, sanitizeLine(pauseLine(pause)));
  else openItem(db, { kind: "usage_limit", eventSeq: event.seq, line: pauseLine(pause), now });
  return true;
}

/** Usage is available again. Call inside a transaction; true when this lifted the pause. */
export function clearUsageLimit(db: Db, why: string, now: number, source: "hook" | "cli" = "hook"): boolean {
  const pause = usagePause(db);
  if (!pause) return false;
  savePause(db, null);
  appendEvent(db, { source, kind: "sched.usage_resumed", payload: { why, paused_ms: now - pause.since }, ts: now });
  resolveItems(db, "usage_limit", null, `usage resumed: ${why}`, now);
  return true;
}
