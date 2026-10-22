# P1 lane means "needs attention"

- Status: done

`flowryn fleet` showed `P1 11` while the briefing said "Needs you: nothing": the count included informational items (`contract_recorded`, one per harness version and never closed, and `auto_resumed`), which piled up for days. Now the P1 count is only what needs you, and info items close by themselves. Everything here is plain code: SQL, a constant and a migration. No model is used.

## The count

`fleet`'s `open` line (`P0 n · P1 n`, src/lifecycle/leader-verbs.ts) counts only `class = 'actionable'` items, open or presented. The briefing's "Needs you" and fleet's `needs` list already did (`openActionable`, src/attention/router.ts). The rule is by class, so it covers every info kind in the lane table (`LANE_TABLE`, src/attention/items.ts), not just these two.

Choice: count only actionable items, rather than moving info kinds to P2. Their lane still decides how they reach the leader: a P1 info item rides the digest, at most three carries (`MAX_INFO_ATTEMPTS`), and P2 items never do. Moving them would have changed delivery as well as the count. The board's "UPDATES (last day)" still lists info items in any state.

## Info items close by themselves

- **A newer contract record supersedes the older item.** `recordPass` (src/contracts/verbs.ts), the one path for a leader's, your terminal's and the daemon's automatic records, resolves the harness's open `contract_recorded` item (`superseded by <harness> <version>`). The item is keyed by `task_id = harness:<id>` (`harnessItemKey`, as `harness_unverified` is). The leader's record and the automatic check open the new one through `openContractRecorded`, so at most one stays open per harness. Your own terminal's record opens no item, but it still supersedes the old one.
- **Retention after presentation.** An info item that a leader turn presented (its newest confirmed presentation) more than `INFO_KEEP_MS` ago is resolved (`presented, kept 1 day`), with one `items.info_closed` event (`{items, keep_ms}`). `INFO_KEEP_MS` is a constant of one day, the same window as the board's updates list. `[upkeep] explanations_keep_days` (30 days, for closed wait explanations) did not fit, and no new config key was needed. The upkeep pass runs it (`closeSeenInfoItems`, src/attention/items.ts) each tick, with the explanation prune and before the busy check, so it runs even when a pass otherwise waits. A failure is logged and does not stop the pass. An info item that was never presented stays open for the digest, as before, and drops to the board after three carries with no presentation (`loseCarried`). Actionable items are never touched.

## Migration 28

`info-items-close` cleans up what was left open before this change:

1. A `contract_recorded` item that has a newer one for the same harness (the line's first word) is resolved.
2. The newest open one per harness gets its key, so the next record supersedes it.
3. Any info item still open or presented that opened over a day ago is resolved.

Actionable items are left alone. Like the earlier data migrations, it writes no event.

## Tests

`test/unit/info-items.test.ts`:

- fleet's P1 ignores info items, open or presented, for every info kind in the lane table, and agrees with the briefing.
- A newer contract record closes the older item, presented or not. It is per harness.
- A presented info item closes after the window, measured from its newest presentation, with its event. One inside the window, or never presented, stays.
- Actionable P1s are untouched.
- The upkeep pass closes info items while it waits.
- Migration 28 runs on a scratch database at schema 27.
