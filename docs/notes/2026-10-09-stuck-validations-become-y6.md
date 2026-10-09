# Stuck validations

- Status: done
- Open: a real pipeline going quiet not yet run live; the `quiet` marker of later no-mistakes versions is read from their docs, not seen live
- Config: `[sched] validation_stuck_ms`

A ship whose validation slot was live but whose pipeline made no progress (a step wedged, or the run gone or ended while the worker never delivered) held the slot silently: nothing told you until you looked. Plain code: the status read the delivery watcher already makes, rows and fixed text; no model.

## Behaviour

- **Stuck** (`noteValidationProgress`, `src/reconcile/delivery.ts`, judged on every no-mistakes status read of a run holding a `validation` slot): an active run on the run's branch is stuck when its oldest active step (largest `active_for`) has been quiet over `[sched] validation_stuck_ms` (default 30 min). Quiet is no-mistakes' own clock: the age in `last_activity` (`"9m24s ago: ..."`, also behind the `quiet` marker later no-mistakes versions add past their own quiet warning; that shape is read from their docs, not seen live), or `active_for` when the step has no activity yet (`quietSeconds`, `src/policy/nomistakes.ts`). A run that is gone (no status, another branch's) or ended (an outcome) is stuck once the slot has gone that long since its grant or the last `run.validated`, so a restart keeps the clock. A status without the steps table, a run parked with no active step (the `worker_idle` P1 covers a worker that stops answering a gate), an activity in a shape this copy cannot read, or a failed read (`nomistakes_down` covers it) judges nothing.
- **One per run per episode**: `run.validation_stuck` opens the P1 (`Validation stuck: <title> (<project>): no-mistakes step review quiet for 45m; flowryn show <task>`, or `... no-mistakes run <id> ended (passed), quiet for 31m with the slot held and nothing delivered; ...`, or `... no no-mistakes run on <branch>, ...`); `run.validation_moving` ends the episode when a read says the run moves and resolves the item (`step moved`). Only events since the slot's grant count, so a dismissed item does not come back every poll, only after the run moved and stalled again.
- **Resolves at release**: `releaseLeases` (`src/sched/pools.ts`) resolves the run's item whenever it releases a validation slot (`slot released: stage ship delivered`, a failure, a cancel, a dead worker), in the same transaction.
- **Relayed**: `validation_stuck` is in `RELAY_KINDS`, so a Claude leader's Stop carries its line once, like a worker report.
- **Choice**: the CI step follows the same rule; no-mistakes logs while it waits on checks, and a CI that logs nothing for the threshold is worth a look. Raise `validation_stuck_ms` if it is not.
- **Tests**: `test/unit/validation-stuck.test.ts` (the `last_activity` age on the v1.53.0 shape, no activity yet, unreadable; quiet step, one per episode, under the threshold, no table or no step, moving and stalling again, dismissed not reopened, ended and gone runs from the grant or the last `run.validated`, no slot, release resolves, a new slot a new episode); `test/integration/validation-stuck.test.ts` (a ship through the real CLI, the fake worker and the no-mistakes stand-in: a quiet step opens the item, the leader's Stop carries it once, the step moving resolves it; an ended run opens it and the delivery resolves it).
- **Version**: 0.15.0. `PROTO` stays 6.

## Config

- `[sched] validation_stuck_ms` (default 1800000, 30 min): how long a validation slot may go with no progress (its oldest no-mistakes step quiet, or no run going with nothing delivered) before the `validation_stuck` P1 opens. `RELAY_KINDS` (`src/attention/items.ts`) now lists `worker_report`, `restart_dropped` and `validation_stuck`.
