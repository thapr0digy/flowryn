# Wake the idle leader for ready work; automatic away

- Status: done
- Open: not run live with remote control: whether Claude fires `idle_prompt` after a turn started from the remote-control chat, so that automatic away can start again after a reply from the phone
- Config: `[away] auto_after_min`

Scout finding 3 (`scout-efficiency-and-fz`). Before this change, a yolo PR that was ready woke nobody. `LEADER_WAKE_KINDS` left out `pr_ready`, and away mode woke only for a PR that was not yolo. Nothing else merges a yolo PR, so PRs #95 and #96 sat for about 5 days. Away mode was manual: `away.started` fired once in 19 days and `away.suggested` 5 times, while 27 of 248 inactive spells in the event log lasted over 2 h. Everything here is plain code: a SQL predicate, a timer check and a meta row. No model is used.

## A yolo PR ready wakes the leader

`pr_ready` is now a leader follow-up (`LEADER_WAKE_KINDS`, src/attention/items.ts). The SQL predicate `LEADER_WAKE_SQL` counts a `pr_ready` only when its task is yolo, because the leader can verify and merge that PR with no prompt. A `pr_ready` is never sensitive work: sensitive work opens `sensitive_action_waiting` instead. The predicate replaces the plain kind list in all three router reads:

- `followUpBatch` takes a yolo `pr_ready`, so an idle leader wakes for it once you are inactive or away.
- `p0Candidate` skips only those items, so a `pr_ready` that waits on you still wakes as a P0 while you are away (`awayWakeSql`).
- The rank order tops the P1 lane with them.

| Item | You active | Inactive (`idle_prompt`) | Away (manual or automatic) |
|---|---|---|---|
| `pr_ready`, yolo | digest | **wakes (follow-up)** | **wakes (follow-up)** |
| `pr_ready`, not yolo or no policy | digest | digest only | wakes (P0, as before) |
| `worker_question` | digest | wakes (question batch, unchanged) | unchanged |
| `gate_ready`, `checks_red`, … | digest | digest only | wakes (as before), now also after `auto_after_min` |

The wake line names it: `Flowryn follow-up [i41]: a yolo PR is ready to verify and merge. Details: flowryn fleet`. The follow-up header and footer say the same, and the leader skill says to verify, then merge. A ready-PR wake counts on the P0 push budget, which follow-ups already use: `[notify] max_triggered_turns_per_hour`, or `[away] max_wakes_per_hour` while you are away. There is no new budget.

A follow-up wakes only for an item that has not been shown to the session. A PR that a digest already showed (as #95 and #96 were) does not wake the leader again later. The change covers a PR that becomes ready while you are inactive.

### Why worker questions are not a wake kind

The task asked to add `worker_question` as well. It already wakes an inactive idle leader: it is a `QUESTION_KINDS` item, and the question batch pushes it on `[notify] max_question_wakes_per_hour` (41 `leader.questions_pushed` events so far, 33 through the waiter). Listing it in `LEADER_WAKE_KINDS` as well would push it on two paths and charge the wrong budget (`startedTurnsLastHour` splits the budgets by `QUESTION_KINDS`). The scout's evidence on this point did not match the code. A unit test pins the existing behaviour instead.

## Automatic away

After `[away] auto_after_min` (default 120) with no input from you, the daemon turns away on by itself. `0` turns it off.

- **When** (`autoAway`, src/attention/away.ts; the daemon checks it on every 1 s attention tick, and only reads unless it starts one): the lease holder's `user_inactive_since` is at least that old, the holder's session is open, and no away is on. `user_inactive_since` is set by Claude's `idle_prompt` (about 60 s after a turn ends with no typing) or by the Pi extension, so the count starts about a minute after the leader's last turn ended. A woken turn does not clear it (`isWakePrompt`).
- **What** (`startAway`, `by: "auto"`, event `away.started` with source `daemon`): its start is backdated to when you went inactive. Gates and other away-wake items that opened while you were gone and still wait then wake the leader at once, under the away cap, and the return brief covers the whole absence. It runs until `now + 7 days`, the cap `flowryn away` already has. An expired away whose brief was never shown is folded in, as for a manual start.
- **What ends it** (`endAutoAway`): your next own message to any leader session (a non-wake prompt), Pi's report that you are typing again, `flowryn back`, or the 7 days. Your return records `away.ended` with reason `returned` (source `hook`), and its return brief rides that same message, headed "automatic away, the user returned". An away you set yourself still ends only on `back` or its expiry. Running `flowryn away` during an automatic away turns it into yours (`by` becomes your role; the start is kept), so your messages stop ending it.
- **Not counted as input**: what you do in your terminal or on the board (`flowryn approve`, `gate pass`). That is not leader input, and it already opens a `user_acted` follow-up.
- **Lines**: the briefing and `fleet` say `Away (automatic: no input from the user since 14:02); the user's next message ends it. …`. The return brief's wake count now also counts `leader.follow_ups_pushed`.
- **Idle suggestion**: it stays only while `auto_after_min = 0`. Automatic away replaces it.
- **No holder** (no leader session): nothing starts, because nobody could be woken.

## Choices

| Choice | Picked | Why |
|---|---|---|
| Which `pr_ready` wakes when you are only inactive | yolo only | The leader can verify and merge it alone; one that waits on you reaches you through away |
| Signal for "no input" | the holder's `user_inactive_since` | It is already recorded for both harnesses; no new hook |
| Start of an automatic away | when you went inactive | Items from the absence wake at once; the brief covers it all |
| Where the check runs | the 1 s attention tick | It needs no new timer; the 60 s steady pass would add up to a minute of delay and cannot be shortened in tests; a failing check logs once until it recovers |
| Migration, `PROTO`, version | none | Away lives in `meta`; no verb or argument changed; recent PRs do not bump the version |

## Tests

- `test/unit/away.test.ts`, "automatic away": the threshold edge and the backdated start; nothing with you active, no holder, a closed holder or `0`; a manual away left alone and `away` taking an automatic one over; your return ends it with the brief pending; items from the absence wake once it starts; folding an unshown brief; the away line. The `[away]` config case covers `auto_after_min` (0 allowed, negatives, fractions and strings refused).
- `test/unit/leader-wakes.test.ts`, "ready work wakes the idle leader": a yolo `pr_ready` pushed once as a follow-up; one that is not yolo, or has no policy, never; the P0 budget caps it; a worker question already wakes on the question path; a yolo PR tops the digest; a full batch's wake line stays within `P0_LINE_MAX`.
- `test/integration/away.test.ts`, "automatic away and ready work" (real daemon, hooks and waiter, fake Claude leader): inactivity past the threshold turns away on and a gate opened in the absence wakes the leader, and your next message ends it with the brief, once; `auto_after_min = 0` keeps away manual; a yolo PR ready wakes the inactive leader once, and the woken turn gets the line in full.
- Pi's "active again" path calls the same `endAutoAway`. No Pi-specific test drives it.
