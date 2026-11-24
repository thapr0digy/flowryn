# Landing batches: one full verify for many ready branches

- Status: done
- Open: split and retry (landing-batches-split-3f) not yet run live; appsec-signal goes back to batches after it lands
- Config: `[projects.<id>] landing = "batch"`, `[projects.<id>] light_verify`, `[projects.<id>] batch_max`

On appsec-signal every branch got its own full verify on main plus its work, often more than once (94 verifies, about 10 min each, for 56 landings on 2026-11-19). Batch mode verifies many ready branches together, once. Design reviewed at gate g807 (the user chose local-only projects first, q108). Everything here is plain code: git plumbing, the verify queue, the landing queue's rows and the merge verb's own path. No model.

## Turning it on

```toml
[projects.appsec-signal]
verify = ["make fmt-check", "make vet", "go build ./...", "make pg-test-gc", "make test-changed BASE=main PG_TEST_MAX=10 PG_TEST_MEMORY=3g"]
landing = "batch"
light_verify = ["make fmt-check", "make vet", "go build ./..."]
batch_max = 8
```

- `landing = "batch"`: a third landing mode beside `"queue"` and `"manual"`, for local-only projects only. It needs `verify` steps (`config_invalid` otherwise) and is refused (`config_invalid`) on a project that delivers PRs: the daemon refuses such a config at start and on SIGHUP, `flowryn project add`/`project set --mode` refuse the mode, and `flowryn config` lists it under `problems`. It is a queue for every "does this project queue" check (no direct auto-merge at delivery, unattended mode defers to the line, the rebuild hold); `landing_train_depth` does not apply.
- `batch_max` (optional, landing-batches-split-3f): the most branches one batch takes, an integer from 1 to 8, 8 when unset; refused (`config_invalid`) unless `landing = "batch"`. `batch_max = 1` verifies one branch at a time, like a queue without its train.
- `light_verify` (optional): the light check, in the `verify` grammar (strings, parallel groups, `{ run, when_changed }` tables; no `{ review = true }`), refused unless `landing = "batch"`. It runs with the verify's deadlines. Unset, a branch may join a batch as soon as it is in line. Keep the changed-tests step in `verify`: on a batch head it sees the union of the batch's changes once.

`flowryn config` shows `landing: "batch"`, `batch_max` and the light steps under `light`; the running daemon lists a project whose delivery mode refuses it under `problems`.

## What happens

1. **Joining the line** is unchanged: routine work (yolo, not sensitive) and approved work join the project's `landing_queue` line. Batching never writes a worker's branch or worktree: no catch-up merge and no carried delivery, so an approval at the delivered head stays valid and no worker is waited on. The delivery frees the worker's slot, and a send-back starts a fresh session (docs/notes/2026-11-22-phase-free-the-rn.md).
2. **Light check.** Each waiting, non-sensitive entry's delivered head is verified alone with `light_verify` (a request with `pr_url` `local:<branch>`, no worktree; the runner tells it from a full verify by its policy id). It runs while a batch is in flight too. A failing step sends the work back once per head ("Light check: ..."; `verify.sent_back` with `light: true`), a step timeout runs it once more, anything else (a second failure, an error) holds the entry for the leader (`held:<code>`, an `auto_merge_held` item).
3. **A batch.** With no batch live, every entry whose light check passed (in line order, at most `batch_max`; while a split is under way, only its next half: see "Split and retry") is merged onto local main's tip in the object store: `git merge-tree` then `git commit-tree` with the batch so far as first parent and the branch as second (`Merge <branch> (<task>) into the landing batch on main <sha> (Flowryn)`), so `git log --first-parent main` reads one merge commit per task. The first member is taken as it is when it already holds main. Before merging:
   - **Migration number clash**: a member that adds a file whose name starts with the same number, in a directory whose path contains `migration` (`db/migrations/000042_x.up.sql`), as a member already taken into the batch leaves (`number_clash`) and goes back to renumber (`landing.batch_clash`). A member that was skipped or sent back for a conflict is never compared against. Date-prefixed notes are not migrations.
   - **Conflicts**: a member that conflicts with main goes back to its worker naming the paths (today's conflict nudge); one that conflicts only with an earlier member waits for the next batch (`landing.batch_skipped` with the paths and the members it met). Once those land, a remaining conflict is with main.
   - The batch is a `landing_batches` row `lb<N>` (`verifying`), its members `landing` with `batch_id` and `batch_pos`, and one verify request for the batch head with ref `batch:<project>/lb<N>` (`landing.batch_built`).
4. **One full verify** of the batch head, in the verify runner's fresh worktree; verify resume after a restart works as for any request.
5. **Green**: every member passes the merge gate as today (approval at its delivered head, the sensitive rule, AI attribution), with one change: a batch member's fast-forward and verify evidence are its batch's, counted only while the batch is landing and its head holds both main and the member's head. Then local main fast-forwards to the batch head once (`landing.batch_forwarded`), and each member's merge is recorded through the merge verb's path (its own `git merge --ff-only` of its head is then a no-op), so each run lands, is cleaned up and moves in the backlog as today (`landing.batch_landed`).
   - A member the gate refuses (its worktree moved past its delivery, an approval gone) leaves (`gate:<code>`, held for the leader) and the rest form a new batch. A refusal about the project checkout (`primary_checkout_tangle`) keeps the batch `landing` with one `landing_batch_held` item, tried again each pass.
   - A stop after the fast-forward: the next pass finds main at the batch head and records the members not yet recorded.
6. **Red, split and retried** (landing-batches-split-3f): a failure that looks environmental is verified again by itself after a backoff; failing tests with `rerun_failed` rerun alone (docs/notes/2026-11-22-phase-flake-earns-a3.md); then a batch of two or more splits in halves until a lone branch fails, which goes back to its worker. See "Split and retry" below. No fix task and no leader.
7. **Held** only when it needs a person: main itself failing (`main_red`), main moving under a batch (`base_moving`), its verify cancelled too often (`verify_cancelled`), a gate loosening waiting for its countersign (`loosened_gate`), or the project checkout (`primary_checkout_tangle`). One `landing_batch_held` item names the next commands: `Landing batch lb3 (web, 1) held: main 1a2b3c4d itself fails at \`bun test\` ... Next: flowryn verify show v52 | flowryn batch retry lb3`. A lone branch whose failure still looks environmental after its retries leaves the line held on its own (`held:verify_timeout`, an `auto_merge_held` item naming it); the rest go on.
8. **Rebuilds.** A batch's head never changes. A member leaving (redelivered, its run ended, dropped, also while a green batch waits to land), main moving under it (at most `MAX_INTEGRATIONS` = 3 times, then held `base_moving`) or a verify the gate no longer counts ends it `dissolved` (`rebuilt`) and a new batch of the members left is built on main as it is (`landing.batch_rebuilt`), with its split stack. Switching the project away from `"batch"` dissolves the live batch (`batching_off`), cancels its queued verify, clears its split stack and puts its members back in line; the views treat its entries as queue entries again from that pass on (`landing.batching`).
   - A member that leaves after main already holds the batch head (a stop after the fast-forward) cannot be taken back: the rest are recorded, and one `landing_batch_held` item per member that left (`landing.batch_left_on_main`) tells the leader its code is on main without a merge record.

Sensitive entries never join a batch. They land one at a time through the local line, with your record at the head that lands, exactly as on a queue project; one first in line goes before the next batch forms.

## Split and retry

A red batch is judged by plain code (`src/verify/batch-retry.ts`, `LandingBatches.failed`), in this order:

1. **Looks environmental: retried by itself.** The failure's cause, first match wins: `timeout` (a step at its deadline), `error` (the verify errored, or a review gave no verdict), `test_timeout` (the failing step's log tail holds a test runner's own timeout line: Go's `panic: test timed out after 5m0s`, bun's `^ this test timed out after 5000ms.`), `load` (the host check refused on load at the verify's start or during it, read from `sched.host_blocked` events, or a fresh host check refuses on load as the red is judged), else `red`. Anything but `red` is verified again at the same head, at most `MAX_AUTO_RETRIES` (2) times per batch head, after 5 and then 15 minutes (`RETRY_BACKOFF_MS`); the verify queue starts it only once the host check passes. The batch stays `verifying` (`verify v9 failed (load); retry 1 of 2 in 5 min`); each retry is a `landing.batch_auto_retry` event (`attempt`, `cause`, `of`, `at`).
2. **Failing tests rerun alone**, when the step has `rerun_failed` (unchanged): 3 of 3 passes land the batch.
3. **Split.** A batch of two or more ends `dissolved` (`split`, `landing.batch_split` with `first` and `rest`) and a new batch of its first half (rounded up, in line order) is built on main as it is. The second half goes onto the front of the new batch's <dfn>split stack</dfn> (`landing_batches.split_rest`: `since`, when the first red of the split was judged, and `halves`, the halves still to verify). A passing half lands at once; a failing half splits again.
4. **A lone branch** failed twice: in its batch and alone on main.
   - A `red` goes back to its worker with the failing step and its log tail (`verify.sent_back` with `batch`, `landing.batch_sent_back`; the entry leaves as `culprit`; the batch ends `sent_back`). First, unless a full verify of main's tip passed since the split began, one <dfn>baseline</dfn> verify of main's tip runs (ref `base:<project>/lb<N>`, `landing.batch_baseline`): green, the branch goes back; red, the batch is held `main_red` and nobody is sent back. A baseline is never merge evidence.
   - A failure that still looks environmental after its retries holds that entry alone (`held:verify_<cause>`, `landing.batch_member_held`; the batch ends `held_member`). A run that is not `ready` is held the same way (`held:not_ready`).

**The next batch.** While the project's newest ended batch has a split stack, the next batch is the stack's first half whose members still wait at their heads, and the rest of the stack goes with it; nothing else joins, so a branch delivered during a split lands after it. A rebuild carries the stack; the leader's retry puts the retried batch's members back in front of it; `batching_off` clears it. An empty stack: up to `batch_max` in line order.

One bad branch of eight, at position 6: [1-8] red, [1-4] green and landed, [5-8] red, [5,6] red, [5] green and landed, [6] red alone and sent back, [7,8] green and landed. Seven verifies, no person.

Shown as `lb3 verify v9 failed (load); retry 1 of 2 in 5 min` on the board and pr_ready line, `batch lb3 1/2 verify ...` in the fleet, and `auto_retries`, `retry_at` and `split_rest` (the halves as task ids) in `flowryn show lb<N>`.

**Fix forward is gone.** Phase 2 (fix-a-red-jy) opened one fix task on a red batch's head and waited up to 60 minutes for it, holding every member. Splitting always narrows a red to one branch its own worker fixes, so no case was left for it. A batch row an older daemon left `fixing` is dissolved on sight (`rebuilt`): its fix run is cancelled or its unstarted task dropped, and its branches form a new batch. Leftover `flowryn/batch/lb<N>` branches are deleted on the next pass. The migration 65 columns stay for history.

## The leader's verbs

- `flowryn batch drop <lb> <task>`: on a verifying or held batch. Its queued verify is cancelled; the member leaves (`dropped`) and goes back to its worker (with the failing step's log when the batch's verify failed, else told no verify failed on it); the next pass builds a new batch of the rest and verifies it.
- `flowryn batch retry <lb>`: on a held batch, as often as needed. The batch ends (`dissolved`, `retried`) and its members, none dropped, form a new batch on main as it is on the next pass, with fresh automatic retries and its count of main moves back at 0.
- `flowryn show lb<N>`: the batch, its members and their states, its verify, retries, split stack and reason.

Both verbs are leader and human (scope: the batch's project). A wrong state or an unknown member is refused with `not_ready` or `not_found`.

## What you see

- `flowryn show <task>` and the pr_ready line: `landing batch lb3: 2 of 4, verifying v41 (lq9)`, `landing queue: waiting for the next batch, light check running (v40) (lq10)`.
- `flowryn fleet` needs cell: `batch lb3 2/4 verifying v41`, `next batch, light check passed`.
- `flowryn board`: a LANDING section for each project that lands in batches now (or still has a live batch): the batch in flight with its members, and the next batch forming with each light check.

## Where it lives

- `src/verify/landing-batch.ts`: the controller (`LandingBatches`: light checks, build, drive, land, hold, drop, retry, and a red's pipeline: `failed`, `scheduleRetry`, `split`, `loneRed`, `loneHeld`) and its views; `endFix` only for a legacy `fixing` row. `src/verify/batch-retry.ts`: `envCause`, `MAX_AUTO_RETRIES`, `RETRY_BACKOFF_MS`, `TEST_TIMEOUT_LINES`, the split stack (`halve`, `nextBatchMembers`). Migration 70 adds `landing_batches.auto_retries`, `retry_at`, `split_rest`. `src/verify/batch-store.ts`: the rows (`landing_batches`, migration 64; `landing_queue.batch_id`, `batch_pos`), the baseline ref (`baseRef`, `liveBaselineAt`) and the reads the gate and views share. `src/verify/object-merge.ts`: the object-store merge shared with the landing train. `src/verify/culprit.ts`: the migration-number clash check. The daemon gives the controller the scheduler's host check (`BatchDeps.host`).
- `src/verify/landing-queue.ts`: a batch project's pass (light checks, then the live batch, then a sensitive entry alone or a new batch); `lineOps` gives the batch controller the line's own moves. `src/verify/start.ts`: a batch head's request is wanted while its batch is live there; a baseline while its lone batch waits on that main; a light request while its entry waits at that head, run with the light steps. `src/policy/merge.ts`: the batch evidence rule in the gate. `src/verify/verbs.ts`: `batch drop`, `batch retry`. `src/attention/items.ts`: `landing_batch_held` (P1, the leader's, wakes it while you are away). `src/verify/config.ts`: `batch_max` (`batchMax`).

## Tests

- `test/unit/landing-batch.test.ts` (real git, the merge verb's own path): the config keys and refusals, `batch_max` (1 to 8, only with batch, shown in the effective config) and `batch_max = 1` building batches of one; three branches in one batch, one verify, all landed with a merge record each, one first-parent merge per task and no worker branch moved; the landed proof per member; a branch delivered during a batch forms the next; the light check queued per branch, a pass joins and a failure goes back; a conflict only with an earlier member waits, then goes back against main; a migration number clash, and none against a member that waits for a conflict; main moved by hand rebuilt three times, then held, and retry rebuilding it on main; a drop from that hold not saying a verify failed; a member leaving a green batch before main takes it (rebuilt) and after (the rest recorded, an item for the leader); batch mode refused on a PR project in the effective config and by project set; a stop after the fast-forward; a member refused by the gate; a pass under another policy not counted; a sensitive branch landing alone; switching back to the queue dissolving the batch.
- `test/unit/landing-batch.test.ts`, split and retry: one bad branch of eight found in exactly seven verifies with the green halves landing on the way and the bad one sent back with its step and log; two bad; all bad with one baseline of main; main red holding the batch with nobody sent back, and the leader's retry; a timeout retried after 5 minutes and the whole batch landing; load counting only during the verify or at judgment, not memory; retries used up splitting a pair and holding a lone branch as an entry while the next half goes on; nothing joining while the stack has halves; the stack carried by a rebuild and cleared by batching off; drop on a verifying batch and retry with no once-per-head limit; a legacy `fixing` row dissolved; a member's gate loosening held for its countersign, landed once given, and a drop dismissing it; the flake rerun landing a batch, and a failed or refused rerun splitting it.
- `test/unit/batch-retry.test.ts`: each failure cause (bun 1.4.4's real timeout line and Go's panic as `test_timeout`), the load window and a fresh host check, halving, the next batch from a stack, the stored stack.
- `test/unit/culprit.test.ts`: migration clashes and what is not one.
- `test/integration/landing-batch.test.ts`: a real daemon and fake workers delivering `--local`: a light check per branch, the first batch verifying while the second branch is delivered, the next batch forming, both landing on local main and cleaned up, no steer. And a red batch: [one] lands, [bad, three] goes red and splits, [bad] alone goes red, one baseline of main passes, bad goes back to its worker, [three] lands; no item for anyone.

## Choices

- Local-only only (q108): landing a batch on GitHub means writing to main there or a batch PR merged with a merge commit; no PR project uses the landing line today.
- A red batch splits in halves rather than being fixed forward (landing-batches-split-3f, gate g1056; it replaces the phase 2 choice at g807): one bad branch never holds the rest, and a lone failing branch goes to the worker that knows it.
- Halves are verified even when one must be red (its sibling passed): one more verify per level, no extra state.
- The split stack lives on the batch row and the next build reads the project's newest ended batch, so a stop between batches loses nothing.
- Automatic retries are per batch head (2, after 5 and 15 minutes), constants rather than settings: a split makes new heads, each with its own budget.
- A lone branch is sent back only once main's tip is shown green since the split began, so a broken main never sends every worker back; the baseline grants nothing.
- A held lone branch leaves the line through the held-entry path, so it never holds the project.
- A branch that clashes only with another member waits for the next batch, rather than being sent back to merge a batch that has not landed (it may still lose a member).
- Light and full verifies are told apart by policy id, so neither the verify queue nor `auto_merges` gained a column. Light checks are plain verify requests judged by the batch controller, not `auto_merges` rows, so the auto-merge state machine is unchanged. The light check keeps its own rule (a timeout runs once more, then the entry is held).
- The gate keeps every per-member rule; only the verify evidence and the fast-forward are the batch's, and only while the batch is landing. A split's new batch holds only its own members, so a member lands only on a verify that covered it.
- Refusals use `not_ready` (a verb on a batch in another state) rather than a new error code.

## Known limits

- A member that the gate refuses, or that leaves, after main already holds the batch (it changed between the gate and the record, or after a stop) is on main without its merge record; an item names it for the leader.
- If a project's own verify pushes the host over its load limit, every failure reads as `load`: each red costs its two automatic retries before it splits.
- A flaky test that is neither a timeout nor rerun alone (no `rerun_failed`) can split a batch and send an innocent branch back.
- The baseline verify of main is not retried automatically: a timeout there holds the batch `main_red` for the leader's retry.
- The light check shares the validation slots with full verifies; with one slot it waits behind a running batch verify.
