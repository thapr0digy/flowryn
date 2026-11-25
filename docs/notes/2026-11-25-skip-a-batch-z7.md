# A verify reuses a pass at the same tree

- Status: done
- Open: the frequency of reuse in Signal's batches is not measured yet (`flowryn verify show v<N>` says `reused`)

A verify of any kind (gate, landing batch, baseline, train candidate, light check) that would run exactly the steps a passed verify already ran on exactly the same files records that pass instead of running them again. It finishes in a second or two instead of a full verify (about 12.5 minutes for Signal). Typical cases: a landing batch rebuilt after a split, retry or requeue, with main where it was; or a batch of one branch whose merge onto main gives the tree the branch's own gate verify already passed. Reuse is always on; nothing configures it.

## When it reuses

All of these must match a passed verification (`src/verify/store.ts` `passedAtTree`):

- the same project;
- the same verify policy (`policy_id`: the normalized steps in order, their `when_changed` globs, the binary and the reviewer, `src/verify/policy.ts`). A light check and a full verify have different policies, so a light pass never satisfies a full verify, and a full pass does not satisfy a light check either (the step lists do not say a full pass covers it, so it runs);
- the same head tree (`git rev-parse <head>^{tree}`); the commit may differ;
- the same base key (`src/verify/changed.ts` `baseKey`), described below;
- the earlier one passed, ran every step as configured (no step was a landing batch's flake rerun of only the failed tests), and recorded a key;
- neither has a review step (`flowryn:review`): the reviewer reads the task's brief, which is not in the tree, so a verify with one always runs (`test/unit/verify-review.test.ts` reviews one tree twice with two verdicts).

A failed, errored, stopped or running verification is never reused. When the plan has a binary (`verify_binary`), the earlier pass's copy is copied into the new verification's directory; if it was pruned, the steps run.

## The base key

Steps such as Signal's `make test-changed BASE=main` choose what to run from the files changed since a base, and `when_changed` skips steps the same way. So the key holds what a step can read of the base: for the PR's base branch and origin's default branch (once each when they are the same), both the local branch and origin's copy, each branch's tree and the tree of its merge base with the head. Two verifications with the same head tree and the same key see the same changed files, whether a step diffs with two dots or three, against the local branch or origin's. A branch that does not exist is recorded as `none`. Git failing to answer (a timeout, a broken repository) means no key and no reuse.

The key is read from the project's repository after the head is fetched and before the slot is touched, so a reused pass never resets, releases or checks out a slot. It is read again when the steps pass; the pass records its tree and key (columns `tree_sha`, `base_key`, migration 71) only when the second read equals the first. A pass during which a base branch moved records no key and is never reused.

A step that reads something outside the tree and these refs (another branch, commit messages after the merge base, the network, the clock) is not covered by the key: its result is reused like any other. The scout (speed-up-signal-a3) found reuse safe for Signal only at an identical tree, which this keeps.

## What it records and shows

A reused verification is a normal row: `state = passed`, its steps copied with the detail `reused from v<N>` (their logs copied too), its `detail` saying which verification it reused, `reused_from` set, and a `pr.verified` event with `reused_from` in the same transaction. `reused_from` always names the verification that ran the steps, never another reuse.

- `flowryn verify show v<N>` prints `reused: v<M>`.
- `flowryn show <task>` and the gate's messages print `v<N> passed at <head> (…), reused v<M>`.
- The dashboard's landing batch card (and `flowryn show lb<N>`) says `lb<N> verify v<N> passed, reused v<M>, …` while verifying and `lb<N> landing on verify v<N> passed, reused v<M>, …` while landing; a train candidate's cell says `verify v<N> passed, reused v<M>`.

Reused rows are left out of each step's deadline history and of the dashboard's typical verify length, since they ran nothing.

## Tests

`test/unit/verify-reuse.test.ts`, on a real git repository: same tree, steps and base reuses (and names the verification that ran); a different tree runs; different steps run; local main or origin's main moved runs; a light pass does not satisfy a full verify (and the reverse); a failed verify is not reused; a base that moved during the run records no key; a pruned binary makes it run; a flake rerun pass is never offered; the same tree with another history has another key.
