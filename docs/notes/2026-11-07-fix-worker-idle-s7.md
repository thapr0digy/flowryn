# The worker_idle pointer and the turn-end reminder result, in either order

- Status: done

The worker_idle pointer of a worker that ignored its turn-end reminder says "got the turn-end reminder, ended its turn again, and has been idle Nm without an outcome". The reconciler builds that line when the idle alert falls due, from `reminderIgnored`. Under load the alert can fall due between the reminder (a Pi follow-up, a Claude Stop continuation) and the worker's next turn end, which is what records the `run.turn_end_reminder_result`. The pointer then opened with the plain line and nothing changed it again, which flaked `test/integration/turn-end-guard.test.ts` at a load average of about 33.

Now when the guard records an ignored result (`settleReminder`, `src/lifecycle/turn-end-guard.ts`), it rewords the run's open worker_idle pointer in the same transaction (`noteIgnoredReminder`, `src/lifecycle/idle-alert.ts`). The result event's payload names the item it reworded (`idle_item_refreshed`). It rewords only a plain idle pointer: one opened from a `run.idle_alert` that is open or presented, that does not already say the worker ignored the reminder, and that does not wait on background jobs. A stale-hooks pointer and a resolved one keep their lines. The idle time in the new line is measured from the stretch's start, which is the item's `opened_at - idle_ms`, both on the reconciler's clock. Both paths build the line with `idleAlertLine`, so the wording is the same whichever came first.

The pointer is still not held back while a reminder is unsettled. A worker that never ends the turn the reminder started would otherwise never be flagged.

The `run.idle_alert` event's `ignored_reminder` still records what was known when the alert fell due. The integration test no longer requires it to be true, because under load it can fall due before the result. It checks the pointer's line instead.

Tests: `test/unit/turn-end-guard.test.ts` covers "the worker_idle pointer and the reminder result, in either order". It checks the result first, the pointer first, an obeyed result, a pointer that waits on a background job, and a resolved pointer. The tests drive the order by hand, so they do not depend on timing.

The daemon's verify of this delivery (v190) failed on an unrelated timeout. `test/unit/landing-queue.test.ts` "a base that moved sends the head of line back…" runs MAX_INTEGRATIONS rounds of real git merges and pushes, which took 6.1s against the 5s default under load. It passes alone, and it now has an explicit 30s budget.
