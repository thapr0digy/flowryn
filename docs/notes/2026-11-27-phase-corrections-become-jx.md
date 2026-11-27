# Corrections become laws without a reminder; laws are re-proved weekly

- Status: done
- Open: not run live through the daemon yet. The first upkeep pass after this lands files each project's learnings sweep and re-proves every project's laws. appsec-signal's laws need Postgres from `make test-changed`, so its re-prove may report them as failing at HEAD until that is solved

Phase 3 of plan p152. Phase 1 (docs/notes/2026-11-27-phase-the-laws-ib.md) made each project's AGENTS.md `## Rules and their checks` table its laws. Phase 2 (docs/notes/2026-11-27-phase-global-laws-iq.md) added the global laws. This phase does three things. A mistake corrected twice gets a law filed without the leader remembering to. Every project's old lessons are sorted once into law, fact or stale. And every law is re-proved each week. It extends the corrections pass (docs/notes/2026-11-22-phase-corrections-become-7t.md) and adds no new registry.

## A repeated class files its scout at once

The weekly pass still runs. Between weekly passes, the upkeep loop now looks for a repeated class at most once an hour (`CLASS_CHECK_MS`), never in the same pass as the weekly one. That check is `classPass` (`src/leader/corrections.ts`). For each project that is not removed and has no corrections scout open, it reads the corrections since the project's last scout, at most a week back. If two of them are one class, it files the scout now, the same one-phase `corrections` plan the weekly pass files. The scout's body names the pair ("Filed early: m1 and m2 look like one class; start there").

Deciding the class for real is judgement, so the scout's model groups the list. The trigger is plain code (`repeatedClass`):

- A lesson learned again with `--correction` in the window is one correction made twice, so it is a class by itself.
- Otherwise, two corrections from different tasks match when their content words overlap. Content words are lower case, three letters or more, with stopwords, ids (`q12`, `m4`) and possessives dropped and a plural's `s` cut. A match needs at least 3 shared words, making up at least half of the shorter correction's words.
- Two corrections in one task never match. They are one incident relayed twice, such as an answer and the steer that passes it on.

A false match costs one scout run, which may report that the class is already enforced. A missed match waits for the weekly pass. A filing appends one `corrections.class` event (`filed`: project, plan, task, corrections, repeat). A check that files nothing records nothing, so it can run hourly. It never moves the weekly pass, whose state stays the last `corrections.pass` event.

**Each list starts where the last one ended.** A project's weekly or early scout now lists only the corrections made since its last corrections scout was filed (the newest plan by `CORRECTIONS_FILER`), at most a week back. Before this, the weekly list always covered the last 7 days, so a scout could get corrections a previous scout had already grouped.

Dry run, 2026-11-27, on a copy of the live database:

- Flowryn's 7 days: the trigger matches q124 and q125, both answered accept-without-ci. This is the class the 2026-11-22 scout found by hand.
- appsec-signal: it matches two leader "idle since your background job ended" check-ins. Leader steers already count as corrections (the 7t note). So appsec-signal will get an early scout most weeks, one at a time, since an open scout blocks the next.

## The scout proposes the laws row

Each `## Checks to ship` entry now carries a `Law:` line: the row its ship adds to the table.

```
### Labels are single words
Evidence: g10.1, l1
Enforcer: test
Past mistake: 1a2b3c4
Law: | Labels are single words | test/ui/labels.test.ts | fails at 1a2b3c4 |
A test over every label in ui/.
```

At delivery, `fileChecks` refuses an entry whose row the laws step could not check once the ship lands. That means no `Law:` line, a row without three non-empty cells, an Enforced by that `parseEnforcers` refuses or that names nothing, or a Proven on that names no commit. The cells are split the way the laws step splits them (escaped `\|` and pipes in code spans stay in their cell). The file paths need not exist yet, because the ship creates them. The ship's body carries the row and tells it to add the row, with Enforced by as built and Proven on as proved, in the same change. Verify's laws step then holds the ship to it.

## The learnings sweep, once per project

The weekly pass also files, once per project ever, a learnings sweep. It is a one-phase plan of workflow `corrections`, filed by `daemon (learnings sweep)` (`SWEEP_FILER`) and approved. Its shared brief lists the project's lessons in use: not set aside, newest 150, each marked correction or lesson. A project with no lessons gets none until it has one. The pass reports the sweeps it filed in `swept` on its `corrections.pass` event.

The sweep follows the correct skill's new section "As the learnings sweep". It sorts each lesson as one of:

- law: a rule a check could enforce;
- fact: true, but no rule;
- stale: the code no longer bears it out.

It reports `## Checks to ship` in the same format, where one cited lesson is enough, then `## Stale lessons`, one line each: `- l<N>: why`.

At delivery, `fileChecks` files the laws as ships, with the same refusals and cap of 5. It then puts every listed lesson in exactly one bucket:

- law: a filed ship cites it;
- stale: listed under `## Stale lessons` and not a law (ids not in the list are dropped);
- fact: everything else.

It records them once, as `learnings.swept` (project, plan, law, stale with why, fact). The report-ready item adds "N stale lessons proposed for flowryn unlearn: l3, l9". Flowryn never unlearns a lesson itself; the leader runs `flowryn unlearn` for the ones it agrees with. A run delivers only once, and no project is swept twice, so no lesson's bucket is reported again. A dropped or cancelled sweep is not filed again.

## Re-proving laws weekly

`src/verify/reprove.ts`. Once a week, the upkeep loop runs `reproveProject` for each project that is not removed. It runs after the sync, build and sweep, and not while a restart or cleanup is under way. Its due time is a week after the last `laws.reproved` event, so the first pass after this lands runs it.

1. It reads the head of `origin/<default branch>` in the project's checkout, then the AGENTS.md table at that head. A project with no origin branch, no AGENTS.md or no table is skipped, with the reason.
2. It makes a detached checkout of that head at `<state_dir>/reprove/<project>`, under the repository's worktree lock. It links the project's `node_modules` into the checkout, so tests import what verify's do. It removes the checkout when it is done, whatever happened.
3. For each law, at HEAD: each enforcer must still be there, with its names. `verify:` and `hook:` enforcers must still name a step or rule. A test enforcer must pass and must run at least one test.
4. For each commit in Proven on, the checkout goes to that commit and HEAD's enforcer files are laid over it: the test file, or a Go package's `*_test.go` files. Then the same commands run. At least one must fail with tests run.

The commands are the laws step's own argument lists (`planPath`). They run through `runBounded` with the project's verify PATH and the project's step deadline (`verify_step_timeout_min`, else its whole verify timeout). No text from the table reaches a shell.

Each law ends in one of three states:

| state | when |
|---|---|
| proven | it fails at each recorded commit and passes at HEAD |
| holds | it passes at HEAD, but nothing re-proves it at a commit: it runs nothing (a doc, a `verify:` step, a hook rule), or its row says `-` |
| unproven | its enforcer vanished or fails at HEAD; it ran no tests; it timed out; or it passes at its commit ("no longer fails where the mistake was") |

`recordReproofs` appends one `laws.reproved` event with every project's results. For each project with an unproven law, it opens a `laws_unproven` item (P1, the leader's to act on) listing each such law and why. A re-prove that the daemon's stop cuts off records nothing, so it runs again at the next start.

**An emptied test.** `bun test` on a file with no tests exits 0. So both the re-prove and verify's laws step now read the output (`ranNoTests`: bun's "Ran 0 tests", go's "[no tests to run]" or "[no test files]"). A test enforcer that ran no test fails its law: `bun test t/e.test.ts ran no tests: an emptied test proves nothing`. A merge that empties a law's test is refused by verify. The re-prove reports a law whose test went empty some other way.

Live, 2026-11-27, on this branch against Flowryn's `origin/main`, with real git and bun, in 24 s:

- proven: the 4 laws that name a commit (2f31e53, 7753f46, ce93110, 9b2f521);
- holds: the 7 recorded with `-`.

The checkout was removed afterwards.

## Tests

`test/unit/corrections.test.ts`:

- repeated class: two matching corrections in different tasks file the scout within one pass, while the weekly pass is not due, with one `corrections.class` event and no second scout while it is open;
- not a class: one task's answer and its relay, and unrelated words, file nothing and record nothing;
- a lesson learned again is a class by itself;
- a scout's list starts where the last one ended;
- content words;
- the `Law:` row: its parsing, the three refusals (no line, no commit, no enforcer), and the row carried in the ship's body;
- the sweep: filed once per project, of its lessons in use, approved and a scout, never a second time; each lesson in one bucket, with the event recorded once and the item's note; a report with no law still sorts every lesson; the stale section's parsing.

`test/unit/reprove.test.ts` uses a fixture repository with real git and real `bun test`:

- a law fails at its commit and passes at HEAD (proven); a doc and a `verify:` row hold; the checkout is gone afterwards;
- a law whose test was emptied is reported;
- a weakened test that passes at the mistake's commit too is reported;
- a vanished enforcer and a gone verify step are reported;
- a Go package's test files are laid over the old commit, checked with a stand-in for `go`;
- a missing origin branch, AGENTS.md or table is skipped with why.

`test/unit/laws.test.ts`: an emptied test fails its law in verify, and a kept test still passes.

`test/unit/upkeep.test.ts`:

- the weekly pass and the class check never run in one pass, and the class check runs at most hourly;
- the re-prove runs once a week, not while busy, with one event and an item for an unproven law.

`test/integration/corrections.test.ts`: its report's check now carries a `Law:` row.
