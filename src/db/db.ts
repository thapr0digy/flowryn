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

/** An applied migration whose recorded name is not this binary's name for its number. */
export interface MigrationMismatch {
  version: number;
  recorded: string;
  expected: string;
}

export class SchemaDivergedError extends Error {
  readonly mismatches: readonly MigrationMismatch[];
  constructor(mismatches: readonly MigrationMismatch[]) {
    const list = mismatches.map((m) => `${m.version} ran as "${m.recorded}", this binary's is "${m.expected}"`).join("; ");
    super(
      `flowryn.db ran other migrations than this binary under the same number (${list}), so its schema differs from what this binary expects; ` +
        "it was migrated by a build from another branch: restore a backup taken before that (flowryn doctor --restore) or run a build that has those migrations",
    );
    this.name = "SchemaDivergedError";
    this.mismatches = mismatches;
  }
}

function hasMigrationNames(db: Db): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get() !== null;
}

/** The applied migrations whose recorded name differs from `migrations`' name for that number; none before migration 28. */
export function divergedMigrations(db: Db, migrations: readonly Migration[] = MIGRATIONS): MigrationMismatch[] {
  if (!hasMigrationNames(db)) return [];
  const expected = new Map(migrations.map((m) => [m.version, m.name]));
  const recorded = db.query("SELECT version, name FROM schema_migrations ORDER BY version").all() as { version: number; name: string }[];
  return recorded.flatMap((r) => {
    const name = expected.get(r.version);
    return name !== undefined && name !== r.name ? [{ version: r.version, recorded: r.name, expected: name }] : [];
  });
}

/**
 * Apply every pending migration in order, each in its own transaction, and record its name. Returns
 * the versions applied. Refuses a database newer than `migrations`, or one whose recorded names differ.
 */
export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS, now: () => number = Date.now): number[] {
  const latest = migrations.length > 0 ? migrations[migrations.length - 1]!.version : 0;
  const current = schemaVersion(db);
  if (current > latest) throw new SchemaTooNewError(current, latest);
  const mismatches = divergedMigrations(db, migrations);
  if (mismatches.length > 0) throw new SchemaDivergedError(mismatches);
  const applied: number[] = [];
  const appliedAt = new Map<number, number>();
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
        const at = now();
        appliedAt.set(migration.version, at);
        if (hasMigrationNames(db)) db.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, ?3)").run(migration.version, migration.name, at);
      });
    } finally {
      if (migration.rebuildsReferencedTable) db.exec("PRAGMA foreign_keys = ON");
    }
    applied.push(migration.version);
  }
  backfillMigrationNames(db, migrations, appliedAt);
  return applied;
}

/**
 * Name the migrations applied before schema_migrations existed, from this binary's names (trust on
 * first use): when applied in this call, with the time; otherwise with no applied_at.
 */
function backfillMigrationNames(db: Db, migrations: readonly Migration[], appliedAt: ReadonlyMap<number, number>): void {
  if (!hasMigrationNames(db)) return;
  const current = schemaVersion(db);
  tx(db, () => {
    const insert = db.query("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, ?3)");
    for (const m of migrations) if (m.version <= current) insert.run(m.version, m.name, appliedAt.get(m.version) ?? null);
  });
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
