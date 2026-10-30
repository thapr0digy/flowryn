import { appendFileSync } from "node:fs";
import type { FlowrynConfig } from "../config/config.ts";
import { FlowrynError } from "../api/errors.ts";
import { leaderTiming, notifyConfig, type NotifyConfig } from "../config/leader.ts";
import type { Db } from "../db/db.ts";
import { getMeta, setMeta, tx } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { scopeIds, taskScope } from "../leader/scope.ts";
import { runBounded } from "../runtime/bounded.ts";
import { scrubbedEnv } from "../runtime/child-env.ts";
import type { HerdrRuntime } from "../runtime/herdr/runtime.ts";
import { redactSecrets } from "../util/redact.ts";
import { sanitizeLine } from "../util/sanitize.ts";
import { getAway } from "./away.ts";

/**
 * OS and Herdr notifications (design section 9): a P0 at once, coalesced
 * within p0_coalesce_s and repeated after p0_renotify_min while unresolved;
 * at most one batched non-P0 notification per min_interval_min for new
 * actionable P1 items and for actionable items open over a day (once a day);
 * never one for P2. A non-blocking worker question, and what you sent from
 * a review page, are not notified: the leader is woken with them instead (a
 * blocking question is a P0, notified at once).
 * Each send is a notifications row and an event.
 *
 * `[notify] command` (docs/notes/2026-10-25-notifications-that-reach-6f.md)
 * reaches you off the Mac: a shell command of yours, run for every P0 send
 * and, while you are away, for the batched one, with the text on stdin and
 * never in its command line. Each run is a `notification.command` event.
 *
 * A review page's pass code (sendPassCode) goes straight to the macOS
 * notification and the notify command, never through an item, a
 * notifications row, an event or the log, and never to Herdr: a worker can
 * read all of those (docs/notes/2026-10-30-pass-a-review-c6.md).
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
  /** The environment the notify command starts from (scrubbed): the daemon's. */
  env?: NodeJS.ProcessEnv;
  /** Where the notify command runs: the Flowryn home. */
  cwd?: string;
  /** `macos` is a recorder (FLOWRYN_NOTIFIER=record:), which a pass code still reaches with notifications off (the tests' seam). */
  macosRecords?: boolean;
}

interface Pending {
  id: string;
  lane: string;
  line: string;
  task_id: string | null;
  run_id: string | null;
}

/** One item as the notify command reads it: its line already carries the scope label. */
export interface CommandItem {
  id: string;
  lane: string;
  line: string;
}

export type NotifyKind = "p0" | "batch";

/** What the notify command is told: one send, or `flowryn notify test`'s sample. */
export interface CommandMessage {
  kind: NotifyKind | "test" | "pass_code";
  notification: string | null;
  away: boolean;
  title: string;
  items: CommandItem[];
}

export interface CommandOutcome {
  /** The command's exit code; 124 when it was ended at its deadline, 127 when it could not start. */
  code: number;
  timedOut: boolean;
  /** The start of its stderr, one line, secrets blanked. */
  stderr: string;
}

interface Send {
  id: string;
  kind: NotifyKind;
  channels: string[];
  title: string;
  text: string;
  message: CommandMessage;
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

/** The command's stdin: the title, then `<item> <lane> <line>` for every item; the text leaves this machine, so secrets are blanked. */
export function commandInput(message: CommandMessage): string {
  const lines = [message.title, ...message.items.map((i) => `${i.id} ${i.lane} ${i.line}`)];
  return redactSecrets(`${lines.join("\n")}\n`);
}

/** The command's environment: the scrubbed base, plus ids and kinds only (item text is never in it). */
export function commandEnv(base: NodeJS.ProcessEnv, message: CommandMessage): Record<string, string> {
  return {
    ...scrubbedEnv(base),
    FLOWRYN_NOTIFY_ID: message.notification ?? "",
    FLOWRYN_NOTIFY_KIND: message.kind,
    FLOWRYN_NOTIFY_AWAY: message.away ? "1" : "0",
    FLOWRYN_NOTIFY_ITEMS: message.items.map((i) => i.id).join(" "),
    FLOWRYN_NOTIFY_TITLE: message.title,
  };
}

const COMMAND_STDERR_CHARS = 300;
const COMMAND_OUTPUT_BYTES = 64 * 1024;

/** Run `[notify] command` once through /bin/sh, bounded (src/runtime/bounded.ts): its whole group is ended at the deadline. */
export async function runNotifyCommand(command: string, timeoutMs: number, message: CommandMessage, opts: { env: NodeJS.ProcessEnv; cwd?: string }): Promise<CommandOutcome> {
  const result = await runBounded(["/bin/sh", "-c", command], {
    label: "notify command",
    timeoutMs,
    stdin: commandInput(message),
    env: commandEnv(opts.env, message),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    maxOutputBytes: COMMAND_OUTPUT_BYTES,
  });
  return { code: result.code, timedOut: result.timedOut, stderr: sanitizeLine(redactSecrets(result.stderr), COMMAND_STDERR_CHARS) };
}

/** The `notification.command` event for one run of the command. Call inside a transaction. */
export function recordCommandRun(db: Db, message: CommandMessage, outcome: CommandOutcome, now: number): void {
  appendEvent(db, {
    source: "daemon",
    kind: "notification.command",
    payload: { notification: message.notification, kind: message.kind, ok: outcome.code === 0, code: outcome.code, timed_out: outcome.timedOut, stderr: outcome.stderr },
    ts: now,
  });
}

/** `flowryn notify test`'s sample: it names no item. */
export function testMessage(away: boolean): CommandMessage {
  return { kind: "test", notification: null, away, title: "Flowryn: test notification", items: [{ id: "-", lane: "P0", line: "flowryn notify test: if you read this, the notify command reaches you" }] };
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
      for (const send of plan) await this.deliver(send);
    } catch (error) {
      this.deps.log(`notify: ${(error as Error).stack ?? String(error)}`);
    } finally {
      this.sending = false;
    }
  }

  /**
   * `flowryn notify test`: run the command once with a sample, the way a
   * send would (same environment, cwd and deadline). Refuses with
   * notifications off or no command; the run is a `notification.command` event.
   */
  async testCommand(): Promise<{ message: CommandMessage; outcome: CommandOutcome }> {
    if (this.deps.off?.()) throw new FlowrynError("not_supported", "notifications are off (FLOWRYN_NOTIFY=off or FLOWRYN_NOTIFIER=null): the notify command never runs");
    const cfg = notifyConfig(this.deps.config());
    if (cfg.command === "") throw new FlowrynError("not_configured", "[notify] command is not set", "set [notify] command in config.toml, then reload it (SIGHUP to the daemon, or flowryn daemon restart)");
    const { db } = this.deps;
    const message = testMessage(getAway(db, this.deps.now()) !== null);
    const outcome = await this.runCommand(cfg, message);
    tx(db, () => recordCommandRun(db, message, outcome, this.deps.now()));
    return { message, outcome };
  }

  /**
   * Send a review page's pass code to you: the macOS notification (when
   * `[notify] macos`) and the notify command (when set, whether or not you are
   * away). Returns the channels it reached; none with notifications off, except
   * a recorder. The code is in the text only: not logged, not stored.
   */
  async sendPassCode(gate: string, title: string, text: string): Promise<string[]> {
    if (this.deps.off?.()) {
      if (!this.deps.macosRecords || !this.deps.macos) return [];
      await this.deps.macos(title, text);
      return ["macos"];
    }
    const cfg = notifyConfig(this.deps.config());
    const reached: string[] = [];
    if (cfg.macos) {
      try {
        await (this.deps.macos ?? osascriptNotify)(title, text);
        reached.push("macos");
      } catch (error) {
        this.deps.log(`notify: macos failed for gate ${gate}'s pass code: ${(error as Error).message.replace(text, "<text>")}`);
      }
    }
    if (cfg.command !== "") {
      const message: CommandMessage = { kind: "pass_code", notification: null, away: getAway(this.deps.db, this.deps.now()) !== null, title, items: [{ id: gate, lane: "P1", line: text }] };
      const outcome = await this.runCommand(cfg, message);
      // Its stderr is not kept: a command that echoes its input would put the code in an event.
      tx(this.deps.db, () => recordCommandRun(this.deps.db, message, { ...outcome, stderr: "" }, this.deps.now()));
      if (outcome.code === 0) reached.push("command");
      else this.deps.log(`notify: command failed for gate ${gate}'s pass code: ${outcome.timedOut ? "timed out" : `exit ${outcome.code}`}`);
    }
    return reached;
  }

  /** In one transaction: pick what is due, record it as sent, and return what to deliver. */
  private plan(): Send[] {
    const { db } = this.deps;
    const cfg = notifyConfig(this.deps.config());
    const always = [...(cfg.macos ? ["macos"] : []), ...(cfg.herdr && this.deps.runtime() ? ["herdr"] : [])];
    const command = cfg.command !== "" ? ["command"] : [];
    const now = this.deps.now();
    const ageMs = leaderTiming(this.deps.config()).age_ms;
    const label = scopeLabeler(db, this.deps.config());
    return tx(db, () => {
      const away = getAway(db, now) !== null;
      const channels: Record<NotifyKind, string[]> = { p0: [...always, ...command], batch: [...always, ...(away ? command : [])] };
      const sends: Send[] = [];
      const p0 = channels.p0.length === 0 ? [] : (db
        .query(
          `SELECT id, lane, line, task_id, run_id FROM items WHERE lane = 'P0' AND class = 'actionable' AND state IN ('open','presented')
             AND (last_notified_at IS NULL OR last_notified_at <= ?1) ORDER BY opened_at`,
        )
        .all(now - cfg.p0_renotify_min * 60_000) as Pending[]);
      const lastP0 = lastSent(db, "p0");
      if (p0.length > 0 && (lastP0 === null || now - lastP0 >= cfg.p0_coalesce_s * 1_000)) {
        sends.push(this.record(p0, "p0", channels.p0, `Flowryn: ${p0.length === 1 ? "a P0 needs you" : `${p0.length} P0s need you`}`, now, away, label));
      }
      const batch = channels.batch.length === 0 ? [] : (db
        .query(
          `SELECT id, lane, line, task_id, run_id FROM items WHERE lane = 'P1' AND class = 'actionable' AND state IN ('open','presented') AND kind NOT IN ('worker_question','review_feedback','review_summary')
             AND (last_notified_at IS NULL OR (opened_at <= ?1 AND last_notified_at <= ?2)) ORDER BY opened_at`,
        )
        .all(now - ageMs, now - DAY_MS) as Pending[]);
      const lastBatch = lastSent(db, "batch");
      if (batch.length > 0 && (lastBatch === null || now - lastBatch >= cfg.min_interval_min * 60_000)) {
        sends.push(this.record(batch, "batch", channels.batch, `Flowryn: ${batch.length === 1 ? "1 item needs you" : `${batch.length} items need you`}`, now, away, label));
      }
      return sends;
    });
  }

  private record(items: Pending[], kind: NotifyKind, channels: string[], title: string, now: number, away: boolean, label: (item: Pending) => string): Send {
    const { db } = this.deps;
    const id = nextNotificationId(db);
    const ids = items.map((i) => i.id);
    db.query("INSERT INTO notifications (id, item_ids, channel, sent_at) VALUES (?1, ?2, ?3, ?4)").run(id, JSON.stringify(ids), `${kind}:${channels.join("+")}`, now);
    for (const item of ids) db.query("UPDATE items SET last_notified_at = ?2 WHERE id = ?1").run(item, now);
    appendEvent(db, { source: "daemon", kind: "notification.sent", payload: { notification: id, kind, items: ids, channels }, ts: now });
    const lines = items.map((i) => ({ id: i.id, lane: i.lane, line: `${label(i)}${i.line}` }));
    return { id, kind, channels, title, text: summary(items, label), message: { kind, notification: id, away, title, items: lines } };
  }

  private async deliver(send: Send): Promise<void> {
    if (this.deps.off?.()) return;
    for (const channel of send.channels) {
      try {
        if (channel === "macos") await (this.deps.macos ?? osascriptNotify)(send.title, send.text);
        else if (channel === "herdr") await this.deps.runtime()?.notify(send.title, send.text);
        else await this.deliverCommand(send.message);
      } catch (error) {
        this.deps.log(`notify: ${channel} failed: ${(error as Error).message}`);
      }
    }
  }

  private async deliverCommand(message: CommandMessage): Promise<void> {
    const outcome = await this.runCommand(notifyConfig(this.deps.config()), message);
    const { db } = this.deps;
    tx(db, () => recordCommandRun(db, message, outcome, this.deps.now()));
    if (outcome.code !== 0) this.deps.log(`notify: command failed for ${message.notification}: ${outcome.timedOut ? "timed out" : `exit ${outcome.code}`}${outcome.stderr ? `: ${outcome.stderr}` : ""}`);
  }

  private runCommand(cfg: NotifyConfig, message: CommandMessage): Promise<CommandOutcome> {
    return runNotifyCommand(cfg.command, cfg.command_timeout_s * 1_000, message, { env: this.deps.env ?? process.env, ...(this.deps.cwd ? { cwd: this.deps.cwd } : {}) });
  }
}
