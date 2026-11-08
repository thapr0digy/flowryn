# No idle workers with work left: the leader wakes for every action item, and idle workers are nudged

- Status: done
- Config: `[leader] action_batch_ms`, `[leader] wake_ceiling_per_hour`, `[workers] idle_nudge_min`, `[workers] idle_nudge_max`

Task no-idle-workers-23, in three phases (phase 2 is task nudge-idle-workers-eg, phase 3 task route-verify-failures-vd; see "Phase 2" and "Phase 3" below). The user (2026-11-06): workers sit stopped with work left, and the leader should hear of everything it must act on and tell the workers what next. Steer m569 made the leader wake the core of this phase: "I need the leader to wake when there is a new action item to complete".

## What changed

Before, an idle leader woke only for a P0, a batch of worker questions, or a few follow-ups (something you did, a merge that landed, a yolo PR ready, a held auto-merge). Nothing woke it while you had been active recently, and the hourly caps limited how often it woke (`[notify] max_triggered_turns_per_hour`, 3; `max_question_wakes_per_hour`, 6; `[away] max_wakes_per_hour`, 6). Every other P1 action item waited for your next message: a PR ready for you, a worker's report, red checks, an unacknowledged steer, stuck validation, a conflict.

Now:

- **One route table.** `LEADER_ROUTE` in `src/attention/items.ts` gives every item kind one of three values. `act` means the leader's move (act on it, or relay it to you). `question` covers the worker questions the leader puts to you (`QUESTION_KINDS`). `user` is yours alone and deliberately not now: `autonomy_parked`, which unattended mode leaves for your morning brief, so it never wakes the leader. `info` means nobody's move. Every actionable kind that is not a question is `act`. `test/unit/leader-route.test.ts` lists every kind, so a new kind fails the test until someone classifies it.
- **Every `act` and `question` item wakes an idle leader**, away or not, once you are not at its composer (see Choices). P0s go one at a time, at once. The leader's P1 action items (`LEADER_WAKE_KINDS`, now derived from the table) go as one batch (`followUpBatch`). The batch comes due once its oldest item has waited `[leader] action_batch_ms` (60 s), so items that open in a burst share one wake. Questions keep their own batch and `question_batch_ms` (30 s).
- **A busy leader gets the items in its running turn.** A Pi leader takes them as a continuation. A Claude leader's Stop now also carries the action batch, as it already carried questions and relay items, so the window holds back only a wake. Relay kinds go in the relay lines alone.
- **A ready PR the daemon is already merging wakes nobody.** That means a live auto-merge or landing-queue entry for its run. A held one wakes the leader as `auto_merge_held`. A non-yolo `pr_ready` now wakes the leader too: putting the merge to you is the leader's move.
- **No hourly cap.** The loop guard is the presentation record: an item is pushed to a session once, and an item never reopens (a new state is a new item).
- **Runaway ceiling.** `[leader] wake_ceiling_per_hour` (60) counts every turn a push started in the session in the last hour: waiter wakes, Pi triggers and typed rewakes, of any kind. At the ceiling, nothing starts a turn until the hour drains. One P0 `leader_wake_runaway` opens, with event `leader.wake_ceiling`; it reaches you through the P0 notification path, and no second one opens for that session while it is open (`src/leader/wake-ceiling.ts`). A push that rides a running turn is never held.
- **Retired caps.** `[notify] max_triggered_turns_per_hour`, `[notify] max_question_wakes_per_hour` and `[away] max_wakes_per_hour` are still read, so older configs load, but they limit nothing, and `flowryn init` no longer writes them into a new config. `flowryn away` reports `wake_ceiling_per_hour` in place of `wake_cap_per_hour`.
- **Away no longer changes what wakes the leader.** `p0Candidate` takes only real P0 action items. The away-only P0 rule (`awayWakeSql`) is gone from it and still counts items for the away suggestion. Away keeps its return brief and its expiry.
- **Leader skill text.** On an item, the leader acts that turn: it steers, verifies, merges, decides what is its own, or puts the item to you. It never leaves a worker idle with work left. The follow-up footer says the same.

## Choices

- **Not over your draft.** Steer m569 says the wake holds "whether or not the user was recently active", and that while you type in the session the item rides the busy turn. Flowryn's only signal for "you are at the composer" is the session's activity flag. Claude clears it about 60 s after a turn ends with no typing (idle_prompt). Pi's extension reads the composer and your keystrokes. So a wake waits while that flag says active (away counts as inactive), then goes. The leader bridge contract proves that nothing is pushed onto a draft (its "a P0 while idle and you active" step). Dropping that hold would break a safety property proven live, which this build cannot re-run live. Known limit: a draft left in a Claude composer keeps idle_prompt from firing, so the wake waits for your next message.
- The follow-up names were kept (`followUpBatch`, `followUpText`, `leader.follow_ups_pushed`) and their meaning widened, instead of renaming them to `actionBatch`: less churn, same wire format. This deviates from the spec's names.
- `leader_wake_runaway` stays open until it is dismissed, rather than resolving itself when the hour drains, so you see that it happened. This deviates from the spec.
- The digest order keeps the old follow-ups (your actions, landed merges, held auto-merges, yolo PRs) at the top of their lane (`FOLLOW_UP_FIRST_SQL`). Which items wake is a separate question, answered by `LEADER_WAKE_SQL`.
- No migration and no `PROTO` change: everything is read from items, presentations and events.

## Tests

- `test/unit/leader-route.test.ts`: the table lists every kind; a report wakes past the old cap; the batch window; a busy Pi continuation; info never wakes; the loop guard; the ceiling and its one P0.
- `test/unit/leader-wakes.test.ts`, `test/unit/away.test.ts`: updated to the new rule.
- `test/integration/leader-wakes.test.ts`: a worker report wakes an idle leader with you active, past the retired cap; a busy Claude leader's Stop carries an action item; a follow-up wakes after its window with you active.
- `test/integration/away.test.ts`, `test/integration/question-wake.test.ts`: gates and questions wake whether you are present or away; the retired caps cap nothing.

## Phase 2: idle-with-work nudges

Before, a worker that stopped with work left sat there: the turn-end guard reminded it once, and after 15 minutes the leader got a `worker_idle` pointer, whatever the worker still owed.

Now the reconciler nudges it (`src/lifecycle/idle-nudge.ts`, called from the live check right after liveness is set, inside the same observed transition, so a newer hook voids it):

- **Who.** A run in state `running` that stopped (`idle_since` set, no busy lease), for which `pendingWait` finds nothing: no review gate (except an unanswered page message), no capacity or other non-active stage state, no pending launch, no open question (reserved ones included), no open permission dialog, no end-turn steer, no background job of its own still running. Never while a daemon restart is asked for or under way (its handoff owns the workers), and never while another steer is carried and not yet seen, or due to ring: the ring machinery owns that.
- **What counts as work left** (any of them):
  - a steer the worker saw (its latest ring is `seen`) and never acknowledged, other than a nudge;
  - for a ship, commits on HEAD not on `refs/remotes/origin/<branch>` (only once that branch was pushed at all), or commits past the head it delivered. These are local ref reads (`git rev-parse`, `git rev-list --count`) through `gitRunner`, so `runBounded`, with a 30 s deadline and no network;
  - its stage is `active` with no `stage.done` since the stage started;
  - the latest verification of its delivered head failed and no steer reached the run after it.
- **When.** The window runs from the latest of: the idle episode's start (`idleEpisodeStart`), the last `run.background_ended`, the last nudge. The first nudge comes `[workers] idle_nudge_min` (10) minutes in. Each later one waits twice the last window (20, then 40 minutes after the one before). At most `[workers] idle_nudge_max` (3) go in one episode.
- **The nudge** is a plain steer (`createSteer`: no decision, never urgent, never end-turn) with a fixed text, and a `run.idle_nudge` event `{n, steer, outstanding, idle_ms, head, remote}` in the same transaction. The bus is notified after commit, so it rides the ordinary carry (a Claude waiter, the idle carry, the Pi extension). For example: `Flowryn: you are idle with work left: unacked steer m556 (read it again: $FLOWRYN_BIN inbox); 2 commits not pushed (push, then deliver); stage build not done. Continue now; end with an outcome.`
- **Progress ends an episode** and resets the count: an outcome event (`OUTCOME_KINDS`), the ack of a steer that is not a nudge, a new stage, a (re)started worker, or a HEAD or remote ref that moved since the last nudge. Each nudge records its number `n`, so after a moved ref the count goes on from 1 (1, 2, 3, then the stall). A nudge sent while a git read failed records its refs as unknown (`refs_unknown`); a move is judged against the episode's latest nudge with known refs, and with none there is no move, so a failed read never resets the count.
- **Stalled.** After the last nudge and one more window (80 minutes at the defaults) with no progress, one P1 `worker_stalled` (route `act`, so it wakes the leader) names the work left and the nudges, with event `run.idle_stalled`. Once per episode.
- **worker_idle** is not opened while a nudge episode is under way for the run (one nudge sent since the last progress); `worker_stalled` takes its place. It still opens for an idle run with no work left, or before the first nudge when `[reconcile] idle_alert_ms` is shorter than the first window.
- **A git read that fails or times out** makes the unpushed condition unknown, never outstanding; the other conditions still apply. It is recorded once per episode as `run.idle_nudge_unknown {detail}`.

The worker contract keeps main's outcome line (prompts-that-keep-47): work on until an outcome, never end a turn to wait on a job, run it in the foreground. The build skill adds only: never end your turn with commits unpushed or undelivered (the visual QA skill commits nothing and stays under its 4,800-character budget without it).

### Phase 2 choices

- **The turn-end rule lives in the stage skills; the contract follows main.** The spec put a long-command rule (background commands over about 5 minutes) in the contract and the skills. Main's contract now says to run a job in the foreground (prompts-that-keep-47), so the background advice is dropped everywhere and the contract is unchanged by this phase. The build skill, read at every stage start, adds one line (`UNDELIVERED_WORK_RULE`): never end your turn with commits unpushed or undelivered. `CONTRACT_REVISIONS` is unchanged.
- **An earlier nudge never holds the next.** A nudge the worker never acks rings on its own like any steer (and opens `steer_unacked` after `max_rings`). Only a carried or due steer that is not a nudge holds a nudge back. A nudge's own ack is not progress, or acking it would reset the count forever.
- **Unpushed needs a remote branch.** A branch never pushed has no `origin/<branch>` ref. Its unpushed condition is then not counted (a build stage before the ship stage owes no push, and a local-only ship never pushes); the stage condition covers it.
- **`[workers] idle_nudge_min` takes a fraction** (tests use 0.01 to 0.02 minutes); `idle_nudge_max` is a positive integer.

### Phase 2 tests

- `test/unit/idle-nudge.test.ts`: each condition, the template, the 10/30/70-minute schedule and the stall 80 minutes later, progress resetting the count (not a nudge's ack), a background job's end starting the window, no nudge on a review gate, a capacity wait, a pending launch, an open or reserved question, a blocked dialog, an end-turn steer, a restart handoff or a ring in flight, a failed verification as the only work left reaching the stall, a failed read that neither resets the count nor repeats its note, and the git reads against a real repository (unpushed, undelivered, never pushed, behind its remote, timed out).
- `test/integration/idle-nudge.test.ts`: a fake worker that left a commit unpushed is nudged, pushes and delivers, and gets no second nudge; one that ignores its nudges gets three, then one `worker_stalled`.

## Phase 3: verify failures route themselves

Before, the auto-merge sent a verify's failing step back to its worker once per head and held everything else for the leader: a timeout, a second failure at the head. A leader's own `flowryn verify` that failed went nowhere: the leader read it and had to steer the worker by hand.

Now one router judges every finished verify that did not pass (`src/verify/route.ts`, `routeVerifyOutcome`). It serves the auto-merge (`fromVerifying`), the landing queue (whose heads of line are auto-merge rows) and a leader's `flowryn verify` (`routeManualVerifies`, run in the auto-merger's pass, which a finished verify kicks):

- **A timeout runs once more.** A step killed at a deadline (it hung at its own deadline on every attempt, or the run's ran out) gets one more verify at the same head: a new request copied from the one it ran from (PR, branch, worktree, PATH, source), or the queued one it joins, with event `verify.auto_rerun {of, step, ref, head, request}`. The auto-merge row goes back to `queued` on it. A second timeout at that head goes to the leader.
- **A real failure goes back to the worker.** A step that exited non-zero is sent back with the step, its exit, its log path and its last 40 lines. The tail is read at most 16 KiB from the end, control characters stripped (`sanitizeBlock`), secrets redacted (`redactSecrets`: GitHub, GitLab, OpenAI-style, AWS and Slack tokens, `Bearer` values, labelled `password=`/`token=` values, URL userinfo, private key blocks), and then cut by the steer's own cap. Event `verify.sent_back {verification, step, exit, head, ref, log, path}` (path `auto_merge` or `manual`). A delivered ship is sent back as before (its last stage starts again with the text); a ship still working gets a plain steer (no decision, not urgent, not end-turn), carried at once.
- **The leader gets** (event `verify.escalated {verification, code, step, head, detail, path}`):
  - a second timeout at the same head (`verify_timeout`);
  - a failure at a head that was already sent back (`verify_failed`);
  - the same step failing after its send-back at an earlier head of the run;
  - a fourth failure in one run (`MAX_VERIFY_SEND_BACKS`, 3 send-backs);
  - an error, a review with no verdict, or a failure with no failing step;
  - a failure whose run has ended;
  - a re-run that could not be queued (the project has no verify steps now, or its config is invalid), with the reason.

  On the auto-merge's path that is the row held with `auto_merge_held`, as before. On a leader's own verify it is a new P1 `verify_failed` item (route `act`, so it wakes the leader) naming `flowryn verify show v<N>`. It resolves when the run delivers again, is sent back or lands; otherwise the leader dismisses it once handled.
- **A leader's own verify is judged once.** Only verifications started from a `cli` request (or a startup recovery's re-run of one) and not already judged elsewhere: an auto-merge row follows it, or either path recorded its `verify.auto_rerun` (`of`), `verify.sent_back`, `verify.escalated` or `verify.route_skipped` (`verification`), so a leader's verify an auto-merge row adopted and then re-ran after a timeout is not escalated a second time once the row moves to the re-run. Each one gets exactly one of the events above or `verify.route_skipped {verification, why}`: superseded by a later verify of the same PR, a delivery past its head, cut off by a daemon stop (recovery runs it again), or no task. The pass keeps its place in meta `verify_route_mark` (the last `finished_at` judged and the ids judged at that instant). With no mark (the first pass after an upgrade), failures from the last 15 minutes are judged and older ones are history. If routing one throws (a database error, a run in a state the send-back refuses), a fresh transaction escalates it instead: `verify.escalated` with the error in `route_error`, and a `verify_failed` item naming the error and `flowryn verify show v<N>`.
- The idle nudge's `verify` condition (phase 2) still covers a failure nobody steered, such as one from before this change.

### Phase 3 choices

- **The same step after a send-back escalates, as the spec says**, even if a different test in that step failed: the worker already had one try at that step, and a loop of send-backs is what the leader should see.
- **`redactSecrets` was already in `src/util/redact.ts`** (cutover C2, with its tests in `test/unit/redact.test.ts`), so the tail uses it rather than a new copy in `src/util/sanitize.ts`.
- **The send-back event is `verify.sent_back` on both paths.** The auto-merge used to name it `auto_merge.verify_failed`; nothing read that kind. Rows sent back before this change still count at their head (an auto-merge row in state `sent_back`).
- **A review step that timed out is re-run once like any step.** A review with no verdict that did not time out is still the leader's.
- **The landing train's candidate verifies are not routed:** their failure only drops the candidate, as before.
- **The send-back text says "your work", not "your delivery":** a leader's verify of a ship that has not delivered yet uses the same text. The log path is the verification's step log on this machine.
- No migration, no `PROTO` change.

### Phase 3 tests

- `test/unit/verify-route.test.ts`: a timeout re-runs once and the second is held; a real failure sends back a cleaned tail and the same step failing at a new head is held; different steps are sent back up to three times, then escalate; a leader's verify sends a delivered ship back, steers a working one and carries it, and with no live run opens `verify_failed`; its timeout re-runs as the leader's own request, then opens `verify_failed`; the auto-merge's, a landing train candidate's and older verifies are not the manual router's; a leader's verify an auto-merge row adopted re-runs once on a timeout with no `verify_failed`; a routing error escalates with the error; a later verify supersedes an earlier failure; the tail drops control characters and tokens and keeps 40 lines.
- `test/unit/auto-merge.test.ts`, `test/unit/verify-review.test.ts`: the verdict now re-runs a timeout.
- `test/integration/auto-merge.test.ts`: the send-back and second-failure hold, through the real daemon.
