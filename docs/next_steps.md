# Next steps for Flowryn

Architecture and design assessment, 2026-10-11. Reviewed revision:
[`f69399f`](https://github.com/thapr0digy/flowryn/tree/f69399f7c64814cd6c7b678d6012a2cd6d1c5182)
(v0.22.0). This is a source-and-documentation review, not a production benchmark
or a certification of live integrations. Recommendations below are proposed work,
not claims that the work has shipped.

## Executive assessment

**Keep the architecture; make its guarantees easier to prove, explain and
operate.** Flowryn's strongest design choice is putting supervision in
deterministic code rather than another model conversation. The leader provides
judgment; the daemon remembers, enforces and recovers. That is a better foundation
for a dependable personal fleet than a general-purpose agent framework.

The next level is not more harnesses, more autonomous decisions or more workers
by default. It is making the existing system comprehensible under failure and
safer to extend: explain why work is waiting, preserve causality across retries,
prove recovery at external boundaries, and make compatibility evidence visible.
The main architectural risk is coordination complexity inside the daemon and
across its tools, not the choice of SQLite or a single process.

## Architecture worth preserving

| Boundary | Current design | Assessment |
|---|---|---|
| Operator and agent surfaces | One CLI registry, typed command metadata, TOON/JSON output, and harness bridges | A coherent control surface. Extend it rather than adding an independent dashboard or MCP business-logic layer. |
| Durable coordination | One daemon writes runtime SQLite state; tasks-axi owns the backlog through an intent journal | Appropriate for a single-host product. This is coordinated state plus an audit log, not a reason to introduce a distributed event platform. |
| Execution | Workflow stages, scheduler grants and capacity leases; harness and Herdr adapters carry execution | Keep admission separate from execution and model choice. Grow within these seams rather than launching workers from new feature modules. |
| Authority | Human-bound approvals, policy gates, leader leases and hook-side tool restrictions | Preserve the distinction between being the leader and having permission to approve. Offline hook enforcement is an intentional boundary, not logic to move indiscriminately into the daemon. |
| Attention | Durable actionable items, bounded digests, briefing after compaction and a zero-model terminal board | Attention is a product resource. Success means fewer unnecessary interventions, not just more completed agent turns. |

The [design's ownership table](design-v3.html#components) is a useful architectural
contract, and its [non-goals](design-v3.html#goals) are mostly still good constraints.
The [CLI registry](../src/cli/registry.ts),
[daemon-down client behavior](../src/cli/client.ts), and
[board](../src/cli/commands/board.ts) show how much useful control already exists
without asking a model to reconstruct state.

The design also has unusually good institutional memory:
[M0 verdicts](m0-verdicts.md) distinguish measured platform behavior from
assumptions, [v1 status](v1-status.md) identifies deliberate exclusions, and
[feature notes](notes/README.md) record later decisions without a shared-file
merge bottleneck. Preserve that honesty: an offline contract pass, a shell run
and a production launchd run are different kinds of evidence.

## Recommended investments

The priorities are risk-first, not a claim that all work must run serially.
Effort is relative: **S** is a bounded feature; **M** crosses a few ownership
boundaries or requires a migration. These are not calendar commitments.

| Work package | Priority / effort | Sequencing |
|---|---|---|
| 1. Durable lifecycle operations | Now / S then M | Fix verified replacement first; define operation identity before generation-dependent recovery. |
| 2. Guarded state transitions | Now / M | Fresh-state checks can start independently; generation-aware guards build on 1. |
| 3. Decision explanations | Next / S-M | Independent first slice; add operation identity when 1 lands. |
| 4. Compatibility and native acceptance | Next / M | Independent; coordinate contract-runner edits with 6. |
| 5. Effective configuration | Next / S-M | Independent. |
| 6. External deadlines and cleanup | Now / M | Independent; agree shared contract result/cleanup changes with 4. |
| 7. Shared heavy-work admission | Next / M | Independent; coordinate verification schema edits with 4. |

### 1. Extend transaction safety to lifecycle side effects

SQLite transactions and the tasks-axi journal already protect a substantial
part of the system. The next boundary is the gap between committing intent and
performing an external action.

**First, a small concrete fix (done):** `Scheduler.freshWorker` ignored the
exit result, then cleared identity and started a new session. It now replaces
a fresh stage's worker only on a verified exit, keeps the old identity and
pending replacement on failure, surfaces the refusal and retries only through
the scheduler; see
[docs/notes/2026-10-12-next-steps-md-we.md](notes/2026-10-12-next-steps-md-we.md).

The [gateway](../src/api/gateway.ts#L84-L113) caches database application but
re-enters `settle` on replay. Settlement can include
[resuming a worker](../src/lifecycle/leader-verbs.ts#L193-L201), not just waiting
for an existing result. Separately,
[cancellation](../src/lifecycle/leader-verbs.ts#L121-L130) stops the worker before
committing cancellation, and [launch](../src/lifecycle/launcher.ts#L282-L315)
starts the agent before saving its process identity. These are concrete
crash/retry boundaries; duplicate workers or unwanted resumes were not
reproduced in this review.

**Next step:** persist a small per-run operation identity, execution generation,
desired outcome and confirmed phase for launch/resume/cancel. Recover the
operation, not merely the last observed worker state. Recheck idempotency inside
the committing transaction and coalesce concurrent requests with the same ULID.
Distinguish replay-safe settlement from issuing an effect again; simply
skipping all settlement on replay would break recovery.

Preserve the scheduler's admission grant and process-identity checks. An
ambiguous launch should be reconciled against its recorded candidate or
explicitly escalated, never adopted by pane label.

**Done means:** deterministic interruption immediately after agent start or
worker termination, plus concurrent/restarted duplicate requests, cannot
produce a second requested operation or undo a cancellation. This is a bounded
extension of the existing machinery, not a new workflow engine. For the first
patch, a false exit result must cause no identity reset or launch, and a later
verified exit must allow exactly one replacement.

### 2. Make state ownership executable across asynchronous work

The ownership table is stronger than relying on every caller to remember all
the rules. A serialized reconcile loop is not the same as serialized access
against hooks and API mutations.

For example, the [reconciler](../src/reconcile/reconciler.ts#L184-L307) reads a
run before awaiting external observations; [liveness updates](../src/lifecycle/runs.ts#L129-L134)
then write by run ID. A newer hook, cancellation or replacement worker can
overtake that observation. This is a code-level race surface, not a measured
production failure.

**Next step:** introduce narrow guarded transition functions for consequential
writes. Inside the transaction, re-read the relevant state and reject results
whose execution generation, lifecycle state or hook watermark changed. Keep
state changes, events, task intents and lease updates together. Other modules
should request those transitions rather than assemble their own partial
version of them.

Start with liveness and automatic resume, then use the same pattern where
external observations affect delivery or stage progression. Do not create a
generic repository layer over every SQL query or rewrite all state machines at
once.

**Done means:** pause an observation, deliver a newer hook/cancellation, then
release it; the old result cannot overwrite current truth or revive terminal
work. The protected transition has one owner and focused race coverage.

### 3. Make "why is this waiting?" a first-class read model

The product already has `fleet`, `show`, `capacity`, the board and actionable
items. The opportunity is to connect their evidence, not add another status
screen.

[Run evidence](../src/lifecycle/runs.ts#L120-L125) retains the latest value per
source. That is appropriate for current state but insufficient to reconstruct
every past decision. The
[stale-hook incident notes](notes/2026-10-10-quieter-stale-hook-3q.md)
explicitly record missing historical Herdr observations; the suppression fix
itself is already implemented.

**Next step:** when a consequential decision, refusal or escalation occurs,
record a compact explanation: rule and reason, operation/generation, relevant
facts, observation times, and the actor or event that can unblock it. Reuse that
structure in existing CLI views and the briefing. Retain decision inputs or
changed observations, not every unchanged poll.

An operator should see, together: "waiting on design approval; question q7
still open; only the captain can answer; evidence last
updated at ...". Keep the terse pointer by default and expand on request.
Add a read-only timeline and a redacted, opt-in diagnostic export rather than
requiring direct database queries or uploading chat transcripts.

**A bounded second slice (done):** expose review-channel health. The Lavish
poller kept retry/failure state in memory, while browser-opening status was
durable, so a page that opened successfully could later stop receiving answers
unseen. Each open review gate now persists its channel's last success,
failure-since, reason and retry time, opens one actionable `review_channel` item
after a bounded threshold and clears it on recovery or gate closure, distinct
from browser opening and from running without optional Lavish; recovery never
passes the gate. See
[docs/notes/2026-10-12-next-steps-md-7b.md](notes/2026-10-12-next-steps-md-7b.md).

**Done means:** a saved blocked-dialog, capacity-wait or resume decision can be
explained and replayed offline; the operator can identify the next authorized
action without asking a model to infer it. Measure unresolved waiting time and
unnecessary interventions before adding more autonomous behavior.

### 4. Bind reusable evidence to current behavior and policy

The existing [offline contract suite](../test/integration/contracts-offline.test.ts)
runs the real contract machinery through instruction-following fakes. Keep it.
The next layer should address where a passing result stops being predictive,
not replace those fakes with expensive model calls on every PR.

**Version the compatibility contract.** The
[recording path](../src/contracts/verbs.ts#L29-L40) and
[lifecycle gate](../src/lifecycle/harness-gate.ts#L174-L181) identify passes by
harness and harness version, while reports carry additional build provenance.
Introduce a per-harness adapter/contract compatibility revision and record the
relevant platform, Herdr and launch-profile context. Carry that revision through
gate lookups, automatic-check attempts and alert deduplication. A behavior-changing
adapter revision should make older evidence visibly stale; a documentation-only
commit should not consume a paid contract run. This is a confidence-model
improvement, not a claim that every existing pass is wrong.

**Bind local verification to its policy as well as its head.**
[`finishedAtHead`](../src/verify/store.ts#L64-L66) selects by PR/head, and
[local-green acceptance](../src/policy/merge.ts#L270-L276) accepts the passing
result. Strengthening the user's configured verification steps does not change
that head. Snapshot a canonical policy identity from the ordered commands and
required artifact; require it for running-job attachment and merge-time reuse.
Legacy results lacking that identity should request re-verification, not imply
coverage of today's policy. Preserve the existing narrow exception for GitHub
checks that never started; this must not bypass actual red/pending checks or
human approvals.

**Close the native deployment loop.** The
[compiled-binary tests](../test/integration/binary.test.ts#L93-L107) and
[build-after-merge notes](notes/2026-10-09-build-after-a-7g.md) already distinguish
script-supervisor or shell evidence from a launchd-owned build and self-restart.
Add an opt-in acceptance run on a local Mac using a separate home and launchd
label, compiled artifacts and fake external services. Exercise replacement,
failed candidates, pinned callers, shutdown and uninstall; retain the exact
artifact and environment identifiers with the result.

**Done means:** a relevant contract revision or verification-policy change
invalidates its corresponding old evidence, unchanged behavior still reuses
evidence, and one authorized native acceptance run demonstrates the replacement
build serving requests without touching the production service. These are
three separate PR-sized slices, not one combined migration. Keep the
[documented CI billing pause](v1-status.md#ci-is-off-2026-10-07) separate from this
work. Restoring Linux CI when billing permits is useful, but neither requires
paid macOS CI nor proves macOS service behavior.

### 5. Make effective configuration complete and inspectable

Section-level parsers already validate types and many unknown keys. However,
[`parseConfig`](../src/config/config.ts#L120-L165) preserves unrecognized
top-level sections in `extra`, and daemon validation invokes the known section
parsers. A misspelled `[notfiy]` is accepted without configuring notifications.
Also, [`flowryn config`](../src/cli/commands/setup.ts#L278-L308) advertises
effective configuration but shows only core paths, task files and tool entries,
not the operational sections added since M1.

**Next step:** compose the existing section parsers into one resolved
configuration snapshot. Register recognized sections, preserving dynamic
project/workflow names, and reject accidental unknown sections with a useful
suggestion. Extend `config` to show effective policy, capacity, workflows,
notifications and upkeep, including defaults versus overrides. Distinguish the
running daemon's accepted configuration from the file currently on disk, and
redact sensitive values.

Keep feature-specific configuration documentation in its existing notes file;
do not make the README another exhaustive reference or move test-only timing
knobs into the primary setup experience.

**Done means:** a typo is explicit, valid custom sections remain supported, and
an operator can explain a daemon decision from its actual accepted configuration
without reading several parser implementations or restarting speculatively.

### 6. Bound external operations and prove cleanup ownership

Reconnect logic and process cleanup already exist. Strengthen the cases where
an external system stays connected but stops behaving correctly.

The [Herdr subscription handshake](../src/runtime/herdr/client.ts#L133-L172)
lacks the establishment deadline ordinary requests have. The
[automatic contract timeout](../src/contracts/auto.ts#L98-L105) force-kills the
runner, while [normal stopping](../src/contracts/auto.ts#L240-L249) gives it a
shorter grace period than some of the
[runner's cleanup operations](../src/contracts/runner.ts#L380-L390).
These are observable budget/ownership mismatches; leftover production resources
were not reproduced during this review.

**Next step:** define an end-to-end deadline and termination owner for each
long-lived external operation, starting with subscriptions and automatic
contracts. Validate protocol acknowledgements and essential response fields;
preserve unknown evidence rather than turning malformed data into "no process".
Use a bounded graceful-stop/escalation sequence and retain exact owned resource
identifiers so supervision can recover after the child is force-killed.
Record behavioral contract success separately from cleanup success.

**Done means:** a silent or malformed peer fails within a known budget;
termination during launch, stalled cancellation and active work either removes
the owned resources or records an explicit recoverable cleanup failure.
Unrelated sessions and worktrees remain untouched. Extend the existing socket
and contract fakes rather than introducing a second integration framework.

### 7. Account for all heavy work in admission control

The scheduler checks host health and capacity before worker grants, but
[local verification](../src/verify/verbs.ts#L145-L175) uses its own
one-at-a-time guard and immediately starts its workload. One verify can still
compete with several validations and active workers. This does not mean
existing worker leases exceed their caps; it means some heavy work is outside
that accounting.

**Next step:** give verification a durable job lease counted against the same
validation budget and host verdict as workflow validation. Extend
[`liveCounts`/`grantLeases`](../src/sched/pools.ts) without fabricating a worker
run to represent a verification. Initially return a clear capacity refusal
rather than building a general-purpose job queue. Release only after the
subprocess and its worktree are cleaned up, and recover interrupted leases at
startup. Keep same-job attachment (including the policy identity once package
4 lands), detached following, restart guards and exact-head verification
worktrees.

**Done means:** host pressure or a full shared budget prevents a new verify;
concurrent verify/worker admission cannot oversubscribe that budget; success,
failure and interrupted recovery release ownership exactly once. Measure
verification wait time and hook responsiveness under the existing fake fleet
before changing default caps. Upkeep builds can adopt the mechanism later;
quota-aware model routing is not part of this first slice.

## Handoff rules for the implementing agent

Treat the numbered recommendations as separate work packages, not permission
for one sweeping refactor. The source links describe the reviewed revision;
compare them with the current branch before changing behavior. In particular,
the crash/retry and observation findings are hypotheses about executable race
windows: first add a deterministic reproduction, then fix the demonstrated
boundary. Do not turn them into claims of a production incident.

For every implementation:

- Read `AGENTS.md`, the relevant feature notes and M0 verdicts first. Add or
  update that feature's dated file under `docs/notes/`; the frozen milestone
  files and README are not the place for new implementation history.
- Preserve the single database writer, an event in each mutation transaction,
  tasks-axi mutations through `recordIntent`, and scheduler-only launch/stage
  grants. Hooks must still enforce tool restrictions with the daemon down.
- Preserve human authority, existing approval/head bindings and the distinction
  between unknown evidence and proof of absence. More automatic recovery must
  not silently approve, discard work or adopt a worker by its label.
- For new persisted fields, cover migration of existing runs and compatibility
  records, not only fresh databases. For public reply/envelope changes, follow
  the repository's protocol compatibility rules.
- Start with the existing fakes and deterministic pause/crash seams. No test
  should touch the user's real Flowryn home, Herdr session, harness settings,
  Docker resources, GitHub or no-mistakes daemon. Any run driving live Herdr must
  use the existing isolated lab helper; native launchd acceptance needs a Mac.
- Run focused cases first, then `bun run typecheck`, `bun run lint` and the
  repository-required broader checks before an implementation PR. Cleanup
  changes must pass both fixture sets named in `AGENTS.md`. This assessment
  does not substitute for those checks.

For recommendation 1, explicitly separate committed desired state, external
effect and observed completion; exercise recovery at each boundary and preserve
necessary replay settlement. For recommendation 2, do not use a read performed
before an `await` as permission for an unconditional write afterwards. For
recommendation 4, propagate the compatibility revision through every consumer,
including automatic attempts and alert keys, while retaining strict versus
relaxed recording authority. For recommendation 5, preserve dynamic
`[projects.<id>]` and `[workflows.<id>]` configuration and the existing behavior
that a rejected reload keeps the last valid daemon configuration.

### Existing test entry points

Run `bun test` with the paths for the slice being changed, rather than starting
with every row. These are extension points, not claims that the proposed edge
cases already have coverage.

| PR-sized slice | Start with these existing tests |
|---|---|
| 1: Verified fresh-stage replacement | `test/unit/workflows.test.ts`, `test/integration/workflows.test.ts` |
| 1: Duplicate requests and durable operations | `test/unit/gateway.test.ts`, `test/integration/workers.test.ts`, `test/integration/crash.test.ts` |
| 2: Stale observation guards | `test/unit/reconciler.test.ts`, `test/integration/prompt-wedge.test.ts`, `test/integration/stale-hooks.test.ts` |
| 3: Evidence and explanations | `test/unit/reconciler.test.ts`, `test/unit/show-full.test.ts`, `test/unit/queue-view.test.ts`, `test/integration/queued.test.ts` |
| 3: Review-channel degradation | `test/unit/gate-questions.test.ts`, `test/unit/review-opener.test.ts`, `test/integration/gate-questions.test.ts`, `test/integration/review-open.test.ts` |
| 4: Contract compatibility identity | `test/unit/contract-record.test.ts`, `test/unit/auto-contract.test.ts`, `test/integration/harness-gate.test.ts`, `test/integration/auto-contract.test.ts` |
| 4: Verification-policy identity | `test/unit/verify.test.ts`, `test/integration/verify.test.ts` |
| 4: Native acceptance scaffolding | `test/unit/launchd.test.ts`, `test/unit/restart.test.ts`, `test/integration/binary.test.ts`; add an opt-in isolated Mac acceptance path |
| 5: Effective configuration | `test/unit/config.test.ts`, `test/unit/setup.test.ts`, `test/integration/cli.test.ts` |
| 6: Protocol and cleanup fault cases | `test/unit/runtime.test.ts`, `test/integration/outages.test.ts`, `test/unit/contracts.test.ts`, `test/unit/auto-contract.test.ts`, `test/integration/contracts-offline.test.ts`, `test/integration/auto-contract.test.ts` |
| 7: Verification capacity | `test/unit/workflows.test.ts`, `test/unit/verify.test.ts`, `test/integration/capacity.test.ts`, `test/integration/verify.test.ts` |

Extend `test/unit/db.test.ts` for any new migration. Useful seams and traps:
`FakeHerdr.holdStarts`/`releaseStarts()` already provide a launch barrier;
the gateway's existing counter verb has no settlement hook; automatic-check
unit fakes terminate immediately and therefore do not prove descendant cleanup.
Use explicit promise barriers for observation races, not longer sleeps.

**Recommended first implementation PR:** only verified fresh-stage replacement
from package 1. Add the failing-exit regression, preserve pending state and
capacity ownership, and prove a subsequent successful scheduler pass replaces
the worker once. It addresses an observed inconsistency using an existing
pattern without requiring a schema redesign. Durable lifecycle operations,
guarded observations and compatibility/policy identities then merit their own
small design notes and migration plans.

## What not to build next

Do not replace Bun/SQLite with services, a message broker or a generic workflow
platform to solve these local coordination problems. Do not add multi-machine
execution, more harnesses, aggressive automatic cleanup or a headless judgment
model before the existing boundaries are measurable and explainable. A model
may eventually help with genuinely ambiguous triage; admission, retry, evidence
validation and escalation thresholds should remain deterministic.

Do not confuse more history with better diagnostics: record decision evidence
first, measure database/log growth and query latency, then design retention
around unresolved operations and audit needs. Likewise, Linux test success is
not Linux host support, and a real-GitHub acceptance run remains intentionally
outside the current plan.

The desired outcome is a supervisor an operator can trust and a coding agent
can safely extend: one answer to what is happening, why it is happening, what
evidence supports it, and what is allowed to happen next.
