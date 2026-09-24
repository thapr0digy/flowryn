import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMeta, integrityProblems, LATEST_SCHEMA_VERSION, migrate, openDb, schemaVersion, SchemaTooNewError, setMeta, tx } from "../../src/db/db.ts";
import { appendEvent } from "../../src/db/events.ts";
import { backupIfDue, listBackups, BACKUPS_KEPT } from "../../src/db/backup.ts";
import { MIGRATIONS, type Migration } from "../../src/db/schema.ts";
import { openItem, resolveItems, findOpenItem, openItems } from "../../src/attention/items.ts";
import { positionOf, runWorkflow } from "../../src/lifecycle/stages.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fw-db-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DESIGN_TABLES = [
  "meta",
  "events",
  "projects",
  "task_policy",
  "runs",
  "run_evidence",
  "divergences",
  "decisions",
  "items",
  "presentations",
  "leader_sessions",
  "leader_lease",
  "messages",
  "approval_attempts",
  "approvals",
  "merges",
  "gates",
  "pool_leases",
  "intents",
  "backlog_snapshot",
  "artifacts",
  "idempotency",
  "spool_ingested",
  "notifications",
  "harness_contracts",
];

describe("migrations", () => {
  test("a fresh database gets every section 13 table, in WAL mode with foreign keys", () => {
    const db = openDb(join(tempDir(), "flowryn.db"));
    expect(migrate(db)).toEqual(MIGRATIONS.map((m) => m.version));
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    for (const table of DESIGN_TABLES) expect(tables).toContain(table);
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    expect((db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    expect(integrityProblems(db)).toEqual([]);
    db.close();
  });

  test("re-running is a no-op", () => {
    const db = openDb(join(tempDir(), "flowryn.db"));
    migrate(db);
    expect(migrate(db)).toEqual([]);
    db.close();
  });

  test("forward-only: a newer database is refused", () => {
    const db = openDb(join(tempDir(), "flowryn.db"));
    migrate(db);
    tx(db, () => setMeta(db, "schema_version", String(LATEST_SCHEMA_VERSION + 1)));
    expect(() => migrate(db)).toThrow(SchemaTooNewError);
    db.close();
  });

  test("a failing migration rolls back entirely and leaves the version unchanged", () => {
    const db = openDb(join(tempDir(), "flowryn.db"));
    migrate(db);
    const broken: Migration[] = [...MIGRATIONS, { version: LATEST_SCHEMA_VERSION + 1, name: "broken", sql: "CREATE TABLE half_done (a); INSERT INTO nope VALUES (1);" }];
    expect(() => migrate(db, broken)).toThrow();
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'half_done'").get()).toBeNull();
    db.close();
  });

  test("one open run per task is enforced by the schema", () => {
    const db = openDb(join(tempDir(), "flowryn.db"));
    migrate(db);
    db.exec("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode) VALUES ('p', 'u', '/p', 'main', 'no-mistakes')");
    db.exec("INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES ('t', 'p', 'ship', 'no-mistakes', 0, 'fix', 1)");
    const insert = (id: string, state: string) =>
      db.exec(
        `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
         VALUES ('${id}', 't', 'claude', 'v', '${state}', 'busy', 'fix', 'build', '/w', 'b', 's', 'h', 1, 1)`,
      );
    insert("r1", "failed");
    insert("r2", "running");
    expect(() => insert("r3", "launching")).toThrow();
    db.close();
  });

  test("a run open before M5 keeps the build-then-ship workflow its worker was given, whatever its workflow id names now", () => {
    const db = openDb(join(tempDir(), "flowryn.db"));
    migrate(db, MIGRATIONS.slice(0, 4));
    db.exec("INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode, workflow) VALUES ('p', 'u', '/p', 'main', 'no-mistakes', 'feature')");
    const run = (id: string, task: string, kind: string, workflow: string, stage: string, state: string) => {
      db.exec(`INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, workflow, created_at) VALUES ('${task}', 'p', '${kind}', 'no-mistakes', 0, '${workflow}', 1)`);
      db.exec(
        `INSERT INTO runs (id, task_id, harness, harness_version, state, liveness, workflow, stage, worktree_path, branch, base_sha, token_hash, started_at, updated_at)
         VALUES ('${id}', '${task}', 'claude', 'v', '${state}', 'busy', '${workflow}', '${stage}', '/w/${task}', 'b-${task}', 's', 'h-${id}', 1, 1)`,
      );
      tx(db, () => appendEvent(db, { source: "cli", kind: "run.dispatched", runId: id, taskId: task, payload: { kind } }));
    };
    run("r1", "t1", "ship", "feature", "build", "running");
    run("r2", "t2", "scout", "scout", "investigate", "running");
    run("r3", "t3", "ship", "feature", "build", "cleaned");
    migrate(db);

    const shape = (id: string, workflow: string) => runWorkflow(db, { id, workflow }).stages.map((s) => `${s.id}:${s.gate}:${s.pools.join("+")}`);
    expect(shape("r1", "feature")).toEqual(["build:none:", "ship:merge:validation"]);
    const pos = positionOf(db, { id: "r1", workflow: "feature", stage: "build" }, "ship");
    expect([pos.index, pos.last]).toEqual([0, false]);
    expect(shape("r2", "scout")).toEqual(["investigate:none:"]);
    // A run already closed is not frozen: it never moves again.
    expect(db.query("SELECT workflow_def FROM runs WHERE id = 'r3'").get()).toEqual({ workflow_def: null });
    db.close();
  });
});

describe("events", () => {
  test("are append-only: triggers refuse UPDATE and DELETE", () => {
    const db = openDb(join(tempDir(), "flowryn.db"));
    migrate(db);
    const { seq } = tx(db, () => appendEvent(db, { source: "cli", kind: "test.happened", payload: { a: 1 } }));
    expect(seq).toBeGreaterThan(0);
    expect(() => db.exec("UPDATE events SET kind = 'x'")).toThrow("append-only");
    expect(() => db.exec("DELETE FROM events")).toThrow("append-only");
    const row = db.query("SELECT * FROM events WHERE seq = ?1").get(seq) as { payload: string; kind: string };
    expect(JSON.parse(row.payload)).toEqual({ a: 1 });
    db.close();
  });

  test("an event and its state change commit or roll back together", () => {
    const db = openDb(join(tempDir(), "flowryn.db"));
    migrate(db);
    expect(() =>
      tx(db, () => {
        appendEvent(db, { source: "cli", kind: "doomed" });
        setMeta(db, "k", "v");
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'doomed'").get()).toEqual({ n: 0 });
    expect(getMeta(db, "k")).toBeNull();
    db.close();
  });
});

describe("items", () => {
  test("open with the lane table's lane and class, resolve by kind and task", () => {
    const db = openDb(join(tempDir(), "flowryn.db"));
    migrate(db);
    const id = tx(db, () => {
      const { seq } = appendEvent(db, { source: "daemon", kind: "intent.failed" });
      return openItem(db, { kind: "backlog_out_of_sync", eventSeq: seq, taskId: "t1", line: "Backlog out of sync:\u001b[31m x\ny" });
    });
    expect(id).toBe("i1");
    const item = findOpenItem(db, "backlog_out_of_sync", "t1")!;
    expect(item).toMatchObject({ lane: "P1", class: "actionable", line: "Backlog out of sync: x y" });
    expect(tx(db, () => resolveItems(db, "backlog_out_of_sync", "t1", "test"))).toBe(1);
    expect(openItems(db)).toEqual([]);
    db.close();
  });
});

describe("backups", () => {
  test("one VACUUM INTO per day, keeping the newest seven", () => {
    const dir = tempDir();
    const db = openDb(join(dir, "flowryn.db"));
    migrate(db);
    const backups = join(dir, "backups");
    const first = backupIfDue(db, backups, new Date(2026, 8, 1));
    expect(first && existsSync(first)).toBe(true);
    expect(backupIfDue(db, backups, new Date(2026, 8, 1))).toBeNull();
    for (let day = 2; day <= 10; day++) backupIfDue(db, backups, new Date(2026, 8, day));
    const kept = listBackups(backups);
    expect(kept.length).toBe(BACKUPS_KEPT);
    expect(kept[0]).toEndWith("flowryn-2026-09-04.db");
    const copy = openDb(kept[kept.length - 1]!, { readonly: true });
    expect(schemaVersion(copy)).toBe(LATEST_SCHEMA_VERSION);
    copy.close();
    db.close();
    writeFileSync(join(backups, "notes.txt"), "ignored");
    utimesSync(join(backups, "notes.txt"), new Date(), new Date());
    expect(listBackups(backups).length).toBe(BACKUPS_KEPT);
  });
});
