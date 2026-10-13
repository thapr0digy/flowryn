# no-mistakes never rewrites a PR on a merge conflict

- Status: done
- Open: not seen live yet (no PR has conflicted since); a worker whose own pipeline parks at a conflict gate before it delivers is not covered (see "Not in scope")

The scout report on the no-mistakes v1.84.0 CI monitor (`scout-no-code-qn`) found that a PR that starts to conflict with `main` after delivery is repaired by the monitor itself: the repair counts against `auto_fix.ci` (here 3, from the global config), always rebases, revalidates from Review and force-pushes. `auto_fix.rebase` does not cover it. Flowryn's own `[upkeep] nudge_conflicts` races it, and the result was five human decisions on 2026-10-12/13 (q58, q60, q62, q63, q66). This change stops the rewrite at the source and makes Flowryn treat what is left as the conflict nudge's business. Plain code throughout (a config file, a parser, a classifier, a git ancestry check, a doctor check); no model.

## Design

**1. Repository config (`.no-mistakes.yaml`).** Two keys, each with a one-line comment, beside the existing `no_ci`:

- `auto_fix: { ci: 0 }`: the CI monitor never starts a fix round, so a `ci-merge-conflict` finding parks the `ci` step at an approval gate instead of rebasing. Flowryn's nudge then sends the ship back to merge `origin/main` with a new commit.
- `rebase: { strategy: merge }`: a clean Rebase step at the start of a run merges a moved `origin/main` (a `--no-ff` merge commit) instead of replaying the branch on it, the other rewrite path the report names.

Verified against the installed binary (v1.84.0), not memory: its embedded config sample lists `auto_fix:` with `ci: 3` among `rebase`, `lint`, `test`, `review`, `document`; its config struct has `yaml:"rebase"` with `yaml:"strategy"`, and its validator reads `rebase.strategy: %q is not a valid strategy (want %q or %q)` (rebase or merge). no-mistakes trusts the file from the default branch, so it takes effect for branches cut from (or merging) `main` after this PR lands. `~/.no-mistakes/config.yaml` is not touched.

**2. A parked conflict gate is the nudge's (`src/policy/nomistakes.ts`, `src/reconcile/delivery.ts`).**

- `parseNmStatus` also reads the top-level `gate:` step (`gateStep`), the full head (`head_sha`) and the `findings` table (TOON, by column name, so `category` is read when a later version prints it). v1.84.0's axi table has no `category` column (`{id,severity,file,line,action,description}`), so a finding is a merge conflict when its category is `ci-merge-conflict` or, without one, its description is exactly no-mistakes' `PR has merge conflicts with the base branch`.
- `isConflictGate(nm)`: no outcome, `gate: ci`, at least one finding, and every finding a merge conflict. A gate with any other finding (a red check beside the conflict) is not one.
- Covered: `conflictCovered(db, run, nm)` holds when the gate is a conflict gate on the run's branch and the run has a `run.conflict_nudged` (nudge sent) or `pr.conflict` (nudges spent, `pr_conflict` open) event for the parked run's head. Those events are written by the existing nudge (`nudgeConflict`), so with `nudge_conflicts` off nothing is covered and today's behaviour stands; after `MAX_CONFLICT_NUDGES` the PR watcher's `pr_conflict` is the one item, as today.
- What covered changes in `applyNmObservation`: the run is not flipped to `validating` (so no `validation_outside_cap` P1 while the nudged stage waits for its grant), `validation_stuck` judges nothing for it (as for any parked gate today), and the evidence row records `conflict_gate: "conflict_nudged" | "pr_conflict"`. The restart guard (`src/daemon/restart.ts`) skips a validation slot whose fresh status is a covered conflict gate, as it skips a CI-only wait: the parked run is not work in progress. No item or decision is opened for it. The worker's next push through the gate supersedes the parked run (`cancelled: superseded by new push`), so nothing aborts it.
- Tests: parser and classifier units; through the stand-in no-mistakes (`$FLOWRYN_HOME/nm-status`) and the delivery watcher, a nudged run whose run parks at a conflict gate stays `running` with no item, and an un-nudged one goes `validating` as today; the restart guard ignores a covered gate.

**3. A head that moved by a rewrite is tagged (`src/watch/delivery.ts`, `src/reconcile/delivery.ts`).**

- Before the observation's transaction, when the PR head differs from the delivered head and no head-move divergence for this pair is recorded yet, the watcher asks git once: `merge-base --is-ancestor <delivered> <new>` in the run's worktree (the project checkout when it is gone), fetching `refs/pull/<n>/head` first when the new head is not in the local objects. Every call goes through the daemon's bounded `GitRunner`. Exit 0 is `descends`, exit 1 `rewritten`, anything else (a failed fetch, a missing object, a timeout) `unknown`.
- `applyPrObservation` takes the verdict (`history`). `descends` keeps today's summary. `rewritten` appends `; history rewritten: <new> does not descend from <delivered>`; `unknown` appends `; ancestry unknown`. The divergence's `divergence.opened` event carries `history`. No schema change, so no migration.
- One divergence per head move: an open (or `keep-run`) divergence whose summary starts with the same `the PR head moved from <delivered> (delivered) to <new>` blocks another, whatever its tag, and also skips the git check on later polls.
- Tests: scratch repos for a descendant head, a force-pushed rewrite and a git failure (unknown); one divergence across repeated polls.

**4. `flowryn doctor` warns (`src/doctor/nomistakes.ts`).** Read-only; it never edits a config.

- Only when `[upkeep] nudge_conflicts` is on and the database names a project with delivery mode `no-mistakes`.
- Effective `auto_fix.ci` per project: the repo's `.no-mistakes.yaml` on the default branch (`origin/<default>`, else the local `<default>`, read with `git show`) overrides `$NM_HOME/config.yaml` (default `~/.no-mistakes/config.yaml`), which overrides no-mistakes' default of 3. YAML through `Bun.YAML`.
- Above 0: a warn naming where the value came from and the line to add: `auto_fix: { ci: 0 }` in the repo's `.no-mistakes.yaml` on its default branch. 0: ok. A file that does not parse: a warn saying so.
- Test homes set `NM_HOME` to a missing directory, so no test reads this machine's no-mistakes config. Tests: fixtures for global-only, a repo override either way, an unparsable file, nudge off.

## Built

As designed, with these specifics:

- `parseFindings` decodes only the `findings[N]{...}:` block: decoding the whole status fails on the free-text `help[N]:` list a parked gate prints (`Expected 1 list-form items`), which is why `parseActiveSteps`' whole-document decode is not reused.
- A covered gate that had already made the run `validating` returns it to `running` with a `run.validated` event carrying `conflict_gate`.
- The ancestry check lives in `src/policy/head-history.ts`; the watcher asks it only for a `ready` run with an open PR whose head moved and has no recorded divergence yet, and a throwing runner reads as `unknown`.
- Doctor's check is `src/doctor/nomistakes.ts` (`no-mistakes auto_fix.ci (<project>)`). Run read-only against this machine before the merge: `warn`, `3 (from ~/.no-mistakes/config.yaml)`, since `main` does not have this PR's `.no-mistakes.yaml` yet.
- Tests: `test/unit/conflict-gate.test.ts` (parser, classifier, and the delivery watcher with a stand-in no-mistakes), `test/unit/restart.test.ts` (the restart guard), `test/unit/head-history.test.ts` (scratch repos), `test/integration/delivery.test.ts` (a commit on top is not tagged), `test/unit/doctor-nomistakes.test.ts` (fixtures).

**Not in scope.** A worker still in its ship stage whose pipeline parks at a conflict gate before delivery is not covered by the nudge (the nudge only acts on delivered runs); the worker contract does not yet say what to do with that gate. Reported to the leader as a follow-up.
