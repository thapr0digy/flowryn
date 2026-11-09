# Workers stay off false-alarm permission prompts, and are steered on when one blocks

- Status: done
- Open: the live assumptions A1 to A3 below are not yet run against a real Claude in a lab session (the build ran offline only)

The user, 2026-11-08, on the leader's improvement shortlist ("Unstick false safety prompts: a worker froze on a wrong 'dangerous delete' warning…"): "I want them all". On 2026-11-08 the worker of unattended-loops-answer-4y edited a file with a `python3 - <<'PY'` heredoc; Claude Code showed "Dangerous rm operation not ruled out" and auto-blocked it 42 s later ("to avoid holding up an unattended session"), and the leader had to steer the worker on by hand.

The design was reviewed at gate g374 and passed, with no open questions.

## Prevention: the worker contract

The worker contract (`workerContract`, src/harness/contract-text.ts) already forbade history rewrites and an `rm` of a maybe-empty variable. Its rm line now also says to edit with the edit tool, not scripts:

    - Edit with your edit tool, not scripts; rm only "${VAR:?}"/mktemp -d; scratch goes in $TMPDIR.

The contract's budgets (test/unit/harness.test.ts, test/unit/instruction-budgets.test.ts) had no room left, so the rule shares the rm line rather than adding one, and "don't retry a blocked command" lives in the steer below, where it is needed. Both harnesses share the text, so `CONTRACT_REVISIONS` goes to claude 10 (also for the new hook) and pi 9, as the last contract-text change did.

## After a prompt: answered or blocked

Claude only. A Pi worker's prompt item is a stall guess with no outcome signal, so Pi gets the guidance but no follow-up.

- When `openBlockedPrompt` opens a `blocked_prompt` item for a Claude run, it records a **prompt episode** (`prompt_episodes`, migration 61): the item, the captured prompt line (`promptLineOf`: redacted, sanitized, at most 160 characters) and the **held tool**, the main-agent tool whose PreToolUse came last and has not finished (`ToolTracker.latest`, in memory, so it is unknown after a daemon restart and on the reconciler's suspected path).
- The item clears as before (any hook, or the dialog-gone check). The episode is then decided by the next main-agent hook (`settlePromptEpisode`, rules in `outcomeOf`):
  - **answered**: PostToolUse for the held tool, or PostToolUseFailure without Claude's rejection wording. Nothing is sent.
  - **denied**: Claude's PermissionDenied hook for it; PostToolUseFailure whose error is Claude's rejection text ("The user doesn't want to proceed…", "Permission … has been denied", "…awaiting approval did not run"; a plain `Permission denied` from a command does not count); PreToolUse of another main-agent tool; Stop; UserPromptSubmit.
  - Held tool unknown: only Stop, UserPromptSubmit or PermissionDenied decide denied, and any PostToolUse decides answered, so a missing fact never sends a false steer.
  - **void**: a new or resumed session (`hook worker-start`), or a second prompt opening while one is undecided.
- **Denied**, fewer than 3 blocked episodes for the run in the last 30 minutes (this one included; answered ones do not count): one ordinary steer through `createSteer`, which rings by the usual paths (a Stop continues the turn with it at once):

      Your last command was blocked by a permission prompt and did not run: "<prompt line>". Do not retry it. Do the same thing another way: edit files with your Edit/Write tool (no python/perl/sed -i scripts); new commits only, git merge origin/<base>, plain push; rm only "${VAR:?}" or mktemp -d paths. Then ack this steer.

  The prompt line has its double quotes and backticks replaced and is capped again, so it is only ever quoted data. Not urgent: an urgent steer would cancel the very tool call that does it another way.
- **Denied**, the 3rd or later within 30 minutes: no steer; one P1 item `prompt_repeat` for the run (once while open) with up to the last three blocked prompt texts, resolved when the run fails, lands or is cleaned. Fixed limits (`PROMPT_REPEAT_LIMIT`, `PROMPT_REPEAT_WINDOW_MS`), no config keys.
- Events: `run.prompt_episode`, `run.prompt_outcome` (`{episode, outcome, via, steer?}`), `run.prompt_repeat`, beside `steer.created`.
- Flowryn still never answers or dismisses a dialog: all of this runs from hooks, which Claude fires only once the dialog is gone. The new worker hook `PermissionDenied` → `flowryn hook permission-denied` prints nothing, so it never asks Claude to retry.

## Tests

- test/unit/prompt-episodes.test.ts: the outcome rules table, the steer text, hostile prompt text arriving inert (no newline, escape or quote breakout, capped), episodes (blocked, answered, Pi, voided by a new session, superseded), and the repeat limit inside and outside the window, with answered episodes not counted.
- test/integration/prompt-episodes.test.ts, through the real daemon, CLI and hook verbs against the fake Herdr: a blocked prompt cleared by the dialog-gone check gets the steer, carried at the next tool result; an answered one gets none; PermissionDenied decides it; three in 30 minutes raise the P1 with all three texts; and while the dialog is up no key or text is sent and no steer is made.

## Assumptions not yet run live

From the Claude Code 2.1.319 binary: PermissionDenied is documented as "After auto mode denies a tool call", with `tool_name`, `tool_input`, `tool_use_id` and `reason`.

- A1: does PermissionDenied also fire on the unattended auto-block? Guess: no; the hook-order rules cover that case.
- A2: does PostToolUseFailure fire for a denied or auto-blocked call, and with which error text? If it does, the rejection-text rule decides it denied.
- A3: in a parallel tool batch, can a sibling's PreToolUse arrive after the dialog clears while the held tool still runs? That would be a false "blocked". If a live run shows it, the rule should ignore pre-tools of ids started before the dialog. The fallback is reading the held tool's result from the transcript.
