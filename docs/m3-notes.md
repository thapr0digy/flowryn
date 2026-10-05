# M3 notes

M3 builds section 17's "M3 · Leaders and attention" of [`design-v3.html`](design-v3.html) on top of [M1](m1-notes.md) and [M2](m2-notes.md): the Claude leader bridge (M3a), the Pi leader bridge (M3b), one shared bridge contract suite both pass, the lane table with items, presentations and notifications, the briefing with its morning section and to-dos, the leader lease and handover, the read-only board, and the `todo edit` and `todo rm` verbs M1 deferred. This file records where the design left room, what M3 chose, and what the live runs showed. Each item names the code that holds it.

## Leader sessions and the lease

- **A leader session is one `flowryn lead` launch**, named by Flowryn (`L<n>`), not by the harness. A Claude `/clear` or a Pi session switch inside the same process stays the same leader; only a quit (Claude `SessionEnd` with any reason but `clear`, Pi `session_shutdown` with `quit`) or the harness exiting ends it (`src/lease/lease.ts`).
- `flowryn lead` registers the session (`lead.open`, your terminal only), launches the harness with the session's token in its environment, records the harness process (`lead.attach`), and closes the session when the harness exits (`lead.close`). The session claims the lease at its first `session-start` hook when the lease is vacant or stale (`src/cli/commands/lead.ts`). Ctrl+C belongs to the harness (it interrupts a turn); `lead` ignores it and only waits.
- `flowryn lead` writes the leader files under `<home>/leader/` on every launch (settings, the skill as a Claude plugin and a Pi skill, the Pi extension, the style block, and a `flowryn` command first on the leader's PATH), rather than once at `init` as design section 15 puts it, so they always match the binary that runs.
- **The session's token is the leader token while the lease names that session.** The design issues a new leader token on every claim and writes it into `CLAUDE_ENV_FILE`; M3 binds one token to the session instead, and derives the role from the lease on every call: `leader` while it holds the lease, `reader` otherwise. The effect is the same (the old holder's token stops authorizing leader verbs the moment the lease moves), it works the same way for Pi, and a read-only session can still read and run `flowryn leader claim`. A session's token ends with the session (`bad_token`) (`src/api/auth.ts`).
- A `reader` running a leader mutation gets `not_leader` (exit 77) naming where the lease is, with the help `flowryn leader claim`. Hook verbs accept a leader session's token as well as a run's.
- Your own terminal keeps the `human` role and may still run the to-do, project and run verbs, as in M1 and M2: the lease decides which *session* leads, not whether you may act.
- **Stale** needs both of the design's conditions: no heartbeat for `stale_ms` and the holder's harness process proven gone (pid, start time and executable). A holder whose process was never recorded cannot be proven gone and is never taken over automatically.
- **On claim**: epoch + 1, the session's token becomes the lease token, a new approval key is minted (its hash is stored; the key goes only to a Pi extension over its own hook call, never into an environment; M4 uses it), the old holder gets a one-line banner for its next prompt, and what was carried to it but not presented is lost, so it is carried again to the new holder. The old holder's waiter is told to exit 0. A non-holder's waiter keeps waiting while the lease is vacant (its own `session-start` may be about to claim it) and exits once another open session holds it.
- **A session that takes the lease mid-conversation gets the full briefing with its next prompt** (`brief_pending`). The design says a new holder needs nothing for actionable items "because the new briefing lists them"; a session that was read-only at its start never had a holder's briefing, so M3 gives it one.
- `leader status` shows the lease and every open session; `leader claim` takes the lease for the calling session, or for `--session <id>` from your terminal.

## Presentations

- A presentation names the turn it expects to appear in: a digest and a Stop continuation belong to the running turn, a waiter wake, a Pi trigger and a briefing to the next one. A turn start marks every carry for an earlier turn `lost`, and a later carry of the same item to the same session for that turn (a `/clear` or a lease change before the turn started) reuses the `lost` row; a turn end (Claude `Stop`, Pi `agent_settled`) confirms every carry for its turn or earlier; `StopFailure` and an interrupt confirm nothing (`src/attention/presentations.ts`, `src/leader/hooks.ts`).
- An actionable item stays open after presentation; it only stops being carried to that session again. An informational item is done once presented, and drops to the board after three carries that were never presented.
- **A P0 pushed to the Pi extension is `offered`**, not carried, until the extension reports how it delivered it (`hook delivered`). Found by the race tests: a Pi run can end in the instant between the daemon's push and the extension's delivery, and a turn end then confirmed a P0 the extension declined. A turn end never confirms an offer; the per-item lease (a unique index, added beside the design's `one_p0_path`) covers offers as well as carries.
- The digest has a hand-over deadline: the hook process's start plus `digest_budget_ms`. Only the daemon decides: it carries nothing it applies past the deadline, so a hook that ran too slowly for Claude to use its answer never counts as carried (design section 9, "silent hook timeout"). The CLI prints whatever context it is handed, since Claude's hook timeout is far longer than the budget (`digestDeadline` in `src/leader/hooks.ts`).

## The Claude leader bridge (M3a)

- A leader-only settings file in `<home>/leader/claude-settings.json`, passed with `--settings` (M0 c11), holds the hooks and the permission rules of design section 12: allow `Bash(flowryn *)`, ask for merge, gate pass and discard, deny `approve` and `hook`. `flowryn lead` runs Claude in `--permission-mode auto` with the terse style block (`--append-system-prompt-file`) and the flowryn skill as a plugin (`--plugin-dir`). The settings also allow the daemon socket for a sandboxed Bash tool, as M2 learned for workers (`src/bridges/claude/settings.ts`).
- Busy: `UserPromptSubmit` starts a turn, `Pre`/`PostToolUse` refresh the busy lease, `Stop`/`StopFailure`/`SessionEnd` end it. Nothing fires after an interrupt (M0 c04), so the lease expires; M3 also watches the transcript for the interrupt marker while a turn runs (M0 finding 6) and ends the turn in seconds.
- You are inactive once `Notification` `idle_prompt` arrives (M0 c03), until your next prompt. A woken turn also runs `UserPromptSubmit` (M0 c01); a prompt that is a P0 wake line does not count as you coming back.
- P0 while busy: `Stop` continues the turn with the P0 line, at most twice in a row. Stop asks once; a P0 that arrives after it goes to the waiter. P0 while idle and you inactive: the asyncRewake waiter (`hook wait-p0`, armed at `SessionStart` and every `Stop`, 8 h) exits 2 with the one line. Idle and you active: nothing is pushed; the P0 notifies and tops your next digest.

## The Pi leader bridge (M3b)

- One extension file, written to `<home>/leader/flowryn-leader.ts` and loaded with `-e` (M0 p12), plus the skill with `--skill` and the style block with `--append-system-prompt`. It imports nothing from Pi, so it typechecks in this repository (`src/bridges/pi/flowryn-leader.ts`).
- The briefing is sent with `deliverAs: "nextTurn"` at `session_start`; after a compaction with `nextTurn`, or with `steer` when `willRetry` is set (M0 p06). The P1 digest is queued with `nextTurn` from `before_agent_start`, which Pi awaits before it injects pending `nextTurn` messages into the same prompt (read in Pi 0.87.1's `AgentSession.prompt`).
- `before_agent_start` is your prompt (a new turn, you active, the digest); `agent_start` is any run, a new turn only when the session was idle (a triggered turn), idempotent while busy (M0 p04). The extension sends its state hooks through one queue, so the daemon sees them in the order Pi emitted them.
- You are inactive when Pi is idle, the composer is empty and no key was pressed for `inactive_ms` (M0 p09); the extension reports it both ways. Without the TUI a P0 never starts a turn; it notifies.
- The P0 long poll: busy, the extension sends a `followUp`; idle and you inactive, a `followUp` with `triggerTurn` (M0 p03). The extension looks at Pi again before it sends and declines when you became active or a draft appeared; a follow-up whose run ended meanwhile goes out as `nextTurn`. It always passes `deliverAs` (M0 finding 14), and blocks shell calls to `flowryn merge`, `approve` and `hook` (M0 p08).

## Attention

- Lane order within a lane: an actionable item open longer than `age_ms` first, then project priority, then due date, then age (`src/attention/router.ts`). `fleet` and every briefing list every open actionable item.
- The digest is a header and at most four lines, or three and `+N more`, under 2,000 characters. The P0 line is one line of at most 200 characters that stands on its own as a fact (M0 finding 5).
- The briefing (`src/attention/briefing.ts`) lists the leader, what needs you (up to 20 lines), what is in flight and queued, and the to-dos due today. The first briefing at or after `morning_hour` on a local day adds one morning line (due today, overdue, tasks done since yesterday); `flowryn brief` shows it without using it up.
- Overdue to-dos are P1 items, opened by the daemon's pass and closed when the to-do is done, removed or moved off the past (`src/attention/todos-due.ts`); a to-do verb settles them at once.
- Notifications (`src/attention/notify.ts`): a P0 at once, coalesced within `p0_coalesce_s`, again after `p0_renotify_min` while open; at most one batched notification for new actionable P1 items per `min_interval_min`, and actionable items open over `age_ms` join one once a day; never one for P2. Channels are macOS (`osascript`, text passed as arguments) and Herdr's `notification.show`. Each is a `notifications` row and an event.
- `flowryn dismiss <item>` closes an item that needs nothing more; a dismissed question is closed as dismissed, its captain hold lifted, and its worker told to decide for itself.

## To-dos

- `todo edit <id> [--title <text>] [--body-file -]` keeps the due date; `todo rm <id>` removes the to-do (`src/lifecycle/todos.ts`).
- `rm` joins the journal's verbs. A repeat answers `NOT_FOUND`, so a replay that `show` confirms gone counts as applied. A removed to-do you restore by hand is your edit and stays, like an added one you delete; only a whole-file rollback that also undoes other writes re-applies the `rm` (`src/journal/`).

## The board

`flowryn board` (`src/cli/commands/board.ts`) reads `flowryn.db` read-only and redraws every 2 s: the leader, what needs you, the fleet, updates from the last day, and open to-dos. It refuses an agent pane; `--once` prints one frame. Approve on the board arrives with the approval channel in M4.

## Config

- `[leader]`: `busy_lease_ms`, `stale_ms`, `inactive_ms`, `digest_budget_ms`, `age_ms`, `question_batch_ms` (added later; see the M5 notes' "Worker questions wake the leader"). The defaults are the design's numbers; the section exists for tests and the lab (`src/config/leader.ts`).
- `[notify]`: `macos`, `herdr`, `min_interval_min`, `p0_coalesce_s`, `max_triggered_turns_per_hour`, `p0_renotify_min`, `max_question_wakes_per_hour`.

## Tests

- `test/integration/races.test.ts` is the M3 exit: one test per race in design section 9.
- `test/integration/bridge-contract.test.ts` runs the shared suite (`src/contracts/bridge-suite.ts`) against a fake Claude leader that runs the real settings file's hook commands with Claude's recorded semantics (`test/helpers/fake-claude-leader.ts`), and a fake Pi that loads the real leader extension (`test/helpers/fake-pi-host.ts`).

## Live runs

`scripts/lab/m3-live.sh [--claude-project <checkout>] [claude] [pi]` runs the same suite against real leaders started with `flowryn lead` in panes of a Herdr lab session (`spikes/lib/herdr-lab.sh`). A seeded worker run (no process) raises the P0s and P1s. Claude leads from a linked worktree of a checkout it already trusts, on a `flowryn/contract-<runid>-leader` branch removed with its worktree by exact name; no dialog is ever answered. Pi leads from a scratch directory with a scratch agent dir and the offline scripted provider. What reached the model is read from Claude's transcript (hook-context attachments and wakes, never a compaction summary or the model's own words) and from Pi's session files (custom and user messages, never an assistant reply). The live typing into a leader's composer uses `pane.send_text`, a method only lab tooling may add to the Herdr client; the daemon never can.

Latest run, 2026-09-24, 18/18 passed: Herdr 0.7.5 (protocol 17), Claude Code 2.1.281 with Haiku 4.5 as the leader model, Pi 0.87.1 with the offline scripted provider, in lab session `fm-lab-flowryn-m3-42537-17099`.

| Step | Claude Code 2.1.281 | Pi 0.87.1 |
|---|---|---|
| Session start claims the vacant lease and briefs | lease 1; the briefing's item presented at the first turn end | lease 3; the briefing rode with the first prompt as `nextTurn` |
| A P1 rides with your next message | carried by `UserPromptSubmit`, presented at `Stop` | carried by `nextTurn` from `before_agent_start`, presented at `agent_settled` |
| A P0 while busy | `Stop` continued the turn with the P0 line, once | the extension queued a `followUp` during the 20 s tool call |
| A P0 while idle and you active | notified, not pushed for 20 s, then top of the next digest | notified, not pushed for 12 s with a draft in the composer, then top of the next digest |
| A P0 while idle and you inactive | `idle_prompt` after 60 s; the asyncRewake waiter woke the session | 5 s idle with an empty composer; a `followUp` with `triggerTurn` started a turn |
| An interrupt leaves no stuck busy | busy cleared 2 s after Escape, from the transcript marker; no hook fired | busy cleared 1 s after Escape, by `agent_settled` |
| Compaction re-briefs | `SessionStart` source `compact` re-listed the open item | `session_compact` re-brief rode with the next prompt |
| A second leader is read-only until it claims | read-only banner; after the claim (epoch 1 → 2) the old leader got the banner and no digest | same (epoch 3 → 4) |
| Quitting the holder releases the lease | `/exit`: lease vacant, both sessions ended | `/quit`: same |

The first live attempts found three problems the fakes had not shown, all fixed and covered above: Pi refuses `/compact` on a short session ("Nothing to compact"), so the lab's scratch agent dir keeps one recent token, as M0 p06 did; Haiku read a step label in the prompt ("to interrupt: …") as a condition and ran nothing, so live prompts carry no label; and a Pi push confirmed by a turn end before the extension declined it, which led to the `offered` state. Test runs also showed that Bun reads `process.ppid` once, so an orphaned waiter never noticed its parent was gone; waiters now check that their original parent still exists.
