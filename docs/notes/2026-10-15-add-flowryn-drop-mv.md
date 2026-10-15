# flowryn drop

- Status: done
- Open: not yet run live; the leader drops resumed-worker-loses-dw / p11 with it once this lands

`flowryn drop <task|plan> [--unblock] --body-file -` removes work that never started. It is for the leader and you, like `cancel`; a worker token is refused. `cancel` acts only on a run, so before this verb nothing could remove a queued task. Seen 2026-10-14: the duplicate `resumed-worker-loses-dw` and its plan `p11` could not be removed, and hand edits to the backlog are blocked. The reason is required: once the task is deleted from the backlog, it is the only record of why the work went.

## What it takes and refuses

| Target | Result | Code |
|---|---|---|
| Queued task, no run ever | dropped | |
| Queued (held or parked) task whose last run was cancelled or failed and whose worktree is removed (`cleanup = done`) | dropped | |
| Parked task whose worktree is still there | refused | `worktree_kept`, hint `flowryn cleanup <task>` |
| Live or delivered run (`launching` to `merging`) | refused | `task_started`, hint `flowryn cancel` |
| `landed` or `cleaned` run, or Done in the backlog | refused | `task_landed` |
| Still blocks an open task (backlog edge, or a phase of a plan not yet in the backlog) | refused unless `--unblock` | `has_dependents` (lists each one and what it waits for) |
| A backlog write for it still pending, or In flight with no run | refused | `not_ready` |
| A decision's task, a task already dropped | refused | `bad_args` |
| A phase of a plan not yet approved | refused: drop the plan | `bad_args` |
| Plan (pending or approved) none of whose phases has a run | plan and every phase dropped | |
| Plan with a phase that has a run | refused | `phase_started`, naming the phase number, its task and its run |
| Plan already discarded or dropped | refused | `bad_args` |

All the codes except `bad_args` and `not_found` are policy refusals (exit 2). Tasks inside the dropped set do not count as dependents. Neither does a dependent dropped earlier whose rm has not applied yet. A single phase of an approved plan can be dropped on its own; the plan is marked `dropped` with its last phase. To drop the remaining phases of a plan that has started, drop them one task at a time, the last phase first.

## What one drop writes

One transaction, the verb's `apply`:

1. A `drops` row per task: its plan, title, reason, who, the tasks it unblocked, and when.
2. `task_policy.auto = 0`, so the scheduler's auto-dispatch never picks it up.
3. With `--unblock`: an `unblock <dependent> --by <task>` intent per edge (a new journal verb; `fieldsSetBy` gives `deps`), and the edge is also removed from that phase's `plan_phases.blocked_by`.
4. An `rm` intent per task the backlog holds. The order is dependents first: tasks-axi `rm` refuses an id that an open task still blocks on. So unblocks come before the rms, and a plan's later phase is removed before the phase it waits for.
5. The plan's state becomes `dropped` (migration 26 rebuilds `plans` with that state). This happens when you drop the plan, or when its last phase is dropped.
6. The task's open items are resolved (`task.dropped`), with their wait explanations.
7. A `task.dropped` event per task and a `plan.dropped` event per plan, each with the reason.

A dropped task leaves Flowryn's queue at once, before the journal's rm reaches the backlog snapshot. `queuedWork` skips it, and `createRun` refuses it (`not_found`, "was dropped"). The `createRun` check covers `dispatch --task`, plan dispatch and the scheduler, so nothing can start a dropped task during that window. `takenIds` includes `drops`, so a dropped id is never minted again. `flowryn show <task>` prints a dropped task's record: its state, when and by whom it was dropped, the reason, its plan, what it unblocked, and its runs.

## Choices

- **Delete, not Done with a note.** In Flowryn, Done means landed. `hasLanded()` treats a Done task Flowryn never ran as landed, and so does tasks-axi `ready`. A dropped task marked Done could start its dependents. The `drops` table keeps the record that the backlog no longer holds.
- **A kept worktree is refused, not cleaned.** `drop` never touches git. The cleanup guard owns the landed-work verdict and the human discard approval, and `drop` must not be a way around them.
- **Dependents: refuse unless `--unblock`.** The user picked this in the design review (q71). Refusing by default means nothing starts by surprise. `--unblock` exists because nothing else can remove a blocked-by edge: no verb does it, and hand edits are blocked.
- **A new plan state.** `discarded` means a design gate asked for changes, which is a different fact. The scheduler and dispatch already key off `state = 'approved'`, so a dropped plan needs no further guard.

## Known limits

- If a hand edit adds a blocked-by edge between the check and the journal's rm, the rm fails permanently and goes down the existing failed-intent path (a P1).
- `drop` does not close a PR that a cancelled run left open.

## Tests

- `test/unit/drop.test.ts`: one case per row of the table, run against the real tasks-axi through the journal. It also covers the rm ordering (within a plan, after `--unblock`, and after a dependent was dropped earlier) and migration 26 on a version 25 database. The design's assumptions each have a named test: tasks-axi `rm` refuses while an open task blocks on the id; `unblock --by` is idempotent; `createRun` closes the dispatch window.
- `test/integration/drop.test.ts`: through the real CLI and daemon. It refuses a live run (`task_started`), a missing reason and a still-blocking task; it drops a one-phase plan of the same shape as p11, then the two tasks. It checks that the backlog file no longer holds them, that no divergence opened (the journal's rm is Flowryn's own write), that `show` and `fleet` agree, and that `dispatch --task` refuses a dropped task.
