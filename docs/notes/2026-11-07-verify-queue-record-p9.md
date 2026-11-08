# Verify queue: every request waiting on its own PR has its own deadline

- Status: done
- Open: not yet run against a live home

A follow-up to the wait registry (docs/notes/2026-11-06-no-silent-waits-vj.md). The verify drain lets a request that must wait on its own PR step aside so the requests behind it start, but the registry only gave the first queued request a wait. A second request waiting on its own PR (a 403 on its PR read behind a first one with an invalid project config) waited with no deadline, and so did its auto-merge, which defers to its queued request's wait. Now every such request has its own wait.

## What changed

- **Migration 58** (`verify-wait`) adds `wait_reason`, `wait_ref` and `wait_since` to `verify_queue`. They are null while a request does not wait on its own.
- **The drain** (`drainVerifyQueue`, src/verify/start.ts) records the wait whenever `stillWanted` makes a request wait (`markWaiting`, src/verify/queue.ts), with a `verify.waiting` event in the same transaction. The clock starts the first time. A new reason keeps it, since the request never stopped waiting, and the event says which reason it replaced. The same reason on a later pass writes nothing, even when its ref differs (an outage reads `unreachable`, then `unreachable 502`), and the first ref is kept, so a drain every scheduler pass adds no events. Once `stillWanted` says the request may start, the drain clears the wait (`clearWaiting`, a `verify.wait_ended` event with how long it waited). A started or cancelled request keeps its last reason as history. The registry only reads queued rows.
- **The reasons are fixed codes**: `config_invalid`, `forge_outage`, `stale_read` and `pr_unreadable`. `wait_ref` holds the id the code names: the short head GitHub still shows (`stale_read`), or the forge error's kind and HTTP status (`refused 403`, `unreachable`). PR text, error messages and tokens are never stored. The text shown is built from the code (`ownWaitCause`). For `config_invalid`, the registry re-reads the config error from today's config.
- **The registry** (`verifyQueueWaits`, src/reconcile/waits.ts):
  - Every queued request with a recorded reason gets its own `verify:<id>` wait. It is due `[waits] verify_queue_min` after `wait_since`, and its cause is `waits on its own PR, so the requests behind it go first: <its cause>`. For `config_invalid` the fix is `flowryn config; flowryn verify show <id>`, otherwise `flowryn verify show <id>`.
  - The head-of-line wait, with its expected-start formula unchanged, now goes to the first queued request without a recorded reason, the one the drain tries next. When requests that stepped aside are ahead of it, its cause says so.
- **`verify show`, `flowryn capacity`** (`waitingOn`): a request waiting on its own shows that cause. A request behind one that stepped aside no longer lists it as `behind`.

## Choices

- The head-of-line wait moves past the requests that stepped aside. Before, the first request covered the whole line. With each of those requests now carrying its own wait, a line wait still pinned to them would leave the request the drain actually tries next (held by a full pool, say) with no wait. The deadline amounts and the drain order are unchanged.
- A request's own clock is `wait_since`, not its request time. That is the requirement: R2's clock starts when R2 began waiting. Once its wait clears, it rejoins the line wait, which counts from its request time as before.
- A recorded reason is the drain's last reading. While a full pool, a pending restart or a failing host check stops the drain before it reaches the request again, the reason stays as it was (except a `stale_read` the watcher's head disproves, which every drain clears first: docs/notes/2026-11-07-fix-a-held-ss.md). Its deadline still runs: the recovery kicks the scheduler, which re-reads it, and the item that may follow names the last cause seen. A bounded, possibly stale cause beats no deadline.
- The auto-merge skip (`autoMergeWaits` ignores a row whose request is queued) stays: that request is now always covered, by its own wait, by the line wait, or by being behind the line's head.

## Tests

- test/unit/waits.test.ts: R1 (an invalid config, waiting from 2 min) and R2 (a 403, waiting from 7 min) get two waits with deadlines at 22 and 27 min. They are recovered and itemized on their own clocks, each item naming its own cause. The request next in line gets the line wait. Once R2's wait clears, R2 counts from its request time.
- test/unit/verify-queue.test.ts: migration 58 applies forward at 57. The drain records both reasons and their start with `verify.waiting` events and stores no forge message. A repeated reason writes nothing. A new reason keeps the clock. A start clears the wait with `verify.wait_ended`. A stale read records `stale_read` with the head GitHub shows.
