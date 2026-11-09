# Verify in under 15 minutes: the parallel runner in this home's verify

- Status: done
- Open: the leader applies the block below and `[capacity] validation = 1` to `~/.flowryn/config.toml` after the merge (a worker cannot write it); one `flowryn verify` of this PR under it is the final proof. `contracts-offline` "pi: every step passes…" failed once in the baseline (below) and never again in 19 runs; three tests fail only with two suites at once (below)
- Config: `[projects.flowryn] verify`, `verify_timeout_min`, `[capacity] validation`, `FLOWRYN_TEST_JOBS`

Verify v216 (PR #173) took 31.7 min, 29.1 of them `bun test` run one file at a time. `bun run test` (docs/notes/2026-11-06-fast-tests-parallel-36.md) existed, but this home's verify never used it. This change measures it on this Mac, makes its last part faster, refreshes its timings, and gives the exact verify block, the test workers and the validation cap, from the measurements. Plain code and measurements; no model.

## What changed

- **The serial files run side by side among themselves** (`scripts/test.ts`, `plan`): after each directory's parallel part, its `SERIAL_FILES` run as `bun test --parallel=<the fewer of the jobs and the files>`, not one at a time. They still run only after the busy part, so nothing else shares the CPU. The 2026-11-06 note found they hold their windows beside each other and miss them only beside a dozen daemons. The integration serial part took 95–209 s before (fix-the-four-3w) and 25 s here, in each of 13 runs. The unit serial part is one file, so it is unchanged.
- **test/timings.json is refreshed** from a parallel run (`bun scripts/test.ts --update-timings`). It listed 213 of the 244 files, so the 31 newest started last.
- **`src/verify/recommended.ts`** holds the block below as data (`recommendedVerifyToml`, `WORKER_PATH_GLOBS`, `VERIFY_TEST_JOBS`, `VERIFY_VALIDATION_CAP`, `VERIFY_TIMEOUT_MIN`). Nothing reads it at runtime. `test/unit/verify-recommended.test.ts` checks this note against it and its globs against the code.
- **`gate-questions`' secret scan tolerates a file the daemon removes meanwhile.** "Send and pass with no code…" (and the pass-key test after it) listed the home's files, then read each one. Between the two, the daemon removed a finished command's `state/owned/<pid>.json` (`runBounded`), and the read threw ENOENT. A file gone since the listing now holds nothing. One that is present is still read, and any other error still fails the test. This was seen twice, both with two suites at once, but the window exists at any load.

## The recommended verify block

```toml
[projects.flowryn]
verify = [
  "bun install --frozen-lockfile",
  ["bun run typecheck", "npx oxlint", "bun run build"],
  [
    { run = "./dist/flowryn doctor --contracts --verify-only --harness claude", when_changed = ["src/**", "spikes/pi/lib/**", "scripts/build.sh", "package.json", "bun.lock", "bunfig.toml", "tsconfig.json"] },
    { run = "./dist/flowryn doctor --contracts --verify-only --harness pi", when_changed = ["src/**", "spikes/pi/lib/**", "scripts/build.sh", "package.json", "bun.lock", "bunfig.toml", "tsconfig.json"] },
  ],
  "FLOWRYN_TEST_JOBS=8 bun run test:unit",
  "FLOWRYN_TEST_JOBS=8 bun run test:integration",
]
verify_binary = "dist/flowryn"
verify_timeout_min = 30
```

and

```toml
[capacity]
validation = 1
```

Replace only `verify`, `verify_binary` and `verify_timeout_min` in `[projects.flowryn]`; keep `landing = "queue"` and the rest.

Each step, and why:

1. **`bun install --frozen-lockfile`** first: every later step needs the dependencies, and a frozen install refuses a lockfile that drifted from package.json.
2. **Type check, lint and build in one parallel group**: they are independent and take about 2 s together here. A type or lint error fails the verify in seconds. The build is in this group because the contract checks need `dist/flowryn`.
3. **Both contract checks in one parallel group, only when a worker-path file changed** (`when_changed`). They are independent (each has its own scratch home and Herdr workspace), so the group takes the longer one's time: 1.9 min (Claude) instead of 2.5 min one after the other (v216's 1.9 + 0.6). They run before the tests and not beside them, so the tests' load never meets the contract suite's own steer windows.
4. **`bun run test:unit`, then `bun run test:integration`**: unit fails fast (about 1.2 min), integration is the long part (about 6 min). `FLOWRYN_TEST_JOBS=8` is in the command, not left to the runner's default (the same 8 on this 12-core Mac), so the pairing with the cap shows in config. Steps run through `/bin/sh` (`src/verify/runner.ts`), so the prefix works.
5. **`verify_timeout_min = 30`**, down from 75: twice the target, so a hung step is caught in half an hour, and a loaded run is not cut.

Estimated full verify on this Mac: install and the cheap group under 1 min, contract checks 1.9 min when they run, tests 7.1 min, about 9.5–10 min in all. It is under 15 min with room for load.

### The contract checks' globs

The 2026-11-06 note's list (`src/lifecycle/`, `src/harness/`, `src/contracts/`, `src/reconcile/`, `src/bridges/`, `src/policy/`, `src/runtime/`, package.json, bun.lock) was too narrow. `flowryn doctor --contracts` starts a scratch daemon. Through it, the contract runner imports nearly every `src/` folder: config, db, api, daemon, sched, attention, transport, service, skills, lavish, verify and others. A worker also calls the CLI verbs. An import walk from `src/main.ts` (the binary) also reaches `spikes/pi/lib/scripted-provider.ts`, the Pi gate's scripted model. So the globs are all of `src/`, that directory, the build script, and the files the build and the dependencies read. A PR that changes only docs, tests, fixtures, other spikes or scripts skips the checks. Its skip reason shows in the verify (`skipped: none of the N files changed…`).

`test/unit/verify-recommended.test.ts` fails when:
- a file under any worker-path directory that AGENTS.md names, or package.json or bun.lock, matches no glob;
- a file in the import closure of `src/main.ts`, `src/contracts/` and `src/bridges/` matches no glob (this caught `spikes/pi/lib`);
- a docs, test or scripts change would run the checks;
- the block does not load through the real config reader with the expected steps, groups and globs;
- this note's block differs from `recommendedVerifyToml()`.

## Two at once: the cap and the test workers

`[capacity] validation` is shared by ship stages, which hold a slot from stage start until delivery, and by verifies. A ship stage releases its slot when it delivers, before its PR's verify starts, so a cap of 1 never blocks a ship's own verify. With a cap of 1, a verify and another ship's no-mistakes pipeline wait for each other too. The suite is CPU-bound here, so the measurements below favour that:

| Setup | Runs | Tests wall | Failures | Load (median) |
| --- | --- | --- | --- | --- |
| one at a time, N=8 | 6 | 422–430 s | 0 | 20–25 |
| one, N=6 | 1 | 450 s | 0 | 14 |
| two at once, N=6 each | 2 pairs (4 runs) | 778–832 s, stopped at the failure | 5 in 4 runs | 36–44 |
| two at once, N=8 each | 1 pair (2 runs) | 827–829 s, stopped at the failure | 3 in 2 runs | 50 |

Two suites at once took about 13.8 min each, so they finished no sooner than two in a row (2 × 7.1 min), and every one of them failed. Fewer workers per verify do not help: the same CPU work shares the same 12 cores, and two at N=4 would load the Mac like one at N=8 and take about twice as long each. So the recommendation is **one verify at a time (`validation = 1`) with 8 test workers**. At N=8 alone the load stayed at a median of 20 with no failure. The 2026-11-07 reason for lowering the cap (five full-suite verifies at once caused timeout flakes) still holds at two.

The cost: with `validation = 1`, a ship stage's no-mistakes pipeline and a verify do not overlap. If that queues ships too long, the fix is a verify-only pool, separate from ship stages, at 1. That is a code change, not made here. no-mistakes' own test step should be `bun run test:unit` or `bun test --changed=origin/main` (2026-11-06 note), not the full suite, which would load the Mac like a second verify.

The failures seen only with two suites at once, all deadline waits that ran out under a load of 36–68:
- `workflows` "changes at the QA review…": the first QA review not reached in 20 s (3 times; fix-the-four-3w saw it under load too).
- `prompt-wedge` "claude: permission_prompt opens one P1…" (2) and "claude: Herdr status "idle" releases the item only on its second consecutive pass" (1).
- `gate-questions` "Send and pass with no code…" (2): the ENOENT race, fixed above.

The first three are left as they are. Under the recommended cap they never failed, in 7 runs here and 18 in fix-the-four-3w. Lengthening their deadlines would only hide a setup this note recommends against.

## Timings

All runs on the shared 12-core Mac, outside the sandbox. A run's parts are: unit parallel, unit serial, integration parallel, integration serial. Bun reports 3666 tests across 244 files.

| Run | Command | Wall | Parts | Result | Load (min–max, median) |
| --- | --- | --- | --- | --- | --- |
| before | `bun test` (v216) | 29.1 min | serial | pass | – |
| before | `bun run test`, N=8 (fix-the-four-3w, 2026-11-08) | about 11–14 min | 92–122 s, –, 469–531 s, 95–209 s | pass | median 40 |
| baseline | `bun run test`, N=8, this branch before the change | stopped at 7.4 min | 53 s, 11 s, 378 s, – | 1 fail: `contracts-offline` pi | 7–41 |
| refresh | `bun scripts/test.ts --update-timings` | 430 s | 60 s, 11 s, 333 s, 25 s | pass | 15–34, 25 |
| 1 | `bun run test` | 426 s | 63 s, 11 s, 326 s, 25 s | pass | 14–29, 20 |
| 2 | `bun run test` | 427 s | 65 s, 11 s, 326 s, 25 s | pass | 12–34, 21 |
| 3 | `bun run test` | 426 s | 63 s, 11 s, 327 s, 25 s | pass | 14–31, 21 |
| 4 | `bun run test` | 425 s | 63 s, 11 s, 325 s, 25 s | pass | 12–35, 21 |
| 5 | `bun run test` | 422 s | 63 s, 11 s, 324 s, 25 s | pass | 14–31, 21 |

The five consecutive runs: 5 pass, 0 fail, 7.0–7.1 min each, against 29.1 min serial. The slowest files in the refreshed timings are `workers` (139 s), `auto-contract-wait` (117 s), `workflows` (109 s) and `delivery` (105 s). Each is well under the integration part's 325 s, so no file sets the finish time, and none was split.

### The baseline's Pi contract failure

The baseline run failed `contracts-offline` "pi: every step passes and the version is recorded": the temp-dir step's steer m7 was seen at +279 ms but not acknowledged within 15 s. fix-the-four-3w saw the same step fail once under load and left it open. To reproduce it, the fake Pi was given temporary logging of each model request, script position, abort and command exit (not committed). The test then ran 12 times, 4 at a time, beside a parallel integration run, and passed 12 of 12. It passed in the 7 one-at-a-time suite runs above as well (19 in all). It stays open, with what to log next time: the fake's script position at each request, and the exit of the `ack` command (the fake ignores both).

## Tests

- `test/unit/test-runner.test.ts`: the integration serial part is `--parallel=5` over its five files; the workers are the fewer of the jobs and the files; the one-file unit serial part runs without `--parallel`.
- `test/unit/verify-recommended.test.ts`: the list under "The contract checks' globs", and that this note's cap is the code's.
- `test/integration/gate-questions.test.ts`: the secret scans read through `holding`, which treats only ENOENT as not holding.
