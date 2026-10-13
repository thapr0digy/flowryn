# Guarded observation transitions: liveness and the automatic resume

- Status: partial
- Open: the same guard for observations that affect delivery or stage progression (docs/next_steps.md package 2, later slices). The reconciler's re-drive of an unfinished launch now goes through its operation (docs/notes/2026-10-13-next-steps-md-rz.md)

docs/next_steps.md package 2, first slice. The reconciler reads a run, awaits
Herdr, `ps` and the harness gate, then writes liveness, releases leases or
claims the one automatic resume by run id. A hook, a cancellation or a
replacement worker that lands during those awaits was overwritten by the older
observation, and a cancelled run could still have its resume claimed.

## Design

**One guard, owned by the lifecycle.** `src/lifecycle/observed.ts` exports
`observedTransition(db, seen, transition, source, now, apply)`. It opens the
transaction, re-reads the run and compares it with `seen` (the row the
observation started from) on the fields the observation's decision depends on:

| Group | Fields |
|---|---|
| Lifecycle state | `state`, `stage_state`, `pending_launch`, `resume_count`, `liveness` |
| Worker identity (the generation) | `proc_pid`, `proc_start`, `launched_at`, `worker_started_at`, `pane_id`, `agent_session` |
| Hook watermark | `last_hook_at`, with the lease fields every hook writes beside it: `busy_until`, `idle_since` |

When the run is gone, terminal, or any of those differ, nothing of the
transition is written: one `run.observation_stale` event records the
transition's name and each changed field (seen and current value), and the
caller gets `{ applied: false }`. Otherwise the fresh row is copied onto
`seen` and `apply(seen)` runs in the same transaction, so the state change,
its event, task intents, items and lease releases still commit together.

**No new column.** The existing fields already identify a worker generation:
every launch writes `launched_at` and a new `proc_pid`/`proc_start`, and a
fresh-stage replacement also mints a new `agent_session` and clears
`worker_started_at`. `last_hook_at` is a millisecond time, so two hooks in one
millisecond can leave it equal; they still change `busy_until`, `idle_since`
or `liveness` unless they wrote exactly what was there, in which case every
input to the observation's decision is unchanged and applying it is correct.
Package 1's operation identity is not used here.

**Stale is skipped, not retried.** A rejected observation is simply dropped:
the next pass (or the reconcile the hook, cancel or launch already schedules)
reads the newer state. A rejection never opens an item; it is an event so the
race is visible in `flowryn show`/the event log.

**Where it applies (this slice).**

- Reconciler liveness writes: Herdr unreachable or no foreground group
  (`unknown`), `orphaned` with its divergence, the live checks (starting,
  trust wedge, busy/idle, the suspected-prompt backstop, the dialog-gone
  release, idle and stale-hook pointers), a delivered run's worker exiting,
  and the final `dead`. Each is one named transition (`unknown`, `orphaned`,
  `live_checks`, `exited_after_delivery`, `died`). Process and Herdr evidence
  stay unguarded: they are what was observed at that time, and only the
  reconciler writes them.
- The automatic resume: `claimAutoResume` and `deferAutoResume` move from the
  reconciler into `src/lifecycle/auto-resume.ts` and run through the guard
  (transitions `auto_resume`, `auto_resume_deferred`). The worker is launched
  only after a claim committed; the existing `resume_count` compare stays as
  a second check. The idle carry (typing a steer into the pane) runs only when
  that pass's live checks applied.
- Wait explanations (docs/notes/2026-10-12-next-steps-md-wz.md) that these
  transitions write (the trust and dialog holds, the dismissed-dialog close,
  `resume.auto`, `resume.deferred`, `resume.refused`) are written inside the
  guarded transition, so a rejected stale observation records no explanation.
- `UrgentPreempter.releasedPrompt` (the cancel path's dialog-gone release) is the
  one other await-then-write of liveness; it goes through the guard too
  (`dialog_gone`).

Hooks keep calling `setLiveness` directly: a hook verb reads its run inside the
gateway's apply transaction and writes current truth, not an older
observation. `setLiveness` stays the inner write that the guarded transitions
and those in-transaction callers share.

**Not in this slice.** Delivery and stage-progression observations, the
scheduler's own transitions, the launcher's identity write, a repository layer
over run SQL. One await-then-launch stays unguarded: a run still `launching`
with no worker identity (the daemon died mid-launch, or Herdr was down) is
re-driven with a fresh launch after the reconciler's harness check
(`Reconciler.reconcileRun`). The launcher's own fresh-launch checks refuse a
terminal or already-identified run, but recovering that launch as an operation
belongs to package 1's operation identity, which now does it
(docs/notes/2026-10-13-next-steps-md-rz.md).

## Tests

`test/unit/observed.test.ts` drives the real `Reconciler` on a scratch
database with explicit promise barriers in its `ps`, Herdr and harness-gate
fakes: each test pauses an observation, applies a newer hook, a cancellation
or a replacement worker, then releases it, and asserts the current liveness,
state and resume count survive, no launch happens, and a
`run.observation_stale` event names the transition. The guard's field
comparison has its own cases, and one checks that a stale live-checks pass
still records Herdr's status, so the next pass's second settled read releases
the dialog. `test/unit/urgent.test.ts` covers the dialog-gone release.
