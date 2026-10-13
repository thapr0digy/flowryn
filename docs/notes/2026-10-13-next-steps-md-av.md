# Guarded observation transitions: delivery and stage progression

- Status: partial
- Open: the observation writes listed under "Left open" below

docs/next_steps.md package 2, second slice. The first slice
(docs/notes/2026-10-12-next-steps-md-s9.md) put liveness and the automatic
resume behind `observedTransition`. This slice does the same for the
observations that move delivery and stage progression: GitHub's PR state and
head, no-mistakes' status, and the reads the `deliver` and `merge` verbs make
before they commit.

## Design

### Inventory: awaited observations that write

Each row is a write decided from something read before an `await`. "Can
overwrite" is what a newer change landing during that await (a new delivery,
`decline`, `cancel`, a stage advance, a merge) lets the old result undo.

| # | Path | Observation (await) | What it writes | Can overwrite | This slice |
|---|---|---|---|---|---|
| 1 | `DeliveryWatcher.watchPrs` → `applyPrObservation` (src/watch/delivery.ts, src/reconcile/delivery.ts) | `forge.pull`, `forge.checks` of the delivered PR; `delivered` is read *before* the await and reused | lands the run (`landRun`, PR merged elsewhere); `merge.unproven`/`refused`/`merged` for a merge with no daemon in flight; the conflict nudge (`sendBack`: run back to work, `conflict_nudged`); `pr_closed`, `checks_red`, `pr_conflict` P1s; head-moved and draft divergences; PR evidence | A worker that redelivers (a new head, or a new PR) during the read: the old PR's `mergeable = false` sends back the run that just delivered a fixed head; the old PR closed or merged lands or flags the new delivery; the old head reads as "moved" against the new one. A `merge`/`cancel` requested during the read is acted on with a pre-merge snapshot | **guarded** (`pr_observation`) |
| 2 | `merge` verb (src/policy/verbs.ts) | `prepare`: `gatherFacts` reads GitHub and git; `apply` re-reads the run's state only | approval taken, `merges` row requested at `facts.head` on `facts.delivered.ref`, run `merging`; or, when the PR read merged, `landRun` | A redelivery (new head or new PR) during the gate's reads: the merge is requested for the delivery that was replaced, on an approval bound to it; a `decline` and redelivery in the window merges the old PR | **guarded** (`merge`) |
| 3 | `deliver` verb (src/lifecycle/worker.ts) | `prepare`: `verifyPrDelivery`/`verifyLocalDelivery` (GitHub, `git ls-remote`, the worktree) | the delivery artifact, run `ready`, stage done, the merge gate, the `pr_ready` item, approvals voided on a new head | Two `deliver` calls in flight (different ULIDs): the slower one, verified at the older head, overwrites the newer delivery. A `decline` (or a fresh-stage replacement, a cancel request) during verification is undone by marking the run ready with the head verified before it | **guarded** (`deliver`) |
| 4 | `DeliveryWatcher.readNmRuns` → `applyNmObservation` (src/watch/delivery.ts, src/reconcile/delivery.ts) | `no-mistakes status` in the worktree (up to `nm_timeout_ms`) | run `running` ⇄ `validating`, `validation_outside_cap` P1, the `validation_stuck` episode (P1, `run.validation_moving`), no-mistakes evidence and the CI-wait clock | A delivery (stage done, slot released), `decline`, a new validation slot granted (a new episode) or a stage advance during the read: the old status opens or closes a stuck episode against the new slot, or flips state from the old pipeline | **guarded** (`nm_observation`) |
| 5 | `DeliveryWatcher.watchCiWait` (src/watch/delivery.ts) | `forge.pull`/`checks` (check count), `readBranchFacts` (`git fetch`, `git show`) | opens the CI-wait decision (a question for the user) and covers the stuck episode | Already re-checks run state and `ciWaitDue` in the transaction; a delivery, `decline` or a new slot that keeps the state `running`/`validating` was not seen | **guarded** (`ci_wait`) |
| 6 | `DeliveryWatcher.watchLocalMerges` (src/watch/delivery.ts) | `proveLocal` (git) for a `merging` local-only run | `recordMergeResult`: merged (lands), unproven (P1) | `recordMergeResult` re-reads the merge row (a settled merge is left alone) and `landRun` refuses a terminal run, but a cancel *request* (an open cancel operation) or a newer merge request was not seen | **guarded** (`local_merge_proof`) |
| 7 | `merge` verb `settle` (src/policy/verbs.ts) | `executeMerge` (GitHub merge + proof) | `recordMergeResult` | It is the effect's own result, written by merge id; `recordMergeResult` refuses a settled merge, `landRun` a terminal run. The merge is in `inFlight`, so the watcher leaves it alone | already guarded by the merge row's state (left as is) |
| 8 | Gate channel: `LavishPoller.record` → `lavishAnswer`, `recordGateComment`, `requestGatePass` (src/lavish/poller.ts) | `lavish-axi poll` | captain answers, gate comments, pass requests | Each re-reads the decision and the gate in the transaction and answers `late` (closed) or `stale` (another page or gate), with an event | already guarded (left as is) |
| 9 | `applyDocker` (src/reconcile/docker.ts) | `docker ps` | docker evidence, an over-lease divergence, a `docker_leftover` P1 | Reads the run and leases after the await (no await in between), so only the container list is old. It changes no run state, stage or delivery; a divergence or P1 from a list a second old is accurate about that second | **left open** |
| 10 | `verifyPrDelivery`'s `diverge` (src/lifecycle/delivery.ts) | the PR read in `deliver`'s prepare | a draft or head-not-on-remote divergence, in its own transaction, before the refusal | A record of what the worker named against what GitHub said at that moment; no state change, and the refusal follows. A run cancelled during the read still gets the divergence | **left open** |
| 11 | Cleanup guard's landed-work verdict (src/policy/landed.ts), `verify` (src/verify/verbs.ts) | PR reads | cleanup verdicts; verify results bound to head and policy | Cleanup is package 6's (both fixture sets); verify results are bound to head and policy by package 4 | **left open** (other packages) |
| 12 | Stage grants under a call (`grantRequested`, `startPooledStages`, `beginLastStage`, src/lifecycle/stages.ts) | `sched.grantNow` | stage started, leases | The scheduler's own transition: it re-reads the run in its grant transaction. The first slice also left the scheduler's transitions out | **left open** (scheduler-owned) |

### One basis for delivery observations

The first slice's `OBSERVED_FIELDS` are the worker's: liveness, process
identity and the hook watermark. A delivered run's worker may still fire hooks
or exit; that must not reject a PR read. Delivery observations rest on
different facts, so `src/lifecycle/observed.ts` gets a second, small basis:

| Part | Read from | Changed by |
|---|---|---|
| `state`, `stage`, `stage_state` | `runs` | delivery, `decline`/send-back, cancel, landing, stage done/begin, a fresh-stage replacement |
| `delivered` | the task's latest `pr`/`local` artifact: kind, ref, head (`deliveredOf`) | a new delivery (new head or new PR) |
| `merge` | the task's latest `merges` row: id and state | a merge request, its result |
| `operation` | package 1's newest operation of the run (`latestOperation`): id and phase | a launch, resume or cancel requested, issued or settled: the execution generation and a cancel in flight |
| `validation` | the run's live `validation` lease: its id and grant time | a validation slot granted or released (a stuck episode is counted from the grant) |

`deliveryBasis(db, runId)` reads it; `deliveryTransition(db, seen, parts,
transition, source, now, apply)` opens the transaction, reads the basis again
and compares the parts the transition depends on. When the run is gone,
terminal, or a part differs, nothing is written but one
`run.observation_stale` event (the same kind as the first slice) with the
transition name and each changed part (seen and current), and the caller gets
`{ applied: false }`. Otherwise `apply(run)` runs in the same transaction with
the current run, so the state change, its events, items, intents and lease
releases still commit together.

Each transition names its parts:

| Transition | Parts | Why not the others |
|---|---|---|
| `pr_observation` | state, stage, stage_state, delivered, merge, operation | the validation slot does not bear on a PR |
| `merge` | state, stage, stage_state, delivered, merge, operation | same |
| `deliver` | state, stage, stage_state, delivered, operation | a merge needs a delivery first; the slot is released by the delivery itself |
| `nm_observation` | state, stage, stage_state, operation, validation | the PR and merge do not bear on the pipeline's status |
| `ci_wait` | state, stage, stage_state, delivered, operation, validation | |
| `local_merge_proof` | state, merge, operation | a merging run's stage is done |

**Taking the basis.** The watchers read it for each run right before that
run's own awaits (not when the pass lists its runs), so a slow read of one run
does not reject the next. The PR watcher's `delivered` comes from the basis, so
the PR it reads and the delivery it compares are the same one. `deliver` takes
it after `startPooledStages` (which may itself start a stage) and before the
verification; `merge` before `gatherFacts`.

**Stale verbs are refused, and the refusal is recorded.** A verb's `apply`
runs inside the gateway's transaction, and a throw rolls that back, event and
all. A stale `deliver` or `merge` therefore throws `ObservationStaleError`
(`observation_stale`, exit 2 policy, with the changed parts in the message and
"deliver again"/"merge again" as help), which carries its event; the gateway
appends that event in its own transaction after the rollback and rethrows. No
reply is stored, so the caller retrying with a new ULID verifies against
current truth. This is the one gateway change; it decides nothing.

**Stale watcher reads are dropped.** As in the first slice: no retry, no item.
The next poll (or the kick the newer change already scheduled) reads current
state. A dropped PR read writes no evidence either: evidence of a PR or head
that is no longer the delivery would be wrong, and the next read records it.

**What stays as it is.** `applyPrObservation`, `applyNmObservation`,
`openCiWait`, `recordMergeResult`, `recordDelivery` and the state machines
they drive are unchanged; they are now called through the guard. Their own
in-transaction checks (merge in flight, `ciWaitDue`, `landRun` on a terminal
run) remain the second check. No new column or migration: every part is
already a row the transitions write.

**Deterministic.** Nothing here needs a model.

## Tests

`test/unit/observed-delivery.test.ts` (new) drives the real watcher and verbs
on a scratch database with the fake forge, fake git and explicit promise
barriers in them. For each guarded path one test pauses the observation,
applies a newer change, releases it, and asserts nothing changed but one
`run.observation_stale` event naming the transition:

- `pr_observation`: a redelivery at a new head while a conflicting PR read is
  paused (no nudge, no send-back); a cancel requested while a merged-PR read is
  paused (not landed).
- `merge`: a redelivery while the gate's PR read is paused (no merge row, no
  approval taken, `observation_stale` reply).
- `deliver`: a second delivery at a newer head commits while the first's PR
  read is paused (the newer delivery stands); a `decline` while it is paused
  (the run stays sent back).
- `nm_observation`: a delivery (slot released, run ready) while an "active"
  status read is paused; a new slot granted while a stalled read is paused (no
  stuck episode).
- `ci_wait`: a `decline` back to `running` with a new slot while the check
  count read is paused (no question opened).
- `local_merge_proof`: a cancel requested while the proof is paused (no merge
  result written).

Plus the basis comparison's own cases, and that an unchanged basis still
applies (the existing watcher, verb and CI-wait tests keep passing).
