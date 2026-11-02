# Survive a moved project checkout, and resume a cancelled run in place

- Status: done
- Open: not run live against a moved work-instance checkout or a real Claude resume of a cancelled run (offline fakes only)

On 2026-10-30 the appsec-signal checkout moved. Flowryn broke in three ways: its task worktrees' `.git` files named the old admin dirs, so `flowryn merge` read an empty head; the project registration kept the old path and could not be changed; and a cancelled run could neither be resumed nor dispatched again, so its passed design gate and its uncommitted work could only be thrown away. Everything here is plain code; no model is involved.

## `flowryn project set <id> --path <new path>`

- The new path is checked as `project add` checks one (absolute, exists, the top level of a git checkout), then: no other project is registered there (`already_exists`); when the project has a remote (the one this call's `--repo-url` sets, else the stored one) and the checkout has an origin, the two name the same repository (`normalizeRemote`), else `invalid_project`; and the project's scope is unchanged (`[scopes] paths` match by path, so a move can land in another scope; refused with a hint to edit `[scopes.<scope>] paths` or set `[projects.<id>] scope` first). A refusal rolls the update back.
- The path is saved with the usual `project.updated` event. After that commits (the verb's `settle`), `git -C <new path> worktree repair <every worktree>` runs once, under the repository's worktree lock, over the worktrees of every run of the project that is not cleaned up and still exists. Git documents this form as the repair for a moved main checkout: it rewrites each worktree's `.git` and the checkout's back-pointers (`test/unit/relink.test.ts` checks it).
- The reply has `worktrees`: one entry per worktree, `repaired` (broken before, linked now), `ok` (already linked) or `failed` with git's words. A `project.relinked` event records the same.
- `live` lists the runs whose worker is up: each was launched with the old paths in its sandbox. Flowryn does not stop a busy worker for you; the hint is `flowryn cancel <task>`, then `flowryn resume <task>`.
- The same path again changes nothing and runs the repair again, so it is the retry for a failed relink (and the fix for a worktree whose link alone broke).

## Worker launches

The sandbox's git paths were already computed at every launch (fresh, stage, relaunch, resume) from `git rev-parse --git-common-dir` and `--git-dir` in the worktree (`src/harness/git-access.ts`), never stored. What was wrong is that a worktree git could not read gave an empty list, and the worker started unable to commit. A ship launch now refuses that, and `ensureWorktree` names a `.git` that points at a missing dir; both say how to relink (`flowryn project set <id> --path <checkout>`, or `git -C <checkout> worktree repair <worktree>`, or, with the checkout gone, give the project its new path). The run fails with that reason, as any launch failure does; after the fix, `flowryn resume` starts it.

No `CONTRACT_REVISIONS` bump: the contract suite's steps and what it proves are unchanged.

## `flowryn resume` takes a cancelled run

`resume` now accepts a cancelled run whose worktree still exists and that is not cleaned up or dropped. A run (cancelled or failed) that a later run of its task, or at its worktree path, superseded is refused (`run_not_active`): the worktree on disk is the later run's. It is the same resume a failed run gets: the run goes back to `running` in its current stage (never back to `ready` or `validating`: the cancel ended that pipeline or delivery, so the worker delivers again), a sweep's `cleanup = refused` is cleared, the task is taken off its parked hold and back In flight (`unhold`, `start` intents), and the scheduler grants its worker slot and starts it from its stored session. The worktree, branch, uncommitted changes, stage and gates (passed ones included) stand: cancel never touched them. Questions the cancel dismissed stay dismissed; the worker asks again if it needs to. `run.resume_requested` records `from: cancelled`. Nothing resumes a cancelled run by itself: the reconciler's automatic resume reads only live runs.

## `flowryn doctor`

A `checkouts` check (files only, no git, read-only database): a project whose path has no `.git` fails with `flowryn project set <id> --path <its new path>`; a worktree of a run not cleaned up whose `.git` names a missing dir fails with the relink command. All well, it reports `ok`.

## Merge

A local merge that cannot read the worktree's head is no longer reported as a head that moved "to """: `head_moved` says the head cannot be read, names the broken `.git` link when there is one, and hints the relink.

## Tests

- `test/integration/moved-checkout.test.ts`: a checkout renamed under a live worker's worktree (doctor fails, `project set --path` repairs it and lists the live worker, a rerun finds it `ok`); a worktree whose admin dir alone is gone; refusals for a folder inside the checkout, another project's checkout and another origin; `--path` with `--repo-url` checked against the new remote; a run cancelled in its build stage after the design gate passed, resumed with its uncommitted file, branch, stage and passed gate, the task In flight; a resume over a broken link failing with the relink hint, then starting once relinked; a cancelled run superseded by a later run of its task, and a cleaned-up cancelled run, refused.
- `test/unit/relink.test.ts`: the `.git` link reader, the relink hint, and the git repair assumption itself.
