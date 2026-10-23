# Chat answers survive background notices

- Status: done

A chat-answer grant (docs/notes/2026-10-10-chat-answers-authorise-5g.md) ended at "the user's next message", and the Claude leader's UserPromptSubmit hook took every prompt for one. Claude Code also runs that hook for messages nobody typed. A notice queued while a dialog is open (a Monitor event, a finished background task, a subagent hand-back) is taken into the turn after the answer, and the hook voided the grant. On 2026-10-17 the user answered q72 in chat; a Monitor's 30-minute expiry notice, queued 43 minutes earlier, arrived 59 ms after grant c19 was made and voided it, so the leader had to ask twice. Now a grant ends only on a message Claude records as typed by the user. Everything else about grants is unchanged.

Plain code throughout: tag matching on the prompt and JSONL parsing of Claude's transcript. No model reads a message.

## What Claude records

Read from 122 real transcripts (Claude 2.1.278 to 2.1.308), then confirmed live by spike c16 (below).

| Arrives as | Transcript entry | `origin.kind` | Counts as the user |
|---|---|---|---|
| A Monitor event, a background Bash or task that finished | `attachment` of type `queued_command` (taken in mid-turn), or a `user` entry (while idle) | `task-notification` | no |
| A subagent hand-back, another session's message | same | `peer` | no |
| A message typed while Claude is busy | `queued_command` | `human` | yes |
| A message typed while idle | `user`, string content | `human` | yes |
| Esc, a slash command, a `claude -p` prompt | `user` | none | yes |

An older `queued_command` has no `origin`, only `commandMode: "task-notification"`, which Claude sets itself. System reminders and hook context are attachments, never prompts, and never voided anything.

The UserPromptSubmit hook input carries only `prompt` (with `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `session_title`): no origin. At the hook, the notice's `queued_command` line is not yet in the transcript; it is written a few milliseconds later. So the hook can only judge the text, and the transcript is the authority, read when the grant is used.

## How it works: two checks, either one voids

1. **The prompt hook** (`prompt` in `src/leader/hooks.ts`). `isNotificationPrompt` (`src/policy/notifications.ts`) is true only when the prompt is nothing but notice blocks: at least one `<task-notification>…</task-notification>` or `<agent-message from="…">…</agent-message>` block. Once those, any `<system-reminder>` blocks (the rendered wrapper, Stop-hook feedback) and the line `Another Claude session sent a message:` are removed, only whitespace may remain. If it is true, each live grant of the session is held (`holdSessionGrants`): `held_prompts + 1`, `verified_at` cleared so its use checks again, and a `grant.held` event. Any other prompt voids the session's grants as before ("the user sent a new message"). The same test keeps a notice from marking the user active (`leader.user_active`, the away suggestion and the return brief) and from ending an automatic away (`endAutoAway`), as a wake already did.
2. **The use** (`transcriptProblem` in `src/policy/grants.ts`, run by `prepareGrant` before `grant use` or a command that takes a grant). After finding the question and the answer as before, it reads every transcript line after the answer's tool_result line, in file order. A `queued_command` attachment's timestamp is when it was queued, not when it was taken in, so time cannot be used. `senderOf` names the sender of each message:
   - The user: a `user` entry with text, an image or a command (not only tool results), unless its `origin.kind` is `task-notification` or `peer`, or it is `isMeta` or a compaction summary. Also a `queued_command` whose `origin.kind` is anything else, or which has no origin and no `commandMode: "task-notification"`. Any such message voids the grant and refuses the command: `grant c<N> was voided: the user sent a new message`.
   - Notices: a message with either of those two origins. If there are fewer than the grant's `held_prompts`, the command is refused without voiding: Claude has not yet written the line, and a retry passes once it has.

   The verify then sets `verified_at` only while `held_prompts` is still the count it checked. If a notice arrived during the check, the command is refused and a retry checks again.

`flowryn show c<N>` shows `held: across N background notice(s)`. Migration 31 adds `captain_grants.held_prompts`.

| After the answer… | Before | Now |
|---|---|---|
| A Monitor event, a background task done, a subagent hand-back | voided | the grant lives |
| The user types a message, busy or idle | voided | voided (at the hook, and again at use) |
| The user types a message and a notice arrives too | voided | voided |
| The user types text that is pure notice markup | voided | voided at use (the transcript says `human`) |
| The hook saw a notice whose line Claude has not written yet | voided | refused; a retry passes |
| Stop, ten minutes, session end, repin | voided | voided (unchanged) |
| Esc during a tool (Claude fires no Stop, M0 c04) | lived on until the next message | voided at use (a user entry with no origin) |

Approval attempts (`voidPendingAttempts`) still end on any prompt, notices included: they are declined prompts, so ending them early costs nothing.

## Threat model (docs/cutover-notes.md, C1 · Decisions)

- **Who can authorise does not change.** A grant is still minted only by the leader's AskUserQuestion hooks, checked against Claude's transcript, used once, and ended by Stop, the ten minutes, session end and a repin. Holding it across a notice keeps exactly the authority the user's answer gave. The change only stops removing it early.
- **The leader can make notices at will** (a background `sleep 1`) and controls much of their text (a Monitor's lines, a subagent's report). The effect is a hold, never a grant. A notice cannot hide the user's "wait, no": the hook voids any prompt that is not pure notice markup, and every message after the answer must be labelled non-human in the transcript, which the leader cannot write (`src/policy/static.ts`).
- **Forged hook calls.** The leader's token can call `hook prompt` with a notice-shaped prompt. That only adds a hold, which makes a use stricter, and it cannot stop the real hook Claude fires for the user's message.
- **Limit (e), a repointed transcript**, is unchanged. A transcript the leader repoints to could carry fake notice lines, but (e) already lets it carry a whole answer, so this adds no new limit and C1's list is not changed.
- **Fail closed.** An origin Claude might add later (`coordinator`, `auto-continuation` and anything unknown) counts as the user.

## Platform facts (spike c16, Claude Code 2.1.308)

`spikes/claude/c16-notice-mid-answer.sh`, run live in a lab session with probe hooks. The model starts `sleep 15` in the background and asks one question at once. The dialog stays open until the command has finished, then is answered, and the model runs one Bash command.

- **N1: confirmed.** The finished command's notice was taken into the turn after the answer, and UserPromptSubmit ran for it once.
- **N2: confirmed.** The hook's `prompt` was the raw queued text, `<task-notification>…<status>completed</status><summary>…</summary></task-notification>`, which `isNotificationPrompt` accepts.
- **N3: confirmed.** By the next Bash PreToolUse, the transcript held a `queued_command` with `origin: {kind: "task-notification", producer: "session-task"}` after the answer's line: no message from the user, one notice.

In the transcript survey, 209 of 230 notices taken in mid-turn had their line before the next assistant entry in file order. The other 21 came after it (parallel writes). A refused use there is retried.

## Choices made here

- **Two layers, not one.** The hook sees only text, and the transcript lags by milliseconds; each catches what the other can miss.
- **A count at use, not a text match.** Holds are compared with notices, so the check does not depend on the hook's text matching the transcript's.
- **An allow-list of origins** (`task-notification`, `peer`). The others are rare, never seen mid-turn, and fail closed.
- **Turn accounting is not changed.** A notice taken in mid-turn still runs `startTurn`, which marks the turn's carried items lost (q72's turn lost i609 to i613). That was reported as its own finding (i622).

## Tests

- `test/fixtures/transcripts/`: one real line for each kind, scrubbed of ids, paths and text. A Monitor event, a background task done, a subagent hand-back, an older notice with no origin, a notice while idle, a message typed while busy, one typed while idle, and an interrupt. `test/helpers/transcript-fixtures.ts` loads them.
- `test/unit/notifications.test.ts`: `senderOf` for every fixture (each notice kind is a notice, each typed kind the user), unknown or missing origins, meta lines and tool results. `isNotificationPrompt` on each fixture's queued and rendered text, notices mixed with typed text, and malformed blocks.
- `test/unit/chat-grants.test.ts`: each notice kind after the answer leaves the held grant usable. Each typed kind voids it at use, even after the hook held the grant. A notice line written before the answer does not count (the order assumption), and more holds than notices refuses (the once-per-notice assumption). A hold re-checks a verified grant, and a hold leaves used, voided and expired grants alone.
- `test/integration/chat-grants.test.ts`, through the real hooks and CLI with the fake Claude leader (new `absorb` step: UserPromptSubmit with the queued text, then the `queued_command` line). Three notices hold the grant, which is then used, and none marks the user active. A typed message voids the grant, and so does one that looks like a notice to the hook. A notice whose line is not yet written refuses the use until it is.
- `test/integration/away.test.ts`, "automatic away and ready work": a notice during an automatic away neither ends it nor marks the user active; the user's next message does, with the return brief.
- The contract revision is unchanged: the suite does not cover leader grants.
