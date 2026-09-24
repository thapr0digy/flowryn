import type { Db } from "../db/db.ts";
import { getMeta, setMeta } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { openItem, resolveRunItems } from "../attention/items.ts";
import type { Timing } from "../config/workers.ts";
import { sanitizeBlock } from "../util/sanitize.ts";
import { taskTitle, type RunRow } from "./runs.ts";

/**
 * Steers to workers (design sections 5, 6 and 12). A steer is a messages row.
 * Hooks and the Pi extension carry it; only the worker's `ack` proves it was
 * seen, because no harness can observe that a model read something. A steer
 * not acknowledged within ring_interval_ms rings again, up to max_rings
 * deliveries in all (the first plus three re-rings), and then opens a P1.
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
}

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

/** Steers that should be delivered now: never rung, or rung long enough ago and still under the cap. */
export function dueSteers(db: Db, runId: string, now: number, timing: Timing): MessageRow[] {
  return unackedSteers(db, runId).filter((m) => m.rings < timing.max_rings && (m.last_rung_at === null || now - m.last_rung_at >= timing.ring_interval_ms));
}

/** When the next unacknowledged steer of any run becomes due again, or null. */
export function nextRingAt(db: Db, timing: Timing): number | null {
  const row = db
    .query("SELECT MIN(last_rung_at) AS at FROM messages WHERE acked_at IS NULL AND last_rung_at IS NOT NULL AND rings < ?1")
    .get(timing.max_rings) as { at: number | null };
  return row.at === null ? null : row.at + timing.ring_interval_ms;
}

/** A hook or the extension carried the steer. Call inside a transaction. */
export function markRung(db: Db, message: MessageRow, run: RunRow, path: RingPath, now: number): void {
  db.query("UPDATE messages SET rings = rings + 1, last_rung_at = ?2, carried_at = COALESCE(carried_at, ?2) WHERE id = ?1").run(message.id, now);
  appendEvent(db, { source: "hook", kind: "steer.rung", runId: run.id, taskId: run.task_id, payload: { steer: message.id, ring: message.rings + 1, path }, ts: now });
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
  db.query("UPDATE messages SET acked_at = ?2 WHERE id = ?1").run(message.id, now);
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
