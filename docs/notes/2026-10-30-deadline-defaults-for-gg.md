# Deadline defaults for reserved decisions while the user is away

- Status: done
- Open: not yet run live (tests use the real daemon, the stand-in no-mistakes and real git)
- Config: `[decisions] default_after_h`, `[decisions] default_classes`

Research report recommendation 6 (section 2.4, `research-improving-flowr-6e`), accepted by the user on 2026-10-30. Questions reserved for the user waited 4.5 h on average when answered in chat, and the user took the recommendation nine times in ten. This lets a reserved question of an opted-in kind be answered as recommended once it has waited long enough and the user is away. Plain code: a rule table and the daemon's attention tick; no model.

## Configuration

```toml
[decisions]
default_after_h = 4              # hours, above 0, at most 168 (default 4)
default_classes = ["ci-wait"]    # opt-in kinds; default [] (off)
```

`default_classes` takes only these kinds:

- `ci-wait`: the CI-wait watchdog's question (src/lifecycle/ci-wait.ts). Its recommendation is `merge-main` or `keep-waiting`. A deadline answer never takes `keep-waiting` (because it changes nothing) or `accept-without-ci` (skipping CI is the user's call).
- `nomistakes`: an `ask --nomistakes` that no `[decisions] nomistakes_rules` rule settled, for a reason a rule could have covered: no rule matched, the rules disagreed, or the rule's answer is not one of the options. The worker's own `--recommend` is taken.

The floor is in code (`DEADLINE_FLOOR`, src/attention/decisions-policy.ts). All six keyword classes (`merge`, `destructive`, `irreversible`, `security`, `credential`, `outward`) are refused in `default_classes` with `config_invalid`. The daemon will not start with them, and a SIGHUP reload is rejected. The brief named four classes. Irreversible and outward are just as risky, and nothing eligible needs them.

## How it works

1. **The kind is recorded when a question opens** (`decisions.reserved_class`, migration 48 `reserved-class`). It is never derived from the wording, so a worker cannot word its way in. Older rows are NULL and never qualify.
   - The CI-wait watchdog writes `ci-wait`.
   - `ask` writes the keyword class when the reserved reason is one.
   - A `--nomistakes` ask writes:
     - `nomistakes` when the facts read and no floor applied;
     - `nomistakes-floor` when a floor applied: sensitive task, `ci` step, `error` severity, a file outside the diff or none, irreversible text, or no ask-user finding (`RuleVerdict.floored`);
     - `nomistakes-unread` when the facts did not read.
   - A worker's own `--reserved` reason writes none.
   - Standalone decisions (`decision add`) get none: they are never eligible.
2. **The pass**: on every attention tick (1 s), after automatic away, `deadlineDefaults` (src/attention/deadline-defaults.ts) runs. It returns at once while `default_classes` is empty or the user is present. Absent means one of two things:
   - `flowryn away` is on (set by the user, or automatic);
   - every open leader session has `user_inactive_since` set.
3. **Eligibility**: `deadlineRefusal` is pure, and each check is tested alone. A question qualifies when it:
   - is open and reserved;
   - is run-scoped (a standalone decision's answer marks its task done, and the undo path cannot reverse that);
   - is not a review-gate question and not deferred;
   - is of an opted-in kind that is not on the floor;
   - has a recommendation that is one of its options and not a refused answer;
   - has waited `default_after_h` since it opened;
   - belongs to a run that is live and not sensitive;
   - has wording that matches none of the keyword patterns. This is checked with every class on, whatever `reserved_classes` narrows.
4. **The answer**: `answerDecision` with `answered_by = policy`, `answered_via = deadline`, and words saying how long it waited. The worker gets the usual answer steer; a CI-wait answer carries out `ciWaitSteer`, which credits the choice to the deadline default, not the user. A `decision.deadline_default` event records the kind, the choice and `waited_ms`. The daemon then notifies the run's bus and kicks the journal, the scheduler and attention.
5. **The brief**: the return brief's "Decided for you" lists each deadline answer as `- [q130] … → merge-main (deadline after 4h 12m; undo: flowryn decide q130 <choice> --by captain)`. Once the run is over, the undo part reads "run over, no undo". So does the regular briefing's "Decided for you since the last briefing". "Settled by rule" leaves deadline answers out, so nothing is listed twice. `flowryn show <id>` shows the `class`.
6. **Undo**: a deadline answer is a policy answer, so `decide <id> <choice> --by captain` takes the existing rule-undo path (`overrideRuleAnswer`) while the run is live. For a CI-wait question, the new steer carries out the new choice's instruction (`ciWaitSteer`; keep-waiting tells the worker to leave the pipeline as it now stands). For any other question it names the deadline answer and asks for a `git revert` of what was committed for it.

The away-mode comment in src/attention/away.ts used to say no decision rule reads away. It now names this rule as the one exception.

## Choices

- **Clock from opening, checked while absent.** This follows the brief's wording and is the simplest to test. A question that waited four hours while the user was active can be answered soon after the user steps away. Counting only time away is a possible later refinement.
- **No leader wake per answer.** The worker is steered directly, and the brief carries the answer to the user.
- **No contract revision bump.** `ask` only records an extra column; nothing the contract suite proves changes.
- **`decision list` unchanged.** The kind shows in `flowryn show`, so list output stays stable.

## Tests

- `test/unit/deadline-defaults.test.ts`:
  - the config defaults, each floor class refused, unknown kinds and bad hours, and a floor class as a startup problem;
  - every eligibility check failing alone;
  - the pass with the user present, with the user away, and with leader sessions inactive or active;
  - the return brief and the briefing lines, before and after the run ends;
  - undo of a CI-wait and of a no-mistakes deadline answer.
- `test/integration/deadline-defaults.test.ts`, through the real daemon and CLI:
  - `ask --nomistakes` records each kind;
  - a backdated question stays open while the user is present;
  - after `away` it is answered via deadline and steered, and the floored one waits;
  - `back` prints it under "Decided for you", and the user's `decide --by captain` undoes it with a new steer.
