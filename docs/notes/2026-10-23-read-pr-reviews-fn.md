# Steer the worker on PR reviews and comments

- Status: done
- Open: not yet run against real GitHub (tests use the fake forge); the REST and GraphQL field names were taken from GitHub's documented shapes for API version 2022-11-28, not read live
- Config: `[upkeep] steer_reviews`, `[upkeep] review_reraise_hours`

Scout finding 10 (scout-efficiency-and-fz): Flowryn read a delivered PR's state, head and checks, but no reviews or comments, so feedback on GitHub waited until you noticed it and steered the worker yourself. The predecessor had this as 6df15481 (`bin/fm-contributions.sh`). It raises unanswered review threads again after a reply age, then daily.

## What it does

On each delivery-watcher poll (`[github] poll_ms`), for every open PR delivered by a ship that is `ready` (delivered) or `running`/`validating` (back at work on it):

1. Read the PR's reviews, inline review comments and conversation comments (`GET pulls/N/reviews`, `pulls/N/comments`, `issues/N/comments`). These are paged and ETag-cached, so an unchanged list is a free 304.
2. Read the review threads' resolution through GraphQL (`reviewThreads { isResolved comments(first:1) { databaseId } }`; REST has no resolved flag). This read happens only while an inline thread waits on an answer, and at most every 5 min per PR (`REVIEW_THREADS_MIN_GAP_MS`), because a GraphQL POST has no ETag and costs rate limit. The GraphQL URL is `<host>/api/graphql` for an Enterprise `…/api/v3` base, otherwise `<api_url>/graphql`. The token rule is unchanged.
3. Apply the rules (`src/forge/feedback.ts`, plain code, no model), then record and send (`src/reconcile/reviews.ts`) in one transaction with events.

### Rules

| Feedback | Steers? | Raised again until |
|---|---|---|
| Inline review comment | yes | its thread is resolved, or a later worker reply in that thread |
| Review requesting changes, with text | yes | a later worker reply anywhere on the PR, or the same reviewer approves |
| Review commenting with text, conversation comment | once | never |
| Approval, empty review, empty change request (its inline comments carry it) | no | – |

| Who wrote it | Counts? |
|---|---|
| You (the PR's author account) | yes (your answer on the design review, q95) |
| Write access (`OWNER`, `MEMBER`, `COLLABORATOR`) | yes |
| A bot (`user.type` Bot) | its reviews and inline comments; not its conversation comments (coverage, deploy previews) |
| Anyone else | no; recorded once as `ignored`, and its text never reaches a worker |

The worker posts its replies from your account, so you and it share a login. The steer therefore asks the worker to end every GitHub reply with the hidden marker `<!-- flowryn:reply -->` (`REPLY_MARKER`). A text with the marker is a worker reply only when the PR's author account wrote it. It answers a thread and is never feedback itself. A marked text from anyone else (a collaborator, a bot, a stranger) is not a worker reply: it answers nothing and is judged like any other text by the table above.

### Sending

- One batched steer per run per poll. It lists who wrote what, where and the link, with each text quoted (first 500 characters) and marked as the reviewer's words, not Flowryn's instructions. At most 10 items are listed; the rest are counted.
- A delivered run (`ready`) is sent back the way the conflict nudge sends it (`sendBack`): approvals are voided, the merge gate closes, and the last stage restarts through the scheduler, resuming a closed worker if needed. A `review_steered` P1 info line says so. Answering a review usually means new commits, and a new commit after delivery would be a head-move divergence.
- A run already at work gets a plain steer.
- A `merging` run is left alone. If the merge does not land, the next poll picks the feedback up.

### Raising again, and caps

- An unanswered tracked item is sent again after `[upkeep] review_reraise_hours` (default 24), then as often. 0 turns that off.
- After `MAX_REVIEW_SENDS` (3) sends, the next due time escalates the item to a `review_unanswered` P1 for you, and it is not sent again. The P1 closes when nothing escalated is left unanswered.
- At most `MAX_SENDS_PER_HEAD` (3) review sends go to one delivered head. Further feedback is `held`, with one `review_unanswered` P1, until a new delivery. This also bounds a loop if a worker forgets the marker and its reply is read as your feedback.
- Feedback that disappears from the PR (deleted, a dismissed review) counts as answered (`gone from the PR`).
- A landing settles both item kinds.

### Upgrade baseline

Migration 33 (main took 31 for the migration name ledger and 32 for `job_procs`) records `meta.pr_feedback_since` (whole seconds, in ms). Feedback written before that is recorded as `baseline` and never sent, so the first poll after the upgrade does not flood open PRs with old comments.

## Data

`pr_feedback` (migration 33) has one row per item per task, keyed by the forge's id (`comment:<id>`, `review:<id>`, `issue-comment:<id>`). Each row holds the kind, author, url, written time, tracked flag, state (`baseline`, `ignored`, `held`, `sent`, `answered`, `escalated`), the number of sends, the first and last send, and when and how it was answered. Events: `pr.feedback_seen`, `run.review_steered` (`via` `send_back` or `steer`, with the delivered head, which the per-head cap counts), `pr.feedback_answered`, `pr.feedback_escalated` and `pr.feedback_capped`.

## Choices

- **Defaults on**, like `nudge_conflicts`: steering is the point.
- **The watcher's GitHub backoff is shared.** A failing read quiets both the PR and review watchers. A review read that throws never holds up the watchers after it.
- **The reply-marker instruction is in the steer text**, not in the worker contract, so there is no `CONTRACT_REVISIONS` bump.
- **`Forge` gains `feedback()` and `reviewThreads()`.** `PullRequest` gains an optional `author` (`user.login`).

## Tests

- `test/unit/pr-feedback.test.ts` covers the rules (who counts, what steers, what answers, ordering), GitHub's shapes through the fake forge (author, the three lists, paging and 304s, GraphQL resolution and NOT_FOUND, the GraphQL URL) and applying a read. Applying covers: the batched steer, no repeat, baseline, ignored strangers, already-answered threads, re-raise then escalation then closing, re-raise off, one-shot items, gone items, the per-head cap and the steer's limits.
- `test/integration/pr-reviews.test.ts` runs through the real daemon. A collaborator's inline comment sends the delivered ship back with the comment in its steer. A stranger's comment never reaches the worker. The redelivery does not resend. The worker's marked reply answers the thread. A stranger's marked reply answers neither a thread nor a change request, while the reviewer's approval answers the change request. A thread resolved on GitHub is read through one GraphQL call and answers its comment. `steer_reviews = false` reads nothing.
- The fake forge (`test/helpers/fake-github.ts`) serves the three lists in GitHub's shapes, and `POST /graphql` for the reviewThreads query.
