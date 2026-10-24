# A message taken into a running leader turn joins that turn

- Status: done
- Open: a message typed while a Claude leader is busy was not run live (the rule holds whether Claude takes it in mid-turn or after Stop)

Finding i622 from chat-answers-survive-es (docs/notes/2026-10-17-chat-answers-survive-es.md, "Choices made here"). Claude takes a background notice that arrives during a turn into that same turn. The notice can be a Monitor event, a finished background task or a subagent hand-back. Claude runs UserPromptSubmit for it, and no Stop comes before it (M0 c01; spike c16, N1). The leader's `prompt` hook ran `startTurn` for every prompt. So a notice added one to `turn_no`, and `loseCarried` marked what the running turn was carrying as `lost`. Those items were then carried again (attempts + 1, so an info item could drop to the board after three), and the return brief's "leader turns" counted every notice. On 2026-10-17, q72's turn lost i609 to i613 this way. Plain code: the rule reads the busy lease and the transcript's interrupt marker. No model is involved.

## The rule

`prompt` in `src/leader/hooks.ts`, Claude leaders only: when `takenMidTurn` holds, the prompt joins the running turn (`continueTurn`) instead of starting one. `takenMidTurn` holds when the session's busy lease is live (`busyNow`) and no interrupt marker has been written to the transcript since the turn started (`interruptedByTranscript`).

- The turn number stays the same, and nothing is lost. The busy lease and `last_event_at` are refreshed, and one `leader.prompt_taken` event is appended (`{session, turn, source}`). There is no `leader.turn_started` event, so the return brief's "leader turns" counts real turns only.
- The digest, a takeover briefing and a wake's lines are carried for the running turn, so that turn's Stop presents them.
- The transcript offset for the interrupt check is kept, not reset, so an interrupt earlier in the same turn still shows.
- Everything else about the prompt is unchanged. In particular, deciding whether it came from the user (`leader.user_active`, the away suggestion, the end of an automatic away) is not touched here. A typed message mid-turn still marks the user active. Keeping a notice from doing so is chat-answers-survive-es's `isNotificationPrompt`, which this rule does not need.
- Still a new turn: any prompt after Stop or StopFailure (idle), after an interrupt marker, or after the busy lease expired (`busy_lease_ms`, 10 minutes since the last hook).
- Pi is unchanged: `agent_start` was already idempotent while busy, and Pi has no background notices.

| Prompt arrives… | Before | Now |
|---|---|---|
| Mid-turn: a notice | new turn; carries lost | same turn |
| Mid-turn: typed while busy | new turn; carries lost | same turn; user active as before |
| After Stop (idle), a notice or typed | new turn | new turn |
| After an interrupt marker | new turn; carries lost | unchanged |
| After the busy lease expired | new turn | unchanged |
| A Stop hook that never reached the daemon, then a prompt within the busy lease | new turn; carries lost, shown again | same turn; carries presented at the next Stop (they were shown) |

## Choices

- **Busy state decides, not the message's text.** Claude starts a turn only from idle, and Stop is the turn end Flowryn already trusts. The rule needs no classifier, so it works whether or not chat-answers-survive-es has landed, and it covers notices, typed messages and a wake racing a busy turn alike.
- **A new event kind** instead of a flag on `leader.turn_started`: the briefing counts turn starts.
- **The dropped-Stop case changes** as in the last table row. The turn ran; only the report of its end was lost.
- No migration, config key or verb. `CONTRACT_REVISIONS` is unchanged: the contract suite has no leader-turn step.

## Tests

`test/integration/mid-turn-prompts.test.ts`, through the real hook verbs:

- A notice mid-turn keeps the turn number. The first prompt's digest carry stays carried, is presented at Stop and is not shown again. There is one `leader.prompt_taken` event and one `leader.turn_started` event.
- A typed message mid-turn keeps the turn and still records `leader.user_active`.
- A notice after Stop starts a new turn.
- After an interrupt marker, a prompt starts a new turn, and the old carry is lost and carried again.
- After the busy lease expired, a prompt starts a new turn.
- The design's assumption: a question dialog left open past the busy lease is refreshed by the answer's PostToolUse, so the notice that follows still joins the turn.
