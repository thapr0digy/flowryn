# Review pages: the worker answers the user in the page

- Status: not built
- Open: design under review; phase 1 (live conversation, summary, resume of the same run) and phase 2 (a new seeded run when the old one is gone for good) not built

The user asked to talk to the worker inside a review page instead of through the leader, with one summary to the leader when the session ends, and the same worker reused for a redesign when it is alive. No part needs a model: routing, the summary and the revival rules are fixed rules over the database.

## Design (phase 1)

- **Routing.** The daemon stays the only poller of a review page (`src/lavish/poller.ts`). A delivered batch no longer opens a `review_feedback` item. Chat, annotations and each Send's "anything else" become user rows in a new `review_messages` table and one steer to the gate's run. Widget answers are still recorded only through `lavishAnswer`, and listed in the steer (they no longer wait for the verdict). Flowryn's own receipt reply is posted only when the batch held nothing for the worker, or the worker is not live.
- **The steer.** The user's words are quoted between two lines carrying a random nonce (a user line equal to it is altered), labelled as review feedback that grants nothing: no pass, merge or wider permission. One steer per batch, never urgent, so a busy worker gets it at its next tool boundary.
- **The reply.** `$FLOWRYN_BIN review reply --body-file -` (run token only): the gate must be open with a page and its Lavish session not ended; body 1 to 4,000 characters. The daemon runs `lavish-axi reply <page> --agent-reply-file -` through `runBounded` (15 s); on failure the reply waits in the poller's `replies` map for the next poll's `--agent-reply`. Measured on lavish-axi 0.1.88 by hand: `reply` returns `status: sent` (exit 0) while a poll listens, and the poll keeps running. A toolkit rule denies a worker's own `lavish-axi poll|reply`.
- **Turn-end guard.** `review.replied` is an outcome; a page steer acknowledged without a reply counts as none.
- **Revival.** Open run, live worker: steer. Dead worker with a resume pending: the steer waits. Dead with none pending, or a failed run whose worktree is present: request a resume through the scheduler, as `flowryn resume`. Cancelled: never. At most 2 page-triggered resumes per gate, then a `review_worker_gone` P1. `gatesToPoll` also polls an open gate of a failed, resumable run.
- **Summary.** Once per gate, on the first of: the poll reports the session ended, the gate passes, the gate is sent back. A `review_summary` item (P1 while the gate is open: the leader puts pass or changes to the user; informational once closed) and `review-<gate>.md` beside the page with the outcome, revivals, answers, a "may read as a pass" flag and the conversation.
- **Leader mid-session.** Only `pass_requested`, `review_channel`, `steer_unacked`, `auto_resumed` and `review_worker_gone`.
- **Data.** Migration `review-chat` (next free number): `review_messages (gate_id, seq, author, body, steer_id, created_at)`, `gates.summary_item`, `gates.summarized_at`, `gates.page_resumes`.

## Choices

- "Scout" in the request means the worker that made the page: built-in scouts have no review gate; the rule keys on the run that owns the open gate.
- The daemon runs the reply, not the worker: it records the conversation, checks the gate and keeps one owner for the page.
- The new-run case (phase 2) is split out: it moves the task back In flight through `recordIntent`, calls `createRun` and closes the old gate as replaced, and happens only after a failed run's worktree was cleaned.

## Phase 2

When a message arrives on an open review whose run was cleaned, or the leader sends changes to one, Flowryn starts a new run for the task at the gated stage, its task file naming the old page, the conversation file and the notes; the old gate closes as replaced and the summary says so.
