# Start a task from a named base branch, then stack plan phases

- Status: done
- Open: not yet run live: no-mistakes `axi run --base-branch` against a real repository, and GitHub's own base change (`PATCH` with `base`) and its auto-retarget when it deletes a merged branch

Scout finding 20 (`scout-efficiency-and-fz`): a plan phase can start only once the phase before it has merged (`docs/v1-status.md`, "Stacking a phase on an open PR"). The design (gate g227) splits the work in two. Phase 1 (stack-a-plan-4y) lets a task start from, and target, a branch other than the project's default. Phase 2 (stacked-plans-uv, design gate g249) builds stacking on top of it: [Stacked plans](#stacked-plans) below. The predecessor had phase 1 as 6a7b3919 (`--base-branch` on brief and spawn). Nothing here uses a model: it is plain lookups and checks over the database, git and the forge.

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

## Stacked plans

Phase 2 (stacked-plans-uv). A plan opts in; then a phase starts on the open PR of the one task it still waits for instead of after that task merges, its merge waits for that task to land, and when it lands Flowryn points the stacked PR at the landed task's own base and has the worker take that base in. All plain code: rules over the database, git and the forge, no model.

### Opting in

```markdown
# Cart
stack: on

## Phase 1: Cart API
...
## Phase 2: Cart page
...
```

- A `stack: on` line before the first `##` (`off` is the default; any other value is `bad_args`). It works in a worker's `stage done --plan-file` and in `flowryn plan`; `flowryn plan <project> --stack` does the same. A `stack:` line inside a phase is that phase's text.
- Refused (`bad_args`) for a project, or a `--mode` override, that ships local-only: there is no PR to stack on.
- The review gate's pending-plan line says so: "plan p3, 2 stacked phases that start by themselves once the task before each delivers its PR: …".
- `flowryn show <plan>` prints `stack: on`; a queued phase reads "queued, ready to stack on X (PR url)" or "queued, waits for X to deliver its PR (why)", a started one "… · stacked on X". `flowryn show <task>` of a stacked run prints `stacked_on: X (merges after it lands)`. `flowryn fleet` counts a phase ready to stack as ready.

### When a stacked phase starts

`phaseReadiness` (`src/lifecycle/stacks.ts`), used by the scheduler's autoDispatch, `dispatch --task` and the views: a phase is ready when every blocker has landed (as before) or, in a stacked plan, when all have landed but one, and that one (`stackBaseFor`):

- is a ship Flowryn runs in the same project, its latest run delivered (`ready`) with a PR, the PR open and not a draft as last read;
- has fewer than 3 open PRs beneath the new one (it and the stacked runs it sits on; `MAX_STACK_DEPTH`, fixed).

The phase starts from that task's run branch (`flowryn/<task>`) fetched from origin, which must equal its delivered head (a branch pushed since its delivery waits for the next delivery: the scheduler skips it that pass, `dispatch --task` refuses `not_ready`). The run's base is that branch (phase 1's base machinery: its PR targets it, the contract names it) and `runs.stacked_on` names the task. The blocker may be the plan's own source task (the design task), so phase 1 of a design's plan can stack on the design's PR. `phase.started` and `run.dispatched` carry `stacked_on`.

### While it works

- Each time the task beneath delivers a new head, every stacked run still working on it (`launching`, `running`, `validating`) gets a steer to `git merge origin/<its branch>` (event `stack.followed`). A delivered stacked run is left alone: the landing's merges take the final head first.
- Its merge is refused while `stacked_on` is set: `stack_not_landed` (exit 2), first in the gate. Yolo auto-merge starts no row for it; its delivery after the retarget starts one.
- A stacked PR read merged on GitHub before the task beneath landed (into that task's branch) is a divergence, not a landing (the merged-off-base rule). Read merged into the landed task's base after it landed, before the watcher retargets it, it lands as merged elsewhere and leaves the stack there (`run.retargeted`, its base the landed one), so a run stacked on it is retargeted to that base.

### When the task beneath lands

The delivery watcher's pass, right after its PR reads (`retargetStacks`), for each stacked run whose task beneath is `landed` or `cleaned`:

1. Every open PR from the run's branch (`pullsForBranch`, so one the pipeline opened before a delivery counts) whose base is not the landed run's base is moved there: `Forge.setBase`, `PATCH /repos/{o}/{r}/pulls/{n}` with `base`. A PR already on it (GitHub moves PRs into a branch it deletes on merge) is left alone. A forge error leaves the run stacked; the next pass tries again.
2. In one transaction: `runs.base_branch` becomes the landed run's base (null for the default branch), `stacked_on` is cleared, event `run.retargeted` (`from`, `to`, `on`, `merge_sha`, `prs`).
3. A delivered run is sent back (`sendBack`, event `stack.sent_back`); a working one is steered. Both get the same text: the new base, then these merges, each a new commit:

```sh
git fetch origin main
git merge --no-edit <H>          # the landed task's final delivered head
git merge --no-edit <S>^1        # main just before the landing
git merge --no-edit -s ours <S>  # the landing commit itself
git merge --no-edit origin/main
```

`S` is the landing proof's merge commit, `H` the delivered head (if git lacks it: `git fetch origin refs/pull/<n>/head`). Why not a plain `git merge origin/main`: after a squash merge (the default `merge_method`) it conflicts wherever the stacked work changed lines the task beneath added, since the squash commit shares no history with that task's branch. With `H` and `S^1` merged, the branch already holds everything `S` holds (the gate merges exactly the delivered head), so recording `S` with the ours strategy is exact; the last merge brings what landed after. The same steps are right after a merge-commit landing. After a rebase landing, `S^1` holds part of the rebased commits and the merges may conflict; the conflict nudge covers that.

Flowryn never deletes a remote branch, so the branch beneath survives until GitHub deletes it on merge (and GitHub then moves the PRs into it itself).

### Base lost

The same pass: when the task beneath is dropped, its latest run `failed` or `cancelled`, or its PR read closed unmerged, the stacked run gets one P1 `stack_base_lost` ("cancel it, or run X again"). `stacked_on` stays set, so the merge stays refused: the stacked branch carries the lost task's work and must not land unreviewed. If that task runs again and delivers, the item settles by itself. There is no unstack verb.

### Data

Migration 45 (`stacked-plans`): `plans.stack` (0/1) and `runs.stacked_on` (the task id, indexed). `flowryn home adopt` keeps a plan's `stack`.

### Choices

- The retarget runs in the watcher after the merge is proven, not in `landRun` (a transaction, no network) and not at cleanup (later than needed).
- The merges over a plain merge: a scratch-repo test of the design's first guess (a plain merge) conflicted.
- Base lost alerts and keeps the refusal rather than unstacking by itself.
- The depth cap is fixed at 3; no configuration key.
- No `CONTRACT_REVISIONS` bump: a stacked run's contract is phase 1's based text. No `PROTO` bump: `--stack` is a new optional argument.

### Tests

`test/integration/stacked-plans.test.ts`: a stacked two-phase plan through the fake worker and the fake GitHub (squash merges): phase 2 starts on phase 1's delivery from its branch and opens its PR into it, its merge is refused `stack_not_landed`, phase 1 lands, the PR is patched to main, phase 2 is sent back, a plain merge of main would conflict, the steer's merges are clean, it delivers again and lands. `test/unit/stacked-plans.test.ts`: the stack line, the merges after a squash and after a merge commit (real git), readiness (draft, depth, unstacked plans), the local-only refusal and the gate line, the merge refusal, following a new head, the retarget pass (patched, already moved, forge down) and base lost. `test/unit/home-adopt.test.ts`: the copied `stack`.
