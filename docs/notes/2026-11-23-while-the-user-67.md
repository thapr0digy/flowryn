# The leader answers reserved worker questions while you are away with autonomy

- Status: done
- Open: not yet run live with a real Claude or Pi leader (tests use the real daemon and CLI with fake workers)

A reserved question (destructive, irreversible, security, credential, outward, merge, ci-wait or a no-mistakes finding kept for you) used to wait for you even while unattended mode (docs/notes/2026-11-05-unattended-mode-one-9e.md) was live; two waited five hours on 2026-11-23. Now, while an autonomy grant covers the question's project, the leader answers it itself with a reason, and your return brief lists it for review and undo.

## The rule

`flowryn decide <q> <choice> --rationale -` from the leader (a leader session holding the lease) on a reserved question is accepted when `autonomyForDecision` (`src/policy/autonomy.ts`) finds the grant in force now covering the question's run: not ended (`flowryn back`), not past its end, naming the run's project, the run started after the autonomy migration. It is checked inside the verb's transaction. Otherwise the refusal is today's `reserved_decision`.

- Only run-scoped worker questions (q<N>), review-gate questions included. A standalone decision (k<N>, which the leader opens itself) stays the user's: the leader never answers its own reserved decision.
- Every reserved kind counts, a question the worker marked for you and a sensitive task's included. The leader is told to take a second look and leave what only you can do (a key only you hold).
- A reason is required: an empty `--rationale` is `bad_args` and records nothing.
- Workers (`worker_token`) and reader sessions are refused by the verb's roles, as before. `--by captain` and the user's own channels are unchanged; this path always records `answered_by = leader`.
- The daemon's autonomy pass is unchanged: it still parks reserved questions and never answers them itself.
- `flowryn answer` (the alias) still refuses a reserved question; under a covering grant its hint names `flowryn decide <id> <choice> --rationale -`.
- Red-check waivers, `discard:`, `flowryn approve`, gate passes and merges keep their own rules.

## The record

`answered_by = leader`, `answered_via = leader-away` (`LEADER_AWAY_VIA`, `src/lifecycle/decisions.ts`), the rationale, and `decisions.autonomy_id` = the grant. The `decision.answered` event adds `reserved` (the question's class, or `reserved`) and `autonomy` (the grant id). No migration, no wire change.

## Review and undo

- The briefing's "Decided for you since the last briefing" and the return brief's "Decided for you" print `- [q132] <question> → <answer> (reserved: <class>; the leader decided while you were away; undo: flowryn decide q132 <choice> --by captain): <reason>`, or "run over, no undo" once its run ended.
- The autonomy report's Parked line for such a question says the leader answered it, instead of "answered since".
- A leader-away answer is undoable like a rule's (`isRuleAnswer`): `flowryn decide <q> <choice> --by captain` while the run is live steers the worker to the new choice and to revert, with new commits, what it did on the leader's answer. The leader cannot re-answer it.

## What the leader is told

- The worker-questions wake text adds, while a grant is live, a line naming its projects: decide their reserved questions too, after a second look, with `--rationale -`, leaving only what needs the user's own hands (`awayQuestionsLine`, `src/attention/router.ts`).
- The leader skill's Decisions bullet says the same in short.
- The autonomy consent sentence (`AUTONOMY_SUMMARY`, shown when you grant or renew) now says a protected question parks only its task "unless your leader decides it after a second look, recording why; your return brief lists each to review or undo". It applies to grants already live. The plain-away summary is unchanged: under a plain away (no grant) reserved questions still wait for you.

## Tests

- `test/unit/decide-away.test.ts`: the rule (live, other project, past end, after back, standalone, pre-migration run), the daemon pass still parking, the record and event, undo and its steer, the brief lines, the wake text, the consent sentence.
- `test/integration/decide-away.test.ts`: through the real CLI: no grant refused; a reader session and the worker itself refused; an empty reason refused; under the grant accepted as leader-away, the worker's steer acknowledged, the return brief listing it; after `back` the next reserved question refused again.
