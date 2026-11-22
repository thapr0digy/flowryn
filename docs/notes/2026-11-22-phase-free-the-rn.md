# Free the worker slot at delivery on batch-landing projects

- Status: done
- Open: not yet run live on appsec-signal

Plan p104, proposal 7. On 2026-11-22 at 08:4x, 2 of 7 held worker slots belonged to ship runs that had delivered and were only waiting to land, while fixes waited for a slot. On a project with `landing = "batch"`, the daemon lands the branch; the worker has nothing left to do unless the branch is sent back. Lauren Tan's rule (pstack) is that each fix round goes to a fresh agent with the original brief plus the failure. Plain code: a lease release, a scheduler step and the send-back's launch choice. No model, no config key, no migration.

## What happens

1. **At delivery.** A `deliver --local` on a batch-landing project (`landingBatched`) releases the run's worker slot in the delivery's own transaction, with the reason `delivered to the landing line` (`pool.released`). The stage pools went back at delivery already. The scheduler is kicked, so waiting work can take the slot. Every local delivery there counts: routine work, a sensitive branch that lands alone, a batch's fix, and work that waits for your approval.
2. **The idle worker is retired.** Each scheduler pass exits the worker of every run that is still `ready`, whose latest worker slot was freed at delivery, and that the reconciler reads `idle`. It is not retired while a launch is pending, an operation is open or escalated, or a steer is unacknowledged (`workersToRetire`, `src/sched/pools.ts`). The exit uses the worker's recorded identity, as a fresh stage's replacement does, and records `run.worker_retired` (`pid`, `reason`). The reconciler then reads the worker dead as `exited_after_delivery`, which is not a failure, so nothing auto-resumes it. A refused exit is logged and retried on the same backoff as a refused replacement.
3. **A send-back starts a fresh session.** Any send-back of such a run asks for a `stage` launch, not a `resume`. That covers a light-check failure, a conflict, a batch drop, `flowryn decline`, or a validator-passed gate reopened. The run waits for the scheduler's grant, which takes a worker slot again (and the stage's pools), exits the old worker if it is still alive, gives the run a new session id (`run.fresh_worker`) and launches it in the same worktree on the same branch. Its task file carries:
   - the stage's steps,
   - the send-back text as the stage note (the failing step and its log tail),
   - the carried context (the plan brief),
   - the task as dispatched.

   One rule decides the launch for every send-back: `workerReturnLaunch` (`src/lifecycle/send-back.ts`). It returns `stage` when the run's latest worker slot was freed at delivery, `resume` for a worker gone otherwise, and none while the worker holds its slot.

On other projects nothing changes: the worker keeps its slot until its run lands.

## Choices

- **A fresh session in the same run, not a new run.** The landing line, approvals, merge records and the backlog all key on the run and its branch. A new run would need a second delivery path. The fresh session gets what a new run would: the brief, the failure and the branch. This is the same mechanism a workflow stage with `fresh = true` uses.
- **Retired once idle, not at the delivery call.** The worker is still mid-turn when `deliver` replies. The reconciler's `idle` reading means the turn ended. Retiring a worker that owes an acknowledgement would lose that steer, so it is kept until it acknowledges.
- **The scheduler retires, not the reconciler.** The scheduler already exits workers by identity (fresh stages, relaunches), with a backoff on refusal, and its passes are serialized with its grants, so a retirement never races a fresh launch that the scheduler itself starts.
- **No config option.** On a batch project the daemon lands the branch, so a waiting worker only holds a slot. Rejected: freeing the slot on queue projects too. Their send-backs today resume a session that knows the branch, and the proposal named batch projects.
- **No new state.** Whether a slot was freed at delivery is read from the run's latest `pool_leases` row (`released_by`), so it survives a restart and needs no migration.

## Known limits

- A steer sent to a delivered run after its worker was retired reaches no one until a send-back starts a fresh worker. `flowryn decline <task>` sends the run back with your words.
- The fresh session loses the old one's in-context knowledge. The brief, the failure tail and the branch's commits are what it has, which is the proposal's intent.

## Tests

- `test/unit/freed-worker-slot.test.ts`, through the real scheduler and send-back:
  - only the latest slot counts;
  - an idle freed worker is retired once, with its event, and a dead one never;
  - workers are kept when they hold their slot, exited for another reason, are busy, owe an acknowledgement, or were sent back;
  - a refused exit backs off;
  - a send-back after the slot was freed asks for a fresh session, and the grant takes the worker slot, exits the old worker and launches `stage` with a new session and the failure in the note;
  - a worker that holds its slot carries on with a steer, and one gone otherwise resumes.
- `test/integration/landing-batch.test.ts`, with a real daemon and fake workers: a delivery frees the slot, the idle worker is retired and read dead, the light check's send-back starts a fresh session (no auto-resume), which commits the fix carried in the failure and delivers again, and the branch lands.
