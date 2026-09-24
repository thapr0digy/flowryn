# Flowryn v1 status

v1 is M1 through M5 of [`design-v3.html`](design-v3.html) section 17, after the M0 spikes. This file lists every v1 item of the design: done, with the milestone and pull request that delivered it, or not built, with the reason. Each milestone's notes ([M1](m1-notes.md), [M2](m2-notes.md), [M3](m3-notes.md), [M4](m4-notes.md), [M5](m5-notes.md)) record the choices it made and its live results; [`m0-verdicts.md`](m0-verdicts.md) records the spikes.

| Milestone | Pull request |
|---|---|
| M0 · Contract spikes and fixtures | Claude, Herdr, tasks-axi and no-mistakes spikes in the initial import; Pi spikes in https://github.com/thapr0digy/flowryn/pull/2 |
| M1 · Core | https://github.com/thapr0digy/flowryn/pull/3 |
| M2 · Runtime, workers, reconciler | https://github.com/thapr0digy/flowryn/pull/4 |
| M3 · Leaders and attention | https://github.com/thapr0digy/flowryn/pull/5 |
| M4 · Delivery and policy | https://github.com/thapr0digy/flowryn/pull/6 |
| M5 · Workflows, capacity, autonomy | the pull request that adds this file |

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
| **M5 exit** a two-phase feature runs design, review, build, visual QA, review, ship and merge, and phase 2 starts by itself | Done (M5): fake leaders in `bun test`, and live in a Herdr lab session with two features side by side per flow and the worker pool capped at 4 (the scale the user approved, scaled from the design's "20 workers on a real machine" for cost). Peak concurrency: **2 live workers** in each flow. The Pi flow passed 17/17; the Claude flow passed 17/17 on its own run, after one real Claude worker in the combined run went idle at its ship stage without delivering; see [M5 notes](m5-notes.md#live-runs) |
| **M5 exit** 20 workers under the caps | Done (M5) with fake workers (real processes through the real CLI, no model calls) on the fake Herdr: 24 ships against the design's caps, the host check and the queue (`test/integration/capacity.test.ts`); not with 20 live model sessions, for cost |

## Other v1 items of the design

The milestone lists name the main work. These are the other v1 items in sections 2 to 16, and where each stands.

| Section | Item | Status |
|---|---|---|
| 5 | Contract tests gate every harness version; dispatch refuses an untested one (`contract_unverified`) | Done (M2 #4) |
| 5 | The daemon checks the installed harness version at startup | Not built: the check runs at every dispatch (and every auto-dispatched phase), not at daemon startup or before a resume. |
| 6 | The four automatic actions (resume once, re-ring, clean up after a proven merge, re-arm monitoring) | Done (M2 #4, M4 #6) |
| 6 | Judgment pointers: idle 15 min, busy with no hook 30 min, divergence, orphan | Done (M2 #4) |
| 7 | The threat model's mitigations (role tokens, deny rules, `/dev/tty` challenge, single-use approvals bound to the head) | Done (M1 #3, M3 #5, M4 #6) |
| 8 | One store per fact; the intent journal; hand edits win unless they contradict a live run | Done (M1 #3) |
| 8 | `flowryn divergence resolve <id> keep-run\|accept-edit` | Not built: no milestone list names it, and M2 deferred it. A divergence's P1 can be closed with `flowryn dismiss`, but the divergence row stays unresolved and nothing re-applies the run's backlog state. A follow-up. |
| 8 | The reconciler's invariant pass: a task is In flight if and only if it has a non-terminal run | Not built (M2 deferred it). The backlog watcher flags hand edits against live runs as divergences (M1), which covers the common case; a task that drifts another way is not caught. A follow-up. |
| 8 | A scout's run landed and cleaned, its task done with `--report` | Not built: a scout that delivered its report stays `ready` (its P1 `report_ready` can be dismissed); nothing moves the run to `cleaned` or the task to Done. A follow-up, together with `promote`. |
| 9 | Delivery classes, lanes, ordering, aging, limits and the listed races | Done (M3 #5) |
| 10 | Lease, claim, handover, read-only sessions | Done (M3 #5) |
| 11 | Workflows, gates, capacity, autonomy, the style block, the skills | Done (M5) |
| 11, 16 | Pause while a Claude usage limit is active; P1 once | Done (M5): from Claude's `StopFailure` `rate_limit` and `quota_auto_resume_fired` hook signals |
| 12 | Leader verbs: dispatch, plan, steer, answer, dismiss, merge, decline, gate pass/changes, cleanup, fleet, show, brief, todo, project, leader status/claim | Done (M1 to M5) |
| 12 | `flowryn promote` (a scout promoted to a ship) | Not built: no milestone list names it. Dispatch a ship that names the scout's report meanwhile. A follow-up. |
| 12 | Worker verbs: report, ask, inbox, ack, stage done, deliver, fail | Done (M1 to M5) |
| 12 | Human verbs: approve [--gate], board, init, doctor, daemon, lead, leader claim --session, config | Done (M1 to M5) |
| 12 | Spool when the daemon is down; read-only reads; exit 69 for leader mutations | Done (M1 #3) |
| 13 | The SQLite schema (every table of section 13) | Done (M1 #3 to M5) |
| 14 | Every safeguard in the table, with Firstmate's fixtures ported | Done (M1 #3 to M5; capacity caps and human-bound gates in M5) |
| 15 | `flowryn init`: preflight, data and state directories, tasks-axi files, tool paths, leaders, workers, service | Done (M1 #3; the leader files are written by `flowryn lead` on every launch, M3 #5) |
| 16 | Failure modes with their recovery: daemon crash, second daemon, Herdr restart, worker death, never-reporting worker, trust wedge, stuck busy, hook timeout, compaction, tasks-axi failure, hand edits, unproven merge, no-mistakes down, usage limit, stale CLI, corrupt database, host pressure, leftover Docker environments, a sleeping laptop | Done (M1 to M5) |
| 16 | Herdr unreachable: "P1 once" | Partly: dispatch refuses (`herdr_unavailable`), liveness reads `unknown` and launches retry, but no P1 opens. A follow-up. |
| 16 | GitHub unavailable or rate-limited: "P1 only if a merge is waiting" | Partly: the watchers back off and a merge refuses (`forge_unavailable`), but no P1 opens for a waiting merge. A follow-up. |
| 16 | Harness updated to an untested version: "P1 with the doctor command" | Partly: dispatch refuses with `contract_unverified` and the doctor command as help, and a ready plan phase opens a P1 (`phase_blocked`); a leader's dispatch gets the refusal, not a P1. |

## Not in v1

These are out of v1 by the design itself (section 2's non-goals, section 17's "After v1"), not deferred work:

- The headless triage runner (the first post-v1 addition).
- Side-by-side running with Firstmate, and backlog import.
- The Obsidian plugin; a Herdr plugin-pane board; the MCP wrapper; Claude Code channels and plugin monitors.
- Harnesses other than Claude Code and Pi; runtimes other than Herdr; Linux and native Windows hosts (the transport and service seams exist).
- Desks, quota-aware scheduling and profile routing; focus routing and score formulas; away and quiet modes; Jira; retention compaction; relay, the mail plane and multi-machine fleets.
- Stacking a phase on an open PR (a per-plan option after v1, section 11).
