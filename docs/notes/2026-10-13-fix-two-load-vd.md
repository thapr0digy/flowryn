# Two load-sensitive flaky tests

- Status: done

Two tests failed in a full-suite run on 2026-10-13 and passed alone. Each gets its real cause found and fixed, with a before/after count under artificial load: `yes` burners (at most 6, at most 10 minutes per burst) alongside the other workers' full suites on the same Mac.

## Design

### 1. "a pinned file replaced in place or removed mid-run fails fast with the reason" (test/unit/contracts.test.ts)

**Cause: macOS, not load and not the product.** The test ran the fake `claude` script once (the pin), rewrote the same file in place with `writeFileSync`, and ran it again. macOS SIGKILLs an exec of a file rewritten in place after it was executed (the "Killed: 9" of overwriting a signed binary; it applies to `#!` scripts too). A standalone probe (run, rewrite in place, run again, a fresh file each round) got exit 137 / SIGKILL with empty output in 24 of 300 rounds with no extra load, and about the same under load; writing a new file and renaming it over the path gave 0 of 300 both ways. `harnessVersion` reads empty output as no version, so `pinDrift` answered "was removed or cannot report its version mid-run" instead of "updated to 2.1.292". The product is right: a binary the kernel kills cannot report a version.

**Fix (test only).** The test now replaces the file the way an updater does: it writes `<file>.new` and renames it over the pinned path, so the pinned path keeps its name and the content changes. The `utimesSync` that keeps the mtime-keyed version cache honest stays.

**Proof.** `bun test test/unit/contracts.test.ts -t "pinned file replaced" --rerun-each 300` under 6 burners plus a looping contracts-offline run: before 30 of 300 failed, after 0 of 300.

### 2. "pi: --model adds an informational real-model pass…" (test/integration/contracts-offline.test.ts)

**What the failure says.** After the `--model` test's doctor exited, the fake Herdr still held pane `w5:p1` with a harness it had not seen exit. Every contract run opens one workspace, so the file's four runs (Claude, Pi, the Pi gate and the real-model pass) use `w1` to `w4` when nothing goes wrong (Herdr call logs of 9 runs of the file, 8 of them beside 6 burners, all 4 workspaces). `w5` means some run opened a second workspace and the run's cleanup did not close it.

**Cause: product, two gaps that let a run's workspace outlive it.**

- *A resume abandons the run's previous workspace.* `Launcher.ensurePane` reuses the run's pane only when `pane.process_info` reads the shell in the foreground; otherwise it opens a new workspace and overwrites `runs.workspace_id`, and nothing ever closes the old one: not the run's cancel or landing (they close `runs.workspace_id`), not the contract runner (it releases `runs.workspace_id`). Right after a harness exits, Herdr can still read the pane's foreground group as the dead harness's until the shell reclaims the terminal, and in the fake the pane reads busy until the test process has reaped the child, which is exactly what lags under load. Injected deterministically (the fake reporting an exited harness for 1.5 s), the file's three resumes each opened a second workspace and left the first open: `w1`, `w3` and `w5` were never closed, and the test, which only counted panes with a live harness, passed.
- *The contract runner snapshots what to release before it stops the scratch daemon.* `runContract`'s cleanup reads the workspace and harness ids from the scratch database, then cancels the run and stops the daemon. A launch or resume still in flight in that window records a workspace and starts a harness the release never hears of. That is a live pane left behind with the cleanup check still "ok", which matches the failure.

The exact interleaving of the failing run is not reproduced: 9 runs of the file under load passed. Both gaps are proved by the code and the first by injection, and each fix below has a test that fails without it.

**Fix.**

1. `ensurePane` closes the run's previous workspace (the guarded `closeWorkspace`, which keeps the user's focus) right after it records the new one. The relaunch happens only once the recorded worker is gone, so whatever still holds the old pane is the dead worker's tail; a worker workspace is the run's own and is closed whole at cancel and landing already. A failed close is logged and recorded as a `run.workspace_close_failed` event, and never fails the launch.
2. The contract runner reads the scratch database again once the daemon has stopped and releases the union with what it noted first (`withScratchIds`, as the daemon's recovery already does). `createdWorkspaces` names every workspace in the run's `run.pane` events, not only the current `runs.workspace_id`, so a workspace a resume replaced is released too if its close failed.
3. `contracts-offline.test.ts` checks that every pane in the fake Herdr is gone after each doctor run, not just every pane with a live harness. A closed workspace's panes are removed when Herdr handles the close, which the doctor awaits before it exits, so the check does not race the fake's child-exit events the way the live-harness check did.

**Tests.** `test/integration/workers.test.ts`: a worker killed while Herdr keeps reading the pane busy (the fake Herdr's new `exitLagMs`) is resumed in a new workspace and the old one is closed; it fails without fix 1 ("timed out waiting for the replaced workspace closed"). `test/unit/contract-owned.test.ts`: `createdWorkspaces` names a workspace only the run's `run.pane` events know, and the release closes it. The runner's re-read has no test of its own: landing a launch between the snapshot and the daemon's stop needs a hook into the runner nothing else wants; it reuses `withScratchIds`, which the recovery tests cover. No `CONTRACT_REVISIONS` bump: nothing here changes harness behaviour the suite proves, only how Flowryn tidies its own workspaces.

**Proof.** The offline contract file with the fake reporting an exited harness for 1.5 s (a temporary knob, not committed): before the fixes all 3 tests fail under the stronger check, leaving `w1`, `w3` and `w5` open (the `--model` test lists all three; `w5` is the name the original failure reported); after, 3 of 3 pass. Under load (6 burners, other workers' suites running) the file passed 9 of 9 before and 4 of 4 after (each run with `workers.test.ts` beside it, 31 tests).
