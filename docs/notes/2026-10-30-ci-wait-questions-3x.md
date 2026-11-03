# CI-wait questions yield to the conflict nudge

- Status: done

A defect the leader saw on 2026-10-30: five CI-wait questions (q135 to q139, merge-main | accept-without-ci | keep-waiting) reached the user after the PR-conflict nudge had already sent their ship back. The user answered, and the grant hook replied "decision qN is already dismissed". Plain code fixes it; no model is involved.

## What happened

The events for q135 show the order. The conflict nudge sent the delivered ship back at head `1b4ce0f6` (`run.conflict_nudged`). About four seconds later the next no-mistakes read still found the old pipeline run waiting in its `ci` step on that same head, now for 69 minutes. That read put the run back to `validating`, and the CI-wait watchdog opened q135 a second after that. About 68 seconds later no-mistakes parked that pipeline at its conflict gate. The watcher then saw the gate as covered by the nudge (`conflictCovered`) and dismissed q135, with "the pipeline is no longer waiting only on CI". For that minute the question's `worker_question` item was open, so the leader relayed it.

## The rules now

- **The nudge wins.** `conflictActedOn` (src/reconcile/delivery.ts) tells whether the conflict nudge has already acted on a head, full or short: it sent the ship back (`run.conflict_nudged`), or its nudges were spent and `pr_conflict` asks you (`pr.conflict`). The covered-conflict-gate check uses the same function. Before the CI-wait watchdog asks (src/watch/delivery.ts `watchCiWait`), it checks the pipeline's head (`head_sha`, else `head`). If the nudge has acted on that head, the watchdog opens no question and closes any open one. It checks again inside the transaction that would open the question, so a nudge that commits during the GitHub and git reads still wins.
- **A nudge closes an open question in its own transaction.** `sendConflictBack` calls `closeCiWaits(..., via "conflict")` in both of its branches: when it sends the ship back, and when it opens `pr_conflict` instead. The decision is `dismissed` with `answered_via = conflict`, its `decision.dismissed` event says "superseded by the conflict nudge", and its item resolves in that same transaction. The leader never relays the question after that, and the stop hook and the digest never list it. No steer goes to the worker, because the worker never asked.
- **A new head is a new stall.** After the worker merges main and ships again, the pipeline runs on a new head. The nudge has not acted on that head, so a CI wait there is asked about as before.

## Choices

- The test is the head, not the time. A nudge on head X makes any pipeline still validating X moot, because the worker has been told to replace X. A head-less status (no `head` or `head_sha`) keeps the old behaviour: it is asked about, since nothing ties it to the nudge.
- A spent nudge (`pr.conflict`) counts too. That item already asks you about the same PR, and merge-main would only repeat it.

## Tests

`test/unit/ci-wait.test.ts`: no question for a CI wait on a nudged head (the 2026-10-30 case), and none on a head with a spent nudge. A pipeline on a new head after the merge is still asked about. An open question and its item close in the nudge's own transaction, with no watcher pass between and no steer. Without the fix, three of these four tests fail.
