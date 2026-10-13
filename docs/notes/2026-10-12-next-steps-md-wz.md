# Why is this waiting?

- Status: partial
- Open: the rest of package 3: the briefing and `fleet` reuse, other decision kinds (gates, approvals, merges), a redacted diagnostic export

`docs/next_steps.md` package 3, its first slice: when Flowryn holds a run on a dialog, refuses it capacity, or resumes it after a death (or refuses to), it records why, durably and compactly, and `flowryn show` says so. Before this, the answer was spread over `runs.liveness`, `run_evidence` (one latest row per source, overwritten every pass), the open items, `meta` and the event payloads, and the scheduler's capacity refusals were written nowhere at all: `flowryn capacity` recomputes a reason from the current state, in a different order from the scheduler's own checks.

## Design

### The record

One new table, `explanations` (migration 22, `explanations`). A row is one decision Flowryn made about one run, with the inputs it decided on:

| column | what |
|---|---|
| `id` | integer, shown as `x<N>` |
| `run_id`, `task_id`, `stage` | the run and the stage it was in |
| `kind` | `dialog`, `capacity` or `resume` |
| `rule` | the rule that decided, below (`capacity.pools_full`, …) |
| `reason` | one sanitized line, at most 160 characters, what the operator reads |
| `facts` | JSON array of `{name, value, at}`: each observation the rule used, with the time it was observed (`at`, ms; `null` when the source carries none) |
| `unblock` | JSON array of `{by, action}`, in order: who or what can end the wait. `by` is `captain` (you, in your own terminal or the worker's pane), `leader`, or `flowryn` (an event Flowryn waits for and acts on by itself). An empty array: nothing waits |
| `signature` | the dedupe key, below |
| `item_id` | the item that carries the same wait, if any; the row closes when that item resolves |
| `operation` | the launch, resume or cancel the decision belongs to, when it belongs to one (docs/notes/2026-10-13-next-steps-md-rz.md): `resume.auto`, `resume.deferred`, and a `capacity` row of a run whose grant would launch an open operation; otherwise `NULL` |
| `event_seq` | the `run.explained` event that recorded it |
| `opened_at`, `closed_at`, `closed_by` | open while the wait lasts; `closed_by` says what ended it |

An index on `(run_id) WHERE closed_at IS NULL` and one on `(task_id, id)`. Existing databases get an empty table: nothing is invented for waits that began before the upgrade (a run already waiting for capacity gets its row on the next scheduler pass; a dialog already open at upgrade has none until it recurs, and `show` then simply prints no `waiting` line for it).

### Writes: decision inputs, not polls

`explain(db, …)` (`src/attention/explanations.ts`, called inside the deciding transaction):

1. **Dedupe.** The signature is `kind`, `rule`, `stage`, `reason`, each fact's `name=value` (not its `at`) and the `unblock` list. When the run already has an open row of the same `kind` with the same signature, nothing is written. A rule that observes again what it observed before writes nothing, so a scheduler pass every few seconds or a reconciler pass per run adds no rows while the wait is unchanged.
2. **Change.** An open row of the same kind with a different signature is closed (`closed_by = superseded by x<N>`) and the new row opens, in the same transaction.
3. **Facts never hold a duration** (`waited 34s`) or anything else that changes each read: they hold the time things started (`launched_at`, a pause's `since`), so an unchanged wait has an unchanged signature, and durations are computed when shown.
4. Each new row appends a `run.explained` event (`{explanation, kind, rule}`), so the table follows the one-event-per-mutation rule even where the decision had no event of its own (a capacity refusal). Closing a row happens inside a transaction that already appends its own event (the grant, the hook, the death, the cancel), except the sweep below, which appends `run.explanations_closed`.

### The three decision kinds and their rules

**`dialog`** (liveness `blocked_dialog`), item-linked, so it ends exactly when its item resolves (hook activity, Herdr reading the dialog gone, the run's death or resume, a cancel or failure):

| rule | where | facts | unblock |
|---|---|---|---|
| `dialog.confirmed` | `hook notify` permission_prompt (`openBlockedPrompt`, not suspected) | prompt line (screen read at the hook), last hook | captain: answer the dialog in pane P (Flowryn never answers it); flowryn: clears it on the worker's next hook (for Claude, also when Herdr reads the agent working, or settled on two passes) |
| `dialog.suspected` | reconciler backstop, Claude (Herdr reads `blocked`) | Herdr `agent_status` (observed at the pass), last hook | captain: look at pane P and answer it; flowryn: clears it when Herdr reads the agent working, or settled on two passes, or on the next hook |
| `dialog.stall` | reconciler backstop, Pi (no activity, Herdr not working) | Herdr `agent_status`, last hook | captain: look at pane P; flowryn: clears it on the worker's next hook |
| `dialog.trust` | reconciler: no worker-start hook `trust_wedge_ms` after the launch (`trust_dialog` item) | launched at, pane | captain: accept the dialog in pane P; flowryn: clears it when the worker-start hook arrives |

The trust rule runs on every pass while the worker has not started; dedupe keeps it to one row.

**`capacity`** (a run with `stage_state = waiting` or a `pending_launch`), written by the scheduler's `tryGrant` at the check that refused it, in its own order: the usage pause, the quota floor, the harness gate, the host check, the pools (a refusal from `activateStage`'s `OverCapacity` is the pools rule). Closed by the grant itself (`closed_by = granted`, in the activation transaction), or by the sweep:

| rule | facts | unblock |
|---|---|---|
| `capacity.usage_limit` | pause since, until, who hit it | flowryn: lets one Claude run probe after HH:MM; captain: `flowryn capacity resume --harness claude` |
| `capacity.quota_floor` | quota percent, floor, window resets at (observed when the verdict last changed) | flowryn: starts it once a reading is at or over the floor; captain: `flowryn capacity resume --harness claude` |
| `capacity.harness_unverified` | harness and version, or why it is missing | flowryn: an automatic contract check is running/queued (when one is); captain: `flowryn doctor --contracts --harness H` (or `flowryn init` for a missing harness) |
| `capacity.host_check` | the host verdict's reason, free memory and load (as recorded when it flipped) | flowryn: grants once the host check passes (its thresholds) |
| `capacity.pools_full` | each full pool: used/cap and what holds it (tasks, and jobs such as `verify v3`) | flowryn: grants when a slot in the pool frees (a holder's stage, run or job ends); captain: raise `[capacity] <pool>` in config.toml |

A pool's holders are facts, so a new holder is a new row: that is a changed input, written once per change.

**`resume`**, written by the reconciler's `handleDeath`/`deferResume`:

| rule | waits? | facts | unblock |
|---|---|---|---|
| `resume.auto` | no: the decision itself, recorded closed (`closed_by = resumed`) | session, husk, pane, resumes so far (0) | none |
| `resume.deferred` | until the scheduler launches it (`closed_by = granted`) | the harness check, session, husk | flowryn: launches it once H V passes its contract suite (or the automatic check is running); captain: `flowryn doctor --contracts --harness H` |
| `resume.refused` | until `failure_needs_you` resolves (`flowryn resume`, a cancel) | resumes so far, session (or none), husk | leader: `flowryn resume <task>`; leader: `flowryn cancel <task>` (both verbs take the leader or you; the row names the leader, the least-privileged caller allowed) |

`resume.refused`'s reason says which: died again after its one automatic resume, or no session to resume.

### Closing

- **Item-linked rows** (`dialog`, `resume.refused`): `resolveRunItems` closes the rows whose `item_id` it just resolved, with the item's own `resolved_by` (`hook post-tool`, `dialog gone`, `run.died`, `run.resume_requested`, `run.cancelled`, …). A leader dismissing the item does not close the row: the dialog may still be up. When the same wait opens a new item (the trust rule after a dismissal), `explain`'s dedupe moves the open row's `item_id` to it, so the new item's resolution closes the row.
- **Grant**: the scheduler's activation transaction closes the run's open `capacity` and `resume` rows.
- **Run end**: `failRun` and `cancelRun` close every open row of the run.
- **Sweep** (each scheduler pass, before the grants): an open row whose run is terminal closes (`run ended`); one whose item resolved by any path closes with the item's `resolved_by`; one whose item was dismissed closes once its condition is gone, a trust `dialog` row when the run's liveness is no longer `blocked_dialog` and a `resume` row when it is no longer `dead` (`item dismissed; no longer waiting`); and an open `capacity` or `resume` row with no item closes when the scheduler's `candidates()` filter no longer selects its run (not `stage_state = waiting` or a `pending_launch`, or dead with no `pending_launch`: a dead run waiting between stages is not granted until `flowryn resume`) (`no longer waiting`). One `run.explanations_closed` event for the pass. So `show` never says "waiting" for a run that is not.
- **Dismissed prompt** (`dialog` row of a `blocked_prompt` item): dismissing the item ends the run's `blocked_dialog` hold while the dialog may still be up, so liveness cannot tell. The signal that would have resolved the item closes the row instead: the worker's next busy or idle hook (`item dismissed; hook <signal>`), or, for Claude, the reconciler reading Herdr's agent status as working or settled on two passes (`item dismissed; dialog gone`), with a `run.explanations_closed` event. A worker that dies takes its dialog with it, and the death paths resolve only open items, so the sweep closes the row once the run is `dead` or `starting` a new worker (`item dismissed; no longer waiting`).

### `flowryn show`

- **Default**: a run with open rows gets one field, `waiting`, after `liveness`: each open row, newest first, as `<reason> (since HH:MM); next: <first unblock action> (<by>)`, joined with ` | `. A row with no `unblock` adds nothing after the reason. No open row, no field.
- **`--why`**: `waiting` becomes a list, one object per open row: `id`, `rule`, `reason`, `since` (time and age), each fact as `name: value (observed HH:MM:SS, <age> ago)` (`observed -` when `at` is null), each unblock as `<by>: <action>`, and `operation: <id> <kind> <phase>` (or `-`).
- **`--timeline`** (read-only): instead of the run view, the task's rows across all its runs, in order: `x<N> HH:MM <rule> [<stage>]: <reason> → <closed_by> HH:MM` (or `→ open`). `--full` prints each row's facts and unblock under it. A task with no rows says so.

Times print in local time like the rest of `show`. Everything comes from the table: nothing is recomputed from the live state, so the record explains the decision as it was made.

### What is decided where

All rules stay where they decide today (`src/lifecycle/prompt-wedge.ts`, `src/reconcile/reconciler.ts`, `src/sched/scheduler.ts`); each passes its own facts to `explain`. `src/attention/explanations.ts` holds the table's writes (dedupe, close, sweep) and the `show` formatting. No model is involved: the explanation is what the deterministic rule saw.

### Files

`src/db/schema.ts` (migration 22), `src/attention/explanations.ts` (new), `src/attention/items.ts` (`resolveRunItems` closes item-linked rows), `src/lifecycle/prompt-wedge.ts`, `src/reconcile/reconciler.ts`, `src/sched/scheduler.ts`, `src/lifecycle/runs.ts` (`failRun`, `cancelRun`), `src/lifecycle/leader-verbs.ts` (`show --why`, `--timeline`).

### Tests

- `test/unit/db.test.ts`: migration 22 on a database in use (a run and an open item survive; the table starts empty).
- `test/unit/explanations.test.ts` (new): the quota floor, the harness gate and a throwing harness check, each one row over several passes; `--timeline` not found; dedupe (the same observation twice writes one row; a changed fact supersedes; a changed `at` alone does not; kinds are independent; a settled decision is recorded closed), item-linked closing, the sweep and a cancel, and the `show` lines (default, `--why`, `--timeline`, `--timeline --full`).
- Per decision kind, through the real code path, then replayed offline: the database file is closed, reopened, and `show --why` / `--timeline` explain it from the table alone:
  - dialog: `openBlockedPrompt` (confirmed), the reconciler's trust wedge over several passes (one row), and hook activity closing it;
  - capacity: a `Scheduler` with a full pool over several passes (one row), a new holder (a second row, the first superseded), the grant closing it, and the usage pause and host rules;
  - resume: the reconciler's automatic resume (closed `resume.auto`), a deferred resume on an unverified harness (open, closed by the grant), and a second death (`resume.refused`, closed by `flowryn resume`).

### Implementation notes

- The harness gate's facts and unblock (`harnessFacts`, `harnessUnblock`) live in `src/lifecycle/harness-gate.ts`, shared by the reconciler's deferred resume and the scheduler's launch gate; the scheduler's other refusal builders are `src/sched/wait-reasons.ts`. A harness check that throws is now an explicit `missing` verdict (it was `false` before), so its reason is recorded. Its detail names only the error's kind (`checking claude failed (ETIMEDOUT)`), and the raw message is a `check error` fact whose dedupe value is fixed (`Fact.same`): a message with pids or timings in it would otherwise supersede the row on every pass. The row keeps the first message it saw.
- Relinking an open row to a new item (the dedupe branch, after a dismissal) appends a `run.explanation_relinked` event (`{explanation, from, item}`).
- `show --timeline` on a target that is no run, no task with a policy and no queued task refuses with `not_found` (exit 4), not an empty timeline.
- `resolveRunItems` returns the resolved ids (`RETURNING id`) to close the explanations they carried; its count is unchanged.
- The pools rule records each full pool's holders by task id, and its job leases as `<kind> <job id>` (`verify v3`); the order is by holder, so the same holders in another order are not a change.

### Out of scope

`fleet` and the briefing (they can read the same table later), gates, decisions and merges as explanation kinds, the diagnostic export, retention (rows are few: one per changed decision; measure before pruning), and package 1's operation identity beyond its reserved column.
