# Deterministic "silent tool" tests in external-ops

- Status: done

`test/unit/external-ops.test.ts` gives each of the daemon's long-lived external operations a peer that never answers and checks that the call fails within its budget, that the descendant the peer started (a sleeper whose pid it writes) is gone, that the ownership ledger is empty and that an unrelated process is alive. The cases failed on most runs on the Mac: 7 of 8 unloaded runs of the file before this change had one to four failing cases, each an `ENOENT` on the sleeper's pid file.

## Cause

Every case writes its fake tool as a new script in a new temp directory. On macOS the first exec of a freshly written script waits on syspolicyd: measured here at 130 to 270 ms unloaded, against 6 to 19 ms for a second exec of the same file and 5 to 43 ms for `/bin/sh -c`. Under load it is longer. The call's 300 ms deadline counts from the spawn, so it often fired before the script had started its sleeper: the group kill then ended a shell that had not forked anything, and the case failed reading a pid file nobody wrote. A pass in that race proved nothing about descendants either way.

## Design

The deadline under test is decoupled from exec latency rather than raised.

- `gateDeadlines(gate)` in `src/runtime/bounded.ts` (tests only, like `configureOwnedProcesses`): while a gate is set, each `runBounded` call arms its deadline when the gate's promise settles instead of at spawn. The gate gets the call's pid, label and `exited` promise. A leader that exits before the gate settles is never cut off, a gate that rejects still arms the deadline, and `null` restores the deadline from spawn. Nothing in `src/` sets a gate, so the daemon's behaviour is unchanged: with no gate the deadline is armed synchronously, as before.
- `fromReady(pidFile, work)` in the test file is the readiness signal: its gate resolves once the fake's pid file holds a whole pid line (or its leader exits, or a 20 s cap passes), and it times the call from the pid file's mtime, the moment the peer was up and silent. It throws when the pid file was never written, so a case cannot pass without the sleeper it checks.

What each case proves is unchanged: the same 300 ms deadline, the same budget (deadline + grace + drain + group confirmation + slack), the same settled checks. Only the start of the clock moved, from "the OS began exec'ing the script" to "the peer is silent". The budget is measured from that same point, so exec latency can no longer push a passing call over it either. The docker-helper case (a normal exit with a helper holding the pipes) is timed from its helper's pid write the same way.

Rejected: raising `TIMEOUT_MS` (exec latency under load has no bound, so any value only moves the race); warming each script with a throwaway exec first (cuts the latency to ~10 ms but does not remove the race under load); retrying a case until its tool started in time (probabilistic).

No model is involved: a promise gate and a file poll.

## Tests

- `test/unit/bounded.test.ts` "gateDeadlines": the deadline counts from the gate's resolution and the gate is told which call it holds; a leader that exits while its gate holds is never cut off; a rejecting gate still arms the deadline; `null` restores the deadline from spawn.
- `test/unit/external-ops.test.ts` "fromReady": a tool that never writes its pid file fails the case rather than passing without its sleeper.
- Proof: 20 consecutive runs of the file, all passing, while the full `bun test` ran in parallel (results in the PR).

## Open questions

- Should other tests that race a short deadline against a freshly written script use the gate too? Recommendation: only when they are seen to flake; `bounded.test.ts` uses `/bin/sh -c`, which is not affected.
