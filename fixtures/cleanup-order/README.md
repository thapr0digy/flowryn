# Cleanup-order fixtures

This is the second cleanup-guard fixture set (`docs/design-v3.html`, section
14: "A second fixture set, for M4, ports the index-lock cases (stale lock
cleared, live lock never removed, lookup errors refuse) and the process-reap
and parked-run-abort ordering cases"). The first set, in
[`../cleanup-guard`](../cleanup-guard), decides whether a worktree's work has
landed. This set checks what a cleanup *does* once that verdict allows it:

1. A git `index.lock` left in the worktree is waited for, removed only when it
   is provably stale (old, and `lsof` proves nothing holds it), and the
   worktree is inspected again afterwards. A live or unprovable lock stays, and
   the cleanup refuses.
2. The task's own no-mistakes run, parked at a gate, is aborted before the
   worker goes, and only when it is proven its own (its branch, and a head that
   is the worktree's HEAD or a descendant of it). Another branch's run, or one
   still executing, is never touched. The abort is confirmed by reading that
   run back; anything but a terminal outcome or the CLI's exact "not found"
   refuses.
3. Leaked processes whose working directory is inside the worktree are
   reaped by identity (their start time), SIGTERM then SIGKILL, never a reused
   pid, in bounded passes. A scan that fails refuses before anything is removed.
4. Only then is the worktree removed: the abort precedes the reap, which
   precedes the removal.

Every refusal must leave the worktree, its branch and its HEAD exactly as they
were.

## Where they come from

The cases are ported from Firstmate's `tests/fm-teardown.test.sh` at commit
`a09090d1`, the same revision as the first set. Each `manifest.json` names its
source test (`ported_from`) and, for the lock cases, the row of that file's
header matrix. Firstmate returns its worktree through `treehouse return
--force`, which fails on a present `index.lock`; Flowryn removes a linked
worktree with `git worktree remove`, which would delete a lock silently (the
lock lives in the worktree's admin directory). So a Flowryn guard checks the
lock itself before removal, and these fixtures test that check rather than a
retry around the removal.

Not ported, deliberately:

| Firstmate test | Why |
|---|---|
| `test_non_linked_index_lock_path_is_checked_from_worktree` | Flowryn worktrees are always linked worktrees. |
| `test_index_lock_mtime_read_failure_refuses` | Firstmate skips it on macOS (its fault injection cannot reach `/usr/bin/stat`). |
| `test_empty_retry_wait_uses_default_without_aborting`, `test_fractional_legacy_retry_wait_refuses_without_arithmetic_error` | Firstmate's environment-variable parsing; Flowryn's clocks are typed config. |
| the runs-ledger family (`test_parked_run_advanced_past_unfetched_head_is_still_aborted` and the eleven "never aborted" ledger cases) | Flowryn does not port the `no-mistakes runs` ledger fallback: a parked run whose head this copy cannot resolve is left alone, never aborted, which is the conservative side of every one of those cases. |
| `test_leaked_tasktmp_process_is_reaped` | Flowryn has no per-task tmp directory. |
| `test_lsof_absent_reaps_tmux_process_group` | Flowryn stops the worker's own process group by its recorded identity before the reap; there is no tmux pane group. |
| the legacy-record, secondmate and Herdr-projection cases | No Flowryn counterpart (section 14 says so for the first set too). |

## Layout

```
run.sh                        runner (validation, and --impl mode)
lib/order-common.sh           shared builders: the first set's git builders plus fakes and runtime helpers
lib/fakes/                    fake no-mistakes, lsof variants, ps rules, git wrappers
<case>/manifest.json          inputs and the expected outcome and state
<case>/build.sh               build.sh <out-dir>: the git state and the case's fakes
<case>/setup.sh (optional)    setup.sh <scenario-dir>: runtime state (locks, processes, no-mistakes answers)
```

A built scenario is the first set's layout (`origin.git/`, `primary/`,
`worktree/` on `fm/task-x1`, `scenario.json`) plus:

| Path | What it is |
|---|---|
| `bin/` | fakes first on the implementation's `PATH`: always `no-mistakes` (the real one is a shared daemon and must never be reached), and per case `lsof`, `ps` or a `git` wrapper |
| `nm/` | the fake no-mistakes' answers (`status`, `after-abort`) and its `abort.log` |
| `runtime/` | what `setup.sh` started: `pids` (killed by the runner when the case ends), `watch-pids`, `lock-path`, `order.log` |
| `tuning.json` | the clocks the implementation should use: `lock_age_ms`, `lock_wait_ms`, `lock_retries`, `reap_grace_ms`, `reap_passes`, `nomistakes_timeout_ms` |

The fake `ps` answers the forms a guard may use for a start time:
`ps -o pid=,lstart=,comm= -p <pids>` (Flowryn) and `ps -p <pid> -o lstart=`
(Firstmate).

## Implementation contract (`run.sh --impl '<command>'`)

For each case the runner builds a fresh scenario, runs `setup.sh`, then runs
`<command> <scenario-dir>` with the scenario as the working directory,
`<scenario>/bin` first on `PATH`, and `FLOWRYN_SCENARIO` and `FLOWRYN_TUNING`
pointing at `scenario.json` and `tuning.json`. The implementation performs a
whole cleanup of `paths.worktree` (a linked worktree of `paths.primary`) and
prints one JSON object:

```json
{"outcome": "removed|refused", "reason_class": "<slug>", "lock": "none|cleared|cleared_by_itself|kept"}
```

The runner then checks, from the manifest's `expected`:

- `outcome`, and `reason_class` when the implementation reports one;
- after a refusal, the worktree is still there on `fm/task-x1` at `local_head`;
  after a removal, the worktree and the task branch are gone;
- `lock`: the index.lock is `present` or `absent` afterwards;
- `abort`: `no-mistakes axi abort --run 01RUN` was called, or no abort was;
- `processes`: every watched process is `dead` or still `alive`;
- `impl_lock`: the implementation's own `lock` report (a transient lock must
  clear by itself, not be removed);
- `order`: what the git wrapper saw at the moment `git worktree remove` ran.

Every process a case starts is killed when the case ends, and on any exit.

## Running

```sh
fixtures/cleanup-order/run.sh                                                    # validate every case
fixtures/cleanup-order/run.sh --impl "bun $PWD/scripts/guard/cleanup-impl.ts"    # Flowryn's guard
fixtures/cleanup-order/run.sh --case leaked_worktree_process_is_reaped --keep    # one case, keep the build
```

Requires bash, git 2.38 or newer, jq, perl and lsof (macOS has it).
