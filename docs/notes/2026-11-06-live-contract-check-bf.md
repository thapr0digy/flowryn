# Live contract check: no early deliver, and evidence on a failed step

- Status: done

The live Claude contract suite (`doctor --contracts --verify-only --harness claude`) failed at random steps on 2026-11-06 (Claude 2.1.318 and 2.1.319): "deliver while idle" ("the worker delivered before m2"), "idle" (timed out waiting for liveness idle), now and then "interrupt". Each failure held every Flowryn merge.

## What the evidence showed

The task's first guess was that the turn-end guard pushed the worker on after each "reply ONE and end your turn", and the model then sometimes delivered. Live runs with `--keep` refuted it. The scratch home's `config.toml` has had `[workers] turn_end_guard = false` since #34 (`scratchConfig`, src/contracts/runner.ts), and a passing run and a failing run each recorded no `run.turn_end_reminder` event at all.

What happened instead, in the failing run's transcript: the worker read its task, acknowledged m1, ran the 25-second sleep, and then on its own wrote a report and ran `deliver --report` at the end of its first turn. Two instructions it is given disagree. The brief and each steer say "reply with the single word … and end your turn". The worker contract says "End each turn with an outcome (stage done, deliver, …)", and the scout task file's header says "This is the last stage. Finished: $FLOWRYN_BIN deliver --report". When the model follows the second, the run lands in its first turn. Then either liveness never reads idle (the "idle" step times out, as v153 did) or the next steer has no live run to reach ("deliver while idle" fails). Which instruction the model follows is the randomness. Before the fix, one run in two failed this way here (23:18 failed, 23:20 passed).

## The fix

- A steer the leader sends with `--end-turn` (the mechanism the turn-end guard already honours) now says so to the worker. `steerLine` appends `END_TURN_NOTE`, "Then end your turn: this steer asks for no outcome.", after the ack instruction, and the urgent variants and the inbox do the same. The worker contract's outcome line names it: "End each turn with an outcome (…), on your own background job, or as a steer says." So the two never contradict, for contract runs and for a real leader's `--end-turn` steers alike. The guard itself is unchanged and still reminds real workers.
- The contract suite sends every steer whose work ends the turn with no outcome with `--end-turn`. That is m1 (the first turn's end, which the brief asks for), m2, the urgent m4, the steer after the interrupt, and the toolkit and temp-dir steers. The steers that start a long command are not marked, since a later steer or the interrupt ends those turns, and neither is the deliver steer, whose turn ends with an outcome. No check looks at the project name. The brief is unchanged, so this does not conflict with a-claude-pi-y5's brief line.
- The guard stays off in contract runs (#34). With the note, the instructed turn ends would satisfy it, but turning it on would also change the resume and interrupt turns, which this task leaves alone.
- `CONTRACT_REVISIONS`: claude 7 → 8, pi 6 → 7. Both harnesses' steer lines and steps changed.

## Evidence on a failed step

When a step fails, the runner reads the scratch run before cleanup removes it (src/contracts/evidence.ts). It keeps:

- the run row, without `token_hash` and `workflow_def`
- the run's events (the last 1,000)
- its steers
- the worker transcript's last 80 lines, each cut at 4,000 characters
- the pane's last 60 lines through Herdr `pane.read`

Each part that cannot be read says why rather than failing the run. Every string is redacted the way `flowryn diag export` redacts every string (`scrubTokens`: URL credentials and token-looking runs), plus `redactSecrets`, the screen redaction. Free text is kept: a contract run's steers and replies are the suite's own fixed words, and they are the evidence. The report writer (`dataDirReport`) saves it as `<report>.evidence.json` at mode 0600 beside the report in `<data_dir>/contracts/`, and names it in the report's `evidence` key and in doctor's failed check ("…; evidence <path>").

## Tests

- `test/helpers/fake-contract-claude.ts` now behaves like the live model. When it was told to end a turn and no steer of that turn carried the note, it delivers a report. With the suite's old, unmarked steers the offline Claude suite fails, at "idle", the v153 shape. With the fix it passes.
- With `FAKE_CONTRACT_IGNORE_END_TURN_NOTE=1` the fake delivers past the note too. `contracts-offline.test.ts` uses that to fail a step on purpose, then checks the evidence file: its mode is 0600, the report names it, and it holds the `run.delivered` event, the end-turn steer, the transcript tail and the pane.
- `test/unit/contract-evidence.test.ts` covers the redaction, the transcript tail and its cut, the file mode, the steer line with the note, and the worker contract's outcome rule naming it.

## Live results (2026-11-06, Claude 2.1.319, Pi 0.87.1)

After the fix, the Claude suite passed five times in a row (23:33, 23:35, 23:37, 23:39, 23:41), and a sixth run on the final worker-contract wording passed at 00:13 on 2026-11-07 (report `claude-2.1.319-2026-11-07T00-13-54-569Z-verify-only.json`), so six in a row. The Pi gate passed.
