# Three flaky tests: a missed host recovery, a delivery staled by its own pipeline ending, and bun's 5 s default

- Status: done

## Design

Each test was looped before any change, on a pristine copy of `main`
(`git archive HEAD`), alone and with every core saturated
(`2 × hw.ncpu` busy loops), to find what it actually waits on. None of the
fixes raises a deadline the test sets.

### 1. `verify.test.ts` "a verify takes a validation slot …": nothing noticed the host recover

The test queues a verify under a failing host check (its probe prints 2 GB),
asks again (the join), then makes the probe print 64 GB and waits 15 s for the
queued verify to start. A kick trace of the scheduler in a failing run showed
the cause: after the join's own kick nothing kicks the scheduler at all. A host
that recovers is noticed only by the scheduler's steady pass, `[sched]
pass_ms`, which the design sets at 30 s and the test left at that default.
Whether the test passed depended on a race it does not control: the join's
debounced pass (25 ms after the join's reply) probes the host, and passed only
when the test's write of 64 GB landed before that probe ran. Otherwise the
next look came from the steady pass, 30 s after daemon start, past the 15 s
deadline.

The product is right: the design says the steady pass notices a host that
recovers without an event, and a 30 s latency for that is intended. The test
now sets `[sched] pass_ms = 250` (as `accounts`, `quota` and `promote` do),
so the steady pass it depends on comes in time, and its comment says that
nothing else kicks the scheduler there.

### 2. `ci-wait.test.ts` "a stalled ship asks the user once …": the delivery refused as stale

verify v57's failure was at "waiting for the delivery" (32.6 s). Its run row
was still `running` with the steer acked, and its events ended
`steer.acked, run.validated, run.observation_stale` with no
`run.delivered`. That is the worker's `deliver` refused with
`observation_stale`: the test writes the stand-in's `run: null` and then the
worker's `go` at once, so the worker's `flowryn deliver` (which reads the
delivery basis, then GitHub and git) can overlap the delivery watcher's
no-mistakes read that flips the run `validating → running`
(`run.validated`). The run's `state` was one of `DELIVER_PARTS`, so the
delivery was refused ("read your steers, then deliver again"); the fake worker
does not retry and the run never became ready.

This is a product bug, not only a test race: the moment a real worker
delivers is right after its pipeline passes, which is exactly when the watcher
reads that pipeline end. A delivery's reads (the named-head gate) do not rest
on whether no-mistakes is running: a newer push is caught by the `delivered`
part and the named-head gate, a send-back or a stage change by `stage` and
`stage_state` and the state leaving `running`/`validating`, a cancel or a new
worker by `operation`.

The fix adds a delivery-basis part, `lifecycle`: the run's state with
`validating` read as `running` (`src/lifecycle/observed.ts`). `deliver`
compares `lifecycle` instead of `state` (`src/lifecycle/worker.ts`); every
other transition still compares `state`. A terminal run is still always
stale. A stale delivery now names `lifecycle` in its `changed` parts where it
named `state`.

### 3. `drop.test.ts` "flowryn drop through the CLI …": bun's 5 s default, not the suite's 30 s

The test sets no timeout and takes 3 to 5 s alone, 9 to 13 s with every core
busy. `bunfig.toml` said `[test] timeout = 30000`, but bun test 1.3.8 ignores
that key: a 5.5 s test in a scratch directory with only that bunfig times out
at 5 s. Nor can a preload set it: a preload's `setDefaultTimeout(30_000)`
(even from a global `beforeAll` or `beforeEach`) reached only one file of a
three-file run. Only `--timeout` on the command line, a test's own timeout, or
`setDefaultTimeout` in the test file itself work, and the verify steps run a
plain `bun test`. So every test without a timeout of its own runs under 5 s.

Making the drop test faster is not realistic (a daemon start, a dozen CLI
processes, three journal waits of up to 10 s), so it gets its own timeout,
60 s: well past its loaded time, and its internal waits still name what
stalled first. `bunfig.toml` loses the ignored key, and its comment says how
a test gets more than 5 s.

About 110 other integration tests in 16 files set no timeout either (most in
`decisions`, `cli`, `decisions-confirm`, `leader-cli`, `daemon`); they are
fast today but share the same cliff. Fixing them is left to a follow-up
(reported to the leader): a `setDefaultTimeout(30_000)` line per file, which
would touch files parallel ships edit.

### Open questions

None left open. Choices made:

- Verify test: configure the steady pass rather than make the scheduler poll
  the host faster while a verify waits on it. Recommendation followed: the
  design's 30 s pass is deliberate, and nothing in production waits on a
  15 s bound.
- Deliver: a new basis part rather than dropping `state` from `DELIVER_PARTS`.
  Dropping it would also let a delivery through a state change that matters
  (a run sent back from `ready`, one that ended); folding only
  `validating` into `running` keeps every other change stale.
- Drop test: its own timeout rather than a suite-wide default, which no
  preload can set and a per-file line would spread over 16 files other ships
  touch. The wider fix is a follow-up.

## Tests

- `test/unit/observed-delivery.test.ts`: "assumption: the pipeline ending
  while a delivery is verified changes nothing it rests on; the delivery
  stands" parks a delivery on its checks read, runs the watcher over
  `run: null` (`validating → running`), then lets it through; and the reverse
  (`running → validating`, a pipeline starting). Both failed before the fix
  (the reply was `observation_stale`) and pass after. The existing races (a
  newer delivery, a send-back) stay stale.

## Before and after

| Test | Before (main) | After |
|---|---|---|
| verify "takes a validation slot" | 4 of 12 failed alone ("vq1 started") | 0 of 12 alone, 0 of 6 under load |
| ci-wait "asks the user once" | 0 of 12 alone, 0 of 12 under load; 1 seen in verify v57; the barrier test above fails every time | 0 of 12 alone, 0 of 6 under load; the barrier test passes |
| drop "flowryn drop through the CLI" | 4 of 8 failed alone, 5 of 5 under load (5 s cut) | 0 of 5 alone, 0 of 5 under load |
