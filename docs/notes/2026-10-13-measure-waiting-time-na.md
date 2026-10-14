# Measure waiting time, interventions and store growth

- Status: partial
- Open: the build (this file holds the design only so far)

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
5. **Conflict nudges** (`run.conflict_nudged` events): the nudge → the run's next `run.delivered` event; reason `conflict nudge`. A run that ended without delivering again ends the wait at its `ended_at`. Open while the run is live and has not delivered again. Nudges are read from the window's events plus the events of every live run (by the `events_run` index).

The window rule is the same for every source: the duration statistics cover waits that **ended in the window**; `open` and `oldest` cover every wait open **now**. A wait that started before the window and ended in it counts in full.

### Interventions

An intervention is a verb a person or the leader ran that changed a run, read from the window's events (plus `approvals` rows). The `interventions` table has `action`, `by` and `n`; `by` is the role the event records (`leader`, `human` shown as `you`, or the approval channel), `-` where nothing records it.

| action | event (rule) | by |
|---|---|---|
| `answer` | `decision.answered` | payload `by` (`captain` → `you`, `leader`) and `via` |
| `dismiss` | `item.dismissed` | payload `by`; a dismissed decision is counted here once, through its item |
| `gate pass` | `gate.passed` of a review gate (payload has `channel`) | the approval channel (`claude-ask`, `claude-chat`, `cli-tty`, `board`, `pi-confirm`) |
| `gate changes` | `gate.changes` | payload `by` |
| `approve merge` | `approvals` rows with `action = 'merge'` created in the window, not `yolo` | the channel |
| `decline` | `run.declined` | payload `by` |
| `steer` | `steer.created` with no decision, whose next event (`seq + 1`) is not a `stage.started` or `run.policy_steered` naming the same steer: those are Flowryn's own stage-start and policy-follow steers, written in the same transaction. Answer and dismissal steers carry their decision and are left out | `-` (not recorded) |
| `cancel` | `operation.requested` with payload `kind = cancel` | payload `by` |
| `resume` | `run.resume_requested` | payload `by` |
| `interrupt` | `run.interrupted` | `-` (not recorded; it includes an urgent steer's preemption) |
| `divergence resolve` | `divergence.resolved` | payload `by` |
| `capacity resume` | `sched.usage_resumed` with source `cli`, `sched.quota_override` | `you` |

### Unnecessary interventions: three rules

Each is a pure rule over recorded rows; the `unneeded` table lists `rule`, `n`, `of` (what it is counted out of) and `detail`.

- **U1 `dismissed alone`**: an `item.dismissed` after which nobody intervened on the same task (any action in the table above other than `dismiss`) within 10 minutes. The item asked for attention it did not need; `detail` lists the item kinds, most first (that is where the noise comes from). Out of: dismissals.
- **U2 `steer to a busy run`**: a non-urgent `steer` whose run's last `run.liveness` before it was `busy` (the worker was mid-turn) and that had no open actionable item at that moment. Nothing about the run asked for one. Out of: steers. Read per steer with the `events_run` index (the latest `run.liveness` with a lower `seq`).
- **U3 `answered as recommended`**: a `decision.answered` whose answer equals the decision's non-empty `recommendation`. The asker already knew the answer it got, so a default could have stood. `detail` splits it by asked-to (captain or leader). Out of: answers to decisions with a recommendation.

Rules only count. None of them changes behaviour; they show where an automatic default or a quieter item would save a turn.

### Store growth and latency

- **Database**: the file, `-wal` and `-shm` sizes (`stat`), `page_count × page_size` and the free pages (`freelist_count`). An in-memory database says so.
- **Rows per table**: every table in `sqlite_master`, `COUNT(*)`, largest first. `events` uses `MAX(seq)`: it is append-only (triggers refuse UPDATE and DELETE) and its rowid has no gaps, so the maximum is the count without a full scan.
- **Events per day** in the window (UTC days, since the window may cross a time zone change): count and payload bytes. **Largest event kinds** in the window: the top 10 by count, with bytes.
- **Latency**: the `fleet` and `brief` reads, each run three times on the same database through their own verb code, median in ms (as a human caller, so `brief` composes the whole briefing). Also `took`: each section of this report.
- **State directory**: each top-level entry of `state_dir` (`logs`, `runs`, `backups`, `bin`, the database files, …), its bytes and file count, symlinks not followed. The walk stops at 20 000 entries in all and marks a capped entry `≥`.

### Bounds

- `events` has no time index. The window's first event is found by binary search on `seq` (`O(log n)` primary-key reads), assuming `ts` does not decrease as `seq` grows (the daemon appends with its own clock; a clock stepping back can move the edge by those few events). Every event query then reads only `seq >= that`, with `LIMIT 20 000` rows per query; a hit limit is a gap line (`capped`).
- `decisions`, `gates`, `items` and `explanations` have no time index either; they hold one row per wait or decision, orders of magnitude fewer than `events`. Each read takes the rows ending in the window or open, `LIMIT 5 000`; a hit limit is a gap line. `took` shows when this stops being cheap.
- Per-steer and per-nudge lookups use `events_run (run_id, seq)`.

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
