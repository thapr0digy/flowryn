# Review pages: the worker answers the user in the page

- Status: partial
- Open: phase 2 (a new seeded run when the review's run is gone for good: cleaned, its worktree removed) is plan p20's next phase

The user asked to talk to the worker inside a review page instead of through the leader, with one summary to the leader when the session ends, and the same worker reused for a redesign when it can be. No part needs a model: routing, the summary and the revival rules are fixed rules over the database (`src/lifecycle/review-chat.ts`).

## What happens on a review page

- **Routing.** The daemon stays the only poller of a review page (`src/lavish/poller.ts`). A delivered batch no longer opens a `review_feedback` item. Chat, annotations and each Send's "anything else" are kept as user rows in `review_messages` and go to the gate's run as one steer per batch (`routePageBatch`). Widget answers are still recorded only through `lavishAnswer`; the steer lists every answer recorded so far. A batch of widget answers alone sends no steer: those answers still reach the worker with the verdict.
- **The steer.** The user's words sit between two lines carrying a fresh nonce (`REVIEW-<8 hex>`); a user line equal to it is altered, so the text cannot close the quote. The frame says it is review feedback that grants nothing (no pass, merge or wider permission). An annotation carries the page text it is on. One steer per batch, never urgent: a busy worker gets it at its next tool boundary. A batch past the steer limit is cut inside the quote, naming the notes file, so the closing line survives. Words sent with Send & End are steered too, saying there is no page left to reply on (act on a change, then end the turn); they never count as an unanswered page message.
- **Flowryn's reply in the page** (the next poll's `--agent-reply`, as before) now says where the words went: "Sent to the worker; its answer will appear here.", "The worker is restarting…", "The worker had stopped; Flowryn is resuming it…", or why nobody reads it.
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
| cleaned, or cleanup done | - | nothing yet (phase 2) |

`gatesToPoll` also polls an open gate of a failed run whose worktree remains, so its page keeps listening. Page-triggered resumes are counted on the gate (`page_resumes`); past `PAGE_RESUMES_MAX` (2) the steer stays queued and one `review_worker_gone` P1 tells the leader (`flowryn resume <task>`, which resolves it, or tell the user). The scheduler's grant still checks capacity and the harness version.

## The leader's one summary

Once per gate, on the first of: the poll reports the session ended (Send & End), the gate passes, the gate is sent back (`summarizeReview`, called from the poller, `passReviewGate` and `sendBack`). The item line leads with the outcome and the counts: messages from the user, replies, answers given on the page, "page revised" (the page's modification time is after the gate opened) and resumes; then, while the gate is still open, "ask the user to pass or send changes", flagging words that read as a pass. The whole conversation goes to `review-<gate>.md` beside the page (written without following a symlink). The item is `review_summary` (P1 actionable, batched with the worker questions like `review_feedback` was) when the session ended with the gate open, `review_recap` (P1 info) once the gate had closed. A gate closing with nothing from the page records `summarized_at` and opens no item. The gate records the file it wrote (`conversation_path`); the verdict steer then points at it (and the raw notes) instead of quoting the comment.

Mid-session the leader sees only `pass_requested`, `review_channel`, `steer_unacked`, `auto_resumed` and `review_worker_gone`.

## Data

Migration 37 `review-chat`: `review_messages (gate_id, seq, author 'user'|'worker'|'flowryn', body, steer_id, created_at)`; `gates.summary_item`, `gates.summarized_at`, `gates.conversation_path`, `gates.page_resumes`. Events: `review.message`, `review.replied`, `review.reply_shown`, `review.unrouted`, `review.revived`, `review.worker_gone`, `review.summarized`.

## Choices

- "Scout" in the request means the worker that made the page: built-in scouts have no review gate; the rule keys on the run that owns the open gate.
- The daemon runs the reply, not the worker: it keeps the conversation, checks the gate and stays the page's one owner.
- Flowryn's own reply still goes out for every batch it routes: the user sees at once where the words went, and the worker's answer follows.
- A batch of widget answers alone sends no steer (less noise); a steer, when one goes, lists every answer so far.
- The user's words lead each stored message, the annotated page text follows, so the pass-word check reads the user's words.
- No `CONTRACT_REVISIONS` bump: the contract suite has no step for the new contract line, and the offline contract test passes unchanged.
- The new-run case is phase 2 (plan p20): it moves the task back In flight through `recordIntent`, calls `createRun` and closes the old gate as replaced.

## Tests

- `test/unit/review-chat.test.ts`: the steer frame (nonce, a forged boundary line, the cut), each routing row, the resume limit, the summary (P1 summary, recap, nothing, a symlinked file), the poller routing a chat message and showing a reply, a refused reply riding the next poll with `--takeover`, and lavish-axi 0.1.88's Send & End output.
- `test/unit/turn-end-guard.test.ts`, `test/unit/toolkit.test.ts`, `test/unit/gate-questions.test.ts`: the guard at a gate, the rule, and the updated routing.
- `test/integration/gate-questions.test.ts`: through the real CLI and daemon, the user talks with the fake worker on the page (its `review reply` shows through the fake lavish-axi) without waking the leader, Send & End wakes the leader with one summary, a pass adds no recap; a dead worker is resumed from the page through the scheduler (same session) and its refused reply rides the next poll. `test/integration/toolkit.test.ts`: the rule through the real hook.
