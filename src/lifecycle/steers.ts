import type { Db } from "../db/db.ts";
import { getMeta, setMeta } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { openItem, resolveRunItems } from "../attention/items.ts";
import type { Timing } from "../config/workers.ts";
import { sanitizeBlock } from "../util/sanitize.ts";
import { taskTitle, type RunRow } from "./runs.ts";

/**
 * Steers to workers (design sections 5, 6 and 12). A steer is a messages row.
 * Hooks and the Pi extension carry it; it is *seen* once it was provably in a
 * model request (Claude: the next PreToolUse, PostToolUse or Stop after the
 * carry, never UserPromptSubmit, which fires before the model reads anything;
 * Pi: the extension's context event), and only the worker's `ack` proves it was acted
 * on. A steer not acknowledged within ring_interval_ms rings again, up to
 * max_rings deliveries in all (the first plus three re-rings), and then opens
 * a P1. A carry known to be lost (an interrupt or a failed turn before it was
 * seen, or an idle carry not seen within seen_timeout_ms) rings again at once.
 */

export interface MessageRow {
  id: string;
  run_id: string;
  body: string;
  created_at: number;
  rings: number;
  last_rung_at: number | null;
  carried_at: number | null;
  acked_at: number | null;
  decision_id: string | null;
  seen_at: number | null;
  /** The latest ring: null before the first, then carried, seen or lost. */
  ring_state: RingState | null;
  /** The latest ring went to an idle worker, so it must be seen within seen_timeout_ms. */
  ring_idle: number;
  /** The hook that marked the latest ring seen, or null. */
  seen_via: string | null;
}

export type RingState = "carried" | "seen" | "lost";

export const MAX_STEER_CHARS = 8_000;

export type RingPath = "post-tool" | "stop" | "waiter" | "extension";

function nextMessageId(db: Db): string {
  const next = Number(getMeta(db, "next_message_no") ?? "1");
  setMeta(db, "next_message_no", String(next + 1));
  return `m${next}`;
}

/** Record a steer. Call inside a transaction; notify the bus after commit. */
export function createSteer(db: Db, run: RunRow, body: string, now: number, decisionId: string | null = null): MessageRow {
  const text = sanitizeBlock(body).trim().slice(0, MAX_STEER_CHARS);
  const id = nextMessageId(db);
  db.query("INSERT INTO messages (id, run_id, body, created_at, decision_id) VALUES (?1, ?2, ?3, ?4, ?5)").run(id, run.id, text, now, decisionId);
  appendEvent(db, { source: "cli", kind: "steer.created", runId: run.id, taskId: run.task_id, payload: { steer: id, decision: decisionId, chars: text.length }, ts: now });
  return getMessage(db, id)!;
}

export function getMessage(db: Db, id: string): MessageRow | null {
  return db.query("SELECT * FROM messages WHERE id = ?1").get(id) as MessageRow | null;
}

export function unackedSteers(db: Db, runId: string): MessageRow[] {
  return db.query("SELECT * FROM messages WHERE run_id = ?1 AND acked_at IS NULL ORDER BY created_at, id").all(runId) as MessageRow[];
}

/**
 * When an unacknowledged steer that has rung becomes due again: a lost carry
 * at once, an idle carry not seen within seen_timeout_ms, and any carry after
 * ring_interval_ms. Null when it is not rung, or out of rings.
 */
function dueAgainAt(m: MessageRow, timing: Timing): number | null {
  if (m.last_rung_at === null || m.rings >= timing.max_rings) return null;
  if (m.ring_state === "lost") return m.last_rung_at;
  const backstop = m.last_rung_at + timing.ring_interval_ms;
  return m.ring_state === "carried" && m.ring_idle === 1 ? Math.min(backstop, m.last_rung_at + timing.seen_timeout_ms) : backstop;
}

/** Steers that should be delivered now: never rung, or due again (above) and still under the cap. */
export function dueSteers(db: Db, runId: string, now: number, timing: Timing): MessageRow[] {
  return unackedSteers(db, runId).filter((m) => m.rings < timing.max_rings && (m.last_rung_at === null || dueAgainAt(m, timing)! <= now));
}

/** When the run's next unacknowledged, not yet due steer becomes due, or null: a waiter wakes for it. */
export function nextDueAt(db: Db, runId: string, timing: Timing): number | null {
  let next: number | null = null;
  for (const m of unackedSteers(db, runId)) {
    const at = dueAgainAt(m, timing);
    if (at !== null && (next === null || at < next)) next = at;
  }
  return next;
}

/** Why a steer rings again: a lost carry, an idle carry nobody saw, or the ring interval. */
function ringReason(m: MessageRow, now: number, timing: Timing): string | null {
  if (m.last_rung_at === null) return null;
  if (m.ring_state === "lost") return "lost";
  if (m.ring_state === "carried" && m.ring_idle === 1 && now - m.last_rung_at < timing.ring_interval_ms) return "unseen";
  return "interval";
}

/**
 * A hook or the extension carried the steer. `idle` says the worker was idle,
 * so the carry must be seen within seen_timeout_ms. Call inside a transaction.
 */
export function markRung(db: Db, message: MessageRow, run: RunRow, path: RingPath, now: number, idle: boolean, timing: Timing): void {
  db.query("UPDATE messages SET rings = rings + 1, last_rung_at = ?2, carried_at = COALESCE(carried_at, ?2), ring_state = 'carried', ring_idle = ?3, seen_via = NULL WHERE id = ?1").run(
    message.id,
    now,
    idle ? 1 : 0,
  );
  const again = ringReason(message, now, timing);
  appendEvent(db, {
    source: "hook",
    kind: "steer.rung",
    runId: run.id,
    taskId: run.task_id,
    payload: { steer: message.id, ring: message.rings + 1, path, idle, ...(again ? { again } : {}) },
    ts: now,
  });
}

/** Carried steers of a run whose latest ring was not seen yet. */
function carriedUnseen(db: Db, runId: string): MessageRow[] {
  return unackedSteers(db, runId).filter((m) => m.ring_state === "carried");
}

/**
 * Carried steers reached a model request: `ids` names them (the Pi extension
 * saw them in its context event), or null means every carried one (a Claude
 * hook after the carry). Call inside a transaction; returns the ids marked.
 */
export function markSeen(db: Db, run: RunRow, ids: string[] | null, via: string, now: number): string[] {
  const marked: string[] = [];
  for (const m of carriedUnseen(db, run.id)) {
    if (ids !== null && !ids.includes(m.id)) continue;
    db.query("UPDATE messages SET ring_state = 'seen', seen_at = COALESCE(seen_at, ?2), seen_via = ?3 WHERE id = ?1").run(m.id, now, via);
    appendEvent(db, {
      source: "hook",
      kind: "steer.seen",
      runId: run.id,
      taskId: run.task_id,
      payload: { steer: m.id, ring: m.rings, via, after_carry_ms: m.last_rung_at === null ? null : now - m.last_rung_at },
      ts: now,
    });
    marked.push(m.id);
  }
  return marked;
}

/**
 * Carried steers that never reached a model request are lost (an interrupt
 * dropped them, or the turn failed first): each rings again at once. Call
 * inside a transaction; returns the ids marked.
 */
export function markLost(db: Db, run: RunRow, reason: string, now: number): string[] {
  const lost = carriedUnseen(db, run.id);
  for (const m of lost) {
    db.query("UPDATE messages SET ring_state = 'lost' WHERE id = ?1").run(m.id);
    appendEvent(db, { source: "daemon", kind: "steer.lost", runId: run.id, taskId: run.task_id, payload: { steer: m.id, ring: m.rings, reason }, ts: now });
  }
  return lost.map((m) => m.id);
}

/**
 * The Pi extension says how it delivered a carried steer: "followUp" to an
 * idle agent (which starts a turn at once, so it must be seen within
 * seen_timeout_ms) or "steer" into a busy one (seen after the current tool
 * batch). Call inside a transaction.
 */
export function noteDeliveryMode(db: Db, run: RunRow, id: string, mode: "steer" | "followUp", now: number): boolean {
  const m = getMessage(db, id);
  if (!m || m.run_id !== run.id || m.ring_state !== "carried") return false;
  db.query("UPDATE messages SET ring_idle = ?2 WHERE id = ?1").run(id, mode === "followUp" ? 1 : 0);
  appendEvent(db, { source: "hook", kind: "steer.delivered", runId: run.id, taskId: run.task_id, payload: { steer: id, ring: m.rings, mode }, ts: now });
  return true;
}

/** One steer's delivery, for `show`: queued, carried, seen or lost, with each step's delay after creation. */
export function steerStatus(m: MessageRow, now: number): string {
  const after = (at: number) => `+${formatMs(at - m.created_at)}`;
  const parts: string[] = [];
  if (m.carried_at !== null) parts.push(`carried ${after(m.carried_at)}`);
  if (m.seen_at !== null) parts.push(`seen ${after(m.seen_at)}`);
  if (m.acked_at !== null) parts.push(`acked ${after(m.acked_at)}`);
  if (m.acked_at === null) {
    if (m.ring_state === null) parts.push(`queued ${formatMs(now - m.created_at)}`);
    else if (m.ring_state === "lost") parts.push("lost, ringing again");
    else if (m.ring_state === "carried") parts.push(`not seen for ${formatMs(now - (m.last_rung_at ?? now))}`);
  }
  return parts.join(", ");
}

/** The fleet's one-word view of a run's oldest unacknowledged steer: "m3 queued", "m3 unseen 12s", "m3 seen", or "-". */
export function steerBrief(db: Db, runId: string, now: number): string {
  const m = unackedSteers(db, runId)[0];
  if (!m) return "-";
  if (m.ring_state === null) return `${m.id} queued ${formatMs(now - m.created_at)}`;
  if (m.ring_state === "seen") return `${m.id} seen, not acked`;
  if (m.ring_state === "lost") return `${m.id} lost, ringing`;
  return `${m.id} unseen ${formatMs(now - (m.last_rung_at ?? now))}`;
}

/** A run's latest steers, oldest first: every unacknowledged one and the last few acknowledged, at most `limit`. */
export function recentSteers(db: Db, runId: string, limit: number): MessageRow[] {
  const rows = db.query("SELECT * FROM messages WHERE run_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2").all(runId, limit) as MessageRow[];
  const shown = new Set(rows.map((m) => m.id));
  const older = unackedSteers(db, runId).filter((m) => !shown.has(m.id));
  return [...older, ...rows.toReversed()];
}

export function formatMs(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.round(ms / 1_000)}s`;
}

/**
 * Steers that used every ring and were still not acknowledged a ring interval
 * after the last: open one P1 per run. Returns the runs that got one.
 */
export function flagUnackedSteers(db: Db, now: number, timing: Timing): string[] {
  const rows = db
    .query(
      `SELECT m.*, r.task_id FROM messages m JOIN runs r ON r.id = m.run_id
       WHERE m.acked_at IS NULL AND m.rings >= ?1 AND m.last_rung_at <= ?2
         AND r.state NOT IN ('cleaned','failed','cancelled')
         AND NOT EXISTS (SELECT 1 FROM items i WHERE i.kind = 'steer_unacked' AND i.run_id = m.run_id AND i.state IN ('open','presented'))`,
    )
    .all(timing.max_rings, now - timing.ring_interval_ms) as (MessageRow & { task_id: string })[];
  const flagged = new Set<string>();
  for (const row of rows) {
    if (flagged.has(row.run_id)) continue;
    flagged.add(row.run_id);
    const event = appendEvent(db, { source: "reconciler", kind: "steer.unacked", runId: row.run_id, taskId: row.task_id, payload: { steer: row.id, rings: row.rings }, ts: now });
    openItem(db, {
      kind: "steer_unacked",
      eventSeq: event.seq,
      taskId: row.task_id,
      runId: row.run_id,
      line: `Steer ${row.id} to the worker on ${taskTitle(db, row.task_id)} was not acknowledged after ${row.rings} rings`,
      now,
    });
  }
  return [...flagged];
}

/** The worker acknowledged a steer. Call inside a transaction. */
export function ackSteer(db: Db, run: RunRow, message: MessageRow, now: number): { already: boolean } {
  if (message.acked_at !== null) return { already: true };
  // An ack proves the steer was read, even when no hook reported it seen first.
  db.query("UPDATE messages SET acked_at = ?2, seen_at = COALESCE(seen_at, ?2), ring_state = CASE WHEN ring_state = 'carried' THEN 'seen' ELSE ring_state END WHERE id = ?1").run(message.id, now);
  const event = appendEvent(db, { source: "cli", kind: "steer.acked", runId: run.id, taskId: run.task_id, payload: { steer: message.id, rings: message.rings }, ts: now });
  if (message.rings > 1) {
    resolveRunItems(db, run.id, ["steer_unacked"], `steer.acked ${message.id}`, now);
    openItem(db, {
      kind: "steer_acked",
      eventSeq: event.seq,
      taskId: run.task_id,
      runId: run.id,
      line: `Steer ${message.id} acknowledged after ${message.rings} rings (${taskTitle(db, run.task_id)})`,
      now,
    });
  }
  return { already: false };
}

type WaitOutcome = "wake" | "timeout" | "superseded";

interface Waiter {
  id: string;
  resolve: (outcome: WaitOutcome) => void;
}

/**
 * In-memory wake-ups for waiters (the Claude asyncRewake waiter and the Pi
 * extension's long poll). The database stays the truth; the bus only says
 * "look again". One waiter per run counts: Claude does not deduplicate async
 * hooks (M0 c01), so a newer waiter (a larger ULID, minted at arm time)
 * supersedes older ones, which exit 0 silently. The latest id survives only
 * in memory, so after a daemon restart the first waiter to reconnect is
 * adopted and any older one that reconnects later is told to exit.
 */
export class SteerBus {
  private readonly waiters = new Map<string, Set<Waiter>>();
  private readonly latest = new Map<string, string>();
  private readonly commands = new Map<string, string>();
  /** Set at daemon shutdown: waiters answer "ask again" at once, and reconnect to the next daemon. */
  closed = false;

  /** Register a waiter; false when a newer one already holds the run. */
  register(runId: string, waiterId: string): boolean {
    const current = this.latest.get(runId);
    if (current && current > waiterId) return false;
    if (current !== waiterId) {
      this.latest.set(runId, waiterId);
      for (const waiter of this.waiters.get(runId) ?? []) if (waiter.id !== waiterId) waiter.resolve("superseded");
    }
    return true;
  }

  isCurrent(runId: string, waiterId: string): boolean {
    return this.latest.get(runId) === waiterId;
  }

  wait(runId: string, waiterId: string, timeoutMs: number): Promise<WaitOutcome> {
    if (this.closed) return Promise.resolve("timeout");
    return new Promise((resolve) => {
      const set = this.waiters.get(runId) ?? new Set<Waiter>();
      this.waiters.set(runId, set);
      const waiter: Waiter = {
        id: waiterId,
        resolve: (outcome) => {
          clearTimeout(timer);
          set.delete(waiter);
          resolve(outcome);
        },
      };
      const timer = setTimeout(() => waiter.resolve("timeout"), timeoutMs);
      set.add(waiter);
    });
  }

  /** Something changed for the run: every waiter re-checks the database. */
  notify(runId: string): void {
    for (const waiter of this.waiters.get(runId) ?? []) waiter.resolve("wake");
  }

  notifyAll(): void {
    for (const runId of this.waiters.keys()) this.notify(runId);
  }

  close(): void {
    this.closed = true;
    for (const set of this.waiters.values()) for (const waiter of set) waiter.resolve("timeout");
  }

  /** Queue a control command for an extension waiter (Pi interrupt) and wake it. */
  command(runId: string, command: string): void {
    this.commands.set(runId, command);
    this.notify(runId);
  }

  takeCommand(runId: string): string | null {
    const command = this.commands.get(runId) ?? null;
    this.commands.delete(runId);
    return command;
  }

  hasWaiter(runId: string): boolean {
    return (this.waiters.get(runId)?.size ?? 0) > 0;
  }

  forget(runId: string): void {
    for (const waiter of this.waiters.get(runId) ?? []) waiter.resolve("superseded");
    this.waiters.delete(runId);
    this.latest.delete(runId);
    this.commands.delete(runId);
  }
}
