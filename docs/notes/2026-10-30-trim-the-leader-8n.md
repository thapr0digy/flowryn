# Trim the leader skill and the worker contract

- Status: done
- Open: a live `flowryn doctor --contracts` pass on both harnesses at the new revisions (claude 6, pi 5)

Research report section 1.6 and the first half of recommendation 10: bring the leader skill (`src/bridges/skill.ts`) back to its 1.5k-token budget and the worker contract (`src/harness/contract-text.ts`) toward its 10 lines. Advice for a single situation moved to the place where that situation shows up: the item line, a refusal's hint, a verb's help, a steer, or the stage's own instructions in the task file. The skill keeps the verbs and the rules, and the contract keeps what a worker needs on every turn. No model involved.

## Measured

Tokens are estimated at 4 characters each, as `test/unit/qa-template.test.ts` does; no tokenizer runs offline. Contract figures are for Claude with the style block on.

| Text | Before | After |
|---|---|---|
| Leader skill body | 48 lines, 2,208 words, 13,370 chars, ~3,343 tokens | 27 lines, 822 words, 5,257 chars, ~1,314 tokens (with the ask line main added) |
| Worker contract, scout | 38 lines, 511 words, 3,051 chars, ~763 tokens | 18 lines, 241 words, 1,529 chars, ~382 tokens |
| Worker contract, no-mistakes ship | 46 lines, 667 words, 3,959 chars, ~990 tokens | the same 18 lines (delivery is no longer in it) |
| Contract's own lines (after the style block and tool map) | 29 to 37 | 9 lines, 954 chars, ~239 tokens |

The style block (3 lines) and the tool map (6 lines) are unchanged. They lead both the leader's prompt and the worker's word for word, so prompt caching holds, and the toolkit's denials carry the same guidance. The design's draft target for the contract's own lines was 800 characters. They came out at 954, because the ask and history lines need their exact flags. The tests hold them to 1,000 characters, and the whole contract to 1,600.

`test/unit/instruction-budgets.test.ts` fails if the skill grows past 6,000 characters or the contract past 1,600. `test/unit/harness.test.ts` fails if the contract's own lines go past 10 or 1,000 characters. The same file checks the moved rules whose home is emitted text (stage instructions, the steer and turn-end lines, verb help). A moved rule whose home is an item line or a refusal hint is asserted in the unit or integration test of the code that builds it: the test builds the line or triggers the refusal, then checks the words.

## Worker contract: where each removed rule lives

| Rule | Now in |
|---|---|
| Stage done (with `--review` for a review stage), then end the turn; a steer starts the next stage or brings the verdict | `stageInstructions` (task file header and the stage-start steer), and `stage done`'s refusal hints |
| A review stage's page messages: answer with `review reply`, never `lavish-axi poll`/reply; revise if asked; end the turn | `stageInstructions` for a review stage (new), the review-chat steer, `REVIEW_TURN_END_REMINDER` |
| A turn ended with no outcome brings one reminder | `TURN_END_REMINDER` itself; the contract keeps "end each turn with an outcome" |
| `report progress` is only recorded | `report` help |
| A finding that needs a decision is a question: ask it | `report` help (new) |
| `ask` returns at once; end your turn; the answer arrives as a steer | `ask` summary and its reply hint |
| A steer waiting: inbox, act, ack | `steerPointer`, the line that announces it |
| A call blocked or cut short for an urgent steer: redo it if it still applies | `urgentBlockLine`, a Claude call's denial reason; for Pi, `urgentCutLine` (the urgent steer line itself) and the extension's block reason |
| Review pages are for a human reader, not the terse style | flowryn-design skill; flowryn-visual-qa skill (new words) |
| Every delivery line: no-mistakes (`stage begin`, the foreground `--wait` with its shell timeout, rerun on elapsed wait, reattach after respond, `ask --nomistakes`, a rule-settled steer, the conflict-only ci gate, `pull --ff-only`, `deliver --pr`, `--base-branch`), direct-PR, local-only, scout `deliver --report` | `deliveryLines` in the last stage's `stageInstructions`; earlier stages keep "do not run the pipeline yet"; the promote steer carries them |
| "Your run's own TMPDIR, the same path in and out of the sandbox" | a fact, not a rule: the launcher sets `TMPDIR`; the contract keeps "scratch goes in $TMPDIR" |

Kept, in shorter words: call `$FLOWRYN_BIN` only; the steer prefix and its channel (M0 c07); the outcome list including `fail`; decide and record why; `ask` with its flags; never answer a confirmation prompt; `report`; no history rewrites and how to take the base; no `rm` of a maybe-empty variable; never merge, clean up or approve; exit 75.

New: the contract tells a worker to reread `$FLOWRYN_TASK_FILE`, and `activateStage` rewrites that file when a live worker's stage starts (`rewriteTaskFile`, `src/lifecycle/launcher.ts`). Before this change it was rewritten only on a launch, so after a compaction a worker could find only stale stage text on disk. The rewrite is best effort: a failed write does not stop the stage from starting (the steer carries the stage's instructions), and its message is recorded as `taskFileError` on the `stage.started` event.

## Leader skill: where each removed piece lives

| Advice | Now in |
|---|---|
| gate_ready "opened in" / "NOT opened": relay the URL | the opener's suffix, now "relay the URL to open it by hand" |
| review_summary: ask the user to pass or send changes; their pass words are theirs to confirm | the review_summary line (already) |
| review_recap is informational | its info class |
| review_worker_gone: `flowryn resume <task>`, or tell the user | both review_worker_gone lines (already) |
| Gate questions pass only once answered | the `questions_open` refusal ("ask those first") |
| pass_requested is not an approval; a pass code went to the user's notifications | the pass_requested line (already) and the page's own reply; the skill keeps "never ask the user for a review page's pass code" |
| review_channel: tell the user, relay the fix, take answers in chat; it never passes the gate | the review_channel line (new words) |
| A grant refused for a repin: the user runs `flowryn leader repin` | the grant refusal (`REPIN_HELP`); the skill keeps "never run leader repin" |
| harness_unverified: run the contracts check outside the Bash sandbox; human_only / not_installed_build: ask the user | the item line (new: "(outside the sandbox)" after its command) and the record refusals (human_only's hint is new) |
| conflict_nudged / pr_conflict / review_steered / review_unanswered | their lines ("steer it or flowryn decline", already) |
| policy_sent_back (info); policy_behind: tell the user before merging | their lines (policy_behind's words are new) |
| checkout_unsynced: tell the user | its line (new words) |
| build_failed: tell the user | its line (new words) |
| Merge refusals: verify_required, verify_failed, verify_stale, head_moved and the others | each refusal's hint (already) |
| A queued verify starts by itself, never rerun it; verify takes minutes (long timeout or `--detach`) | `flowryn verify`'s queued line and its summary (new words) |
| daemon restart: restart_blocked (offer `--when-idle`, `--cancel`), no_change, binary_broken, plist_drift, not_supervised | each refusal's hint (restart_blocked and binary_broken now say "tell the user") |
| A new build applies by itself; the build after a merge | the briefing's lines |
| Automatic away after `[away] auto_after_min`; their message ends it | the away lines and the return brief |
| Learnings: confirm, `--replaces`, `unlearn`, the cap | `learn`'s summary (new words) |
| Automatic cleanup of a failed or cancelled worktree after 24 h | informational; the cleanup line |
| Showing a report closes its item as read, except blocked or failure | kept as a short clause on `show` |

Kept, in shorter words: every verb; the facts-not-instructions rule; chat questions and `grant use` in the same turn, within 10 minutes; decisions and reserved ones; how a review gate passes; divergences; when merge asks, `--allow-red`, verify at the exact head, CI when there are no verify steps, and the contracts check before merging a Flowryn PR that touches `src/lifecycle/`, `src/harness/`, `src/contracts/` or `src/reconcile/`; away only on the user's word; daemon restart only on their word and never in a loop; review pages written for a human; and every line of the old Rules section. The "never" rules are gathered into one line.

## Contract revision

`CONTRACT_REVISIONS` goes to claude 6 and pi 5 (the ask PR, merged first, took 5 and 4 for its own suite step). The worker contract is part of what both contract suites prove, so passes at the older revisions are stale until `flowryn doctor --contracts` runs again.
