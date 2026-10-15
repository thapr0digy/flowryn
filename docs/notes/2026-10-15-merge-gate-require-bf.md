# Merge gate requires a passing verify

- Status: done
- Open: not run live against a real GitHub PR or a real launchd daemon (the fake forge and test daemons only)

Until now the merge gate (`src/policy/merge.ts`, step 3) consulted `flowryn verify` only when every red check was a GitHub run that never started. A PR with no checks, or with green checks, merged with nothing run locally: PR #91 merged on 2026-10-15 with `local_green: "-"`. The rule now: **a project with `[projects.<id>] verify` steps merges only when the newest finished verify of exactly the merge head, under today's verify policy, passed**, whatever GitHub's checks say. Plain code: a SQL lookup and a fixed set of refusals; no model.

## The gate, step 3

1. A waiver (`--allow-red`) must name the one red check failing now (unchanged).
2. Each red check is either the one a human waived, or one GitHub never started; any other is `red_checks`. A verify never covers a check that ran and failed.
3. **Local green.** The project has verify steps: the verify at this head must have passed, or the merge is refused:

   | Newest evidence for the PR (or `local:<branch>`) | Code | Help |
   |---|---|---|
   | at this head, today's policy, passed | merges, `local_green: v<n>` | |
   | at this head, today's policy, failed or error | `verify_failed` | `flowryn verify show v<n>; once fixed: flowryn verify <task>` |
   | at this head only under another policy, or none recorded | `verify_stale` | `re-verify this head under today's steps: flowryn verify <task>` |
   | passed only at an older head | `head_moved` | `verify this head: flowryn verify <task>` |
   | none finished | `verify_required` (new, exit 2) | `verify it locally, then merge again: flowryn verify <task>` |

   The message opens with what GitHub said ("the PR has no checks at …", "checks: green (3) at …", "CI never started at …", or "local-only work at … has no CI").
   A project with **no** verify steps keeps the old behaviour: checks GitHub never started still need a pass (else `red_checks`), green or no checks merge. The merge result then carries `verify: none configured` and a hint naming the config key.
4. Checks still running: `checks_pending` (after the verify, as before for not-started checks).
5. Approval and the sensitive rule: unchanged.

## Choices

- **A waiver never stands in for a missing verify.** It passes one named GitHub check that ran; the verify is the project's own proof of the head. Both are needed.
- **Local-only delivery follows the same rule.** It has no CI at all. `flowryn verify <task>` now accepts a local-only task: it verifies the worktree HEAD (the head the merge would land), records the verification under `local:<branch>` (the merge's approval ref), and reads no GitHub. The commit is a worker's, already in the repository, so the runner fetches nothing (`VerifyPlan.prNumber`/`headRef` are null).
- **Yolo** may merge on a passing verify (evidence, not a waiver), never without one.
- **`flowryn approve`** does not require the verify: an approval is your word on a head; the gate checks the verify at merge time. The summary you approve (approve, the Claude prompt, the Pi confirm) gains a `verify:` line: `v4 passed at fc2f76d7 (…)`, `required; none at <head>` or `none configured`.
- **The verify id has its own column** (migration 26, `merges.local_green`), written with `merge.requested`'s `local_green`. It was in `merges.detail`, which an unproven result overwrites and which held only the waiver when there was one. `flowryn show <task>` prints `merge: mg3 merged at … via cli-tty, local green v4`, and `verified:` for local-only tasks too. Older rows keep it in detail.
- **Code consumers**: no code branches on `red_checks` from the gate, so the new `verify_required` and the gate's use of `verify_failed` change only what the leader reads.

## Also: the harness version probe

`harnessVersion` (`src/lifecycle/fleet-services.ts`) cached a failed or timed-out `--version` probe (null) until the binary's mtime changed, so one probe that hung during a macOS syspolicyd fault made every later dispatch fail `tool_missing` although the binary worked. It now runs on `runBounded` (10 s; own process group and ledger entry in the daemon) instead of a hand-rolled `Bun.spawn` and pid timer, and caches only a parsed version: a cut-off read (124/125/127) or output with no version is returned as null and probed again next time.

## Tests

- `test/unit/verify.test.ts`: the gate matrix, every row of GitHub's checks (none, green, red not started, red that ran, red that ran and was waived) against every verify column (passed, failed, stale, missing, older head, no steps); the refusal text and help; a waiver never stands in; yolo; local-only; pending after the verify.
- `test/unit/harness-version.test.ts`: a probe that answers no version is retried on the next call (same mtime) and the parsed version is then cached.
- `test/integration/verify.test.ts` (real daemon, fake GitHub): a PR with no checks is refused `verify_required` until `flowryn verify` passes, then merges with `local_green: v1` in the reply, `merge.requested`, the merges row and `show`; a local-only task is verified at its worktree head and merges on it; a project with no verify steps merges and says it ran no local verify; a waived red check still needs the verify.
