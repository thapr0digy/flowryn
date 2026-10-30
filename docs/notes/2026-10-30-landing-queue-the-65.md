# Landing queue: the daemon brings approved PRs up to date and merges them in turn

- Status: done
- Open: not yet run live; fathom is the first project to try it (the leader sets `landing = "queue"` there; this PR changes no one's config). Flowryn itself only after fathom.
- Config: `[projects.<id>] landing`

Research report recommendation 2 (`~/.flowryn/data/research-improving-flowr-6e/report.md`, sections 2.2, 1.2 and 1.5), design reviewed at gate g255. Everything here is plain code: git, the verify queue, the auto-merge state machine and the merge gate. No model.

## What it does

`[projects.<id>] landing = "queue" | "manual"` (default `"manual"`). With `"queue"`:

- A ready PR joins its project's line when its work is routine (yolo, not sensitive), or when a human approved its merge: the leader's `flowryn merge <task>` (its Claude prompt, chat grant or Pi confirm), or `flowryn approve <task>` in your shell.
- The first entry that can go is brought up to date in the run's own worktree:
  - `git fetch origin <base>`; if the branch already has the tip, nothing is merged;
  - otherwise `git merge --no-ff --no-edit -m "Merge origin/<base> into <branch> (Flowryn landing queue)" origin/<base>`, a plain merge commit, then `git push origin HEAD:refs/heads/<branch>` (never a rebase, never forced, never `-u`);
  - the delivery is carried to the new head (`run.head_carried`, `via: landing`) and its verify queued;
  - an `auto_merges` row then verifies, waits on GitHub's checks and merges, exactly as on an `auto_merge` project.
- A merge that conflicts is undone (`git merge --abort`) and the ship is sent back with today's conflict nudge (same text, same `run.conflict_nudged` event, same limit of three, then `pr_conflict`), now naming the conflicted files. The next entry starts.
- Just before the merge, the base is fetched again: if it moved past the verified head, the entry goes back to be brought up to date (the row superseded as `base_moved`), at most `MAX_INTEGRATIONS` (3) times, then it is held.
- One entry per project lands at a time. The others wait with `; auto-merge: landing queue: 2 of 3, behind t7 (lq9)` on their `pr_ready` line, and the leader is not woken for them.
- For Flowryn's own project, the rebuild after a merge waits while its line still has PRs to land, so the daemon rebuilds and restarts once per drained line, for at most `LANDING_HOLD_MS` (2 h) from the first merge it held (`upkeep.build_held`).

```toml
[projects.fathom]
verify = ["bun install --frozen-lockfile", "bun run typecheck", "bun test"]
landing = "queue"
```

`landing = "queue"` is refused (`config_invalid`) without `verify` steps, as `auto_merge` is: the queue verifies each PR again after merging main into it. It is not part of the verify policy. `auto_merge` is not needed beside it; on a queue project a delivery never starts an auto-merge of its own (it would land out of turn).

## Approvals (the user's answer q130)

An approval carries across the queue's own clean merge of the base, unless the work is sensitive.

- On a queue project, `flowryn merge <task>` checks only the approval (sensitive work needs a human record even under yolo, as at the merge gate). It does not merge: it leaves the approval standing as a record bound to the head (`standingApproval`: your record as it is, a Claude prompt, chat grant or Pi confirm turned into one), puts the PR in line and replies `landing: lq<n>`, `position`, `state: queued`. A yolo task needs no record.
- When the queue merges the base in, the carry voids standing records as any new head does; the queue then copies the entry's approval to the new head (same channel, same waiver, same expiry; the actor says `carried across a clean merge of main`). The daemon's merge finds it only through the live entry (`findLandingApproval`, for `DAEMON_CALLER` only).
- Sensitive work: the approval does not carry. The entry leaves (`approval_needed`) with an `auto_merge_held` item naming `flowryn merge <task>`; the pushed merge of main stands, so your word at the new head is all it needs.

## Leaving the line

An entry is `landed` when its run lands, or `left` with a reason: `conflict`, `sent_back` (a verify failure or a decline), `redelivered` (it rejoins at the back once delivered again), `held:<code>` (its auto-merge was held), `superseded` (its auto-merge was superseded), `auto_merge_gone`, `landing_blocked` (busy worker or changed worktree for over 30 min), `push_refused`, `merge_failed`, `not_clean`, `no_worktree`, `approval_needed`, `base_moving`, `landing_off` (the project left the queue), or the run's end. Holds open `auto_merge_held` (`Landing held: …; <next command>`), which wakes the leader. An entry is never taken again at the head it left at; a new delivery, or the leader's `flowryn merge`, puts it back.

A head of line whose worker is busy, shows a dialog, or whose worktree has uncommitted changes is skipped for the next entry that can go (`landing.blocked`), and keeps its place. Its 30 minutes restart when another entry starts landing, so only time spent being tried counts. A clean worktree that is only behind the entry's head (a merge of main made on GitHub, carried by the watcher) is fast-forwarded to it first (`git fetch origin <branch>`, `git merge --ff-only`).

## Where it lives

- `src/verify/landing-queue.ts`: the store (`landing_queue`, migration 48), `enqueueLanding`, `deliveredToQueue` and the `LandingQueue` controller. It runs inside the auto-merger's pass (before and after the rows) and its `beforeMerge` hook, so every kick that moves an auto-merge moves the line.
- `src/verify/auto-merge.ts`: `createAutoMerge` (a row for any caller), `supersedeAutoMerge`, `setReadyProgress`, the `LandingHooks` dependency; a row that is a live entry's is not superseded by `auto_merge` being off.
- `src/lifecycle/delivery.ts`: `carryLanding`. `src/reconcile/delivery.ts`: `sendConflictBack` (shared with the watcher's nudge), and a PR read whose head is the one the delivery was carried from is GitHub lagging behind the push, not a moved head.
- `src/policy/merge.ts`: `standingApproval`, and `findLandingApproval` in `chooseApproval` for the daemon. `src/policy/verbs.ts`: the merge verb's queue path.
- `src/upkeep/build.ts`: the rebuild hold. `flowryn show` has `landing:`; "why waiting" has `merge.landing`.
- Deliver replies `landing: queue` on a queue project and kicks the watcher, whose pass kicks the queue.

## Tests

- `test/unit/landing-queue.test.ts` (real git against scratch repositories): the config key; who joins (routine, an approval at the head, not otherwise; no wake); a delivery on a queue project starts no auto-merge; the daemon's merge is a two-parent merge commit with the delivered head first, pushed, that proves clean (`cleanMainMerge`), with its delivery carried and verify queued while the next PR waits; an up-to-date PR is not merged into; a conflict undone and sent back with the file; busy and dirty worktrees skipped then held after 30 min; a merge cut off before its push pushed on the next pass; an approval carried (channel, waiver, expiry) and found only by the daemon; sensitive work held for your word; a moving base re-integrated, then held at `MAX_INTEGRATIONS`; the watcher's lagging read opens no divergence.
- `test/unit/upkeep-build.test.ts`: the rebuild waits while Flowryn's line has PRs, builds once it drains, and builds after `LANDING_HOLD_MS` anyway.
- `test/integration/landing-queue.test.ts` (real daemon, fake GitHub over a bare origin, fake workers): two routine PRs land in order, the second with the daemon's merge of main, a new verify at that head and its merge there; a conflicting second PR is sent back with `same.txt`, its worktree clean at the delivered head.

## Choices

- Built on the auto-merge state machine rather than beside it: the verify, checks and merge path is already tested; the queue serialises it and adds the catch-up merge.
- The daemon carries the delivery itself after its push (rather than waiting for the watcher), and the carry is not limited to routine work: the daemon made the merge. A watcher read between the push and the carry may open a head-move divergence for exactly that move; the carry closes it (`settleHeadMove`, resolution `carried`). For routine work the watcher may carry it first (also after a stop between the push and the carry); the entry keeps its place and the queue lands at the carried head. A live direct auto-merge from before the project queued is superseded when the entry starts landing.
- The merge runs in the run's worktree, so a later send-back starts from it. Workers do not take Flowryn's repo lock, so the guard is the run's liveness and a clean worktree, checked just before the merge (the design said "the repo lock"; this is the deliberate change).
- `flowryn merge` on a queue project never merges at once; to bypass the line, switch the project to manual.
- A stacked PR (its base another task's branch) does not join until it is retargeted onto the default branch.
- No contract revision bump: the worker's path is unchanged apart from the conflict steer's text and the deliver reply's extra field.

## What was not checked

- How many past conflict send-backs would have been clean merges by the time the worker acted (the events do not keep the head). Fathom's first week shows the split between clean catch-ups and real conflicts.
- A repository hook that refuses a daemon push from a worker's worktree: the tests use plain bare origins.
- Real GitHub's `mergeable` right after the daemon's push may read unknown briefly; the queue does not read it (git decides).
