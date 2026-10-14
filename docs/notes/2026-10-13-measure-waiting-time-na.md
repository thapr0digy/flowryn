# Measure waiting time, interventions and store growth

- Status: done

`docs/next_steps.md` package 3 ("Done means": measure unresolved waiting time and unnecessary interventions before adding more autonomous behaviour) and "What not to build next" (measure database/log growth and query latency, then design retention). One read-only verb, `flowryn stats`, computed from what Flowryn already records. No new autonomous behaviour, no model, no schema change.

## Design

### The verb

`flowryn stats [--since 7d] [--project <id>]` (and the global `--json`). A `read` verb like `fleet` and `capacity`: roles leader, reader and human, pure SQLite reads plus `stat(2)` of the state directory, so the read-only fallback serves it with the daemon down. Default output is the CLI's usual TOON rendering of the reply; `--json` prints the same data for scripts.

- `--since`: `<n>m`, `<n>h`, `<n>d` (window back from now) or `YYYY-MM-DD` (local midnight). Default `7d`. Anything else, zero, or a start in the future is `bad_args`.
- `--project`: limits the waits and interventions to tasks of that project (`task_policy.project_id`); an unknown project is `not_found`. The store section is the whole database whatever `--project` says (it says so in its line).

Reply fields, in order: `window`, `waits` (table), `interventions` (table), `unneeded` (table), `store` (object), `gaps` (list), `took` (ms per section).

### Waiting time

A **wait** is one span from when something started waiting to when it stopped. Each source below gives its waits a `reason`. For each reason the `waits` table has:

| column | meaning |
|---|---|
| `reason` | below |
| `n` | waits that ended inside the window |
| `median`, `p90`, `max` | time to resolution of those `n` waits; nearest-rank percentiles (the value at rank ⌈q·n⌉ of the sorted durations), so a median of an even count is the lower middle value |
| `open` | waits still open now, whenever they started |
| `oldest` | the oldest open one: its age and its id (`x12`, `q7`, `g40`, `i301`, task id) |

Rows are sorted by `open` then `n`, descending; a reason with nothing in the window and nothing open is left out. Durations print as `45s`, `12m`, `3.5h`, `2.1d`.

The sources, each with its rule:

1. **Wait explanations** (`explanations`, docs/notes/2026-10-12-next-steps-md-wz.md): reason = the row's `rule` (`dialog.confirmed`, `dialog.suspected`, `dialog.stall`, `dialog.trust`, `capacity.usage_limit`, `capacity.quota_floor`, `capacity.harness_unverified`, `capacity.host_check`, `capacity.pools_full`, `capacity.operation_mode`, `resume.deferred`, `resume.refused`). `resume.auto` is left out: it is recorded closed and waits for nothing. A row closed `superseded by x<N>` whose successor `x<N>` has the **same rule** continues the same wait (a pool's holder changed, the wait did not): the chain is one wait from its first row's `opened_at` to its last row's end. A successor with a different rule ends that rule's wait and starts the next rule's. To join chains whose first rows closed before the window, every row of each run that has a row ending in the window or open is read (a run keeps at most `explanations_keep_per_run` closed rows, so this stays bounded).
2. **Decisions** (`decisions`): `created_at` → `answered_at` (answered or dismissed both set it). Reason `decision (captain)` when only you may answer it, i.e. it has a `reserved_reason` or is a review gate's question (`gate_id`); otherwise `decision (leader)`.
3. **Gates** (`gates`): `opened_at` → `closed_at`. Reason `gate review` or `gate merge`.
4. **Actionable items** (`items` of class `actionable`): `opened_at` → `resolved_at` (a dismissal sets it). Reason `item <kind>`: `item blocked_prompt`, `item capacity_wait`, `item failure_needs_you`, `item steer_unacked`, … An item carrying a decision (`decision_id`) is left out, since the decision is already counted. Info items wait for nothing and are left out.
5. **Conflict nudges** (`run.conflict_nudged` events): the nudge → the run's next `run.delivered` event; reason `conflict nudge`. A run that ended without delivering again ends the wait at its `ended_at`. Open while the run is live and has not delivered again. Nudges are read from every run live now or ended in the window (its `ended_at`, else `updated_at`), each run's events by the `events_run` index: a nudge of a run that ended before the window cannot end in it.

The window rule is the same for every source: the duration statistics cover waits that **ended in the window**; `open` and `oldest` cover every wait open **now**. A wait that started before the window and ended in it counts in full.

### Interventions

An intervention is a verb a person or the leader ran that changed a run, read from the window's events (plus `approvals` rows). The `interventions` table has `action`, `by` and `n`; `by` is the role the event records (`leader`, `human` shown as `you`, or the approval channel), `-` where nothing records it.

| action | event (rule) | by |
|---|---|---|
| `answer` | `decision.answered` | payload `by` (`captain` → `you`, `leader`) and `via` |
| `dismiss` | `item.dismissed` | payload `by`; a dismissed decision is counted here once, through its item |
| `gate pass` | `gate.passed` of a review gate (payload has `channel`) | the approval channel (`claude-ask`, `claude-chat`, `cli-tty`, `board`, `pi-confirm`) |
| `gate changes` | `gate.changes` with a `by` (a merge gate closed unpassed by a send-back records none: the decline or nudge is the action) | payload `by` |
| `approve merge` | `approvals` rows with `action = 'merge'` created in the window, not `yolo` | the channel |
| `decline` | `run.declined` | payload `by` |
| `steer` | `steer.created` with no decision, whose steer id no `stage.started` or `run.policy_steered` event in the window names (payload `steer`): those are Flowryn's own stage-start and policy-follow steers. Answer and dismissal steers carry their decision and are left out | `-` (not recorded) |
| `cancel` | `operation.requested` with payload `kind = cancel` | payload `by` |
| `resume` | `run.resume_requested` | payload `by` |
| `interrupt` | `run.interrupted` | `-` (not recorded; it includes an urgent steer's preemption) |
| `divergence resolve` | `divergence.resolved` whose `by` is a caller role (`leader`, `human`); Flowryn resolves some itself and names the event (`run.delivered`) | payload `by` |
| `capacity resume` | `sched.usage_resumed` with source `cli`, `sched.quota_override` | `you` |

### Unnecessary interventions: three rules

Each is a pure rule over recorded rows; the `unneeded` table lists `rule`, `n`, `of` (what it is counted out of) and `detail`.

- **U1 `dismissed alone`**: an `item.dismissed` after which nobody intervened on the same task (any action in the table above other than `dismiss`) within 10 minutes. A dismissal less than 10 minutes before `now` is left out of both `n` and `of`, since its follow-up may still come; so is the dismissal of an item with no task (a system alert, whose fix happens outside Flowryn, so no recorded action can follow it), with a gap line giving how many. The item asked for attention it did not need; `detail` lists the item kinds, most first (that is where the noise comes from). Out of: dismissals.
- **U2 `steer to a busy run`**: a non-urgent `steer` whose run's last `run.liveness` before it was `busy` (the worker was mid-turn) and that had no open actionable item at that moment. Nothing about the run asked for one. Out of: steers. Read per steer with the `events_run` index (the latest `run.liveness` with a lower `seq`).
- **U3 `answered as recommended`**: a `decision.answered` whose answer equals the decision's non-empty `recommendation`. The asker already knew the answer it got, so a default could have stood. `detail` splits it by asked-to (captain or leader). Out of: answers to decisions with a recommendation.

Rules only count. None of them changes behaviour; they show where an automatic default or a quieter item would save a turn.

### Store growth and latency

- **Database**: the file, `-wal` and `-shm` sizes (`stat`), `page_count × page_size` and the free pages (`freelist_count`). An in-memory database says so.
- **Rows per table**: every table in `sqlite_master`, `COUNT(*)`, largest first. `events` uses `MAX(seq)`: it is append-only (triggers refuse UPDATE and DELETE) and its rowid has no gaps, so the maximum is the count without a full scan.
- **Events per day** in the window (`events_per_day_utc`: UTC days, since the window may cross a time zone change): count and payload bytes. **Largest event kinds** in the window: the top 10 by count, with bytes.
- **Latency**: the `fleet` and `brief` reads, each run three times on the same database through their own verb code, median in ms (as a human caller, so `brief` composes the whole briefing). Also `took`: each section of this report.
- **State directory**: each top-level entry of `state_dir` (`logs`, `runs`, `backups`, `bin`, the database files, …), its bytes and file count, symlinks not followed (a link counts as itself). The walk stops at 20 000 entries in all and marks a capped entry's bytes `≥`.

### Bounds

- `events` has no time index. The window's first event is found by binary search on `seq` (`O(log n)` primary-key reads), assuming `ts` does not decrease as `seq` grows (the daemon appends with its own clock; a clock stepping back can move the edge by those few events). Every event query then reads only `seq >= that`: a query returning rows has `LIMIT 20 000`, and the two aggregates (events per day, largest kinds) read at most the window's first 1 000 000 events, and events per day lists at most the newest 400 days; any of these limits hit is a gap line.
- `decisions`, `gates`, `items` and `explanations` have no time index either; they hold one row per wait or decision, orders of magnitude fewer than `events`. Each read takes the rows ending in the window or open, open ones first, `LIMIT 5 000`; a hit limit is a gap line and drops the oldest closed waits. `took` shows when this stops being cheap.
- Per-steer and per-nudge lookups use `events_run (run_id, seq)`.
- The report reads synchronously on the daemon's thread, like every read verb, so a long `--since` delays hooks and other calls while it runs: by at most about 1.3 s on this Mac with every limit above reached (a synthetic database of 1 000 000 events in the window, 6 000 rows in each wait table and 2 000 runs, `--since 7d`; the store's two event aggregates are 1 s of it), and about 60 ms on the live database.

### Gaps: say, do not record

The report's `gaps` list states each fact it could not get, and only those that apply:

- steers and interrupts do not record who sent them (the `by` column is `-`); interrupts include urgent steers' preemption;
- cancels before lifecycle operations (migration 25) recorded no `by` and are not counted;
- closed wait explanations are pruned after `[upkeep] explanations_keep_days` (shown when the window reaches further back) and beyond `explanations_keep_per_run` per run, and none exist before migration 22;
- decisions without `created_at` (before migration 6) are left out of waits (shown with their count);
- any query that hit its `LIMIT`.

None of these needs a schema change to make the report useful now, so this change adds none. Recording a steer's and an interrupt's caller would be a payload field on an existing event (no migration) and is left for a change that needs it.

### Tests

Unit tests on a migrated scratch database seeded with fixed clocks: each wait source and its window rule, the explanation chain join (same rule continues, different rule splits, chain head before the window), nearest-rank percentiles, each intervention row and its exclusions (stage-start and policy-follow steers, decision steers, merge-gate passes, yolo approvals), each U rule with a case that matches and one that does not, `--project` and `--since` parsing and errors, the events binary search (including an empty table), `MAX(seq)` equal to `COUNT(*)`, the caps producing gap lines, and the state directory walk with its cap. One CLI integration test runs `flowryn stats --json` against the read-only fallback.

## Build

- `src/attention/stats.ts`: the verb (`STATS_VERBS`, registered in `src/api/registry.ts`), the window, the five wait sources, interventions and the three rules. `src/attention/store-stats.ts`: the store section; it times `fleet` and `brief` by calling their own `read` from `LEADER_RUN_VERBS` and `ATTENTION_VERBS`, so the latency is of the code those verbs run, not a copy of their queries.
- Durations print as strings (`12m`, `3.5h`) in both TOON and `--json`: the reply is the same data either way, as for every verb. A script that needs exact numbers reads the tables itself.
- `--since YYYY-MM-DD` uses `isValidIsoDate` (`src/lifecycle/dates.ts`), so `2026-02-31` is refused rather than rolled over.
- On a copy of the live database (12 425 events, 574 items, 138 gates) the whole report took about 60 ms: window search 8 ms, waits 13 ms, interventions 3 ms, store 33 ms (of which the `fleet` and `brief` timings, three runs each, are most). It showed the 7-day picture the rules are for: 30 of 33 dismissals were U1 (most `worker_report`), 9 of 10 answers to recommended questions took the recommendation (all asked of you), and merge gates waited a median 71 minutes.

### Tests

`test/unit/stats.test.ts` (32 cases since the follow-up, on a migrated scratch database, fixed clock), each named after the assumption it checks: the `--since` forms and refusals; the binary search (empty table, equal timestamps, past the end); nearest-rank percentiles; the window rule (a wait begun before the window counts in full, one ended before it does not); each wait source with its exclusions (explanation chains joined across the window edge, a rule change splitting them, `resume.auto`, captain vs leader decisions and the undated-decision gap, an open gate of an ended run, info and decision items, nudges ended by delivery, by the run's end, or open from before the window); `--project`; the row-limit gap; every intervention row and every exclusion (merge-gate pass and changes, a scheduler launch, Flowryn's divergence resolution, a daemon-side usage resume, yolo approvals, stage-start, policy-follow and decision steers); each U rule matching and not (and a U1 dismissal whose 10 minutes have not ended); `MAX(seq)` equal to `COUNT(*)`; UTC day buckets and kinds, and the events-per-day cap (the newest days kept, a gap line only past the cap); the latency rows; the database line on file and in memory; the state-directory walk with a symlink, its cap and a missing directory; and the verb's reply shape, `not_found` project and the retention gap. `test/integration/stats.test.ts` runs `flowryn stats` through the real CLI, served by the daemon (with a `bad_args` refusal) and by the read-only fallback with the daemon down.

## Follow-up: #87 review (flowryn-stats-follow-kr)

### Design

Six review findings, each fixed where the rule above was wrong or unstated; the Design text above is corrected in place.

1. **Nudges begun before the window.** A nudge's wait ends at the run's next `run.delivered` or at its end, both at or before the run's `ended_at` (`updated_at` when unset). So a nudge whose wait can be open now or have ended in the window belongs to a run that is live now or ended in the window. The nudges read are every `run.conflict_nudged` of those runs (`runs` scanned once, each run's events by `events_run`), replacing "the window's nudges plus live runs' nudges", which missed a nudge from before the window whose run delivered or ended inside it.
2. **Open waits first at a cap.** Each wait source orders its rows open first (decisions `state = 'open'`, gates and items by their open states, explanations by runs with an open row, nudges by live runs), then newest end first, so a `LIMIT` drops the oldest closed waits, never an open one. The gap line still says the source was capped.
3. **Flowryn's own steers by id.** A steer is Flowryn's when a `stage.started` or `run.policy_steered` event in the window names it in its payload `steer`; those ids are read in one query (same window, `LIMIT 20 000`, a gap line when hit). Nothing depends on the naming event being at `seq + 1` any more, so an unrelated event written between the two no longer turns Flowryn's steer into an intervention.
4. **U1 and dismissals with no task.** An item with no task is a system alert (`forge_unavailable`, `nomistakes_down`, `restart_dropped`, `contract_recorded`): what fixes it happens outside Flowryn (a service restarted, the network back), so no recorded action can follow it and silence after its dismissal says nothing. Such a dismissal is left out of U1's `n` and `of` (it still counts as a `dismiss` intervention), and a gap line gives how many were left out. Before, it always matched, since "same task" never matched a null task.
5. `TERMINAL` is built from `TERMINAL_STATES` (`src/lifecycle/runs.ts`), not a second hand-written list.
6. **The report holds the daemon.** A read verb runs synchronously on the daemon's thread (`src/api/gateway.ts`), so while `flowryn stats` runs, hooks and other calls wait. Its work is bounded by the limits in Bounds; to keep it linear in them, U1 indexes interventions by task, U2 items by run and the wait summary groups in place (each was a scan or copy of a whole list per row). Bounds states the bound with a measured worst case.

Tests (`test/unit/stats.test.ts`): a nudge before the window whose run delivered in the window, and one whose run ended in it, both counted in `n`; each capped source with more closed rows than the cap and one open wait keeps the open one; Flowryn's steer with an unrelated event between it and its `stage.started` (and its policy event) is not an intervention, while a steer no event names is; a task-less dismissal is out of U1 with its gap line; and the steer-id query's cap gap.

### Build

- `src/attention/stats.ts`: `nudgeWaits` reads one join of `runs` (live, or `COALESCE(ended_at, updated_at) >= since`) with their `run.conflict_nudged` events, live runs first; the other four sources order open rows first; `ownSteers` reads the steer ids named by `stage.started` and `run.policy_steered` events from the window's first seq (`json_extract(payload, '$.steer')`), and a steer whose id is in that set is Flowryn's; `dismissedAlone` returns `taskless`, which `unneeded` turns into a gap line; `TERMINAL` comes from `TERMINAL_STATES`; `pushTo` groups U1's follow-ups by task, U2's items by run and the waits by reason.
- Measured with a scratch script (not committed) on a synthetic database at every limit: `--since 7d` took 1.3 s (window 42 ms, waits 215 ms, interventions 55 ms, store 978 ms), `--since 1d` 0.7 s. That is the bound stated in Bounds.
- Tests: four new cases in `test/unit/stats.test.ts` (nudges from before the window ended by a delivery or the run's end in it, and a run ended before the window left out; every capped source keeping its open wait; the steer cap's gap line; a task-less dismissal out of U1 with its gap line, still a `dismiss` intervention), and the steer case now has an unrelated event between a steer and the event naming it, plus a steer an unrelated event names. Each new case fails on the code before this change.
