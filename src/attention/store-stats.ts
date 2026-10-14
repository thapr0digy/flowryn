import { lstatSync, readdirSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { ReadCtx, VerbSpec } from "../api/verbs.ts";
import type { Db } from "../db/db.ts";
import { LEADER_RUN_VERBS } from "../lifecycle/leader-verbs.ts";
import { ATTENTION_VERBS } from "./verbs.ts";

/**
 * `flowryn stats`'s store section (docs/notes/2026-10-13-measure-waiting-time-na.md):
 * the database's size and rows, the window's events by day and by kind, the
 * latency of the reads `fleet` and `brief` do, and what the state directory
 * holds. The whole database whatever --project says.
 */

/** Window events aggregated at most: past this many the day and kind tables stop, with a gap line. */
export const MAX_SCANNED_EVENTS = 1_000_000;
/** Entries the state directory walk visits in all. */
export const MAX_DIR_ENTRIES = 20_000;
/** UTC days the events-per-day table lists at most, the newest kept. */
export const MAX_EVENT_DAYS = 400;
const TOP_KINDS = 10;
const LATENCY_RUNS = 3;
/** The reads whose latency is reported: what the leader runs most. */
export const TIMED_READS = ["fleet", "brief"] as const;

export interface StoreSection {
  scope: string;
  db: string;
  tables: { table: string; rows: number }[];
  events_per_day_utc: { day: string; n: number; bytes: string }[];
  event_kinds: { kind: string; n: number; bytes: string }[];
  latency: { read: string; median: string }[];
  state_dir: { entry: string; bytes: string; files: number }[];
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function pragma(db: Db, name: "page_count" | "page_size" | "freelist_count"): number {
  const row = db.query(`PRAGMA ${name}`).get() as Record<string, number> | null;
  return row ? Number(Object.values(row)[0] ?? 0) : 0;
}

/** The file sizes (main, -wal, -shm) and SQLite's own page accounting. */
export function dbLine(db: Db): string {
  const pages = pragma(db, "page_count");
  const size = pragma(db, "page_size");
  const free = pragma(db, "freelist_count");
  const accounting = `${pages} pages × ${size} B (${formatBytes(pages * size)}), ${free} free`;
  const file = db.filename;
  if (!file || file === ":memory:") return `in memory · ${accounting}`;
  const files = [["db", file], ["wal", `${file}-wal`], ["shm", `${file}-shm`]] as const;
  const sizes = files.map(([label, path]) => {
    const bytes = fileSize(path);
    return `${label} ${bytes === null ? "-" : formatBytes(bytes)}`;
  });
  return `${sizes.join(" · ")} · ${accounting}`;
}

/**
 * Rows of every table, largest first. events is append-only (triggers refuse
 * UPDATE and DELETE) and keyed by its rowid, so MAX(seq) is its count without
 * a scan.
 */
export function tableRows(db: Db): { table: string; rows: number }[] {
  const names = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
  return names
    .map((table) => {
      const sql = table === "events" ? "SELECT COALESCE(MAX(seq), 0) AS n FROM events" : `SELECT COUNT(*) AS n FROM "${table.replaceAll('"', '""')}"`;
      return { table, rows: (db.query(sql).get() as { n: number }).n };
    })
    .toSorted((a, b) => b.rows - a.rows || a.table.localeCompare(b.table));
}

/** The window's events by UTC day and its largest kinds, both with payload bytes. */
export function eventGrowth(db: Db, scope: { since: number; firstSeq: number }, gaps: string[]): Pick<StoreSection, "events_per_day_utc" | "event_kinds"> {
  const params = { first: scope.firstSeq, last: scope.firstSeq + MAX_SCANNED_EVENTS, since: scope.since };
  const window = "seq >= $first AND seq < $last AND ts >= $since";
  const capped = db.query("SELECT 1 FROM events WHERE seq >= $last LIMIT 1").get({ last: params.last });
  if (capped) gaps.push(`event growth: only the window's first ${MAX_SCANNED_EVENTS} events are counted`);
  const newestDays = db
    .query(`SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS day, COUNT(*) AS n, SUM(length(payload)) AS bytes FROM events WHERE ${window} GROUP BY day ORDER BY day DESC LIMIT ${MAX_EVENT_DAYS + 1}`)
    .all(params) as { day: string; n: number; bytes: number }[];
  const days = newestDays.slice(0, MAX_EVENT_DAYS).toReversed();
  if (newestDays.length > MAX_EVENT_DAYS) gaps.push(`events per day: only the newest ${MAX_EVENT_DAYS} days are listed`);
  const kinds = db
    .query(`SELECT kind, COUNT(*) AS n, SUM(length(payload)) AS bytes FROM events WHERE ${window} GROUP BY kind ORDER BY n DESC, kind LIMIT ${TOP_KINDS}`)
    .all(params) as { kind: string; n: number; bytes: number }[];
  return {
    events_per_day_utc: days.map((d) => ({ day: d.day, n: d.n, bytes: formatBytes(d.bytes) })),
    event_kinds: kinds.map((k) => ({ kind: k.kind, n: k.n, bytes: formatBytes(k.bytes) })),
  };
}

/** Each read run LATENCY_RUNS times through its own verb, as you would call it; the median in ms. */
export function readLatency(ctx: ReadCtx, verbs: readonly VerbSpec[] = [...LEADER_RUN_VERBS, ...ATTENTION_VERBS], reads: readonly string[] = TIMED_READS): { read: string; median: string }[] {
  const asYou: ReadCtx = { ...ctx, caller: { role: "human", runId: null, taskId: null } };
  return reads.map((name) => {
    const spec = verbs.find((v) => v.name === name);
    if (!spec?.read) return { read: name, median: "no such read" };
    const samples: number[] = [];
    try {
      for (let i = 0; i < LATENCY_RUNS; i += 1) {
        const start = performance.now();
        spec.read(asYou, {});
        samples.push(performance.now() - start);
      }
    } catch (error) {
      return { read: name, median: `failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    samples.sort((a, b) => a - b);
    return { read: name, median: `${samples[Math.floor(samples.length / 2)]!.toFixed(1)} ms` };
  });
}

interface DirTotal {
  bytes: number;
  files: number;
  capped: boolean;
}

/**
 * Each top-level entry of the state directory: its bytes and files, symlinks
 * not followed (lstat). The walk visits at most `cap` entries in all; an entry
 * it could not finish has its bytes marked `≥` (its files count what was seen).
 */
export function stateDirSizes(dir: string, gaps: string[], cap = MAX_DIR_ENTRIES): StoreSection["state_dir"] {
  let top: string[];
  try {
    top = readdirSync(dir).toSorted();
  } catch (error) {
    gaps.push(`state_dir ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  let budget = cap;
  const totals = top.map((name): [string, DirTotal] => {
    const total: DirTotal = { bytes: 0, files: 0, capped: false };
    const stack = [join(dir, name)];
    while (stack.length > 0) {
      if (budget <= 0) {
        total.capped = true;
        break;
      }
      budget -= 1;
      const path = stack.pop()!;
      let st: Stats;
      try {
        st = lstatSync(path);
      } catch {
        continue; // removed between the listing and the stat
      }
      if (st.isDirectory()) {
        try {
          for (const child of readdirSync(path)) stack.push(join(path, child));
        } catch {
          total.capped = true;
        }
      } else {
        total.bytes += st.size;
        total.files += 1;
      }
    }
    return [name, total];
  });
  if (budget <= 0) gaps.push(`state_dir: the walk stopped at ${cap} entries; entries marked ≥ are larger`);
  return totals
    .toSorted((a, b) => b[1].bytes - a[1].bytes || a[0].localeCompare(b[0]))
    .map(([entry, t]) => ({ entry, bytes: `${t.capped ? "≥" : ""}${formatBytes(t.bytes)}`, files: t.files }));
}

export function storeStats(ctx: ReadCtx, scope: { since: number; firstSeq: number }, gaps: string[]): StoreSection {
  return {
    scope: "the whole database, whatever --project says",
    db: dbLine(ctx.db),
    tables: tableRows(ctx.db),
    ...eventGrowth(ctx.db, scope, gaps),
    latency: readLatency(ctx),
    state_dir: stateDirSizes(ctx.config.state_dir, gaps),
  };
}
