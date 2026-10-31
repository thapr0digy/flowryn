# Flaky pr-reviews test: two clock reads a millisecond apart

- Status: done

`test/integration/pr-reviews.test.ts` "a stranger's marked reply answers
neither a thread nor a change request; a resolved thread and an approval do"
failed two full-suite verifies (v90, v109) with every other suite running
beside it, and passed alone.

## Cause

Not a wait, a poll interval or a deadline: a timestamp. The test adds a
change request and an inline comment back to back, and the fake GitHub
stamps each with its own `new Date().toISOString()` (millisecond
resolution). The feedback reader orders items by time, then by key
(`src/forge/feedback.ts`), and the `run.review_steered` event lists the keys
in that order. The test expected `["comment:1001", "review:1000"]`, the key
order, which holds only when both adds fall in the same millisecond. Under
load (a GC pause or a descheduled thread between the two calls) the clock
ticks between them, the review sorts first, and the event's keys come out
`["review:1000", "comment:1001"]`: exactly the v109 diff.

The product is right: ordering by time is what a reviewer reads, and the
tie-break only makes equal times stable.

## Fix

The test reads the clock once and passes that `at` to both adds, so the
two items always tie and the key tie-break decides, as the assertion
expects. No product code changed.

## Proof

- Giving the comment `at + 1 ms` reproduces the v109 failure every time,
  with the same diff.
- With the fix, the whole file (all four tests) passed 20 of 20 runs under
  24 busy loops (`2 × hw.ncpu`).
