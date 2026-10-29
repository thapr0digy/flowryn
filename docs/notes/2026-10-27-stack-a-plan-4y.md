# Start a task from a named base branch, then stack plan phases

- Status: partial
- Open: phase 2 (stacked plans: a phase starting on the open PR of the phase before it, the retarget when that one lands) is its own task in plan p21; not yet run live: no-mistakes `axi run --base-branch` against a real repository

Scout finding 20 (`scout-efficiency-and-fz`): a plan phase can start only once the phase before it has merged (`docs/v1-status.md`, "Stacking a phase on an open PR"). The design (gate g227) splits the work in two. This change, phase 1, lets a task start from, and target, a branch other than the project's default. Phase 2 builds stacking on top of it. The predecessor had phase 1 as 6a7b3919 (`--base-branch` on brief and spawn). Nothing here uses a model: it is plain lookups and checks over the database, git and the forge.

## `dispatch --base <branch>`

```sh
flowryn dispatch web --kind ship --base release/2 --body-file - < task.md
flowryn dispatch web --kind ship --blocked-by fix-auth-3k --auto --base release/2 --body-file - < task.md
```

- The ship starts from origin's tip of `<branch>`, fetched at the start (`git fetch origin +refs/heads/<b>:refs/remotes/origin/<b>` in the primary checkout), not from the default branch. The primary checkout must still be on its default branch: the worktree is added from it.
- Its PR must target that branch. The worker's contract says so: "open a PR into `<branch>`" (direct-PR), "pass `--base-branch <branch>` on every `no-mistakes axi run` that starts a run" (no-mistakes), and "To take your base: new commits, `git merge origin/<branch>`". A task with no base gets the same contract text as before, byte for byte, so `CONTRACT_REVISIONS` is unchanged.
- Delivery (`deliver --pr`) refuses a PR into any other branch. The merge gate refuses `base_mismatch` (exit 2) when the PR's base on GitHub is not the run's base, for example after someone retargeted it by hand, and when the PR was already merged into another branch. A PR the watcher reads merged into another branch (retargeted, then merged on GitHub, even while a merge it asked for is in flight) opens a divergence instead of landing the run; `flowryn divergence resolve <d> keep-run` lands it as merged.
- Cleanup's landed-work guard proves the work is in that branch, not in the default one. The CI-wait question and its merge-main steer, the conflict nudge (already the PR's own base) and the no-mistakes ask-user rules' merge base all use it too, as does the clean-merge carry (docs/notes/2026-10-23-a-clean-merge-fm.md): a routine PR whose head moves only by a clean merge of its base keeps its delivery, at `deliver` and in the watcher.
- `flowryn show <task>` prints `base: <branch>`; the dispatch reply and the `run.dispatched` event carry it (`base`, `base_branch`).
- With `--blocked-by`, the base is kept on the Queued task and used when it starts, by itself (`--auto`) or with `dispatch --task`. `--task` refuses a new `--base`: the base is set when the task is filed.

Refused (`bad_args`, exit 3): a scout (it opens no PR); a project or a `--mode` that ships local-only (its landing merges into local default); a name `git check-ref-format --branch` rejects or that starts with `-`; a branch origin does not have (or that cannot be fetched). A Queued dispatch (`--blocked-by`, `--after`) checks only the name at filing; origin is fetched when the task starts, so a branch origin lacks is refused then, not at filing. `--base <the default branch>` is the same as no base.

## Data

Migration 44 (`base-branch`): `task_policy.base_branch` (what the task was filed with) and `runs.base_branch` (the branch the run's PR targets now; phase 2's retarget changes it during a run). Null is the project's default branch. `runBase(run, project)` (`src/lifecycle/runs.ts`) is the one place that resolves it. `flowryn home adopt` copies `task_policy.base_branch` with the rest of a policy row.

## Choices

- The base is stored per run, not only per task, because stacking will change it mid-run.
- The fetch happens at the start, not at filing, so a Queued task starts from the branch as it is then.
- A review carried on by a new run (review revival, when the old run ended for good) starts from the old run's base again.
- A promoted scout never has a base (a scout cannot take one), so promotion is unchanged.
- No `PROTO` bump, as with `--mode` and `--model`: `--base` is a new optional argument, and an older daemon refuses an argument it does not know (`bad_args`), so a newer CLI can never start a task on the wrong branch through it.

## Tests

`test/integration/dispatch-base.test.ts`: a based ship starts from the release branch, is told to target it, delivers into it, merges there and is cleaned up; a PR into main is refused at deliver; `base_mismatch` at the merge gate; a Queued based ship started by the scheduler; a clean merge of the base carried by the watcher; the refusals. `test/unit/merged-off-base.test.ts` (the divergence and keep-run), `test/unit/home-adopt.test.ts` (the copied column), `test/unit/harness.test.ts` (contract text, including the byte-identical default) and `test/unit/ci-wait.test.ts` (the merge-main steer).
