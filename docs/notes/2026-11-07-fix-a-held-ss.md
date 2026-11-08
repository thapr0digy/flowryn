# A held auto-merge resumes when a later verify passes, and a yolo merge waiting for the leader wakes it

- Status: done
- Config: `[waits] leader_min`

On 2026-11-07 a-claude-pi-y5 (PR #152) was held: auto-merge am37 "held (verify_failed): verify v182 failed again at 05bf2c9e after a send-back". The leader then ran `flowryn verify`, and v191 passed at the same head. The hold stayed. A held row was final, and on a landing-queue project the entry had left the line, which takes a head only once. The auto_merge_held item was gone by then, so fleet showed "ready to merge; waiting for the leader" with P1 0. Nothing woke the leader, and the PR sat for about 9 h. fix-a-superseded-7n (v189 passed) sat the same way.

## A passing verify releases a verify hold

Each auto-merger pass first runs `releaseHolds` (`src/verify/auto-merge.ts`). A held row is released when all of these hold:

- it is its run's newest row;
- it was held for its verify (`verify_failed`, `verify_timeout`, `verify_error`, `verify_cancelled`);
- the run is still `ready` with the row's head delivered;
- the newest finished verify of exactly that head, under the project's current verify policy, passed after the hold.

The verify can come from any source: the leader's `flowryn verify`, a recovery, or the queue. A finished verify already kicks the auto-merger, so this happens at once.

A released row gets one `auto_merge.hold_released` event, and its auto_merge_held item is resolved. Then:

- A row that merges goes back to `waiting_checks` on that verification and continues as before: checks, the merge gate, then the merge verb's path with the daemon as caller.
- An auto-verify row (`merge = 0`) ends `verified`.
- A row that was a landing-queue entry's is superseded with reason `hold_released`. The queue's `enqueueReady` then lets the head join the line again. Normally it takes a head once, and an entry that left at this head blocks it, but an entry whose auto-merge was released this way does not. The new entry's auto-merge follows the passing verify, so it is not verified again.

Holds for other reasons are not released by a passing verify: red checks, a gate refusal, checks timing out, a moved head. The merge gates are unchanged, and the verify is still at the exact head.

## A yolo run waiting for the leader gets a deadline

The wait registry (`src/reconcile/waits.ts`) has a new kind, `leader`. It applies to a yolo run whose open why-waiting explanation is `merge.ready`, `merge.held` or `decision.leader`. Those are the lines fleet shows as "waiting for the leader". The wait counts from when that wait began, and it is due after 15 min (`[waits] leader_min`). Past the deadline the registry does what it does for any wait. It recovers first by kicking the auto-merger, which releases a hold a passing verify ended. A pass later it opens one wait_expired item, a P1 that wakes the leader. The item names the merge or decision, the leader's command (`flowryn merge <task>`) and the reason.

A wait already carried by an open item is not itemized twice. For a merge that is the run's pr_ready or auto_merge_held, and for a decision its own item. If that item closes while the wait stands, the wait is itemized on the next pass, as for the capacity waits.

## A verify request no longer waits on a stale read of its own head

This was added to scope by steer m668. Verify request vq184 (PR #165, fix-a-superseded-7n) sat at "waits on its own PR: GitHub still shows 646cf993, a head delivered before 3a76bbf1". By then GitHub, read through the API, already showed 3a76bbf1, and so did the watcher's evidence (`flowryn show`'s `head_now`). The drain read the PR through the forge's ETag cache, and that read can answer with an older body. A recorded wait was also kept while the drain stopped before reaching the request, because the pool was full or the host check failed. In both cases the stale reason stayed on record.

The drain (`src/verify/start.ts`) now uses the freshest head it can get:

- **A fresh read before it defers.** When the PR read shows an earlier delivered head of the task, the drain reads it again without `If-None-Match` (`Forge.pull(ref, { fresh: true })`) before it defers.
- **The watcher's head counts.** If GitHub's answer still shows the earlier head, but the watcher's newest reading for the task's live run (`observedHead`, from its PR evidence) shows the request's own head, the request starts on that head, with a log line.
- **Disproved waits are cleared.** At the start of every drain, a recorded `stale_read` wait that the watcher's reading disproves is cleared (`clearDisprovedStaleReads`, with its `verify.wait_ended` event). This runs before the drain can stop for the pool or the host check, so fleet and the wait registry say the request waits its turn, not that GitHub lags.

A request still waits, for up to `STALE_READ_WAIT_MS`, while every reading shows the older head. The verify runs on the exact head, and the merge gate is unchanged.

## Tests

- `test/unit/auto-merge.test.ts` "a later passing verify releases a hold": the resume to waiting_checks with its event and resolved item; an auto-verify ending verified; nothing released by a pass at another head, an older pass, or a run that moved on; a non-verify hold left alone.
- `test/unit/landing-queue.test.ts` "an entry that left on a verify hold joins the line again…": real git; the entry left at the head is taken again only after the release, and the new landing follows the passed verify.
- `test/unit/waits.test.ts` "a yolo run waiting for the leader": the 15 min deadline, the recovery kick, the wait_expired item that wakes the leader, `leader_min`, covering by pr_ready, and no wait for a run that is not yolo.
- `test/integration/auto-merge.test.ts` "a hold after a second failure is released…": a real daemon and the fake forge. A step fails twice at the same head, the run is held, the leader's `flowryn verify` passes, and the PR merges.
- `test/integration/no-silent-waits.test.ts` "a yolo PR ready to merge with nothing waking the leader…": the merge waits with no item, a wait_expired item opens past the deadline, and fleet shows the `leader` wait as overdue.

- `test/unit/verify-queue.test.ts` "a stale head read": a cached read gets an uncached re-read that starts the request; the watcher's head starts it while GitHub lags; a recorded `stale_read` wait is cleared while the host check holds the queue.
- `test/unit/forge.test.ts` "a fresh read skips the ETag": against the fake GitHub, a fresh read gets a full answer, never a 304.

All of these failed before the fix.
