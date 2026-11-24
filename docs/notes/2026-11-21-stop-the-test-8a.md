# The test suite leaves no processes behind

- Status: done
- Open: the SIGINT and SIGKILL interrupts of a full run were checked by hand, not by a test of the full suite

On 2026-11-21 the leader found 49 processes from test runs adopted by launchd (PPID 1), 15 to 23 days old: fake `claude --version` stubs, verify and landing-queue gates spinning on a `go` file, `flowryn hook worker-start` from contract homes, a fake harness and a git hook. Their test homes were long deleted. A test that timed out, was cancelled, or force-killed its daemon at teardown left them, since a daemon's verify steps and tool calls lead their own process groups.

## The process guard

`test/helpers/process-guard-preload.ts` is a second `[test] preload`. Each bun test process gets one reaper sidecar (`test/helpers/reaper.ts`), started detached so a Ctrl-C to the terminal does not reach it.

- Every second the reaper reads `ps -axo pid=,ppid=,lstart=,command=` and remembers each process under the test process by pid and start time; it forgets one once it exits. It keeps what it remembers in `$TMPDIR/flowryn-process-guard/<test pid>.json`.
- Every 200 ms it checks that the test process is still its parent. Once it is not (the run ended, Ctrl-C, a verify deadline's SIGKILL), it sends SIGTERM to each remembered process still alive as itself, waits up to 4 s (a daemon under test then ends its own children: its stop grace is 2 s), sends SIGKILL to the rest, and exits.
- After each file (after the whole run, without `--parallel`), once the file's own teardown has run, the preload's `afterAll` looks for processes the tests started that are still alive: those under the test process, and those the reaper remembered that launchd has since adopted. It waits 3 s for stragglers, then ends them and fails the run, naming each with its command line.

Under `--parallel` the preload runs again for each file in the same worker, with fresh globals and a fresh `process.env`, so the state file is what says a reaper already runs (its pid, a child of this process, running `reaper.ts`).

The guard signals only processes it saw under the test process, and only while the pid still carries the start time it was seen with. It never matches names across the system, so a reused pid or the user's own Claude sessions are never touched. `test/unit/process-guard.test.ts` checks this (`signalIfSame` against this test's parent with a wrong start time, and launchd), and runs `test/fixtures/process-guard/leaks.fixture.ts`, a file that leaks a `sh -c` grandchild on purpose, in a bun test of its own: the run fails naming `sleep 30` and the leak is ended; killed with SIGKILL mid-test, its reaper ends the leaked grandchild within seconds.

## The fixes the guard found and the task named

- A fleet's or leader env's teardown kills its daemon with SIGKILL, then `reapOwned` ends the process groups the daemon's ledger (`<state_dir>/owned`) still names, through the daemon's own startup recovery (`recoverOwnedProcesses`), by recorded identity.
- `waitForFileShell(path, { exitWithParent })` (test/helpers/harness.ts) is the wait-on-file loop: it gives up after 60 s, or as soon as the process that started it is gone. The capacity and landing-queue verify gates use it; the pausing tasks-axi wrapper uses it with `exitWithParent: false`, since a crash test means it to outlive its daemon.
- The fake Herdr remembers every harness it spawned, not only each pane's newest, and ends them all at its stop; a start that reaches a stopped server spawns nothing.
- A fake harness exits, with its process group, once the test process that started it is gone.

No production code changed: the daemon already ends its own children at a clean stop (`stopOwnedProcesses`) and recovers a force-killed one's at its next start. The reaper's SIGTERM gives a daemon whose test process died that clean stop.

The fake `claude` stubs only echo a version. The ones found hanging on `--version` were most likely held at their first exec (a freshly written script in a temp directory waits on macOS's policy check) when their daemon was force-killed: the ledger reaping and the reaper end them now.
