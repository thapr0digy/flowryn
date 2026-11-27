# A worker cannot end its turn while its own background shell job runs

- Status: done
- Open: not run live through a real Claude worker yet

The laws plan's first Flowryn law from a corrections scout (appsec-signal, `corrections-become-check-hs`, evidence.md §2). Five corrections (m1242, m1246, m1541, m1557, m1565) were one class: a worker ran `make ui-check-changed` or `make ui-golden` with `run_in_background` (both run past Claude's 600 s foreground limit), ended its turn with "I'll act when it lands", the job's end notice did not wake it, and it sat idle until the leader steered it. The worker contract already said "never end a turn to wait on a job"; prose was not enough.

## The rule

A Claude worker's Stop with no steer taken is refused while a Bash job it started in the background (in this worker process) is still running (`src/lifecycle/background-hold.ts`, called from the worker `stop` verb in `src/lifecycle/hooks.ts` before the turn-end guard). The refusal is a Stop continuation (`hookSpecificOutput.additionalContext`, the channel steers and the turn-end reminder use) that reads:

> Do not end your turn yet: your background job (Bash bui1, started 12m ago) is still running, and its end may not wake you once the turn is over. Wait for it in this turn with an until-loop on its completion: Monitor, or a foreground Bash until-loop (under 10 min a call; run it again until the job ends). Then act on its result. If you no longer need it, stop it with TaskStop.

Each refusal is a `run.background_hold` event {tool_use_ids, jobs}; the run stays busy (signal `held`). Deterministic: events, the transcript scan `runningBackgroundJobs` already does, and a fixed string.

## What it does not hold

- Anything that rightly holds the worker wins (`waitBesidesOwnJobs`, the turn-end guard's `pendingWait` without the background job): the run past `running`, a stage not `active` (a review gate, a grant), a pending launch, its own open question, a permission dialog, and a steer sent with `--end-turn`.
- An asynchronous agent: its hand-back (`<agent-message>`) wakes the worker, and none of the five cases was one. It stays a rightful wait for the turn-end guard, as before.
- A job of an earlier worker process (before a relaunch or resume), as `runningBackgroundJobs` already counts.
- Leader sessions: the hold is only in the worker branch of the `stop` verb, and a leader's tool calls record no background starts (integration test).
- Pi: it has no background tool, so the hold is Claude only.
- `[workers] turn_end_guard = false` turns it off with the guard (the contract suite runs that way, so `CONTRACT_REVISIONS` is unchanged).
- With the daemon down the `stop` hook steps aside (design section 12): the turn ends, and the `worker_idle` pointer naming the job stays the backstop.

## Bounded

A job stops holding when:

| reason | when | recorded |
|---|---|---|
| ended | its `<task-notification>` is in the transcript | `run.background_ended`, as before |
| `cap` | `HOLD_CAP_MS` (60 min) since the job started, the job's deadline: a job whose end was missed holds no longer | `run.background_hold_released` |
| `refusals` | it has held `HOLD_MAX_REFUSALS` (3) Stops: a worker that keeps ending its turn is let go rather than looped | `run.background_hold_released` |

The call's own `timeout` is not a release: whether Claude enforces it on a `run_in_background` call is unverified, and a job that outlives it would otherwise be let go while still running, the failure this rule exists to stop.

Holds are Stop continuations but stay outside `MAX_CONTINUATIONS` (two steer continuations, design section on Stop continuations). The refusal count is 3 so that two steer continuations, three holds and an asyncRewake waiter wake (which Claude counts as a Stop-hook continuation, M0 c14) stay under Claude's cap of 8 consecutive continuations, and no recorded hold is dropped by Claude.

`run.background_hold_released` {tool_use_id, job, reason, refusals, started_at} is written once per job. A released job is still a rightful wait for the turn-end guard, so no reminder follows, and the `worker_idle` pointer ("has been idle Nm waiting on its own background job (Bash …)") is the backstop, as it was for every case before this change.

```sql
SELECT json_extract(payload, '$.reason') AS reason, COUNT(*) FROM events
 WHERE kind = 'run.background_hold_released' GROUP BY 1;
```

## The law

AGENTS.md's Rules and their checks: "A worker cannot end its turn while its own background Bash job runs", enforced by `test/unit/background-hold.test.ts`, which fails at a01bd23 (no hold) and passes at HEAD. The unit cases replay the transcripts' shape (`make ui-check-changed BASE=main` started with `run_in_background`, then a Stop): held and named, two jobs, none, ended, cap, a call timeout that does not release before the cap, refusals, an agent, a relaunch, and the rightful waits that win.

## Tests

- `test/unit/background-hold.test.ts`: one case per path, above.
- `test/integration/turn-end-guard.test.ts`: through the real CLI hook and daemon, a fake Claude worker is held naming its job and ends its turn once the job's notice lands; one that keeps ending its turn is released after 3 refusals with the reason recorded and gets the pointer naming the job; once the job ended, an outcome-less turn end gets the ordinary reminder; a Claude leader's background Bash and Stop are never held.
- The fake worker (`test/helpers/fake-harness.ts`) treats a hold like a reminder: it is appended to `fake-holds.txt` and continues the turn.
