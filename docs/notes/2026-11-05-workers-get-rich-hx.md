# Workers get rich, structured briefs that carry the design forward

- Status: done
- Open: the live contract passes at the new revisions (claude 7, pi 6) are not run yet
- Config: `[briefs] enforce`

A worker used to start from one paragraph, and every stage after design only got "Stage build is done." Now a dispatch must carry a structured brief, the design stage writes an engineer build spec that the review pins with its page, build ends with a handoff, and every task file carries what came before. All of it is plain code: a Markdown section parser, fixed templates, sha256 digests and file assembly. No model call (the design's "deterministic first" rule: no step needs judgement that a parser cannot give).

## Briefs at dispatch

`flowryn dispatch --kind ship|scout` checks the body's `## ` sections (`src/lifecycle/brief.ts`). The check refuses a brief with a missing section, an empty one, one that says only TODO/TBD, or a template slot left as written (a line that is wholly `{{…}}`). The error is `brief_invalid` (exit 3) and lists every problem in one line.

- Ship: `## Intent` (the user's words verbatim, with the acceptance criteria), `## Context` (the substance of each source, written in, not "read X"), `## Requirements`, `## Constraints`, `## Security`, `## Out of scope`, `## Verification`. `## Spec` is optional: the leader's build instructions, never the user's intent. This is firstmate's split between intent and spec.
- Scout: `## Intent`, `## Context`, `## Questions`, `## Out of scope`.
- Security and Out of scope may say `None: <reason>`. A bare `None.` is refused.
- Headings match case-insensitively, plus a few aliases (`User's intent`, `Security bar`, `Non-goals`). Order is free, and a heading inside a fenced code block is text.
- `flowryn template ship|scout|handoff|spec` prints each shape. Leaders, readers, you and workers can all run it.
- `--loose <reason>` skips the check, but only from your own terminal (the user's answer to q142). A leader's `--loose` is refused. The reason is kept as a `brief.loose` event.
- Not checked: `--kind ask`, `--task <id>` (its body is already recorded), phases of a plan from an approved design (they carry that design's spec), `promote --body-file` (a note; the scout's report is carried), and every run dispatched before this change.
- `flowryn plan` takes the brief its phases share with `--brief-file <path>`, checked as a ship brief (or `--loose <reason>` from your terminal). This differs from the design, which put the brief in the plan's preamble. A plan's `## ` sections are already its phases, so the brief needs its own file. It is kept on `plans.preamble` and carried into each phase's task file.

## The design stage's build spec

The design skill now also writes `$FLOWRYN_REPORT_DIR/design/spec.md`, with the sections `## Approach`, `## Files and interfaces`, `## Data and schema`, `## Error handling`, `## Security`, `## Test plan` and `## Rejected alternatives`. The page's folded detail links to it with `<a href="spec.md">`.

`stage done --review` in a flowryn-design stage refuses with `spec_invalid` when the spec is missing, unlinked, a symlink, outside the report directory, not UTF-8, over 256 KB or short of a section. When the gate opens, it stores `gates.spec_path`, `spec_text` (the spec's sanitized text), `spec_digest` and `page_digest`.

A worker's `review reply` re-pins after a revision: it re-reads the spec and the page, re-checks the spec, updates the digests and appends `gate.repinned`. The user approves what they last saw. A pass by any channel (`gate pass`, `approve`, a page code) is refused with `design_changed` while either file differs from its pin; the page channel answers on the page. Later stages read the gate's copy of the spec, never the file, so an edit after approval cannot change what they are told was approved.

## The carried context

`taskFileText` (`src/lifecycle/launcher.ts`) writes every task file: fresh, resume, relaunch, fresh stage worker, and a live worker's stage start. Between the stage note and the `---` before the brief, it adds `## Context Flowryn carries`, built by `src/lifecycle/context-block.ts` from Flowryn's records:

- The approved build spec of the task's last passed design review, from any of the task's runs, and the design page's path. A phase task with no design of its own gets the design that planned it (`plans.source_task`).
- That review's answers (`gateAnswersNote`) and the choices recorded in questions.json's `decided`.
- A leader plan's shared brief.
- Scout reports: the task's own `report.md` once it was promoted, and each `--after report:<scout>` it waited for. A missing report is named, not fatal.
- Each stage's latest handoff.

Size rule: a document is inlined up to 16 KB, and the block up to 48 KB in total. Past either limit, the full text goes to `<runDir>/context/<name>.md` (mode 0600), and the block shows its outline, path and digest.

Each inlined document is fenced with more backticks than any run inside it, so its own headings and fences cannot pose as Flowryn's sections. The design proposed a random marker; a fence longer than any inside is deterministic and does the same job.

A task with nothing to carry gets no block, so its task file is byte for byte what it was before this change.

## Handoffs

`stage done --handoff-file <path|->` takes `## Done`, `## Deviations` and `## Risks` (each may be `None.`), at most 8 KB after cleaning. It is required in a flowryn-build-test stage and optional elsewhere. It is stored in `stage_handoffs` (migration 52, `rich-briefs`) with its `stage.done` event. The next stage's note is `Stage build is done. Its handoff …` followed by the text, instead of `Stage build is done.` A worker that skips `stage done` with `stage begin <last stage>` gives no handoff. That path is a no-mistakes ship's shortcut and was left as it is.

## Skills

- The design skill: the build spec step.
- The build skill: re-read the carried context, the principal-level checklist (match the spec, threat-model, no secrets, validate inputs, explicit errors with tests for failure paths), a self-review of the whole diff, and the handoff.
- The leader skill: the brief's shape and `flowryn template`, and `plan --brief-file`.

## `[briefs] enforce`

`true` by default. When `false`, Flowryn checks no dispatch brief, requires no spec or handoff, and still pins a spec that is present. Test homes set it to `false` unless a test's config names `[briefs]`, so the suite's one-line fake bodies still dispatch. `test/integration/rich-briefs.test.ts` turns it on.

## Contract revisions

The contract suite's scout dispatch is now a valid scout brief (`contractBody`), and the task file's shape changed, so `CONTRACT_REVISIONS` moved to claude 7 and pi 6. A live `flowryn doctor --contracts` pass is needed for each.

## Tests

- `test/unit/brief.test.ts`: the parser, each template filled and unfilled, aliases, None rules, optional sections and handoffs.
- `test/unit/context-block.test.ts`: a pre-feature run (no block), fresh and resume, a relaunched new run of the task, a plan phase, a leader plan's shared brief, a promoted scout's report, a watched report that is missing, an oversized spec (file at 0600 with outline and digest), and the fence.
- `test/integration/rich-briefs.test.ts`: free-text refusal, `--loose` for you and not for a leader, `template`, and design → build → ship through the fake worker. That run covers a refused stage done without a spec, `design_changed` after an edit, a re-pin, a refused build stage done without a handoff, and the ship stage's task file holding the spec (with the edit) and the build handoff.
