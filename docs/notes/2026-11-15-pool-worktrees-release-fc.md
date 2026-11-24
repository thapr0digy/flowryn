# Release a worktree's services before it goes

- Status: done
- Open: appsec-signal's `release = ["make pg-test-down"]` not yet set or run live (the leader sets it after merge)
- Config: `[projects.<id>] release`

A project can name commands that free a worktree's own services, such as a per-worktree test database, before the worktree goes back to the treehouse pool or is removed. Without it, appsec-signal's pool worktrees kept their `make pg-test-up` PostgreSQL containers (up to 2 GiB each) running for days after their tasks ended, and seven of them filled the Colima VM. `make pg-test-gc` does not help there: it removes only servers whose worktree directory is gone, and pool worktrees are reused, never gone.

```toml
[projects.appsec-signal]
release = ["make pg-test-down"]
```

## When it runs

- **A run's worktree** (pool slot or plain git worktree), in the cleanup procedure (`src/policy/cleanup.ts`), whenever a cleanup gets past its safety checks: a landed run, a cancelled or failed one, a discard you approved. Order: verdict, git lock, the parked no-mistakes run, the worker stops, **release**, the reap, the git lock again, the return or removal, the branch.
  - After the worker, so nothing of the task still uses the services.
  - Before the reap, so the reap also ends anything the release leaves running, and the second lock check catches a git lock it leaves.
  - Before the return, never after: once returned, the next run may already hold the slot, and its services would be the ones stopped. After a git removal the directory is gone.
- **A verification's checkout** (`src/verify/runner.ts`): a slot's at the end of each use (`endCheckout`), and at the start (`prepareSlot`) only when the previous end did not release it (docs/notes/2026-11-24-verifies-reuse-one-a6.md "The reset rule"), a one-off `v<n>/wt` before git removes it, however the verification ended. A slot kept for a resume after a daemon restart is not released; its next use releases it (docs/notes/2026-11-24-verifies-reuse-one-a6.md).
- Not when the worktree is already gone (nothing to run in), and not when the cleanup is refused before the worker stops: that worktree stays, with its services.

A cleanup refused after the release (a process that survives the reap, a failed return) keeps the worktree without its services; the next `make test` starts them again, as it does after any `pg-test-down`.

## How it runs

- Each entry is one command, split on whitespace into argv and run without a shell. A quote, `$`, a backtick, `|`, `&`, `;`, `<`, `>`, `(`, `)`, `*` or `\` is refused as `config_invalid`: put such a command in a script and name the script. A malformed value is refused by every config check that reads the project (`verifyConfig`); at cleanup time it is logged and nothing runs.
- In order, in the worktree, through `runBounded`: its own process group and a 60-second deadline each. Every command runs even when one before it failed.
- The environment is a daemon-made verify's (`releaseEnv`, `src/verify/runner.ts`): the daemon's environment, scrubbed, with the project's last `flowryn verify` caller's PATH, else the daemon's plus `~/.bun/bin`. A release finds the same `make` and `docker` that the project's verify steps do.

## When it fails

A non-zero exit, the deadline or a command that cannot start is logged (`cleanup <task>: release <command> failed (code N): <last line>`, or `verify <id>: ...`) and recorded as an event with the failed commands and their last 20 lines of output (at most 4 KB each):

- `run.release_failed` on the run (`worktree`, `failed`), and `release:failed` in `cleanup.done`'s steps.
- `verify.release_failed` (`verification`, `worktree`, `failed`).

A failure never refuses a cleanup or keeps a worktree: one broken command would otherwise pin every worktree of the project.

## Tests

- `test/unit/project-release.test.ts`: the key (argv split, refusals, the known-key check), the runner (order, cwd, a failure or a deadline never stopping the next, a command that cannot start, the output tail).
- `test/unit/treehouse.test.ts`: the release runs once after the worker stops and before the reap and the return, with the branch still checked out; a failed one still returns the slot; none on a refused verdict or a gone worktree.
- `test/unit/verify.test.ts`: release before removal, pass and fail; a failure recorded and the worktree still removed; a worktree kept for a resume not released.
- `test/integration/treehouse-pool.test.ts`: a cancelled pool run's cleanup runs the release in the slot, records a failing one, and still returns the slot.
- The cleanup fixtures pass no release, so `fixtures/cleanup-guard` and `fixtures/cleanup-order` pass unchanged.
