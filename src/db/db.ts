import { Database } from "bun:sqlite";
import { MIGRATIONS, LATEST_SCHEMA_VERSION, type Migration } from "./schema.ts";

export type Db = Database;

export interface OpenOptions {
  readonly?: boolean;
}

/**
 * Open flowryn.db. Writable opens set WAL, foreign keys, a 5 s busy timeout
 * and synchronous=FULL, so a committed transaction survives a crash of the
 * process or the machine. Read-only opens are for CLI reads while the daemon
 * is down (WAL allows concurrent readers).
 */
export function openDb(path: string, options: OpenOptions = {}): Db {
  const db = options.readonly
    ? new Database(path, { readonly: true, strict: true })
    : new Database(path, { create: true, readwrite: true, strict: true });
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  if (!options.readonly) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
  }
  return db;
}

/** Run `fn` in one BEGIN IMMEDIATE transaction; it commits on return and rolls back on throw. */
export function tx<T>(db: Db, fn: () => T): T {
  return db.transaction(fn).immediate();
}

export function schemaVersion(db: Db): number {
  const table = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (!table) return 0;
  const row = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | null;
  return row ? Number(row.value) : 0;
}

export class SchemaTooNewError extends Error {
  constructor(found: number, supported: number) {
    super(`flowryn.db is at schema ${found}, newer than this binary supports (${supported}); migrations are forward-only, so install a newer flowryn`);
    this.name = "SchemaTooNewError";
  }
}

/** Apply every pending migration in order, each in its own transaction. Returns the versions applied. */
export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): number[] {
  const latest = migrations.length > 0 ? migrations[migrations.length - 1]!.version : 0;
  const current = schemaVersion(db);
  if (current > latest) throw new SchemaTooNewError(current, latest);
  const applied: number[] = [];
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    // PRAGMA foreign_keys is a no-op inside a transaction, so it is switched around it.
    if (migration.rebuildsReferencedTable) db.exec("PRAGMA foreign_keys = OFF");
    try {
      tx(db, () => {
        db.exec(migration.sql);
        if (migration.rebuildsReferencedTable) {
          const broken = db.query("PRAGMA foreign_key_check").all();
          if (broken.length > 0) throw new Error(`migration ${migration.version} (${migration.name}) left ${broken.length} broken foreign key reference(s)`);
        }
        db.query("INSERT INTO meta (key, value) VALUES ('schema_version', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
          String(migration.version),
        );
      });
    } finally {
      if (migration.rebuildsReferencedTable) db.exec("PRAGMA foreign_keys = ON");
    }
    applied.push(migration.version);
  }
  return applied;
}

/** PRAGMA quick_check; returns the problems, or an empty list when the file is sound. */
export function integrityProblems(db: Db): string[] {
  const rows = db.query("PRAGMA quick_check").all() as { quick_check: string }[];
  const messages = rows.map((r) => r.quick_check);
  return messages.length === 1 && messages[0] === "ok" ? [] : messages;
}

export function getMeta(db: Db, key: string): string | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?1").get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.query("INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export { LATEST_SCHEMA_VERSION };
