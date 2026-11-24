import type { FlowrynConfig } from "../config/config.ts";
import { capacityConfig } from "../config/workflows.ts";
import type { Db } from "../db/db.ts";
import { restartHoldingVerifies } from "../daemon/restart.ts";
import { SEES_ALL } from "../leader/scope.ts";
import { taskTitle } from "../lifecycle/runs.ts";
import { liveCounts } from "../sched/pools.ts";
import { hostState } from "../sched/scheduler.ts";
import { capacityView } from "../sched/verbs.ts";
import { sanitizeLine } from "../util/sanitize.ts";
import { BATCH_REF_PREFIX, batchLine, batchMembers, liveBatch, verifyingStage } from "../verify/batch-store.ts";
import { landingCell, landingProgress, placeOf, projectLine } from "../verify/landing-queue.ts";
import { queuedRequests, requestOf } from "../verify/queue.ts";
import { ownWaitCause, VERIFY_POOL, waitingOn } from "../verify/start.ts";
import { runningVerifications, type Verification } from "../verify/store.ts";
import { queueEtas, stepUsual, typicalVerify, verifyProgress, type Eta, type QueueEta, type StepView } from "./eta.ts";

/**
 * The dashboard's one summary (docs/notes/2026-11-24-a-live-build-t8.md): what `/api/status`
 * answers and the page draws. It reads through the functions the terminal views use
 * (`flowryn capacity`, `verify show`, `show`, `show lb<N>`), so the page and the terminal say the
 * same thing; it stores nothing. It holds ids, titles, states, timings and Flowryn's own one-line
 * texts, never a step's output, an env value or a path.
 */

export const STATUS_VERSION = 1;
/** Rows per list that has no natural bound (the verify queue, a project's landing line, the waiting runs). */
export const MAX_ROWS = 50;
const TITLE_CHARS = 60;

export interface Subject {
  kind: "task" | "batch" | "pr";
  id: string;
  title: string;
}

export interface VerifyItem {
  id: string;
  request: string | null;
  project: string;
  for: Subject;
  /** The PR's web address, only when it is one (https). */
  pr: string | null;
  head: string;
  started_at: number;
  elapsed_ms: number;
  eta: Eta | null;
  eta_why: string | null;
  current: string[];
  steps: StepView[];
  show: string;
}

export interface QueueItem {
  id: string;
  project: string;
  for: Subject;
  pr: string | null;
  position: number;
  waited_ms: number;
  why: string;
  eta: QueueEta;
  show: string;
}

export interface LandingEntry {
  id: string;
  task: string;
  title: string;
  state: string;
  place: string;
  cell: string;
  line: string;
  since_ms: number;
  show: string;
}

export interface LandingLine {
  project: string;
  batches: boolean;
  entries: LandingEntry[];
  more: number;
}

export interface BatchItem {
  id: string;
  project: string;
  state: string;
  line: string;
  verify: string | null;
  members: { task: string; pos: number | null; state: string }[];
  show: string;
}

export interface WaitingRun {
  task: string;
  title: string;
  stage: string;
  needs: string;
  waited: string;
  why: string;
  show: string;
}

export interface SectionError {
  error: string;
}

export type Section<T> = T | SectionError;

export interface DashboardStatus {
  version: number;
  build: string | null;
  now: number;
  verifies: Section<VerifyItem[]>;
  verify_queue: Section<QueueItem[]>;
  landing: Section<LandingLine[]>;
  batches: Section<BatchItem[]>;
  waiting: Section<{ runs: WaitingRun[]; more: string | null }>;
  pools: Section<{ pool: string; used: number; cap: number }[]>;
  host: Section<{ ok: boolean | null; line: string }>;
}

export interface StatusFacts {
  db: Db;
  config: FlowrynConfig;
  now: number;
  build: string | null;
  /** A section that could not be read: logged, and the rest still renders. */
  log(line: string): void;
}

function text(value: string, max = 200): string {
  return sanitizeLine(value, max);
}

function webUrl(url: string): string | null {
  return url.startsWith("https://") ? url : null;
}

/** What a verify or request is for: a landing batch (its ref names it), a task, or a bare PR. */
function subjectOf(db: Db, v: Pick<Verification, "pr_url" | "task_id">): Subject {
  if (v.pr_url.startsWith(BATCH_REF_PREFIX)) {
    const id = v.pr_url.slice(v.pr_url.lastIndexOf("/") + 1);
    return { kind: "batch", id, title: `landing batch ${id}` };
  }
  if (v.task_id) return { kind: "task", id: v.task_id, title: text(taskTitle(db, v.task_id), TITLE_CHARS) };
  return { kind: "pr", id: v.pr_url, title: text(v.pr_url, TITLE_CHARS) };
}

function section<T>(facts: StatusFacts, name: string, read: () => T): Section<T> {
  try {
    return read();
  } catch (error) {
    facts.log(`dashboard: could not read ${name}: ${(error as Error).message}`);
    return { error: `could not read ${name}` };
  }
}

function perProject<T>(read: (project: string) => T): (project: string) => T {
  const seen = new Map<string, T>();
  return (project) => {
    if (!seen.has(project)) seen.set(project, read(project));
    return seen.get(project)!;
  };
}

/** Why no queued request gets an estimate now, or null: a restart holding verifies back, a failing host check, no slot for verifies at all. */
function queueHeldBy(db: Db, now: number, running: number, free: number): string | null {
  const restart = restartHoldingVerifies(db, now);
  if (restart) return "a daemon restart waits for the running verifies first";
  const host = hostState(db);
  if (host && !host.ok) return `the host check fails (${text(host.reason, 80)})`;
  if (running + free === 0) return `other work holds every ${VERIFY_POOL} slot`;
  return null;
}

/** The whole summary, each section on its own: one that throws becomes `{ error }`. */
export function buildStatus(facts: StatusFacts): DashboardStatus {
  const { db, config, now } = facts;
  const typical = perProject((project) => typicalVerify(db, project));
  const usual = perProject((project) => stepUsual(db, project));
  const caps = capacityConfig(config).pools;

  const verifies = section(facts, "the running verifies", () => {
    return runningVerifications(db).map((v): VerifyItem => {
      const progress = verifyProgress(v, usual(v.project_id), now);
      return {
        id: v.id,
        request: requestOf(db, v.id)?.id ?? null,
        project: v.project_id,
        for: subjectOf(db, v),
        pr: webUrl(v.pr_url),
        head: v.head_sha.slice(0, 8),
        started_at: v.started_at,
        elapsed_ms: Math.max(0, now - v.started_at),
        ...progress,
        show: `flowryn verify show ${v.id}`,
      };
    });
  });

  const verifyQueue = section(facts, "the verify queue", () => {
    const queued = queuedRequests(db).slice(0, MAX_ROWS);
    const items = Array.isArray(verifies) ? verifies : [];
    // A running verify's slot frees at its time left; without one, at its project's typical length less what it has run.
    const busy = items.map((item) => item.eta?.left_ms ?? (typical(item.project) === null ? null : Math.max(0, typical(item.project)! - item.elapsed_ms)));
    const free = Math.max(0, (caps[VERIFY_POOL] ?? 0) - (liveCounts(db)[VERIFY_POOL] ?? 0));
    const held = queueHeldBy(db, now, items.length, free);
    const etas = queueEtas(
      [...busy, ...Array.from({ length: free }, () => 0)],
      queued.map((r) => ({ id: r.id, project: r.project_id, held: held ?? (r.wait_reason ? text(ownWaitCause(r), 120) : null) })),
      typical,
    );
    return queued.map(
      (r, i): QueueItem => ({
        id: r.id,
        project: r.project_id,
        for: subjectOf(db, r),
        pr: webUrl(r.pr_url),
        position: i + 1,
        waited_ms: Math.max(0, now - r.requested_at),
        why: text(waitingOn(db, r, caps, now)),
        eta: etas.get(r.id)!,
        show: `flowryn verify show ${r.id}`,
      }),
    );
  });

  const landing = section(facts, "the landing queues", () => {
    const projects = db.query("SELECT DISTINCT project_id FROM landing_queue WHERE state IN ('waiting','landing') ORDER BY 1").all() as { project_id: string }[];
    return projects.map(({ project_id: project }): LandingLine => {
      const line = projectLine(db, project);
      return {
        project,
        batches: db.query("SELECT 1 FROM landing_batches WHERE project_id = ?1 LIMIT 1").get(project) !== null,
        entries: line.slice(0, MAX_ROWS).map((row) => {
          const place = placeOf(db, row);
          return {
            id: row.id,
            task: row.task_id,
            title: text(taskTitle(db, row.task_id), TITLE_CHARS),
            state: row.state,
            place: place ? `${place.position} of ${place.of}` : "-",
            cell: text(landingCell(db, row), 80),
            line: text(landingProgress(db, row)),
            since_ms: Math.max(0, now - row.state_since),
            show: `flowryn show ${row.task_id}`,
          };
        }),
        more: Math.max(0, line.length - MAX_ROWS),
      };
    });
  });

  const batches = section(facts, "the landing batches", () => {
    const projects = db.query("SELECT DISTINCT project_id FROM landing_batches ORDER BY 1").all() as { project_id: string }[];
    return projects
      .map(({ project_id: project }) => liveBatch(db, project))
      .filter((b) => b !== null)
      .map(
        (batch): BatchItem => ({
          id: batch.id,
          project: batch.project_id,
          state: batch.state,
          line: text(batchLine(db, batch)),
          verify: batch.state === "verifying" ? text(verifyingStage(db, batch), 80) : null,
          members: batchMembers(db, batch.id).map((r) => ({ task: r.task_id, pos: r.batch_pos, state: r.state })),
          show: `flowryn show ${batch.id}`,
        }),
      );
  });

  // The capacity view through every scope's lens, as the board sees it: read once, and the three sections built from it.
  const capacity = section(facts, "capacity", () => ({ data: capacityView({ db, config, now }, SEES_ALL).data }));
  const fromCapacity = <T>(read: (data: Record<string, unknown>) => T): Section<T> => ("error" in capacity ? capacity : section(facts, "capacity", () => read(capacity.data)));
  const waiting = fromCapacity((data) => ({
    runs: (data.waiting as Omit<WaitingRun, "show">[]).map((w) => ({ ...w, show: `flowryn show ${w.task}` })),
    more: typeof data.more === "string" ? data.more : null,
  }));
  const pools = fromCapacity((data) => data.pools as { pool: string; used: number; cap: number }[]);
  const host = fromCapacity((data) => ({ ok: hostState(db)?.ok ?? null, line: text(data.host as string) }));

  return { version: STATUS_VERSION, build: facts.build, now, verifies, verify_queue: verifyQueue, landing, batches, waiting, pools, host };
}
