# A superseded steer stops raising "not acknowledged"

- Status: done

On 2026-11-07 the leader sent two steers (m630, then m632) to one worker. The worker acked m632 and acted on it, but m630 stayed unacked, so `flagUnackedSteers` opened a `steer_unacked` P1 for it after every ring. Dismissing the P1 did not help: the check only looked for an open or presented item, so a dismissed one let the next reconciler pass open a new one (i1591, i1593, i1594, i1599, i1600, i1601).

## What changed (src/lifecycle/steers.ts)

- **An ack settles older steers.** `ackSteer` now also marks every older unacked steer on the same run as acked, at the same time. Older means created earlier, or created in the same millisecond with a lower message number. Each one gets a `steer.superseded` event with `{ steer, by, rings }`, where `by` is the steer that was acked. They stop ringing and are never flagged. Any open `steer_unacked` item on the run is resolved by `steer.acked <id>`, even when the acked steer rang only once. `flowryn ack` adds `superseded: [ids]` to its reply when it settled any. Newer steers are left alone and keep ringing.
- **A steer is flagged at most once.** `flagUnackedSteers` skips a steer that already has a `steer_unacked` item in any state: open, presented, resolved or dismissed. It finds the steer through the item's `steer.unacked` event payload. A dismissed item therefore stays dismissed. A different steer on the same run that runs out of rings can still open its own P1.

The rule is deterministic: the worker has acted on a later steer, so the earlier one no longer needs an answer. No new verb, column or migration was added, and ring timing is unchanged.

## Tests

`test/unit/steers.test.ts` covers four cases. Older steers are settled, with their events, and never flagged. An open P1 for an older steer is resolved while newer steers keep ringing. A dismissed item is not reopened, but a different steer can still flag. `recentSteers` now uses an order the new rule allows. The three new tests fail without the fix.
