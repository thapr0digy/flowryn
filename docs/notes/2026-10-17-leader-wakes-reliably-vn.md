# Leader wakes reliably

- Status: done
- Open: a full rewake of a live Claude leader (waiter killed, line typed, new waiter armed) not yet run end to end in a lab; the composer read and a typed turn were checked live (below)
- Config: `[leader] waiter_grace_ms`

An idle leader now wakes on what you do outside its session, and after its waiter has died. Everything here is deterministic: item kinds, SQL, timers and a fixed line. No model is used.

## Your own actions wake the leader

Before this change, an approval, gate pass, merge or decline you made in your own terminal or on the board opened no item that could wake the leader. A merge you approved then sat until you next typed to the leader.

Three item kinds are now *leader follow-ups* (`LEADER_WAKE_KINDS`, src/attention/items.ts). They are all P1 actionable. They are pushed like a P0: through the Claude waiter, or as a Pi trigger, when the leader is idle and you are inactive or away. They go after any P0, as one batch of at most four (`followUpBatch`, src/attention/router.ts). The waiter's line is `Flowryn follow-up [i31,i32]: …`, and the woken turn gets each line in full. While you are active, nothing is pushed: the follow-ups top the next digest's P1 lines. They are also relay kinds, so a busy Claude leader's turn end carries them.

| Your action (human role only) | Item | Leader's follow-up | Closes when |
| --- | --- | --- | --- |
| `flowryn approve T`, board `a` (merge) | `user_acted` | `flowryn merge T` | the merge is requested, the run lands or is cancelled, or it is dismissed |
| `flowryn approve T --discard` | `user_acted` | `flowryn cleanup T --discard` | the cleanup is done, or it is dismissed |
| `flowryn approve T --gate S` | `user_acted` | tells you the next stage | dismissed after relay |
| `flowryn decline T`, `flowryn gate changes T` | `user_acted` | tells you the worker got your words | dismissed after relay |
| Your `flowryn merge T` refused | `user_acted` | tells you why | dismissed after relay |
| "Request pass" on a review page | `pass_requested` (already existed) | confirms with you through a human channel | the gate passes or is sent back |
| A merge proven outside the leader's own merge call | `landed` | reports the landing | dismissed after relay |

- **The leader never wakes itself.** `openUserActed` (src/attention/follow-up.ts) opens an item only for a `human` caller (your terminal, the board). `landRun` takes `by` on its proof. The leader's own `flowryn merge` passes `by: "leader"`, because its reply already says the merge landed. Anything else passes `other`: your merge, the delivery watcher's later proof of an unproven merge, or a PR merged on GitHub.
- **One wake per action, never a loop.** Each item is carried once, through the presentation lease. A newer action on the same task replaces an older follow-up that is still open. Follow-ups use the P0 budget, `[notify] max_triggered_turns_per_hour` (or `[away] max_wakes_per_hour` while away).
- **A landed item outlives cleanup.** The daemon cleans up a landed run at once, and the run's cleanup resolves its items, so `landed` is kept out of that sweep. It stays until the leader dismisses it.
- **Away.** `user_acted` and `landed` join `AWAY_WAKE_KINDS` and `awayWakeSql`, so the away suggestion and the return brief count them. `pass_requested` was already an away kind. All three now wake an inactive leader even when you are not away, so `p0Candidate` leaves them to the follow-up batch.
- **Notifications are unchanged.** The notification pump already batches new P1 actionable items.
- **Not built: approval expiry.** An approval that expires does not close its follow-up. The leader's `flowryn merge` would be refused and say so, and the item stays until it is dismissed.

## A leader whose waiter is gone

The Claude waiter lives 8 h. It is re-armed only at SessionStart and Stop, and it exits for good on a protocol change after a daemon upgrade. After that, nothing could wake an idle leader. `LeaderRewake` (src/leader/rewake.ts) runs on the daemon's 1 s attention tick, the same way idle-carry works for workers. When every check below passes, it types a fixed line into the lease holder's Herdr pane and submits it:

`Flowryn wake [i12,i14]: the leader's waiter had stopped; items wait. Details: flowryn fleet`

The line holds daemon-made ids, never item text. The prompt hook treats it as a wake, so you stay inactive. The turn's digest carries the items, wake kinds first, and the turn's Stop arms a new waiter.

The checks, in order:

1. The holder has had no waiter in the bus for `[leader] waiter_grace_ms` (default 30 s). `SteerBus.lastSeen` counts from the daemon's start, so after a restart a reconnecting waiter takes the push, not the keys.
2. `leaderPush` has a due wake: the leader is idle, you are inactive or away, and the hourly budget is not spent.
3. Nothing in the database blocks it (`rewakeBlocker`). A block is any of these: the holder is a Pi leader (status only), it has no pane, Herdr is not set up, its process is not known, or an earlier rewake got no answer (no hook event since).
4. The wake has been due for two ticks, and no rewake was typed in this grace window.
5. Herdr: the pane exists and runs the session's own process (`proc_pid`). Herdr reads it `idle` or `done`. The screen shows no dialog question, and the composer reads empty (`paneBlocker`).
6. Right before the keys: the wake is still due, and Herdr still reads the pane settled.

Typed rewakes count against the P0 hourly budget (`rewakesLastHour`, src/leader/wake-state.ts).

**When the leader cannot be woken, Flowryn says so.** The reason is kept in the meta table, with one `leader.rewake_blocked` event per change, and cleared (`leader.rewake_clear`) once nothing is due. `flowryn leader status` (`wake`), `fleet` (`wake`) and the briefing show it as one line:

`Leader wake: not possible since 03:12: the leader runs outside Herdr; type to it.`

### Live check of the composer read (Claude Code 2.1.302, Herdr lab session)

The design's open question was whether the screen can tell an empty composer from your draft. A lab pane running `claude --model haiku` was read through `herdr pane read --ansi` in three states:

- **Fresh:** an empty composer shows a dim placeholder: `❯ ESC[0mESC[2mTry "edit items.ts to..."ESC[0m`. With the escape codes stripped, this is indistinguishable from a draft.
- **Draft:** typed text is plain: `❯ half a draft`.
- **After one turn:** the composer is `❯ ` with nothing after it, and Herdr reads `idle`.

So the rewake reads the pane with its escape codes (`readPane(…, { ansi: true })`). It drops text drawn dim (SGR 2) as placeholder (`typedText`), and finds the composer between two rule lines. The unit tests use those exact bytes. A composer it cannot find refuses ("cannot read the leader's composer"). The same run showed that a line typed with `send-text` and Enter starts a normal turn that ends idle.

## Tests

- **test/unit/leader-wakes.test.ts**
  - A follow-up wakes an idle leader once, and tops the digest while you are active.
  - Batching at four, the P0 first, and the shared budget.
  - The wake line counts each kind on its own: a review-page pass request reads "a review pass was requested", never "a merge landed".
  - Only human callers open `user_acted`.
  - A landing the leader's merge proved opens nothing; other proofs open one `landed` item.
  - The fixed line, and the composer read: the live bytes, drafts, and transcript quotes that are not the composer.
  - The rewake types once after the grace and two ticks, then never again without an answer.
  - Each refusal: blocked, working or unknown status; a busy re-read; a draft; no composer; a dialog; a pid mismatch; a gone pane; no pane; Pi; no process; no Herdr; a live waiter.
  - The budget, and a restart within the grace.
  - The status line.
- **test/integration/leader-wakes.test.ts**, through the real leader hooks and waiter:
  - A decline from your terminal wakes the idle, inactive leader once, and the woken turn gets the line in full.
  - With you active, the follow-up waits for your next message.
- **Updated tests:**
  - test/unit/away.test.ts: `pass_requested` now wakes as a follow-up, not as a P0.
  - test/unit/policy-follow.test.ts: a landing proven elsewhere leaves its `landed` item open.
