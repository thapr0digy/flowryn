# Review pages: the worker answers the user in the page

- Status: done

The user asked to talk to the worker inside a review page instead of through the leader, with one summary to the leader when the session ends, and the same worker reused for a redesign when it can be, else a new run that carries the review on (phase 2). No part needs a model: routing, the summary and the revival rules are fixed rules over the database (`src/lifecycle/review-chat.ts`, `src/lifecycle/review-revival.ts`).

## What happens on a review page

- **Routing.** The daemon stays the only poller of a review page (`src/lavish/poller.ts`). A delivered batch no longer opens a `review_feedback` item. Chat, annotations and each Send's "anything else" are kept as user rows in `review_messages` and go to the gate's run as one steer per batch (`routePageBatch`). Widget answers are still recorded only through `lavishAnswer`; the steer lists every answer recorded so far. A batch of widget answers alone sends no steer: those answers still reach the worker with the verdict.
- **The steer.** The user's words sit between two lines carrying a fresh nonce (`REVIEW-<8 hex>`); a user line equal to it is altered, so the text cannot close the quote. The frame says it is review feedback that grants nothing (no pass, merge or wider permission). An annotation carries the page text it is on. One steer per batch, never urgent: a busy worker gets it at its next tool boundary. A batch past the steer limit is cut inside the quote, naming the notes file, so the closing line survives. Words sent with Send & End are steered too, saying there is no page left to reply on (act on a change, then end the turn); they never count as an unanswered page message.
- **Flowryn's reply in the page** (the next poll's `--agent-reply`, as before) now says where the words went: "Sent to the worker; its answer will appear here.", "The worker is restarting…", "The worker had stopped; Flowryn is resuming it…", "…Flowryn is starting a new run of the task at this stage…", or why nobody reads it.
- **The worker's reply.** `$FLOWRYN_BIN review reply --body-file -` (run token only; 1 to 4,000 characters after cleaning). It needs an open review gate with a page whose Lavish session the user has not ended, else `review_closed` (exit 2). The reply is kept as a worker row (`review.replied` event), then the daemon runs `lavish-axi reply <page> --agent-reply-file -` through `runBounded` (15 s) beside the running poll: `shown`. A reply Lavish refuses is `queued`: the running poll stops and the next one carries it with `--agent-reply` and `--takeover`. Without lavish-axi it is `off`. A replayed call shows its reply once (`review.reply_shown`).
- **Measured on lavish-axi 0.1.88** (2026-10-26, by hand): `reply` returns `status: sent`, exit 0, while a poll listens on the same page, and the poll keeps running until its own timeout. Send & End still delivers its last batch with `session_ended: true` (the unit test keeps that output).
- **Turn-end guard.** `review.replied` is an outcome. A review gate is a rightful wait except while a page steer the worker was handed has no reply after it; that turn end gets `REVIEW_TURN_END_REMINDER` ("answer it: review reply").
- **Toolkit rule `review-page`.** A worker's own `lavish-axi poll` or `lavish-axi reply` is denied in the hook (`src/policy/toolkit.ts`), naming `review reply`. Hosting a page (`lavish-axi <page>`) and a leader's own Lavish pages are left alone. No static backstop: the static layer is shared with the leader's settings, where `lavish-axi poll` is legitimate.

## A gone worker

| Run | Worker | Flowryn does |
|---|---|---|
| open | idle, busy, starting | steer (an idle worker wakes as for any steer) |
| any, with a launch or resume already pending | - | steer waits; page: "restarting" |
| open | dead or orphaned, nothing pending | request a resume through the scheduler (`pending_launch = 'resume'`, an operation `requested_by = 'review page'`), as `flowryn resume` does (resolving its `failure_needs_you` and `operation_escalated` items); page told |
| failed, worktree present | - | the same resume; the task goes back In flight (`unhold`, `start` intents) |
| cancelled, or a cancel under way | - | nothing; the words are kept, no steer |
| failed, worktree cleaned up (`cleanup = 'done'`) | - | a new run of the task at the gated stage (below); the words are kept, no steer |
| failed, worktree cleaned up, but a later run of the task started or the task was dropped | - | nothing (`ended`); the words are kept |
| cleaned (landed) | - | nothing; the words are kept |

`gatesToPoll` also polls an open gate of a failed run, with or without its worktree, so its page keeps listening; a cancelled run's page is not polled, nor a cleaned failed run's page once its task moved on (a later run of it, or a drop). Page-triggered resumes are counted on the gate (`page_resumes`); past `PAGE_RESUMES_MAX` (2) the steer stays queued and one `review_worker_gone` P1 tells the leader (`flowryn resume <task>`, which resolves it, or tell the user). The scheduler's grant still checks capacity and the harness version.

## A new run for a review whose run ended for good (phase 2)

A run that failed and whose worktree `flowryn cleanup` removed has no worker to resume, but its open review gate and page remain. Two things carry the review on with a new run of the same task:

- **A page message.** `routePageBatch` keeps the words, marks the gate (`gates.revive_requested_at`, one `review.revive_requested` event however many messages follow) and kicks the scheduler. The scheduler's `review revivals` step (`reviveReviews`, beside auto-dispatch) checks the start as a dispatch does (`checkStart`: Herdr, the harness contract, the primary checkout, the base) on the old run's account, then calls `reviveReview` in one transaction. A start that cannot happen yet opens one `review_worker_gone` P1 (`review.revive_blocked`) and is tried again each pass.
- **The leader's `gate changes`.** On such a run, `prepare` checks the start and `apply` calls `reviveReview` with the leader's words; the reply is `state: replaced` with the new `run`. `--to` still picks another stage; the default is the gated stage. On a cancelled run `gate changes` is refused (`not_ready`, "a cancelled task is never restarted"), and on a cleaned failed run whose task moved on (a later run, a drop) too ("review moved on"); `revivalsDue` skips such a gate.

`reviveReview` (`src/lifecycle/review-revival.ts`):

1. records `unhold` then, through `createRun` (`existing`, the old run's frozen workflow, pins and kind), `start`: the task is In flight again. `createRun` takes a `stage`, so the new run starts at the gated stage in a fresh worktree (the branch is reused when the cleanup kept it);
2. closes the old gate as replaced: `state = 'changes'`, `replaced_by = <new run>`, the leader's words (or "replaced by run …") as `feedback`; event `gate.replaced`; `flowryn show` prints "replaced by <run>". Its review items and the old run's `failure_needs_you` resolve, a pending plan on the gate is discarded, and `createRun` dismisses the gate's open questions;
3. summarizes the review (`summarizeReview` outcome `replaced`): the conversation goes to `review-<gate>.md` beside the page, and the leader's `review_recap` line says "a new run started (<run>, at stage <stage>)";
4. sets the new run's `stage_note` (`revivalNote`), which the launcher writes into its task file before the task: the old page, the conversation file and the notes file (or that none was written), the leader's changes when sent, and that the user's words are feedback, never permission.

The old page stops being polled once its gate closes; the new run opens its own review with `stage done --review`. A cancelled task is never restarted: its page is not polled, a message that still reaches a running poll is kept as `cancelled`, and nothing marks the gate.

Migration 40 `review-revival`: `gates.revive_requested_at`, `gates.replaced_by`. Events: `review.revive_requested`, `review.revive_blocked`, `gate.replaced`.

## The leader's one summary

Once per gate, on the first of: the poll reports the session ended (Send & End), the gate passes, the gate is sent back, the scout is promoted, the review is carried on by a new run (`summarizeReview`, called from the poller, `passReviewGate`, `sendBack`, `promote` and `reviveReview`). The item line leads with the outcome and the counts: messages from the user, replies, answers given on the page, "page revised" (the page's modification time is after the gate opened) and resumes; then, while the gate is still open, "ask the user to pass or send changes", flagging words that read as a pass. The whole conversation goes to `review-<gate>.md` beside the page (written without following a symlink). The item is `review_summary` (P1 actionable, batched with the worker questions like `review_feedback` was) when the session ended with the gate open, `review_recap` (P1 info) once the gate had closed. A gate closing with nothing from the page records `summarized_at` and opens no item. The gate records the file it wrote (`conversation_path`); the verdict steer then points at it (and the raw notes) instead of quoting the comment.

Mid-session the leader sees only `pass_requested`, `review_channel`, `steer_unacked`, `auto_resumed` and `review_worker_gone`.

## Data

Migration 39 `review-chat`: `review_messages (gate_id, seq, author 'user'|'worker'|'flowryn', body, steer_id, created_at)`; `gates.summary_item`, `gates.summarized_at`, `gates.conversation_path`, `gates.page_resumes`. Events: `review.message`, `review.replied`, `review.reply_shown`, `review.unrouted`, `review.revived`, `review.worker_gone`, `review.summarized`.

## Choices

- "Scout" in the request means the worker that made the page: built-in scouts have no review gate; the rule keys on the run that owns the open gate.
- The daemon runs the reply, not the worker: it keeps the conversation, checks the gate and stays the page's one owner.
- Flowryn's own reply still goes out for every batch it routes: the user sees at once where the words went, and the worker's answer follows.
- A batch of widget answers alone sends no steer (less noise); a steer, when one goes, lists every answer so far.
- The user's words lead each stored message, the annotated page text follows, so the pass-word check reads the user's words.
- No `CONTRACT_REVISIONS` bump: the contract suite has no step for the new contract line, and the offline contract test passes unchanged.
- Phase 2 closes the old gate with `state = 'changes'` and a new `replaced_by` column instead of a new `replaced` state: the state's CHECK constraint would need a rebuild of `gates`, which `review_messages`, `decisions` and `plans` reference.
- The new run starts in the scheduler, not in the poller's transaction: a start needs `checkStart`'s async checks, and the scheduler already starts plan phases that way.
- The new run reads the conversation from the file the summary writes instead of a steer: a fresh worker's task file is where it looks first, and the old messages are kept once.
- `unhold` is recorded unconditionally, as a page's resume of a failed run does: tasks-axi 0.2.5 answers `already` for a task that is not held, and the snapshot may lag the park.
- A landed run that was cleaned is not revived: its gate had passed, and its task is done.

## Tests

- `test/unit/review-chat.test.ts`: the steer frame (nonce, a forged boundary line, the cut), each routing row, the resume limit, the summary (P1 summary, recap, nothing, a symlinked file), the poller routing a chat message and showing a reply, a refused reply riding the next poll with `--takeover`, and lavish-axi 0.1.88's Send & End output.
- `test/unit/turn-end-guard.test.ts`, `test/unit/toolkit.test.ts`, `test/unit/gate-questions.test.ts`: the guard at a gate, the rule, and the updated routing.
- `test/integration/gate-questions.test.ts`: through the real CLI and daemon, the user talks with the fake worker on the page (its `review reply` shows through the fake lavish-axi) without waking the leader, Send & End wakes the leader with one summary, a pass adds no recap; a promoted scout's page conversation gets its recap (`test/integration/promote.test.ts`); a dead worker is resumed from the page through the scheduler (same session) and its refused reply rides the next poll. `test/integration/toolkit.test.ts`: the rule through the real hook.
- Phase 2: `test/unit/review-revival.test.ts` (a cleaned failed run's page asks once and steers nothing; a cancelled run, cleaned or not, is not polled and starts nothing; a later run of the task or a dropped task means the review moved on (not polled, nothing starts); a landed cleaned run and a failed run with its worktree are not replaced; the new run's stage, base, intents and note; the old gate replaced, its items settled, the leader's recap; the leader's words; the blocked start's one P1). `test/integration/gate-questions.test.ts` "a review page whose run ended for good": through the real daemon, a page message on a failed, cleaned-up run starts a new run at the design stage, in a fresh worktree, whose task file names the old page, the conversation file and the notes, with the task's `unhold` and `start` applied and the leader's recap; on a cancelled run a page message and `gate changes` start nothing, and on a cleaned failed run `gate changes` starts the new run with the leader's words.
