import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import type { Db } from "../db/db.ts";
import { getMeta, setMeta, tx } from "../db/db.ts";
import { appendEvent, type EventRow } from "../db/events.ts";
import { openItem } from "../attention/items.ts";
import { diffTasks, intentErased, isEmptyDiff, type BacklogDiff } from "./diff.ts";
import { pendingIntents, recordIntent, type AppliedPayload, type Journal } from "./journal.ts";
import { hashFile, readSnapshot, writeSnapshot, JOURNAL_FILES, type JournalFile } from "./snapshot.ts";
import { listTasks, type BacklogTask, type TasksAxiRunner } from "./tasks-axi.ts";

/**
 * How far back an intent counts as "just written by the CLI". Inside this
 * window, a read that shows a task exactly as it was before the intent is
 * treated as a stale editor buffer overwriting it, and the intent is applied
 * again. Outside it, the file is taken as your edit.
 */
export const ERASE_WINDOW_MS = 60 * 60 * 1000;
/** A stale buffer that keeps winning is left alone after this many re-applies. */
export const MAX_REAPPLY_DEPTH = 3;
export const HASH_CHECK_INTERVAL_MS = 60_000;

/** A re-applied copy and its original share one chain, named by the original intent. */
function chainRoot(applied: AppliedPayload): string {
  return applied.args.reapplyOf ?? applied.intent;
}
const DEBOUNCE_MS = 150;

export type CheckOutcome = "unchanged" | "baseline" | "edited" | "no_runner" | "read_failed";

export interface CheckResult {
  outcome: CheckOutcome;
  diff?: BacklogDiff;
  reapplied?: string[];
  divergences?: string[];
}

export interface WatcherDeps {
  db: Db;
  journal: Journal;
  files: () => Record<JournalFile, string>;
  runner: () => TasksAxiRunner | null;
  now?: () => number;
  log?: (message: string) => void;
  eraseWindowMs?: number;
  intervalMs?: number;
}

interface OpenRun {
  id: string;
  task_id: string;
  state: string;
}

/**
 * Notices changes to backlog.md and todos.md that did not come from the
 * journal (design section 8, "When you edit the backlog by hand"): a file
 * watch plus a periodic hash check against the last applied hash.
 */
export class BacklogWatcher {
  private readonly deps: WatcherDeps;
  private readonly now: () => number;
  private readonly watchers: FSWatcher[] = [];
  private readonly debounce = new Map<JournalFile, ReturnType<typeof setTimeout>>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(deps: WatcherDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.watchFiles();
    this.interval = setInterval(() => void this.checkAll("interval"), this.deps.intervalMs ?? HASH_CHECK_INTERVAL_MS);
    await this.checkAll("startup");
  }

  stop(): void {
    this.stopped = true;
    for (const w of this.watchers.splice(0)) w.close();
    for (const t of this.debounce.values()) clearTimeout(t);
    this.debounce.clear();
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  /** Re-point the file watches, for example after a config reload. */
  rewatch(): void {
    for (const w of this.watchers.splice(0)) w.close();
    this.watchFiles();
  }

  async checkAll(reason: string): Promise<void> {
    for (const file of JOURNAL_FILES) {
      if (this.stopped) return;
      try {
        await this.check(file, reason);
      } catch (error) {
        this.deps.log?.(`watcher: checking ${file} failed: ${(error as Error).stack ?? String(error)}`);
      }
    }
  }

  private watchFiles(): void {
    const files = this.deps.files();
    const byDir = new Map<string, JournalFile[]>();
    for (const file of JOURNAL_FILES) {
      const dir = dirname(files[file]);
      byDir.set(dir, [...(byDir.get(dir) ?? []), file]);
    }
    for (const [dir, watched] of byDir) {
      try {
        // Watch the directory, not the file: tasks-axi replaces the file, which ends a watch on its inode.
        const watcher = watch(dir, (_event, filename) => {
          for (const file of watched) {
            const name = basename(this.deps.files()[file]);
            if (filename === null || filename === name) this.schedule(file);
          }
        });
        watcher.on("error", (error) => this.deps.log?.(`watcher: ${dir}: ${error.message}`));
        this.watchers.push(watcher);
      } catch (error) {
        // A missing directory is fine; the periodic hash check still covers the file.
        this.deps.log?.(`watcher: cannot watch ${dir}: ${(error as Error).message}`);
      }
    }
  }

  private schedule(file: JournalFile): void {
    const existing = this.debounce.get(file);
    if (existing) clearTimeout(existing);
    this.debounce.set(
      file,
      setTimeout(() => {
        this.debounce.delete(file);
        void this.check(file, "fs-event").catch((error) => this.deps.log?.(`watcher: ${file}: ${(error as Error).message}`));
      }, DEBOUNCE_MS),
    );
  }

  /** Compare the file with the last applied hash; on a change, re-read, diff and reconcile. */
  check(file: JournalFile, reason: string): Promise<CheckResult> {
    return this.deps.journal.locks.run(file, () => this.checkLocked(file, reason));
  }

  private async checkLocked(file: JournalFile, reason: string): Promise<CheckResult> {
    const { db } = this.deps;
    const path = this.deps.files()[file];
    const contentHash = hashFile(path);
    const snapshot = readSnapshot(db, file);
    if (snapshot && snapshot.contentHash === contentHash) return { outcome: "unchanged" };
    const runner = this.deps.runner();
    if (!runner) return { outcome: "no_runner" };
    let tasks: BacklogTask[];
    try {
      tasks = await listTasks(runner, path);
    } catch (error) {
      this.deps.log?.(`watcher: reading ${path} failed; will retry: ${(error as Error).message}`);
      return { outcome: "read_failed" };
    }
    const now = this.now();
    if (!snapshot) {
      tx(db, () => {
        writeSnapshot(db, file, contentHash, tasks, now);
        appendEvent(db, { source: "backlog", kind: "backlog.baseline", payload: { file, path, tasks: tasks.length, reason }, ts: now });
      });
      return { outcome: "baseline" };
    }

    const diff = diffTasks(snapshot.tasks, tasks);
    const erased = this.erasedIntents(file, tasks, now);
    const conflicts = file === "backlog" ? this.runConflicts(tasks) : [];
    const reapplied: string[] = [];
    const divergences: string[] = [];
    tx(db, () => {
      writeSnapshot(db, file, contentHash, tasks, now);
      appendEvent(db, {
        source: "backlog",
        kind: "backlog.edited",
        payload: { file, path, reason, ...diff, erased: erased.map((e) => e.intent) },
        ts: now,
      });
      for (const applied of erased) {
        const copy = recordIntent(db, {
          file,
          verb: applied.verb,
          taskId: applied.taskId,
          positional: applied.args.positional,
          flags: applied.args.flags,
          reapplyOf: applied.args.reapplyOf ?? applied.intent,
          reapplyDepth: (applied.args.reapplyDepth ?? 0) + 1,
          now,
        });
        appendEvent(db, {
          source: "backlog",
          kind: "intent.reapplied",
          taskId: applied.taskId,
          payload: { intent: copy.id, erased: applied.intent, verb: applied.verb },
          ts: now,
        });
        reapplied.push(copy.id);
      }
      for (const conflict of conflicts) divergences.push(this.openDivergence(conflict, now));
    });
    if (reapplied.length > 0) this.deps.journal.kick();
    if (!isEmptyDiff(diff)) this.deps.log?.(`watcher: ${file} edited by hand (${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed)`);
    return { outcome: "edited", diff, reapplied, divergences };
  }

  /**
   * Intents applied inside the erase window whose effect this read no longer
   * shows. Once one intent on a task reads as erased, every later intent on
   * that task in the window goes back too, in order, so the task ends where the
   * journal last left it. A re-applied copy supersedes its original, so each
   * chain is considered once, through its latest application.
   */
  private erasedIntents(file: JournalFile, tasks: BacklogTask[], now: number): (AppliedPayload & { taskId: string })[] {
    const since = now - (this.deps.eraseWindowMs ?? ERASE_WINDOW_MS);
    const rows = (this.deps.db.query("SELECT * FROM events WHERE kind = 'intent.applied' AND ts >= ?1 ORDER BY seq").all(since) as EventRow[])
      .map((row) => ({ row, applied: JSON.parse(row.payload) as AppliedPayload }))
      .filter(({ row, applied }) => applied.file === file && row.task_id !== null);
    const latestInChain = new Map<string, number>();
    for (const { row, applied } of rows) latestInChain.set(chainRoot(applied), row.seq);

    const byId = new Map(tasks.map((t) => [t.id, t]));
    const pendingTasks = new Set(pendingIntents(this.deps.db, file).map((i) => i.task_id));
    const rewinding = new Set<string>();
    const erased: (AppliedPayload & { taskId: string })[] = [];
    for (const { row, applied } of rows) {
      const taskId = row.task_id!;
      if (latestInChain.get(chainRoot(applied)) !== row.seq) continue;
      if (pendingTasks.has(taskId)) continue;
      if ((applied.args.reapplyDepth ?? 0) >= MAX_REAPPLY_DEPTH) continue;
      if (!rewinding.has(taskId) && !intentErased(applied, byId.get(taskId))) continue;
      rewinding.add(taskId);
      erased.push({ ...applied, taskId });
    }
    return erased;
  }

  /** A hand edit that contradicts a live run: its task left In flight or vanished. */
  private runConflicts(tasks: BacklogTask[]): { run: OpenRun; summary: string }[] {
    const { db } = this.deps;
    const runs = db.query("SELECT id, task_id, state FROM runs WHERE state NOT IN ('cleaned','failed','cancelled')").all() as OpenRun[];
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const pendingTasks = new Set(pendingIntents(db, "backlog").map((i) => i.task_id));
    const conflicts: { run: OpenRun; summary: string }[] = [];
    for (const run of runs) {
      if (pendingTasks.has(run.task_id)) continue;
      const open = db.query("SELECT 1 FROM divergences WHERE run_id = ?1 AND resolved_at IS NULL").get(run.id);
      if (open) continue;
      const task = byId.get(run.task_id);
      if (!task) conflicts.push({ run, summary: `task ${run.task_id} was removed from the backlog by hand while run ${run.id} is ${run.state}` });
      else if (task.state !== "in_flight") {
        conflicts.push({ run, summary: `task ${run.task_id} was moved to ${task.state} by hand while run ${run.id} is ${run.state}` });
      }
    }
    return conflicts;
  }

  private openDivergence(conflict: { run: OpenRun; summary: string }, now: number): string {
    const { db } = this.deps;
    const next = Number(getMeta(db, "next_divergence_no") ?? "1");
    setMeta(db, "next_divergence_no", String(next + 1));
    const id = `d${next}`;
    db.query(
      "INSERT INTO divergences (id, run_id, task_id, higher, lower, summary, opened_at) VALUES (?1, ?2, ?3, 'run', 'backlog', ?4, ?5)",
    ).run(id, conflict.run.id, conflict.run.task_id, conflict.summary, now);
    const event = appendEvent(db, {
      source: "backlog",
      kind: "divergence.opened",
      runId: conflict.run.id,
      taskId: conflict.run.task_id,
      payload: { divergence: id, higher: "run", lower: "backlog", summary: conflict.summary },
      ts: now,
    });
    openItem(db, {
      kind: "divergence",
      eventSeq: event.seq,
      taskId: conflict.run.task_id,
      runId: conflict.run.id,
      line: `Divergence ${id}: ${conflict.summary}; the run is untouched`,
      now,
    });
    return id;
  }
}
