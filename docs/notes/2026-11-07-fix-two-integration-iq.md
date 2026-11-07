# Two integration races seen under load

- Status: done

Two integration tests failed on their own inner waits at load ~20 and passed alone. One was a product race, the other plain slowness.

## The usage-limit probe: a product race, fixed

`test/integration/workflows.test.ts` "with no live Claude session left, the pause expires and lets one probe through…" saw two `sched.usage_probe` events where one was expected.

The cause: a probe held its slot only while it was younger than the backoff, timed from its grant (`probeOut` in `src/sched/usage.ts`). A probe's age includes its launch, and its `rate_limit` can only arrive after its worker has started and made its first API call. When that took longer than the backoff, the next pass saw the probe as stale and let a second run in while the first could still hit the limit. Grants are serialized (`Scheduler.exclusive`), so that age check was the only way to a second probe. The test's 2 s backoff made it easy to hit on a loaded host. With the default 15 min it was rare, but just as real: the design promises exactly one probe.

The fix keeps no timer:

- A probe holds the slot while its run is alive, however slowly it launches or answers. Its death or end (failed, cancelled, cleaned, liveness dead) frees the slot for the next waiting run.
- The probe's own first tool call lifts the pause (`noteProbeReply`, called from the worker `hook pre-tool`; a `sched.usage_resumed` event with source `hook`, why "the probe worker <task> got a reply (a tool call)"). A tool call means the model answered, so usage is available again. This takes over the job the old timer did: a long, healthy probe turn no longer holds everything else up until its `Stop`. Only the probe's call counts. A session that was already mid-turn when the limit hit proves nothing new.
- A normal `Stop`, `quota_auto_resume_fired`, a `rate_limit` re-arm and `flowryn capacity resume` work as before.

A probe that never answers and never dies (a launch that wedges without being marked dead) holds the pause until the reconciler marks it dead or you run `flowryn capacity resume --account <id>`, which the P1 names.

Tests: `test/unit/workflows.test.ts` "a live probe holds the slot however long it takes to answer…" checks the gate at the backoff, just past it and far past it (on the old code it returned `probe` at the backoff), then a late `rate_limit` re-arming with one probe recorded. "the probe's own tool call lifts the pause…" checks that only the probe's call lifts. The integration test now expects the probes `[b, c]` exactly, the lift from c's first tool call, and d starting only after the lift, never as a probe.

## The review-open poll: slowness, wait widened

`test/integration/review-open.test.ts` "[review] open_browser = false…" timed out at 10 s waiting for the first `lavish-axi` call.

No race: once `stage done` has committed the gate, its `settle` kicks the poller (`ctx.lavish.kick()`). The next pass hosts the page's copy with `lavish-axi <page> --no-open`, whose first line writes `lavish-calls.log`, and the daemon's steady pass kicks the poller again every `pass_ms` as a fallback. No step waits on a condition that could stay false. Measured from `handIn` returning to the file appearing: 130–190 ms idle and the same beside a parallel suite run. So the 10 s miss was a starved host. The wait is now 30 s, and the test sets its own 60 s timeout, since the wait is longer than bun's 5 s default.
