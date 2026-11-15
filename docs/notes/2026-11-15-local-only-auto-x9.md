# A merge queue for local-only projects

- Status: done
- Open: not yet run live on appsec-signal

On a local-only project every landing used to make every other ready branch "not a fast-forward" of local main (`src/policy/merge.ts`, `not_fast_forward`): its auto-merge held, the leader steered the worker to merge main and deliver again, and the branch was verified again. On appsec-signal on 2026-11-15 most branches were verified three or four times. Local-only projects now land through the landing queue and its train (docs/notes/2026-10-30-landing-queue-the-65.md, docs/notes/2026-11-07-faster-landing-test-q7.md), extended rather than copied: plain code (git plumbing, the verify queue, the auto-merge state machine), no model.

## On by default

`[projects.<id>] landing` unset now means `"queue"` on a local-only project with verify steps (`landingMode` in `src/verify/config.ts` takes the project's delivery mode); `landing = "manual"` opts out. Without verify steps a local-only project stays manual, and PR projects are unchanged (unset is manual). The train depth is `landing_train_depth`, 2 when unset. `flowryn config` reads the config alone, so it shows `landing` only where it is written.

Deliveries already being merged when a project starts queueing finish the old way (a live direct auto-merge is left alone); a held one joins the line.

## Candidates

Every local entry lands at a candidate (`train_head`, `train_base`, `train_request` on its `landing_queue` row; no migration): git's own merge of its delivered head and the head ahead of it, `merge-tree --write-tree` then `commit-tree` with the delivered head as first parent, written to the project's object store only. The head ahead is local main's tip for the first entry (its verify request at rank 0) and the candidate ahead for each car within the depth (at `TRAIN_RANK`, so it runs on a free slot). An entry that already holds its base is its own candidate: no merge commit. The verify runner checks the candidate out in its own fresh worktree, as for a PR train candidate; nothing is fetched or pushed.

- **No verify at delivery.** `deliver --local` on a queue project starts no auto-verify (a PR on a queue project still gets one): the delivered head is not what lands once main moves, and the candidate's verify is the one that counts. Entries beyond the depth wait unverified until the train reaches them.
- **Starting.** With no entry landing, the first entry whose candidate is on main's tip starts. A merge candidate needs its worker idle and its checkout clean at the delivered head; the checkout then fast-forwards to the candidate (`git merge --ff-only`: the branch gains one merge commit, nothing is rewritten), the delivery is carried to it (`carryLanding`, a `local` artifact with `carried_from`, event `landing.caught_up`), and the auto-merge row follows the candidate's existing verify. A candidate that is the delivered head needs nothing of the checkout.
- **Landing.** The auto-merge's merge is the merge verb's own path: the gate needs a passing verify at exactly the candidate, and `git merge --ff-only` moves local main to it. Before it, `beforeMerge` checks local main is still an ancestor of the candidate; main moved by hand sends the entry back to waiting, rebuilt on the new main (`landing.base_moved`; at `MAX_INTEGRATIONS` = 3, held).
- **Conflicts.** A car whose merge onto the car ahead conflicts builds nothing (`landing.train_skipped`, now with the conflicted `files`) and waits its turn. On main, a conflict sends the work back naming the paths (`run.conflict_nudged`, local wording: merge main into your branch with a new commit, deliver --local again); the checkout is not touched.
- **A failed car.** While the car ahead has not landed, a failed candidate only ends the train behind it (the failure may be the car ahead's). Once main is its base, the failure is exactly main plus its work: a step that failed sends it back with that verify's log (`landing.car_failed`, `verify.sent_back`), with no verify again. A timeout or error starts the landing, whose auto-merge verifies again under its own rules. A car whose base left is rebuilt on main.

## A worker that is not ready on its turn

When an entry's turn comes and its merge candidate needs its checkout, but its worker is busy or showing a dialog, or its checkout has uncommitted changes or a newer commit, the line waits `LOCAL_TURN_WAIT_MS` (5 min, a constant beside the train depth in `src/verify/config.ts`). After that the entries behind it go ahead: it stays out of the train, keeps a candidate on main and its place, and is tried first again next turn. Each entry that starts landing ahead of it costs it a turn (`landing.turn_skipped`); at its `MAX_SKIPPED_TURNS`-th (3) it leaves the line held (`turns_skipped`, an `auto_merge_held` item for the leader). The 30 min `BLOCKED_HOLD_MS` of a continuous wait still holds an entry nothing goes past (a line of one).

## What you see

- `flowryn show <task>`: `landing queue: 2 of 3, behind t41, candidate 1a2b3c4d on 5e6f7a8b, verifying v41 (lq7)`; the entry landing: `landing queue: first in line, caught up with main at 5e6f7a8b, verify v41 passed (lq6)`; one waiting on its worker: `..., waiting on its worker (the worker is busy), passed over 1 of 3`.
- `flowryn fleet`, the needs cell of a queued ship (PR or local): `queue 2/3 verifying v41 on 5e6f7a8b`, `landing verifying v40`, or `queue 1/2 worker not ready`.

## Tests

`test/unit/landing-local.test.ts` (real git): two branches ready together land in sequence with one verify each, no steer, the second's branch only gaining the merge commit (no reset in its reflog); a train of three lands in order; main moved by hand rebuilds and re-verifies the head of line; a car conflicting with the car ahead waits, then goes back naming the paths on main with its checkout untouched; a failed car goes back with its log once its base landed, with no second verify; a car whose base left is rebuilt on main; a busy worker waits 5 min, the ones behind go ahead, and it is held at its 3rd skipped turn; a worker that becomes ready in time takes its turn. `test/unit/landing-queue.test.ts`: the local-only default and its opt-out. `test/integration/landing-local.test.ts`: the same two-branch demo through a real daemon and fake workers delivering `--local`.

## Rejected

- Catching up inside the auto-merge on "not a fast-forward" (merge main, verify again): no order, so each landing stales every other ready branch again and nothing verifies ahead.
- Reusing an earlier pass when the files do not overlap: a change in one file breaks another (a renamed export, a schema), and the train already verifies ahead.
- Landing the merge commit directly while the checkout is busy or dirty: it needs a new merge-gate rule for a head that is not the checkout's; the user chose the wait-then-pass-over rule above (q73, changed in steer m648).
- A separate local-only queue: a second copy of the line, train, holds and promotion rules.
