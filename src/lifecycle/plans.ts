import { FlowrynError } from "../api/errors.ts";
import type { Db } from "../db/db.ts";
import { getMeta, setMeta } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import type { BacklogTask } from "../journal/tasks-axi.ts";
import { recordIntent } from "../journal/journal.ts";
import { readSnapshot } from "../journal/snapshot.ts";
import { sanitizeBlock } from "../util/sanitize.ts";
import { mintTaskId } from "./ids.ts";
import type { ProjectRow } from "./projects.ts";

/**
 * Plans (design section 11): a phased feature is a plan, filed as ship tasks
 * chained with blocked-by. A plan is usually the output of a design stage, so
 * approving the design approves the plan: a plan a worker hands in with
 * `stage done --plan-file` waits (pending) on that review gate and reaches the
 * backlog only when a human channel passes it. A plan the leader files with
 * `flowryn plan` is approved as it is filed, like a dispatch. The phases of an
 * approved plan start by themselves once their blockers have landed (the
 * scheduler), never on an open PR.
 */

export interface PlanPhase {
  title: string;
  body: string;
  workflow: string | null;
  harness: "claude" | "pi" | null;
  /** Earlier phases of the same plan this one waits for, by number (1-based); null: the one before it. */
  after: number[] | null;
}

export interface PlanRow {
  id: string;
  project_id: string;
  title: string;
  state: "pending" | "approved" | "discarded";
  source_task: string | null;
  gate_id: string | null;
  filed_by: string;
  created_at: number;
  approved_at: number | null;
  approved_via: string | null;
}

export interface PhaseRow {
  plan_id: string;
  phase_no: number;
  task_id: string;
  title: string;
  body: string;
  workflow: string;
  harness: string | null;
  blocked_by: string;
}

export const MAX_PHASES = 20;
const MAX_PHASE_BODY = 64_000;
const MAX_TITLE = 120;
const DIRECTIVE = /^(workflow|harness|after):\s*(.+)$/i;
const WORKFLOW_ID = /^[a-z][a-z0-9-]{0,31}$/;

function cleanTitle(heading: string): string {
  const title = heading.replace(/^phase\s+\d+\s*[:.\-–—]\s*/i, "").replace(/\s+/g, " ").trim();
  return title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1).trimEnd()}…` : title;
}

/**
 * Parse a plan: an optional `# title`, then one `## <phase>` section per
 * phase. A section may start with `workflow: <id>`, `harness: claude|pi` and
 * `after: <n>[, <n>]` lines; the rest is the phase's task. Each phase waits for
 * the one before it unless `after` says otherwise.
 */
export function parsePlan(text: string): { title: string | null; phases: PlanPhase[] } {
  const lines = sanitizeBlock(text).split("\n");
  let title: string | null = null;
  const phases: PlanPhase[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  const finish = () => {
    if (!current) return;
    const out: PlanPhase = { title: cleanTitle(current.heading), body: "", workflow: null, harness: null, after: null };
    const rest = [...current.lines];
    while (rest.length > 0 && rest[0]!.trim() === "") rest.shift();
    while (rest.length > 0) {
      const match = DIRECTIVE.exec(rest[0]!.trim());
      if (!match) break;
      rest.shift();
      const [, key, value] = match;
      const v = value!.trim();
      if (key!.toLowerCase() === "workflow") {
        if (!WORKFLOW_ID.test(v)) throw new FlowrynError("bad_args", `plan phase "${out.title}": workflow ${v} is not a workflow id`);
        out.workflow = v;
      } else if (key!.toLowerCase() === "harness") {
        if (v !== "claude" && v !== "pi") throw new FlowrynError("bad_args", `plan phase "${out.title}": harness must be claude or pi`);
        out.harness = v;
      } else {
        const numbers = v.split(/[,\s]+/).filter(Boolean).map(Number);
        if (numbers.length === 0 || numbers.some((n) => !Number.isInteger(n) || n < 1)) throw new FlowrynError("bad_args", `plan phase "${out.title}": after takes phase numbers, such as after: 1`);
        out.after = numbers;
      }
    }
    out.body = rest.join("\n").trim();
    if (out.title.length === 0) throw new FlowrynError("bad_args", "a plan phase needs a title after ##");
    if (out.body.length > MAX_PHASE_BODY) throw new FlowrynError("bad_args", `plan phase "${out.title}" is over ${MAX_PHASE_BODY} characters`);
    phases.push(out);
  };
  for (const line of lines) {
    const h2 = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    const h1 = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (h2) {
      finish();
      current = { heading: h2[1]!, lines: [] };
    } else if (h1 && !current && title === null) title = cleanTitle(h1[1]!);
    else if (current) current.lines.push(line);
  }
  finish();
  if (phases.length === 0) throw new FlowrynError("bad_args", "the plan has no phases: one ## section per phase");
  if (phases.length > MAX_PHASES) throw new FlowrynError("bad_args", `a plan holds at most ${MAX_PHASES} phases`);
  phases.forEach((p, i) => {
    for (const n of p.after ?? []) if (n > i) throw new FlowrynError("bad_args", `plan phase ${i + 1} "${p.title}": after names phase ${n}, which is not an earlier phase`);
  });
  return { title, phases };
}

function nextPlanId(db: Db): string {
  const next = Number(getMeta(db, "next_plan_no") ?? "1");
  setMeta(db, "next_plan_no", String(next + 1));
  return `p${next}`;
}

/** Task ids already used or reserved: the policy table, the backlog, pending adds and plan phases. */
export function takenIds(db: Db): (id: string) => boolean {
  const ids = new Set<string>();
  for (const row of db.query("SELECT task_id FROM task_policy UNION SELECT task_id FROM plan_phases").all() as { task_id: string }[]) ids.add(row.task_id);
  for (const task of readSnapshot(db, "backlog")?.tasks ?? []) ids.add(task.id);
  for (const row of db.query("SELECT task_id FROM intents WHERE state = 'pending' AND task_id IS NOT NULL").all() as { task_id: string }[]) ids.add(row.task_id);
  return (id) => ids.has(id);
}

export interface NewPlan {
  project: ProjectRow;
  title: string;
  phases: PlanPhase[];
  /** The design task the plan came from: phase 1 waits for it to land. */
  sourceTask: string | null;
  gateId: string | null;
  workflow: string;
  harness?: "claude" | "pi" | null;
  /** Extra blockers phase 1 waits for (a dispatch with --blocked-by). */
  blockedBy?: string[];
  filedBy: string;
  state: "pending" | "approved";
  now: number;
}

/** Record a plan and its phases (task ids minted now, so a replay names the same tasks). Call inside a transaction. */
export function recordPlan(db: Db, p: NewPlan): { id: string; phases: PhaseRow[] } {
  const id = nextPlanId(db);
  db.query("INSERT INTO plans (id, project_id, title, state, source_task, gate_id, filed_by, created_at) VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?6, ?7)").run(
    id,
    p.project.id,
    p.title,
    p.sourceTask,
    p.gateId,
    p.filedBy,
    p.now,
  );
  const taken = takenIds(db);
  const minted: string[] = [];
  const rows: PhaseRow[] = [];
  p.phases.forEach((phase, i) => {
    const taskId = mintTaskId(phase.title, (candidate) => taken(candidate) || minted.includes(candidate));
    minted.push(taskId);
    const deps = phase.after ? phase.after.map((n) => minted[n - 1]!) : i > 0 ? [minted[i - 1]!] : [...(p.sourceTask ? [p.sourceTask] : []), ...(p.blockedBy ?? [])];
    const row: PhaseRow = { plan_id: id, phase_no: i + 1, task_id: taskId, title: phase.title, body: phase.body.length > 0 ? phase.body : phase.title, workflow: phase.workflow ?? p.workflow, harness: phase.harness ?? p.harness ?? null, blocked_by: JSON.stringify(deps) };
    db.query("INSERT INTO plan_phases (plan_id, phase_no, task_id, title, body, workflow, harness, blocked_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)").run(
      row.plan_id,
      row.phase_no,
      row.task_id,
      row.title,
      row.body,
      row.workflow,
      row.harness,
      row.blocked_by,
    );
    rows.push(row);
  });
  appendEvent(db, { source: "cli", kind: "plan.filed", payload: { plan: id, project: p.project.id, phases: rows.map((r) => r.task_id), source: p.sourceTask, gate: p.gateId, by: p.filedBy }, ts: p.now });
  if (p.state === "approved") approvePlan(db, id, p.filedBy, p.now);
  return { id, phases: rows };
}

/** A worker's plan, pending on its design's review gate. Call inside a transaction. */
export function fileWorkerPlan(db: Db, p: { project: ProjectRow; sourceTask: string; gateId: string; phases: { title: string | null; phases: PlanPhase[] }; workflow: string; now: number }): string {
  // A new plan for the same gate replaces an earlier one (a worker that ran stage done twice).
  discardPlansOfGate(db, p.gateId, p.now);
  return recordPlan(db, {
    project: p.project,
    title: p.phases.title ?? `Phases after ${p.sourceTask}`,
    phases: p.phases.phases,
    sourceTask: p.sourceTask,
    gateId: p.gateId,
    workflow: p.workflow,
    filedBy: `worker (${p.sourceTask})`,
    state: "pending",
    now: p.now,
  }).id;
}

const MAX_BACKLOG_BODY = 4_000;

/**
 * Approve a plan: its phases become ship tasks in Queued, each blocked by the
 * ones it waits for, with auto set so they start by themselves (design
 * section 11). Call inside a transaction.
 */
export function approvePlan(db: Db, planId: string, via: string, now: number): void {
  const plan = db.query("SELECT * FROM plans WHERE id = ?1").get(planId) as PlanRow | null;
  if (!plan || plan.state !== "pending") return;
  const project = db.query("SELECT * FROM projects WHERE id = ?1").get(plan.project_id) as ProjectRow | null;
  if (!project) throw new FlowrynError("not_found", `project ${plan.project_id} is gone`);
  db.query("UPDATE plans SET state = 'approved', approved_at = ?2, approved_via = ?3 WHERE id = ?1").run(planId, now, via);
  for (const phase of phasesOf(db, planId)) {
    db.query(
      `INSERT OR IGNORE INTO task_policy (task_id, project_id, kind, delivery_mode, yolo, sensitive, workflow, auto, created_at)
       VALUES (?1, ?2, 'ship', ?3, ?4, 0, ?5, 1, ?6)`,
    ).run(phase.task_id, project.id, project.delivery_mode, project.yolo, phase.workflow, now);
    const flags: Record<string, string | true | string[]> = { kind: "ship", repo: project.id, body: phase.body.slice(0, MAX_BACKLOG_BODY) };
    const deps = JSON.parse(phase.blocked_by) as string[];
    if (deps.length > 0) flags["blocked-by"] = deps;
    recordIntent(db, { file: "backlog", verb: "add", taskId: phase.task_id, positional: [phase.task_id, phase.title], flags, now });
  }
  appendEvent(db, { source: "cli", kind: "plan.approved", payload: { plan: planId, via }, ts: now });
}

/** Changes were requested on the gate a plan waited on: the plan goes with the design. Call inside a transaction. */
export function discardPlansOfGate(db: Db, gateId: string, now: number): number {
  const rows = db.query("SELECT id FROM plans WHERE gate_id = ?1 AND state = 'pending'").all(gateId) as { id: string }[];
  for (const row of rows) {
    db.query("UPDATE plans SET state = 'discarded' WHERE id = ?1").run(row.id);
    appendEvent(db, { source: "cli", kind: "plan.discarded", payload: { plan: row.id, gate: gateId }, ts: now });
  }
  return rows.length;
}

export function phasesOf(db: Db, planId: string): PhaseRow[] {
  return db.query("SELECT * FROM plan_phases WHERE plan_id = ?1 ORDER BY phase_no").all(planId) as PhaseRow[];
}

export function phaseOfTask(db: Db, taskId: string): (PhaseRow & { plan_title: string; plan_state: string; project_id: string; phases: number }) | null {
  return db
    .query(
      `SELECT ph.*, pl.title AS plan_title, pl.state AS plan_state, pl.project_id,
              (SELECT COUNT(*) FROM plan_phases x WHERE x.plan_id = ph.plan_id) AS phases
       FROM plan_phases ph JOIN plans pl ON pl.id = ph.plan_id WHERE ph.task_id = ?1`,
    )
    .get(taskId) as (PhaseRow & { plan_title: string; plan_state: string; project_id: string; phases: number }) | null;
}

export function getPlan(db: Db, id: string): PlanRow | null {
  return db.query("SELECT * FROM plans WHERE id = ?1").get(id) as PlanRow | null;
}

/**
 * Has a blocker landed? A task Flowryn ran has landed once a run of it is
 * cleaned (merge proven, then cleanup done; design section 11). A task
 * Flowryn never ran has landed when the backlog shows it done.
 */
export function hasLanded(db: Db, taskId: string, backlog: BacklogTask[] | null): boolean {
  if (db.query("SELECT 1 FROM runs WHERE task_id = ?1 AND state = 'cleaned'").get(taskId)) return true;
  if (db.query("SELECT 1 FROM task_policy WHERE task_id = ?1").get(taskId)) return false;
  return (backlog ?? []).some((t) => t.id === taskId && t.state === "done");
}

/** The tasks a backlog task is blocked by: tasks-axi lists a dependency as `blocked-by:<id>`. */
export function blockersOf(task: BacklogTask): string[] {
  return task.deps.filter((d) => d.startsWith("blocked-by:")).map((d) => d.slice("blocked-by:".length)).filter((d) => d.length > 0);
}

/** The blockers a queued task still waits for: its backlog dependencies (your edits win), else the plan's. */
export function waitingOn(db: Db, taskId: string, backlog: BacklogTask[] | null, planDeps: string[]): string[] {
  const task = backlog?.find((t) => t.id === taskId);
  const deps = task ? blockersOf(task) : planDeps;
  return deps.filter((dep) => !hasLanded(db, dep, backlog));
}
