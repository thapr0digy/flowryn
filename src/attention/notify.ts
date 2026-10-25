import { appendFileSync } from "node:fs";
import type { FlowrynConfig } from "../config/config.ts";
import { leaderTiming, notifyConfig } from "../config/leader.ts";
import type { Db } from "../db/db.ts";
import { getMeta, setMeta, tx } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import type { HerdrRuntime } from "../runtime/herdr/runtime.ts";
import { scopeIds, taskScope } from "../leader/scope.ts";

/**
 * OS and Herdr notifications (design section 9): a P0 at once, coalesced
 * within p0_coalesce_s and repeated after p0_renotify_min while unresolved;
 * at most one batched non-P0 notification per min_interval_min for new
 * actionable P1 items and for actionable items open over a day (once a day);
 * never one for P2. A non-blocking worker question, and what you sent from
 * a review page, are not notified: the leader is woken with them instead (a
 * blocking question is a P0, notified at once).
 * Each send is a notifications row and an event.
 */

export type MacNotify = (title: string, body: string) => Promise<void>;

export interface NotifyDeps {
  db: Db;
  config(): FlowrynConfig;
  runtime(): HerdrRuntime | null;
  now(): number;
  log(message: string): void;
  /** macOS delivery; tests replace it. */
  macos?: MacNotify;
  /** The FLOWRYN_NOTIFY=off override: decisions are still recorded, nothing is delivered. */
  off?(): boolean;
}

interface Pending {
  id: string;
  lane: string;
  line: string;
  task_id: string | null;
  run_id: string | null;
}

const DAY_MS = 86_400_000;

/** macOS: `display notification` with the text passed as arguments, never spliced into the script. */
export const osascriptNotify: MacNotify = async (title, body) => {
  const proc = Bun.spawn(
    ["/usr/bin/osascript", "-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body],
    { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  const timer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`osascript exited ${code}: ${stderr.trim().slice(0, 200)}`);
};

/** A macOS channel that appends to a file instead of notifying (FLOWRYN_NOTIFIER=record:<path>, the tests' seam). */
export function recordingNotify(path: string): MacNotify {
  return async (title, body) => {
    appendFileSync(path, `${JSON.stringify({ title, body, at: Date.now() })}\n`);
  };
}

function nextNotificationId(db: Db): string {
  const next = Number(getMeta(db, "next_notification_no") ?? "1");
  setMeta(db, "next_notification_no", String(next + 1));
  return `n${next}`;
}

function lastSent(db: Db, kind: "p0" | "batch"): number | null {
  const row = db.query("SELECT MAX(sent_at) AS at FROM notifications WHERE channel LIKE ?1").get(`${kind}:%`) as { at: number | null };
  return row.at;
}

/**
 * The notification text. Notifications reach you, not a model, so they cover every scope; with more
 * than one scope each names the scope of its first item (docs/notes/2026-10-24-leader-scoping-and-vj.md).
 */
function summary(items: Pending[], label: (item: Pending) => string): string {
  const first = items[0]!;
  const line = `${label(first)}${first.line}`;
  return items.length === 1 ? line : `${line} (+${items.length - 1} more: flowryn board)`;
}

/** "[work] " for an item of the work scope, when config has more than one scope; "" otherwise. */
function scopeLabeler(db: Db, config: FlowrynConfig): (item: Pending) => string {
  if (scopeIds(config).length < 2) return () => "";
  return (item) => {
    const taskId = item.task_id ?? (item.run_id ? ((db.query("SELECT task_id FROM runs WHERE id = ?1").get(item.run_id) as { task_id: string } | null)?.task_id ?? null) : null);
    const scope = taskId ? taskScope(db, config, taskId) : null;
    return scope && scope !== "global" ? `[${scope}] ` : "";
  };
}

export class NotifyPump {
  private readonly deps: NotifyDeps;
  private sending = false;

  constructor(deps: NotifyDeps) {
    this.deps = deps;
  }

  /** Decide and send what is due now. Never throws: a failed channel is logged. */
  async tick(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      const plan = this.plan();
      for (const send of plan) await this.deliver(send.channels, send.title, send.text);
    } catch (error) {
      this.deps.log(`notify: ${(error as Error).stack ?? String(error)}`);
    } finally {
      this.sending = false;
    }
  }

  /** In one transaction: pick what is due, record it as sent, and return what to deliver. */
  private plan(): { channels: string[]; title: string; text: string }[] {
    const { db } = this.deps;
    const cfg = notifyConfig(this.deps.config());
    const channels = [...(cfg.macos ? ["macos"] : []), ...(cfg.herdr && this.deps.runtime() ? ["herdr"] : [])];
    if (channels.length === 0) return [];
    const now = this.deps.now();
    const ageMs = leaderTiming(this.deps.config()).age_ms;
    const label = scopeLabeler(db, this.deps.config());
    return tx(db, () => {
      const sends: { channels: string[]; title: string; text: string }[] = [];
      const p0 = db
        .query(
          `SELECT id, lane, line, task_id, run_id FROM items WHERE lane = 'P0' AND class = 'actionable' AND state IN ('open','presented')
             AND (last_notified_at IS NULL OR last_notified_at <= ?1) ORDER BY opened_at`,
        )
        .all(now - cfg.p0_renotify_min * 60_000) as Pending[];
      const lastP0 = lastSent(db, "p0");
      if (p0.length > 0 && (lastP0 === null || now - lastP0 >= cfg.p0_coalesce_s * 1_000)) {
        sends.push(this.record(p0, "p0", channels, `Flowryn: ${p0.length === 1 ? "a P0 needs you" : `${p0.length} P0s need you`}`, now, label));
      }
      const batch = db
        .query(
          `SELECT id, lane, line, task_id, run_id FROM items WHERE lane = 'P1' AND class = 'actionable' AND state IN ('open','presented') AND kind NOT IN ('worker_question','review_feedback')
             AND (last_notified_at IS NULL OR (opened_at <= ?1 AND last_notified_at <= ?2)) ORDER BY opened_at`,
        )
        .all(now - ageMs, now - DAY_MS) as Pending[];
      const lastBatch = lastSent(db, "batch");
      if (batch.length > 0 && (lastBatch === null || now - lastBatch >= cfg.min_interval_min * 60_000)) {
        sends.push(this.record(batch, "batch", channels, `Flowryn: ${batch.length === 1 ? "1 item needs you" : `${batch.length} items need you`}`, now, label));
      }
      return sends;
    });
  }

  private record(items: Pending[], kind: "p0" | "batch", channels: string[], title: string, now: number, label: (item: Pending) => string) {
    const { db } = this.deps;
    const id = nextNotificationId(db);
    const ids = items.map((i) => i.id);
    db.query("INSERT INTO notifications (id, item_ids, channel, sent_at) VALUES (?1, ?2, ?3, ?4)").run(id, JSON.stringify(ids), `${kind}:${channels.join("+")}`, now);
    for (const item of ids) db.query("UPDATE items SET last_notified_at = ?2 WHERE id = ?1").run(item, now);
    appendEvent(db, { source: "daemon", kind: "notification.sent", payload: { notification: id, kind, items: ids, channels }, ts: now });
    return { channels, title, text: summary(items, label) };
  }

  private async deliver(channels: string[], title: string, text: string): Promise<void> {
    if (this.deps.off?.()) return;
    for (const channel of channels) {
      try {
        if (channel === "macos") await (this.deps.macos ?? osascriptNotify)(title, text);
        else await this.deps.runtime()?.notify(title, text);
      } catch (error) {
        this.deps.log(`notify: ${channel} failed: ${(error as Error).message}`);
      }
    }
  }
}
