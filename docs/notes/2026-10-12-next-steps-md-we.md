# Verified fresh-stage replacement

- Status: done

The first slice of `docs/next_steps.md` package 1: a stage with `fresh = true` replaces its worker only after the old worker's exit is verified. Durable operation identity (the rest of package 1) is not part of this change.

## Design

### The boundary

A grant of a fresh stage (`activateStage` returns `launch: "stage"`) calls `Scheduler.freshWorker` (`src/sched/scheduler.ts`). On main at 3848e01 it awaits `exitWorker(runId)` and ignores the result, then in one transaction clears the process identity (`proc_pid`, `proc_start`, `proc_exe`), writes a new `agent_session` and appends `run.fresh_worker`, then calls `launch(runId, "stage")`. The daemon's `exitWorker` forwards the real `exitRun` result (`src/daemon/daemon.ts`): `ok: false` when the recorded process is still there after SIGTERM, the grace period and SIGKILL. So a worker that did not exit loses its identity, Flowryn forgets it, and a second worker starts in the same worktree beside it. The launcher's own guard (`proc_pid !== null` refuses a stage launch) cannot catch this, because freshWorker cleared `proc_pid` first. `relaunchWorker` in the same file already checks `ok` and returns without touching the row.

Repro (unit, `test/unit/workflows.test.ts`): a scheduler over a scratch database with a run waiting for a fresh stage and a stand-in `exitWorker` that answers `{ ok: false }`. Before the fix one pass clears `proc_pid`, changes `agent_session` and calls `launch` once. No sleeps: the stand-ins answer at once and `passNow()` is awaited.

### The rule

A fresh stage replaces its worker only on a verified exit, the precondition `relaunchWorker` already uses.

- `ok: false`, or `exitWorker` throwing (counted as unverified, with its message as the detail): no identity reset, no new session, no launch. The row keeps the old identity, `stage_state = 'active'`, `pending_launch = 'stage'` and its pool leases, which `activateStage` left in place. The run stays a scheduler candidate, so the next pass (the steady `[sched] pass_ms` timer or any kick) tries again. A retry takes no new lease: `neededPools` asks for nothing the run already holds.
- The refusal is surfaced: the first refusal of an episode appends `run.fresh_worker_refused` (`stage`, `detail`, `attempts`); `exitRun` already appends `run.exited` with `ok: false` for each attempt. The third consecutive refusal appends `run.worker_not_exited` and opens one P1 item `worker_not_exited` for the run on it, never a second while it is open.
- A later verified exit does what freshWorker did before (identity cleared, new session, `run.fresh_worker`, one launch) and, in the same transaction, resolves the run's `worker_not_exited` item. The launcher clears `pending_launch` when the new worker starts, so the run leaves the candidates: exactly one replacement.
- One failed candidate never stops other work: a refusal returns normally, so the grant loop goes on to the next candidate in the same pass. A throwing `exitWorker` is caught in freshWorker for the same reason (before, it threw out of the whole `grant` step).

Choices the brief left open, and why:

- Episode tracking is in memory (a `Map<runId, attempts>` on the scheduler holding an attempt count per run), not a new column: a refusal is a transient condition, and after a daemon restart the worst case is one more `run.fresh_worker_refused` event and three more attempts before the item, while `findOpenRunItem` keeps a still-open item from duplicating. No schema change, so no migration.
- The item threshold is a count (3 attempts), not a new config key: each attempt already spends the exit grace period plus the SIGKILL wait, so three attempts are minutes of a worker that will not die, which is worth a person's look. A constant keeps the config surface unchanged.
- `relaunchWorker` is not changed. It already refuses on `ok: false`; making it catch a throw too is a separate change.

### Files

- `src/sched/scheduler.ts`: `freshWorker` checks the exit, records refusals, resolves the item on success.
- `src/attention/items.ts`: the `worker_not_exited` kind (P1, actionable) in the lane table.
- `test/unit/workflows.test.ts`: the scheduler-level regressions (false exit, throwing exit, later verified exit replaces once, leases kept, other work granted, item after three refusals).
- `test/integration/workflows.test.ts`: end to end on the fake Herdr: a fresh stage whose old worker will not exit waits, then replaces it once when it does. The stand-in old worker is a `sleep` that is not a process-group leader, so `exitRun`'s group signal finds nothing and the identity check still sees it alive; a failing host probe holds the stage's grant while the test records it as the worker, because the reconciler leaves a run with a pending launch to the scheduler (a live worker outside its pane would otherwise be marked orphaned).

### Out of scope

Durable per-run operation identity, crash/retry recovery of launch, resume and cancel, the gateway's replay settlement, and any backoff between refused attempts.
