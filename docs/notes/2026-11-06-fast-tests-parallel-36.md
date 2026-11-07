# Fast tests: parallel suite, fail fast, scoped runs, contract checks only when needed

- Status: done
- Open: the 5 min target was not reached on the shared Mac (10–12 min, load average 15–48 from other sessions; see "Timings"); no-mistakes' own test command lives outside this repo (see "no-mistakes")
- Config: `[projects.<id>] verify` step tables `{ run, when_changed }`, `FLOWRYN_TEST_JOBS`, `FLOWRYN_CONTRACT_POLL_MS`

Leader audit of 2026-11-06: `bun test` took 25–27 min, one file at a time, and one PR ran it 3 to 7 times (the build skill, no-mistakes, verify, the landing queue's re-verify). This change makes the full run parallel, orders verify so cheap steps fail first, has the build stage run only the affected tests, and lets verify skip the contract checks when no file on a worker's path changed. Everything is plain code: a glob compiler, a git diff, a step table, a runner script. No model.

## The parallel suite: `bun run test`

`scripts/test.ts` (`bun run test`, `bun run test:unit`, `bun run test:integration`):

1. `bun test --parallel=N --timeout=30000 --path-ignore-patterns=<serial files> test/unit`
2. `bun test --timeout=30000 <unit serial files>`, one at a time
3. `bun test --parallel=N --timeout=30000 --path-ignore-patterns=<serial files> test/integration`
4. `bun test --timeout=30000 <integration serial files>`, one at a time

It stops at the first failing part, so a unit failure shows in a minute or two. With more than one part it ends with one summary in bun's format, the parts added, so `flowryn verify` records every test's count.

- **N** is `FLOWRYN_TEST_JOBS` when set, else two thirds of the cores, from 2 to 8 (8 on a 12-core Mac). 12 was no faster than 8 on this machine and failed more timing windows.
- **The 30 s default timeout.** Under `--parallel` each file ran 3–4 times slower than alone (per-file times summed to 7,244 s against about 1,600 s serially), and 28 tests that pass alone hit bun's 5 s default. A test that sets its own timeout keeps it. `bunfig.toml` cannot set it, nor `parallel` (Bun 1.4.4 ignores both keys), so the flags are in the script.
- **The serial files** (`SERIAL_FILES` in the script): `gate-questions` in test/unit, and `races`, `urgent`, `question-wake`, `treehouse-pool` and `asks` in test/integration. Each asserts on a wall-clock window (a fixed sleep before "nothing happened yet", or a race between two deliveries). They passed alone and in parallel among themselves (38/38) but missed their windows beside a dozen daemons. `gate-questions`' review-channel health test asserts on an event window too, and once saw an extra `gate.channel_ok` event under a parallel unit run. A unit test checks that every listed file exists.
- **Isolation.** Every test home already has its own temp dir, socket and database, and no fixed ports were found, so nothing else needed changing. `bun test` alone still works and runs one file at a time.
- **test/timings.json** holds per-file durations, so `--parallel` starts the slowest files first. Refresh it with `bun scripts/test.ts --update-timings` in a PR of its own, because every PR that updated it would conflict.

`test/integration/auto-contract.test.ts` (180 s, the slowest file) is now three files that run side by side: `auto-contract-pass` (a new version, a revision bump), `auto-contract-stop` (SIGKILL and SIGTERM mid-suite) and `auto-contract-strict`. Their shared fleet and queries are in `test/helpers/auto-contract.ts`. The strict test used to sleep 11 s for two of the checker's 5 s passes. It now waits for the P1 (an event wait), then for two passes of a 500 ms checker. `FLOWRYN_CONTRACT_POLL_MS` (a positive integer of ms, read by the daemon) sets the pass interval and defaults to 5 s. A wait remains because "nothing starts" has no event to wait on.

## Verify: order, and `when_changed`

Verify runs cheap steps first, stops at the first failing step (as it already did), and runs unit before integration. A step may be a table, `{ run = "<command>", when_changed = ["<glob>", ...] }`, at the top level or inside a parallel group. The step runs only when a file changed against the PR's base matches one of its globs. Otherwise it is recorded as `skipped` (shown as `–`), with the reason in its detail, such as `skipped: none of the 3 files changed against origin/main matches its when_changed (src/lifecycle/**, src/harness/**)`. A skipped step does not stop the run.

```toml
[projects.flowryn]
verify = [
  "bun install --frozen-lockfile",
  ["bun run typecheck", "npx oxlint", "bun run build"],
  { run = "./dist/flowryn doctor --contracts --verify-only --harness claude", when_changed = ["src/lifecycle/**", "src/harness/**", "src/contracts/**", "src/reconcile/**", "src/bridges/**", "src/policy/**", "src/runtime/**", "package.json", "bun.lock"] },
  "bun run test:unit",
  "bun run test:integration",
]
verify_binary = "dist/flowryn"
```

The globs list the code a worker's launch, hooks and steer channels run through. A change there can break what the contract suite proves, and a change elsewhere (docs, tests, the CLI, verify itself) cannot. Add `--harness pi` as a second table with the same globs if you verify Pi too.

- **Changed files** are read once per verification, and only when some step has globs: `git merge-base refs/remotes/origin/<base> HEAD`, then `git diff --name-only --no-renames -z`. A rename therefore counts both paths. `<base>` is the PR's base branch (read from GitHub when the request starts). Local-only work has none, so the base is origin's default branch (`origin/HEAD`), else `origin/main`. When git cannot say (no merge base, an unknown ref), the step **runs**, with `ran: the changed files are unknown (…)` in its detail. A stale `origin/<base>` only widens the diff, so more steps run, never fewer.
- **Globs** (`src/verify/changed.ts`) are compiled to an anchored RegExp and never handed to a shell. They support `**` as a whole segment, `*` and `?` within a segment, `[...]` and `[!...]`, and one level of `{a,b}`. The config refuses at load (`config_invalid`, naming the glob and why) an empty, absolute, `..`, unbalanced, nested-brace or backslash glob, a `**` inside a segment, an empty or non-list `when_changed`, a table without `run`, and an unknown key.
- **Policy identity.** A step with globs hashes as `{ run, when_changed }`, so adding or changing globs is a new policy, because a pass that skipped a step proves less. A list without any globs hashes exactly as before.
- The snippet shown for a project without verify steps now puts `bun run build` in the first group, before `bun test`.

## The build stage runs only affected tests

The build skill (`src/skills/stages.ts`) now says to run the tests the change affects (`bun test --changed=origin/main` for bun), plus the type checker and the linters, and not the whole suite. The project's verify is the single full run.

## no-mistakes

Its test step is configured outside this repo. Set it to `bun test --changed=origin/main` (or `bun run test:unit`), not the full suite, since verify runs that afterwards.

## Timings

Runs on the shared 12-core Mac, with other sessions' go test matrices, a qemu VM and another worker running at the same time (load average 28–48):

| Run | Command | Wall | Result |
| --- | --- | --- | --- |
| before | `bun test` (v146, v148) | 25–27 min | serial |
| 1 | `bun test --parallel=8` | 9 min 51 s | 29 timeouts at bun's 5 s default |
| 2 | `bun test --parallel=12 --timeout=30000` | 11 min 35 s | 7 failures, all in the files now serial |
| final 1 | `bun run test` | 10 min 27 s | 3186 pass, 0 fail (unit 88 s, integration 431 s, serial 108 s) |
| final 2 | `bun run test` | 11 min 35 s | 3186 pass, 0 fail (unit 94 s, integration 491 s, serial 110 s) |
| final 3 | `bun run test` | 11 min 10 s | 3186 pass, 0 fail (unit 90 s, integration 471 s, serial 110 s) |

That is about 2.3 times faster than the serial suite, not the 5 min target. These runs shared the CPU with other sessions, and bun used about 2.8 cores on average. The unit part (about 1.5 min) is the fail-fast window. One more flake turned up under load and was fixed: `upkeep-build`'s build-guard test slept 300 ms before checking that a build was under way. It now waits for the build's first step.

## Tests

- `test/unit/verify-when-changed.test.ts`: config tables and groups; refusals of bad globs and bad tables; the policy identity (unchanged without globs, different with them); the glob matcher table; a match runs the step; no match skips it with the reason and a `pr.verify_step` event; a skip does not stop a later failure; renames count both paths; unknown changes run the step; the fallback to origin's default branch.
- `test/unit/test-runner.test.ts`: the plan (each directory without its serial files, then those files), that the serial files exist, the worker count, and the combined summary read by verify's parser.
- `test/integration/auto-contract-{pass,stop,strict}.test.ts`: the old file's five tests, unchanged in what they assert.
