# No idle workers with work left: the leader wakes for every action item

- Status: partial
- Open: phase 2 (idle-with-work nudges, the worker's long-command wording) and phase 3 (verify failures route themselves) are plan p23's later phases
- Config: `[leader] action_batch_ms`, `[leader] wake_ceiling_per_hour`

Task no-idle-workers-23, phase 1 of 3. The user (2026-11-06): workers sit stopped with work left, and the leader should hear of everything it must act on and tell the workers what next. Steer m569 made the leader wake the core of this phase: "I need the leader to wake when there is a new action item to complete".

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
