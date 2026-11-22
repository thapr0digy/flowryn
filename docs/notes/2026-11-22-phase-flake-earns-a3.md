# Flakes earn one rerun: a red landing batch reruns its failing tests before fixing forward

- Status: done
- Open: not run live. appsec-signal needs `rerun_failed` on its test step before any batch reruns (see "Turning it on"); until then nothing changes
- Config: `[projects.<id>] verify` step table key `rerun_failed`

Proposal 1 of plan p104 (scout how-lauren-tan-rx). From batch mode's start (2026-11-21 12:00) to the scout: 9 red batches opened 9 fix tasks. The leader retried 3 by hand, and 2 fixes were cancelled because the red was a load flake. Her rule: "Flake earns one fresh build. Only the diff's own failures get a commit." This change gives a red batch's failing tests one rerun alone at the same head. A pass there lands the batch, and the flake is recorded and ticketed instead of hidden. Plain code (a log parser, a weekly rule, the plan-filing path); no model.

## Turning it on

A step opts in with `rerun_failed`, a command that names `{failed}`:

```toml
[projects.appsec-signal]
verify = [
  "make vet",
  { run = "make test-changed", rerun_failed = "go test -count=1 {failed}" },
]
```

Flowryn cannot know how a project runs one package's tests (build tags, a test database, environment), so the command is the project's. `{failed}` becomes the failing packages (Go) or test files (bun), separated by spaces. Each is a plain word (`[A-Za-z0-9_./@+-]`, no `..`, not starting with `-`), so it is safe unquoted inside the command, `PKGS="{failed}"` included. `rerun_failed` is not part of the verify policy, because it does not change what a pass of the step proves, so adding it keeps every recorded pass. `light_verify` refuses it, because a failing light check goes back to its worker.

Put it only on a step that runs tests and nothing else. If the step also lints or builds, a failure there names no test, so it earns no rerun. But if the step fails tests and something else at once, the rerun checks only the tests.

## What happens

1. A batch's full verify fails at a step (a non-zero exit, not a timeout or an error) that has `rerun_failed`, and the batch has neither a fix task nor a rerun at this head yet.
2. **The failing tests.** `failedTests` (`src/verify/flake.ts`) reads the last 256 KiB of the step's log, with control characters stripped and secrets redacted:
   - Go: each top-level `--- FAIL: TestX` belongs to the next `FAIL <package>` line, and the test is `<package> TestX`. A package with no test named (a panic, a timeout) is itself the test. Subtests and `ok` packages are ignored.
   - bun: each `(fail) name` belongs to the `<file>.test.ts:` header above it, and the test is `<file> > name`. The `N tests failed:` summary at the end is not attributed to the last file.
   - **No rerun** for a log that names no failure, `[build failed]`, `[setup failed]`, `Unhandled error`, a bun failure with no file header, more than 10 packages or files (that is a real break), or a name that is not a plain word. The batch is fixed forward and `verify.flake_refused` says why.
3. **The weekly rule.** A test that already flaked within 7 days earns another rerun only while the fix task filed for it is open (not dropped, not landed, not Done in the backlog). Otherwise the rerun is refused (`verify.flake_refused`: "`<test>` already flaked within the week (2 days ago, v31) and its fix `<task>` is closed"). This stops a real order-dependent bug from passing alone week after week.
4. **The rerun.** The batch stays `verifying`, and `landing_batches.flake` records the rerun (head, the red verification, the step's place and name, the command, the targets, the tests, `pending`). One verify request for the same head under the same full policy is queued (`verify.flake_rerun`, with the command and tests). When the runner admits it (`admitRequest`), the failed step carries `rerun` and runs `repeatedCommand`, that is, the filled-in command 3 times in a row. Each run is marked `--- flowryn: flake rerun N of 3` in the log, and the first failure ends it with its exit code. Every other step runs as configured, because the red run's later steps never ran. The step's detail says `flake rerun of v31: 1 failing test, 3 times, with \`go test -count=1 …\`: passed 3 of 3`.
5. **Green**: the batch lands as any green batch does. The merge gate counts the rerun's pass, which ran at the batch head under the full policy. Its record is honest: the step's `rerun` field and detail say what ran. Then:
   - `flaky_tests` (migration 66): one row per test, keyed by project and test, with its package or file, a flake count, first and last seen, and the red verification. A repeat flake counts again.
   - **One fix task** for the tests that have neither an open fix task nor one filed within 7 days. It goes through the plan-phase path, as a batch's fix does (an approved one-phase plan, its backlog add through `recordIntent`, the `fix` workflow where one is configured). It is non-blocking: nothing waits on it. Its brief names the tests, the rerun command, the failing run's last 40 lines (fenced, as data) and the rule "never add a retry, a skip or a longer timeout to hide it".
   - `verify.flake` (batch, project, head, the red verification and the rerun, step, command, tests, the task filed or null, and the tests already ticketed). The briefing shows it once: `Flake 09:12: landing batch lb7 (appsec-signal) landed after example.com/…/audit TestWrite passed 3 of 3 alone (v58); fix task fix-flaky-….`
   - The batch's landing detail adds `its failing tests having passed 3 of 3 alone (flaky)`.
6. **Red**: `verify.flake_rerun_failed`, and the batch is fixed forward as before, from the rerun's red: one fix task with the step's log tail, its `what` naming `(its rerun of the failing tests of v31)`. Nothing is recorded as flaky. There is no second rerun at that head. If the failing tests pass 3 of 3 but a later step fails (those steps never ran in the first red), the flake is still recorded and ticketed, and the batch is fixed forward from that later step. A rerun killed at a deadline is judged failed, and the timeout path runs the full verify once more, as for any timeout.

A leader's `flowryn batch retry` runs every step in full: it ends a rerun still pending at that head. `flowryn show lb<N>` lists `flake` (state, the red verification, the rerun, the step and the tests).

The rerun's time never enters the step's deadline history (`recentPasses` skips a step with `rerun`), because it ran another command under the step's name.

## Why this shape

- **The verify policy, not a separate one.** The rerun is a full verify of the same head with one step narrowed, so the merge gate, the batch's request bookkeeping, verify resume and the views work unchanged. A second policy would need its own path through the start check, the gate and the batch state. The narrowing is recorded on the step and in events, never silent.
- **Whole packages or files, not single tests.** As the brief asks, rerunning the failing package keeps order-dependent failures inside it visible.
- **Rejected: rerunning the whole step.** For appsec-signal, `make test-changed` takes up to 9.4 min, so 3 times would cost about 28 min. Rejected: inferring the command (`go test`, `bun test`). Projects need their own flags and environment.
- **Rejected: a rerun on the auto-merge and queue paths.** A red there goes back to its own worker, whose diff is the only suspect. A batch's red is shared by every member, which is where flakes cost the most.

## Tests

- `test/unit/flake.test.ts`: the parser (Go packages and tests, subtests and `ok` lines ignored, a package with no test; bun files and the closing summary). Its refusals: no names, build and setup failures, an unhandled error, a headerless `(fail)`, too many targets, unsafe names. The `{failed}` fill, the repeated shell through a real `/bin/sh` (3 marks green, one mark and the exit code red, a trailing `#` comment), `withRerun`, and the config key (flattened place, policy unchanged, refusals, `light_verify`).
- `test/unit/verify-steps.test.ts`: the runner runs the rerun command instead of the step's own and records its detail. A failing rerun fails with its exit code. A rerun's pass never sets a deadline.
- `test/unit/landing-batch.test.ts`, "a flaky batch", with real git and the merge verb's path:
  - The rerun queued and admitted with the narrowed step; on its pass, the batch lands, the flake row is written, one fix task is filed (plan, brief, backlog intent) and the briefing line is shown.
  - A failed rerun fixes forward, with nothing recorded and no second rerun.
  - The weekly rule refuses a test that flaked this week with no fix task.
  - An open fix task keeps the rerun and files no second task.
  - A log naming no tests is refused and fixed forward.
