# Countersigned gate loosening

- Status: done
- Open: not yet run live on a real fix-forward

Plan p104, proposal 6. A fix can make a red check green by moving the check instead of the code: raising a budget, lengthening a timeout, skipping a test, adding an allowlist entry. This week two fix-forwards each raised a UI first-load budget by 1 KB, and nobody saw it. Now such a fix merges only after a verifier has proved the new number and the leader has countersigned it. The model is Lauren Tan's rule (pstack autopilot-full): "Anything that loosens a gate … needs a verifier's proof and then your fresh countersign."

## Which diffs

The rule covers two kinds of diff:

- A run on the `fix` workflow. The diff is its commits past its base branch: local `refs/heads/<base>` for a local-only ship, `refs/remotes/origin/<base>` for a PR.
- A landing batch's fix-forward. The diff is only the fix's own commits, past the batch head it started on (`fix_base`), so the members' changes never count.

Feature work is not checked.

## What counts as loosening

`src/policy/loosening.ts` reads `git diff --unified=0`. It uses plain rules, no model, and keeps them narrow so ordinary numeric edits don't trigger them:

- **raised**: a changed line whose only difference is a higher number. This counts in two places:
  - any line of a file whose name contains `budget`;
  - a line in a test runner's config (`bunfig.toml`, `Makefile`/`*.mk`, `vitest|jest|playwright.config.*`, `pytest.ini`, `tox.ini`, `.golangci.yml`) that names a timeout, deadline, threshold, limit, budget or retries.

  Units of one dimension are compared after scaling: `5m` to `400s` counts as raised, and `200kb` to `1mb` counts too.
- **skip**: an added line that skips a test, in any file except Markdown. The spellings are:
  - JS/TS: a `skip` or `todo` call on `test`, `it`, `describe`, `suite` or `context`; `xit`, `xdescribe` and `xtest`; and `skipIf`.
  - Go: `t.Skip`, `Skipf` and `SkipNow`.
  - Python: pytest's and unittest's skip marks.
  - Rust: the `ignore` attribute.

  A `skipIf` on `process.platform` is the platform skip AGENTS.md asks for, so it does not count. A line that only moved within its hunk doesn't count either.
- **allowlist**: a new non-comment entry in a file whose name contains `allowlist`, `allow-list` or `allow_list`.

## The gate

The merge gate (`checkGateAndCountersign`, `src/policy/merge.ts`) runs the countersign as its last step, after every other check has passed. By then the proof exists: the gate's local green at this head, which for a batch member is the batch's full verify. If the fix's diff loosens a gate, or the diff cannot be read, the gate acts in three steps:

1. It opens one standalone decision (`k<N>`, origin `countersign`, key `<task>-<head>`). The decision lists the loosenings and the verify that proved them, and has the options `countersign` and `refuse`. The leader answers it with `flowryn decide k<N> countersign --rationale "…"`. On sensitive work the decision is reserved for the user instead.
2. It records a `merge.loosened_gate` event naming the task, head, base, loosenings, decision and proof.
3. It refuses the merge with `loosened_gate`.

A `countersign` answer at that head lets the merge through. A new head needs a fresh countersign. A `refuse` answer, or a dismissed decision, keeps the gate refusing, and the refusal names the send-back.

## Where it holds

- **Landing batch.** The batch is green but not landed. It is held with reason `loosened_gate`, the fix (or other member) as its culprit, and one `landing_batch_held` item with the next commands: `flowryn decide k<N> countersign | flowryn batch drop lb<N> <task>`.
  - Once the decision reads `countersign`, the next pass moves the batch back to landing (event `landing.batch_countersigned`) and lands every member.
  - After a `refuse`, the batch stays held. Dropping the fix rebuilds the members from main, as any drop does.
- **Auto-merge and the landing line.** The refusal holds the entry as `held:loosened_gate`. After the countersign, the leader runs `flowryn merge <task>` again.
- **The leader's `flowryn merge`.** The command is refused, and the help names the decision.

The open decision appears in the briefing's decisions for the leader.

## Tests

- `test/unit/loosening.test.ts`: the detector rules.
- `test/unit/countersign.test.ts`: the gate on a local-only fix with real git. It covers a refused gate, a single decision, a countersign that passes, a refuse that keeps refusing, a sensitive decision reserved for the user, and features and clean fixes that pass untouched.
- `test/unit/landing-batch.test.ts`, under "fix forward": a fix-forward that raises a budget holds the green batch, and the countersign lands it. A refused countersign keeps the batch held, and dropping the fix rebuilds it.
