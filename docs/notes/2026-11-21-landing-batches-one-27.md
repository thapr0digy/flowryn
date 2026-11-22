# Landing batches: one full verify for many ready branches

- Status: done
- Open: not yet run live (appsec-signal first, the leader turns it on)
- Config: `[projects.<id>] landing = "batch"`, `[projects.<id>] light_verify`

On appsec-signal every branch got its own full verify on main plus its work, often more than once (94 verifies, about 10 min each, for 56 landings on 2026-11-19). Batch mode verifies many ready branches together, once. Design reviewed at gate g807 (the user chose local-only projects first, q108). Everything here is plain code: git plumbing, the verify queue, the landing queue's rows and the merge verb's own path. No model.

## Turning it on

```toml
[projects.appsec-signal]
verify = ["make fmt-check", "make vet", "go build ./...", "make pg-test-gc", "make test-changed BASE=main PG_TEST_MAX=10 PG_TEST_MEMORY=3g"]
landing = "batch"
light_verify = ["make fmt-check", "make vet", "go build ./..."]
```

- `landing = "batch"`: a third landing mode beside `"queue"` and `"manual"`, for local-only projects only. It needs `verify` steps (`config_invalid` otherwise) and is refused (`config_invalid`) on a project that delivers PRs: the daemon refuses such a config at start and on SIGHUP, `flowryn project add`/`project set --mode` refuse the mode, and `flowryn config` lists it under `problems`. It is a queue for every "does this project queue" check (no direct auto-merge at delivery, unattended mode defers to the line, the rebuild hold); `landing_train_depth` does not apply.
- `light_verify` (optional): the light check, in the `verify` grammar (strings, parallel groups, `{ run, when_changed }` tables; no `{ review = true }`), refused unless `landing = "batch"`. It runs with the verify's deadlines. Unset, a branch may join a batch as soon as it is in line. Keep the changed-tests step in `verify`: on a batch head it sees the union of the batch's changes once.

`flowryn config` shows `landing: "batch"` and the light steps under `light`; the running daemon lists a project whose delivery mode refuses it under `problems`.

## What happens

1. **Joining the line** is unchanged: routine work (yolo, not sensitive) and approved work join the project's `landing_queue` line. Batching never writes a worker's branch or worktree: no catch-up merge and no carried delivery, so an approval at the delivered head stays valid and no worker is waited on. The delivery frees the worker's slot, and a send-back starts a fresh session (docs/notes/2026-11-22-phase-free-the-rn.md).
2. **Light check.** Each waiting, non-sensitive entry's delivered head is verified alone with `light_verify` (a request with `pr_url` `local:<branch>`, no worktree; the runner tells it from a full verify by its policy id). It runs while a batch is in flight too. A failing step sends the work back once per head ("Light check: ..."; `verify.sent_back` with `light: true`), a step timeout runs it once more, anything else (a second failure, an error) holds the entry for the leader (`held:<code>`, an `auto_merge_held` item).
3. **A batch.** With no batch live, every entry whose light check passed (in line order, at most `MAX_BATCH` = 8) is merged onto local main's tip in the object store: `git merge-tree` then `git commit-tree` with the batch so far as first parent and the branch as second (`Merge <branch> (<task>) into the landing batch on main <sha> (Flowryn)`), so `git log --first-parent main` reads one merge commit per task. The first member is taken as it is when it already holds main. Before merging:
   - **Migration number clash**: a member that adds a file whose name starts with the same number, in a directory whose path contains `migration` (`db/migrations/000042_x.up.sql`), as a member already taken into the batch leaves (`number_clash`) and goes back to renumber (`landing.batch_clash`). A member that was skipped or sent back for a conflict is never compared against. Date-prefixed notes are not migrations.
   - **Conflicts**: a member that conflicts with main goes back to its worker naming the paths (today's conflict nudge); one that conflicts only with an earlier member waits for the next batch (`landing.batch_skipped` with the paths and the members it met). Once those land, a remaining conflict is with main.
   - The batch is a `landing_batches` row `lb<N>` (`verifying`), its members `landing` with `batch_id` and `batch_pos`, and one verify request for the batch head with ref `batch:<project>/lb<N>` (`landing.batch_built`).
4. **One full verify** of the batch head, in the verify runner's fresh worktree; verify resume after a restart works as for any request.
5. **Green**: every member passes the merge gate as today (approval at its delivered head, the sensitive rule, AI attribution), with one change: a batch member's fast-forward and verify evidence are its batch's, counted only while the batch is landing and its head holds both main and the member's head. Then local main fast-forwards to the batch head once (`landing.batch_forwarded`), and each member's merge is recorded through the merge verb's path (its own `git merge --ff-only` of its head is then a no-op), so each run lands, is cleaned up and moves in the backlog as today (`landing.batch_landed`).
   - A member the gate refuses (its worktree moved past its delivery, an approval gone) leaves (`gate:<code>`, held for the leader) and the rest form a new batch. A refusal about the project checkout (`primary_checkout_tangle`) keeps the batch `landing` with one `landing_batch_held` item, tried again each pass.
   - A stop after the fast-forward: the next pass finds main at the batch head and records the members not yet recorded.
6. **Red, fixed forward** (phase 2, fix-a-red-jy): a step that failed (a nonzero exit, not a timeout or an error) opens one fix task for the batch before any hold. A step with `rerun_failed` first reruns its failing tests once alone at the same head, and lands the batch if they pass 3 of 3 (docs/notes/2026-11-22-phase-flake-earns-a3.md). See "Fix forward" below. A batch has at most one fix; a second red holds it.
7. **Red, held**: a step timeout runs the verify once more; anything else (a second timeout, an error, a second red, a fix that did not come through) holds the batch (`held`, `landing.batch_held`) with its likely culprit and one `landing_batch_held` item: `Landing batch lb3 (web, 3) held: verify v9 failed at \`bun test\` (exit 1); likely t41: ... Next: flowryn batch drop lb3 t41 | flowryn batch retry lb3`. A batch held for main moving (`base_moving`) or its verify cancelled too often (`verify_cancelled`) offers only `flowryn batch retry lb3`. The item carries the culprit's task (else the first member's), so it routes to the scope that owns the project. New deliveries keep their light checks meanwhile and form the next batch.
8. **Rebuilds.** A batch's head changes only by its fix. A member leaving (redelivered, its run ended, dropped, also while a green batch waits to land), main moving under it (at most `MAX_INTEGRATIONS` = 3 times, then held `base_moving`) or a verify the gate no longer counts ends it `dissolved` (`rebuilt`) and a new batch of the members left is built on main as it is (`landing.batch_rebuilt`). Switching the project away from `"batch"` dissolves the live batch (`batching_off`), cancels its queued verify and puts its members back in line; the views treat its entries as queue entries again from that pass on (`landing.batching`).
   - A member that leaves after main already holds the batch head (a stop after the fast-forward) cannot be taken back: the rest are recorded, and one `landing_batch_held` item per member that left (`landing.batch_left_on_main`) tells the leader its code is on main without a merge record.

Sensitive entries never join a batch. They land one at a time through the local line, with your record at the head that lands, exactly as on a queue project; one first in line goes before the next batch forms.

## Fix forward

When a batch's full verify fails a step, Flowryn opens one fix task for the project, then waits for it (`fixing`, `landing.batch_fixing`, `landing.batch_fix_opened`). Plain code, no model in the daemon:

- **The task** goes through the plan-phase start path: an approved one-phase plan filed by `daemon (landing batch lb<N>)`, its task a queued ship with `auto` set (workflow `fix`, or the project's when no `fix` workflow exists), its backlog add through `recordIntent`, started by the scheduler's grant like any phase. It starts on any project, whatever its `autonomy`: the batch holds the project's landings until it is fixed.
- **Its start**: a local branch `flowryn/batch/lb<N>` is created at the batch head, and the task's run starts there (`runs.base_sha` is the batch head; its own branch is `flowryn/<task>` as usual, and it lands into the default branch). Nothing earlier is rewritten. The `flowryn/batch/lb<N>` branch is deleted once the fix's run is under way or the batch ends.
- **Its brief**: the failing step and its bounded, redacted log tail (fenced, marked as data), each member with its branch, delivered head and changed files (12 shown, the rest counted), the likely culprit, and the rule: new commits on top, never rebase, reset or amend.
- **Its delivery** (`deliver --local`) joins the line as routine work does (a non-yolo project's fix needs your approval at its head, as any branch there does), takes no light check, and never forms a batch of its own. The batch checks it holds the batch head (`merge-base --is-ancestor`), then takes it as its last member: the fix's head becomes the batch head (`landing.batch_fix_delivered`) and the full verify runs again. Green lands every member and the fix, each with its own merge record, through the merge gate as in step 5.
- **When it does not come through**, the batch is held for you as a red batch is (`verify_failed`; the item line starts with the fix's fate): a second red (the culprit is named among the members, never the fix), the fix's run failing or cancelled, its task dropped, a delivery off the batch head (the fix ends), or no delivery within `FIX_DEADLINE_MS` (60 min). A fix that ran late keeps going, and its delivery is still taken while the batch is held; if it then fails, is cancelled or is dropped, the fix ends and the hold names that fate instead. A batch already held for something else (`base_moving`) keeps that reason and its next step; only the fix's fate is added.
- **Ending the fix**: `batch drop` of any branch (or of the fix itself, once it is delivered and so a member) ends the fix, since its branch holds every member, and the rest are rebuilt from main; `batch retry` before the fix delivered ends it too (the red was a flake; it is the way to end a fix not yet delivered); any rebuild or the batch ending ends it. Ending it makes its entry leave (`fix_ended`), asks for its run's cancel (the reconciler stops the worker; the task is parked, as `flowryn cancel` leaves it), or drops a task that never started (`drops`, by `daemon`) (`landing.batch_fix_ended`). A rebuilt batch is new and may open its own fix.

Shown as `lb3 fixing (fix-landing-batch-ab)` on the board, `batch lb3 1/2 fixing (fix-landing-batch-ab)` in the fleet, `landing batch lb3: 1 of 2, fixing: fix-landing-batch-ab works on its red verify` on the pr_ready line, and `fix: { task, state, base }` in `flowryn show lb<N>`.

## The leader's verbs

- `flowryn batch drop <lb> <task>`: on a held batch only. It ends the batch's fix, if any. The member leaves (`dropped`) and goes back to its worker (the fix itself is only ended); the next pass builds a new batch of the rest and verifies it. On a `verify_failed` hold the worker gets the failing step's log and, when it was named, why it is the likely culprit; on any other hold it is told why the batch was held and that no verify failed on it.
- `flowryn batch retry <lb>`: on a held batch only. On a `verify_failed` hold, once per head: the same head is verified again (a load flake); a fix not yet delivered ends. On a `base_moving` or `verify_cancelled` hold the batch ends (`dissolved`, `retried`) and its members, none dropped, form a new batch on main as it is on the next pass, with its count of main moves back at 0.
- `flowryn show lb<N>`: the batch, its members and their states, its verify, culprit and reason.

Both verbs are leader and human (scope: the batch's project). A wrong state or an unknown member is refused with `not_ready` or `not_found`.

## The likely culprit

`src/verify/culprit.ts`, plain code: the failing step's log tail (bounded) is read for file references (`path/file.go:12`), Go `FAIL <package>` lines and bun test file headers; each member scores 3 per changed file named exactly and 1 per changed file in a named directory or package. One member strictly ahead is named; a tie or no match names none and says so. It is a hint, never an automatic drop.

## What you see

- `flowryn show <task>` and the pr_ready line: `landing batch lb3: 2 of 4, verifying v41 (lq9)`, `landing queue: waiting for the next batch, light check running (v40) (lq10)`.
- `flowryn fleet` needs cell: `batch lb3 2/4 verifying v41`, `next batch, light check passed`.
- `flowryn board`: a LANDING section for each project that lands in batches now (or still has a live batch): the batch in flight with its members, and the next batch forming with each light check.

## Where it lives

- `src/verify/landing-batch.ts`: the controller (`LandingBatches`: light checks, build, drive, land, hold, drop, retry, and the fix: `openFix`, `driveFix`, `adoptFix`, `endFix`, `fixBrief`) and its views. `src/sched/scheduler.ts` (`autoDispatch`): a batch's fix starts on its batch head (`fixStartOf`), on any project. Migration 65 adds `landing_batches.fix_task`, `fix_base`, `fix_state` (`open`, `delivered`, `ended`), `fix_since`, and `fixing` to the one-live-batch index. `src/verify/batch-store.ts`: the rows (`landing_batches`, migration 64; `landing_queue.batch_id`, `batch_pos`) and the reads the gate and views share. `src/verify/object-merge.ts`: the object-store merge shared with the landing train. `src/verify/culprit.ts`.
- `src/verify/landing-queue.ts`: a batch project's pass (light checks, then the live batch, then a sensitive entry alone or a new batch); `lineOps` gives the batch controller the line's own moves. `src/verify/start.ts`: a batch head's request is wanted while its batch is live there; a light request while its entry waits at that head, run with the light steps. `src/policy/merge.ts`: the batch evidence rule in the gate. `src/verify/verbs.ts`: `batch drop`, `batch retry`. `src/attention/items.ts`: `landing_batch_held` (P1, the leader's, wakes it while you are away).

## Tests

- `test/unit/landing-batch.test.ts` (real git, the merge verb's own path): the config keys and refusals; three branches in one batch, one verify, all landed with a merge record each, one first-parent merge per task and no worker branch moved; the landed proof per member; a branch delivered during a batch forms the next; the light check queued per branch, a pass joins and a failure goes back; a conflict only with an earlier member waits, then goes back against main; a migration number clash, and none against a member that waits for a conflict; a red batch held with its culprit and item, retry once per head, drop sending the culprit back and a new batch of the rest landing; a timeout run once more, then held; main moved by hand rebuilt three times, then held, and retry rebuilding it on main; a drop from that hold not saying a verify failed; a member leaving a green batch before main takes it (rebuilt) and after (the rest recorded, an item for the leader); batch mode refused on a PR project in the effective config and by project set; a stop after the fast-forward; a member refused by the gate; a pass under another policy not counted; a sensitive branch landing alone; switching back to the queue dissolving the batch.
- `test/unit/landing-batch.test.ts`, fix forward: a red batch opening one fix task (plan, task policy, backlog intent, `flowryn/batch/lb<N>` at the batch head, the brief) whose delivery joins as the last member, is verified again and lands with every member; a second red held with drop cancelling the fix and rebuilding the rest from main; the deadline holding the batch and a late delivery still taken; a failed fix run; a delivery off the batch head; a timeout opening no fix; the fix taking no light check.
- `test/unit/culprit.test.ts`: names in a log, the culprit, ties and no match, migration clashes and what is not one.
- `test/integration/landing-batch.test.ts`: a real daemon and fake workers delivering `--local`: a light check per branch, the first batch verifying while the second branch is delivered, the next batch forming, both landing on local main and cleaned up, no steer. And a red-then-fixed batch: the scheduler starts the fix on the batch head, the fake fix worker (its steps ride in the failing step's output, which the brief carries) commits and delivers, the batch is verified again and lands with the fix, and the branch delivered meanwhile lands in the next batch.

## Choices

- Local-only only (q108): landing a batch on GitHub means writing to main there or a batch PR merged with a merge commit; no PR project uses the landing line today.
- A red batch opens one fix task on top of the batch before any hold (phase 2): fix forward rather than bisecting, as the user chose at g807. The fix starts on any project's autonomy, because the batch holds every landing of the project until it is fixed.
- The fix starts from the batch head as its `base_sha`, not as a `base_branch`: a base branch is what a PR targets, and the fix lands into the default branch like any member. The local branch `flowryn/batch/lb<N>` only keeps the batch head reachable until the fix's own branch holds it.
- Ending a fix cancels its run (a cancel operation the reconciler drives) rather than dropping the task, as `flowryn drop` refuses started work; the parked task is the leader's to drop.
- A fix's late delivery is still taken while its batch is held: it is the cheapest way to green, and the leader can still drop or retry.
- A branch that clashes only with another member waits for the next batch, rather than being sent back to merge a batch that has not landed (it may still lose a member).
- Light and full verifies are told apart by policy id, so neither the verify queue nor `auto_merges` gained a column. Light checks are plain verify requests judged by the batch controller, not `auto_merges` rows, so the auto-merge state machine is unchanged.
- The gate keeps every per-member rule; only the verify evidence and the fast-forward are the batch's, and only while the batch is landing.
- `MAX_BATCH` (8) is a constant: a red batch holds every member, so it stays small until data says otherwise.
- Refusals use `not_ready` (a held-only verb on a batch in another state) rather than a new error code.

## Known limits

- A member that the gate refuses, or that leaves, after main already holds the batch (it changed between the gate and the record, or after a stop) is on main without its merge record; an item names it for the leader.
- A red batch stops the project's landings until it is fixed, dropped or retried; a held batch older than you expect shows on the board.
- A fix is told only what the batch's failing step printed (its last lines) and the members' file lists; a failure that needs more context is held after the deadline.
- An ended fix's task stays parked in the backlog (its run was cancelled); `flowryn drop` removes it.
- The light check shares the validation slots with full verifies; with one slot it waits behind a running batch verify.
