import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb, tx, type Db } from "../../src/db/db.ts";
import { Journal, recordIntent, type NewIntent, type IntentRow } from "../../src/journal/journal.ts";
import { BacklogWatcher } from "../../src/journal/watcher.ts";
import { processRunner, type TasksAxiRunner } from "../../src/journal/tasks-axi.ts";
import type { JournalFile } from "../../src/journal/snapshot.ts";
import { realTasksAxi } from "./harness.ts";

export type RawRun = Awaited<ReturnType<TasksAxiRunner["run"]>>;

/** A runner that can answer instead of the real tasks-axi, to inject failures. */
export class ScriptedRunner implements TasksAxiRunner {
  readonly calls: string[][] = [];
  readonly real: TasksAxiRunner;
  intercept: ((args: string[]) => RawRun | null) | null = null;

  constructor() {
    this.real = processRunner(realTasksAxi(), Bun.which("node"));
  }

  async run(args: string[], timeoutMs?: number): Promise<RawRun> {
    this.calls.push(args);
    const scripted = this.intercept?.(args);
    if (scripted) return scripted;
    return this.real.run(args, timeoutMs);
  }

  mutations(): string[][] {
    return this.calls.filter((c) => !["list", "show", "--version"].includes(c[0]!));
  }
}

export const LOCKED: RawRun = { exitCode: 1, stdout: "error: backlog is locked by another tasks-axi process\ncode: LOCKED\n", stderr: "", timedOut: false };

export interface JournalEnv {
  dir: string;
  db: Db;
  files: Record<JournalFile, string>;
  runner: ScriptedRunner;
  journal: Journal;
  watcher: BacklogWatcher;
  clock: { now: number };
  record(intent: NewIntent): IntentRow;
  logs: string[];
  cleanup(): Promise<void>;
}

export function makeJournalEnv(options: { eraseWindowMs?: number; runnerMissing?: boolean } = {}): JournalEnv {
  const dir = mkdtempSync(join(tmpdir(), "fw-j-"));
  const db = openDb(join(dir, "flowryn.db"));
  migrate(db);
  const files: Record<JournalFile, string> = { backlog: join(dir, "backlog.md"), todos: join(dir, "todos.md") };
  const runner = new ScriptedRunner();
  const clock = { now: Date.now() };
  const logs: string[] = [];
  const journal = new Journal({
    db,
    files: () => files,
    runner: () => (options.runnerMissing ? null : runner),
    now: () => clock.now,
    log: (m) => logs.push(m),
  });
  const watcher = new BacklogWatcher({
    db,
    journal,
    files: () => files,
    runner: () => runner,
    now: () => clock.now,
    log: (m) => logs.push(m),
    eraseWindowMs: options.eraseWindowMs,
  });
  return {
    dir,
    db,
    files,
    runner,
    journal,
    watcher,
    clock,
    logs,
    record: (intent) => tx(db, () => recordIntent(db, { now: clock.now, ...intent })),
    async cleanup() {
      watcher.stop();
      await journal.stop();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function intents(db: Db): IntentRow[] {
  return db.query("SELECT * FROM intents ORDER BY seq").all() as IntentRow[];
}

export function eventKinds(db: Db): string[] {
  return (db.query("SELECT kind FROM events ORDER BY seq").all() as { kind: string }[]).map((r) => r.kind);
}
