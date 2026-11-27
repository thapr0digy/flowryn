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
 * not read, as Claude may not enforce it on a background call), or once
 * `HOLD_MAX_REFUSALS` holds ran in a row since the worker's last real turn
 * end, whichever jobs they named; each release but an end is a
 * `run.background_hold_released` event with its reason. Holds are Stop
 * continuations outside `MAX_CONTINUATIONS`, so counting them per chain of
 * Stops keeps two steer continuations, every hold and an asyncRewake wake
 * under Claude's cap of 8 continuations. Anything else that
 * rightly holds the worker (a question, a gate, a steer saying end the turn,
 * the run past running) wins, and an asynchronous agent never holds: its
 * hand-back wakes the worker.
 */

export const HOLD_KIND = "run.background_hold";
export const HOLD_RELEASED_KIND = "run.background_hold_released";

/** The longest a job holds its worker, from the job's start: a job whose end was missed holds no longer. */
export const HOLD_CAP_MS = 60 * 60_000;
/**
 * Holds in a row since the worker's last real turn end, across all its jobs: a
 * worker that keeps ending its turn is let go, and the worker_idle pointer
 * takes over. 2 steers + 3 holds + a waiter wake stay under Claude's 8 Stop
 * continuations, so no recorded hold is dropped by Claude.
 */
export const HOLD_MAX_REFUSALS = 3;

export type ReleaseReason = "cap" | "refusals";

/**
 * This worker process's hold history: the jobs already released, and the holds
 * in a row since its last real turn end (liveness to idle), kept in the
 * database so the count survives a daemon restart.
 */
function holdHistory(db: Db, run: RunRow): { chain: number; released: Set<string> } {
  const since = run.worker_started_at ?? run.started_at;
  const released = new Set<string>();
  let chain = 0;
  const rows = db
    .query(
      `SELECT kind, payload FROM events WHERE run_id = ?1 AND ts >= ?2
        AND (kind IN (?3, ?4) OR (kind = 'run.liveness' AND json_extract(payload, '$.to') = 'idle')) ORDER BY seq`,
    )
    .all(run.id, since, HOLD_KIND, HOLD_RELEASED_KIND) as { kind: string; payload: string }[];
  for (const row of rows) {
    if (row.kind === HOLD_KIND) chain += 1;
    else if (row.kind === HOLD_RELEASED_KIND) released.add((JSON.parse(row.payload) as { tool_use_id: string }).tool_use_id);
    else chain = 0;
  }
  return { chain, released };
}

/** Why the job no longer holds, or null while it does. */
function releaseReason(job: BackgroundJob, chain: number, now: number): ReleaseReason | null {
  if (now >= job.startedAt + HOLD_CAP_MS) return "cap";
  if (chain >= HOLD_MAX_REFUSALS) return "refusals";
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
  const { chain, released } = holdHistory(db, run);
  const holding: BackgroundJob[] = [];
  for (const job of shells) {
    if (released.has(job.toolUseId)) continue;
    const reason = releaseReason(job, chain, now);
    if (reason === null) {
      holding.push(job);
      continue;
    }
    appendEvent(db, {
      source: "hook",
      kind: HOLD_RELEASED_KIND,
      runId: run.id,
      taskId: run.task_id,
      payload: { tool_use_id: job.toolUseId, job: job.job, reason, refusals: chain, started_at: job.startedAt },
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
