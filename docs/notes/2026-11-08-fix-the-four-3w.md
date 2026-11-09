# The four known flaky tests, fixed at their cause

- Status: done

Earlier leader sessions noted four tests that failed under full-suite load, each with a "rerun verify" workaround: `promote`, `turn-end-guard` (Pi), `review-open` (`open_browser = false`) and the usage-limit probe test in `workflows`. Each fix below targets the race itself, not a longer sleep or a retry. Two are product races, with a test that fails on the old code. Two are test races, where the test now goes through the daemon or waits on the event it means.

## promote: the test wrote the database under the daemon (test race)

`test/integration/promote.test.ts` "a scout in a review with questions > is promoted" put a user message into the review with `addReviewMessage` on its own connection, in a transaction, while the daemon was writing. Under load it got `SQLITE_BUSY`. `BEGIN IMMEDIATE` had already been tried and was not enough.

The user's message now arrives the way a real one does. The test queues a chat message for the test home's `lavish-axi` stand-in (`$FLOWRYN_HOME/lavish-queue/`). The daemon's own poll of the review page prints it, and `routePageBatch` keeps it. The test waits for the `review_messages` row, then promotes. The test no longer writes `flowryn.db`.

## turn-end-guard (Pi): the run went idle between the reminder and the follow-up turn (product race)

`fix-worker-idle-s7` covered one order: a worker_idle pointer that opened before the reminder's result gets its wording changed when the result lands. The window it worked around exists only for Pi. A Claude reminder is a Stop continuation, so the hook marks the run busy ("reminded") and no idle alert can fall due before that turn ends. A Pi reminder is a follow-up turn that the extension starts after the stop hook returns, but the hook marked the run idle. The run then sat idle, with `idle_since` set, until the follow-up turn's own hooks arrived. With a short `idle_alert_ms` under load, the alert fell due in that gap. Against a real Pi, the follow-up turn's first hook marks the run busy, which resolves that pointer as "busy again". The next turn end then opens a second pointer. The test read the first, plain one.

Now the stop hook marks a Pi run busy ("reminded") when it returns a reminder, as it does for Claude (`src/lifecycle/hooks.ts`, `stop`). The run stays busy until the follow-up turn ends, so the idle alert can only fall due after the reminder's result. A Pi follow-up that never starts (the extension's `sendMessage` throws) lets the busy lease (`busy_lease_ms`, 10 min) lapse. The reconciler's Pi stall backstop then opens the suspected-stall item. Before this change, the worker_idle pointer covered that case. The rewording from s7 stays as a backstop.

The contract suite runs with `turn_end_guard = false`, so this path is not one it proves, and `CONTRACT_REVISIONS` is unchanged. The Pi extension changes only in a comment.

Test: `test/integration/turn-end-guard.test.ts` "…reminded once…" now checks, for both harnesses, that no `run.liveness` event sets the run idle between the first `run.turn_end_reminder` and its result. It also checks again that `run.idle_alert` records `ignored_reminder: true`, which s7 had relaxed. On the old hook code the Pi case fails (an idle transition sits between the two events).

## review-open: the wait waited on the wrong call (test race)

`test/integration/review-open.test.ts` "[review] open_browser = false" waited for `lavish-calls.log` to exist, then slept 300 ms before checking that nothing had opened. The first `lavish-axi` call is the daemon hosting the page's copy (`<page> --no-open`), and the poll comes after it. The poll is the step that offers the gate to the opener: in `followGates`, `start` is followed in the same synchronous step by `opener.offer`. So the test's wait ended before the event it named, and the fixed sleep stood in for it. The test now waits for the poll's own line (`poll <page>`) in the calls log and has no sleep. The 30 s bound from `fix-two-integration-iq` stays as a deadline only.

## workflows usage-limit: the probe verdict was read before the grant's awaits (product race)

The design promises at most one probe per expired pause. `fix-two-integration-iq` removed the timer that freed a live probe's slot. One more way through was left. `tryGrant` reads the usage gate (`accountHold` → `usageGate`), then awaits the quota read, the sign-in check, the harness version check and the host check. Only after that does it start the run and `claimProbe` in its transaction, using the verdict it read before. Grants are serialized, but hooks are not. A live session's `rate_limit` can re-arm the pause inside that window (a new `until`, `probe: null`). The stale "probe" verdict then starts a run into the fresh pause and records it as the probe: a second probe without waiting out the backoff. The plan-phase start (`startPhase`) had the same gap around `checkStart`.

Both transactions now read `usageGate` again before they start anything. If the pause holds, the grant refuses with the usage-limit reason, the same as a pass that saw the pause, and the phase waits. If it allows a probe, that is the run it claims. A run that overflowed to another account still needs that account to be fully open.

Tests (`test/unit/account-capacity.test.ts`, "the usage pause's one probe, under a grant's awaits"):

- A pause re-armed during the grant's quota read starts nothing: no launch, no `sched.usage_probe`, and the run's reason is the pause. This fails on the old code.
- Of three runs waiting at the expiry, over two passes exactly one starts, as the probe, and the other two wait on it.

The integration test's assertions are unchanged.

## Found on the way: contract-ack-blocker's re-ring window (test race)

The first suite of the proof run failed `test/integration/contract-ack-blocker.test.ts` "a Claude Stop that carries a steer continues the turn…": `idle_since` was null after the second Stop. The test fleet re-rings an unacknowledged steer after `ring_interval_ms = 1000`. Under load, the hooks between the two Stops (each one a CLI call) took longer than that. The steer came due again, and the second Stop carried it as a continuation, which marks the run busy. That is correct product behaviour, and re-ringing is not what the test asserts. The test now sets `ring_interval_ms` to 10 minutes, so that window is out of its reach. The guard is off in this test and its harness is Claude, so the Pi hook change above is not involved.

## Found by the daemon's verify: clean-merge-carry read before the auto-verify settled (test race)

The daemon's verify of this PR (v223) failed `test/integration/clean-merge-carry.test.ts` "a merge of main that slips in an edit is not carried…": a `verify_queue` row existed for the head that was not carried. The events in a kept test home show why. Once the PR head moves, the delivery's own auto-verify request is cancelled ("the PR head moved from A to B; verify the new head"). `AutoMerger.requeueLost` (`src/verify/auto-merge.ts`) then queues a verify of B, emits `auto_merge.verify_requeued` and supersedes the row. This is documented behaviour ("a head that really moved has its verify queued"), and the merge is still refused with `head_moved`. The test checked the queue right after the head-moved divergence opened, in a different transaction from the requeue, so it passed only when it read between the two. The leader chose the test fix over changing auto-merge (q191).

The test now waits until the delivered head's `auto_merges` row has left the live states. It then checks that no `run.head_carried` exists and that every verify of B is one that `auto_merge.verify_requeued` names: the pre-verify, never a carry's. Run 18 times (3 loops of 6) beside a `bun run test`: 18 pass, 0 fail. That suite run failed one other test, `prompt-wedge` "a run with an open blocked_prompt that dies…": the item was already resolved when the run read `blocked_dialog`. That is a Claude run with no reminder and no usage pause, so none of these changes is on its path, and it is left open here.

## SERIAL_FILES

None of the four files was in `SERIAL_FILES` (`scripts/test.ts`), and these fixes do not touch the six that are (`gate-questions` and `races`, `urgent`, `question-wake`, `treehouse-pool`, `asks`). Each of those asserts on a wall-clock window of its own, so the list is unchanged.

## Proof under load

Method, on the shared 12-core Mac on 2026-11-08, outside the command sandbox. Each of the four files ran 20 times in its own loop, one `bun test --timeout=30000 test/integration/<file>.test.ts` after another, and the four loops ran side by side. Meanwhile `bun run test` (the full parallel suite) ran again and again as load until every loop had finished:

```sh
for f in promote turn-end-guard review-open workflows; do
  ( for i in $(seq 20); do bun test --timeout=30000 test/integration/$f.test.ts; done ) &   # pass count kept per file
done
while loops-still-running; do bun run test; done
```

The 1-minute load average, sampled every 30 s (106 samples), ranged from 6 to 83, with a median of 40.

| File | Runs | Pass | Fail |
| --- | --- | --- | --- |
| `promote.test.ts` | 20 | 20 | 0 |
| `turn-end-guard.test.ts` | 20 | 20 | 0 |
| `review-open.test.ts` | 20 | 20 | 0 |
| `workflows.test.ts` | 20 | 20 | 0 |

The load suites:

- Suite 1 failed only `contract-ack-blocker` (the section above). It was fixed during the run.
- Suite 5 started while the last loop was finishing and failed two waits in other files, both left open here (other slow tests are out of scope):
  - `workflows` "changes at the QA review…": the first QA review was not reached in 20 s.
  - `contracts-offline` "pi: --model…": the Pi contract's "temp dir" step waited 15 s for a steer acknowledgement. The contract suite runs with `turn_end_guard = false`, so the Pi reminder change is not on that path.
- Suites 2 to 4 each passed all 3601 tests:
  - unit: 92–122 s
  - integration parallel: 469–531 s
  - serial files: 95–209 s

After the proof run, the serial suite (`bun test`) passed: 3601 pass, 0 fail, in 2290 s.

Before the fixes, at a load of about 35, the same loops passed 10 of 10 for each file. Two harder probes reproduced failures:

- **Stress.** Six copies of each test, filtered to the one in question, ran beside the suite, at a load past 60. They hit wait timeouts (a launch not granted in 20 s, a reminder not settled in 15 s). These failures came from the load, not from the races above. The `workflows` loop in the first baseline also failed twice, both times in "a stage with fresh = true…", with the same launch-grant timeout. That test passed 10 of 10 in a later loop under the proof's load.
- **The old code.** The new unit test for the probe and the Pi assertion in `turn-end-guard` both fail on the old code. They do not depend on load.
