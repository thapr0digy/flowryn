# Run worktrees from a treehouse pool

- Status: done
- Open: not yet run live under the daemon (a Herdr pane in a pool slot, a repository with its own `treehouse.toml` and warm-up hooks); verification worktrees still use plain git (below)
- Config: `[workers] worktree_provider`

Each run used to get a brand-new `git worktree add` under `[workers] worktree_root` and lose it at cleanup, so installed packages, virtual environments and build caches were rebuilt every run. Now the daemon leases a run's worktree from a pool kept by [treehouse](https://github.com/kunchenguid/treehouse) and hands it back at cleanup, reset but with its ignored files (the warm caches) kept. Plain code throughout; no model is involved.

## Config

`[workers] worktree_provider = "treehouse" | "git"`, default `"treehouse"`.

- `treehouse`: a run leases a pool slot when treehouse is found ([tools] or PATH) and its calls succeed; otherwise it gets today's git worktree at `<worktree_root>/<project>/<task>`, with a log line (`launch <run>: no pool worktree (<why>); using a git worktree`) and a `run.worktree_fallback` event. Doctor's `worktrees` line names the provider and treehouse's version, and `worktree fallbacks` warns about any fallback in the last day with the last reason.
- `git`: never calls treehouse. Test homes and contract runs use it (their cleanups remove their own worktrees by exact name).

A run keeps the kind of worktree it started with: a git-provider run stays on git after the setting changes, and a pool run is returned to the pool.

## The pool

Flowryn's pool is its own, at `--root <worktree_root>/<project>/.pool`, never the pool a user or agent uses by hand: `treehouse return --all` in that pool also returns leased slots, so a manual "return everything" could pull a folder from under a live worker. Under the project's worktree folder it is covered by what already covers that folder (the scope guard). Slots are `<root>/.treehouse/<repo>-<hash>/<slot>/<repo>-<slot>` (`--unique-leaf`, so tools that name things after the folder, like Docker Compose projects in visual QA, never collide across concurrent runs). Treehouse's own settings in the repository's `treehouse.toml` (pool size, warm-up hooks, `.worktreeinclude`) still apply; `--root` overrides only its root.

Calls (treehouse 3.1.8, read from each subcommand's help and tried in a scratch repository), all through `runBounded` with stdin at EOF and `TREEHOUSE_NO_UPDATE_CHECK=1` (src/runtime/treehouse.ts):

| When | Call |
|---|---|
| Launch | `treehouse --root R get --lease --json --no-fetch --unique-leaf --lease-holder flowryn:<run>` from the checkout. `get --lease` is the one non-interactive acquire that resets a slot; `lease <name>` only marks an existing slot. `--no-fetch`: the base commit is already local. |
| Launch after a crash | `treehouse --root R status --json`: a slot whose `lease_holder` is `flowryn:<run>` and whose folder exists is adopted, so a lease taken but never recorded is not leaked. |
| A get that failed | the same status, and a slot it leased anyway (a warm-up hook failing, or the 300 s deadline after the lease was taken) goes back with `return --force --if-lease-id`. |
| Cleanup | `treehouse --root R return [--force] --if-lease-id <lease> <path>`: `--force` only for a discard you approved, as `git worktree remove --force` was; `--if-lease-id` never returns a slot another run holds now. |

## Launch

`ensureWorktree` (src/lifecycle/launcher.ts), under the repository lock (src/runtime/repo-lock.ts) for the get (a new slot is a `git worktree add`) and for the checkout:

1. A run whose `worktree_path` exists is checked as before (a worktree root, on the run's branch). One holding a lease whose slot is still detached (the daemon stopped between lease and checkout) finishes its checkout.
2. A run holding a lease whose slot is gone (destroyed by hand) returns that lease forced (logged if treehouse refuses it, the lease then staying held in treehouse) and prunes git's record of the slot, under the repository lock (otherwise git still counts the run's branch as checked out there and no new slot can switch to it), then records `run.worktree_lost` and takes another slot; the branch still has its commits. A slot treehouse still lists for the run but whose folder is gone is never adopted, so the launch cannot pick the vanished slot again.
3. Otherwise, with the treehouse provider: adopt or lease a slot, record `runs.worktree_path` and `runs.worktree_lease` with a `run.worktree_leased` event in one transaction, then check the slot is clean (`git status --porcelain` empty: ignored files are fine) and `git switch -c <branch> <base_sha>`, or `git switch <branch>` when it exists. Treehouse's own `-b` cuts from its base branch, not an arbitrary commit, so it is not used (stacked phases need `base_sha`). A failed check or switch returns the slot forced (nothing of the run's is in it yet), puts the planned git path back with `run.worktree_returned`, and fails the launch with git's words, as a failed `git worktree add` did.
4. Treehouse missing, or a status or get call failing: the git worktree, as before. A get that fails after treehouse marked a slot leased hands that slot back forced first (nothing of the run's is in it), so the fallback leaves no lease held.

The dispatch still records the planned git path; the launch replaces it with the slot's. A dispatch of a task whose earlier run still holds its slot (not cleaned up) is refused `already_exists`, as the planned path existing refuses it for git: the branch is checked out there.

## Cleanup

The order is unchanged (src/policy/cleanup.ts): the landed-work verdict, the index lock, the parked no-mistakes run, the worker's exit, the reap of every process whose cwd is inside the worktree (the Herdr pane's shell included). Then, for a run holding a lease (`returnWorktree`, src/lifecycle/landing.ts), the slot is returned instead of removed, and the branch is deleted as before. On `cleanup.done` the run's `worktree_lease` is cleared. A slot whose folder is already gone (destroyed by hand) has its lease returned forced, since nothing is left to lose (a failure is only logged, the lease then staying held in treehouse, as at launch), then the worktree list is pruned as before, so the lease is handed back whenever the run lets go of it. With treehouse uninstalled since the launch, the cleanup is refused `remove_failed` (install it and retry) rather than removing the slot with git: a git removal would leave treehouse holding the lease for good, which quietly shrinks a capped pool, while the refusal names its own fix.

What the guard protects is kept the same way:

- A plain return refuses a slot with uncommitted or untracked files (treehouse cannot ask with stdin at EOF: exit 3), as `git worktree remove` without `--force` did; the cleanup is refused `remove_failed` with treehouse's words and the slot, branch and head stay.
- A discard needs your approval as before; it returns forced and records `discarded_head`.
- A clean return of a slot on an unlanded branch resets the slot but the branch ref keeps its commits; the guard's verdict came first, as for git.

What the next run in a returned slot does not inherit: the branch (the return detaches the slot, then the branch is deleted), tracked or untracked changes (a plain return refuses them, a forced one cleans them, and the launch checks the slot is clean), and processes (the reap, then treehouse's own check for lingering processes). Ignored files stay: they are the warm cache, and a pool never crosses projects. That includes any ignored file a worker wrote, such as a local secrets file or logs; the repository's `.gitignore` and `treehouse.toml` decide what that is, and `worktree_provider = "git"` turns the pool off.

## Everything that read a run's worktree path

- Scope guard (src/leader/scope-guard.ts): denies `<worktree_root>/<project>` (it named only `<data_dir>/worktrees/<project>`, so a custom root was not covered), which holds the pool; a run's own path only until it is cleaned up, since a returned slot may be another run's; the list is rewritten when a lease is taken or returned.
- Promote (src/lifecycle/promote.ts): a cleaned-up scout's slot still exists in the pool, so "the scout's worktree is still there" now applies only to a run not cleaned up.
- Relink (src/lifecycle/relink.ts): `git worktree repair` also covers the project's idle pool slots (found on disk, `poolSlots`), so a moved checkout does not leave the next lease a broken slot.
- Resume, drop, review revival and the upkeep sweep read run and cleanup state, not folder layout; a leased slot is never handed to another run, so their rules hold.
- The worker's sandbox (src/harness/git-access.ts, src/harness/claude/adapter.ts, the launcher) was already computed from the run's actual worktree and its git dirs at every launch; a pool slot is a linked worktree like any other.
- Contracts: the contract runner sets `worktree_provider = "git"`; the suite does not prove the pool, so `CONTRACT_REVISIONS` is unchanged.

## Not changed

- Verification worktrees (src/verify/runner.ts) are made at the head under test and removed after every check, with their own path safety and restart recovery; moving them onto the pool would be a separate change with its own tests.
- The post-merge build worktree (src/upkeep/build.ts) is already one reused folder per project that keeps its packages.

## Tests

- `test/helpers/fake-treehouse.ts`: the stand-in every test home gets (`[tools] treehouse`), answering `--version`, `get --lease --json`, `status --json` and `return [--force] [--if-lease-id]` as 3.1.8 did, with real `git worktree add --detach` for new slots, state in the pool root (`.treehouse/fake-get-fails` makes `get` fail after leasing) and a call log in `$FLOWRYN_HOME/treehouse-calls.log` (`treehouse.fail` makes every call fail). The test preload refuses spawning the real treehouse in-process.
- `test/integration/treehouse-pool.test.ts`: a ship leased from the pool, cleaned up with a plain return after its work landed in the local main, and the next run given the same slot clean, on its own branch, with the ignored cache kept; a resume whose slot was destroyed by hand returning the old lease and taking a fresh slot on the run's branch; a failing treehouse leaving the run on a git worktree, with the log line, event and doctor warning, and its cleanup removing the worktree with git.
- `test/unit/treehouse.test.ts`: Flowryn's side (the lease and status shapes, the version's leading `v`, adopt by holder, a failed get handing its slot back, a vanished slot never adopted). treehouse 3.1.8's real behaviour (a plain return refusing changes, a return detaching the slot so the branch can go, a forced return keeping ignored files, `--if-lease-id` refusing another lease) was checked by hand in a scratch repository, not by the suite, which never runs the real treehouse; the "stand-in fidelity" tests keep the stand-in faithful to it. A second hand check (treehouse 3.1.8, 2026-11-04) on a slot whose folder was deleted: `return --force --if-lease-id <its lease> <path>` and a plain `return --if-lease-id <its lease> <path>` both exit 0 ("🌳 Worktree returned to pool."), with the wrong lease it exits 1 ("lease precondition failed"), and `status --json` afterwards lists no such slot: the slot is forgotten and its lease gone. The stand-in does the same. Then the cleanup's return path (an approved discard forced with its head recorded, a vanished slot's lease returned forced, landed work returned plain, a failed return refusing with everything kept), and doctor's lines.
- `test/unit/leader-scope.test.ts`: the pool under a custom root denied to other scopes, a cleaned-up run's slot no longer.
- Both cleanup fixture sets pass unchanged: they run the git removal, as `scripts/guard/cleanup-impl.ts` passes no `returnWorktree`.
