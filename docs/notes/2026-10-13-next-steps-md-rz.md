# Durable lifecycle operations: launch, resume, cancel

- Status: done

`docs/next_steps.md` package 1, its second slice (the first, verified fresh-stage replacement, is docs/notes/2026-10-12-next-steps-md-we.md). Launch, resume and cancel each cross a boundary between a committed intent and an external effect (Herdr's `agent.start`, a signal to the worker), and Flowryn recovered them from the last observed worker state, not from what it had asked for. This slice records each as an operation, and recovery works from the operation.

## Design

### The boundaries on main (392eeee)

| Path | Order today | Interruption |
|---|---|---|
| `flowryn cancel` (`src/lifecycle/leader-verbs.ts`) | `prepare` stops the worker (`exitRun`), then `apply` commits `cancelRun` | A crash after the stop and before the commit leaves a running, uncancelled run with a dead worker: the reconciler's next pass reads a death and resumes it once. The cancel is undone. |
| Launcher (`src/lifecycle/launcher.ts`) | writes `launched_at`, calls `agent.start`, polls for the harness, then commits its identity | A crash between `agent.start` and the identity write leaves a `launching` run with no identity. The reconciler re-drives a fresh launch (`Reconciler.reconcileRun`, left open by #76), `ensurePane` finds the pane busy with the first agent and opens a new workspace: a second worker in the same worktree. A resume interrupted the same way keeps the old dead identity, so the next pass reads a second death and fails the run while the new worker runs. |
| Automatic resume | `claimAutoResume` commits, then `launch(resume)` | A crash between them leaves `resume_count = 1`, `starting`, the old identity: the next pass calls it a second death. |
| Gateway replay (`src/api/gateway.ts`) | a stored reply re-enters `settle` | `resume`'s settle calls `launch(run, "resume")`; the launcher has no guard for a resume (the dead identity is still recorded), so a replayed `resume` after the first one launched starts a second worker in the same session. |
| Same-ULID calls in flight together | both miss the stored reply, both `prepare` | two exits, two launches; the second `INSERT INTO idempotency` then fails on the key. |

### The record

One new table, `operations` (migration 25, after #73's contract revision took 23 and #79's verify policy 24):

| column | what |
|---|---|
| `id` | ULID. A CLI request's own idempotency key (`env.ulid`) when a verb made it, so the request and its operation share one identity; minted otherwise |
| `run_id`, `task_id` | the run |
| `kind` | `launch`, `resume` or `cancel` |
| `mode` | for `launch`/`resume`: the launcher mode (`fresh`, `stage`, `relaunch`, `resume`); null for `cancel` |
| `generation` | the execution generation: for `launch`/`resume`, the worker it starts (one more than the run's highest so far); for `cancel`, the newest confirmed one it stops (0 when none started) |
| `desired` | the outcome asked for: `worker_running` or `run_cancelled` |
| `phase` | `requested` → `effect_issued` → `confirmed`, `failed` or `escalated` (below) |
| `requested_by` | `leader`, `human`, `reconciler`, `scheduler`, `daemon` |
| `reason` | `cancel`'s reason line; null otherwise |
| `pane_id`, `agent_name`, `issued_at` | the recorded candidate: the pane `agent.start` was sent to, the agent name it was given, when (committed before the call) |
| `attempts` | how many times the effect was issued |
| `proc_pid`, `proc_start` | the confirmed worker identity (launch/resume) |
| `detail` | one sanitized line: why it failed or was escalated, or how it was confirmed |
| `item_id` | the P1 of an escalation |
| `created_at`, `updated_at`, `settled_at` | |

A unique index on `(run_id) WHERE phase IN ('requested','effect_issued')`: a run has at most one open operation, of any kind. That index is the database's own refusal of a second requested operation; the code checks first and coalesces or refuses, so the index is the backstop, never the normal path.

Existing databases get an empty table. Two upgrade cases are recovered from the run row, because it already holds what an operation would (below): a run `launching` with no identity and `launched_at` set (the old launcher wrote it right before `agent.start`) is an issued launch whose candidate is `pane_id` at `launched_at`; one with `launched_at` null never issued anything. A resume interrupted before the upgrade cannot be told from a second death and is handled as today.

### Phases

- **requested**: the desired outcome is committed; no effect has been issued. Safe to issue.
- **effect_issued**: the candidate is committed and the effect may have happened. Never issued again until recovery has looked.
- **confirmed**: launch/resume: the worker's identity was recorded in the same transaction. Cancel: `cancelRun` committed in the same transaction.
- **failed**: refused or failed, and either a caller was told (a cancel whose worker did not exit; the launch's `failRun`) or a later decision ended it (`superseded by cancel <id>`, `run ended`).
- **escalated**: recovery cannot decide from the evidence. One P1 item `operation_escalated` names the run and what was seen. The escalation holds the run until a newer operation takes over, and only you open one: `flowryn cancel`, or (for an escalated launch or resume) an explicit `flowryn resume`. Dismissing the P1 does not release the hold: an ambiguous candidate may still be alive in its pane, and a fresh launch beside it is the double start this design exists to prevent. For an escalated launch or resume the reconciler does not judge or relaunch the run; for an escalated cancel the worker is the recorded one, so the reconciler keeps watching it: its death is written (liveness `dead`, the usual P0 to resume or cancel, reason `died after a cancel that could not stop it`) and never resumed automatically.

`confirmed`, `failed` and `escalated` are final.

### Who opens an operation

| Request | Where (same transaction as the decision) | kind / mode |
|---|---|---|
| A scheduler grant that launches (`activateStage` returns `launch`) | the activation transaction | the run's open requested operation if it has one (a resume waiting for capacity), else a new `launch` with the grant's mode, or `resume` for `pending_launch = resume` |
| `flowryn resume` | the verb's `apply` (its id is the call's ULID) | `resume` / `resume` |
| The automatic resume, now or deferred | `claimAutoResume` / `deferAutoResume` | `resume` / `resume` |
| `flowryn cancel` | the verb's `apply` (its id is the call's ULID) | `cancel` |
| Anything else that calls the launcher | the launcher's claim transaction (below) opens one if the run has none, so no launch is ever unrecorded | `launch` |

Each refuses when the run already has an open operation, except as coalescing says.

### Coalescing and idempotency

- **Same ULID, concurrent**: the gateway keeps the in-flight mutations by ULID; a second call with a ULID already in flight awaits the first one's reply instead of running `prepare` and `apply` again (a spooled copy is marked ingested as before).
- **Same ULID, after a restart or a lost reply**: the stored reply, as today. Its `settle` drives the operation named in the reply by its phase (below), so a replay finishes an interrupted request and never issues an effect the operation already issued.
- **Inside the committing transaction** the gateway reads `idempotency` again for the ULID: a reply stored meanwhile is returned instead of applying a second time.
- **Different ULIDs, same intent**: a `cancel` on a run with an open `cancel` returns that operation's id and awaits its outcome (one stop, one cancellation); a `resume` on a run with an open `resume` is refused as today (`the worker is starting, not dead`); a `resume` while a `cancel` is open is refused (`run_not_active`).
- **Cancel supersedes a launch**: a `cancel` on a run whose `launch`/`resume` is still open closes it `failed` (`superseded by cancel <id>`) in the cancel's transaction, so the cancel never waits on a launch that may never confirm.

### Replay-safe settlement versus issuing an effect

The rule: **an effect is issued only by the transition `requested → effect_issued`**, a compare-and-set on the operation's phase in the transaction that also commits the candidate. Every caller (a live request's `settle`, a replay's `settle`, the reconciler, the scheduler) may ask for an operation to be driven; only the one whose compare-and-set commits issues the effect. Settlement on replay is therefore kept (it reports and finishes the operation) and is safe:

- `resume`'s `settle` passes its operation id to the launcher. The launcher's claim commits `effect_issued` only from `requested`; a replay finds `effect_issued` or `confirmed` and the launcher does nothing. The reply still says `resuming`; one the grant has not started yet says `waiting: <reason>` with the `rule` of the run's open capacity or resume explanation (the `flowryn capacity` hint only for a `capacity.*` rule), or `waiting for its grant` when none is open.
- `cancel`'s `settle` calls `driveCancel(id)` (below). A replay of a confirmed cancel returns its result; of a failed one, the same error; of an open one, it drives it to its end.

### Cancel: intent first

1. `apply` (one transaction with the stored reply): open the `cancel` operation (`requested`, reason, generation), close a superseded launch. The run row is unchanged: still the same run, same worker.
2. `settle` → `driveCancel`: a compare-and-set to `effect_issued` (attempts + 1), then `exitRun` (SIGTERM by the recorded identity, SIGKILL after the grace, verified gone: unchanged).
3. Verified exit: one transaction, `cancelRun` (park, release, items, explanations, as today) and the operation `confirmed`. A run that ended meanwhile (failed, cancelled elsewhere) confirms with `detail = run already <state>`.
4. A launch the cancel superseded that then throws (its harness never appeared, say) does not fail the run: the launcher sees the open cancel, records `run.launch_failed_cancelling`, and the cancel ends the run `cancelled`.
5. Unverified exit on a live request: the operation `failed` and the reply is the error it is today (`the worker did not exit (...); nothing was cancelled`). The run carries on.

While a cancel is open, nothing starts or resumes the run: the launcher's claim refuses, the scheduler's candidates leave it out, the automatic resume does not claim, and the reconciler does not treat the run's worker as dead or orphaned: it drives the cancel instead (below). `driveCancel` is coalesced in memory by operation id, so the request, its replay and the reconciler share one attempt.

Recovery (the reconciler, after a restart or for any open cancel not in flight in this process): `requested` or `effect_issued` → `driveCancel` again. Stopping by identity is idempotent (a gone process is a verified exit; a reused pid fails the start-time check), so a cancel interrupted before the stop, during it, or after it and before the commit all end cancelled, never resumed. An unverified exit with no caller waiting has no one to tell: the operation is `escalated` with its P1 rather than silently dropped. A caller that joins an attempt the reconciler began (the CLI retrying the same call after a restart) counts as waiting: the stop's failure then fails the cancel and the caller gets the error, as a live request does.

A launch racing a cancel: the launcher's identity transaction confirms only its own operation still `effect_issued`. A cancel committed first has closed it, so the launcher records the identity (so the process can be found) and stops the process it just started, as it already does for a run that ended meanwhile.

### Launch and resume: the candidate before the effect

The launcher (`Launcher.run`):

1. On entry, before any side effect (`ensurePane` can open a workspace): the run's open operation must be the one being launched, in `requested`; an open `cancel`, an `effect_issued` launch or a launch whose id does not match refuses (`skipped`).
2. The claim transaction (the one that writes `launched_at` and `run.launching` today) re-checks that and moves the operation to `effect_issued` with `pane_id`, `agent_name` and `issued_at`. Only then `agent.start`.
3. The identity transaction confirms the operation (`proc_pid`, `proc_start`) beside the run's identity, `pending_launch`, `stage_note` updates it makes today.
4. `failRun` (a launch that failed) and `cancelRun` close the run's open operation `failed` (`run ended`). A deferral before the claim (Herdr down before `agent.start`) leaves the operation `requested`; a Herdr error from `agent.start` itself leaves it `effect_issued`, because the call may have reached Herdr.

Recovery of a launch or resume not in flight in this process (the reconciler, before any liveness judgement, so a run with an open operation is never read as dead, orphaned or due a resume):

- **requested**, no `pending_launch` (the grant was taken, or the automatic resume claimed, and the daemon stopped before the launcher claimed it): the harness gate, then `launch(run, mode, id)`. This replaces the unguarded fresh-launch re-drive: it covers resume too, and the launcher's claim re-checks the operation, so a cancel landing during the harness check wins.
- **requested** with `pending_launch`: the scheduler's (as today).
- **effect_issued**: reconciled against the recorded candidate, never a pane label:
  - Herdr unreachable or the read fails: nothing (unknown is not absence); the next pass looks again.
  - In the recorded pane, the foreground group's leader is the run's harness (the adapter's process match on the configured binary) and its start time is no earlier than `issued_at` (less one second for `ps`'s whole-second start times): that process is the candidate. It is adopted in one transaction (the launcher's identity write, the operation `confirmed`, `detail = recovered candidate`), guarded: the operation must still be `effect_issued` with the same attempt count.
  - The recorded pane is gone, or shows only its shell, and `issued_at` is older than `[reconcile] launch_timeout_ms` (the launcher's own wait for a harness to appear): the effect did not take. The operation returns to `requested` (`operation.reissued` event) and is launched again under the same id: one operation, `attempts` counts the issues. After 3 issues it escalates instead. Within the timeout it waits for the next pass.
  - Anything else (the pane runs some other foreground process, or a harness that started before `issued_at`): escalated.

The scheduler leaves out of its candidates a run whose operation is `effect_issued` or whose open operation is a `cancel`: recovery owns them, so a fresh-stage replacement is never started over an ambiguous launch. It also leaves out a run whose newest operation escalated (`heldByEscalation` in `src/lifecycle/operations.ts`, the same check the reconciler holds the run by), so an escalated stage or relaunch replacement is not granted a fourth issue; once you cancel or resume it, a newer operation is the newest and the hold ends. A grant re-checks both in its activation transaction.

### Generation

The partial unique index already keeps one open operation per run; `generation` makes the history readable and is what the launcher confirms against: a confirmation or an adoption applies only to the operation it claimed (same id, same attempts), so a stale launcher or recovery pass from an older generation commits nothing (`run.operation_stale` event, like #76's `run.observation_stale`). #76's guarded transitions are unchanged and still apply to the reconciler's liveness writes and the automatic resume claim, which now also opens its operation inside the same guarded transaction.

### The `operation` column of #77's explanations

Filled where the explanation belongs to an operation: `resume.auto` and `resume.deferred` carry the resume operation's id, and a `capacity` row carries the id of the open operation the grant would launch (a deferred or requested resume). `flowryn show --why` prints `operation: <id> <kind> <phase>` (or `-`). `flowryn show` adds an `operation` field while the run has an open operation, or an escalated one whose P1 still holds it (`heldByEscalation`).

### What does not change

The scheduler's admission (a launch still needs its grant; recovery re-drives only a granted or claimed launch, and `pending_launch` stays the scheduler's), process-identity checks (start time and executable), #76's guards, the single writer and one event per mutation (every operation transition appends `operation.<phase>` in its transaction), tasks-axi intents through `recordIntent` (only `cancelRun`/`failRun`, unchanged), and offline hook enforcement. No retry framework: the only repeated effect is the launch re-issue above, bounded at 3, and the cancel's idempotent stop.

### Files

- `src/db/schema.ts`: the migration.
- `src/lifecycle/operations.ts` (new): the table's reads and transitions (open, claim, confirm, fail, escalate, reissue), all called inside the caller's transaction.
- `src/lifecycle/operation-recovery.ts` (new): `driveCancel` (coalesced), the candidate check, recovery of one run's operation.
- `src/api/gateway.ts`: in-flight coalescing by ULID, the in-transaction idempotency re-check.
- `src/lifecycle/leader-verbs.ts`: `cancel` and `resume` through operations; `show`'s `operation` field and `--why` line.
- `src/lifecycle/launcher.ts`: the entry check, the claim, the confirmation, the racing-cancel stop.
- `src/lifecycle/auto-resume.ts`, `src/lifecycle/runs.ts` (`failRun`, `cancelRun` close operations), `src/sched/scheduler.ts` (grant opens the operation, candidates), `src/reconcile/reconciler.ts` (recovery first, the re-drive through the operation), `src/attention/items.ts` (`operation_escalated`), `src/attention/explanations.ts` (the `operation` value), `src/daemon/daemon.ts` (wiring).

### Implementation notes

Where the build settled what the design left open:

- `flowryn resume` refuses before its harness check (in `resumable`) when a cancel or an issued launch is open, so the refusal is `run_not_active` rather than whatever the harness check says.
- `flowryn resume` on a dead run whose automatic resume is already requested (deferred on an unverified harness) takes that operation rather than opening a second: the reply names it, and the grant launches it once.
- `flowryn resume` with a requested launch of another mode open (a fresh stage worker waiting for its grant) is refused (`bad_args`, naming it): that launch starts the run when granted, and a resume beside it would be a second request.
- `flowryn resume` on a run held by an escalated launch or resume is allowed whatever its liveness (it is your explicit decision after looking at the pane), opens a new resume operation and resolves the `operation_escalated` item. It never stops the ambiguous process: if the pane is busy the launcher opens a new workspace, as for any resume. On an escalated fresh, stage or relaunch replacement (the run's `pending_launch` still names it), the resume opens its operation in that mode (`launch`, mode `stage` and so on), keeps `pending_launch` and the stage note, and launches nothing itself: its settle kicks the scheduler, whose grant starts the replacement once under that operation. A resume of the stored session would run `--resume` on a session the escalated start may never have created. One mode per operation: the scheduler refuses a grant whose open requested operation has another mode than the launch it would start (`capacity.operation_mode`, naming the operation; `flowryn resume`, then `flowryn cancel`, are the ways out), and the launcher starts nothing under an operation of another mode. The reconciler launches a requested operation no launcher claimed unless the scheduler owns it: it leaves it when `pending_launch` is its own mode, `resume` or `fresh`, so a requested resume left under a waiting stage or relaunch replacement (an automatic resume, or a promote over it) is launched as a resume, and a requested stage or relaunch replacement only ever by the grant.
- A cancel that `cancelRun` ends some other way (a divergence's accept-edit) is confirmed (`run cancelled`); a launch or resume open when the run fails or is cancelled is failed (`run failed`, `run cancelled`).
- A live cancel whose stop fails stores the exit's own detail (`SIGKILL`) on the operation, so a replay's error reads exactly as the live one did.
- A stored reply from before this change carries no `operation`: its settle does nothing more (its apply already cancelled, or its resume was launched then).
- After the harness check, the reconciler reads the operation again before launching it, as well as the launcher's claim: a cancel landing during the check wins without the launcher being called.
- Recovery after a confirmed cancel also forgets the run's waiters, kicks the scheduler and closes its Herdr workspace, as the verb did; that also ends a candidate a superseded launch may have left in the pane.
- The gateway coalesces in-flight calls by ULID for every mutation, ephemeral ones included; a spooled copy of a call still in flight is marked ingested once the first reply is in.
- The fake worker gained `FAKE: ignore-term` (SIGTERM ignored), so a cancel's stop can be caught inside its grace period.

### Tests

Deterministic: explicit promise barriers in the fakes, an abandoned barrier standing in for a daemon that died at that point (a new set of instances over the same database file is the restart), and the fake Herdr's `holdStarts` for an agent that was started and has not appeared. No sleeps.

- `test/unit/operations.test.ts` (new): a crash between the cancel's commit and its stop, and right after the worker's termination (both: cancelled on restart, never resumed); a replayed cancel after a restart finishes it, a replay of a finished one stops nothing; the same cancel twice at once (one ULID) and two cancels at once (two ULIDs): one operation, one stop; a live stop that fails (error as before, replay the same, no second stop); a stop that fails in recovery escalates, the worker is still watched and its death noticed but never resumed; a replay joining the reconciler's attempt fails the cancel rather than escalating; a resume refused while a launch of another mode is requested; a dismissed escalation still holds the run, and `flowryn resume` is the explicit way out (on an escalated stage replacement it opens a stage operation for the grant, nothing launched beside it); a cancel superseding a waiting resume, and a resume refused while it is open; the unique index; the launcher's guard; an issued launch judged against its candidate (adopted, started before the issue, another process, within and past the timeout, at the issue limit, Herdr away, an issued resume not read as a second death, a check whose operation changed during the Herdr read, a launch interrupted before operations existed); an automatic resume claimed before a crash is launched under its operation; a cancel landing during the harness check wins; `show`'s `operation` field.
- `test/unit/gateway.test.ts`: the same ULID twice in flight (and a spooled copy): one prepare, apply and settle; a reply stored during prepare is returned, not applied again.
- `test/unit/workflows.test.ts`: the grant's replacement is one operation named to the launcher and reused by the retry after a refused exit; a run with an open cancel or an issued launch is never granted; an escalated stage replacement gets no exit attempt and no launch, held even once its P1 is resolved or dismissed, released by a newer operation you open, which the grant launches once; an open requested operation of another mode than the grant's launch is refused with why.
- `test/unit/db.test.ts`: the operations migration (25) on a database in use, a run left mid-launch untouched, one open operation per run, the CHECKs.
- `test/integration/operations.test.ts` (new), on the fake Herdr with kill -9 of the daemon: killed right after `agent.start`, the restart adopts the candidate (one `agent.start`); a start that never came up is issued again under the same operation (two `agent.start`, one operation); a cancel landing while the launcher waits makes the launcher stop its own worker; a cancel superseding a launch that then times out ends the run cancelled, not failed; killed while a cancel's stop waits out the grace of a worker that ignores SIGTERM, the restart finishes the cancel and never resumes; the same `resume` envelope twice at once and again after a restart starts exactly one worker.
