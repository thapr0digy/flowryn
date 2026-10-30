# A pid too large for the system reads as gone

- Status: done

Since `ps` calls got a deadline (docs/notes/2026-10-29-ps-calls-get-7p.md) a ps that exits 1 with anything on stderr reads as unknown. macOS ps answers a pid above `kern.pid_max` (99998) with exit 1 and `ps: process id too large: <pid>`, and it aborts the whole read, so the other pids asked about go unread too. That made the cleanup-order fixture `process_exit_during_identity_lookup_does_not_refuse` (lsof reports pid 99999998, which no process can hold) refuse with `identity_unverified` on macOS instead of reading the process as exited. procps on Linux prints nothing for such a pid and exits 1, which already read as gone.

`pidsTooLarge` (`src/runtime/proc.ts`) recognises exactly that answer: one such line per refused pid, nothing else on stderr or stdout. `psRunnerAt` then drops the refused pids as gone and asks ps again about the rest, so impossible pids never hide the others; a refusal naming a pid that was not asked about, or any other stderr, still throws `PsUnavailable`. The Lavish poller's leftover-poll sweep, which calls ps itself for one pid, reads the same answer as "not that poll". Plain code, no model.

Tests: `test/unit/ps-unknown.test.ts` "a pid above the system's limit is gone, not unknown" (the parser, the real ps on each platform with one and with two too-large pids, a fake macOS ps with mixed pids, a refusal for an unasked pid, and a darwin-only check of the assumption that macOS ps refuses every pid when one is too large). Both fixture sets pass on macOS.
