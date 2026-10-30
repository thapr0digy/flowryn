import { existsSync } from "node:fs";
import { resolveCaller } from "../../api/auth.ts";
import type { CompletionSource } from "../../api/verbs.ts";
import { accountsConfig } from "../../config/accounts.ts";
import { loadConfig, type FlowrynConfig } from "../../config/config.ts";
import { flowrynHome, stateFiles } from "../../config/paths.ts";
import { workflowsConfig } from "../../config/workflows.ts";
import { openDb, type Db } from "../../db/db.ts";
import { readSnapshot } from "../../journal/snapshot.ts";
import { lensFor, SEES_ALL, type ScopeLens } from "../../leader/scope.ts";
import { sanitizeLine } from "../../util/sanitize.ts";

/**
 * The ids shell completion offers (`flowryn completion values <source>`): a
 * read-only look at the database or config, never the daemon, so a busy or
 * stuck daemon cannot hold up a prompt. Only open things are listed (not Done
 * tasks or answered decisions). A leader or reader token sees its own scope,
 * through the same lens as the list verbs; a run token sees nothing (workers
 * never tab-complete). Without a token it is your terminal, which may read the
 * database file anyway.
 */

export interface CompletionValue {
  id: string;
  description: string;
}

const MAX_DESCRIPTION = 80;
/** A Tab never waits long on a database another process holds. */
const BUSY_TIMEOUT_MS = 250;

const DB_SOURCES: ReadonlySet<CompletionSource> = new Set(["project", "task", "decision", "todo"]);

function value(id: string, description: string): CompletionValue {
  return { id, description: sanitizeLine(description, MAX_DESCRIPTION) };
}

function dbValues(db: Db, lens: ScopeLens, source: CompletionSource): CompletionValue[] {
  switch (source) {
    case "project":
      return (db.query("SELECT id, path FROM projects ORDER BY id").all() as { id: string; path: string }[]).filter((p) => lens.project(p.id)).map((p) => value(p.id, p.path));
    case "task":
      return (readSnapshot(db, "backlog")?.tasks ?? []).filter((t) => t.state !== "done" && lens.task(t.id)).map((t) => value(t.id, t.title));
    case "todo":
      return (readSnapshot(db, "todos")?.tasks ?? []).filter((t) => t.state !== "done" && lens.task(t.id)).map((t) => value(t.id, t.title));
    case "decision":
      return (db.query("SELECT id, task_id, question FROM decisions WHERE state = 'open' ORDER BY rowid").all() as { id: string; task_id: string; question: string }[])
        .filter((d) => lens.task(d.task_id))
        .map((d) => value(d.id, d.question));
    default:
      return [];
  }
}

function configValues(config: FlowrynConfig, lens: ScopeLens, source: CompletionSource): CompletionValue[] {
  switch (source) {
    case "workflow":
      return Object.values(workflowsConfig(config)).map((w) => value(w.id, w.stages.map((s) => s.id).join(" → ")));
    case "stage": {
      const workflowsOf = new Map<string, string[]>();
      for (const w of Object.values(workflowsConfig(config))) {
        for (const s of w.stages) workflowsOf.set(s.id, [...(workflowsOf.get(s.id) ?? []), w.id]);
      }
      return [...workflowsOf].map(([stage, workflows]) => value(stage, `in ${workflows.join(", ")}`));
    }
    case "account":
      return Object.values(accountsConfig(config).accounts)
        .filter((a) => !lens.restricted || a.scope === lens.scope)
        .map((a) => value(a.id, `${a.harness}, scope ${a.scope}`));
    default:
      return [];
  }
}

/**
 * The values of one source for the caller `token` names (null: your terminal).
 * Throws on anything it cannot read; the verb turns that into no output.
 */
export function completionValues(env: NodeJS.ProcessEnv, source: CompletionSource): CompletionValue[] {
  const { config } = loadConfig(flowrynHome(env));
  const token = env.FLOWRYN_TOKEN && env.FLOWRYN_TOKEN.length > 0 ? env.FLOWRYN_TOKEN : null;
  const dbPath = stateFiles(config.state_dir).db;
  if (!existsSync(dbPath)) {
    // No database yet: config's ids are still there for your terminal; a token cannot be checked.
    return token || DB_SOURCES.has(source) ? [] : configValues(config, SEES_ALL, source);
  }
  const db = openDb(dbPath, { readonly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const caller = resolveCaller(db, token, null);
    if (token && caller.role !== "leader" && caller.role !== "reader") return [];
    const lens = lensFor(db, config, caller.scope);
    return DB_SOURCES.has(source) ? dbValues(db, lens, source) : configValues(config, lens, source);
  } finally {
    db.close();
  }
}

/** One `_describe` line per value: `id:description`, a colon in the id escaped. */
export function describeLines(values: readonly CompletionValue[]): string {
  return values.map((v) => `${v.id.replaceAll("\\", "\\\\").replaceAll(":", "\\:")}:${v.description}\n`).join("");
}
