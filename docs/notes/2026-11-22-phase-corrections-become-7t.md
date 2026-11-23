# Corrections become checks: the correct skill and the weekly corrections scout

- Status: done
- Open: not run live; the first weekly pass runs at the daemon's first upkeep pass after this lands. This week's steers predate the `by` marker, so the live dry run below marked them on a copy

Proposal 9 and the rule-to-check half of proposal 3 of plan p104 (scout how-lauren-tan-rx). Her rule: "Whenever you're correcting your agent, think about how you can make that a deterministic check instead of adding another line to your rules." Here, a correction people make twice in a project becomes a check, filed as a ship. It is not another `flowryn learn` lesson. The idea is adapted from pstack's `correct`; none of its text is copied.

## The correct skill

`src/skills/correct.ts`, one harness-neutral text written in three places:

- among the worker skills (`<state_dir>/skills/correct/SKILL.md`, in the `flowryn-stages` Claude plugin). The corrections workflow's stage names it, and every ship the scout files points at it.
- in the leader's Claude plugin (`<home>/leader/claude-plugin/skills/correct/`) and as a second Pi `--skill` (`<home>/leader/skills/correct/`). The leader skill's lesson line now sends repeat corrections to a ship through it, and tells the leader to mark a lesson that records the user correcting it with `--correction`.

What it says:

1. A class needs two corrections or more. Group by the kind of mistake, not by the words.
2. Skip a class the project's checks already enforce. If a check exists but missed the mistake, fix that check.
3. Pick the highest enforcer: architecture, then a type or lint whose message names the fix, then a test, then a doc line.
4. Prove the check fails on the past mistake's commit and passes on HEAD.
5. Add a row to the project's AGENTS.md rule↔enforcer table (`## Rules and their checks`).

Flowryn's own table is in AGENTS.md.

## The weekly pass

`correctionsPass` (`src/leader/corrections.ts`) runs in the upkeep loop beside the prune. It is due when no `corrections.pass` event is younger than 7 days, so the event is its only state. No index serves events by kind, so the loop keeps the due time in memory (`correctionsDueAt`) and reads events again only once it is due, or after a daemon start. For each project that is not removed, it reads the last 7 days' corrections (`correctionsOf`):

| source | id | what counts |
|---|---|---|
| your answer | `q<N>`/`k<N>` | decisions with `answered_by = captain` on the project's tasks, with the question, the answer and the note |
| steer | `m<N>` | `flowryn steer` from the leader or your terminal. The `steer.created` event now carries `by` (leader or human). Flowryn's own steers have none |
| review page | `g<N>.<seq>` | your messages on a review page (`review_messages`, author user) |
| sent back | `g<N>` | a review gate closed with changes and your words. Merge-gate changes are failed checks, so they are already enforced. Replaced and promoted gates are left out |
| lesson | `l<N>` | `learnings` of the project marked as corrections, created in the window or confirmed again there (marked "confirmed again"). Plain facts are left out, as are lessons unlearned or replaced; ones set aside by the cap or by expiry still count |

A lesson is a correction only when marked: `flowryn learn --project <id> --correction --body-file -` (migration 68 adds `learnings.correction`). Other lessons are plain facts ("api uses pnpm") and never count. The same words learned again with `--correction` mark an existing lesson; the mark is never cleared, and a `--replaces` of a marked lesson keeps it. The `learning.*` event and the verb's output carry `correction: true`. Lessons written before migration 68 are unmarked.

Each entry's words are sanitised to one line of at most 600 characters, with secrets redacted. Only the newest 150 are kept, and the list says how many were left out. Lessons with no project and standalone decisions with no task policy belong to no project, so they are not read.

A project with at least 2 corrections, and no earlier corrections scout still open, gets a one-phase plan:

- filed by `daemon (weekly corrections scout)` and approved as filed;
- its phase runs workflow `corrections`, a new built-in scout workflow whose `investigate` stage carries the correct skill;
- its shared brief (`plans.preamble`, carried into the task file's context) is the list.

A scout is open until its latest run has landed (its report is delivered), is cleaned, failed or cancelled, or it is dropped. The pass appends one `corrections.pass` event with `since`, `until`, `filed` (project, plan, task, count) and `skipped` (project, why). A project with no corrections is not named in it.

Under autonomy `plan` the scout starts by itself. Under `manual` it waits for `flowryn dispatch <project> --task <id>`, and later weeks skip that project until it reports.

### Plan phases may now be scouts

`phaseKind(workflow)` (`src/config/workflows.ts`): a phase of a built-in workflow that ends in no merge gate (`scout`, `corrections`) is a scout. Before this, every phase was a ship, and a `workflow: scout` phase was refused when it started. `approvePlan` writes the kind into `task_policy` and the backlog add. `autoDispatch` and `dispatch --task` start the run as that kind. Plans are filed without the config, so a `[workflows]` table's own scout workflow is still filed as a ship and refused at start, as before.

## The scout's report becomes ships

The scout reports with `## Short answer`, then `## Checks to ship`, then `## Classes not filed`. Each check is an entry like this:

```
### <the check, one line>
Evidence: <two or more ids from the list>
Enforcer: architecture | type | lint | test | doc
Past mistake: <commit or task>
<what the check is, where it goes, its message, how to prove it>
```

At delivery (`deliver --report`), only for the scout of a plan filed by the weekly pass, `fileChecks` reads the entries:

- An entry is refused when it has no title, has no words beyond the labelled lines, or cites an id that is not in its list.
- It is also refused when it cites fewer than 2 ids (a class needs two corrections).
- Only the first 5 valid entries are filed; the rest are refused.
- The valid entries become one approved plan, `Checks from <scout task>`, filed by `corrections scout (<task>)`. Its phases are independent of each other (`after: []`) and use the project's workflow. Its shared brief is the scout's list, so each ship can read the words it cites.
- Each ship's body is the entry, plus a line naming the correct skill's path: prove the check, and add the AGENTS.md row in the same change.

The `corrections.ships_filed` event records the plan, the ships and each refusal with its reason. The report-ready item adds "N checks filed as ships (p<N>), M refused". A report with no such section files nothing and records nothing.

Why ships are filed approved: they only add checks, and each one still goes through build, verify and its merge gate. The pstack rule is the same ("advisory until a ship lands"). The plan's brief keeps every automatic decision in an event.

## `flowryn corrections <project> [--days N]`

A read verb for the leader, a reader or your terminal (project-scoped). It lists the same corrections for the last N days (1 to 90, default 7): id, source, date, task, words. The correct skill points the leader at it when a correction repeats.

## The dry run on this week's data

This was run on 2026-11-22, on a copy of the live `flowryn.db`; the live database was only read. This week's steers predate the `by` marker. So on the copy, 111 steers whose openings are not Flowryn's own templates were marked `by: leader` (auto-merge, merge queue, stage, review-passed, idle, conflict and landing lines were left out). Then the real code ran.

**The weekly pass** filed three scouts:

| project | corrections |
|---|---|
| appsec-signal | 154 |
| flowryn | 24 |
| portwarden | 5 |

Nothing was skipped.

**The appsec-signal scout.** Following the skill, the scout grouped the declutter corrections:

- m1070–m1073: "less is more", relayed four times;
- m1150 and m1164: one-word labels, and one table on the event page;
- m1181: Topics repeat the brief;
- l57, l59 and l61: no narrative, single-word labels and no split tables, no Briefing fold.

It read `tests/ui/check.mjs`: plan p107 already enforces most of this class (declutterFacts, briefFacts, investigationFacts, zeroFoldFacts, the Briefing fold assertion). So it proposed only the two gaps, where a rule runs on a few routes:

- `labelFacts`, which returns early off `/decide` (evidence l59, m1150, m1164, m1111);
- `splitTableFacts`, which runs on `/assets/` and `/surface` only (evidence l59, m1164).

Both cite `ee082dca7^` as the past mistake. It left four classes unfiled, each with the check that covers it: load flakes, idle background jobs, unreadable shell commands, and migration-number clashes.

**The Flowryn scout** found one class: a PR with no checks registered waited an hour on CI (q124, q125, answered accept-without-ci both times). It proposed settling that by rule.

**Filing.** `fileChecks` filed 2 appsec-signal ships and 1 Flowryn ship from these reports, with no refusals.

## Tests

- `test/unit/corrections.test.ts`:
  - what the list reads and leaves out (rule answers, Flowryn's steers, merge-gate changes, replaced and promoted gates, plain-fact, unlearned and replaced lessons, other projects, last week);
  - a plain fact counts only once learned again with `--correction`, the mark is never cleared, and a replacement keeps it;
  - sanitising and redaction;
  - the pass: one approved scout per project with its list as the brief, kind scout in the task policy and the backlog add, one event, not again within a week, an open scout skipped with its reason, one correction too few, removed projects passed over;
  - filing: independent approved ships, each refusal reason, the cap, no section files nothing, only a corrections scout files;
  - parsing, an entry in the skill's format filed by `fileChecks` (round trip), `phaseKind`, the skill's budget, and the steer's `by`.
- `test/integration/corrections.test.ts`: through a real daemon and the fake harness. `flowryn learn --correction` twice, then the pass. `dispatch --task` starts the phase as a scout of workflow `corrections`, and its task file names the correct skill's `SKILL.md`. The report's valid check becomes a ship, the one-off is refused, and the item says so.
- `test/unit/upkeep.test.ts`: the pass runs on the loop's first pass, then not again within the week.
- `test/unit/workflows.test.ts`: the built-in `corrections` workflow. `test/integration/leader-cli.test.ts`: the Pi leader's second `--skill`.
