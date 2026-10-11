# Quieter stale-hook pointer

- Status: done
- Open: whether Herdr reads `working` for an idle Claude worker holding a background job or sitting at the post-delivery prompt is inferred from the replay, not seen live (run_evidence keeps only the latest Herdr row)

The `run.stale_hooks` pointer ("looks busy but sent no hook event for Nm; possibly stuck") fired on Herdr reading `working` and 30 min without a hook, with no look at what the run was doing. All 21 it raised from 2026-10-05 to 2026-10-10 were noise: the worker was validating (6), delivered and waiting on its merge (13) or at a design review gate (2). Design: task `quieter-stale-hook-3q` (gate g90), approved 2026-10-10 and built under `quieter-stale-hook-v9`. Plain code: database reads; no model.

## Behaviour

- **The rule** (`staleHooksDue`, `src/lifecycle/stale-hooks.ts`, called by the reconciler's pass in place of the old inline check): due only when Herdr reads `working`, the run has been quiet `[reconcile] stale_hook_ms` (default 30 min) since `quietFrom`, `pendingWait(db, run, t, "reconciler")` is null, and `idleAlertDue` allows a pointer this episode (counted from `quietFrom`). It returns `{ due: true, quietFrom }` or `{ due: false, why }`; the cheap checks run first, so the transcript read inside `pendingWait` happens only once the quiet stretch is long enough.
- **Same waits as the turn-end guard, by calling it**: `pendingWait` (`src/lifecycle/turn-end-guard.ts`) is the one rule for "rightly idle": the run past `running` (validating, ready, merging), a stage not active (review gate, waiting for capacity), a pending launch, an open question, a permission dialog, a steer that said to end the turn, its own background job. A wait added there quiets both. It gains a `source` argument, the event source it records a background job's end under: the guard passes `"hook"`, the reconciler `"reconciler"`.
- **The clock counts from the last instruction too**: `quietFrom = max(last hook, instructionAt(run))` (run start or resume, stage start, steer carried). A worker idle for an hour and then woken by a stage start or a steer is no longer overdue the second it wakes (event 8435: the ship stage's conflict nudge, the pointer 0 s later).
- **Silence records nothing**, as with the guard: the reconciler passes every few seconds and silence is the normal case.
- **Event**: `run.stale_hooks` keeps `since` (the last hook) and adds `quiet_from`; the item's minutes count from `quiet_from`. An open `worker_idle` item still closes the way it did (busy again, waiting on you).
- **The hung pipeline**: a ship quiet while `validating` no longer gets this pointer; `validation_stuck` (PR #53, `docs/notes/2026-10-09-stuck-validations-become-y6.md`) covers a pipeline that stops making progress.
- **Version**: 0.20.0.

## Tests

- `test/fixtures/stale-hooks-2026-10.json`: the 21 `run.stale_hooks` events from flowryn.db (seq 5258 to 8435), each as the run state rebuilt from the run's events before it (the last of `run.validating` / `run.delivered` / `gate.opened` / `stage.started`, open questions, unended background starts, the latest steer carried), with `wait` (what `pendingWait` alone says) and the verdict. The replay keeps none of them: 18 are silenced by the wait, 3 (6569, 7224, 7798: a steer carried a second to a minute before) first by the instruction clock and also by the wait, and 8435 by the instruction clock alone (its 5 unended background starts were not checked against the transcript, so none is seeded).
- `test/unit/stale-hooks.test.ts`: the replay (each event also passes the old rule, so each is a pointer the change removes), and synthetic cases: running, active stage, nothing to wait on, 31 min quiet fires; 29 min is silent; a running background job is silent, and one the transcript shows ended is recorded with source `reconciler` and the pointer fires; a carried steer restarts the clock; Herdr not `working`; an open question or a pending launch; an open item holds it.
- `test/integration/stale-hooks.test.ts`: through the reconciler and the fake Herdr: a stalled worker Herdr reads `working` gets one event (with `quiet_from`) and one item; a worker at its review gate gets none while Herdr reads `working`.
