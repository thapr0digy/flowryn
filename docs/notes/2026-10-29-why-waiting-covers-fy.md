# Why waiting: reviews, decisions and merges

- Status: done
- Open: not yet watched live on a real fleet; checks that GitHub never started (covered by a local verify at merge time) read as red checks here

Scout finding 14. The wait explanations (`2026-10-12-next-steps-md-wz.md`, `2026-10-13-next-steps-md-wq.md`) covered a dialog, a capacity refusal and a resume, not the waits that last longest: a review page, a worker's question, a delivered PR waiting to merge. Each of those now gets an explanation too: who can end it (you, the leader, or Flowryn by itself), since when, and the exact command. No model: every line is read from records Flowryn already keeps.

## Design

### One writer, not fifteen

The dialog, capacity and resume rules record their explanation where they decide. Reviews, decisions and merges have no single deciding rule: about fifteen places open and close them (a stage done, a gate pass or send-back, a review revival, five decision inserts, every auto-merge step, a landing). So one writer, `explainHumanWaits` (`src/attention/human-waits.ts`), reads what is open and records each wait through `explain`, whose dedupe writes nothing while a wait is unchanged. It reads only the database (never GitHub or git), so it is cheap and cannot hang.

It runs:

- in every scheduler pass, before the sweep (so at worst every `pass_ms`, 30 s by default);
- after any mutation verb, debounced, without a whole pass: the gateway calls `ctx.sched.explainWaits()` (the scheduler's `kickWaits`), so a question asked or answered, or a review opened or closed, is explained within moments.

A wait already open at upgrade is explained on the first pass, dated by its source (`since`): a review by its gate's `opened_at`, a question by its `created_at`, a merge step by when that step began. So the five-day-old PR gets its line at once, with its real age.

### The rules

| kind | rule | when | who acts first |
|---|---|---|---|
| gate | `gate.review` | an open review gate of a live run | you: answer on the review page |
| gate | `gate.review_channel` | the same, while the page's poll fails (`channel_failing_since`) | you: `flowryn approve <task> --gate <stage>` in your shell |
| decision | `decision.leader` | an open run-scoped question, not reserved, not a review's | the leader: `flowryn decide <q> <choice> --rationale -` |
| decision | `decision.captain` | the same, reserved for you | you: `flowryn decide <q> <choice> --by captain`, or tell the leader |
| decision | `decision.deferred` | `defer_until` after today | Flowryn: shows it again on that date |
| merge | `merge.auto` | a live auto-merge (queued, verifying, waiting on checks, merging) | Flowryn |
| merge | `merge.held` | a held auto-merge | the leader: the command its `auto_merge_held` item names |
| merge | `merge.checks_red` | stored GitHub evidence at the delivered head has red checks, and you have not waived the only one at this head | the leader: steer the worker; you: waive exactly one |
| merge | `merge.verify` / `merge.verify_failed` | the project has verify steps and no passing verify at the head | Flowryn while one runs or is queued; else the leader: `flowryn verify <task>` |
| merge | `merge.checks_pending` | checks still running at the head | Flowryn (GitHub) |
| merge | `merge.approval` | not yolo, or sensitive, with no live human approval at the head | you: `flowryn approve <task>` |
| merge | `merge.ready` | nothing else is left | the leader: `flowryn merge <task>` (with `--allow-red <check>` when your waiver passed a red check) |

Every leader step also names you, with the same command for your terminal (`decide`, `verify` and `merge` take the human role). The merge rules follow `checkGate`'s order (red checks, local green, pending checks, approval); a test runs `checkGate` on the same facts for each step and expects the matching rule. A merge row needs an open merge gate and a delivery; evidence for another head is not read as this head's checks, and a PR that reads merged or closed has none (the landing and `pr_closed` own those).

A review's own questions (`--questions-file`) are a fact of the gate row, not rows of their own: one wait, one answer place. Standalone decisions (`k<N>`) have no run and stay in "Needs you" only.

### Data: migration 42 (`human-waits`)

- `explanations` is rebuilt (SQLite cannot widen a CHECK): `kind` adds `gate`, `decision` and `merge`, and a nullable `subject` names what a wait is about (`g12`, `q7`, `merge`). Ids and the AUTOINCREMENT sequence are kept, so a pruned row's id is never handed out again (events name rows as `x<N>`).
- `explain` dedupes per run, kind and subject (`subject IS ?`, so the old kinds behave as before): two open questions on one run are two rows. `NewExplanation` gains `subject` and `since`.
- `auto_merges.next`: `hold()` already composed the next command for its item line; it now keeps it, so the explanation names it exactly. A row held before the migration falls back to `flowryn show <task>`.

### Closing

- The sweep closes a gate row once its gate is not open (`gate passed`, `gate changes`) and a decision row once it is answered (`answered by <who>`) or dismissed; a run's end closes every kind (`run ended`).
- The writer closes any open review, decision or merge row no rule wants any more, with the same outcomes, and a merge row with `merged` or `sent back` from the run's latest merge gate. One `run.explanations_closed` event when anything closed.
- A step that moves on (a verify passes, so the merge now waits for the leader) supersedes the old row through `explain`'s dedupe.

### Views

`show` (default, `--why`, `--timeline`), `fleet`'s `waiting` table and `capacity`'s `unresolved` pick the new kinds up unchanged. The briefing's "Waiting" section keeps only the old three kinds (`RUN_HOLD_KINDS`): its "Needs you" already lists the review, question and PR-ready items. `waitingRuns` takes a kinds filter for that, and now picks a run's newest row by `opened_at` (a backdated row is not newer for being written later). The diagnostic export carries the new rows; their facts hold ids, never a question's text.

## Tests

`test/unit/human-waits.test.ts` (each rule; one row across many passes; a changed page-failure wording is no new wait; two questions stay two rows and close separately; each close path; the merge steps superseding one another; held and live auto-merges; evidence for another head; the merge rules against `checkGate` on the same facts; fleet, capacity and the briefing; a run's end), `test/unit/db.test.ts` (migration 42 keeps ids and the sequence, adds `subject` and `next`, refuses an unknown kind), `test/integration/human-waits.test.ts` (the real daemon and CLI: a worker's question and a design review explained within moments of the verbs, with who acts and the command, and closed by `answer` and `gate changes`).
