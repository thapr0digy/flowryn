import { FlowrynError } from "../api/errors.ts";
import type { Args, Caller, VerbSpec } from "../api/verbs.ts";
import { stringArg } from "../api/verbs.ts";
import { accountsConfig, IMPLICIT_SCOPE, projectScope, type AccountsConfig } from "../config/accounts.ts";
import type { FlowrynConfig } from "../config/config.ts";
import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { readSnapshot } from "../journal/snapshot.ts";
import { LEGACY_SCOPE, UNCONFIRMED_SCOPE } from "../lease/lease.ts";
import type { HarnessId } from "../harness/types.ts";

/**
 * A leader per scope (docs/notes/2026-10-24-leader-scoping-and-vj.md). A
 * leader session belongs to the scope of the account its login runs on, and
 * sees and acts on that scope's tasks only. A task's scope is its project's
 * (src/config/accounts.ts projectScope); a task with no project (a to-do, a
 * standalone decision) is in the scope of the leader that created it.
 * Everything here is a lookup: no model decides what a leader may see.
 *
 * A home with one scope is unrestricted: every task is in it, so nothing is
 * filtered and nothing behaves differently.
 */

/**
 * What a verb a leader or reader can call does with scope, declared on its
 * spec (a unit test requires one on every such verb):
 * - none: it carries no task content (daemon status, away);
 * - list: its read filters what it lists by the caller's scope itself;
 * - ref: the argument `arg` names a task, run, item, decision, gate, plan,
 *   divergence, grant, leader session or to-do, which must be in the caller's scope;
 * - project: the argument `arg` names a project, which must be in the caller's scope;
 * - self: the verb checks scope itself (what it creates takes the caller's scope).
 */
export type VerbScope =
  | { kind: "none" }
  | { kind: "list" }
  | { kind: "self" }
  | { kind: "ref"; arg: string; optional?: boolean; project?: string }
  | { kind: "project"; arg: string; optional?: boolean };

/** A scope seen from a caller: "global" when the thing names no task (a GitHub outage), null when it has no scope at all (a broken project). */
export type ThingScope = string | "global" | null;

const GLOBAL = "global";

interface ScopeCache {
  accounts: AccountsConfig | null;
  projects: Map<string, string | null>;
}

const caches = new WeakMap<FlowrynConfig, ScopeCache>();

function cacheOf(config: FlowrynConfig): ScopeCache {
  let cache = caches.get(config);
  if (!cache) {
    let accounts: AccountsConfig | null = null;
    try {
      accounts = accountsConfig(config);
    } catch {
      accounts = null;
    }
    cache = { accounts, projects: new Map() };
    caches.set(config, cache);
  }
  return cache;
}

/** The scopes config defines (at least the default one); empty when the accounts config is invalid. */
export function scopeIds(config: FlowrynConfig): string[] {
  const accounts = cacheOf(config).accounts;
  return accounts ? Object.keys(accounts.scopes) : [];
}

export function defaultScope(config: FlowrynConfig): string {
  return cacheOf(config).accounts?.default_scope ?? IMPLICIT_SCOPE;
}

/**
 * Does this caller see everything? Your terminal (no scope) does, and so does
 * a confirmed session in a home whose only scope is its own.
 */
export function unrestricted(config: FlowrynConfig, scope: string | undefined): boolean {
  if (scope === undefined) return true;
  if (scope === UNCONFIRMED_SCOPE) return false;
  const ids = scopeIds(config);
  return ids.length === 1 && ids[0] === scope;
}

/** A registered project's scope; null when it is unknown or its scope rules are broken (it is then nobody's). */
export function projectScopeById(db: Db, config: FlowrynConfig, projectId: string): string | null {
  const cache = cacheOf(config);
  const row = db.query("SELECT id, path, repo_url, harness FROM projects WHERE id = ?1").get(projectId) as { id: string; path: string; repo_url: string; harness: HarnessId } | null;
  if (!row || !cache.accounts) return null;
  const key = `${row.id}\u0000${row.path}\u0000${row.repo_url}`;
  if (cache.projects.has(key)) return cache.projects.get(key)!;
  let scope: string | null;
  try {
    scope = projectScope(config, cache.accounts, row);
  } catch {
    scope = null;
  }
  cache.projects.set(key, scope);
  return scope;
}

/** Item keys that are not tasks (`harness:claude` on a contract record) belong to every scope. */
function isKey(taskId: string): boolean {
  return taskId.includes(":");
}

/**
 * A task's scope: the one recorded when a scoped leader created it without a project, else its
 * project's (Flowryn's policy row, the backlog's repo, its plan's project), else the default scope
 * (your terminal's to-dos, one from before scopes, a hand-added task).
 */
export function taskScope(db: Db, config: FlowrynConfig, taskId: string): ThingScope {
  if (isKey(taskId)) return GLOBAL;
  const recorded = db.query("SELECT scope FROM task_scopes WHERE task_id = ?1").get(taskId) as { scope: string } | null;
  if (recorded) return recorded.scope;
  const project = taskProject(db, taskId);
  if (project !== null) return projectScopeById(db, config, project);
  return defaultScope(config);
}

/** The project a task belongs to, by what Flowryn recorded, then the backlog and to-do snapshots, then its plan. */
export function taskProject(db: Db, taskId: string): string | null {
  const policy = db.query("SELECT project_id FROM task_policy WHERE task_id = ?1").get(taskId) as { project_id: string } | null;
  if (policy) return policy.project_id;
  for (const file of ["backlog", "todos"] as const) {
    const task = readSnapshot(db, file)?.tasks.find((t) => t.id === taskId);
    if (task?.repo) return task.repo;
  }
  const phase = db.query("SELECT pl.project_id FROM plan_phases ph JOIN plans pl ON pl.id = ph.plan_id WHERE ph.task_id = ?1").get(taskId) as { project_id: string } | null;
  return phase?.project_id ?? null;
}

/** What a reference names, for a scope check: its scope, or undefined when nothing by that name exists (the verb says so). */
export function refScope(db: Db, config: FlowrynConfig, ref: string): ThingScope | undefined {
  const ofTask = (taskId: string | null | undefined): ThingScope => (taskId ? taskScope(db, config, taskId) : GLOBAL);
  if (/^L\d+$/.test(ref)) {
    const s = db.query("SELECT scope FROM leader_sessions WHERE session_id = ?1").get(ref) as { scope: string } | null;
    if (s) return s.scope === UNCONFIRMED_SCOPE ? null : s.scope;
  }
  if (/^[kq]\d+$/.test(ref)) {
    const d = db.query("SELECT task_id FROM decisions WHERE id = ?1").get(ref) as { task_id: string } | null;
    if (d) return ofTask(d.task_id);
  }
  if (/^c\d+$/.test(ref)) {
    const g = db.query("SELECT task_id, item FROM captain_grants WHERE id = ?1").get(ref) as { task_id: string | null; item: string } | null;
    if (g) return g.task_id ? ofTask(g.task_id) : (refScope(db, config, g.item) ?? null);
  }
  if (/^g\d+$/.test(ref)) {
    const g = db.query("SELECT r.task_id FROM gates g JOIN runs r ON r.id = g.run_id WHERE g.id = ?1").get(ref) as { task_id: string } | null;
    if (g) return ofTask(g.task_id);
  }
  if (/^p\d+$/.test(ref)) {
    const p = db.query("SELECT project_id FROM plans WHERE id = ?1").get(ref) as { project_id: string } | null;
    if (p) return projectScopeById(db, config, p.project_id);
  }
  if (/^d\d+$/.test(ref)) {
    const d = db.query("SELECT d.task_id, r.task_id AS run_task FROM divergences d LEFT JOIN runs r ON r.id = d.run_id WHERE d.id = ?1").get(ref) as { task_id: string | null; run_task: string | null } | null;
    if (d) return ofTask(d.task_id ?? d.run_task);
  }
  if (/^i\d+$/.test(ref)) {
    const i = db.query("SELECT i.task_id, r.task_id AS run_task FROM items i LEFT JOIN runs r ON r.id = i.run_id WHERE i.id = ?1").get(ref) as { task_id: string | null; run_task: string | null } | null;
    if (i) return ofTask(i.task_id ?? i.run_task);
  }
  if (/^vq?\d+$/.test(ref)) {
    const v = db.query(`SELECT project_id, task_id FROM ${ref.startsWith("vq") ? "verify_queue" : "verifications"} WHERE id = ?1`).get(ref) as { project_id: string; task_id: string | null } | null;
    if (v) return v.task_id ? ofTask(v.task_id) : projectScopeById(db, config, v.project_id);
  }
  if (ref.startsWith("merge:")) return ofTask(ref.slice("merge:".length));
  const run = db.query("SELECT task_id FROM runs WHERE id = ?1").get(ref) as { task_id: string } | null;
  if (run) return ofTask(run.task_id);
  if (taskKnown(db, ref)) return taskScope(db, config, ref);
  return undefined;
}

function taskKnown(db: Db, taskId: string): boolean {
  if (db.query("SELECT 1 FROM task_policy WHERE task_id = ?1 UNION SELECT 1 FROM task_scopes WHERE task_id = ?1 UNION SELECT 1 FROM plan_phases WHERE task_id = ?1 UNION SELECT 1 FROM drops WHERE task_id = ?1").get(taskId)) return true;
  return (["backlog", "todos"] as const).some((file) => readSnapshot(db, file)?.tasks.some((t) => t.id === taskId) ?? false);
}

/** May a caller of this scope see a thing of that scope? */
export function sees(config: FlowrynConfig, scope: string | undefined, thing: ThingScope): boolean {
  if (unrestricted(config, scope)) return true;
  if (thing === GLOBAL) return true;
  return thing !== null && thing === scope;
}

/** A predicate over task ids for one caller, memoized for one read. */
export function taskFilter(db: Db, config: FlowrynConfig, scope: string | undefined): (taskId: string | null | undefined) => boolean {
  if (unrestricted(config, scope)) return () => true;
  const memo = new Map<string, boolean>();
  return (taskId) => {
    if (!taskId) return true;
    let seen = memo.get(taskId);
    if (seen === undefined) {
      seen = sees(config, scope, taskScope(db, config, taskId));
      memo.set(taskId, seen);
    }
    return seen;
  };
}

/** A predicate over project ids for one caller. */
export function projectFilter(db: Db, config: FlowrynConfig, scope: string | undefined): (projectId: string) => boolean {
  if (unrestricted(config, scope)) return () => true;
  return (projectId) => sees(config, scope, projectScopeById(db, config, projectId));
}

/** An item (or anything with a task and a run) a caller of this scope may see. */
export function itemFilter(db: Db, config: FlowrynConfig, scope: string | undefined): (item: { task_id: string | null; run_id?: string | null }) => boolean {
  const byTask = taskFilter(db, config, scope);
  if (unrestricted(config, scope)) return () => true;
  return (item) => {
    if (item.task_id) return byTask(item.task_id);
    if (item.run_id) {
      const run = db.query("SELECT task_id FROM runs WHERE id = ?1").get(item.run_id) as { task_id: string } | null;
      return byTask(run?.task_id ?? null);
    }
    return true;
  };
}

/** An item as the lens shows it: its line, and the untruncated one. */
export interface ShownItem {
  id: string;
  kind: string;
  task_id: string | null;
  run_id?: string | null;
  line: string;
  full_line?: string | null;
}

/**
 * Item kinds that belong to no task and whose lines never name one: every
 * scope's leader sees them whole. Any other task-less item (a GitHub outage
 * listing the merges that wait, runs waiting for capacity, a dropped restart, a
 * failed build) may name another scope's tasks, so a scoped leader gets a fixed
 * line instead (redact); your own terminal shows it whole.
 */
export const PLAIN_GLOBAL_KINDS: ReadonlySet<string> = new Set(["contract_recorded", "nomistakes_down", "herdr_unreachable"]);

/** The fixed line a scoped leader sees for a task-less item that may name other scopes' tasks. */
export function neutralLine(item: Pick<ShownItem, "id" | "kind">): string {
  return `${item.kind.replaceAll("_", " ")}: its details may name other scopes' tasks, so only the user's own terminal shows them (flowryn show ${item.id} there)`;
}

/** What one caller may see, for a read or a push: predicates over tasks, items and projects. */
export interface ScopeLens {
  /** False for your terminal and for a home with one scope: nothing is filtered. */
  restricted: boolean;
  scope: string | undefined;
  task(taskId: string | null | undefined): boolean;
  item(item: { task_id: string | null; run_id?: string | null }): boolean;
  project(projectId: string): boolean;
  /** The item as this caller is shown it: a task-less item that may name other scopes' tasks gets its neutral line. */
  redact<T extends ShownItem>(item: T): T;
}

export const SEES_ALL: ScopeLens = { restricted: false, scope: undefined, task: () => true, item: () => true, project: () => true, redact: (item) => item };

function redactGlobal<T extends ShownItem>(item: T): T {
  if (item.task_id || item.run_id || PLAIN_GLOBAL_KINDS.has(item.kind)) return item;
  const line = neutralLine(item);
  return { ...item, line, full_line: item.full_line === undefined ? undefined : line };
}

/** The lens for a caller of `scope`; without a config (a test's bare read) it sees all. */
export function lensFor(db: Db, config: FlowrynConfig | undefined, scope: string | undefined): ScopeLens {
  if (!config || unrestricted(config, scope)) return SEES_ALL;
  return { restricted: true, scope, task: taskFilter(db, config, scope), item: itemFilter(db, config, scope), project: projectFilter(db, config, scope), redact: redactGlobal };
}

/** The lens of a leader session, by its recorded scope. */
export function sessionLens(db: Db, config: FlowrynConfig | undefined, sessionId: string | null): ScopeLens {
  if (!sessionId) return SEES_ALL;
  const row = db.query("SELECT scope FROM leader_sessions WHERE session_id = ?1").get(sessionId) as { scope: string } | null;
  return lensFor(db, config, row?.scope ?? UNCONFIRMED_SCOPE);
}

function refused(what: string, scope: string | undefined): FlowrynError {
  const mine = scope === UNCONFIRMED_SCOPE ? "this session's login is not confirmed, so it sees no scope" : `this leader sees only scope ${scope}`;
  return new FlowrynError("scope_refused", `${what} is outside this leader's scope: ${mine}`, "the leader of that scope, or your own terminal, can do it");
}

/**
 * The gateway's scope check for one call (both the daemon and the read-only
 * fallback run it): a reference or project argument outside the caller's scope
 * refuses, and the refusal is recorded. A verb a leader or reader can call
 * that declares no scope refuses for a scoped caller: fail closed.
 */
export function enforceScope(spec: VerbSpec, db: Db, config: FlowrynConfig, caller: Caller, args: Args, record?: (refusal: { verb: string; ref: string }) => void): void {
  if (caller.role !== "leader" && caller.role !== "reader") return;
  if (unrestricted(config, caller.scope)) return;
  const rule = spec.scope;
  if (!rule) throw refused(spec.name, caller.scope);
  if (rule.kind === "none" || rule.kind === "list" || rule.kind === "self") return;
  const check = (arg: string, asProject: boolean, optional: boolean) => {
    const value = stringArg(args, arg);
    if (value === undefined) {
      if (optional) return;
      throw refused(spec.name, caller.scope);
    }
    const thing = asProject ? projectRefScope(db, config, value) : refScope(db, config, value);
    if (thing === undefined || sees(config, caller.scope, thing)) return;
    record?.({ verb: spec.name, ref: value });
    throw refused(value, caller.scope);
  };
  check(rule.arg, rule.kind === "project", rule.optional === true);
  if (rule.kind === "ref" && rule.project) check(rule.project, true, true);
}

/** A project argument's scope; undefined for a project nobody registered (the verb says so). */
export function projectRefScope(db: Db, config: FlowrynConfig, projectId: string): ThingScope | undefined {
  return db.query("SELECT 1 FROM projects WHERE id = ?1").get(projectId) ? projectScopeById(db, config, projectId) : undefined;
}

/**
 * A task a scoped leader creates with no project (a to-do, a standalone decision) stays in its
 * scope. Your terminal's go to the default scope, recorded by leaving them out. Inside a transaction.
 */
export function recordTaskScope(db: Db, caller: Caller, taskId: string): void {
  if ((caller.role !== "leader" && caller.role !== "reader") || caller.scope === undefined || caller.scope === UNCONFIRMED_SCOPE) return;
  db.query("INSERT OR IGNORE INTO task_scopes (task_id, scope) VALUES (?1, ?2)").run(taskId, caller.scope);
}

/** Refuse a scoped caller acting on a thing outside its scope (for verbs with scope "self"). */
export function requireInScope(config: FlowrynConfig, caller: Caller, thing: ThingScope | undefined, what: string): void {
  if (caller.role !== "leader" && caller.role !== "reader") return;
  if (thing === undefined || sees(config, caller.scope, thing)) return;
  throw refused(what, caller.scope);
}

/** Record a scope refusal (no content: the verb and the reference only). Call inside a transaction. */
export function recordScopeRefusal(db: Db, caller: Caller, refusal: { verb: string; ref: string }, now: number): void {
  appendEvent(db, { source: "cli", kind: "leader.scope_refused", payload: { session: caller.session ?? null, scope: caller.scope ?? null, verb: refusal.verb, ref: refusal.ref }, ts: now });
}

/**
 * Rows written before scopes took the implicit scope `default`; when config
 * names another default scope and has no scope called `default`, they move to
 * it, so the leader leading before the upgrade keeps leading. The daemon calls
 * this at start and after every config reload. Inside a transaction.
 */
export function adoptLegacyScope(db: Db, config: FlowrynConfig, now: number): number {
  const ids = scopeIds(config);
  if (ids.length === 0 || ids.includes(LEGACY_SCOPE)) return 0;
  const target = defaultScope(config);
  let moved = 0;
  const legacy = db.query("SELECT session_id FROM leader_lease WHERE scope = ?1").get(LEGACY_SCOPE) as { session_id: string | null } | null;
  if (legacy) {
    const taken = db.query("SELECT session_id FROM leader_lease WHERE scope = ?1").get(target) as { session_id: string | null } | null;
    if (!taken) moved += db.query("UPDATE leader_lease SET scope = ?2 WHERE scope = ?1").run(LEGACY_SCOPE, target).changes;
    else db.query("DELETE FROM leader_lease WHERE scope = ?1").run(LEGACY_SCOPE);
  }
  moved += db.query("UPDATE leader_sessions SET scope = ?2 WHERE scope = ?1").run(LEGACY_SCOPE, target).changes;
  if (moved > 0) appendEvent(db, { source: "daemon", kind: "leader.scope_adopted", payload: { from: LEGACY_SCOPE, to: target, rows: moved }, ts: now });
  return moved;
}

/** The other scopes' counts of what waits for their leader, for a briefing: numbers only, never content. */
export function otherScopeCounts(db: Db, config: FlowrynConfig, scope: string | undefined): { scope: string; items: number }[] {
  if (unrestricted(config, scope) || scope === UNCONFIRMED_SCOPE) return [];
  const rows = db.query("SELECT task_id, run_id FROM items WHERE class = 'actionable' AND state IN ('open','presented') AND lane IN ('P0','P1')").all() as { task_id: string | null; run_id: string | null }[];
  const counts = new Map<string, number>();
  for (const row of rows) {
    let taskId = row.task_id;
    if (!taskId && row.run_id) taskId = (db.query("SELECT task_id FROM runs WHERE id = ?1").get(row.run_id) as { task_id: string } | null)?.task_id ?? null;
    if (!taskId) continue;
    const thing = taskScope(db, config, taskId);
    if (thing === null || thing === GLOBAL || thing === scope) continue;
    counts.set(thing, (counts.get(thing) ?? 0) + 1);
  }
  return [...counts.entries()].map(([s, items]) => ({ scope: s, items })).toSorted((a, b) => a.scope.localeCompare(b.scope));
}
