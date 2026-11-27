# Laws: each project's rules table is checked by verify

- Status: done
- Open: not run live through the daemon yet; the first verify after this lands checks Flowryn's 10 laws and appsec-signal's 1. Later phases of plan p152: global laws, filing laws from repeated corrections, re-proving laws on a schedule

Phase 1 of plan p152. Each project's AGENTS.md `## Rules and their checks` table (added by the correct skill, docs/notes/2026-11-22-phase-corrections-become-7t.md) is now the project's laws. Verify reads it as data. Before this, nothing read it: a row could name an enforcer that did not exist and nothing would notice.

## The laws step

Every project's `flowryn verify` has a built-in step, `flowryn:laws` (`LAWS_STEP`). It runs as a group of its own after the configured steps, so install and build have run first, but before a `{ review = true }` step, so a broken table fails before the paid review. A daemon stop in the middle of the step fails it (`laws: stopped after N laws checked`), so a resumed verify checks every law again. You do not configure it, and no project can turn it off. The light check of a batch project does not run it; the batch's full verify does.

The step runs in the daemon, like the review step (`src/verify/laws.ts`, called from `src/verify/runner.ts`). It reads `AGENTS.md` at the head being verified:

- No file, or no `## Rules and their checks` heading: the step passes with the note `no laws: AGENTS.md has no ## Rules and their checks table`.
- A heading whose table has no `Rule | Enforced by | Proven on` header or no `|---|` line: the step fails.
- Otherwise it checks each row in order. One failing row fails the step. The verification fails, and the worker gets the log as for any failed step.

The step's detail is `N laws hold`, or `K of N laws failed; first: <rule>: <why>`. Its log has one `ok`/`FAIL` line per law, with the file's line number, and the last 30 lines of output from each failing command. The verification row keeps each law's result on the step (`laws: [{ rule, state, detail }]`).

### Enforced by

The cell is split into parts on `;`. Each part may name:

| written | checked by |
|---|---|
| a bare path with a `/` and a file extension: `test/unit/db.test.ts` | the file is in the repository |
| a code-span path: `` `internal/sqlcheck` ``, `` `.oxlintrc.json` `` | the file or directory is in the repository |
| code spans after a path, in the same part: `` `TestName` ``, `` `no-shadow` ``, `` `never rebase` `` | the file holds each of these words. In a Go package, each must be a `func Name(` in its `_test.go` files |
| `` `verify: <step>` `` | the step is one of the project's verify steps (compared as the verify policy normalizes it) |

Other words are prose, and the step ignores them ("the hook,", "test:"). A code span that is not a path, comes before any path, and is not `verify:` fails the row. So a row cannot look enforced when nothing reads it. A row whose cell names nothing fails: "Enforced by names nothing verify can run or confirm".

Paths are relative and stay inside the checkout: an absolute path, a `..` segment or a symlink out of the repository fails the row.

What runs:

- A `*.test.*`/`*.spec.*` JS or TS file: `bun test ./<path>`.
- A Go package directory with `_test.go` files, or one such file: `go test -count=1 [-run ^(A|B)$] ./<package>`. `-run` is added only when the row names its tests, and only after each name is found as a test func. A `-run` that matches nothing would otherwise pass without testing anything.
- Any other file or directory is confirmed: it exists and holds the names.

The step runs every test enforcer itself. A `when_changed` glob or a `test-changed` target that skipped the test still leaves it to run here. Commands are argument lists built from paths and names that were checked, and they go through `runBounded` in the verify checkout, with the steps' environment and PATH. Their deadline is the step's own (`verify_step_timeout_min`, or its history), never past the run's. No text from the table reaches a shell, and a row cannot change the sandbox or the hooks' allow-lists. The binary must be on the verify PATH, or the row fails and says which command is missing.

### Proven on

A row names the commit its enforcer fails at, such as `fails at 2f31e53, passes at HEAD`. Each sha prefix in the cell (7 to 40 hex digits, with an optional `^` or `~N`) must resolve to a commit of the repository. A cell that names no commit fails the row.

`-` (or an empty cell) is allowed only on a row that the base's table already had: rows recorded before this change. The step reads `AGENTS.md` at the merge base with origin's copy of the PR's base branch, or with the local branch when origin has none (`mergeBaseOf`, `src/verify/changed.ts`). It matches rows by their Rule text, with whitespace collapsed. A new row with `-` fails: "a new law needs Proven on: the commit its enforcer fails at". A reworded old row counts as new. When the base cannot be read, a `-` row fails, because it cannot be told apart from a new one.

The step checks that the commit exists, not that the enforcer fails there. Phase 4 of the plan re-proves laws.

### Policy and reuse

The laws step is not part of the verify policy id (`verifyConfig` returns `laws: true`, and `admitRequest` adds the step). It is the same built-in step on every project, and adding it to the hash would have changed every project's policy at once. One consequence: a pass recorded before this landed still counts at its head. A reused pass (docs/notes/2026-11-25-skip-a-batch-z7.md) must come from a verification that ran the laws step. Rows from before the step existed are not reused.

## `flowryn laws <project>`

This is a read verb for the leader, a reader or your terminal (project-scoped). It reads the laws table in the project's checkout. For each law it shows the rule, Enforced by, Proven on ("not recorded" for a `-` row), its last result (`passed`, `failed`, or `not checked yet`) and that result's detail. The results come from the newest finished verification of the project whose laws step ran. A hint gives the count of laws recorded before laws were checked, which name no commit. Flowryn has 7 of these.

```
flowryn laws flowryn
```

## Live results

On 2026-11-27, `checkLaws` ran on this branch's own checkout: all 10 of Flowryn's laws held (the first 9, `test/integration/toolkit.test.ts` included, in about 18 s). appsec-signal's one row (`` `internal/sqlcheck` `TestEveryDoorQueryRunsAsTheDoorRole` ``, fails at `c6f5d36c^` and `675d12edf^`) parses to `go test -count=1 -run ^(TestEveryDoorQueryRunsAsTheDoorRole)$ ./internal/sqlcheck`. That test opens the Postgres the earlier `make test-changed` step started (dbtest's server file in the checkout). It was not run here.

## Tests

`test/unit/laws.test.ts`:

- the table: no heading, cells split outside code spans and on escaped pipes, a malformed header;
- the enforcers: bare and code-span paths, names, `verify:`, prose skipped, a stray code span refused;
- `Proven on` commits;
- each check: no table passes with the note; an old `-` row holds and a new one is refused; a commit that does not resolve; a failing test with its output in the log; confirmed files and their names; a wrong verify step; a prose-only row; a path outside the repository; a Go package run as `go test -run` with the exact argument list, and a misspelt test name refused before anything runs;
- through the real runner, on a fixture repository: a row pointing at a missing test fails verify (`test/unit/dismiss.test.ts does not exist`). Once the test is added, the same row passes, and `flowryn laws` shows it passed in that verification. A project with no table passes verify with the note. The light check has no laws step.
