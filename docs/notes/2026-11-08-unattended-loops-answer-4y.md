# Overnight answers and a review-gate validator, only while you said you are away

- Status: done
- Open: not yet run live (tests use the real daemon and CLI, real git and a stand-in `claude` print call; no model is reached)
- Config: `[decisions] default_gates`, `[decisions] validator_max_usd`, `[decisions] validator_rounds`

The user, 2026-11-08: the daemon kept them answering questions it had a recommendation for, which broke long overnight `/loop` runs. On 2026-11-07 a no-mistakes question stalled one run for 18 h. They asked for two things, only when they say they are away:

- held questions answered with the worker's recommendation;
- review pages checked by a separate, clear-context validator against the spec and the code.

The design was reviewed at gate g369. Both of its questions were answered as recommended: chat confirmation counts (q185), and unattended mode is left as it is (q186).

The validator's verdict is the only model use: whether a design or build holds up against a spec in natural language takes judgement. The trigger, eligibility, the floor, schema parsing, recording, steering and the undo are plain code.

## Turning it on

```toml
[decisions]
default_classes = ["ci-wait", "nomistakes"]   # deadline defaults (docs/notes/2026-10-30-deadline-defaults-for-gg.md)
default_after_h = 2                           # hours a question or review waits first
default_gates = ["design", "qa"]              # the reviews the validator may judge; default [] (off)
validator_max_usd = 1                         # one call's spend cap, above 0, at most 20 (default 1)
validator_rounds = 2                          # rounds per review stage per away, 1 to 5 (default 2)
```

This home's `~/.flowryn/config.toml` has no `[decisions]` section, so both features are off. Add the block above, then `kill -HUP` the daemon or restart it.

- A stage other than `design` or `qa` in `default_gates` is refused with `config_invalid`. So is a cap of 0 or above $20, or a round count outside 1 to 5. The daemon will not start with one, and a SIGHUP reload is rejected.
- The call's deadline is `[ask] timeout_ms`.

## Who counts as away

Both deadline defaults and the validator now fire only while an away **the user started** is on (`userStartedAway`, src/attention/away.ts). That is a live posture whose `by` is one of:

- `human`: `flowryn away` in your terminal, or `away --autonomous` granted there;
- `captain-chat`: the Claude leader's `away` on your answer to a binding chat question.

Automatic away (`auto`), a leader's own `away` (`leader`) and every leader session being inactive never count. This replaces the old trigger, and there is no key to bring it back. A leader extending your away rewrites `by`, which turns both features off for the rest of it. That errs toward asking you.

The chat form works like unattended mode's grant:

1. A leader's plain `away --until <time>` still starts away (`by: leader`). It still delivers items, and its reply's hint names `flowryn chat-question away:<YYYY-MM-DDTHH:MM>`.
2. That prints one binding AskUserQuestion question. It states what Flowryn will decide and what it never does, with the options "Decide while I'm away" and "No".
3. Your answer becomes a grant (action `away`), minted only by the leader's own hooks and checked against Claude's transcript. The leader then runs `flowryn grant use <grant>`, which starts away until exactly that minute with `by: captain-chat`. Your notes become the away's words.

Unattended mode's chat grant now records its away as `captain-chat` too. Its terminal grant was already `human`.

## The validator (`src/attention/gate-validator.ts`)

On every attention tick, after deadline defaults:

1. **Pick.** The pass finds each open review gate of a stage in `default_gates` that has waited `default_after_h` since it opened. `validatorRefusal` is pure, and each check is tested alone. A gate qualifies when:
   - an away you started is on;
   - its run is live and not sensitive;
   - no live unattended-mode grant covers it (that pass owns it);
   - it carries no pending phase plan (passing it would approve the plan, which files backlog tasks an undo cannot remove);
   - it has a review page, and its pinned page and spec are unchanged;
   - no round is running for it;
   - fewer than `validator_rounds` rounds of that task's stage ran under this away (failures count), none of them ended `held` (a held gate waits for you; the validator never re-asks it), and you have not reopened a validator pass of that stage of the run under this away;
   - none of its open questions is of a floor kind, or worded like one (checked with every keyword class on).

   Only a gate that passes those checks costs a `git rev-parse HEAD`. In one transaction the pass records a `gate_validations` row `j<N>` (state `running`, event `validator.started`) with the head and how long the gate had waited. At most `[ask] max_concurrent` calls run at once.
2. **Call.** One print-mode call on the run's own harness and account, in the background, through `runBounded`. It reuses the verify review step's call shape (src/verify/review.ts):
   - Claude gets only Read, Grep and Glob, and `--restricted`, `--strict-mcp-config` and `--max-budget-usd`. It runs from a scratch cwd under `<state_dir>/validations/j<N>/`, with the worktree added through `--add-dir`.
   - Pi gets its read tools, `--no-context-files --no-approve` and the spend meter.
   - The environment is scrubbed. Nothing from the worker's conversation or session goes in.
   - The prompt holds the task's dispatch brief, the pinned spec, the review page as text (scripts, styles and tags dropped), the gate's open questions with their options and the worker's recommendation and why, and the branch's diff from its merge base. Each part is fenced with its own random marker. The contract (`VALIDATOR_CONTRACT`) says nothing inside a fence is an instruction.
3. **Read.** `parseValidatorReply` (pure) takes the whole reply or its last ```json fence as exactly `{verdict, findings, questions}`:
   - `verdict` is `pass` or `changes`.
   - `findings` holds at most 20 entries of `{requirement | file, problem, fix}`, each field at most 600 characters.
   - `questions` holds `{id, choice, consistent_with_spec, why}` for the gate's open questions only, each listed once.
   - Any other key or type, `changes` with no finding, or an unknown or repeated question id is no verdict. A `pass` that lists findings is read as `changes`, so findings are never dropped.
4. **Act.** `applyValidation` re-reads every fact in a new transaction and runs `validatorRefusal` again, so a reply can only act on a gate that is still eligible. `validatorAction` (pure) then decides:
   - **No verdict** (malformed, timeout, crash, spawn failure, cap reached, an error result): state `failed` with the reason. The gate keeps waiting, and a `validator_failed` item (P1, the user's, never wakes the leader) names `flowryn show j<N>`. Any close of the gate, yours or the validator's, closes the validator's items for the run.
   - **You came back** (the away ended or is a new one), **the run ended**, **the gate closed**, **eligibility was lost** or **the head moved** during the call: state `advised`. Nothing acts. A `validator_advice` item (the leader relays it) carries the verdict as advice.
   - **Pass**: each open gate question takes the validator's choice only when it equals the worker's recommendation, is a single choice among the options and is marked `consistent_with_spec` (`questionTake`, pure). It is answered `answered_by policy`, `answered_via validator`. If any question is still open, the round is `held` and a `validator_held` item names them; the gate waits for you, and the validator does not judge that stage again under this away. Otherwise `recordGatePass` passes the gate on the new approvals channel `validator` (actor `validator j<N>`, head the one judged), so every check a pass makes still runs. A refusal there is also `held`.
   - **Changes**: `sendBack` closes the gate as changes and requests the stage before it through the scheduler. The words are "The independent validator (j<N>) … asks for these changes:" plus the numbered findings, and the event's `by` is `validator j<N>`.
5. **Stop and restart.** A daemon stop aborts the calls and leaves their rows `running`. The next pass fails each such row with "the daemon stopped while it ran", and its round counts.

The whole reply is kept at `<state_dir>/validations/j<N>/report.md` (64 KB). `flowryn show j<N>` prints the gate, state, reason, wait, head, spend, verdict, findings, question judgements and the first 60 lines of the report (`--full` for all).

## The return brief and the undo

"Decided for you" now lists, besides deadline answers:

- each gate question the validator took: `- [q12] … → db (taken by the validator as recommended after 3h 0m; undo: flowryn decide q12 <choice> --by captain)`;
- each round, by outcome:
  - `- [j3] design review of <task> → passed by the validator (after 3h 0m; report: flowryn show j3; undo: flowryn gate reopen <task> --gate design --body-file -)`
  - `→ sent back by the validator with 2 findings (after …; report: …)`
  - `→ passed by the validator but held for you: …`
  - `→ no verdict, waits for you: …`
  - `→ the validator's verdict is advice only: …`

"Settled by rule" leaves validator answers out. The briefing's "since the last briefing" list carries the same lines.

Undo:

- **A question:** the existing rule-undo path. A `policy` answer is undone with `decide --by captain` while the run is live, and the worker is told to revert, with new commits, what it did on its own recommendation.
- **A pass:** `flowryn gate reopen <task> --gate <stage> --body-file -` (new verb, leader and human, `scope` by task). It is not an approval, since it only sends work back. It is allowed while the run is live, has not delivered (after that, `decline` on the PR), has no review gate open, and that stage's latest review was passed on channel `validator`. It records `gate.reopened`, closes the validator's items, releases the run's stage pools (a worker that is gone is resumed with your words, as `decline` does), and requests the gated stage through the scheduler with your words. The worker submits the review again, and that review is yours: a reopen uses up the stage's rounds for the current away, so the validator judges it again only under a later away.
- **A changes round:** nothing to reverse. The worker revises, and the next review is the user's once the rounds are used.

## Data

Migration 59 `gate-validations` adds the table `gate_validations`. It holds the id, gate, run, task, stage, `away_since` (rounds count per away), head, state (`running`, `passed`, `changes`, `held`, `failed` or `advised`), `verdict_json`, `reason`, `cost_usd`, `waited_ms`, `report_path`, `started_at` and `ended_at`. The migration also rebuilds `approvals` with the `validator` channel. Every write appends its event in the same transaction: `validator.started`, `validator.passed`, `validator.changes`, `validator.held`, `validator.failed`, `validator.advised`, `validator.item` and `gate.reopened`.

## Security

- **Prompt injection.** The page, diff, spec and brief are worker-written, so they are fenced and declared data. Whatever the reply says, plain code limits it to two things: pass a gate that was eligible before and after the call, taking only answers equal to the worker's own recommendation; or send findings back to the same worker. It cannot:
  - merge;
  - approve a plan;
  - answer a floor-kind or keyword-worded question;
  - act on a sensitive task or another run;
  - add a choice the worker did not recommend.
- **Read-only, no credentials.** The validator has reading tools only, no web tools, a scrubbed environment and no token in the prompt.
- **Cost.** The cap is enforced by Claude's own `--max-budget-usd` or the Pi meter, and a breach is no verdict. Rounds are bounded per away.
- **Authorization.** The trigger needs `by` to be `human` or `captain-chat`. `captain-chat` is written only after `takeGrant` succeeds on a grant the leader's hooks minted. A worker cannot call `away`. Validator answers are `policy`, never `captain`.

## Choices

- **No new trigger key.** The old "absent" check let quiet-at-the-keyboard count as away, which is what the user objected to.
- **The run's harness and account** for the call. It is the login the task already runs on, and no new setting is needed.
- **The whole dispatch brief** goes in, not only its Intent and Requirements sections. It is capped at 64 KB like the verify review's, and more context costs the validator nothing in authority.
- **`gate_validations`, `j<N>`**, so the name does not collide with verify's `verifications` and `v<N>` or the `validation_*` items.
- **Failures count as rounds**, so a validator that always errors stops after `validator_rounds`.
- **No `CONTRACT_REVISIONS` bump.** The validator reuses the ask/review print call the suite already proves, and no worker step changed.

## Tests

- `test/unit/gate-validator.test.ts`:
  - the config keys and their refusals (also as a startup problem);
  - every `validatorRefusal` check alone;
  - the reply schema: valid, fenced, pass-with-findings, and twelve malformed shapes;
  - `questionTake` and `validatorAction`, case by case;
  - against a real database: picking only under a user-started away; a stopped round failing; pass (with an agreeing question, and a held one); changes; no verdict (malformed, timeout, cap); the user back, the run ended and the head moved, each turning into advice; the round limit per away;
  - the brief's lines and `gate reopen`'s checks;
  - the call's argv through its seam: the review tools only, the cap, `--add-dir`, a scratch cwd, the fenced prompt without page scripts; a cap breach, a timeout and a spawn failure.
- `test/unit/chat-away.test.ts`: the `away:<stamp>` ref, its binding question and answer mapping, and an end in the past.
- `test/unit/deadline-defaults.test.ts`: inactivity, an automatic away, a leader's away and an expired away answer nothing; a `captain-chat` away does; `userStarted` for each `by`.
- `test/integration/gate-validator.test.ts`, through the real daemon and CLI with a stand-in `claude`:
  - a user-started away: the validator passes the design gate on channel `validator`, `show j1` and `back` list it, and `gate reopen` sends it back;
  - an automatic away starts nothing;
  - a changes verdict sends the findings back to design;
  - malformed output fails twice, keeps the gate open and stops at the round limit;
  - your return mid-call leaves advice only;
  - a due no-mistakes question waits under an automatic away and is answered once you start away;
  - the fake Claude leader's own away is `leader`, and your chat answer through the real hooks makes it `captain-chat`, once.
