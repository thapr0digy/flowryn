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
| 7 | `merge` verb `settle` (src/policy/verbs.ts) | `executeMerge` (GitHub merge + proof) | `recordMergeResult` | It is the effect's own result, written by merge id; `recordMergeResult` refuses a settled merge, and keeps a merge proven for a terminal run with `noteMergedAfterEnd` rather than landing it. The merge is in `inFlight`, so the watcher leaves it alone | already guarded by the merge row's state (left as is) |
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
| a proven merge (`pr_observation` reading merged, `local_merge_proof` proving merged, `merge` finding the PR already merged) | delivered | see below |

**A proven merge is never dropped.** A merge of the delivered work cannot be
undone, so it wins over anything newer: a cancel requested, any other
operation change, a change of the merge row, a stage or state change. It is
checked only against the delivery (a redelivery means the next read is of the
new delivery, and a merged PR still reads merged then). The reversible effects
(the conflict nudge, P1s, divergences, `unproven`) keep the full parts.

- **The racing cancel ends as a no-op.** `landRun` ends a cancel still open
  `failed` with `the run landed before the cancel took effect; the merge
  stands (merge <sha>)` (`LANDED_BEFORE_CANCEL`). A cancel whose worker stop
  is in flight then finds its operation settled and stops there, and
  `flowryn cancel` answers `run_not_active` with that line instead of a stop
  failure. The worker of a landed run is stopped by its cleanup as usual.
  A fresh `flowryn cancel` of a run already landed is refused (`run_not_active`,
  pointing at `flowryn cleanup`) before any cancel operation is recorded.
- **A merge proven after the run already ended** (the cancel committed before
  the read came back) does not revive the run: terminal work stays terminal.
  `noteMergedAfterEnd` records the fact instead: an open merge request is
  marked `merged`, a `run.merged_after_end` event is appended, and a
  divergence (P1, GitHub or git over the run) says the work landed under an
  ended run, so you decide what the task is now. The PR watcher, the local
  proof and the merge verb all keep it. The merge verb does so on both of its
  proven reads: a PR the gate already reads merged (the cancel committed
  during the gate's read, the delivery unchanged) and its own merge's proof
  (the cancel committed while GitHub merged; `recordMergeResult` calls
  `noteMergedAfterEnd` instead of `landRun` for a run already ended). Either
  way its caller is told the PR merged after the run ended and a divergence
  asks; nothing lands and no cleanup starts.

**Taking the basis.** The watchers read it for each run right before that
run's own awaits (not when the pass lists its runs), so a slow read of one run
does not reject the next. The PR watcher's `delivered` comes from the basis, so
the PR it reads and the delivery it compares are the same one. `deliver` takes
it after `startPooledStages` (which may itself start a stage) and before the
verification; `merge` before `gatherFacts`.

**Stale verbs are refused, and the refusal is recorded.** A verb's `apply`
runs inside the gateway's transaction, and a throw rolls that back, event and
all. A stale `deliver` or `merge` therefore throws a `FlowrynError`
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
`openCiWait`, `recordDelivery` and the state machines they drive are
unchanged; they are now called through the guard. `recordMergeResult` changes
only for a run already ended (above). Their own
in-transaction checks (merge in flight, `ciWaitDue`, `landRun` on a terminal
run) remain the second check. No new column or migration: every part is
already a row the transitions write.

**Deterministic.** Nothing here needs a model.

## Implementation notes

- `src/lifecycle/observed.ts`: `DeliveryBasis`, `deliveryBasis`, `staleBasis`,
  `deliveryTransition` (watchers) and `requireDeliveryBasis` (verbs), beside
  the first slice's `observedTransition`.
- `src/api/errors.ts`: the `observation_stale` code (exit 2) and
  `FlowrynError.refusalEvent`; `src/api/gateway.ts` `applyTx` appends that
  event after a refused apply rolls back. Any verb may use it; only `deliver`
  and `merge` do.
- `src/watch/delivery.ts`: each watcher write goes through
  `deliveryTransition` with its parts (`PR_PARTS`, `NM_PARTS`,
  `CI_WAIT_PARTS`, `LOCAL_MERGE_PARTS`). The watcher's deps gain an optional
  `readNmStatus` (defaults to the real read), so a test can pause the status
  read on a barrier instead of a sleeping stand-in script.
- `src/lifecycle/worker.ts` (`DELIVER_PARTS`) and `src/policy/verbs.ts`
  (`MERGE_PARTS`): the basis is read in `prepare` and required in `apply`. A
  scout's report delivery reads nothing remote and is not guarded.
- `MERGED_PARTS` (src/watch/delivery.ts) and `["delivered"]` for an
  already-merged PR in the merge verb; `landRun` settles an open cancel
  (src/lifecycle/landing.ts); `noteMergedAfterEnd` (src/reconcile/delivery.ts)
  for a merge read after the run ended, called by the watchers, the merge
  verb's `apply` and `recordMergeResult`; the cancel verb's `settle` maps the
  landed outcome (src/lifecycle/leader-verbs.ts).
- A dropped *unproven* local proof leaves the merge `requested`: if the cancel
  it raced completes, the run ends cancelled; if not, the next pass reads the
  proof again against the settled operation.

## Tests

`test/unit/observed-delivery.test.ts` drives the real `DeliveryWatcher` and
the real `deliver` and `merge` verbs through the `Gateway`, on a scratch
database with a fake forge, a fake git and a stand-in status read, each with an
explicit promise barrier. For each guarded path one test pauses the
observation, applies a newer change, releases it, and asserts nothing changed
but one `run.observation_stale` event naming the transition and the changed
part; beside each, a control with nothing newer shows the same observation
still applies. A proven merge is the exception: its tests assert it wins.

| Transition | Paused read | Newer change | Without the guard |
|---|---|---|---|
| `pr_observation` | `forge.pull` of a conflicting PR | redelivery at a new head | the new delivery is sent back (conflict nudge) |
| `pr_observation` | `forge.pull` of a merged PR | cancel requested | (the merge wins: the run lands, the cancel ends `failed` as a no-op, no stale event) |
| `pr_observation` | `forge.pull` of a merged PR | the cancel completes (run cancelled) | (not revived: `run.merged_after_end` and a divergence) |
| `merge` | the gate's `forge.pull` | redelivery at a new head | a merge is requested for the replaced head |
| `merge` | the gate's `forge.pull` of a merged PR | the cancel completes (run cancelled) | (not revived: `run.merged_after_end` and a divergence, no cleanup) |
| `merge` `settle` | `forge.merge` | the cancel completes (run cancelled) | (the merge is proven, the run not revived: `run.merged_after_end` and a divergence, no cleanup) |
| `deliver` | `forge.checks` of the older delivery | a newer delivery commits | the older head overwrites the newer |
| `deliver` | `forge.checks` of a redelivery | send-back (decline) | the run is ready again, the decline undone |
| `nm_observation` | the status read of a stalled pipeline | a new validation slot | a stuck P1 for the new slot, run `validating` |
| `ci_wait` | the check-count `forge.pull` | the stage restarted with a new slot | a CI-wait question for the old pipeline |
| `local_merge_proof` | `git merge-base` proving merged | cancel requested | (the merge wins: recorded merged, the run lands) |
| `local_merge_proof` | `git merge-base` not proving it | cancel requested | the merge is recorded `unproven` with a P1 |

With the guard disabled every race test of a reversible effect fails and every
control passes. "a cancel a landing overtook" checks `flowryn cancel`'s answer
when the run lands while its worker is being stopped. The
basis has its own cases: a part the transition does not name never makes it
stale, a terminal run always does, and a hook's liveness or lease write on a
delivered run is not part of it.
