# Sensitive PRs merge by themselves during an away you started

- Status: done
- Open: not yet run live (tests use the real daemon, CLI and fake forge with a stand-in `claude -p`; no model is reached); this home's config block below is applied by the leader after the merge (a worker cannot write `~/.flowryn/config.toml`)
- Config: `[merge] sensitive_when_away`

The user, 2026-11-08. Sensitive PRs waited for `flowryn approve` during overnight `/loop` runs; on 2026-11-07 the security-triage phase 1 and 2 PRs waited all night. Offered "batch them for one approve on return" or "merge them automatically", they chose: "Merge them automatically. I don't know what kind of sensitive prs I wouldn't want to merge".

The design was reviewed at gate g371 and passed. It had no open questions.

The validator's verdict is the only model use: whether a diff does what its brief asks takes judgement. The trigger, eligibility, the approval record, its live check, the stop when you come back, the merge and the brief are plain code. It reuses the trigger (`userStartedAway`) and the validator (src/attention/gate-validator.ts) of [unattended-loops-answer-4y](2026-11-08-unattended-loops-answer-4y.md). Neither is new.

## Turning it on

```toml
[merge]
sensitive_when_away = true   # default false
```

The key must be a boolean. Any other value or key in `[merge]` is `config_invalid`: the daemon will not start with it, and a SIGHUP reload is rejected.

This home turns it on, along with the overnight-answer and review-validator keys the earlier ship documents (`~/.flowryn/config.toml` has neither `[merge]` nor `[decisions]` today):

```toml
[merge]
sensitive_when_away = true   # the user, 2026-11-08: "Merge them automatically"

[decisions]
default_classes = ["ci-wait", "nomistakes"]   # answered on the worker's recommendation after default_after_h, only while you said you are away
default_after_h = 2
default_gates = ["design", "qa"]
validator_max_usd = 1
validator_rounds = 2
```

Why: the user asked for overnight runs to stop parking on questions (the earlier ship) and on sensitive merges (this one). Add the block, then `kill -HUP` the daemon or restart it.

The merge rounds use `[decisions] validator_max_usd` (each call's cap) and `validator_rounds` (rounds that did not pass, per task per away). They do not need `default_gates`.

## What happens (`src/attention/away-merge.ts`)

The pass runs on every attention tick, right after the review-gate validator.

1. **Stop first.** `stopAwayMerges` voids every unused `away-validator` approval that is no longer live (described below), and stops what it would have merged. A direct auto-merge not yet `merging` is superseded with reason `user_back`. A landing entry holding the approval leaves the line. A merge already asked of GitHub has used its approval and finishes.
2. **Pick.** Each ready sensitive ship is checked by `awayMergeRefusal` (pure; each check is tested alone). A round may start only when:
   - the key is on and an away you started is on;
   - the run is a ship, ready, not stacked, and not covered by unattended mode (that grant already merges sensitive work for its projects);
   - its project is yolo: the sensitive rule is the only thing between it and a merge;
   - the newest finished verify at exactly the delivered head, under today's policy, passed;
   - GitHub's last PR head and the worktree HEAD are both the delivered head;
   - nothing already approved this head;
   - no round is running for the task, and none ended `held` under this away;
   - fewer than `validator_rounds` rounds that did not pass and fewer than `MAX_INTEGRATIONS + 1` (4) passes under this away.

   Only a run that passes all of that costs a `git rev-parse HEAD`. In one transaction the pass records a `gate_validations` row `j<N>` with stage `merge`, no gate, the PR `ref` and the head.
3. **Call.** The validator's own call (`callValidator`), with `MERGE_VALIDATOR_CONTRACT`:
   - The prompt holds the dispatch brief, the approved build spec (`approvedSpec`) and the diff from the merge base to the head. Each is fenced as data.
   - There is no page, and `questions` must be `[]`: a reply that lists one is no verdict.
   - Same tools, cap, scrubbed environment, scratch cwd and deadline as review rounds.
   - Review and merge rounds share `[ask] max_concurrent`.
4. **Act.** `applyMergeValidation` re-reads every fact and asks `validatorAction`:
   - **No verdict** (malformed, timeout, cap, spawn error, a daemon stop): the round is `failed`, and a `validator_failed` item says "the PR waits for your approval".
   - **You came back, the away changed, the head moved during the call, or eligibility was lost:** `advised`, with a `validator_advice` item. Nothing merges.
   - **Changes:** the round ends `changes` and the ship goes back to its worker through `sendBack` (event `away_merge.sent_back`, by `validator j<N>`). The findings are numbered: "The independent validator (j<N>) checked this PR … asks for these changes". Its live auto-merge or landing entry ends.
   - **Pass:** the daemon records an approval:
     - channel `away-validator`, action `merge`, bound to the task, ref and exact head;
     - actor `validator j<N> (away since HH:MM, started by human|captain-chat)`;
     - it expires at the away's end, or at most 16 h out;
     - event `away_merge.approved`.

     On a direct project, the delivery's auto-verify gives way to a verify-backed auto-merge (`createAutoMerge`, merge = 1). On a landing-queue project, the queue takes the approval when it enqueues.
5. **The merge gate** (`chooseFor`, src/policy/merge.ts). It takes the approval only for the daemon's own merge, of sensitive work, with no waiver. It must be found by `findAwayApproval` at exactly `facts.head`, and `awayApprovalLive` (pure) must hold: an away you started is on, it is the away the round ran under, the round started after it began, passed, and judged this head. The landing queue's standing record gets the same check. Every other gate rule runs as before: canonical PR, not a draft, head on the remote, checks, and local verify at this head. `findHumanApproval` never returns this channel, so no human-only check ever accepts it.
6. **The landing queue.** Its merge of main moves the head, and a sensitive approval does not carry across that (the existing rule). The entry leaves with `approval_needed`, without a hold item, because the validator judges the new head by itself once the queue's verify of it passes. `retakeForAwayApproval` lets the queue take the head again once a newer approval binds it.

## Who counts as away

The away must be one you started: `by` is `human` (`flowryn away` in your terminal) or `captain-chat` (your answer to the Claude leader's binding chat question). An automatic away, a leader's own `away` and inactivity never count. Tests cover each.

Your return is `flowryn back`, the away's expiry, or a new away or extension that is not yours (a leader extending your away rewrites `by`). Any of these stops what has not merged yet, within a tick. The gate's live check covers the race.

## The return brief

"Decided for you" (and "since the last briefing") lists sensitive merges first, then rounds:

- `- [mg12] merged sensitive PR <url> of <task> after the validator passed it (report: flowryn show j7; undo: git revert <sha> in a new fix ship)`. The undo is `git revert -m 1 <sha>` for the `merge` method.
- `- [mg12] merge of sensitive PR <url> … asked of GitHub after the validator passed it, not yet proven …`
- `- [mg12] sensitive PR <url> of <task> did not merge (refused: …); it waits for you (report: flowryn show j7)`
- `- [j7] pre-merge check of sensitive <task> → passed by the validator (report: flowryn show j7; merged as mg12 | waiting on the merge checks | not merged: you came back, so it waits for flowryn approve | not merged: its head changed, so a later round judges the new head)`
- `→ sent back by the validator with N findings`, `→ no verdict, the PR waits for your approval: …`, `→ advice only, the PR waits for your approval: …`

No line says anything was un-merged. `flowryn show j<N>` prints a merge round with `stage: merge`, `gate: -` and its `pr`.

## Data

Migration 60 `away-merges`:

- rebuilds `gate_validations` with a nullable `gate_id` and a new `ref` column (a merge round's PR);
- rebuilds `approvals` with `away-validator` in its channel check.

New events, each appended in its write's transaction: `away_merge.approved`, `away_merge.sent_back` and `away_merge.stopped`, plus the existing `validator.*`, `approval.*` and `auto_merge.*` events.

## Security

- **Trigger:** only `userStartedAway`. A worker cannot call `away`. `captain-chat` is written only after `takeGrant` on a grant the leader's own hooks minted.
- **Minting:** only `applyMergeValidation` in the daemon writes `away-validator`. No verb does.
- **Binding:** task, ref and exact head, checked against the head the gate is about to merge, the same away and a passed round at that head. A push or the queue's merge of main voids it (`recordDelivery`, `carryLanding`).
- **Prompt injection:** the brief, spec and diff are worker-written and fenced. The reply only feeds the fixed schema. The most it can do is let this head merge, or send findings back to the same worker.
- **Read-only, no credentials:** the existing validator call.
- **Out of scope, unchanged:** discard approvals, which tasks are sensitive, non-yolo projects.

## Choices

- **Yolo projects only.** Elsewhere every task needs you, and a sensitive task must not merge more easily than ordinary work.
- **Unattended mode wins** for the runs it covers. Its standing grant already merges sensitive work.
- **After local verify, before GitHub's checks.** No spend on a head that verify rejects, and the merge gate still waits for checks. No `default_after_h` wait: the PR is done.
- **A user-started away does not end on your chat message.** That is the earlier ship's rule, and `/loop` wake-ups arrive as messages. "Your return" is `flowryn back`, expiry or replacement. This deviates from the task's "their own message", decided in the build: a message cannot be told apart from a `/loop` wake, so counting it would stop every overnight merge.
- **The landing queue re-judges the new head** instead of carrying the pass across its merge of main. The task binds the pass to the exact head that merges.
- **One `gate_validations` table**, with stage `merge` and a null gate, rather than a `kind` column the spec named. No review gate is called `merge`, so the stage is enough.
- **No hook in `endAway`.** The pass's stop runs every tick, and the gate's live check refuses a stale record in between. This avoids a module cycle through away.ts.
- **No suffix on the sensitive "waits for your approval" item.** The spec named one, but delivery does not read config. The item closes when the PR lands.
- **No `CONTRACT_REVISIONS` bump.** No worker step changed. The validator reuses the print call the suite already proves.

## Tests

- `test/unit/away-merge.test.ts`:
  - the key, with its refusals and startup problem;
  - every `awayMergeRefusal` check alone, and every `awayApprovalLive` case;
  - the merge prompt and contract;
  - against a real database: the trigger for each `by`; pass (record, live check, never a human record, the auto-merge started); a push after the pass; changes (sent back); no verdict (malformed, a listed question, timeout); head moved and user back as advice; the round limit;
  - `stopAwayMerges` voiding and keeping;
  - the brief's lines and the revert;
  - migration 60.
- `test/integration/away-merge.test.ts`, through the real daemon, CLI and fake forge:
  - you present: no merge, and the PR waits;
  - a human away: it merges on `away-validator` at the judged head, `show j1` works, and `back`'s brief lists it with its URL, report and undo;
  - a leader's own away: no round;
  - changes: the worker gets the findings and nothing merges;
  - the head moves during the call: advice only;
  - the forge refuses: not landed, and the brief says it waits for you;
  - a landing-queue project whose merge of main moves the head: two rounds, it lands at the second judged head, and nothing is held for the leader.
