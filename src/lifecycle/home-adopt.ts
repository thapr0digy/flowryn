import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { FlowrynError } from "../api/errors.ts";
import { stringArg, type HandlerCtx, type HandlerResult, type VerbSpec } from "../api/verbs.ts";
import { accountsConfig, harnessAccounts, projectScope, type AccountsConfig } from "../config/accounts.ts";
import { loadConfig, resolveTool, type FlowrynConfig } from "../config/config.ts";
import { expandHome, runDir, stateFiles } from "../config/paths.ts";
import { workersConfig } from "../config/workers.ts";
import { workflowFor } from "../config/workflows.ts";
import { PING_VERB } from "../daemon/system-verbs.ts";
import { openDb, schemaVersion, LATEST_SCHEMA_VERSION, type Db } from "../db/db.ts";
import { appendEvent, type EventRow } from "../db/events.ts";
import { normalizedTitle } from "../journal/diff.ts";
import { recordIntent, type FlagValue } from "../journal/journal.ts";
import { listTasks, processRunner, type BacklogTask } from "../journal/tasks-axi.ts";
import { request } from "../transport/unix.ts";
import { isLockHeld } from "../util/flock.ts";
import { ulid } from "../util/ulid.ts";
import { PROTO } from "../version.ts";
import { blockersOf, nextPlanId, takenIds, type PhaseRow, type PlanRow } from "./plans.ts";
import { getProject, listProjects, type ProjectRow } from "./projects.ts";
import { TERMINAL_STATES } from "./runs.ts";
import { todoViews } from "./todos.ts";

/**
 * `flowryn home adopt <old home>` (docs/notes/2026-10-24-leader-scoping-and-vj.md,
 * phase 2): move an idle second Flowryn home's queued work into this one, under
 * one scope, and leave the old home as a read-only archive whose daemon refuses
 * to start. Every step is a rule: nothing here needs a model.
 *
 * The old home is read, never written, apart from its `adopted.json` marker:
 * its database read-only, its backlog and to-dos through tasks-axi `list`.
 * What moves goes in through this home's own channels in one transaction:
 * projects and policy rows straight into flowryn.db, backlog and to-do adds
 * (and holds) through `recordIntent`, with one `home.adopted` event naming every old to
 * new id and every dropped edge.
 */

export const ADOPTED_MARKER = "adopted.json";
const ADOPTED_EVENT = "home.adopted";
const PING_CONNECT_MS = 300;
const PING_REPLY_MS = 2_000;

/** What `<old home>/adopted.json` holds. */
export interface AdoptedMarker {
  adopted_into: string;
  at: string;
  scope: string;
  projects: string[];
  tasks: string[];
  todos: string[];
  plans: Record<string, string>;
}

/** The marker of an adopted home, or null. A marker that cannot be read still marks the home adopted. */
export function readAdoptedMarker(home: string): AdoptedMarker | { unreadable: string } | null {
  const path = join(home, ADOPTED_MARKER);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as AdoptedMarker;
  } catch (error) {
    return { unreadable: (error as Error).message };
  }
}

/** The line the old home's daemon prints when it refuses to start. */
export function adoptedLine(home: string, marker: AdoptedMarker | { unreadable: string }): string {
  if ("unreadable" in marker) return `home_adopted: ${home} was adopted into another Flowryn home (its ${ADOPTED_MARKER} cannot be read: ${marker.unreadable}); this daemon stays stopped`;
  return `home_adopted: ${home} was adopted into ${marker.adopted_into} on ${marker.at}; its work runs there now, and this daemon stays stopped`;
}

function refuse(message: string, help?: string): never {
  throw new FlowrynError("adopt_refused", message, help);
}

function real(path: string): string {
  return existsSync(path) ? realpathSync(path) : path;
}

/** The old home as an absolute real path; never this home. */
function oldHomePath(raw: string, mainHome: string): string {
  const expanded = expandHome(raw.trim());
  if (!isAbsolute(expanded)) throw new FlowrynError("bad_args", `the old home must be an absolute path, not ${raw}`, "flowryn home adopt ~/.flowryn-work");
  if (!existsSync(expanded)) throw new FlowrynError("not_found", `no such directory: ${expanded}`);
  const home = realpathSync(expanded);
  if (home === real(mainHome)) refuse(`${home} is this Flowryn home`, "name the other home, such as ~/.flowryn-work");
  if (!existsSync(join(home, "config.toml"))) refuse(`${home} has no config.toml, so it is not a Flowryn home`);
  return home;
}

/** The home.adopted event this home recorded for that old home, if any. */
function priorAdoption(db: Db, oldHome: string): { seq: number; payload: AdoptionPayload } | null {
  const rows = db.query("SELECT seq, payload FROM events WHERE kind = ?1 ORDER BY seq DESC").all(ADOPTED_EVENT) as Pick<EventRow, "seq" | "payload">[];
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as AdoptionPayload;
    if (payload.old_home === oldHome) return { seq: row.seq, payload };
  }
  return null;
}

async function socketAnswers(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  try {
    await request(path, { proto: PROTO, ulid: ulid(), verb: PING_VERB, args: {} }, { connectMs: PING_CONNECT_MS, replyMs: PING_REPLY_MS });
    return true;
  } catch {
    return false;
  }
}

type Row = Record<string, string | number | null>;

/** What the old home holds that adoption reads: rows from its database, its backlog and its to-dos. */
export interface OldHome {
  home: string;
  config: FlowrynConfig;
  projects: ProjectRow[];
  policies: Row[];
  plans: PlanRow[];
  phases: PhaseRow[];
  backlog: BacklogTask[];
  todos: BacklogTask[];
}

function readOldDb(path: string): Pick<OldHome, "projects" | "policies" | "plans" | "phases"> {
  if (!existsSync(path)) refuse(`the old home has no database at ${path}`);
  const db = openDb(path, { readonly: true });
  try {
    const version = schemaVersion(db);
    // Rows are copied column for column, so both databases must have this build's schema.
    if (version > LATEST_SCHEMA_VERSION) refuse(`the old home's database is at schema ${version}, newer than this build's ${LATEST_SCHEMA_VERSION}`, "install the newer flowryn, then adopt");
    if (version < LATEST_SCHEMA_VERSION) refuse(`the old home's database is at schema ${version}, older than this build's ${LATEST_SCHEMA_VERSION}`, "start its daemon once with this build so it migrates, stop it, then adopt");
    const openRuns = db.query(`SELECT id, task_id, state FROM runs WHERE state NOT IN (${TERMINAL_STATES.map((s) => `'${s}'`).join(", ")}) ORDER BY id`).all() as { id: string; task_id: string; state: string }[];
    if (openRuns.length > 0) refuse(`the old home has runs that have not ended: ${openRuns.map((r) => `${r.id} (${r.task_id}, ${r.state})`).join(", ")}`, "let them finish or cancel them in the old home, then adopt");
    const decisions = db.query("SELECT id FROM decisions WHERE state = 'open' ORDER BY id").all() as { id: string }[];
    if (decisions.length > 0) refuse(`the old home has open decisions: ${decisions.map((d) => d.id).join(", ")}`, "answer or dismiss them in the old home, then adopt");
    const gates = db.query("SELECT id, kind FROM gates WHERE state = 'open' ORDER BY id").all() as { id: string; kind: string }[];
    if (gates.length > 0) refuse(`the old home has open gates: ${gates.map((g) => `${g.id} (${g.kind})`).join(", ")}`, "pass them or send changes in the old home, then adopt");
    // A pending backlog write means the old backlog file is not yet what its database says it is.
    const intents = db.query("SELECT COUNT(*) AS n FROM intents WHERE state = 'pending'").get() as { n: number };
    if (intents.n > 0) refuse(`the old home has ${intents.n} backlog write(s) still pending`, "start its daemon until they apply, stop it, then adopt");
    return {
      projects: db.query("SELECT * FROM projects ORDER BY id").all() as ProjectRow[],
      policies: db.query("SELECT * FROM task_policy ORDER BY task_id").all() as Row[],
      plans: db.query("SELECT * FROM plans ORDER BY created_at, id").all() as PlanRow[],
      phases: db.query("SELECT * FROM plan_phases ORDER BY plan_id, phase_no").all() as PhaseRow[],
    };
  } catch (error) {
    if (error instanceof FlowrynError) throw error;
    refuse(`cannot read the old home's database ${path}: ${(error as Error).message}`);
  } finally {
    db.close();
  }
}

/**
 * Read the old home, refusing while anything there is live: its daemon
 * answering or holding its lock, a run not ended, an open decision or gate, a
 * pending backlog write, a task In flight.
 */
export async function inspectOldHome(mainConfig: FlowrynConfig, home: string): Promise<OldHome> {
  let config: FlowrynConfig;
  try {
    config = loadConfig(home).config;
  } catch (error) {
    refuse(`the old home's config.toml cannot be read: ${(error as Error).message}`);
  }
  if (await socketAnswers(join(runDir(home), "flowrynd.sock"))) refuse(`the old home's daemon answers on ${join(runDir(home), "flowrynd.sock")}`, `stop it first: FLOWRYN_HOME=${home} flowryn daemon stop`);
  const files = stateFiles(config.state_dir);
  if (existsSync(files.lock) && isLockHeld(files.lock)) refuse(`a daemon holds the old home's lock ${files.lock}`, `stop it first: FLOWRYN_HOME=${home} flowryn daemon stop`);
  const rows = readOldDb(files.db);
  const tasksAxi = resolveTool(mainConfig, "tasks_axi");
  if (!tasksAxi || !existsSync(tasksAxi)) throw new FlowrynError("tool_missing", "tasks-axi is not installed, so the old backlog cannot be read");
  const runner = processRunner(tasksAxi, resolveTool(mainConfig, "node"));
  const read = async (file: string): Promise<BacklogTask[]> => {
    if (!existsSync(file)) return [];
    try {
      return await listTasks(runner, file);
    } catch (error) {
      refuse(`cannot read ${file}: ${(error as Error).message}`);
    }
  };
  const backlog = await read(config.tasks.backlog);
  const todos = await read(config.tasks.todos);
  const inFlight = [...backlog, ...todos].filter((t) => t.state === "in_flight").map((t) => t.id);
  if (inFlight.length > 0) refuse(`the old home has tasks In flight: ${inFlight.join(", ")}`, "finish them or move them back to Queued in the old home, then adopt");
  return { home, config, ...rows, backlog, todos };
}

/** The scope the old home's work joins: --scope, else the scope of the declared Claude account on the old home's [workers.claude] config_dir. */
function adoptScope(config: FlowrynConfig, accounts: AccountsConfig, old: OldHome, requested: string | undefined): string {
  if (requested !== undefined) {
    if (!accounts.scopes[requested]) refuse(`no scope ${requested} in this home's config`, `scopes: ${Object.keys(accounts.scopes).join(", ")}`);
    return requested;
  }
  const dir = workersConfig(old.config).claude.config_dir;
  if (dir === null) refuse("the old home sets no [workers.claude] config_dir to match an account by", "pass --scope <id>");
  const matches = harnessAccounts(config, "claude").filter((a) => a.declared && a.config_dir !== null && real(a.config_dir) === real(dir));
  if (matches.length !== 1) {
    refuse(
      matches.length === 0
        ? `no declared Claude account in this home's config uses ${dir}, the old home's [workers.claude] config_dir`
        : `accounts ${matches.map((a) => a.id).join(" and ")} all use ${dir}`,
      "declare the account in [accounts], or pass --scope <id>",
    );
  }
  return matches[0]!.scope;
}

export interface DroppedEdge {
  task: string;
  blocked_by: string;
  why: "landed" | "not queued" | "to-do";
}

export interface AdoptionPayload {
  old_home: string;
  scope: string;
  projects: { added: string[]; skipped: string[] };
  tasks: Record<string, string>;
  todos: Record<string, string>;
  plans: Record<string, string>;
  dropped_edges: DroppedEdge[];
}

/** Adds in an order where each task's kept blockers come first (tasks-axi --blocked-by needs them to exist). */
function blockersFirst(tasks: BacklogTask[], kept: Map<string, string[]>): BacklogTask[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out: BacklogTask[] = [];
  const seen = new Set<string>();
  const visit = (task: BacklogTask, path: Set<string>) => {
    if (seen.has(task.id) || path.has(task.id)) return;
    path.add(task.id);
    for (const dep of kept.get(task.id) ?? []) visit(byId.get(dep)!, path);
    path.delete(task.id);
    seen.add(task.id);
    out.push(task);
  };
  for (const task of tasks) visit(task, new Set());
  return out;
}

function backlogFlags(task: BacklogTask, blockers: string[]): Record<string, FlagValue> {
  const flags: Record<string, FlagValue> = {};
  if (task.kind) flags.kind = task.kind;
  if (task.repo) flags.repo = task.repo;
  if (task.body.length > 0) flags.body = task.body;
  if (task.priority !== null) flags.priority = String(task.priority);
  if (blockers.length > 0) flags["blocked-by"] = blockers;
  for (const link of task.links) {
    const at = link.indexOf(":");
    const kind = link.slice(0, at);
    const target = link.slice(at + 1);
    if ((kind === "pr" || kind === "report") && target.length > 0) flags[kind] = target;
  }
  return flags;
}

function holdFlags(hold: NonNullable<BacklogTask["hold"]>): Record<string, FlagValue> {
  const flags: Record<string, FlagValue> = { reason: hold.reason ?? "held in the home it was adopted from" };
  if (hold.kind) flags.kind = hold.kind;
  if (hold.until) flags.until = hold.until;
  return flags;
}

/** The projects that move: inserted, or skipped when this home has the same id at the same path. Refuses a clash or a scope mismatch. */
function adoptProjects(db: Db, config: FlowrynConfig, accounts: AccountsConfig, old: OldHome, scope: string): { added: ProjectRow[]; skipped: string[] } {
  const added: ProjectRow[] = [];
  const skipped: string[] = [];
  const mine = listProjects(db);
  for (const project of old.projects) {
    let own: string;
    try {
      own = projectScope(config, accounts, project);
    } catch (error) {
      refuse(`project ${project.id}: ${(error as Error).message}`);
    }
    if (own !== scope) {
      refuse(
        `project ${project.id} (${project.path}) is in scope ${own} under this home's config, not ${scope}`,
        `add its folder to [scopes.${scope}] paths (such as "${dirname(project.path)}/") or set [projects.${project.id}] scope = "${scope}", reload, then adopt`,
      );
    }
    try {
      workflowFor(config, project.workflow, "ship");
    } catch (error) {
      refuse(`project ${project.id}'s workflow: ${(error as Error).message}`, "add the workflow to this home's [workflows], then adopt");
    }
    const existing = getProject(db, project.id);
    if (existing) {
      if (real(existing.path) !== real(project.path)) refuse(`project ${project.id} is already registered here at ${existing.path}, not ${project.path}`);
      skipped.push(project.id);
      continue;
    }
    const samePath = mine.find((p) => real(p.path) === real(project.path));
    if (samePath) refuse(`${project.path} is already registered here as project ${samePath.id}, not ${project.id}`);
    added.push(project);
  }
  return { added, skipped };
}

function insertAdoptedProject(db: Db, p: ProjectRow & { import_source?: string | null }): void {
  db.query(
    `INSERT INTO projects (id, repo_url, path, default_branch, delivery_mode, yolo, priority, harness, workflow, autonomy, import_source)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  ).run(p.id, p.repo_url, p.path, p.default_branch, p.delivery_mode, p.yolo, p.priority, p.harness, p.workflow, p.autonomy, p.import_source ?? null);
}

function insertPolicy(db: Db, row: Row): void {
  db.query(
    `INSERT INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, sensitive, workflow, auto, reason, created_at, import_source, mode_reason, base_branch)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
  ).run(row.task_id!, row.project_id!, row.kind!, row.delivery_mode!, row.yolo!, row.sensitive ?? 0, row.workflow!, row.auto ?? 0, row.reason ?? null, row.created_at!, row.import_source ?? null, row.mode_reason ?? null, row.base_branch ?? null);
}

/**
 * Move the old home's work in. Call inside the verb's transaction: projects,
 * policy rows, plans and phases straight in, backlog and to-do adds (and holds)
 * through recordIntent, and one home.adopted event.
 */
export function adoptHome(db: Db, config: FlowrynConfig, old: OldHome, requestedScope: string | undefined, now: number): AdoptionPayload {
  let accounts: AccountsConfig;
  try {
    accounts = accountsConfig(config);
  } catch (error) {
    refuse(`this home's accounts config is invalid: ${(error as Error).message}`);
  }
  const scope = adoptScope(config, accounts, old, requestedScope);
  const projects = adoptProjects(db, config, accounts, old, scope);

  const queued = old.backlog.filter((t) => t.state === "queued");
  const openTodos = old.todos.filter((t) => t.state !== "done");
  const taken = takenIds(db);
  const takenTodos = new Set(todoViews(db).map((v) => v.id));
  const clashes = [...queued, ...openTodos].map((t) => t.id).filter((id) => taken(id) || takenTodos.has(id));
  if (clashes.length > 0) refuse(`task ids already in this home: ${[...new Set(clashes)].join(", ")}`, "drop or finish them here, or rename them in the old home's backlog, then adopt");

  const moved = new Set(queued.map((t) => t.id));
  const policies = old.policies.filter((p) => moved.has(String(p.task_id)));
  for (const policy of policies) {
    try {
      workflowFor(config, String(policy.workflow), policy.kind === "scout" ? "scout" : "ship");
    } catch (error) {
      refuse(`task ${policy.task_id}'s workflow: ${(error as Error).message}`, "add the workflow to this home's [workflows], then adopt");
    }
  }

  // A blocker that landed in the old home, or never reached its queue, has nothing left to wait for here.
  const done = new Set(old.backlog.filter((t) => t.state === "done").map((t) => t.id));
  const dropped: DroppedEdge[] = [];
  const kept = new Map<string, string[]>();
  for (const task of queued) {
    const blockers = blockersOf(task);
    kept.set(task.id, blockers.filter((b) => moved.has(b)));
    for (const gone of blockers.filter((b) => !moved.has(b))) dropped.push({ task: task.id, blocked_by: gone, why: done.has(gone) ? "landed" : "not queued" });
  }

  for (const project of projects.added) insertAdoptedProject(db, project);
  for (const policy of policies) insertPolicy(db, policy);

  const planIds: Record<string, string> = {};
  for (const plan of old.plans.filter((p) => p.state === "approved")) {
    const phases = old.phases.filter((ph) => ph.plan_id === plan.id && moved.has(ph.task_id));
    if (phases.length === 0) continue;
    const id = nextPlanId(db);
    planIds[plan.id] = id;
    // The old gate id names a gate of the old home, so it is not carried over.
    db.query(
      "INSERT INTO plans (id, project_id, title, state, source_task, gate_id, filed_by, created_at, approved_at, approved_via) VALUES (?1, ?2, ?3, 'approved', ?4, NULL, ?5, ?6, ?7, ?8)",
    ).run(id, plan.project_id, plan.title, plan.source_task, plan.filed_by, plan.created_at, plan.approved_at, plan.approved_via);
    for (const phase of phases) {
      const deps = JSON.parse(phase.blocked_by) as string[];
      for (const dep of deps.filter((d) => !moved.has(d))) {
        if (!dropped.some((e) => e.task === phase.task_id && e.blocked_by === dep)) dropped.push({ task: phase.task_id, blocked_by: dep, why: done.has(dep) ? "landed" : "not queued" });
      }
      db.query(
        "INSERT INTO plan_phases (plan_id, phase_no, task_id, title, body, workflow, harness, blocked_by, account, model, effort) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
      ).run(
        id,
        phase.phase_no,
        phase.task_id,
        phase.title,
        phase.body,
        phase.workflow,
        phase.harness,
        JSON.stringify(deps.filter((d) => moved.has(d))),
        phase.account,
        phase.model,
        phase.effort,
      );
    }
  }

  const withPolicy = new Set(policies.map((p) => String(p.task_id)));
  const ownProject = new Set(old.projects.map((p) => p.id));
  const pinScope = (taskId: string) => db.query("INSERT OR REPLACE INTO task_scopes (task_id, scope) VALUES (?1, ?2)").run(taskId, scope);
  const tasks: Record<string, string> = {};
  for (const task of blockersFirst(queued, kept)) {
    recordIntent(db, { file: "backlog", verb: "add", taskId: task.id, positional: [task.id, normalizedTitle(task)], flags: backlogFlags(task, kept.get(task.id) ?? []), now });
    if (task.hold) recordIntent(db, { file: "backlog", verb: "hold", taskId: task.id, positional: [task.id], flags: holdFlags(task.hold), now });
    // A task with no project of its own would otherwise fall into this home's default scope.
    if (!withPolicy.has(task.id) && !(task.repo && ownProject.has(task.repo))) pinScope(task.id);
    tasks[task.id] = task.id;
  }
  const todos: Record<string, string> = {};
  for (const todo of openTodos) {
    const flags: Record<string, FlagValue> = { kind: todo.kind ?? "todo" };
    if (todo.body.length > 0) flags.body = todo.body;
    if (todo.priority !== null) flags.priority = String(todo.priority);
    recordIntent(db, { file: "todos", verb: "add", taskId: todo.id, positional: [todo.id, normalizedTitle(todo)], flags, now });
    if (todo.hold) recordIntent(db, { file: "todos", verb: "hold", taskId: todo.id, positional: [todo.id], flags: holdFlags(todo.hold), now });
    for (const gone of blockersOf(todo)) dropped.push({ task: todo.id, blocked_by: gone, why: "to-do" });
    pinScope(todo.id);
    todos[todo.id] = todo.id;
  }

  const payload: AdoptionPayload = {
    old_home: old.home,
    scope,
    projects: { added: projects.added.map((p) => p.id), skipped: projects.skipped },
    tasks,
    todos,
    plans: planIds,
    dropped_edges: dropped,
  };
  appendEvent(db, { source: "cli", kind: ADOPTED_EVENT, payload, ts: now });
  return payload;
}

/** Write `<old home>/adopted.json` whole (a temporary file renamed over it). */
export function writeAdoptedMarker(oldHome: string, mainHome: string, payload: AdoptionPayload, at: number): AdoptedMarker {
  const marker: AdoptedMarker = {
    adopted_into: mainHome,
    at: new Date(at).toISOString(),
    scope: payload.scope,
    projects: [...payload.projects.added, ...payload.projects.skipped],
    tasks: Object.keys(payload.tasks),
    todos: Object.keys(payload.todos),
    plans: payload.plans,
  };
  const path = join(oldHome, ADOPTED_MARKER);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return marker;
}

type Prepared = { kind: "rerun"; home: string } | { kind: "adopt"; old: OldHome };

function summary(payload: AdoptionPayload, already: boolean, at: number): Record<string, unknown> {
  return {
    old_home: payload.old_home,
    already_adopted: already,
    scope: payload.scope,
    projects_added: payload.projects.added,
    projects_skipped: payload.projects.skipped,
    tasks: Object.keys(payload.tasks),
    todos: Object.keys(payload.todos),
    plans: Object.entries(payload.plans).map(([from, to]) => `${from} → ${to}`),
    dropped_edges: payload.dropped_edges.map((e) => `${e.task} blocked-by ${e.blocked_by} (${e.why})`),
    at,
  };
}

const homeAdopt: VerbSpec = {
  name: "home adopt",
  summary: "Move an idle second Flowryn home's projects, queued tasks, to-dos and plans into this one",
  positionals: [{ name: "home", required: true, help: "the old Flowryn home, such as ~/.flowryn-work" }],
  flags: {
    scope: { type: "string", help: "the scope its work joins (default: the scope of the account on its [workers.claude] config_dir)", placeholder: "id" },
  },
  kind: "mutation",
  roles: ["human"],
  async prepare(ctx, args): Promise<Prepared> {
    const home = oldHomePath(stringArg(args, "home")!, ctx.config().home);
    if (priorAdoption(ctx.db, home)) return { kind: "rerun", home };
    return { kind: "adopt", old: await inspectOldHome(ctx.config(), home) };
  },
  apply(ctx, args, prepared): HandlerResult {
    const p = prepared as Prepared;
    const home = p.kind === "rerun" ? p.home : p.old.home;
    // Looked up again inside the transaction: two adopts of one home at once record one adoption.
    const prior = priorAdoption(ctx.db, home);
    if (prior) return { data: summary(prior.payload, true, ctx.now()), hints: ["flowryn board"] };
    if (p.kind === "rerun") throw new Error(`home.adopted event for ${home} vanished`);
    const payload = adoptHome(ctx.db, ctx.config(), p.old, stringArg(args, "scope"), ctx.now());
    return { data: summary(payload, false, ctx.now()), hints: ["flowryn board", "flowryn todo list"] };
  },
  async settle(ctx: HandlerCtx, result: HandlerResult): Promise<HandlerResult> {
    const home = String(result.data.old_home);
    const prior = priorAdoption(ctx.db, home);
    if (!prior) return result;
    writeAdoptedMarker(home, ctx.config().home, prior.payload, Number(result.data.at));
    return { ...result, data: { ...result.data, marker: join(home, ADOPTED_MARKER) } };
  },
};

export const HOME_VERBS: VerbSpec[] = [homeAdopt];
