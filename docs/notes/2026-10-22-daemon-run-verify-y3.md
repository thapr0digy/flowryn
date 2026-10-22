# Daemon-run verify queue and yolo auto-merge

- Status: partial
- Open: phase 2 (yolo auto-merge, `[projects.<id>] auto_merge`) is plan p13's next phase; two flowryn suites at once on this Mac not yet run live

Scout findings 4, 6 and 16 (`~/.flowryn/data/scout-efficiency-and-fz/report.md`). All 15 merges so far were started by hand by the leader (`merge.requested` source `cli`, 15 of 15). `flowryn verify` refuses a second job (`verify_busy`), with no queue. The user decided on 2026-10-22 that yolo ships verify and merge with no leader turn, opt-in per project, never for sensitive work. It is turned on for fathom first, and for flowryn only once a daemon restart no longer drops a running validation or verify.

Everything here is plain code: a queue table, a per-delivery state machine, the existing merge gate and restart guards. No model is used.

## Evidence the design rests on

- Every `restart_dropped` so far was a `daemon.restart_expired` whose guard was a validation (`validation: next-steps-md-rz (validating for 103 min)`; six events from 2026-10-05 to 2026-10-13). None was a verify.
- A validation is not flowrynd's work. The no-mistakes pipeline runs in the shared no-mistakes daemon (its own launchd agent), so `kickstart -k` of flowrynd stops none of it. The slot, `validating` and the stage are rows, and the watcher reads the status again after a restart. The m5 notes "Why re-attach holds" record this, and `test/integration/restart-ci-wait.test.ts` proves it for a CI wait.
- A verify is flowrynd's work. Its steps are children of the daemon, launchd's restart kills them, and startup recovery records the row as `error` (`recoverVerifications`).

## Phase 1: verify queue and restart (built)

### Queue

- New table `verify_queue` (the next free migration number): `id` (`vq<n>`), `project_id`, `pr_url`, `task_id`, `head_sha`, `policy_id`, `source` (`cli`, `auto` or `recovered`), `path`, `requested_at`, `rank` (0, or -1 for a recovered job, which goes to the front), `state` (`queued`, `started` or `cancelled`) and `verification_id`. The `verifications` table and every gate query on it stay as they are, so a queued request can never count at the merge gate.
- `verify.start` resolves the target and head as today. It then:
  - attaches to a running job, or a queued request, with the same PR, head and policy;
  - starts the job at once when the queue is empty, a `validation` slot is free, the host check passes and no restart is parked;
  - otherwise queues the request and replies `queued` with the request id and its position ("2 of 3, behind v41 and vq7").
- `verify_busy` goes away: the "another policy at the same head" case is queued like any other request.
- The queue drains in the scheduler's pass, before stage grants (the "drain before fill" rule: a verify is the step closest to shipping). Order is rank, then `requested_at`. Each start takes a `validation` lease in the same transaction as its `verifications` row, so concurrency is the pool's cap (5 today), under the host check. While a restart is parked, no queued verify starts, and none starts once the daemon is shutting down. A queued request whose PR and head already have a running verification under today's policy follows that one (it is marked started with its id) instead of starting a second.
- `flowryn verify show` takes a `vq<n>` too: its position, or once started, its verification. The CLI follows a queued request through to its result. `--detach` returns the request id.
- A queued request for a PR that has closed or moved to another head (a redelivery), or whose project no longer has verify steps, is `cancelled` with its reason (as built, below).
- PATH: a request from the CLI keeps the caller's PATH, as today. A daemon-made request (phase 2) uses the PATH of the latest CLI verify of the project, kept in meta (`verify_path:<project>`), and otherwise the daemon's own PATH plus `~/.bun/bin`.

### Restart

- **Validations are carried across a restart, not waited on.** The `validation` guard leaves `restartGuards`, and the guard reply lists them as "carried: validation t1 (...)". This removes the only cause of every `restart_dropped` so far.
- **Verifies are drained.** A parked restart (automatic or `--when-idle`) still waits on the `verifying` guard, and the scheduler starts no queued verify while it is parked. The wait is bounded by `verify_timeout_min` (45 min for flowryn).
- **An interrupted verify is resumed.** Startup recovery still records the interrupted row as `error` (`the daemon stopped mid-run`), then queues the same PR, head and policy at the front (`source = recovered`), once per verification. A second interruption opens the usual item instead.

## Phase 2: yolo auto-merge (not built: plan p13)

The user's answer in the design review (q78): a verify that fails because a step exited non-zero sends the ship back to its worker once per head, with the failing step and its tail. A timeout, an `error`, or a second failure at the same head opens `auto_merge_held` for the leader.

- `[projects.<id>] auto_merge = true` (default false). It is refused (`config_invalid`) for a project with no `verify` steps, since without them the gate passes a PR that has no checks.
- **Trigger.** In the `deliver` verb's transaction, when the project opts in, the task is yolo and not sensitive, and the delivery is a PR or a local-only branch: insert an `auto_merges` row (`queued`) and a `verify_queue` request (`source = auto`) for the delivered head. A redelivery at a new head supersedes the earlier row and its request.
- **State machine** (`src/verify/auto-merge.ts`, one row per run and head), driven by `pr.verified`, the delivery watcher's observations and a 60 s timer:

  | From | Event | To |
  |---|---|---|
  | queued | verification started | verifying |
  | verifying | passed | waiting_checks |
  | verifying | failed or error | held, which opens the item (see Q1) |
  | waiting_checks | checks not pending | merging, through the merge path |
  | waiting_checks | over 6 h pending | held |
  | merging | merged | merged (existing `yolo_merged` and `landed` items) |
  | merging | gate refused | held, with the gate's code and message |
  | merging | unproven | stays; the existing `unproven_merge` P1 covers it |
  | any | run not ready (sent back, cancelled, redelivered) | superseded |

- **The merge** is the `merge` verb's prepare, apply and settle, factored into one function that both the verb and the controller call. The caller is the daemon, so `chooseApproval` finds no leader channel and picks the yolo posture: channel `yolo`. `checkGate` is not changed. The event source is `daemon`, and `merge.requested` carries `by: auto`.
- **Items.** New `auto_merge_held` (P1, actionable, in `LEADER_WAKE_KINDS` and `AWAY_WAKE_KINDS`), whose line gives the reason and the next command. `pr_ready` still opens, and its line reads "auto-merge: verify queued (vq7, 2 of 3)", so the leader does not start a second verify (it would attach anyway).
- **Not swept.** A PR delivered before the project opted in is not picked up. `flowryn verify` and `flowryn merge` cover it as today.
- **Turning it on** is the user's config edit: `[projects.fathom] auto_merge = true` first. Flowryn is only turned on after phase 1 has run through a few merges with no `restart_dropped`. This PR changes no one's config.

## What phase 1 built

- `verify_queue` is migration 28. `src/verify/queue.ts` is the store. `src/verify/start.ts` admits a request (its verification row, its `validation` job lease and `started`, all in one transaction) and drains the queue. Events: `verify.queued`, `verify.dequeued`, `verify.cancelled` and `verify.not_requeued`.
- `verify.start` (`src/verify/verbs.ts`):
  - Every call is a request.
  - It attaches to a running job with the same PR, head and policy, or joins a queued request with the same three (`attached: true`).
  - It starts at once only when nothing is queued, no restart holds verifies back, a slot is free and the host check passes.
  - Otherwise it replies `queued: true` with `request`, `position` ("2 of 3") and `waiting` ("behind vq2", "the validation pool is full (1/1: t3 (ship))", "the host check fails (...)", "a daemon restart asked for 4 min ago waits for the running verifies first").
  - `verify_busy` and the `no_capacity` refusal of a verify are gone. A second policy at the same head is simply another job.
- The scheduler's grant step drains first (`SchedulerDeps.drainVerifies`, wired in `src/daemon/daemon.ts`).
  - The first queued request either starts, is cancelled, or holds everyone behind it. Order is rank, then `requested_at` (FIFO).
  - Before it starts, it is checked again: its PR is still open at the same head (or, for local-only work, the worktree HEAD has not moved), and the project still has verify steps. If not, it is cancelled, and the reason is recorded on the request.
  - A GitHub outage or an invalid config leaves it queued.
  - A start always runs today's steps, under today's policy.
- The restart hold (`restartHoldingVerifies` in `src/daemon/restart.ts`): a parked restart request or a handoff under way holds queued verifies back for at most `RESTART_HOLDS_VERIFIES_MS` (60 min). The bound exists so a restart that waits on something else (a confirmation dialog) cannot stop every verify.
- `flowryn verify show vq<n>` gives the place in line, what it waits on, and the verification once started. The CLI follows a queued request (one line each time its place changes) and then its verification. A cancelled request ends the CLI with `verify_cancelled`. `--detach` returns the request.
- `flowryn capacity` lists `verify_queue` (request, PR, task, waited, why) when anything is queued.
- Restart:
  - `restartGuards` has no `validation` guard. `carriedValidations` lists those runs, with their no-mistakes step, in the restart's reply (`carried`), in the `daemon.restart_requested` event and in the CLI's restart reply.
  - A parked restart no longer re-reads no-mistakes every 5 s, since no guard depends on that read.
- Recovery (`src/verify/runner.ts`): a verification stopped with the daemon (recorded by the job itself), or found running at startup, is recorded as `error`. It is then requeued at rank -1 with `source = recovered` and `recovered_from` set, once. `verify show v<n>` shows `requeued: vq<n>`. A verification started before migration 28 has no request and is not requeued.
- Fetching a PR head uses `--no-write-fetch-head`, so jobs in one repository can fetch at once.
- Tests:
  - `test/unit/verify-queue.test.ts`: the migration; order, position and joining; what a request waits on; the restart hold and its bound; the drain up to the cap and FIFO; jobs in one repository each fetching their own PR head at once; holds by restart, host and pool; cancellation of a closed PR, a moved head or a project with no steps, and an outage that leaves the request queued; today's policy at start; the requeue from startup recovery and from a stop, once only, and not for a verification from before migration 28.
  - `test/unit/restart.test.ts`: validations carried in every shape, never a guard.
  - `test/integration/verify.test.ts`: jobs side by side; queued under host pressure, then started by the scheduler; a policy change runs its own job; the CLI following a queued request to its result, and to `verify_cancelled` when the PR closes.
  - `test/integration/capacity.test.ts`: a verify queued behind a ship's slot, shown by `capacity`.
  - `test/integration/restart-ci-wait.test.ts`: a review step with a local agent is carried across a real restart and the slot is released at delivery; a requested merge still holds a restart, and its drop reaches the leader's Stop.

## Assumptions the build must test

1. Two verifies of the same project at once do not collide on `git fetch` ref locks or on pruning. Test: two concurrent jobs in one repository.
2. A validation with a local agent step (review) survives a flowrynd restart, and the slot is released at delivery. Test: extend `restart-ci-wait.test.ts` with a review step that has an agent.
3. A daemon caller reaching `chooseApproval` gets `yolo` and nothing else, and a sensitive run is refused. Test: unit cases.
4. The scheduler's pass ordering puts queued verifies before ship-stage grants without starving a stage.
5. A flowryn `bun test` and the contract `--verify-only` step tolerate a second suite running beside them (sockets in temporary homes). Test: run the real steps twice at once on this Mac before turning flowryn on (an operational check, not CI).

## Risks

- Two heavy flowryn suites at once on one Mac slow each other. The host check (load per core, free memory) holds the third. Mitigation if it is not enough: a per-project verify cap later.
- A `blocked_prompt` guard can still hold a restart past 240 min. That is out of scope here; the `restart_dropped` item still says so.
- Auto-merge on flowryn restarts the daemon after every merge. Phase 1 makes that safe, but it is only proven once it runs live.

## Choices made

- A separate `verify_queue` table, not a `queued` state on `verifications`. That avoids a table rebuild (the CHECK constraint), and the gate's queries cannot see a request that never ran.
- Validations are carried, not waited on: they live in no-mistakes, and every recorded drop was a validation wait.
- Verifies are drained, not killed and requeued, on a planned restart. Killing them would redo up to 20 min after every flowryn merge. Requeueing is only for a stop nobody planned.
- `auto_merge` requires verify steps.
- Deliveries made before the opt-in are not swept.
- One merge function is shared by the verb and the controller, so the gate, approvals and events stay in one place.
- Two phases: the queue and restart first (flowryn's own precondition), then auto-merge.
