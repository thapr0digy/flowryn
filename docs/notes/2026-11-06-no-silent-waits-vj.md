# No silent waits: every wait has a deadline, and an expired wait acts by itself

- Status: done
- Open: not yet run against a live home
- Config: `[waits] verify_queue_min`, `[waits] capacity_min`, `[waits] host_min`, `[waits] harness_check_min`, `[waits] phase_start_min`, `[waits] auto_merge_min`, `[waits] landing_min`

Two stalls on 2026-11-06 went unnoticed for hours. In the first, auto-merge am4 waited 2.5 h on verify request vq128. The verify queue had cancelled that request: GitHub still showed the head the delivery was carried from, so the drain read it as "the PR head moved". In the second, phase 2 of a plan waited about 2 h on the host check (7.8 GB free against an 8 GB floor), and the only signal was the 30-minute capacity P1. Both had the same cause. A wait ended only when some event arrived, and nothing timed it out when that event never came. This change fixes it with plain code (a table, timers and the reconciler) and no model.

## A lost verify is queued again at once (`src/verify/auto-merge.ts`)

The auto-merge used to wait up to 6 h on a request cancelled because its head moved. It held at once on a request that was gone, or on a verification cut off by a second daemon stop. Now each of those cases calls `requeueLost`:

- **A cancelled request.** Any cancel reason except a final one: a closed or merged PR, GitHub having no such PR, the project or its verify steps gone (`cancelIsFinal`, `src/verify/start.ts`).
- **A request that is gone.** For example, one dropped while the daemon was down.
- **A verification that is gone, or cut off by a stop.** This includes a stop that interrupted a rerun, which the startup recovery requeues only once (`interruptedByStop`).

`requeueLost` queues a verify of the current head and writes one `auto_merge.verify_requeued` event. The event records why (`why`), which request or verification was lost, the head, what the row now follows and the attempt number. It also kicks the scheduler, so the new request drains straight away.

- **The head GitHub read.**
  - If it is an earlier delivered head of the task (`staleRead`, typically the head a carry started from), GitHub has not caught up. The delivered head is verified again. A carried head follows the existing carried rule: its re-verify is never skipped.
  - If it really moved (the watcher's evidence shows a new head that was never delivered), that head's verify is queued. The row is superseded (`head_moved`), and the delivery of that head starts the next auto-merge on the verify already queued. If no delivery comes, the watcher's head-moved item tells the leader.
  - If the watcher's evidence still shows the delivered head (it has not re-read the PR yet), the row is left as it is for that pass, and no requeue is counted. The registry's `auto_merge` deadline bounds this. Evidence showing any other head that was never delivered (the head moved again) counts as moved. A local-only move has no evidence to wait for, so the delivered head is verified again, up to the cap.
- **The cap.** After `MAX_VERIFY_REQUEUES` (3) requeues of one row, the row holds (`auto_merge_held`) with `flowryn verify <task>, then flowryn merge <task>` (just `flowryn verify <task>` for an auto-verify row, `merge = 0`).
- **The landing queue.** It drives its head of line through the same rows, so lq4 and lq5 get the same recovery.
- **Auto-verify rows** (`merge = 0`, docs/notes/2026-11-06-auto-verify-every-t8.md) get the same recovery: a requeued verify that has already passed moves the row to `verified`, not `waiting_checks`.

The drain no longer cancels on a stale read. When GitHub shows an earlier delivered head of a task whose latest delivery is the request's head, the request waits instead. It waits up to `STALE_READ_WAIT_MS` (5 min) from when it was requested, and is cancelled after that.

## Shorter auto-merge waits, and a queue a waiting request does not block

The leader's audit (steer m576) added these:

- **A passed verify whose PR head moved** and was never redelivered now holds `HEAD_MOVED_WAIT_MS` (30 min) after the auto-merger first saw the move, not 6 h. The first sighting appends one `auto_merge.head_moved_seen` event for the row (its id and the moved head), and the clock counts from that event, not from when the row began waiting on checks, so a push after a long CI wait still gets its 30 min. The merge gate's `head_moved` retry uses the same event and bound.
- **GitHub's checks** may stay pending `CHECKS_WAIT_MS` (6 h). On a project whose default branch's `.no-mistakes.yaml` says `no_ci: true`, the limit is `NO_CI_CHECKS_WAIT_MS` (1 h). The daemon reads the file through bounded git and keeps the reading for a minute (the auto-merger's `noCi` dep).
- **The verify drain** (`drainVerifyQueue`) still starts requests in order. A request that has to wait on its own PR now steps aside for that pass, so the requests behind it start. Such a wait is GitHub lagging, GitHub unreachable, or an invalid project config. A full validation pool, a pending restart or a failing host check still hold the whole queue. The registry tracks only the first request: a second request that also waits on its own PR behind a waiting first has no deadline of its own until the first starts or is cancelled. Recording the drain's per-request wait reason, so each gets its own, is a follow-up.
- **The scheduler's `capacity_wait` P1**, opened by runs waiting over `[sched] wait_alert_ms`, also names the oldest queued verify in the queue's own order, with its id, task and age (`oldest queued verify vq1 (t1) 31m`). A queued verify alone never opens it: the registry's `verify_queue` wait covers that.

## The wait registry (`src/reconcile/waits.ts`, `src/reconcile/wait-deadlines.ts`)

`collectWaits` lists every waiting state there is now. One table (`WAIT_DEADLINES_MS`) gives each kind its deadline:

| kind | what waits | counted from | deadline |
|---|---|---|---|
| `verify_queue` | the first request in the verify queue | its expected start: the later of its request time, the last move of a request ahead of it, and the usual end of each running verify not started from a request behind it (its project's slowest of the last 5 passes, else its timeout) | 20 min |
| `capacity` | a run waiting for a grant (pools, project limit, usage limit, quota, sign-in) | `runs.waiting_since` | 10 min |
| `host` | a run whose latest refusal is `capacity.host_check` | `runs.waiting_since` | 10 min |
| `harness_check` | a run whose latest refusal is `capacity.harness_unverified` (the automatic contract check) | `runs.waiting_since` | 20 min |
| `phase_start` | an approved plan's automatic phase, on a `plan`-autonomy project, whose blockers have landed and that has no run | its last blocker's `run.landed` or `run.cleaned`, else the plan's approval | 10 min |
| `auto_merge` | a live auto-merge not following a queued request or a running verify (those are the queue's and the verify's own deadlines) | `state_since`; a PR head that moved, its `auto_merge.head_moved_seen` | 30 min; a PR's pending checks, the auto-merger's own checks limit (6 h, 1 h under no_ci, from the daemon's same no_ci reading) |
| `landing` | each project's first waiting entry while none of its entries is landing | `state_since` | 30 min |

`[waits] <kind>_min` overrides a deadline in whole minutes, from 1 to 1440. Any other key or value refuses the config at load: the effective config's `waits` section, which `flowryn config` shows.

### The pass

The reconciler runs `checkWaits` on each full pass (the `checkWaits` dep wired in `src/daemon/daemon.ts`). Each wait goes through these steps:

1. **Past its deadline: recovery first.**
   - A row in `waits` (migration 56) records it, with a `wait.recovered` event.
   - The pass then kicks the scheduler (`verify_queue`, `capacity`, `host`, `harness_check`, `phase_start`) or the auto-merger (`auto_merge`, `landing`). A scheduler pass drains the verify queue, re-reads the host check, grants, and re-evaluates every phase's blockers (`autoDispatch`). An auto-merger pass re-queues a lost verify as above and moves the landing queue.
   - Recovery never passes a gate, answers a decision or merges.
2. **Still there on a later pass (at least `RECOVERY_GRACE_MS`, 30 s, after the recovery): one item.**
   - A `wait.expired` event, and one `wait_expired` item (P1, actionable, routed `act` in `LEADER_ROUTE`, so it wakes an idle leader once).
   - Its line puts the command before the cause, so a digest that cuts the line keeps the fix: `Waiting 11m, past its 10m deadline: <what> (<title>); <fix>; why: <cause>`.
   - A host wait gives the measured value, the floor and the key: `7.8 GB free memory, under the 8 GB floor ([capacity.host] min_free_mem_gb)`. Its fix is `free the host, or change [capacity.host] min_free_mem_gb in config.toml (the daemon reloads it); flowryn capacity`.
   - A run that is a plan phase is named `phase N of "<plan>" (<task>), stage <stage>`, so when a phase waits for a grant the item says why.
   - The first verify request names what the drain waits on: an invalid `[projects.<id>]` config (its fix starts with `flowryn config`), a GitHub outage, else its place in the queue, a restart, a full pool or the host check.
   - A phase with no run says why it has not started: not in the backlog snapshot, not queued, held, its `phase_blocked` reason, or that the scheduler has not started it. Its fix is `flowryn dispatch <project> --task <id>`.
   - Item text holds only task ids, durations, measured values and commands.
3. **A wait some other open item already carries** (`usage_limit`, `quota_low`, `account_signed_out`, `harness_unverified`) is recovered, but never itemized twice. Its row records `covered:<item>`, and the registry never resolves an item it did not open. Each pass checks the cover again: once that item closes (or the run's refusal changes), the wait is itemized.
4. **A wait that ends,** or one that starts a new episode (a different `since`): its row is deleted and its item resolved (`wait ended`), with a `wait.cleared` event.

The scheduler's 30-minute `capacity_wait` P1 no longer opens when every run waiting that long already has its own registry item (its `run:<id>` row), or a cover that is still open.

## `flowryn fleet`

Each entry of `waiting[]` now carries `wait` (the kind), `age` and `deadline` (`in 8m`, or `passed 2m ago`). A run's entry keeps the words of its recorded explanation. A wait with no run explanation (the verify queue, an auto-merge, a landing entry, a phase with no run) is listed with the registry's own words and fix. An invalid `[waits]` table, which the daemon refused, shows the entries without the clock rather than failing the read.

## Choices

- Waits are computed from the live tables on every pass, not stored as their own state machine. Only expired waits get a row, so the registry cannot drift from what it describes.
- The auto-merge's own recovery runs on its next pass with no deadline. A lost request is never something to wait out. The registry's `auto_merge` deadline covers what is left: a merge unproven, a head moved with nothing delivered, or checks pending. Pending checks are due at the auto-merger's own limit, not 30 min, so slow CI does not wake the leader while the auto-merger still waits legitimately.
- A verify started from a request behind the first is not counted in the first's expected start, so requests that step past a waiting first never slide its deadline. The cost: a first request waiting on a full pool that such a verify holds can get a `wait_expired` P1, which resolves itself once it starts. A bounded false P1 beats a silent stuck request.
- The phase deadline counts from the blocker's cleanup as well as its landing, because a phase becomes ready only once its blocker's run is cleaned (`hasLanded`).

## Tests

- `test/unit/auto-merge.test.ts`:
  - A cancelled verify is queued again at once, up to `MAX_VERIFY_REQUEUES`, then held.
  - A stale GitHub read re-verifies the delivered head.
  - A head that really moved gets its verify queued, and its delivery follows it.
  - A moved head the watcher's evidence does not show yet leaves the row for that pass and counts no requeue; evidence newer than the cancel's head supersedes at once; a local move is requeued.
  - A request that is gone is requeued; a final cancel holds.
  - A second interruption by a stop is requeued.
- `test/unit/auto-merge.test.ts` also covers the 30-min head-moved hold, counted from the first sighting (checks pending 31 min, then a push, holds only 30 min after the push was seen), and the 1 h no_ci checks limit.
- `test/unit/verify-queue.test.ts`:
  - A request waiting on its own PR steps aside, and the request behind it starts.
  - A stale read waits up to `STALE_READ_WAIT_MS`, then is cancelled.
- `test/unit/capacity-alert.test.ts`:
  - A queued verify alone opens no `capacity_wait`. Runs waiting over the threshold open it, with the oldest queued verify (in queue order) and its age, and it closes once nothing waits that long.
  - A run whose own registry wait is itemized opens no second P1. One whose cover has closed, or whose only itemized wait is another key, still counts.
- `test/unit/waits.test.ts`:
  - The `[waits]` table and its validation.
  - A host-held launch is recovered at 10 min, then itemized with the numbers, wakes the leader, and the item resolves when the wait ends.
  - A covered usage-limit wait, itemized once its cover closes.
  - A phase that did not start after its blocker landed is re-kicked, then itemized; its run starting ends the wait.
  - The verify queue's expected start; requests that go past a waiting first request never move its deadline.
  - The first request's cause names an invalid project config or a GitHub outage.
  - An auto-merge waiting on checks is due at the checks limit (1 h under no_ci); one whose head moved is due 30 min after the move was first seen.
- `test/integration/no-silent-waits.test.ts`, with a real daemon and the fake GitHub:
  - A verify cancelled mid-auto-merge is queued again at once and both PRs land.
  - A restart that drops a queued verify is followed by a requeue and both land.
  - `flowryn fleet` shows the queued verify's age and deadline.
