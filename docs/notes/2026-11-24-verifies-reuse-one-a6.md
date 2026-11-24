# Verifies reuse one checkout per slot

- Status: done
- Open: the Go cache hit at a reused path is not yet seen live (two consecutive appsec-signal verifies in one slot: the compile step should drop from about 45 s to about 12 s, and the Go cache grow by megabytes, not a gigabyte)

Every verification used to check out into a new directory, `<state>/verify/v<N>/wt`, and remove it at the end. Go puts each package's absolute directory into its compile action id when `-trimpath` is off, so a new path recompiled every package: on appsec-signal 43-46 s, about 325 CPU-s and 1.1 GB of Go cache per verify, against about 12 s and 4 MB at a reused path. At 80-120 verifies a day the Go cache reached 649 GB in three days (Go evicts only entries unused for five days). Any cache keyed on the checkout's path missed the same way.

## Layout

- A verification's checkout is a **slot**: `<state>/verify/slots/<project>/<k>`, a detached git worktree of the project kept between verifies. `slots/` never collides with `v<N>` (a project may be named `v12`).
- `<state>/verify/v<N>` stays per verification: logs, `bin/`, review files. `verifications.worktree_path` names the slot (no migration). `pruneDirs` removes old `v<N>` directories only, never a slot.
- At admission (`admitRequest`, `src/verify/start.ts`), in the transaction that inserts the row and grants the `validation` job lease, the verification takes its project's lowest-numbered slot that no verification with a live verify job lease holds (`freeSlot`). The lease is released only after the end-of-use cleanup, so a slot is held from admission until its cleanup ends and two verifies never share one. With the pool's cap at N, a project has at most N slots.

## The reset rule

Before any step runs (`prepareSlot`, `src/verify/runner.ts`):

1. The guard (`ownPath`) must accept the slot: its path under the verify root spells `slots/<project id>/<digits>` and no component below the root is a symlink.
2. A slot that is a checkout of this project (git's top level there is the slot, and its common dir is the project's): the project's `release` commands run in it first, in the tree the previous verify left, so the commands that match how its services started stop them; then `git checkout --force --detach <head>` and `git clean -ffdx`.
3. A missing slot, one that is not a checkout of this project, or one that does not come out clean: recreated once (made writable without following symlinks, removed, `git worktree prune`, `git worktree add --detach`), under the repository's worktree lock.
4. Proof: `HEAD` is the head and `git status --porcelain --ignored --untracked-files=all` prints nothing. That is what "a fresh checkout" means for the steps. Untracked and ignored files go, `.env` files included.

There is no keep-list: what is worth keeping (Go's build cache, bun's install cache, module caches) lives outside the checkout.

At the end of a use (`endCheckout`): the release commands run, then `git clean -ffdx`, so an idle slot holds only the tracked tree; then the slot lease is released. A verification a daemon stop cuts off keeps its slot untouched for a resume, as before; a fallback `v<N>/wt` checkout is never resumed, so it is removed.

## Fallback

A slot that cannot be made clean (the guard refuses it, its release at the start fails, or the recreate fails) is not used: that verification checks out into its own `v<N>/wt`, as before slots, and is removed at its end. One transaction sets its `worktree_path` and appends `verify.slot_fallback` (`verification`, `slot`, `why`). A failed release at the start falls back because the previous verify's services may still hold its data.

## Services are not reused

The scout's item hoped a slot's test server (appsec-signal's test Postgres, keyed to the checkout) would be reused too. It is not: the release commands run at both ends of every use, so no verify sees another's data. A project wanting a faster start makes its own server start faster.

## Resume

A verification a daemon stop cut off resumes (docs/notes/2026-11-07-faster-landing-test-q7.md) only when it ran in a slot and nothing used that slot since (it is the newest verification with that `worktree_path`). The resumed verification is admitted into that slot and runs there as it was left: no release, no reset; it checks the checkout belongs to the project and is at the head, else drops the resume (`pr.verify_resume_dropped`) and prepares the slot as usual. The old `git worktree move` is gone. A verification interrupted in the old `v<N>/wt` layout is not resumed (it runs from scratch once).

## Startup recovery

A crashed verification recorded as interrupted keeps its slot for a resume (a fallback `v<N>/wt` is removed); any other's slot gets the end-of-use release and clean, and an old `v<N>/wt` is removed. Either way the next user of the slot resets it.

## Tests

`test/unit/verify-slots.test.ts` (real git, worktrees and shell steps): two consecutive verifies of different trees share the slot's absolute path and the second sees no untracked file, `.env`, nested repository or edit of the first; leftovers planted in an idle slot are reset away; concurrent admissions get different slots and the next takes slot 0; a crashed verify's slot is reused after recovery; the release runs at the start in the previous tree and at the end; a release failing at the start falls back with `verify.slot_fallback`; a read-only leftover gets the slot recreated; a stray directory at the slot is recreated; a symlinked `slots/<project>` is refused and nothing outside the root changes; pruning never removes a slot; the guard's accepted and refused spellings and symlinks. `test/unit/verify-resume.test.ts`: a resume runs in the same slot; a slot used since the interrupt, or an old `v<N>/wt` source, is not resumed. `test/unit/verify-queue.test.ts`: four verifies at once in one repository take four slots.
