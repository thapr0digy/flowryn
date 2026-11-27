import type { Db } from "../db/db.ts";
import { appendEvent } from "../db/events.ts";
import { backgroundHoldLine } from "../harness/contract-text.ts";
import { listJobs, runningBackgroundJobs, type BackgroundJob } from "./background-jobs.ts";
import type { RunRow } from "./runs.ts";
import { waitBesidesOwnJobs } from "./turn-end-guard.ts";

/**
 * The background hold: a Claude worker may not end its turn while a Bash job
 * it ran in the background is still running. The job's end notice does not
 * always wake a worker whose turn is over (appsec-signal m1242, m1246, m1541,
 * m1557, m1565: `make ui-check-changed` and `make ui-golden` run past the
 * 600 s foreground limit, the worker backgrounded them, ended its turn "to act
 * when it lands", and sat idle until the leader steered it). So its Stop is
 * answered with a continuation naming the job and how to wait for it in the
 * turn (docs/notes/2026-11-27-a-worker-cannot-w5.md). Deterministic: events
 * and a fixed string.
 *
 * Bounded, so it never wedges a worker: a job stops holding once its end is
 * recorded, at its deadline (the cap, from its start; the call's `timeout` is
 * not read, as Claude may not enforce it on a background call), or after
 * `HOLD_MAX_REFUSALS` refusals; each release but an end is a
 * `run.background_hold_released` event with its reason. Holds are Stop
 * continuations outside `MAX_CONTINUATIONS`, so the refusal count keeps two
 * steer continuations, every hold and an asyncRewake wake under Claude's cap
 * of 8 continuations. Anything else that
 * rightly holds the worker (a question, a gate, a steer saying end the turn,
 * the run past running) wins, and an asynchronous agent never holds: its
 * hand-back wakes the worker.
 */

export const HOLD_KIND = "run.background_hold";
export const HOLD_RELEASED_KIND = "run.background_hold_released";

/** The longest a job holds its worker, from the job's start: a job whose end was missed holds no longer. */
export const HOLD_CAP_MS = 60 * 60_000;
/**
 * Refusals per job: a worker that keeps ending its turn is let go, and the
 * worker_idle pointer takes over. 2 steers + 3 holds + a waiter wake stay under
 * Claude's 8 Stop continuations, so no recorded hold is dropped by Claude.
 */
export const HOLD_MAX_REFUSALS = 3;

export type ReleaseReason = "cap" | "refusals";

/** Per job of this worker process: how often it held a Stop, and whether it was released. */
function holdHistory(db: Db, run: RunRow): { refusals: Map<string, number>; released: Set<string> } {
  const since = run.worker_started_at ?? run.started_at;
  const refusals = new Map<string, number>();
  const released = new Set<string>();
  const rows = db
    .query("SELECT kind, payload FROM events WHERE run_id = ?1 AND kind IN (?2, ?3) AND ts >= ?4 ORDER BY seq")
    .all(run.id, HOLD_KIND, HOLD_RELEASED_KIND, since) as { kind: string; payload: string }[];
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as { tool_use_ids?: string[]; tool_use_id?: string };
    if (row.kind === HOLD_RELEASED_KIND && payload.tool_use_id) released.add(payload.tool_use_id);
    for (const id of payload.tool_use_ids ?? []) refusals.set(id, (refusals.get(id) ?? 0) + 1);
  }
  return { refusals, released };
}

/** Why the job no longer holds, or null while it does. */
function releaseReason(job: BackgroundJob, refusals: number, now: number): ReleaseReason | null {
  if (now >= job.startedAt + HOLD_CAP_MS) return "cap";
  if (refusals >= HOLD_MAX_REFUSALS) return "refusals";
  return null;
}

/**
 * A Claude worker's turn ended with no steer taken: the refusal text when one
 * of its own background Bash jobs still holds it, or null to let the turn end.
 * Records the job ends the transcript shows, each release and the refusal.
 * Call inside the transaction.
 */
export function holdTurnEnd(db: Db, run: RunRow, now: number): string | null {
  if (waitBesidesOwnJobs(db, run) !== null) return null;
  const shells = runningBackgroundJobs(db, run, now, "hook").filter((j) => j.tool === "Bash");
  if (shells.length === 0) return null;
  const { refusals, released } = holdHistory(db, run);
  const holding: BackgroundJob[] = [];
  for (const job of shells) {
    if (released.has(job.toolUseId)) continue;
    const count = refusals.get(job.toolUseId) ?? 0;
    const reason = releaseReason(job, count, now);
    if (reason === null) {
      holding.push(job);
      continue;
    }
    appendEvent(db, {
      source: "hook",
      kind: HOLD_RELEASED_KIND,
      runId: run.id,
      taskId: run.task_id,
      payload: { tool_use_id: job.toolUseId, job: job.job, reason, refusals: count, started_at: job.startedAt },
      ts: now,
    });
  }
  if (holding.length === 0) return null;
  appendEvent(db, {
    source: "hook",
    kind: HOLD_KIND,
    runId: run.id,
    taskId: run.task_id,
    payload: { tool_use_ids: holding.map((j) => j.toolUseId), jobs: holding.map((j) => j.job) },
    ts: now,
  });
  return backgroundHoldLine(listJobs(holding, now), holding.length);
}
