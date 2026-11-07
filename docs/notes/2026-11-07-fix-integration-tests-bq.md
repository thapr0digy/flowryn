# Integration tests get a 60 s per-test timeout

- Status: done
- Open: the v179 operations.test.ts failure (its tests already set 90 to 120 s) is unexplained; its log was pruned

On 2026-11-07 verifies v179, v180 and v181 each failed one different integration test at about 5.1 s (operations.test.ts resume-twice, queued.test.ts `--task` restart, accounts usage-limit). All pass alone. Three worker suites ran beside the verify, so it took about twice as long. The project's verify step runs plain `bun test`, not `bun run test`, so these tests got bun's 5 s default, not the 30 s that `scripts/test.ts` passes, while their own `waitUntil` deadlines allow 10 to 30 s. A loaded host failed them on bun's timeout before their own waits could.

## The change

- `test/helpers/integration-timeout.ts`: `INTEGRATION_TEST_TIMEOUT_MS` (60 s) and `useIntegrationTimeout()`, which calls `setDefaultTimeout`.
- Every `test/integration/*.test.ts` calls `useIntegrationTimeout()` at its top level, after its imports. A test that sets its own timeout keeps it.
- Unit tests keep a short timeout: bun's 5 s under plain `bun test`, and 30 s under `bun run test`'s `--parallel` part. The one exception is a single slow git test (see Load run).
- Plain code, no model, no assertion touched.

Why each file calls the helper itself (measured on Bun 1.4.4): `bunfig.toml` ignores a `timeout` key. `setDefaultTimeout` applies only to the file whose top-level code runs it. A preload, or a call in a helper module's body, runs once per process, so it reaches only the first file that loads it. A call from each file's own top level reaches that file, with or without `--parallel`, and wins over `--timeout`, so `bun run test` gives integration files 60 s too.

60 s, not 30 s: the longest literal `waitUntil` deadline in a test that relies on the default is 30 s (policy-follow, restart-ci-wait, validation-stuck). At a 30 s timeout, bun's timeout would tie that wait and hide its named error.

## Measure

A static pass over `test/integration` (each test's literal `waitUntil` deadlines against its explicit timeout) on 2026-11-07:

- 198 tests have an inner wait longer than 5 s. 147 set their own timeout, and none of those is shorter than its longest wait. 51 relied on bun's 5 s default. Their longest waits run 10 to 30 s, and all are now covered by the 60 s default.
- The helpers' default deadlines (`fleet.waitRun` and `pty`, each 20 s) are under 60 s too.
- The verify logs agree for two of the three failures. v180 failed `queued.test.ts` "a queued task whose run failed can be started again with --task" at 5124 ms, and bun killed its 2 dangling processes. v181 failed `accounts.test.ts` "a usage limit on one account…" at 5054 ms: its CLI call ended with exit 143 when bun stopped the test. Both relied on the 5 s default, with inner waits of 10 to 15 s.
- v179's log has been pruned. `operations.test.ts`' "the same resume request twice" test already sets 120 s, and every test in that file sets 90 to 120 s, so a 5.1 s failure there was not bun's per-test timeout. That one is left for a separate look if it recurs.

`test/unit/integration-timeout.test.ts` keeps this true. It fails when an integration file does not call `useIntegrationTimeout()`. It also fails when a file has a `waitUntil` deadline at or past 60 s and no explicit test timeout longer than that deadline. The second check is per file and coarse on purpose, so it never misreads a test body.

## Load run

The host's load average was 29 (other sessions were also running). Two suites ran side by side: `bun test --parallel=4 --timeout=30000 test/integration` and `bun test test/unit`. Beside them, the three named files were run with plain `bun test`:

- The three named files: 19/19 pass in 84 s.
- The parallel integration suite, serial files included: 547/547 pass in 806 s.
- The plain unit run: 2800/2801. The one failure was `test/unit/landing-queue.test.ts` "a base that moved sends the head of line back…" at 5.96 s. It runs MAX_INTEGRATIONS rounds of real git merges and failed again when run alone while an integration suite ran. That one test now sets 30 s itself. Every other unit test keeps the default.
