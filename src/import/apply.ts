import { FlowrynError } from "../api/errors.ts";
import { stringArg, type Args, type VerbSpec } from "../api/verbs.ts";
import { decisionsConfig, reservedReason } from "../attention/decisions-policy.ts";
import { setMeta } from "../db/db.ts";
import { defaultAutonomy } from "../config/workflows.ts";
import { createStandaloneDecision, DECISION_KEY } from "../lifecycle/decisions.ts";
import { DELIVERY_MODES, getProject, inspectRepo, insertProject, PROJECT_ID, type ProjectRow, type RepoFacts } from "../lifecycle/projects.ts";
import { takenIds } from "../lifecycle/plans.ts";
import { queueTask } from "../lifecycle/queued.ts";
import type { FmDecision } from "./firstmate.ts";

/**
 * `import.apply` (cutover C3): the daemon half of `flowryn import firstmate`.
 * The CLI parses the Firstmate home and clones; this records what it found:
 * projects, queued tasks and decisions, each marked firstmate:<id>, so a
 * second run reports exists and changes nothing. Your own terminal only.
 */

export interface ImportPlan {
  projects: { name: string; path: string; mode: string; yolo: boolean }[];
  tasks: { id: string; project: string; kind: "ship" | "scout"; title: string; body: string; priority: number | null; blockedBy: string[] }[];
  decisions: FmDecision[];
}

export interface PlanRow {
  item: string;
  kind: "project" | "task" | "decision";
  action: "create" | "exists" | "refuse" | "warn";
  reason: string;
}

const source = (id: string) => `firstmate:${id}`;

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

function checkProject(raw: unknown): ImportPlan["projects"][number] {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (!isStr(o.name) || !isStr(o.path) || !isStr(o.mode) || typeof o.yolo !== "boolean") {
    throw new FlowrynError("bad_args", "each plan project needs a string name, path, mode and a boolean yolo");
  }
  return { name: o.name, path: o.path, mode: o.mode, yolo: o.yolo };
}

function checkTask(raw: unknown): ImportPlan["tasks"][number] {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const okPriority = o.priority === null || typeof o.priority === "number";
  const okBlockedBy = Array.isArray(o.blockedBy) && o.blockedBy.every(isStr);
  if (!isStr(o.id) || !isStr(o.project) || !isStr(o.title) || !isStr(o.body) || (o.kind !== "ship" && o.kind !== "scout") || !okPriority || !okBlockedBy) {
    throw new FlowrynError("bad_args", "each plan task needs a string id/project/title/body, kind ship or scout, a number|null priority and a string[] blockedBy");
  }
  return { id: o.id, project: o.project, kind: o.kind, title: o.title, body: o.body, priority: o.priority as number | null, blockedBy: o.blockedBy as string[] };
}

function checkDecision(raw: unknown): FmDecision {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const okArchived = o.archived === null || isStr(o.archived);
  if (!isStr(o.id) || !isStr(o.project) || !isStr(o.origin) || !isStr(o.key) || !isStr(o.question) || !isStr(o.context) || !okArchived) {
    throw new FlowrynError("bad_args", "each plan decision needs a string id/project/origin/key/question/context and a string|null archived");
  }
  return { id: o.id, project: o.project, origin: o.origin, key: o.key, question: o.question, context: o.context, archived: (o.archived as string | null) ?? null };
}

function parsePlan(raw: string | undefined): ImportPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "");
  } catch {
    throw new FlowrynError("bad_args", "plan must be the JSON the import command builds");
  }
  if (typeof parsed !== "object" || parsed === null) throw new FlowrynError("bad_args", "plan must be the JSON the import command builds");
  const p = parsed as Record<string, unknown>;
  if (!Array.isArray(p.projects) || !Array.isArray(p.tasks) || !Array.isArray(p.decisions)) {
    throw new FlowrynError("bad_args", "plan must be the JSON the import command builds");
  }
  return { projects: p.projects.map(checkProject), tasks: p.tasks.map(checkTask), decisions: p.decisions.map(checkDecision) };
}

/** `dry` is fail-safe: apply only when the caller explicitly passed `dry: false`. */
function dryArg(args: Args): boolean {
  return args.dry !== false;
}

/**
 * residual fix 2: among a set of mutually-stuck ids, which ones can reach themselves again by
 * following only edges that stay inside that same stuck set? Those are the actual cycle members —
 * a task merely downstream of a cycle (blocked by a cycle member, but not reachable back from it)
 * is not one, and resolves normally once its cycle-member blocker is refused and peeled off.
 */
function cycleMembers(ids: string[], edgesOf: (id: string) => string[]): Set<string> {
  const members = new Set<string>();
  for (const start of ids) {
    const stack = [...edgesOf(start)];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (next === start) {
        members.add(start);
        break;
      }
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...edgesOf(next));
    }
  }
  return members;
}

export const importApply: VerbSpec = {
  name: "import.apply",
  summary: "Internal: record a Firstmate import (projects, tasks, decisions)",
  positionals: [],
  flags: { plan: { type: "string", help: "the import plan, JSON" }, dry: { type: "boolean", help: "report only" } },
  kind: "mutation",
  roles: ["human"],
  async prepare(ctx, args) {
    const plan = parsePlan(stringArg(args, "plan"));
    const facts: Record<string, RepoFacts | string> = {};
    for (const p of plan.projects) {
      try {
        facts[p.name] = await inspectRepo(ctx, p.path);
      } catch (error) {
        facts[p.name] = (error as Error).message;
      }
    }
    return { plan, facts };
  },
  apply(ctx, args, prepared) {
    const { plan, facts } = prepared as { plan: ImportPlan; facts: Record<string, RepoFacts | string> };
    const dry = dryArg(args);
    const rows: PlanRow[] = [];
    const now = ctx.now();

    for (const p of plan.projects) {
      const existing = ctx.db.query("SELECT id FROM projects WHERE import_source = ?1").get(source(p.name)) as { id: string } | null;
      if (existing) {
        rows.push({ item: p.name, kind: "project", action: "exists", reason: `project ${existing.id}` });
        continue;
      }
      if (!PROJECT_ID.test(p.name)) {
        rows.push({ item: p.name, kind: "project", action: "refuse", reason: `project id ${p.name} must be lowercase letters, digits and dashes` });
        continue;
      }
      if (!(DELIVERY_MODES as readonly string[]).includes(p.mode)) {
        rows.push({ item: p.name, kind: "project", action: "refuse", reason: `mode ${p.mode} must be one of ${DELIVERY_MODES.join(", ")}` });
        continue;
      }
      if (getProject(ctx.db, p.name)) {
        rows.push({ item: p.name, kind: "project", action: "refuse", reason: `project ${p.name} already exists and was not imported` });
        continue;
      }
      const f = facts[p.name]!;
      if (typeof f === "string") {
        const missingDir = f.startsWith("no such directory:");
        if (dry && missingDir) rows.push({ item: p.name, kind: "project", action: "create", reason: "clone, then register" });
        else rows.push({ item: p.name, kind: "project", action: "refuse", reason: f });
        continue;
      }
      const byPath = ctx.db.query("SELECT id FROM projects WHERE path = ?1").get(f.path) as { id: string } | null;
      if (byPath && byPath.id !== p.name) {
        rows.push({ item: p.name, kind: "project", action: "refuse", reason: `${f.path} is already registered as project ${byPath.id}` });
        continue;
      }
      if ((f.repoUrl ?? "") === "" && p.mode !== "local-only") {
        rows.push({ item: p.name, kind: "project", action: "refuse", reason: `project ${p.name} has no origin remote` });
        continue;
      }
      if (!f.defaultBranch) {
        rows.push({ item: p.name, kind: "project", action: "refuse", reason: `project ${p.name}: cannot tell the default branch` });
        continue;
      }
      if (!dry) {
        const row: ProjectRow = { id: p.name, repo_url: f.repoUrl ?? "", path: f.path, default_branch: f.defaultBranch, delivery_mode: p.mode as ProjectRow["delivery_mode"], yolo: p.yolo ? 1 : 0, priority: 2, harness: "claude", workflow: "fix", autonomy: defaultAutonomy(ctx.config()) };
        insertProject(ctx.db, row, source(p.name));
      }
      rows.push({ item: p.name, kind: "project", action: "create", reason: `${p.mode}${p.yolo ? " +yolo" : ""}` });
    }

    // Importable set (finding 2): a project this import already recorded (exists), or will (create) —
    // in a dry run, "will" means the plan's own project row came out create, with no DB write yet.
    const importableFromPlan = new Set(rows.filter((r) => r.kind === "project" && (r.action === "create" || r.action === "exists")).map((r) => r.item));
    const isImportable = (name: string): boolean => importableFromPlan.has(name) || !!ctx.db.query("SELECT 1 FROM projects WHERE id = ?1 AND import_source = ?2").get(name, source(name));

    // Decisions are created before tasks (a task's blocked-by may name a decision's own Firstmate item
    // id, which only resolves to a real task id once the decision exists), but their rows print after
    // the task rows (finding 4: projects, tasks, decisions — the order the golden plan fixes).
    const decisionRows: PlanRow[] = [];
    const decisionTaskId = new Map<string, string>(); // a decision's plan id -> its real (existing or new) task id
    const cfg = decisionsConfig(ctx.config());
    for (const d of plan.decisions) {
      const existing = ctx.db.query("SELECT id, task_id FROM decisions WHERE import_source = ?1").get(source(d.id)) as { id: string; task_id: string } | null;
      if (existing) {
        decisionRows.push({ item: d.id, kind: "decision", action: "exists", reason: "already imported" });
        decisionTaskId.set(d.id, existing.task_id);
        continue;
      }
      if (!isImportable(d.project)) {
        decisionRows.push({ item: d.id, kind: "decision", action: "refuse", reason: `project ${d.project} is not imported` });
        continue;
      }
      // A key tasks-axi would refuse (DECISION_KEY) is a refuse row, not a transaction-aborting throw:
      // `createStandaloneDecision` validates it again, but checking it here first means the plan's
      // other rows still get recorded even when one decision's key is malformed.
      if (!DECISION_KEY.test(d.key)) {
        decisionRows.push({ item: d.id, kind: "decision", action: "refuse", reason: `decision key ${d.key} must be lowercase letters, digits and dashes` });
        continue;
      }
      const collision = ctx.db.query("SELECT id FROM decisions WHERE origin = ?1 AND key = ?2").get(d.origin, d.key) as { id: string } | null;
      if (collision) {
        decisionRows.push({ item: d.id, kind: "decision", action: "refuse", reason: `decision ${d.origin}/${d.key} already exists (${collision.id})` });
        continue;
      }
      const reserved = reservedReason({ question: d.question, context: d.context, sourceReason: null, blocksYoloOff: false }, cfg);
      if (!dry) {
        const made = createStandaloneDecision(ctx.db, { key: d.key, question: d.question, options: [], context: d.context, origin: d.origin, reservedReason: reserved, project: d.project, importSource: source(d.id), now });
        decisionTaskId.set(d.id, made.taskId);
      } else {
        // residual fix 1: a dry run never calls createStandaloneDecision, so there is no real task id
        // yet — but a task blocked-by this decision must still preview as a kept, resolved blocker (the
        // real apply will remap it), not a false "dropped" warning. The placeholder is never written
        // anywhere; dry mode never calls queueTask.
        decisionTaskId.set(d.id, `dry:${d.id}`);
      }
      decisionRows.push({ item: d.id, kind: "decision", action: "create", reason: reserved ? `reserved: ${reserved}` : "the leader may decide" });
    }

    // Tasks: resolve every task's own outcome first (exists / refuse for a reason that does not depend on
    // ordering), then create the rest in dependency order over blockers that are themselves plan tasks
    // (finding 3): a dependent listed before its blocker in the plan must still both create, because
    // tasks-axi's `add --blocked-by X` fails if X is not yet in the backlog. A blocker that cannot resolve
    // — refused, or neither a plan task, a decision this apply created, nor an already-imported task — is
    // dropped from the edge with a `warn` row on its dependent, rather than failing the dependent outright.
    const taken = takenIds(ctx.db);
    const taskRow = new Map<string, PlanRow>();
    const taskWarnings = new Map<string, string[]>();
    const pending = new Map<string, ImportPlan["tasks"][number]>();
    const warn = (taskId: string, reason: string) => {
      const list = taskWarnings.get(taskId) ?? [];
      list.push(reason);
      taskWarnings.set(taskId, list);
    };
    for (const t of plan.tasks) {
      const policy = ctx.db.query("SELECT import_source FROM task_policy WHERE task_id = ?1").get(t.id) as { import_source: string | null } | null;
      if (policy) {
        taskRow.set(t.id, { item: t.id, kind: "task", action: policy.import_source === source(t.id) ? "exists" : "refuse", reason: policy.import_source === source(t.id) ? "already filed" : `task id ${t.id} is already used` });
        continue;
      }
      if (taken(t.id)) {
        taskRow.set(t.id, { item: t.id, kind: "task", action: "refuse", reason: `task id ${t.id} is already used` });
        continue;
      }
      if (!isImportable(t.project)) {
        taskRow.set(t.id, { item: t.id, kind: "task", action: "refuse", reason: `project ${t.project} is not imported` });
        continue;
      }
      pending.set(t.id, t);
    }
    const preExistingTask = (id: string): boolean => !!ctx.db.query("SELECT 1 FROM task_policy WHERE task_id = ?1").get(id);
    /** One resolution pass over every still-pending task; returns whether any task resolved. */
    const resolveOnce = (): boolean => {
      let progress = false;
      for (const [id, t] of pending) {
        // Collected locally, not committed through `warn()` yet: a dep still `pending` abandons this
        // attempt for another pass, and the warnings already produced in this same attempt must not
        // double up when the task is retried (and finally resolved) in a later pass.
        const resolved: string[] = [];
        const localWarnings: string[] = [];
        let waiting = false;
        for (const dep of t.blockedBy) {
          const decisionId = decisionTaskId.get(dep);
          if (decisionId) {
            resolved.push(decisionId);
            continue;
          }
          const row = taskRow.get(dep);
          if (row && (row.action === "create" || row.action === "exists")) {
            resolved.push(dep);
            continue;
          }
          if (row) {
            localWarnings.push(`blocked-by ${dep} dropped: ${row.reason}`);
            continue;
          }
          if (pending.has(dep)) {
            waiting = true;
            break;
          }
          if (preExistingTask(dep)) {
            resolved.push(dep);
            continue;
          }
          const decisionRow = decisionRows.find((r) => r.item === dep);
          localWarnings.push(`blocked-by ${dep} dropped: ${decisionRow ? decisionRow.reason : "not found"}`);
        }
        if (waiting) continue;
        for (const reason of localWarnings) warn(id, reason);
        if (!dry) {
          const project = getProject(ctx.db, t.project)!;
          queueTask(ctx.db, { taskId: id, title: t.title, body: t.body, kind: t.kind, project, priority: t.priority, blockedBy: resolved, importSource: source(id), now });
        }
        taskRow.set(id, { item: id, kind: "task", action: "create", reason: `queued ${t.kind}` });
        pending.delete(id);
        progress = true;
      }
      return progress;
    };
    while (pending.size > 0) {
      while (resolveOnce()) {
        /* keep resolving until a pass makes no further progress */
      }
      if (pending.size === 0) break;
      // Stuck: peel off exactly the true cycle members (an SCC of size > 1, or a self-blocked task) among
      // what is left, refuse them, then resume — a task only downstream of the cycle resolves in the next
      // round through the ordinary dropped-blocker path (its blocker's row is now a `refuse`).
      const ids = [...pending.keys()];
      const edgesOf = (id: string): string[] => (pending.get(id)?.blockedBy ?? []).filter((d) => pending.has(d));
      const cycles = cycleMembers(ids, edgesOf);
      if (cycles.size === 0) {
        // Defensive only: a stuck pending set always contains a real cycle (finite graph, every node
        // still blocked on another pending node); never loop forever if that invariant is somehow wrong.
        for (const id of ids) taskRow.set(id, { item: id, kind: "task", action: "refuse", reason: "blocked-by cycle" });
        pending.clear();
        break;
      }
      for (const id of cycles) {
        taskRow.set(id, { item: id, kind: "task", action: "refuse", reason: "blocked-by cycle" });
        pending.delete(id);
      }
    }

    for (const t of plan.tasks) {
      rows.push(taskRow.get(t.id)!);
      for (const reason of taskWarnings.get(t.id) ?? []) rows.push({ item: t.id, kind: "task", action: "warn", reason });
    }
    rows.push(...decisionRows);

    if (!dry && decisionRows.some((r) => r.action === "create")) setMeta(ctx.db, "import_triage", "1");
    return { data: { rows } };
  },
  async settle(ctx, result) {
    ctx.journal.kick();
    return result;
  },
};
