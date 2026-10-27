# Keep a routine approval across a clean merge of main

- Status: done
- Open: not yet run against real GitHub (its update-branch merge is assumed to match git's own; if it does not, it fails closed)

Scout finding 8 (`~/.flowryn/data/scout-efficiency-and-fz/report.md`). Before this change, any new head on a delivered PR threw away its standing. The watcher opened "the PR head moved … merges wait for a new delivery", the worker had to deliver again, and the leader started a fresh verify and merge. Now a head that adds only clean merges of the default branch to the delivered one keeps its delivery for routine work (yolo, not sensitive). A verify of the new head is still required, and it is queued automatically. Plain code and git; no model.

## What "a yolo approval" means here

A routine merge takes the yolo posture at merge time (`chooseApproval`) and needs no stored record. So what a new head actually lost was the delivery: the delivered head the gate checks against, the open merge gate, and the `pr_ready` item. Those carry. A human record (`cli-tty`, `board`) still binds the exact head you saw and is voided at the carried head as at any new head. On routine work such a record only exists to waive a red check, and that check ran at the old head.

## The proof (`src/policy/clean-merge.ts`)

`cleanMainMerge(git, cwd, { from, to, base })` walks `git rev-list --first-parent --parents to ^from` (at most `MAX_CARRY_COMMITS` = 20) from the oldest commit. Every commit must pass all four checks:

- it has exactly two parents;
- the first parent is the step before (`from` for the first commit);
- the second parent is an ancestor of `origin/<base>` (one bounded `git fetch --quiet --no-tags origin <base>` when this copy lacks it);
- `git merge-tree --write-tree --no-messages <first> <second>` exits 0 (no conflicts) and prints exactly the commit's tree.

Each of these fails with its own `why`:

- a non-merge commit anywhere in the chain;
- an octopus merge;
- main as the first parent;
- a merge of a branch that is not on main;
- a merge with conflicts (its resolution is new code);
- an "evil merge" that slips an edit into a clean merge;
- rewritten history;
- any git call that fails or is cut off ("git could not say").

Every call goes through the caller's bounded `GitRunner`. Git must be 2.38 or later for `merge-tree --write-tree`.

## Where it applies

- **Delivery watcher** (`src/watch/delivery.ts`): when an open PR's head moved and `headHistory` says it descends, the watcher asks for the proof in the run's worktree, or the project checkout once the worktree is gone. The PR's base must be the run's base (`runBase`: its `dispatch --base`, else the project's default branch; docs/notes/2026-10-27-stack-a-plan-4y.md), and the proof is of merges of that branch. `applyPrObservation` (`src/reconcile/delivery.ts`) then calls `carryDelivery`, which:
  - inserts the artifact for the new head with `carried_from`;
  - voids human records;
  - appends `run.head_carried` (`pr`, `from`, `to`, `steps`, `via: watcher`, `verify`);
  - queues the verify;
  - rewrites the `pr_ready` line ("head B is A plus only a clean merge of main; verify queued (vqN)").

  The run stays `ready`, the merge gate stays open, and no steer is sent. The watcher kicks the scheduler, which drains the queue. Otherwise the divergence opens as before, and its summary names why: `, not carried: only routine work (yolo, not sensitive) carries a clean merge of main`, or `, not carried: not only a clean merge of main (<why>)`. A rewrite or unknown history keeps today's summary.
- **`deliver`** (`src/lifecycle/worker.ts`): a worker that redelivers the same PR at such a head gets the same proof before the transaction. For routine work `recordDelivery` stamps `carried_from`, appends `run.head_carried` (`via: deliver`) and queues the verify. Its reply carries `carried_from` and `verify_queued`.
- **Yolo auto-merge** (`src/verify/auto-merge.ts`, `[projects.<id>] auto_merge`): a carried head counts as a delivery. `deliver` already calls `startAutoMerge` after `recordDelivery`. On the watcher path, `applyPrObservation` calls the carry's `autoMerge` hook in the same transaction; the daemon wires it to `startAutoMerge`. That supersedes the live row at the old head and starts one at the new head on the verify the carry queued. Without the hook, the old row would be superseded as `redelivered` and nothing would merge the carried head.
- **`flowryn show`**: `carried_from: <head> (the new head adds only a clean merge of main)`.
- **Unchanged:** `checkGate` (the exact delivered head, and local green at exactly this head), `chooseApproval`, the conflict nudge, `sendBack`, sensitive and non-yolo work, and local-only deliveries.

## The re-verify

`queueCarriedVerify` (`src/verify/queue.ts`) inserts a `source = auto` request for the new head under today's verify policy. It inserts nothing in three cases: the project has no verify steps, a request is already queued at that head and policy, or a verification there is running or passed. The steps run with `autoVerifyPath`, the same PATH rule as the auto-merge's verify: the project's latest `flowryn verify` caller's PATH (`verify_path:<project>`), else the daemon's plus `~/.bun/bin`, because launchd's own PATH lacks it.

## Data

Migration 37 (`artifact-carried-from`) adds `artifacts.carried_from TEXT`. The proof's steps live in the `run.head_carried` event.

## Evidence

Consecutive delivered heads in flowryn.db (76 pairs up to 2026-10-23), classified with this proof against the repository:

| Pairs | What the new head added |
|---|---|
| 52 | A merge of main with conflicts (mostly `docs/m5-notes.md`, `src/db/schema.ts`, `test/unit/db.test.ts`, `docs/v1-status.md`) |
| 7 | A clean merge alone |
| 7 | A clean merge mixed with the worker's own commits |
| 5 | Own commits only |
| 4 | Rewritten history |

The payoff grows as the conflict hotspots go (`2026-10-22-remove-conflict-hotspots-24.md`).

## Tests

- `test/unit/clean-merge.test.ts` (real git), covered cases:
  - a worker's clean merge, which also checks that merge-tree writes the same tree as `git merge`;
  - two clean merges in a row;
  - an older main commit as the second parent;
  - a stale copy that fetches main once.

  Refused (not carried): a conflict resolved by hand, an evil merge, a non-main branch, main as the first parent, an octopus merge, a clean merge plus an own commit, a rebase, more than 20 commits, a cut-off `merge-tree`, and a missing head.
- `test/unit/carry-delivery.test.ts` checks:
  - the watcher-side carry (artifact, event, no divergence, run ready, gate open, ready line);
  - the queued verify, its PATH and dedupe, and no request when the project has no steps;
  - a human record voided;
  - sensitive and non-yolo work kept on the old path with the reason, and so is a failed proof;
  - the `deliver`-side carry, and a proof from another head that is ignored;
  - an opted-in auto-merge: the old head's row is superseded, and the new head's row waits on the carried verify.
- `test/integration/clean-merge-carry.test.ts` (real daemon, fake GitHub over a bare origin):
  - main moves and is merged into the PR branch; the watcher carries the delivery, the queued verify passes at the new head, and `merge` lands under yolo at that head;
  - with `auto_merge = true`, the carried head auto-merges with no `merge` asked;
  - an evil merge keeps the divergence, queues no verify, and `merge` refuses `head_moved`.
- `test/unit/db.test.ts`: migration 37.

## Choices

- Chains of clean merges carry: two refreshes before a verify are still only main.
- The verify is queued in both paths: it is required, and starting it is mechanical.
- `main` is fetched only when the second parent is not already on the local copy.
- A column on `artifacts`, not a new table: one carried head per artifact, and the proof sits in the event.
- Local-only branches are left out: they are rare, and their gate already wants a fast-forward of main.
- `verifyPolicy` is optional in `DeliveryWatcherDeps`. Absent means no verify steps, so tests that build a watcher need no change. The daemon wires it from `[projects.<id>] verify`.
