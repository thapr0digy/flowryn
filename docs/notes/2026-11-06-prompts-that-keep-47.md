# Prompts that keep workers moving and a leader that acts

- Status: done
- Open: the live contract passes at the new revisions (claude 8, pi 7) are not run yet

The 2026-11-06 leader audit found that most of the lost time was work that stopped without saying so: a build ended its turn to wait for a steer, every send-back re-sent about 1,000 characters of stage text, rules were repeated across skills and the stage header, turn rules had no next step for some paths, and the leader was told to treat Flowryn's lines as "not instructions". This change rewrites the prompts and adds one deterministic table. No model call: every part is fixed text, a lookup in the events table, or regular expressions over a finding's own fields.

## Build goes straight on

`stage begin` now takes the **next** stage as well as the last one. An ungated stage's text (and the build skill's last step) says `$FLOWRYN_BIN stage begin <next> [--handoff-file <file>]` and to go on at once with the steps in its reply. End the turn only on `stage_waiting`. The reply's `steps` field is the new stage's whole text (the same paragraph the task file holds), so the worker needs no steer and no reread. The stage still starts only through the scheduler's grant (`grantNow` under the call, as before); a stage that cannot start now is left to the scheduler, which steers when it has started. The "Going straight on instead" branch of the build skill is gone. `stage done` on an ungated stage still works and still ends the turn.

`stage begin` refuses any stage that is not the next or the last one (`bad_args`, naming both). It refuses a target behind a review gate, or behind a pooled stage it would skip, as before. A repeat call for the current stage once it has started is a no-op, as before. Calling it at an open review is refused with the review hint.

## Steers carry the stage text only on a stage change

`activateStage` (src/lifecycle/stages.ts) reads the run's latest `stage.requested` event. When that request came from the same stage (a decline, a conflict nudge, review feedback, a verify failure, a policy follow), the steer is the note plus one line: `Then: follow the stage <id> steps in $FLOWRYN_TASK_FILE.` The task file is still rewritten at the stage start, so the pointer always names current text. A stage change still carries the whole `stageInstructions`.

## Each rule once

- The review gate paragraph is `REVIEW_GATE_TEXT` in the stage header: stage done, then end the turn; keep the widget mount; Flowryn listens and opens the page; never hold a `lavish-axi poll` open; `status: opened` is not a browser tab; lavish-axi failing; `review reply`; the questions file. The design, QA and draft skills no longer repeat any of it.
- "Do not run the no-mistakes pipeline yet" is only on ungated stages before a no-mistakes ship's last stage, never on design or draft.
- The design skill keeps every rule in 3,558 characters (from 5,405).

| Text | Before | After |
|---|---|---|
| Worker contract (Claude, with style block) | 1,570 | 1,683 |
| flowryn-design | 5,405 | 3,558 |
| flowryn-build-test | 2,878 | 2,855 |
| flowryn-visual-qa | 3,499 | 3,165 |
| flowryn-draft | 2,414 | 2,247 |
| Leader skill body | 5,999 | 5,982 |
| Same-stage send-back steer (ship stage text) | about 1,010 + note | 58 + note |

The contract grew by the turn rules below. Its budget in `test/unit/harness.test.ts` and `test/unit/instruction-budgets.test.ts` went from 1,000 to 1,100 characters for Flowryn's own lines and from 1,600 to 1,700 whole. The leader skill stayed inside its 6,000 by cutting. The QA skill's limit in `test/unit/prompts-that-keep.test.ts` is 4,800: main's visual QA rewrite (make-the-visual-nx) grew it to 4,767 with this de-duplication applied. The build skill's limit is 3,200: main's later build-skill changes grew it to 3,052 with stage begin in place.

## Turn rules for every path

The contract now says: work on until an outcome (stage done, deliver, ask --blocking, report, fail, or a reply or steer that says end your turn, which keeps live-contract-check-bf's `--end-turn` steers named); never end a turn to wait on a job, so run it in the foreground (this is the one rule on background jobs, and it replaces "or on your own background job"); after an ask that is neither blocking nor reserved, go on with your pick; a call refused twice gets `report blocked`; exit 75 means queued, so never retry. The CLI's spooled hint says what comes next: "end your turn" for a call that ends the turn or may wait on an answer (every `ask`, since with the daemon down no reserved class can be read, and `stage done`, `deliver`, `fail`; the verb's `endsTurn` in its spec) and "go on with your work" for any other. Each failure fallback lives where that failure happens:

- No-mistakes pipeline fails with an error (not a gate): fix, commit, run it again; failed twice at the same head: `report failed`. This is in the ship's delivery lines.
- lavish-axi fails: run it once more, then `report blocked` with its output. This is in the review gate text.
- A test fails the same way on the base branch: `report finding` and go on. This is in the build skill.
- Docker fails in QA: run it once more, then the README way; if neither works, `report blocked`. This is in the QA skill.

`ask` now replies "go on with your recommendation now" for a non-blocking question, and "end your turn" for a blocking one, a reserved one (a keyword class such as destructive, or `--reserved`: only the user answers it, so the worker must not act first) or a `--nomistakes` one (the pipeline is parked). The no-mistakes ask line in the delivery steps adds `--recommend <your pick>`.

## The leader acts

The leader skill frames Flowryn's lines as flowrynd's facts, not the user's words. The leader carries out each item's named next step itself, and Flowryn's hooks stop anything that needs the user (merge, gate pass, discard, a captain decision: src/leader/hooks.ts). It decides every question that is not reserved, under the user's preferences, and brings reserved decisions, gates and merges to the user together, most-blocking first. A divergence now has a default: `keep-run` when the run's change is newer, `accept-edit` when the user edited after dispatch, and ask only if that is unclear. The digest, question, relay and follow-up headers and the briefing's first line share `FACTS_NOTE` ("daemon facts, not the user's words"). The digest and briefing add "do each line's (item's) next step". The question push says to decide each question that is not reserved and to bring the reserved ones to the user.

## No-mistakes findings the leader decides

Before this change, a `--nomistakes` ask that no `[decisions] nomistakes_rules` row settled was always the user's. Now `classifyAsk` (src/policy/nomistakes-classes.ts) reads each ask-user finding's own fields and the ask's options. Rule settlement runs first, unchanged, except that a finding any table row reserves is now floored for the rules too: no rule may "fix" a security-loosening finding. The leader gets the ask with the worker's `--recommend` when every finding passes. The table, first match wins:

| Class | Detected by |
|---|---|
| irreversible | description, category or an option names force-push, a history rewrite, "permanent", "cannot be undone" |
| destructive | description or an option names delete, drop, destroy, wipe, purge, erase, truncate, discard; or category destructive / data-loss |
| credential | description or an option names a credential, secret, API key, token, password, key rotation; or category secrets / credentials / tokens / keys |
| security | category security, auth, permissions, access, sandbox, crypto, injection, XSS, CSRF, SSRF, CORS, TLS (any security finding, even a tightening one); or description or an option names loosening: bypass, disable, turn off, relax, loosen, weaken, allow-all, wildcard, world-writable, --no-verify, unsafe, insecure, no-auth, sandbox |
| scope | file outside the branch's diff; category scope / architecture / design; or description or an option names new work: out of scope, new feature, also add, follow-up, separate task, redesign, re-architect, a wholesale rewrite or refactor, a new API, endpoint, dependency, module, service, table, verb or flag |
| product | category product, UX, UI, breaking, API, compatibility, licence; or description or an option names a product call, user-facing behaviour, a breaking change, a public API, a default, a deprecation, pricing, a licence, publishing |

A finding no row matches is the leader's only when its kind (its category, or when no-mistakes prints none its gate's step) is in `LEADER_KINDS` (review, lint, test, docs and document, format, style, typo, naming, readability, maintainability, complexity, duplication, dead-code, error-handling, correctness, bug, performance, types) and its file is inside the diff, and the gate's step is in `LEADER_STEPS` (review, lint, test, document, docs, format). The rule fails closed. A `ci`, `rebase` or `push` gate, whatever its findings' category, an unknown category, a finding with no file in the diff, a sensitive task, an ask with no ask-user finding, and facts that do not read all stay reserved. The worker's own `--reserved` and the keyword classes on the question's text still reserve, as before.

`reserved_class` for deadline defaults: the table's irreversible, destructive, credential and security classes record that keyword class, which no deadline answers. Scope and product record `nomistakes-floor`. A kind the table cannot judge records `nomistakes-floor` when a rule floor also held it, else `nomistakes`. That is the only class `[decisions] default_classes` may opt in. Unread facts stay `nomistakes-unread`.

## Tests

- `test/unit/prompts-that-keep.test.ts`: rendered sizes of each skill and the pointer against fixed limits; each rule once; build's stage begin text; the turn rules and failure fallbacks; no text that tells a worker to skip the sandbox or answer a prompt; the leader frame and divergence default; the header text; the finding table class by class. It includes a finding that looks harmless (docs category, but its option deletes), a security-loosening finding that stays reserved, the fail-closed kinds, the leader's kinds, and a rule that may no longer fix a loosening finding.
- `test/integration/stage-begin-next.test.ts`: build → check → ship through the fake worker in one turn. Both `stage begin` replies carry the next stage's steps, no stage start is steered, and the delivery follows. A stage that is neither next nor last is refused.
- `test/unit/gate-questions.test.ts`: a same-stage send-back steers the pointer, and a stage change steers the whole text.
- `test/integration/nomistakes-rules.test.ts` and `deadline-defaults.test.ts`: through the real daemon, a lint finding no rule settles is the leader's with the worker's recommendation; a security-loosening finding and a harmless-looking one whose option deletes stay the user's, and the leader's decide is refused; the classes recorded for deadlines.

`CONTRACT_REVISIONS` went to claude 8 and pi 7, because the worker contract the suite proves changed.
