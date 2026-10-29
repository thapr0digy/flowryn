# ps is bounded, and a failed ps is unknown

- Status: done

Every liveness read goes through `ps`: the reconciler's "is the worker alive", `terminate`'s checks before and after each signal, the leader lease's stale test, reaping leaked processes, launch and resume recovery, the ledger recovery at startup, and the Lavish poller's sweep of leftover polls. Before this change `psRunnerAt` (`src/runtime/proc.ts`) spawned ps with no deadline and returned whatever it printed, so a hung ps stalled the caller and a failing ps (empty output) read as "every process gone": the reconciler could resume a live worker, the lease could be taken from a live holder, and `terminate` could report a process gone that it never verified. Found by the efficiency scout (docs/notes/2026-10-13-next-steps-md-xm.md, "Left open"). Plain code, no model.

## What a ps answer means now

- **Bounded.** Each ps call runs through `runBounded` with a 5 s deadline (`PS_TIMEOUT_MS`): `psRunnerAt`, `readProcessTable` and the poller's sweep. In the daemon it gets its own process group and an ownership ledger entry like any other external command.
- **Three answers.** `psAnswer` reads a bounded result: exit 0 is the table; exit 1 with nothing on stdout or stderr is "none of these pids" (what macOS ps and procps both do for a pid that is not running); anything else (an error on stderr, 124 timed out, 125 overflowed, 127 cannot spawn, a signal) throws `PsUnavailable`. `readIdentities` also throws it for a row that does not parse, since that row could be any pid asked about.
- **`PsRunner` contract.** A runner returns the rows of the live pids (or "") and throws `PsUnavailable` when it cannot say. `isAlive` and `readIdentity` pass the throw on; `aliveOrUnknown` turns it into `null` for callers that branch on it.

## What each reader does with "unknown"

- **Reconciler**: the run's liveness is `unknown` for the pass (as for a Herdr error); it is never judged dead, resumed or orphaned.
- **`terminate`**: a pid ps cannot vouch for is never signalled. A failure before SIGTERM returns `{ ok: false, evidence: "unknown", signal: "none" }`; a failure on the re-check before SIGKILL sends no SIGKILL (`signal: "SIGTERM"`); a failed read while waiting is waited through; reads still failing after SIGKILL report `unknown`, not `timeout`. `exitRun` reports it as not verified, so a cancel escalates rather than confirms.
- **Interrupt**: refused with "whether the worker runs is unknown", not "the worker is not running".
- **Lease**: a silent holder ps cannot read stays `held`; only a holder proven gone is `stale`.
- **Leader cwd** (`processCwd`): `null`, "cannot be read".
- **Reaping** (`reapUnder`): `identity_unverified`, and nothing more is signalled.
- **Launch and resume recovery** (`Operations`): the candidate is `unknown` for the pass; it is neither adopted, escalated nor started again.
- **Herdr `harnessProcess`**: polls on through a failing ps; one still failing at the launch deadline is thrown (the launch fails with ps's reason), never read as "no harness appeared".
- **Owned-process recovery** (`recoverOwnedProcesses`): already kept an entry whose ps fails as `failed`; a `terminate` that cannot verify now lands there too.
- **Lavish sweep** (`src/lavish/poller.ts`): the records are read on the first pass, and no poll starts until the sweep is done, so an orphan never polls beside a new one. A record whose ps fails is not killed and is kept as `<gate>.<ms>.unchecked.json`, a name no poll of this daemon writes, so the next start checks it again; a record checked and found gone is removed.
- **`flowryn lead attach`**: a ps failure is an error reply rather than `not_found`.

## Tests

`test/unit/ps-unknown.test.ts` (exit codes, a failing, hung and garbled ps, `terminate` at each step, reaping, the leader cwd, the Lavish sweep keeping and later clearing a record), and one case each in `reconciler.test.ts`, `operations.test.ts`, `interrupt.test.ts`, `lease.test.ts` and `runtime.test.ts` (`harnessProcess`). `gate-questions.test.ts`'s sweep case now waits on `poller.swept()`.

**Migration.** None.
