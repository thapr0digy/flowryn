# dispatch --after: start queued work on an event

- Status: done
- Open: not yet run live against GitHub

`flowryn dispatch <project> --kind ship --after <event> --body-file -` files a ship Queued until each named event has happened, then the scheduler starts it by itself, with no leader turn. It is the deterministic subset of the predecessor's `bin/fm-procevent-when.sh` (a general condition-then-action runner): Flowryn's events are a small known set read from records Flowryn or GitHub already keep, so no command is run, no model is asked and no trust binding is needed. Source: the 2026-10-22 scout report, finding 21. The design was reviewed and approved on its Lavish page (gate g206).

## Events

| `--after` | Happens when | Implemented as |
|---|---|---|
| `task:<id>` | the task lands (its latest run is `cleaned`; a decision task once answered) | an ordinary blocked-by edge, the same as `--blocked-by <id>` |
| `pr:<number>` | the PR in the project's GitHub repo merges | a watch |
| `report:<scout task>` | the scout's report lands (a run of it reaches `landed` or `cleaned`) | a watch |

`--after` is repeatable, ship only, and implies `--auto`; every event must happen (and any `--blocked-by` task land) before the task starts. It combines with `--blocked-by`. A project whose autonomy is `manual` keeps its meaning: the waits fire, and the task waits for `dispatch <project> --task <id>` (the dispatch hint says so), as `--auto` does today.

Refused at dispatch (nothing filed): an unknown form (`bad_args`, listing the three); `pr:` on a project with no GitHub remote, a PR GitHub does not find (`not_found`) or one closed unmerged (`bad_args`); `report:` on a task that is not a scout of this project, or a dropped one; `task:` on a scout (`bad_args`, hint `--after report:<id>`); a watch task named in `task:` or `--blocked-by` (`bad_args`: wait for the event itself with `pr:` or `report:`); `--after`, `--blocked-by` or `--auto` with `--task`, which starts an already filed task (`bad_args`). A PR already merged is accepted and fires on the next pass. GitHub out of reach is not a refusal: the hint says the PR is checked once GitHub answers.

## Watches

A PR or report event is a watch (`src/lifecycle/watches.ts`, table `watches`, migration 36, ids `w<N>`): a held backlog task of kind `watch` (id like `after-pr-112-k3`, title "Wait for PR #112 to merge") that only Flowryn completes, and that the queued task is blocked by. This is the shape standalone decision tasks already have, so every rule that starts queued work (the scheduler's auto-dispatch, `waitingOn`, `hasLanded`, the queue view, a hand edit to the backlog winning) applies unchanged. The watch task's add and hold go into the journal before the waiting task's add names it in `--blocked-by`, all in the dispatch's transaction.

The delivery watcher's pass (`DeliveryWatcher.settleWatches`, `src/watch/delivery.ts`, every `[github] poll_ms`) settles each open watch:

1. **Close** when nothing waits for it any more: the waiting task was dropped, or no Queued task is blocked by the watch task (its edge removed by hand), and the watch task is removed from the backlog (`rm`). Closed without a backlog write when you dropped or completed the watch task yourself. Never decided while a backlog write for the watch task or its waiter is pending, so a watch just filed is not closed before its edges arrive.
2. **Wait** while a backlog write for either task is pending: a watch fires only once the backlog holds the waiting task and its edge, so the scheduler kicked on the fire can start it at once.
3. **Read the event.** A report: the scout's runs. A PR: if Flowryn delivered it (an `artifacts` row of kind `pr`) and that task's run landed, it merged; otherwise GitHub's word (`forge.pull`), skipped while GitHub is quiet after a failure (the delivery watcher's back-off and `forge_unavailable` P1 apply).
4. **Fire** when it happened: the watch is `fired`, its task unheld and done, a `watch.fired` event, and the scheduler kicked. A fired watch counts as landed at once (`hasLanded` reads the `watches` row), before the journal's done reaches the backlog snapshot.
5. **Stuck**, when it cannot happen as things stand (the PR closed unmerged, the scout's latest run failed or was cancelled, the scout dropped, GitHub does not find the PR): one P1 `watch_stuck` naming the waiting task and both ways out, `flowryn drop <waiting task>` or `flowryn drop <watch task> --unblock` (which skips the wait; the task then starts on the next scheduler pass). The watch stays open, because a PR can be reopened and a failed scout dispatched again: the P1 closes when the event is possible again, or when it fires or closes.

Events: `watch.opened`, `watch.fired`, `watch.stuck`, `watch.closed`.

## Where it shows

- `flowryn fleet`, `show <task>` and the board show a waiting task's wait in words: `waits: PR #112 to merge, web-other-x1`; `show` lists each with its watch task id.
- A watch task is not Queued work (like a decision's task), so it does not show in the queue or its counts.
- `flowryn show <watch task>` or `show w<N>`: what it waits for, the waiting task, its state, the stuck reason, when it was opened and last checked.
- The dispatch reply has `waits_for` (each watch's event and task id).
- A watch and its task are in their project's scope (docs/notes/2026-10-24-leader-scoping-and-vj.md): a scoped leader sees, and can `show`, only its own scope's.

## Choices

- **Watch as a held backlog task**, not a list the scheduler consults on the side: one readiness rule (blocked-by), hand edits still decide, and decision tasks already prove the shape. Cost: one backlog line per wait, moved to Done when it fires.
- **`task:` is plain blocked-by**, with no watch row: no second mechanism for what already works.
- **`pr:` means merged**, not landed: it is the event the user names, and covers any PR in the repo. A Flowryn PR's own task stays available as `task:` for merged-and-cleaned.
- **No give-up deadline** (the predecessor's `never-true` after a week): the wait is visible in the queue, and the cases where it truly cannot happen raise `watch_stuck`.
- **Stuck keeps the watch open** rather than a terminal `failed` state: both causes are reversible, and dropping work is the user's call.
- **No new configuration**: the watch reads ride the delivery watcher's cadence and back-off.
- **PROTO 8**: `dispatch` gained an argument. No `CONTRACT_REVISIONS` bump: the worker path is unchanged.

## Tests

- `test/unit/watches.test.ts`: `--after` parsing and every refused form; a watch's backlog add before its hold and its label; the verdicts (GitHub's PR states, a scout's runs, a scout promoted to a ship, a PR Flowryn delivered); firing (unhold, done, landed before the snapshot says so); stuck (one P1, cleared, closed on fire); closing (a watch just filed is kept, an edge removed, the waiter dropped, the watch task dropped or completed by hand); a watch task out of the queue and the waiting task's wait in words.
- `test/integration/after.test.ts` (fake GitHub, fake Herdr, real tasks-axi): a PR merging starts the task, with the journal order, events, `show` and `fleet`; a PR merged before dispatch; closed unmerged then reopened; the refusals (including a watch task as a blocker and `--after`/`--blocked-by`/`--auto` with `--task`); dropping the waiting task closes the watch and removes its task; dropping the watch task with `--unblock` starts the task; manual autonomy; a fired watch across a daemon restart starts the task once; a scout's report landing starts the task; `task:` and `pr:` together wait for both.
