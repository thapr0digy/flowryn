# Settle routine no-mistakes ask-user findings by rule

- Status: not built
- Open: design under review; build and ship stages not started
- Config: `[decisions] nomistakes_rules`

Scout finding 1 (scout-efficiency-and-fz): 46 of 79 decisions came from no-mistakes; 21 reached the user (68.5 h of waiting), answered mostly `fix` or `approve`. The user's ruling (2026-10-22): a fixed rule answers `fix` for lint warnings in files the branch added and for review warnings inside the branch's own diff; everything else (CI gates, history rewrites, files outside the diff, errors) is reserved for the user.

## Design

Plain code, no model: a table lookup over fields no-mistakes itself prints.

1. The worker asks as today, with one new flag: `$FLOWRYN_BIN ask --nomistakes --options approve,fix,skip --blocks … --body-file -`.
2. The ask's `prepare` (async, before the transaction) reads the facts itself, never from the worker's text:
   - `no-mistakes axi status` in the run's worktree (`readNmStatus`, `parseNmStatus`), which must be the worktree's own parked run (`ownParkedRun`): the gate step and the findings table `{id,severity,file,line,action,description}`;
   - the branch's diff against `origin/<default branch>` at the run's `head_sha`: `git diff --name-status <base> <head>` and, for findings with a line, `git diff -U0 <base> <head> -- <file>` hunk ranges.
3. Each `ask-user` finding gets a file class:

   | class | meaning |
   |---|---|
   | `added` | the branch added the file |
   | `diff-line` | the finding's line is on a line the branch added or changed |
   | `touched` | the file is in the diff, but the line is not (or the finding has no line) |
   | `outside` | the file is not in the branch's diff |
   | `none` | the finding names no file |

4. The table (`[decisions] nomistakes_rules`, first match wins; these two are the default when the key is absent, `[]` turns rules off):

   ```toml
   [decisions]
   nomistakes_rules = [
     { id = "lint-warning-added", step = "lint", severity = "warning", file = ["added"], answer = "fix" },
     { id = "review-warning-diff", step = "review", severity = "warning", file = ["added", "diff-line"], answer = "fix" },
   ]
   ```

5. All or nothing: the ask is settled only when every `ask-user` finding of the gate matches a rule and the answer is one of the worker's `--options`. Then `apply` inserts the decision and answers it in the same transaction through `answerDecision` with `answered_by = 'policy'`, `answered_via = 'rule:<id>[,<id>]'` and a rationale naming each finding and its class. The worker gets the answer as a steer (the usual path): `fix findings lint-1, lint-2 (no-mistakes axi respond --action fix --findings lint-1,lint-2)`. No worker-question item opens, so nothing pings the leader.
6. Otherwise the decision opens as today but reserved for the user, with reason `nomistakes: <why>` (`ci gate`, `error finding`, `file outside the diff`, `status unreadable`, …).

Floors the config cannot lift (validation refuses such a rule): step `ci`; severity `error`; file class `outside` or `none`; a finding whose text matches the irreversible, destructive, credential or security patterns of `reservedReason`; a sensitive task.

## Undo

The briefing gets a section "Settled by rule since the last briefing" listing each policy answer with its rule and `flowryn decide <id> <choice> --by captain`. `decide` accepts an already-answered decision only when `answered_by = 'policy'`, only through the captain channel, and only while its run is live. It records `decision.overridden` and steers the worker: the user's choice, and to revert any fix commits the rule caused with `git revert` (new commits, never a rewrite) before responding to the gate.

## What changes

- `src/attention/decisions-policy.ts`: `nomistakes_rules` parsing and validation, the floors.
- `src/policy/nomistakes-rules.ts` (new): file classes and the rule match, pure functions.
- `src/lifecycle/worker.ts`: `ask --nomistakes`, its `prepare`, settle-by-rule in `apply`; `replyMs` raised so the status read never spools the ask.
- `src/lifecycle/decision-verbs.ts`: `answerDecision` takes `by: "policy"`; `decide` overrides a policy answer.
- `src/attention/briefing.ts`: the settled-by-rule section; `src/attention/stats.ts`: policy answers counted apart.
- `src/harness/contract-text.ts`: the ask-user line names `--nomistakes`. The offline contract suite drives no no-mistakes gate, so `CONTRACT_REVISIONS` does not change (checked again in build).
- No migration: `answered_by` is plain TEXT and the rule id lives in `answered_via`.

## Choices made in design

- Settled in the daemon at ask time, not by the leader calling `decide --by policy`: zero waiting, and no CLI flag through which the leader could claim a rule.
- Facts from no-mistakes' status and git, not the worker's text: the worker cannot widen a rule by how it words the question.
- Unmatched no-mistakes asks are reserved for the user, per the ruling; the leader no longer answers them (it answered 25 so far).
- Explicit `--nomistakes` flag rather than guessing from text: an unrelated question asked while a gate is parked is never auto-answered.
