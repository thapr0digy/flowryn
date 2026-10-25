# Flaky verify-queue test: concurrent worktree adds in one repository

- Status: done

## Design

### The cause: a real race in git, not the test

"draining the queue > assumption: jobs in one repository at once do not collide"
(`test/unit/verify-queue.test.ts`) failed in two `flowryn verify` runs on
2026-10-23 (v35 is one) with one of its four jobs in state `error`. Rerunning it with the
job's `detail` in the assertion, 8 copies at once, gave the error:

```
git worktree add failed: Preparing worktree (detached HEAD 78b95e3)
fatal: failed to read .git/worktrees/wt1/commondir: Undefined error: 0
```

`git worktree add` lists the repository's worktrees while it sets up its own,
and reads the admin directory (`.git/worktrees/<name>/`) of another add that
has created it but not yet written its `commondir`. Plain git shows the same
thing with no Flowryn involved: 8 concurrent `git worktree add --detach` in one
repository, 30 rounds, failed 1 of 240 adds with that message. So the queue's
claim that jobs in one repository can run at once was true for the fetch (an
empty `--refmap`, `--no-write-fetch-head`: no shared ref or file is written) but
not for the worktree add, which the queue ran concurrently too.

### The fix

`src/runtime/repo-lock.ts`: `withRepoLock(repo, fn)`, an in-process FIFO lock
keyed by the repository's real path. Every worktree add, remove and prune the
daemon runs in a project repository takes it:

- the verify job's `git worktree add` and `removeWorktree` (remove, prune);
- the run launcher's `git worktree add` (`src/lifecycle/launcher.ts`), since a
  run starting while a verify adds its worktree in the same repository races
  the same way;
- the merge build's prune and add (`src/upkeep/build.ts`).

Only those git calls are serialized: the fetch, and the verify steps
themselves, still run concurrently, so jobs keep overlapping for all but a
fraction of a second each. Each git call has its own deadline (`runBounded`),
so a hung holder releases the lock when its git is stopped. Plain code; no
model.

Not a retry: the failure is not one of git's lock files (`index.lock`,
`<ref>.lock`), so there is no lock error to retry on, and a retry would only
make the collision rarer.

### Before and after

The collide test's own shape (4 jobs) fails rarely on an idle Mac: 1 of 120
runs with 8 copies of the file at once. A temporary variant with 12 jobs and
`validation = 16`, 4 copies at once:

| | runs | failed |
|---|---|---|
| before | 40 | 3 (4 jobs, all the `commondir` error) |
| after, 12 jobs | 120 | 0 |
| after, 4 jobs, 8 copies at once | 80 | 0 |

The test is kept as it was, with each job's `detail` added to its assertion so a
future failure names git's error. `test/unit/repo-lock.test.ts` checks the lock:
turns in arrival order by any path to the repository (a symlink), another
repository alongside, a throwing holder releasing it.

### Open questions

- The cleanup runner (`src/policy/cleanup.ts`: `worktree remove` and `prune`)
  and the contract cleanup (`src/contracts/cleanup.ts`, synchronous, lab-only)
  do not take the lock. Recommendation: leave them for now. The cleanup runner
  changes need the cleanup-guard fixture sets, and a remove or prune racing an
  add has not been seen to fail (an add writes its `locked` file first, which
  prune honours); take the lock there in a follow-up if one is.
- The lock is per daemon process. A worker's own `git worktree add` (treehouse)
  in the same repository is outside it. Recommendation: accept; workers add
  worktrees rarely and from their own checkout, and a cross-process lock file
  would be a second thing git does not know about.
