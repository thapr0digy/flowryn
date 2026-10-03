import { basename } from "node:path";
import type { Db } from "../db/db.ts";
import { tx } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { findOpenItem, openItem, resolveItems } from "../attention/items.ts";
import { ulid } from "../util/ulid.ts";
import { KeyedMutex } from "./file-locks.ts";
import { hashFile, patchTasks, readSnapshot, writeSnapshot, JOURNAL_FILES, type JournalFile } from "./snapshot.ts";
import { classifyMutation, listTasks, taskFromJson, type BacklogTask, type TasksAxiOutcome, type TasksAxiRunner } from "./tasks-axi.ts";

/**
 * The tasks-axi verbs the journal issues. `mv` is deliberately absent: a repeat
 * returns NOT_FOUND and it moves a task to another file (M0 spike t01), so it is
 * not replay-safe. `rm` repeats with NOT_FOUND too, but its goal state is the
 * task being gone, so a replay confirms that with `show` and counts it applied.
 * `block` records a blocked-by edge and is idempotent per tasks-axi 0.2.5 help.
 */
export const INTENT_VERBS = ["add", "start", "done", "hold", "unhold", "update", "reopen", "rm", "block"] as const;
export type IntentVerb = (typeof INTENT_VERBS)[number];

export type FlagValue = string | true | string[];

export interface IntentArgs {
  positional: string[];
  flags: Record<string, FlagValue>;
  /** Set on a copy re-applied after a stale editor buffer erased the original. */
  reapplyOf?: string;
  reapplyDepth?: number;
}

export interface IntentRow {
  id: string;
  seq: number;
  file: JournalFile;
  verb: IntentVerb;
  args: string;
  task_id: string | null;
  state: "pending" | "applied" | "failed";
  attempts: number;
  last_error: string | null;
  created_at: number;
  applied_at: number | null;
}

export interface NewIntent {
  file: JournalFile;
  verb: IntentVerb;
  taskId: string;
  positional?: string[];
  flags?: Record<string, FlagValue>;
  reapplyOf?: string;
  reapplyDepth?: number;
  now?: number;
}

/** Retry delays after each failed attempt (design section 8); the last one repeats. */
export const BACKOFF_MS = [1_000, 5_000, 30_000, 120_000, 600_000] as const;
/** A P1 "backlog out of sync" item opens after this many failures (design section 16). */
export const FAILURES_BEFORE_ITEM = 5;

/**
 * Record an intent. Call inside the transaction that makes the matching
 * runtime change, so the change, the intent and the event commit together.
 */
export function recordIntent(db: Db, intent: NewIntent): IntentRow {
  if (!(INTENT_VERBS as readonly string[]).includes(intent.verb)) throw new Error(`the journal never issues tasks-axi ${intent.verb}`);
  const now = intent.now ?? Date.now();
  const args: IntentArgs = { positional: intent.positional ?? [], flags: intent.flags ?? {} };
  if (intent.reapplyOf) {
    args.reapplyOf = intent.reapplyOf;
    args.reapplyDepth = intent.reapplyDepth ?? 1;
  }
  const seqRow = db.query("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM intents").get() as { next: number };
  const id = ulid(now);
  db.query(
    `INSERT INTO intents (id, seq, file, verb, args, task_id, state, attempts, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', 0, ?7)`,
  ).run(id, seqRow.next, intent.file, intent.verb, JSON.stringify(args), intent.taskId, now);
  appendEvent(db, {
    source: "daemon",
    kind: "intent.recorded",
    taskId: intent.taskId,
    payload: { intent: id, seq: seqRow.next, file: intent.file, verb: intent.verb, reapply_of: intent.reapplyOf ?? null },
    ts: now,
  });
  return getIntent(db, id)!;
}

export function getIntent(db: Db, id: string): IntentRow | null {
  return db.query("SELECT * FROM intents WHERE id = ?1").get(id) as IntentRow | null;
}

export function pendingIntents(db: Db, file?: JournalFile): IntentRow[] {
  if (file) return db.query("SELECT * FROM intents WHERE state = 'pending' AND file = ?1 ORDER BY seq").all(file) as IntentRow[];
  return db.query("SELECT * FROM intents WHERE state = 'pending' ORDER BY seq").all() as IntentRow[];
}

export function intentArgs(row: IntentRow): IntentArgs {
  return JSON.parse(row.args) as IntentArgs;
}

/** The full tasks-axi argument list for an intent, ending with --file and --json. */
export function intentArgv(row: IntentRow, filePath: string): string[] {
  const args = intentArgs(row);
  const argv: string[] = [row.verb, ...args.positional];
  for (const [flag, value] of Object.entries(args.flags)) {
    if (value === true) argv.push(`--${flag}`);
    else if (Array.isArray(value)) for (const v of value) argv.push(`--${flag}`, v);
    else argv.push(`--${flag}`, value);
  }
  argv.push("--file", filePath, "--json");
  return argv;
}

export interface JournalDeps {
  db: Db;
  files: () => Record<JournalFile, string>;
  /** Null when tasks-axi cannot be found; intents then stay pending and retry. */
  runner: () => TasksAxiRunner | null;
  now?: () => number;
  log?: (message: string) => void;
  backoffMs?: readonly number[];
  pollMs?: number;
}

export interface AppliedPayload {
  intent: string;
  file: JournalFile;
  verb: IntentVerb;
  args: IntentArgs;
  already: boolean;
  pre: BacklogTask | null;
  post: BacklogTask | null;
  /** The file's hash just before the write; a later read with this hash is the file rolled back to before this intent. */
  preHash: string | null;
}

/**
 * The intent journal: the only caller of tasks-axi mutations. Intents apply one
 * at a time, in seq order per file; a failing head blocks later intents for the
 * same file (ordering matters: add before done) but not the other file.
 */
export class Journal {
  readonly locks = new KeyedMutex<JournalFile>();
  private readonly db: Db;
  private readonly deps: JournalDeps;
  private readonly now: () => number;
  private readonly backoff: readonly number[];
  private readonly nextAttemptAt = new Map<string, number>();
  private readonly waiters = new Map<string, Set<(row: IntentRow) => void>>();
  /**
   * Set by the backlog watcher: diffs a hand edit the journal is about to
   * write over, so the edit is recorded (and checked against live runs) rather
   * than silently absorbed by the post-write read. Runs under the file lock.
   */
  beforeWrite: ((file: JournalFile) => Promise<void>) | null = null;
  private draining: Promise<void> | null = null;
  private drainAgain = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(deps: JournalDeps) {
    this.db = deps.db;
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.backoff = deps.backoffMs ?? BACKOFF_MS;
  }

  /** Poll for intents whose backoff has elapsed. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (pendingIntents(this.db).length > 0) this.kick();
    }, this.deps.pollMs ?? 1_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.draining) await this.draining;
  }

  kick(): void {
    void this.drain();
  }

  /**
   * Apply every intent that is due, in order, until none is. At startup this
   * is the replay: every pending intent gets one attempt before the daemon
   * serves requests.
   */
  drain(): Promise<void> {
    if (this.draining) {
      this.drainAgain = true;
      return this.draining;
    }
    const run = (async () => {
      do {
        this.drainAgain = false;
        for (let next = this.nextDue(); next && !this.stopped; next = this.nextDue()) {
          try {
            await this.applyOne(next);
          } catch (error) {
            // An unexpected failure (disk, database) must not wedge the loop; the intent stays pending.
            const attempts = (getIntent(this.db, next.id)?.attempts ?? 0) + 1;
            this.nextAttemptAt.set(next.id, this.now() + this.backoff[Math.min(attempts - 1, this.backoff.length - 1)]!);
            this.deps.log?.(`journal: applying ${next.verb} ${next.task_id} threw: ${(error as Error).stack ?? String(error)}`);
          }
        }
      } while (this.drainAgain && !this.stopped);
    })();
    // Clear in a callback, not a finally block: when nothing is due the body
    // finishes synchronously, before `this.draining` is even assigned.
    const tracked = run.finally(() => {
      if (this.draining === tracked) this.draining = null;
    });
    this.draining = tracked;
    return tracked;
  }

  /** Resolve when the intent leaves pending, or with its current row after `timeoutMs`. */
  awaitSettled(id: string, timeoutMs: number): Promise<IntentRow | null> {
    const current = getIntent(this.db, id);
    if (!current || current.state !== "pending") return Promise.resolve(current);
    return new Promise((resolve) => {
      const set = this.waiters.get(id) ?? new Set();
      const done = (row: IntentRow) => {
        clearTimeout(timer);
        set.delete(done);
        resolve(row);
      };
      const timer = setTimeout(() => {
        set.delete(done);
        resolve(getIntent(this.db, id));
      }, timeoutMs);
      set.add(done);
      this.waiters.set(id, set);
    });
  }

  private nextDue(): IntentRow | null {
    const now = this.now();
    let best: IntentRow | null = null;
    for (const file of JOURNAL_FILES) {
      const head = this.db.query("SELECT * FROM intents WHERE state = 'pending' AND file = ?1 ORDER BY seq LIMIT 1").get(file) as IntentRow | null;
      if (!head) continue;
      if ((this.nextAttemptAt.get(head.id) ?? 0) > now) continue;
      if (!best || head.seq < best.seq) best = head;
    }
    return best;
  }

  private notify(row: IntentRow): void {
    if (row.state === "pending") return;
    const set = this.waiters.get(row.id);
    if (!set) return;
    this.waiters.delete(row.id);
    for (const waiter of set) waiter(row);
  }

  private async applyOne(intent: IntentRow): Promise<void> {
    await this.locks.run(intent.file, async () => {
      const fresh = getIntent(this.db, intent.id);
      if (!fresh || fresh.state !== "pending") return;
      const filePath = this.deps.files()[fresh.file];
      // Counted in the outcome's transaction, with its event: an attempt cut short by a crash does not count.
      const attempts = fresh.attempts + 1;
      const runner = this.deps.runner();
      const snapshot = readSnapshot(this.db, fresh.file);
      if (runner && this.beforeWrite && snapshot && snapshot.contentHash !== hashFile(filePath)) await this.beforeWrite(fresh.file);
      const pre = readSnapshot(this.db, fresh.file)?.tasks.find((t) => t.id === fresh.task_id) ?? null;
      const preHash = hashFile(filePath);
      let outcome: TasksAxiOutcome;
      if (!runner) {
        outcome = { ok: false, kind: "transient", code: "TOOL_MISSING", message: "tasks-axi was not found; set [tools] tasks_axi in config.toml", exitCode: null };
      } else {
        outcome = classifyMutation(await runner.run(intentArgv(fresh, filePath)));
        if (!outcome.ok && outcome.kind === "permanent" && fresh.verb === "add" && fresh.task_id) {
          outcome = await this.addAlreadyApplied(runner, fresh.task_id, filePath, outcome);
        }
        if (!outcome.ok && outcome.kind === "permanent" && fresh.verb === "rm" && fresh.task_id) {
          outcome = await this.rmAlreadyApplied(runner, fresh.task_id, filePath, outcome);
        }
      }
      if (outcome.ok) {
        await this.markApplied(fresh, filePath, runner!, outcome.json, pre, preHash);
      } else if (outcome.kind === "transient") {
        this.markRetry(fresh, attempts, filePath, outcome);
      } else {
        this.markFailed(fresh, filePath, outcome);
      }
      const settled = getIntent(this.db, fresh.id);
      if (settled) this.notify(settled);
    });
  }

  /** An add that failed permanently may have landed on an earlier attempt; `show` decides. */
  private async addAlreadyApplied(runner: TasksAxiRunner, taskId: string, filePath: string, failure: TasksAxiOutcome): Promise<TasksAxiOutcome> {
    const shown = await runner.run(["show", taskId, "--file", filePath]);
    if (shown.exitCode === 0) return { ok: true, json: { ok: true, action: "add", already: true } };
    return failure;
  }

  /** A repeated rm answers NOT_FOUND; when `show` agrees the task is gone, the rm has done its job. */
  private async rmAlreadyApplied(runner: TasksAxiRunner, taskId: string, filePath: string, failure: TasksAxiOutcome): Promise<TasksAxiOutcome> {
    if (failure.ok || failure.code !== "NOT_FOUND") return failure;
    const shown = await runner.run(["show", taskId, "--file", filePath]);
    if (shown.exitCode !== 0 && !shown.timedOut && !shown.spawnError) return { ok: true, json: { ok: true, action: "rm", already: true } };
    return failure;
  }

  private async markApplied(intent: IntentRow, filePath: string, runner: TasksAxiRunner, json: Record<string, unknown>, pre: BacklogTask | null, preHash: string) {
    const now = this.now();
    const contentHash = hashFile(filePath);
    let tasks: BacklogTask[] | null = null;
    try {
      tasks = await listTasks(runner, filePath);
    } catch (error) {
      this.deps.log?.(`journal: list after ${intent.verb} ${intent.task_id} failed, patching the snapshot: ${(error as Error).message}`);
    }
    const post = json.task && typeof json.task === "object" ? taskFromJson(json.task as Record<string, unknown>) : (tasks?.find((t) => t.id === intent.task_id) ?? null);
    tx(this.db, () => {
      this.db.query("UPDATE intents SET state = 'applied', applied_at = ?2, last_error = NULL, attempts = attempts + 1 WHERE id = ?1").run(intent.id, now);
      if (tasks) writeSnapshot(this.db, intent.file, contentHash, tasks, now);
      else if (post) writeSnapshot(this.db, intent.file, contentHash, patchTasks(readSnapshot(this.db, intent.file)?.tasks ?? [], post), now);
      const payload: AppliedPayload = {
        intent: intent.id,
        file: intent.file,
        verb: intent.verb,
        args: intentArgs(intent),
        already: json.already === true,
        pre,
        post,
        preHash,
      };
      appendEvent(this.db, { source: "daemon", kind: "intent.applied", taskId: intent.task_id, payload, ts: now });
      resolveItems(this.db, "backlog_out_of_sync", intent.task_id, `intent:${intent.id}`, now);
    });
    this.nextAttemptAt.delete(intent.id);
  }

  private markRetry(intent: IntentRow, attempts: number, filePath: string, outcome: Extract<TasksAxiOutcome, { ok: false }>) {
    const now = this.now();
    const delay = this.backoff[Math.min(attempts - 1, this.backoff.length - 1)]!;
    this.nextAttemptAt.set(intent.id, now + delay);
    tx(this.db, () => {
      this.db.query("UPDATE intents SET last_error = ?2, attempts = attempts + 1 WHERE id = ?1").run(intent.id, `${outcome.code}: ${outcome.message}`);
      const event = appendEvent(this.db, {
        source: "daemon",
        kind: "intent.retry",
        taskId: intent.task_id,
        payload: { intent: intent.id, attempt: attempts, code: outcome.code, message: outcome.message, retry_in_ms: delay },
        ts: now,
      });
      if (attempts >= FAILURES_BEFORE_ITEM && !findOpenItem(this.db, "backlog_out_of_sync", intent.task_id)) {
        openItem(this.db, {
          kind: "backlog_out_of_sync",
          eventSeq: event.seq,
          taskId: intent.task_id,
          line: outOfSyncLine(intent, filePath, outcome),
          now,
        });
      }
    });
    this.deps.log?.(`journal: ${intent.verb} ${intent.task_id} attempt ${attempts} failed (${outcome.code}); retry in ${delay} ms`);
  }

  private markFailed(intent: IntentRow, filePath: string, outcome: Extract<TasksAxiOutcome, { ok: false }>) {
    const now = this.now();
    this.nextAttemptAt.delete(intent.id);
    tx(this.db, () => {
      this.db.query("UPDATE intents SET state = 'failed', last_error = ?2, attempts = attempts + 1 WHERE id = ?1").run(intent.id, `${outcome.code}: ${outcome.message}`);
      const event = appendEvent(this.db, {
        source: "daemon",
        kind: "intent.failed",
        taskId: intent.task_id,
        payload: { intent: intent.id, code: outcome.code, message: outcome.message },
        ts: now,
      });
      if (!findOpenItem(this.db, "backlog_out_of_sync", intent.task_id)) {
        openItem(this.db, { kind: "backlog_out_of_sync", eventSeq: event.seq, taskId: intent.task_id, line: outOfSyncLine(intent, filePath, outcome), now });
      }
    });
    this.deps.log?.(`journal: ${intent.verb} ${intent.task_id} failed permanently (${outcome.code}: ${outcome.message})`);
  }
}

function outOfSyncLine(intent: IntentRow, filePath: string, outcome: Extract<TasksAxiOutcome, { ok: false }>): string {
  const name = basename(filePath);
  if (outcome.code === "LOCKED") {
    return `Backlog out of sync: ${intent.verb} ${intent.task_id} waits on a tasks-axi lock; if no tasks-axi runs, remove ${filePath}.lock`;
  }
  return `Backlog out of sync: tasks-axi ${intent.verb} ${intent.task_id} on ${name} failed (${outcome.code}): ${outcome.message}`;
}
