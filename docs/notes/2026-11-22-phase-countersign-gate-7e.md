# Countersigned gate loosening

- Status: done
- Open: not yet run live on a real fix in a landing batch

Plan p104, proposal 6. A fix can make a red check green by moving the check instead of the code: raising a budget, lengthening a timeout, skipping a test, adding an allowlist entry. This week two fix-forwards each raised a UI first-load budget by 1 KB, and nobody saw it. Now such a fix merges only after a verifier has proved the new number and the leader has countersigned it. The model is Lauren Tan's rule (pstack autopilot-full): "Anything that loosens a gate … needs a verifier's proof and then your fresh countersign."

## Which diffs

The rule covers a run on the `fix` workflow. The diff is its commits past its base branch: local `refs/heads/<base>` for a local-only ship, `refs/remotes/origin/<base>` for a PR. A landing batch's fix-forward was a second kind until landing batches split on red instead (landing-batches-split-3f, docs/notes/2026-11-21-landing-batches-one-27.md); a fix run in a batch is still checked, and holds the green batch `loosened_gate` until its countersign.

Feature work is not checked.

## What counts as loosening

`src/policy/loosening.ts` reads `git diff --unified=0`. It uses plain rules, no model, and keeps them narrow so ordinary numeric edits don't trigger them:

- **raised**: a changed line whose only difference is a higher number. This counts in two places:
  - any line of a file whose name contains `budget`;
  - a line in a test runner's config (`bunfig.toml`, `package.json`, `Makefile`/`*.mk`, `vitest|jest|playwright.config.*`, `jest.config.json`, `pytest.ini`, `tox.ini`, `pyproject.toml`, `setup.cfg`, `.golangci.yml`) that names a timeout, deadline, threshold, limit, budget or retries. In a package manifest (`package.json`, `pyproject.toml`, `setup.cfg`) only a test runner's timeout counts: a `--timeout`, `--testTimeout` or `-timeout` flag, or a `timeout` or `testTimeout` key. A number that is part of a version (`^6.8.0`, `>=2.3`, `vitest@^1.2.0`) never counts, so a timeout raised on a script line that pins its runner's version still does. So `"test": "bun test --timeout 5000"` raised to `20000` in `package.json` counts, but bumping `express-rate-limit` from `^6.7.0` to `^6.8.0` does not.

  Units of one dimension are compared after scaling: `5m` to `400s` counts as raised, and `200kb` to `1mb` counts too.
- **skip**: an added line that skips a test, in any file except Markdown. The spellings are:
  - JS/TS: a `skip` or `todo` call on `test`, `it`, `describe`, `suite` or `context`; `xit`, `xdescribe` and `xtest`; and `skipIf`.
  - Go: `t.Skip`, `Skipf` and `SkipNow`.
  - Python: pytest's and unittest's skip marks.
  - Rust: the `ignore` attribute.

  A `skipIf` on `process.platform` is the platform skip AGENTS.md asks for, so it does not count. A line that only moved within its hunk doesn't count either.
- **allowlist**: a new non-comment entry in a file whose name contains `allowlist`, `allow-list` or `allow_list`. A line that only gained or lost a list's trailing comma is not new, so removing a list's last entry does not count.

## The gate

The merge gate (`checkGateAndCountersign`, `src/policy/merge.ts`) runs the countersign as its last step, after every other check has passed. The proof is one of:

- the gate's local green at this head (for a batch member, the batch's full verify);
- with no verify steps, a PR whose GitHub checks are all green (at least one check, none red, pending or waived).

With neither, the countersign alone is not enough: the gate refuses `loosened_gate` ("no verifier proved the new number: add verify steps or send it back") and opens no decision until a proof exists.

If the fix's diff loosens a gate, or the diff cannot be read, and a proof exists, the gate acts in three steps:

1. It opens one standalone decision (`k<N>`, origin `countersign`, key `<task>-<head>`). The decision lists the loosenings and what proved them, and has the options `countersign` and `refuse`. The leader answers it with `flowryn decide k<N> countersign --rationale "…"`. On sensitive work the decision is reserved for the user instead.
2. It records a `merge.loosened_gate` event naming the task, head, base, loosenings, decision and proof.
3. It refuses the merge with `loosened_gate`.

A `countersign` answer at that head lets the merge through. On sensitive work only the user's answer (`answered_by = captain`) counts, even on a decision that opened before the run was marked sensitive (the gate then reserves the open decision). A leader's countersign there keeps refusing, and the refusal names the send-back. A new head needs a fresh countersign. A `refuse` answer, or a dismissed decision, keeps the gate refusing, and the refusal names the send-back.

The `countersign` origin is the gate's own: `flowryn decision add --origin countersign` is refused, so no one can open a countersign ahead of the gate.

A countersign decision is dismissed (event `decision.dismissed`, its items resolved, its backlog task closed) when it goes stale:

- the gate opens a new one for the same task at a new head;
- `flowryn batch drop` drops its task from a batch;
- a batch's fix ends (dropped, retried, rebuilt, or the batch ended).

## Where it holds

- **Landing batch.** The batch is green but not landed. It is held with reason `loosened_gate`, the fix (or other member) as its culprit, and one `landing_batch_held` item with the next commands: `flowryn decide k<N> countersign | flowryn batch drop lb<N> <task>` (only the drop when no decision opened).
  - Once the decision reads `countersign`, the next pass moves the batch back to landing (event `landing.batch_countersigned`) and lands every member.
  - After a `refuse`, the batch stays held. Dropping the fix rebuilds the members from main, as any drop does.
- **Auto-merge and the landing line.** The refusal holds the entry as `held:loosened_gate`. After the countersign, the leader runs `flowryn merge <task>` again.
- **The leader's `flowryn merge`.** The command is refused, and the help names the decision.

The open decision appears in the briefing's decisions for the leader.

## Tests

- `test/unit/loosening.test.ts`: the detector rules.
- `test/unit/countersign.test.ts`: the gate on a local-only fix with real git. It covers a refused gate, a single decision, a countersign that passes, a project with no verify steps that keeps refusing with no decision, a refuse that keeps refusing, a new head that dismisses the old decision, a sensitive decision reserved for the user where only the user's countersign passes, and features and clean fixes that pass untouched.
- `test/integration/decisions.test.ts`: `decision add` refuses the `countersign` origin.
- `test/unit/landing-batch.test.ts`, under "a gate loosening in a batch": a fix run in a batch that raises a budget holds the green batch, and the countersign lands it. Dropping that member while its decision is open dismisses the decision and rebuilds the rest.
