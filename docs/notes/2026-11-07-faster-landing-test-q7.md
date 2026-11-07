# Faster landing: test queued PRs together, resume verifies after a restart

- Status: done
- Open: not yet run live on a real GitHub squash merge (the tests play it with `git merge --squash` on a scratch origin)
- Config: `[projects.<id>] landing_train_depth`

The leader audit of 2026-11-06 found the landing queue landing one entry per project at a time with a verify of about 28 min each (about 2 PRs per hour), a verify interrupted by a daemon restart redoing its whole run, and a parked restart holding new verifies for up to 60 min. All of it is plain code: git plumbing, tables and timers. No model is involved.

## The landing train (`src/verify/landing-queue.ts`)

One entry per project still lands at a time; only the verifies run ahead.

- **Candidates.** While the head of line verifies, each waiting entry within `landing_train_depth` (the head of line counts: depth 2 means one entry verifies ahead) gets a candidate: git's own merge of its delivered head and the head ahead of it (`merge-tree --write-tree`, then `commit-tree` with the delivered head as first parent and the head ahead as second). The head ahead is the head of line's head for the first, then the candidate ahead's. The candidate is written into the project's object store only: never into the worktree, never pushed, so dropping one never needs a force-push. The entry records it as `train_head`, `train_base` and `train_request` (migration 57), and a `landing.train_built` event carries its base, head, the delivered head it builds on and its place.
- **Free slots only.** The candidate's verify request is queued at `TRAIN_RANK` (1), behind every ordinary (0) and recovered (-1) request, so it takes a validation slot only when nothing else waits. The drain starts it without asking GitHub (it is not the PR's head yet) while a live entry keeps it, and cancels it ("the landing train no longer tests ...") otherwise.
- **Promotion.** When the entry ahead lands, the next pass promotes the candidate instead of merging main, when all of these hold: the last entry that landed on the project landed at the candidate's base; the candidate's newest finished verify did not fail; the worktree is at the delivered head; the candidate's parents are the delivered head and the base; and `trainBaseHolds` proves with git that main's tree is exactly the base's (whatever the merge method: a squash, a merge commit or a rebase all leave that tree) and that git's merge of the candidate into main writes exactly the candidate's tree. The worktree then fast-forwards to the candidate and it is pushed (a plain push: it descends from the delivered head), the delivery is carried as the queue's own merge is, the candidate's request moves to rank 0 (`verify.reranked`), and the landing's auto-merge follows that verify: a pass that already finished makes it wait on checks at once.
- **Before the merge.** A promoted entry keeps `train_base`. Its merge needs `trainBaseHolds` again instead of the usual "main is an ancestor of the head", since a squash merge never puts main's own landing commit in the candidate. A main that moved since sends it back to merge main, as a moved base always did, with its train fields cleared.
- **A base that changes.** A candidate whose base is no longer the head ahead (the entry ahead left, was sent back, merged main again, or its head was carried) is dropped (`landing.train_dropped`, its queued request cancelled) and built again on the new base on the same pass. A head of line that leaves leaves its follower's candidate unpromotable (nothing landed at its base): it is dropped and the entry merges main as before. A merge that conflicts builds no candidate (`landing.train_skipped`), and a candidate whose verify failed builds none behind it: the train ends there, and the entries behind wait their turn as before.

The merge gate is unchanged: a merge still needs a pass at the exact head that lands, and the promoted head is the very commit its verify ran on.

`landing_train_depth` is an integer from 1 to 5 (`MAX_TRAIN_DEPTH`), 2 by default on a queue project (`DEFAULT_TRAIN_DEPTH`); 1 turns the train off. `flowryn config` shows it beside `landing = "queue"`. With depth N, N queued PRs land in about one verify time plus their merges and checks.

## Verify resume (`src/verify/start.ts`, `src/verify/runner.ts`)

- A verification a daemon stop cuts off (a graceful stop, or a dead daemon found at startup with its steps ended) is still recorded as an error ("the daemon stopped mid-run") and requeued as before, but now keeps its worktree.
- A new verification of the same PR, head and verify policy, with exactly the same steps, resumes the newest such one whose slot is free and whose worktree is still there (`resumableFrom`): every step that passed or was skipped there is kept (`resumed_from`, its detail "kept from v<N>"), and the rest run. The `pr.verify_started` event names `resumed_from` and the kept steps.
- At the start the resumed verification takes the old worktree over (`git worktree move` into its own directory, under the repository's worktree lock), so the kept steps keep what they built (an install, a build), checks that it is at the head, and copies the kept steps' logs into its own directory. A source worktree that is gone, will not move or is not at the head drops the resume (`pr.verify_resume_dropped`, with why) and every step runs from a fresh worktree.
- A new head or another policy is never resumed: it starts fresh. A verification that failed or passed is never a source. A kept worktree nothing resumes goes with its directory when `pruneDirs` removes it.

## The restart hold (`src/daemon/restart.ts`)

`RESTART_HOLDS_VERIFIES_MS` is 10 min (was 60). A verify a restart interrupts now resumes from its first unfinished step, so holding new ones back for long saves little, and a restart parked on something else (a confirmation dialog) no longer stops every verify for an hour.

## Tests

`test/unit/landing-train.test.ts` (real git, GitHub's squash played by a second clone): a train of three lands in order, each at its candidate on the head that landed before it, with every base on its event; a middle failure re-bases the one behind it without the failed one; the head of line leaving integrates the next as before; a conflicting candidate ends the train; main holding more than the base, or moving after the promotion, never lands the candidate; `trainBaseHolds` on its own; the depth key. `test/unit/verify-resume.test.ts` (real worktrees and shell steps): a resume keeps the passed step and its log and finds what it built; one through startup recovery; a new head, or a changed policy, during the interrupt starts fresh; a moved source worktree drops the resume; a failed verification is never resumed. `test/unit/verify-queue.test.ts`: a candidate's request starts without asking GitHub, waits behind the others, and is cancelled once dropped; the 10-minute hold.

## Known limits

- A dropped candidate whose verify is already running is not stopped: it finishes and nothing follows it (it holds its slot until then).
- Candidates are unreferenced commits in the project's object store; git's gc keeps unreachable objects for two weeks by default, far longer than a candidate lives.
