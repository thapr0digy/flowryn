# Dismiss refuses an open question's item

- Status: done

`flowryn dismiss <item>` used to close the item's question (q<N>) with it. A leader that dismissed a worker-question or CI-wait item before answering it lost the answer: the later `flowryn decide` or `flowryn chat-question` failed with "decision q162 is already dismissed" (learning l77, 2026-11-24, and again with q162 on 2026-11-25).

Now dismiss refuses an item whose question is open and not deferred, for every caller, with `decision_open` (exit 2). The help names the next step:

- `flowryn decide q<N> <choice> --rationale -`, or `flowryn chat-question q<N>` when the question is reserved for the user;
- or, to let the worker decide, `flowryn decision defer q<N> --until <YYYY-MM-DD>`, then `flowryn dismiss <item>`.

There is no override flag. A deferred question's item dismisses as before: the question closes as dismissed, its hold lifts, and the worker is told to decide for itself (a CI-wait question tells it nothing). An answered question's item dismisses and the answer stands. A review gate's question is still refused with `bad_args` (only the user answers it). Unattended mode's parked questions are open, so they are refused too.

The "deferred" rule (`defer_until` after today, local time) now lives in one place, `isDeferred` in `src/lifecycle/decisions.ts`, used by `decision list`, deadline defaults, human waits and dismiss.

Tests: `test/unit/dismiss-open-question.test.ts`; through the CLI, `test/integration/leader-cli.test.ts` ("brief, fleet, dismiss, …") and `test/integration/ci-wait.test.ts`.
