import type { Db } from "../db/db.ts";
import { HISTORY_PASSES, recentPasses } from "../verify/deadline.ts";
import { normalizeStep } from "../verify/policy.ts";
import type { StepState, Verification } from "../verify/store.ts";

/**
 * The dashboard's estimates (docs/notes/2026-11-24-a-live-build-t8.md). Plain arithmetic over the
 * verify history: a step's usual time is the median of its last clean passes in the project (the
 * same passes the step deadlines read, src/verify/deadline.ts, which take their max instead); a
 * running verify's time left adds up its groups; a queued request's start comes from a small
 * simulation of the validation slots. Every number here is an estimate and is labelled so.
 */

export const ETA_BASIS = `median of each step's last ${HISTORY_PASSES} clean passes`;
/** How many passed verifications of a project make its typical whole verify. */
const TYPICAL_VERIFIES = 5;

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** Each step's usual time in the project, by its name: null for a step with no clean pass yet. */
export function stepUsual(db: Db, projectId: string): (step: string) => number | null {
  const passes = recentPasses(db, projectId);
  return (step) => median(passes.get(normalizeStep(step)) ?? []);
}

/** The median length of the project's last passed verifications, or null with none. */
export function typicalVerify(db: Db, projectId: string): number | null {
  const rows = db
    .query("SELECT finished_at - started_at AS ms FROM verifications WHERE project_id = ?1 AND state = 'passed' AND finished_at IS NOT NULL AND reused_from IS NULL ORDER BY started_at DESC, rowid DESC LIMIT ?2")
    .all(projectId, TYPICAL_VERIFIES) as { ms: number }[];
  return median(rows.map((r) => r.ms));
}

export interface StepView {
  name: string;
  group: number;
  state: StepState;
  /** How long it took, once it ended. */
  ms: number | null;
  /** How long it has run, while it runs. */
  elapsed_ms: number | null;
  usual_ms: number | null;
  /** The elapsed time is its group's start, not its own (a row from before steps recorded their start). */
  approx: boolean;
}

export interface Eta {
  left_ms: number;
  basis: string;
  /** How far the slowest running step is past its usual time; 0 when none is. */
  over_ms: number;
}

export interface VerifyProgress {
  steps: StepView[];
  /** The steps running now. */
  current: string[];
  eta: Eta | null;
  /** Why there is no estimate. */
  eta_why: string | null;
}

const ENDED: ReadonlySet<StepState> = new Set(["passed", "failed", "stopped", "skipped"]);

/**
 * Where a running verification stands. Steps with the same group run at once and groups run in
 * order (a row from before groups: each step its own). Time left: in the current group, the
 * longest of each unfinished step's usual time less what it has run; in each later group, its
 * longest usual time; summed. A step past its usual adds nothing and shows in `over_ms`. Any
 * unfinished step without history: no estimate.
 */
export function verifyProgress(v: Pick<Verification, "steps" | "started_at">, usual: (step: string) => number | null, now: number): VerifyProgress {
  const groups = new Map<number, number[]>();
  v.steps.forEach((step, i) => {
    const group = step.group ?? i;
    groups.set(group, [...(groups.get(group) ?? []), i]);
  });
  const order = [...groups.keys()].toSorted((a, b) => a - b);
  // A group's start, for a running step that recorded none: the verify's start plus each earlier group's longest step.
  const groupStart = new Map<number, number>();
  let at = v.started_at;
  for (const g of order) {
    groupStart.set(g, at);
    at += Math.max(0, ...groups.get(g)!.map((i) => v.steps[i]!.ms ?? 0));
  }
  const steps: StepView[] = v.steps.map((step, i) => {
    const group = step.group ?? i;
    const running = step.state === "running";
    const since = step.started_at ?? groupStart.get(group)!;
    return {
      name: step.name,
      group,
      state: step.state,
      ms: ENDED.has(step.state) ? step.ms : null,
      elapsed_ms: running ? Math.max(0, now - since) : null,
      usual_ms: usual(step.name),
      approx: running && step.started_at === undefined,
    };
  });
  const current = steps.filter((s) => s.state === "running").map((s) => s.name);
  const unfinished = steps.filter((s) => !ENDED.has(s.state));
  const unknown = unfinished.find((s) => s.usual_ms === null);
  if (unknown) return { steps, current, eta: null, eta_why: `no history for ${unknown.name}` };
  let left = 0;
  let over = 0;
  for (const g of order) {
    const members = steps.filter((s) => s.group === g && !ENDED.has(s.state));
    if (members.length === 0) continue;
    left += Math.max(
      ...members.map((s) => {
        if (s.elapsed_ms === null) return s.usual_ms!;
        over = Math.max(over, s.elapsed_ms - s.usual_ms!);
        return Math.max(0, s.usual_ms! - s.elapsed_ms);
      }),
    );
  }
  return { steps, current, eta: { left_ms: left, basis: ETA_BASIS, over_ms: over }, eta_why: null };
}

export interface QueuedForEta {
  id: string;
  project: string;
  /** Why it gets no estimate (it waits on something other than a slot), or null when it waits only for one. */
  held: string | null;
}

export type QueueEta = { starts_in_ms: number; done_in_ms: number } | { starts_in_ms: null; why: string };

/**
 * When each queued request starts and ends, if the queue drains as usual: each slot is free at
 * `freeAt` (ms from now; 0 for a free slot, null when unknown); in queue order, a request takes the
 * earliest free slot and holds it for its project's typical verify. A slot whose time is unknown
 * may free first, so a request starts known only on a slot free now. A held request steps aside
 * (no estimate, no slot); once a start or a length is unknown, every request behind it has none.
 */
export function queueEtas(freeAt: readonly (number | null)[], queued: readonly QueuedForEta[], typical: (project: string) => number | null): Map<string, QueueEta> {
  const result = new Map<string, QueueEta>();
  const known = freeAt.filter((s): s is number => s !== null);
  const someUnknown = known.length < freeAt.length;
  const times = freeAt.length > 0 ? known : [0];
  let unknown: string | null = null;
  for (const request of queued) {
    if (request.held !== null) {
      result.set(request.id, { starts_in_ms: null, why: request.held });
      continue;
    }
    const start = times.length > 0 ? Math.min(...times) : null;
    if (unknown === null && (start === null || (someUnknown && start > 0))) unknown = "a running verify has no estimate";
    if (unknown !== null) {
      result.set(request.id, { starts_in_ms: null, why: unknown });
      continue;
    }
    const length = typical(request.project);
    if (length === null) {
      result.set(request.id, { starts_in_ms: null, why: `${request.project} has no passed verify yet` });
      unknown = `${request.id} ahead has no estimate`;
      continue;
    }
    times[times.indexOf(start!)] = start! + length;
    result.set(request.id, { starts_in_ms: start!, done_in_ms: start! + length });
  }
  return result;
}
