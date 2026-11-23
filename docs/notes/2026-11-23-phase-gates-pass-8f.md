# Review gates pass on objective evidence

- Status: done
- Open: not yet run live on a real design or QA gate
- Config: `[projects.<id>] gate_pass`

Plan p104, proposal 4. Since Nov 15 the user passed 29 review gates by chat, most of them on work whose evidence was already green. A project can now let the daemon pass its design and QA review gates on that evidence. The user reviews the page afterwards, in the briefing, and can send it back in one command. The model is Lauren Tan's: humans look at verification artifacts, not at work as it happens, and the agent that judges a change is never the one that wrote it.

## Turning it on

```toml
[projects.appsec-signal]
gate_pass = "evidence"
```

`"evidence"` is the only value; unset, every review gate waits for a human channel as before. Any other value is `config_invalid`.

## When a gate passes

The daemon's pass (`src/attention/evidence-pass.ts`) runs on the validator's tick. The rules (`src/attention/evidence-gate.ts`) are plain code, except for the design reviewer's verdict.

A **QA gate** (stage skill `flowryn-visual-qa`) passes when all of these hold:

- The card's verdict is `works`.
- No finding is a `blocker` or a `major` (minors and nits are fine).
- Every `qa/probe-*.json` in the task's report dir is clean: no error, `pageOverflow` and every list below present (a probe missing one holds), no sideways page scroll, and empty `overflow`, `overlaps`, `contrast`, `names` and `images` lists, and no `clipped` entry without an ellipsis. `contrastUnknown`, `offToken` and an ellipsis clip are left out on purpose, because the QA method says they need judgement. A page whose card says "Nothing visible." needs no probe; any other page needs at least one.
- The project's verify passed at the gate's head. The pass queues that verify itself, once, under `local:<branch>` with the run's worktree (source `auto`, event `gate.evidence_verify`), and waits for it, and for any rerun at that head (a verify cut off by a daemon restart is requeued and judged by its rerun). A project with appsec-signal's `ui-check` step behind `when_changed = ["ui/**"]` (proposal 3) runs it here, so "the UI checks are green at that head" is the verify's own record. A project with no verify steps holds.

A **design gate** (stage skill `flowryn-design`) passes when all of these hold:

- The gap check's verdict is `ready` or `ready with the fixes below`.
- The gap check's first check, "Simplest secure option", records exactly `none` (anything else, such as "none needed, but a new Redis service", holds). That check names every new piece of infrastructure, key, credential, service, setting or cross-repo change, so any finding there means the design may add infrastructure, and the review stays the user's. `design-gap-check.md` now says so.
- One independent validator round says pass. This is the gate validator (`src/attention/gate-validator.ts`): a fresh, read-only, capped model call over the brief, the pinned spec, the page and the branch's diff, with no access to the worker's conversation. The round is recorded in `gate_validations` with `basis = 'evidence'`. A `changes` verdict sends the design back with its findings, as under away. No verdict, or eligibility lost while it ran, leaves the gate to the user with an item, and no further evidence round runs on that stage. A round the daemon cut off (a restart while it ran) judged nothing, so the next tick starts one fresh round; a second cut-off round hands the stage to the user. Every round counts against `validator_rounds`.

Both kinds also need:

- the task is not sensitive;
- the gate carries no phase plan (only the user approves a plan);
- the page (and spec) are unchanged since they were pinned;
- the branch has not moved since the review opened (`gates.pass_head`);
- the user has never reopened an evidence pass of this task's stage;
- no earlier evidence round of the stage was held, failed or advised (a round the daemon cut off counts only from the second);
- fewer than `[decisions] validator_rounds` evidence rounds have run on the stage.

The pass waits, rather than holds, while unattended mode covers the run (its own pass owns the gate), while a validation runs, and while the gate's questions are open for the user.

A passed gate is recorded like any other: an approval on the new channel `evidence` (migration 69), consumed by `recordGatePass`, and event `gate.evidence_passed` with its evidence (the verdict, the number of probes and the verify id for QA; the gap verdict and the round for design), the head and the page.

## When it holds

Only design and QA review gates are judged; a review gate of any other stage is left to the user without an event or a briefing line.

A gate whose evidence is not green is held once: event `gate.evidence_held` with why, and meta `evidence_held:<gate>`. The pass never looks at that gate again, and it waits for the user as before.

## The digest and the send-back

The briefing's "Decided for you" section, in both the morning briefing and the return brief, lists each evidence pass with its evidence, its page link and the undo while the run is live and undelivered:

```
- [g12] qa review of Inbox redesign (sig-inbox-4k) → passed on evidence (works, 6 clean probes, verify v88 passed at 1a2b3c4d; page: http://127.0.0.1:4387/session/…; undo: flowryn gate reopen sig-inbox-4k --gate qa --body-file -)
- [g14] design review of Graph filters (sig-graph-9q) → waits for you: the design may add infrastructure: its Simplest secure option check records 1, 2 (page: …)
```

`flowryn gate reopen <task> --gate <stage> --body-file -` now also takes back a pass on channel `evidence`. It sends the run back to that stage with the user's words, and the stage's next review is the user's. An evidence round that passed is listed once, by its gate; its own `[j<N>]` line is left out.

## Choices

- **One reviewer, the existing validator.** It already reads the brief, the spec, the page and the diff with fences, caps and a fixed reply schema, and it keeps a report for `flowryn show j<N>`. A second reviewer would be a parallel path. The rounds share `[ask] max_concurrent`, `validator_max_usd` and `validator_rounds`. Its contract no longer says "the user is away", which an evidence round would make untrue.
- **The QA rule has no model.** Every one of its checks is a record that already exists (the page check's verdict and severities, the probe's JSON, a verification row), so a model would add cost and no judgement.
- **QA verifies the branch head before ship.** The verify runs at the gate rather than waiting for the landing verify, because the gate must judge the head it passes. It costs one more verify per QA gate; landing still verifies what it lands.
- **Hold once, then never again.** A held gate is the user's, like a gate the validator held under away. Retrying on the next tick would turn a red check into a polling loop.
- **Rejected: a separate setting per stage, or thresholds for minors.** The brief's rule is fixed. A project that wants only QA can leave its designs to answer questions; a gate with open questions waits for the user.

## Tests

`test/unit/evidence-gate.test.ts` covers:

- the setting;
- the probe, QA and design rules, and probe reading (a symlink is refused);
- each refusal on its own, hold and wait;
- a QA gate end to end: the verify queued once, the pass on channel `evidence`, the event, the brief's line and the reopen;
- the holds: a major finding (once), a failed verify, a dirty probe, a sensitive task, a moved branch;
- a project without the setting;
- a design gate end to end through the validator's seam: a pass (`basis = 'evidence'`), changes sending the design back, a design that may add infrastructure held without a round, and a reopened stage held.

No model, git or Herdr is reached.
