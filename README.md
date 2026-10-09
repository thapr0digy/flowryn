# Flowryn

Flowryn is a self-contained coordinator for a fleet of coding agents. You talk to one leader agent (Claude Code or Pi), and it dispatches workers into isolated worktrees in Herdr panes. Workers push their updates to a single daemon, `flowrynd`, which keeps runtime state in SQLite, ranks each update, and delivers it to the leader at a natural pause so your main conversation is not flooded or interrupted.

## Status

M1 (core) is built: one signed binary that is both `flowryn` and `flowrynd`, the SQLite schema and event log, the tasks-axi intent journal and backlog watcher, and the CLI with to-do and project verbs, `init`, `doctor` and the launchd agent.

M2 (runtime, workers, reconciler) is built: the Herdr runtime, Claude Code and Pi worker adapters with their contract suites, the isolation assertion, the worker verbs, steers with re-ring, and the reconciler (evidence ranking, reattach, husks and resume-once).

M3 (leaders and attention) is built: `flowryn lead` starts a Claude Code or Pi leader with its leader bridge (a leader-only hook set for Claude, a leader extension for Pi), both passing one shared bridge contract suite; the leader lease and handover; the lane table with items, presentations and notifications; the briefing with its morning section and to-dos; the read-only `flowryn board`; and `todo edit` and `todo rm`.

M4 (delivery and policy) is built: ships deliver through no-mistakes, direct-PR or local-only, checked by the named-head gate; a GitHub watcher follows every delivered PR and its checks; merges go through the merge gate (red checks refused, one check waivable by you, the approval bound to the head) and count only once proven; your approval comes from Claude's own prompt, Pi's confirm, `flowryn approve` in your shell (a code read from `/dev/tty`) or the board's approve key; and landed work is cleaned up through the cleanup guard.

M5 (workflows, capacity and autonomy) is built, and with it v1: runs move through workflow stages (the `feature` workflow is design, build and ship; `feature-ui`, for work with screens, adds a visual QA review before ship) with review gates only your word passes (Claude's prompt, Pi's confirm, `flowryn approve --gate` or the board); capacity pools (20 workers, 5 validation, 5 Docker environments, 5 browsers by default) with a host check before every grant and Docker label evidence; phased plans whose next phase starts by itself once the previous one has landed; a configurable terse style block; the Claude usage-limit pause; and the three stage skills.

The v1 completion pass built the items M1 to M5 left open: the harness version checked at daemon startup and before every resume or launch; `flowryn divergence resolve <id> keep-run|accept-edit`; the reconciler's invariant pass (a task is In flight if and only if it has a live run); scouts that land with their report and are cleaned up through the cleanup guard; `flowryn promote`, a scout promoted to a ship in place; and the section 16 P1s for Herdr unreachable and for GitHub unavailable while a merge waits. [`docs/v1-status.md`](docs/v1-status.md) lists every v1 item: done, with the pull request that delivered it, or not built, with the reason.

The architecture spec is [`docs/design-v3.html`](docs/design-v3.html); open it in a browser. [`docs/m0-verdicts.md`](docs/m0-verdicts.md) records every M0 spike's verdict (Claude Code, Herdr, tasks-axi, no-mistakes and Pi), the tool versions tested, and each edit the verdicts made to the design. [`docs/m1-notes.md`](docs/m1-notes.md), [`docs/m2-notes.md`](docs/m2-notes.md), [`docs/m3-notes.md`](docs/m3-notes.md), [`docs/m4-notes.md`](docs/m4-notes.md) and [`docs/m5-notes.md`](docs/m5-notes.md) list the choices each milestone made where the design leaves room, and the live results of M2 to M5 (the v1 completion pass is the last section of the M5 notes).

Work after 2026-10-09 has one notes file per feature in [`docs/notes/`](docs/notes/README.md): the choices it made, its live results, its status and the configuration keys it adds. The milestone notes, the cutover notes and `docs/v1-status.md` are frozen records of the work before that. `bun run notes` prints every feature with its status, pull request and configuration keys.

## Development

Requirements: macOS, [Bun](https://bun.sh) 1.3.8, Node with `tasks-axi` 0.2.5 on PATH (`npm install -g tasks-axi@0.2.5`), `git`, and `jq` for the fixtures.

```bash
bun install                      # dependencies
bun run typecheck                # tsc --noEmit
bunx oxlint                      # lint (.oxlintrc.json); `bun run lint` runs the same
bun test                         # unit and integration tests, including the kill -9 exit test
bun run build                    # dist/flowryn plus the dist/flowrynd link, re-signed on macOS
fixtures/cleanup-guard/run.sh --impl "bun $PWD/scripts/guard/landed-impl.ts"   # the 21 landed-work fixtures, against Flowryn's guard
fixtures/cleanup-order/run.sh --impl "bun $PWD/scripts/guard/cleanup-impl.ts"   # the 23 cleanup-order fixtures (locks, reaping, parked runs)
```

After `bun run build` rewrites the binary the launchd agent runs, the daemon applies it by itself once nothing would break (`[daemon] auto_restart = "merged"`, the default): it notices the new build within 30 s, and restarts onto it through the same guards as `--when-idle` when the build is a clean build of a commit on `origin/<default branch>` and not older than the running daemon (protocol, version, schema). A build from a branch or a dirty tree gets an info line instead and is never applied by itself (after merging, rebuild from the default branch), and a downgrade a P1; `"off"` leaves every restart to you. Workers and the leader's hooks run a copy of the running daemon's build (`<state_dir>/bin/flowryn`), so a rebuild never strands them on a protocol the running daemon refuses (docs/m5-notes.md, "Automatic restarts"). `flowryn daemon restart` (or the leader) applies any build at once: it refuses while a restart would break a merge, a blocked prompt or a validation (`--when-idle` waits instead; a validation that only waits on external CI, with no local agent, does not block), smoke-checks the new binary first, and has launchd restart the daemon (docs/cutover-notes.md, "Leader-safe daemon restart"). After relinking a new build into a different place (for example `ln -sf "$PWD/dist/flowryn" ~/.local/bin/flowryn`), run `flowryn daemon uninstall && flowryn daemon install`: the launchd plist records the resolved binary path, so a daemon installed from the old build keeps running the old binary until it is reinstalled. Install waits for launchd to finish unloading the old agent and retries the bootstrap with a short backoff, so the two can run back to back.

The tests start real daemons on Unix sockets, watch files with FSEvents, run the real tasks-axi and drive `flowryn approve` and the board through a pty (`script` on macOS, Python's `pty` on Linux), so run them outside any command sandbox. They never reach GitHub or the real no-mistakes: a local fake GitHub and a stand-in no-mistakes answer instead.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs all of the above on `ubuntu-latest` on every pull request and on pushes to `main` (a macOS runner bills 10x). A few tests need macOS (the plist lint and the live launchd supervisor, the binary's codesign check, Claude's Seatbelt sandbox, the FSEvents file watch, BSD `script`); they are marked `test.skipIf(process.platform !== "darwin")` with the reason beside them, so CI reports them as skipped. They run on the Mac: no-mistakes runs the full `bun test` there before every pull request, so run it locally before you open one.

**CI is off until about 2026-11-07** (GitHub Actions billing): the workflow is disabled on GitHub and `.no-mistakes.yaml` declares `no_ci: true`, so pull requests have no checks; see [docs/v1-status.md](docs/v1-status.md#ci-is-off-2026-10-07) to re-enable both.

The source layout follows the component table in section 4 of the design: `src/api` (gateway, tokens, idempotency, spool), `src/journal` (intent journal, backlog watcher), `src/lifecycle` (to-do, project, dispatch and plans, launcher, workflow stages, steers, worker and hook verbs, delivery and landing), `src/harness` (the Claude and Pi adapters and the Pi worker extension), `src/runtime` (the Herdr client and runtime, process identity), `src/reconcile`, `src/watch` (the Herdr subscription, the GitHub and no-mistakes watchers), `src/forge` (the GitHub REST client), `src/policy` (approvals, the merge gate, review gates, the cleanup guard and cleanup order), `src/lease` (leader sessions and the lease), `src/sched` (capacity pools, the host check, the scheduler and auto-dispatch, the usage-limit pause), `src/skills` (the three stage skills), `src/attention` (lanes, presentations, the digest and briefing, notifications), `src/leader` (the leader side of the hook verbs), `src/bridges` (the Claude leader settings, the Pi leader extension, the leader skill), `src/contracts` (the harness contract suites and the leader bridge suite), `src/daemon`, `src/cli`, `src/db` (schema, migrations, events, backups), `src/transport`, `src/service` (launchd), `src/init` and `src/doctor`.

The tests never touch a real Herdr or harness: runtime tests use a fake Herdr (`test/helpers/fake-herdr.ts`) that runs a fake worker through the real `flowryn` hook and worker verbs, and the leader tests use a fake Claude leader that runs the real leader settings file's hooks and a fake Pi that loads the real leader extension. The live runs against Herdr, Claude Code and Pi are the contract suites, `scripts/lab/m2-live.sh` to `scripts/lab/m5-live.sh` and `scripts/lab/v1-live.sh` (see "Running the live runs" below).

## Using flowryn

```bash
flowryn init                        # interactive: tools, data and state directories, tasks-axi files, launchd agent
flowryn doctor                      # checks config, tools, tasks-axi files, database, daemon and service; shows the [policy] mode. Your own terminal only
flowryn daemon status               # start | stop | install | uninstall | run (foreground); shows the build and any pending restart
flowryn daemon restart              # onto the installed build; the leader may run it too. --when-idle waits for merges, prompts and validations to clear (a merged build applies by itself)
flowryn todo add "renew passport" --due 2026-10-01
flowryn todo list                   # --all, --due today|overdue
flowryn todo due <id> tomorrow      # YYYY-MM-DD, today, tomorrow, +Nd or none
flowryn todo done <id>
flowryn project add ~/code/web      # reads origin and the default branch
flowryn project set web --mode direct-PR --yolo on
flowryn dispatch web --kind scout --body-file - <<'EOF'
Find where the login redirect loop comes from.
EOF
flowryn fleet                       # every worker: state, liveness, its oldest open steer, what it needs; then queued work: blockers, --auto, what starts it
flowryn show <task>                 # one run in detail, with each steer's carried, seen and acked times; or a Queued task: its blockers, hold and what starts it
flowryn steer <task> --body-file -  # words for a worker, delivered at its next tool call or idle wake
flowryn steer <task> --urgent --body-file -  # cut in: block its next tool call, and cut a tool past 3 s (never through a dialog)
flowryn steer <task> --end-turn --body-file -  # it tells the worker to end its turn (wait, or it only informs): no turn-end reminder follows
flowryn answer <decision> <choice>  # answer a worker's question; it arrives as a steer
flowryn interrupt <task>            # stop the current turn (verified; refused while a dialog may be open); cancel <task>; resume <task>
flowryn doctor --contracts          # run the harness contract suites (steps and a time estimate up front, then step N/M) and record each passing version
flowryn doctor --contracts --verify-only  # the same suites, recording nothing; any caller, the leader included (its PR-build checks)
flowryn lead                        # start a Claude Code leader here; --pi for Pi; harness args after --
flowryn board                       # a live, read-only view: what needs you, the fleet, queued work, updates, to-dos (--once)
flowryn brief                       # the briefing again
flowryn dismiss <item>              # close an item that needs nothing more
flowryn away --until 08:00 --body-file -   # away: everything that needs you wakes the leader (remote control); +8h, 90m or a date; default 12 h
flowryn back                        # away ends; prints the return brief: waiting on you, decided for you, landed, failed, spend
flowryn show d3                     # a divergence: which sources disagree, and how to settle it
flowryn divergence resolve d3 keep-run    # the run's state wins, written back into the backlog; accept-edit: your edit wins
flowryn promote <task> --body-file -  # a scout becomes a ship in place: same task, and while it works the same worker
flowryn leader status               # which session leads; leader claim [--session <id>] moves the lease
flowryn todo edit <id> --title <t>  # or --body-file -; the due date stays. todo rm <id> removes one
flowryn approve <task>              # your word for a merge: shows the PR, head and checks, reads a code from /dev/tty
flowryn approve <task> --allow-red lint   # waive exactly one failing check; --discard approves throwing work away
flowryn merge <task>                # through the merge gate; it counts only once GitHub (or local main) proves it
flowryn merge <task> --allow-red 'CI / build'  # the leader's waiver: Claude's prompt (or Pi's confirm) names the check, your yes waives it
flowryn decline <task> --body-file -  # send a delivered ship back with your words
flowryn cleanup <task> [--discard]  # remove a landed, cancelled or failed task's worktree, through the cleanup guard
flowryn dispatch web --kind ship --workflow feature --body-file -   # design, review, build, ship
flowryn dispatch web --kind ship --workflow feature-ui --body-file -   # the same plus visual QA and its review (work with screens)
flowryn plan web --body-file plan.md  # a phased feature: one "## Phase" section each; each starts once the one before lands
flowryn show p1                     # a plan's phases and where each is
flowryn approve <task> --gate design  # pass a review gate in your terminal (the board's a key lists reviews too)
flowryn gate changes <task> --body-file -  # send a review back with your words (QA goes back to build)
flowryn decide q7 db --by captain   # your answer to a review's question (or click it on the review page itself)
flowryn decide q7 other --by captain --words "redis"  # your own answer to a review question, in your words
flowryn capacity                    # pools over their caps, the host check, and what waits for a grant
flowryn capacity resume --harness claude  # lift the Claude usage-limit pause now, in your own terminal
flowryn decision list               # open decisions; --reserved (only you may answer), --deferred, --all
flowryn show q7                     # one decision: its question, context and why in full (lists cut them to a line)
flowryn decision add --key db --question "SQLite or Postgres?" --options sqlite,postgres --body-file -
flowryn decide k3 sqlite --rationale "one process"   # the leader's answer; reserved ones need your word
flowryn decide k3 sqlite --rationale -              # the same, the rationale read from stdin
flowryn decide k3 sqlite --body-file -               # in your own shell: your answer, verbatim
flowryn decision defer k3 --until 2026-11-01
flowryn dispatch web --kind ship --mode direct-PR --mode-reason "internal CI only" --body-file -
flowryn help                        # every verb; `flowryn <verb> --help` for one
```

A leader is the one conversation you talk to. `flowryn lead` runs Claude Code with a leader-only settings file (`--settings`) or Pi with the Flowryn leader extension (`-e`), plus the flowryn skill and the terse style block, all written under `~/.flowryn/leader/`; your own harness settings are never edited. One session holds the leader lease: it gets a briefing at every session start and compaction, a digest of new items on your next message, and a P0 line after its current turn, or as a new turn when it is idle and you are away. Any other leader session is read-only until it runs `flowryn leader claim`. P0s and batched updates also reach you as macOS and Herdr notifications.

Output is TOON by default and JSON with `--json`. Errors print `error`, `code` and `help`, and the exit code says what happened: 0 ok, 2 policy refusal, 3 validation, 4 not found, 69 daemon down, 75 spooled, 76 protocol mismatch, 77 role refused. When the daemon is down, reads come from the database read-only with a banner, worker verbs spool to disk and are delivered at the next start, and leader mutations exit 69.

Configuration lives in `~/.flowryn/config.toml` (`FLOWRYN_HOME` moves the whole home, which tests use). The daemon reloads it on `SIGHUP`, and keeps the old configuration when the new one fails validation. M2 adds `[herdr]` (`socket` or `session`), `[workers]` (`worktree_root`, `branch_prefix`), `[workers.claude]` (`model`, `effort`, `permission_mode`, `pretrust`, `config_dir`, `extra_args`), `[workers.pi]` (`model`, `effort`, `agent_dir`, `session_dir`, `extensions`, `no_extensions`, `no_skills`, `no_context_files`, `extra_args`, `env`) and `[reconcile]` (the reconciler's clocks, for tests and the lab); [`docs/m2-notes.md`](docs/m2-notes.md) explains each. M3 adds `[notify]` (`macos`, `herdr`, `min_interval_min`, `p0_coalesce_s`, `max_triggered_turns_per_hour`, `p0_renotify_min`) and `[leader]` (the leader's clocks, for tests and the lab); [`docs/m3-notes.md`](docs/m3-notes.md) explains them. M4 adds `[github]` (`api_url`, `web_url`, `token_env`, `poll_ms`, `timeout_ms`, `merge_method`) and `[cleanup]` (the cleanup guard's clocks); [`docs/m4-notes.md`](docs/m4-notes.md) explains them. The macOS notification channel is on in your own setup unless `[notify] macos = false` (`flowryn init` asks and writes the answer; `flowryn doctor` warns when the key is missing). `FLOWRYN_NOTIFY=off` makes a daemon record its notifications without delivering any: the tests and live runs set it, and refuse to start a daemon without it. M5 adds `[workflows.<id>]` (`stages = [{ id, skill, gate, pools, fresh }]`), `[capacity]` (a cap per pool) and `[capacity.host]` (`min_free_mem_gb`, `max_load_per_core`, `probe`), `[autonomy]` (`default`), `[style]` (`terse`, `text` or `file`), `[sched]` (the scheduler's clocks, for tests and the lab) and `docker` in `[tools]`; [`docs/m5-notes.md`](docs/m5-notes.md) explains them. The v1 completion pass adds `[herdr] unreachable_alert_ms` (how long Herdr may be away, while something needs it, before its P1; default 60 s). The cutover adds `[decisions]` (`reserved_classes`) and `[reconcile] prompt_suspect_ms` (default 120 s); the steer latency work adds `[reconcile] seen_timeout_ms` (default 5 s) and `[reconcile] steer_preempt_after_ms` (default 3 s, how long a tool runs before an urgent steer cuts it); docs/cutover-notes.md explains them. The idle-worker fixes add `[reconcile] idle_realert_ms` (default 4 h) and `waiter_grace_ms` (default 20 s); docs/m5-notes.md ("Idle workers") explains them. The daemon sends a GitHub token (from `GH_TOKEN`, `GITHUB_TOKEN` or `gh auth token`) only to GitHub's own API. Away mode adds `[away]` (`max_wakes_per_hour`, default 6; `default_hours`, default 12; `suggest_after_min`, default 60); docs/m5-notes.md, "Away mode", explains them. The turn-end guard adds `[workers] turn_end_guard` (default true; contract runs turn it off, since their worker ends its turns without an outcome on purpose). Review questions add `lavish_axi` in `[tools]` (optional: without it a review's questions are answered only through the leader); docs/m5-notes.md, "Gate questions", explains them. Leader contract checks add `[policy] mode` (`strict`, the default and what a missing key means: only your own terminal records a contract pass; `relaxed`: the leader may also record one, from the installed build only, and the daemon runs the recording check itself on a new harness version); `flowryn init` asks, `flowryn doctor` shows it, and docs/cutover-notes.md, "Approval channels · contract records from the leader", explains both.

Workers decide what they can themselves and record why; they ask only when they cannot proceed. They call the same CLI from their pane, with the run's token: `report <status>` (`finding`, `blocked`, `failed` and any word outside the fixed table open a P1 item your leader sees at its next turn end (once), in its digest and `fleet`, and `flowryn show <item>` gives the whole text; `progress` and other status words are only recorded), `ask` (with `--blocks <what waits on the answer>`), `inbox`, `ack`, `stage done` (with `--review <lavish url> --page <html>` before a review gate, so flowrynd listens on the page itself and wakes your leader with what you send from it, and `--questions-file <json>` for what only you can answer: each question becomes a decision reserved for you, asked on the review page as clickable options with the recommendation preselected, an Other choice, an "anything else" box and one Send for all of them, and listed for your leader; the gate passes once each is answered, and the page's "request pass" only asks your leader to confirm the pass with you), `stage begin <last stage>` (a no-mistakes ship calls it before its pipeline, so the pipeline runs under the ship stage's `validation` slot; `stage_waiting` means end the turn until a steer says it has started) and `stage show`, `deliver` (`--report` for a scout; `--pr <url>` or `--local` for a ship, by the project's delivery mode) and `fail`, and the `hook` verbs their Claude hooks or Pi extension call. A merge needs your word, except a yolo project's non-sensitive merge, which runs without a prompt: a Claude leader's `flowryn merge` puts Claude's own prompt in front of you, and a Pi leader merges through its `flowryn_merge` tool, which asks you with a confirm; or approve in your shell (`flowryn approve`) or on the board (`a`). Dispatch, a resume and a launch refuse a harness version that has no passing contract run, and the daemon checks the installed versions at startup, opening one P1 per untested version, so run `flowryn doctor --contracts` after installing or updating Claude Code or Pi. Your leader runs it too: under `[policy] mode = "relaxed"` it records the pass itself from the installed build, and each pass it records reaches you as a line on your next message and in the briefing; under `strict` it asks you to run it. Under `relaxed` the daemon also runs the recording check by itself when it finds a new version: one at a time, once per version, from the pinned copy of the build it runs, never while a restart is pending (and a restart waits for it). A pass is recorded with a line on your next message and in the briefing, and the P1 opens only if the check fails (its line names the report) or the daemon cannot run it (a development command); docs/m5-notes.md, "Automatic contract checks", has the details. Before merging a ship whose PR touches `src/lifecycle/`, `src/harness/`, `src/contracts/` or `src/reconcile/`, the leader runs that PR's build with `doctor --contracts --verify-only`, which records nothing, and merges only after it passes. Every other `doctor` stays your own terminal's.

## Key choices

- The control plane is CLI-first: an agent-ergonomic `flowryn` CLI over the daemon socket. An MCP wrapper is optional.
- Runtime state lives in SQLite, owned by `flowrynd`. Tasks and to-dos live in tasks-axi, whose location is set during setup.
- Claude Code and Pi are first-class leaders, and Herdr is the runtime.

## Running the live runs

### The M2 live exit

M2's exit test runs a real scout on each harness, kills a worker mid-run and, separately, the daemon, and checks that both recover. Unit and integration tests cover the same paths against the fake Herdr; the live run proves them against Herdr 0.7.5, Claude Code and Pi.

```bash
scripts/lab/m2-live.sh --claude-project "$PWD"               # every phase
scripts/lab/m2-live.sh contracts                              # one phase: contracts, scouts, kill-worker or kill-daemon
```

It provisions a Herdr lab session through `spikes/lib/herdr-lab.sh` (or reuses `FLOWRYN_LAB_SESSION`), builds a scratch Flowryn home and daemon, and removes both at the end. `--keep` leaves the home for inspection. Pi works in a fresh clone of this repository inside that home, with a scratch agent dir and the offline scripted provider; set `M2_PI_MODEL` to use another model. Claude runs only with `--claude-project <checkout>`: a checkout Claude already trusts, whose linked worktrees inherit that trust. `pretrust = "check"` means `~/.claude.json` is never written. Every branch the run creates is named `flowryn/contract-<runid>-…`, and the run removes exactly those branches and their worktrees on exit, including on failure or a signal. Results print as PASS/FAIL lines and go to `spikes/.runs/m2-live-results.json`. Run it outside any command sandbox. [`docs/m2-notes.md`](docs/m2-notes.md) records the latest results.

### The M3 leader bridges, live

The shared leader bridge contract suite runs in `bun test` against fake leaders. The live run proves it against real leaders started with `flowryn lead` in a Herdr lab session.

```bash
scripts/lab/m3-live.sh --claude-project "$PWD"               # Claude Code and Pi
scripts/lab/m3-live.sh pi                                     # Pi only (the offline scripted provider)
```

It provisions a Herdr lab session through `spikes/lib/herdr-lab.sh` (or reuses `FLOWRYN_LAB_SESSION`), builds a scratch Flowryn home and daemon, starts two leaders of each harness in lab panes, types into them as you would, and removes everything at the end (`--keep` leaves the home). Claude leads from a linked worktree of the checkout you name, which Claude must already trust, on a `flowryn/contract-<runid>-leader` branch removed with its worktree on exit; `M3_CLAUDE_MODEL` defaults to `haiku`. Pi leads from a scratch directory with a scratch agent dir and the offline scripted provider; set `M3_PI_MODEL` (and `M3_PI_AGENT_DIR` with a copy of its `auth.json`) to use another model. Results print as PASS/FAIL lines and go to `spikes/.runs/m3-live-results.json`. Run it outside any command sandbox.

### The M4 exit, live

The M4 exit test runs in `bun test` against fake leaders, fake workers and a fake GitHub (`test/integration/m4-exit.test.ts`). The live run proves it against real leaders and workers in a Herdr lab session.

```bash
scripts/lab/m4-live.sh --claude-project "$PWD"               # every flow, with the harness contract suites first
scripts/lab/m4-live.sh --seed-contracts pi-confirm board      # some flows; seed the contract record instead of running it
```

Flows: `claude-ask` and `cli-tty` on a Claude leader, `pi-confirm`, `board` and `forge` on a Pi leader. Each is one ship from dispatch to merged and cleaned. Local-only ships land for real; direct-PR and no-mistakes ships push to bare origins behind a fake GitHub the run serves on 127.0.0.1, so no GitHub repository is touched. Claude flows need `--claude-project <checkout>` (a checkout Claude already trusts): the run makes linked worktrees of it on `flowryn/contract-<runid>-…` branches and removes exactly those on exit. The run answers only the merge prompts under test (Claude's permission prompt, Pi's confirm), never a trust dialog. Results print as PASS/FAIL lines and go to `spikes/.runs/m4-live-results.json`. Run it outside any command sandbox.

### The M5 exit, live

The M5 exit test runs in `bun test` against fake leaders and fake workers (`test/integration/m5-exit.test.ts`), and the 20-worker capacity exit against fake workers on the fake Herdr (`test/integration/capacity.test.ts`). The live run proves two-phase features against real leaders and concurrent real workers in a Herdr lab session.

```bash
scripts/lab/m5-live.sh --claude-project "$PWD"               # both flows, with the harness contract suites first
scripts/lab/m5-live.sh --seed-contracts pi                     # the Pi flow only; seed the contract record instead of running it
```

Flows: `pi` (a Pi leader, Pi workers on the offline scripted provider, scratch repositories; the design passes through the `flowryn_gate_pass` confirm and QA on the board) and `claude` (a Claude leader; phase 1 on a scripted Pi worker, phase 2 on a real Claude worker, in linked worktrees of the checkout you name; the design passes through Claude's prompt and QA through `flowryn approve --gate qa` in a lab pane). Each flow runs two independent two-phase features side by side under its one leader, each in its own project. Each feature runs design, review, build, visual QA (a real `nginx:alpine` container labelled with the run, a curl and a `chrome-devtools-axi` screenshot), review, ship and merge, then checks that phase 2 starts by itself only after phase 1 has landed. Both phase-1 workers are live together, and the worker pool is capped at 4. The run samples the live worker processes throughout, and a flow fails unless the peak is 2 to 4. The latest runs reached a peak of 2 live workers in each flow; [`docs/m5-notes.md`](docs/m5-notes.md) records them. The run answers only the review and merge prompts under test, never a trust dialog, and removes every branch, worktree and container it made. Results print as PASS/FAIL lines and go to `spikes/.runs/m5-live-results.json`. Run it outside any command sandbox.

### The v1 completion pass, live

The completion pass's items are covered in `bun test` (`test/integration/harness-gate.test.ts`, `divergence.test.ts`, `promote.test.ts`, `outages.test.ts` and the scout cases of `workers.test.ts`). The live run proves the platform-facing ones against real Herdr and Pi in a lab session.

```bash
scripts/lab/v1-live.sh                         # every phase; the last stops its own lab session
scripts/lab/v1-live.sh scout promote           # some phases (Pi's contract record is seeded without the harness phase)
```

Phases: `harness` (the startup check reads the real installed Claude Code and Pi versions and opens a P1 for each untested one; Pi's contract suite passes and settles its P1; a dispatch on Claude refuses; no Claude model is ever called), `scout` (a Pi scout lands with its report and is cleaned up through the cleanup guard, its task done with the report), `promote` (a Pi scout promoted in place mid-task is relaunched into its own session as a ship, which commits, delivers locally, merges under yolo and is cleaned), `divergence` (a hand edit against a live run settled with keep-run; a task put In flight by hand, raised by the invariant pass and settled with accept-edit) and `herdr` (the lab session is stopped through the lab helper under a live run, and one P1 opens for the outage while the retries go on). Pi runs the offline scripted provider with a scratch agent dir; the projects are fresh clones inside a scratch home that is removed at the end. Results print as PASS/FAIL lines and go to `spikes/.runs/v1-live-results.json`. Run it outside any command sandbox.

### The cutover, live

C1's decisions and C2's prompt wedges are covered in `bun test` (`test/integration/decisions-confirm.test.ts` and others, `prompt-wedge.test.ts`). The live run proves both against a real Claude Code worker.

```bash
scripts/lab/cutover-live.sh                    # both phases
scripts/lab/cutover-live.sh prompt             # one phase
```

Phases: `decisions` (a real Claude scout delivers a report whose `## Open decisions` section raises three standalone decisions, one `Reserved: lab`; the leader answers two with `--rationale`, your own shell answers the reserved one, and a `--blocked-by <task> --auto` ship gets a run within 120 s of its blocker landing) and `prompt` (a real Claude worker whose task branch carries an extra `.claude/settings.json`, committed to that worktree's own disposable branch rather than written by Flowryn, with a `PreToolUse` hook that forces an "ask" decision on `git commit --amend`; the run must open one `blocked_prompt` item naming "amend" within 120 s, with no `worker_idle` item alongside). Both phases run on fresh clones of this repository in a scratch Flowryn home with its own scratch daemon, using a linked worktree of this already-trusted checkout against your real `~/.claude` with `[workers.claude] pretrust = "check"`, so nothing here ever touches `~/.flowryn` or writes to `~/.claude.json`; every worker branch carries this run's own `flowryn/contract-<runid>-` prefix. Results print as PASS/FAIL lines and go to `spikes/.runs/cutover-live-results.json`. Run it outside any command sandbox.

## Running the M0 spikes

The spikes are throwaway shell scripts under [`spikes/`](spikes), grouped as `claude/`, `herdr/`, `tasks-axi/`, `no-mistakes/` and `pi/`. Each script prints one `VERDICT <id>: <verdict>` line and writes `spikes/.runs/results/<id>.json`. `spikes/.runs/` is gitignored and holds every log, probe event and transcript pointer.

Requirements: macOS, `bash`, `jq`, `perl`, and the tools under test (`claude`, `herdr`, `tasks-axi`, `no-mistakes`; Pi for the Pi group, found as `PI_BIN`, then `/opt/homebrew/bin/pi-signed`, then `pi` on `PATH`). Herdr and Claude spikes use the vendored lab helper `spikes/lib/herdr-lab.sh`; set `HERDR_LAB_HELPER` to use another one.

The Herdr and Claude spikes start Claude Code from the repo root, so the checkout must be a directory Claude Code already trusts. In an untrusted checkout (a fresh worktree, for example) Claude stops at its workspace-trust dialog before any hook runs, and the spike fails with `blocked: untrusted path <dir>`. The spikes never accept that dialog, because doing so edits `~/.claude.json`. `spikes/run-all.sh` exits non-zero when any spike exits non-zero or records no result.

```bash
spikes/run-all.sh                    # every group; provisions and tears down one lab session
spikes/run-all.sh tasks-axi          # one group: tasks-axi, no-mistakes, herdr, claude or pi
bash spikes/claude/c01-async-rewake.sh   # one spike; provisions its own lab session
```

To share one lab session across several single-spike runs:

```bash
mkdir -p spikes/.runs && spikes/lib/lab-hold.sh &
export FLOWRYN_LAB_SESSION=$(cat spikes/.runs/lab-session)
bash spikes/herdr/h04-split-env.sh
touch spikes/.runs/lab-release       # tears the session down
```

Safety rules the scripts follow:

- Every Herdr call goes through `spikes/lib/herdr-lab.sh`, which pins a named `fl-lab-*` session and checks that the default session is unchanged at teardown. No spike touches the default session or a pane it did not create.
- Each Claude spike passes a per-spike settings file with `--settings` and runs in its own lab workspace. Sessions start from the repo root with `--setting-sources user`, so the repo's `CLAUDE.md` import raises no dialog and no project or local settings load. No spike edits `~/.claude/settings.json`, project settings or `~/.claude.json`.
- tasks-axi spikes use scratch backlogs under `spikes/.runs/`.
- `spikes/no-mistakes/n01-gate-env.sh` is read-only; `--watch <seconds>` scans a live gate run's processes for worker-only variable names.
- The Herdr and Claude spikes need access to Herdr's sockets, so run them outside any command sandbox.

Pi spikes need no model account: every turn comes from an offline scripted provider (`spikes/pi/lib/scripted-provider.ts`), and each Pi process uses a scratch agent dir, so `~/.pi` is never read or written. [`spikes/pi/NOTES.md`](spikes/pi/NOTES.md) covers the method and an optional real-model smoke pass.

Claude spikes use Haiku by default (`CLAUDE_SPIKE_MODEL`). The ask-prompt and steer spikes, and the auto-mode run in `c09`, default to Sonnet, because their outcome depends on the model. A full run makes real model calls: about two dozen short sessions.

The cleanup-guard fixtures are separate: `fixtures/cleanup-guard/run.sh` builds and checks all 21 landed-work cases, and `fixtures/cleanup-order/run.sh` the 23 cleanup-order cases (index locks, parked no-mistakes runs, leaked processes, the order of the steps); `run.sh --impl <cmd>` runs an implementation against either set. See [`fixtures/cleanup-guard/README.md`](fixtures/cleanup-guard/README.md) and [`fixtures/cleanup-order/README.md`](fixtures/cleanup-order/README.md).
