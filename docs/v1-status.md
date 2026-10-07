# Flowryn v1 status

v1 is M1 through M5 of [`design-v3.html`](design-v3.html) section 17, after the M0 spikes, completed by one more pass for the items the milestones left open. This file lists every v1 item of the design: done, with the milestone and pull request that delivered it, or not built, with the reason. Each milestone's notes ([M1](m1-notes.md), [M2](m2-notes.md), [M3](m3-notes.md), [M4](m4-notes.md), [M5](m5-notes.md)) record the choices it made and its live results; the completion pass is the last section of the [M5 notes](m5-notes.md#the-v1-completion-pass); [`m0-verdicts.md`](m0-verdicts.md) records the spikes.

| Milestone | Pull request |
|---|---|
| M0 · Contract spikes and fixtures | Claude, Herdr, tasks-axi and no-mistakes spikes in the initial import; Pi spikes in https://github.com/thapr0digy/flowryn/pull/2 |
| M1 · Core | https://github.com/thapr0digy/flowryn/pull/3 |
| M2 · Runtime, workers, reconciler | https://github.com/thapr0digy/flowryn/pull/4 |
| M3 · Leaders and attention | https://github.com/thapr0digy/flowryn/pull/5 |
| M4 · Delivery and policy | https://github.com/thapr0digy/flowryn/pull/6 |
| M5 · Workflows, capacity, autonomy | https://github.com/thapr0digy/flowryn/pull/7 |
| v1 completion · the items M1 to M5 left not built or partly built | the pull request that marks them Done here |

## CI is off (2026-10-07)

GitHub refuses to start any Actions job on this private repository (free tier, billing/spending limit) until about 2026-11-07, so every pull request's one check, "typecheck, lint, test, build, fixtures", would stay red. Until billing returns:

- The `CI` workflow is disabled on GitHub (`gh workflow disable CI`, a repository setting), so pull requests have no checks. Flowryn's merge gate passes a pull request with no checks (`src/policy/merge.ts`: checks state `none`).
- `.no-mistakes.yaml` declares `no_ci: true`, so the no-mistakes CI step counts a zero-check pull request as green. It trusts that only from the default branch.
- Only the Linux run is lost: no-mistakes' test step still runs the full `bun test` on the Mac before every pull request.

Once billing is back (about 2026-11-07), re-enable both: run `gh workflow enable CI`, then remove `no_ci: true` from `.no-mistakes.yaml` (and this section and the README line) in a pull request. The leader holds a to-do due 2026-11-07 for it.

## The milestone items (section 17)

| Item | Status |
|---|---|
| **M0** every spike has a verdict; every M0 mark confirmed or replaced | Done (M0; the Pi marks in #2) |
| **M0** the 21 cleanup-guard fixtures | Done (M0; run against Flowryn's guard in M4) |
| **M1** single binary with signing | Done (M1 #3) |
| **M1** flock and socket; handshake, tokens, idempotency | Done (M1 #3) |
| **M1** schema and migrations; event log | Done (M1 #3; migrations 2 to 5 in M2 to M5) |
| **M1** intent journal and backlog watcher | Done (M1 #3) |
| **M1** CLI registry with TOON/JSON, exit codes and spool | Done (M1 #3) |
| **M1** init, doctor, launchd | Done (M1 #3) |
| **M1** todo and project verbs | Done (M1 #3; `todo edit` and `todo rm` in M3 #5) |
| **M1 exit** fake-event tests; kill -9 of the daemon mid-journal loses nothing | Done (M1 #3, `test/integration/crash.test.ts`) |
| **M2** Herdr runtime | Done (M2 #4) |
| **M2** Claude and Pi worker adapters with contract suites | Done (M2 #4) |
| **M2** isolation assertion; worker verbs | Done (M2 #4) |
| **M2** steer push and re-ring | Done (M2 #4) |
| **M2** reconciler: evidence ranking, reattach, husks, resume-once | Done (M2 #4) |
| **M2 exit** a real scout end to end on each harness; killing a worker and the daemon mid-run both recover | Done (M2 #4, live 26/26) |
| **M3a/M3b** Claude and Pi leader bridges, one shared bridge contract suite | Done (M3 #5) |
| **M3** lane table, items, presentations, notifications | Done (M3 #5) |
| **M3** briefing with the morning section and to-dos | Done (M3 #5) |
| **M3** lease and handover | Done (M3 #5) |
| **M3** read-only board | Done (M3 #5; its approve key in M4 #6) |
| **M3 exit** the nine races of section 9 each have a passing test | Done (M3 #5, `test/integration/races.test.ts`; live 18/18) |
| **M4** no-mistakes, direct-PR and local-only delivery | Done (M4 #6) |
| **M4** GitHub watcher; named-head gate | Done (M4 #6) |
| **M4** approval channel, all four channels | Done (M4 #6) |
| **M4** merge gate with red refusal and proof | Done (M4 #6) |
| **M4** cleanup guard with both fixture sets green | Done (M4 #6; CI runs both) |
| **M4** board approve | Done (M4 #6) |
| **M4 exit** a ship from dispatch to merged and cleaned on each leader, approval from each channel | Done (M4 #6, fake leaders in `bun test`; live 17/17 against a local fake GitHub) |
| **M4** a real-GitHub end-to-end run | Not planned: you declined a sandbox repository. The direct-PR and no-mistakes paths are covered by the M4 fake-forge tests (`test/helpers/fake-github.ts` serves the same GitHub REST calls, backed by a real bare git repository). |
| **M5** workflow stages and review gates | Done (M5) |
| **M5** capacity pools with the host check and Docker label evidence | Done (M5) |
| **M5** plan, and auto-dispatch on landing | Done (M5) |
| **M5** the terse style block | Done (M3 #5 wrote it into the leader's prompt and the worker contract; M5 made it configurable in `[style]` and leading) |
| **M5** the three stage skills | Done (M5) |
| **M5** `feature-ui` carries visual QA (`feature` is design, build, ship); every QA page opens with a plain-language card, checked at `stage done` | Done (plain-language-qa-rh) |
| **M5 exit** a two-phase feature runs design, review, build, visual QA, review, ship and merge, and phase 2 starts by itself | Done (M5): fake leaders in `bun test`, and live in a Herdr lab session with two features side by side per flow and the worker pool capped at 4 (the scale the user approved, scaled from the design's "20 workers on a real machine" for cost). Peak concurrency: **2 live workers** in each flow. The Pi flow passed 17/17; the Claude flow passed 17/17 on its own run, after one real Claude worker in the combined run went idle at its ship stage without delivering; see [M5 notes](m5-notes.md#live-runs) |
| **M5 exit** 20 workers under the caps | Done (M5) with fake workers (real processes through the real CLI, no model calls) on the fake Herdr: 24 ships against the design's caps, the host check and the queue (`test/integration/capacity.test.ts`); not with 20 live model sessions, for cost |

## Other v1 items of the design

The milestone lists name the main work. These are the other v1 items in sections 2 to 16, and where each stands.

| Section | Item | Status |
|---|---|---|
| 5 | Contract tests gate every harness version; dispatch refuses an untested one (`contract_unverified`) | Done (M2 #4) |
| 5 | The daemon checks the installed harness version at startup | Done (v1 completion): at startup for every harness in use, at every dispatch, before every resume (yours or the reconciler's one automatic resume, which waits for a passing contract) and before every launch the scheduler grants; an untested version refuses (`contract_unverified`) and opens one P1 with the doctor command |
| 6 | The four automatic actions (resume once, re-ring, clean up after a proven merge, re-arm monitoring) | Done (M2 #4, M4 #6) |
| 6 | Judgment pointers: idle 15 min, busy with no hook 30 min, divergence, orphan | Done (M2 #4) |
| 7 | The threat model's mitigations (role tokens, deny rules, `/dev/tty` challenge, single-use approvals bound to the head) | Done (M1 #3, M3 #5, M4 #6) |
| 8 | One store per fact; the intent journal; hand edits win unless they contradict a live run | Done (M1 #3) |
| 8 | `flowryn divergence resolve <id> keep-run\|accept-edit` | Done (v1 completion): keep-run writes the runs' state back into the backlog through the journal; accept-edit lets your edit stand and cancels a live run (worker stopped, worktree kept); the divergence row and its P1 close together. A divergence between evidence sources takes keep-run only. `flowryn show d<N>` shows one |
| 8 | The reconciler's invariant pass: a task is In flight if and only if it has a non-terminal run | Done (v1 completion): on every full reconcile pass, against a backlog snapshot that matches the file; a violation either way is a backlog divergence (P1), one that holds again closes by itself |
| 8 | A scout's run landed and cleaned, its task done with `--report` | Done (v1 completion): a verified report lands the run (a scout's workflow ends in no gate), the daemon cleans the worktree up through the cleanup guard, and the task is done with `--report`; the `report_ready` P1 stays open until the report is read |
| 9 | Delivery classes, lanes, ordering, aging, limits and the listed races | Done (M3 #5) |
| 10 | Lease, claim, handover, read-only sessions | Done (M3 #5) |
| 11 | Workflows, gates, capacity, autonomy, the style block, the skills | Done (M5) |
| 11, 16 | Pause while a Claude usage limit is active; P1 once | Done (M5): from Claude's `StopFailure` `rate_limit` and `quota_auto_resume_fired` hook signals; the pause also expires after a backoff with one probe run, and `flowryn capacity resume --harness claude` lifts it (docs/m5-notes.md) |
| 12 | Leader verbs: dispatch, plan, steer, answer, dismiss, merge, decline, gate pass/changes, cleanup, fleet, show, brief, todo, project, leader status/claim | Done (M1 to M5) |
| 12 | `flowryn promote` (a scout promoted to a ship) | Done (v1 completion): a scout at work keeps its run, worker, worktree and session (the worker is relaunched into its own session under a ship's contract); a scout whose run is over becomes a ship on the same task with a new run that names its report |
| 12 | Worker verbs: report, ask, inbox, ack, stage done, deliver, fail | Done (M1 to M5) |
| 12 | Human verbs: approve [--gate], board, init, doctor, daemon, lead, leader claim --session, config | Done (M1 to M5) |
| 12 | Spool when the daemon is down; read-only reads; exit 69 for leader mutations | Done (M1 #3) |
| 13 | The SQLite schema (every table of section 13) | Done (M1 #3 to M5) |
| 14 | Every safeguard in the table, with the previous orchestrator's fixtures ported | Done (M1 #3 to M5; capacity caps and human-bound gates in M5) |
| 15 | `flowryn init`: preflight, data and state directories, tasks-axi files, tool paths, leaders, workers, service | Done (M1 #3; the leader files are written by `flowryn lead` on every launch, M3 #5) |
| 16 | Failure modes with their recovery: daemon crash, second daemon, Herdr restart, worker death, never-reporting worker, trust wedge, stuck busy, hook timeout, compaction, tasks-axi failure, hand edits, unproven merge, no-mistakes down, usage limit, stale CLI, corrupt database, host pressure, leftover Docker environments, a sleeping laptop | Done (M1 to M5) |
| 16 | Herdr unreachable: "P1 once" | Done (v1 completion): one P1 per outage, once it has lasted `[herdr] unreachable_alert_ms` (60 s) while a run is open or something it refused waits; it resolves when Herdr answers; the daemon also finds a Herdr that starts after it |
| 16 | GitHub unavailable or rate-limited: "P1 only if a merge is waiting" | Done (v1 completion): one P1 per outage while a delivered PR waits at the merge gate or a merge waits for its proof, naming them; it resolves when GitHub answers or no merge waits |
| 16 | Harness updated to an untested version: "P1 with the doctor command" | Done (v1 completion): the startup check, a dispatch, a resume and a launch each open it, once per version; a passing contract run resolves it |

## Cutover

The features that let Flowryn replace the previous orchestrator (docs/cutover-notes.md).

| Item | Status |
|---|---|
| C1 standalone decisions, the reserved policy, the user's word for a captain answer, scout open decisions, briefing sections | Done (C1) |
| C2 mid-run prompt wedges | Done (C2) |
| Queued work in fleet, show, the board and the briefing | Done: one shared definition of Queued (docs/cutover-notes.md, C3) |
| C3 the one-time import | Done (C3), then removed once the cutover was over: `dispatch --mode`, queued tasks outside plans and your preferences in the leader's prompt stay; the import command, its parser and `import.apply` are gone, and migration 9 marks what it created `legacy:<id>` (docs/cutover-notes.md) |
| Steer latency, Tier 0 and Tier 1: the interrupt key refused while a dialog may be open, a wake after an interrupt, the waiter armed at every turn start, seen evidence, fast re-rings of lost carries, a contract suite that measures steers | Done (docs/cutover-notes.md "Steers · latency") |
| Steer latency, Tier 2: `flowryn steer --urgent` blocks the next tool call and cuts a tool past `steer_preempt_after_ms`, never through a dialog, on Claude and Pi | Done (docs/cutover-notes.md "Steers · urgent") |
| Leader-safe `flowryn daemon restart`: leader or you, deterministic guards with `--when-idle`, the binary and plist checks, launchd `kickstart -k` asked by the daemon, `daemon.restarted` in the briefing | Done (docs/cutover-notes.md "Leader-safe daemon restart"); `kickstart -k` by the job itself not yet run live |
| Review questions: a review gate's open questions become decisions reserved for you, asked on the review page (lavish-axi's input playbook) and listed for the leader, the first answer counting; the ask rule (decide autonomously, ask only when blocked) in the worker contract and checked in code | Done: docs/m5-notes.md, "Gate questions" |
| Worker questions wake the leader: every open worker question reaches the leader without your message, batched per 30 s into one wake, a busy turn taking them at its Stop, on its own hourly budget; only a blocking one raises an OS alert; the daemon listens on every review page and wakes the leader with what you send from it | Done (docs/m5-notes.md "Worker questions wake the leader") |
| Clickable review answers: one Send carries every answer, an Other choice with your words, an "anything else" note and a pass request (a leader item; the gate still passes only through a human channel); the design and QA skills never list questions as text | Done: docs/m5-notes.md, "Gate questions", "One Send" |
| Away mode (autonomy spec 2, ship B): `flowryn away [--until] [--body-file -]` and `flowryn back`; while away every new item only you can move wakes the leader for the remote-control chat, on `[away] max_wakes_per_hour`; your messages never end it; `back` or the expiry gives one return brief (waiting on you, decided for you, landed, failed, spend); delivery only, no grants | Done: docs/m5-notes.md, "Away mode" |
| Leader contract checks: `doctor --contracts --verify-only` for any caller (the leader runs a worker-path PR's build before merging it); `[policy] mode` strict (default: only you record) or relaxed (the leader also records, from the installed build only, each record shown to you); workers never record | Done: docs/cutover-notes.md, "Approval channels · contract records from the leader"; docs/m5-notes.md, "Leader contract checks". A live leader run outside the Bash sandbox not yet done |

## Not in v1

These are out of v1 by the design itself (section 2's non-goals, section 17's "After v1"), not deferred work:

- The headless triage runner (the first post-v1 addition).
- Side-by-side running with the previous orchestrator.
- The Obsidian plugin; a Herdr plugin-pane board; the MCP wrapper; Claude Code channels and plugin monitors.
- Harnesses other than Claude Code and Pi; runtimes other than Herdr; Linux and native Windows hosts (the transport and service seams exist).
- Desks, quota-aware scheduling and profile routing; focus routing and score formulas; quiet mode (away mode came after v1, above); Jira; retention compaction; relay, the mail plane and multi-machine fleets.
- Stacking a phase on an open PR (a per-plan option after v1, section 11).
