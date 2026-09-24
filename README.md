# Flowryn

Flowryn is a self-contained coordinator for a fleet of coding agents. You talk to one leader agent (Claude Code or Pi), and it dispatches workers into isolated worktrees in Herdr panes. Workers push their updates to a single daemon, `flowrynd`, which keeps runtime state in SQLite, ranks each update, and delivers it to the leader at a natural pause so your main conversation is not flooded or interrupted.

## Status

M1 (core) is built: one signed binary that is both `flowryn` and `flowrynd`, the SQLite schema and event log, the tasks-axi intent journal and backlog watcher, and the CLI with to-do and project verbs, `init`, `doctor` and the launchd agent.

M2 (runtime, workers, reconciler) is built: the Herdr runtime, Claude Code and Pi worker adapters with their contract suites, the isolation assertion, the worker verbs, steers with re-ring, and the reconciler (evidence ranking, reattach, husks and resume-once).

M3 (leaders and attention) is built: `flowryn lead` starts a Claude Code or Pi leader with its leader bridge (a leader-only hook set for Claude, a leader extension for Pi), both passing one shared bridge contract suite; the leader lease and handover; the lane table with items, presentations and notifications; the briefing with its morning section and to-dos; the read-only `flowryn board`; and `todo edit` and `todo rm`.

M4 (delivery and policy) is built: ships deliver through no-mistakes, direct-PR or local-only, checked by the named-head gate; a GitHub watcher follows every delivered PR and its checks; merges go through the merge gate (red checks refused, one check waivable by you, the approval bound to the head) and count only once proven; your approval comes from Claude's own prompt, Pi's confirm, `flowryn approve` in your shell (a code read from `/dev/tty`) or the board's approve key; and landed work is cleaned up through the cleanup guard.

M5 (workflows, capacity and autonomy) is built, and with it v1: runs move through workflow stages (the `feature` workflow is design, build, visual QA and ship) with review gates only your word passes (Claude's prompt, Pi's confirm, `flowryn approve --gate` or the board); capacity pools (20 workers, 5 validation, 5 Docker environments, 5 browsers by default) with a host check before every grant and Docker label evidence; phased plans whose next phase starts by itself once the previous one has landed; a configurable terse style block; the Claude usage-limit pause; and the three stage skills. [`docs/v1-status.md`](docs/v1-status.md) lists every v1 item: done, with the pull request that delivered it, or not built, with the reason.

The architecture spec is [`docs/design-v3.html`](docs/design-v3.html); open it in a browser. [`docs/m0-verdicts.md`](docs/m0-verdicts.md) records every M0 spike's verdict (Claude Code, Herdr, tasks-axi, no-mistakes and Pi), the tool versions tested, and each edit the verdicts made to the design. [`docs/m1-notes.md`](docs/m1-notes.md), [`docs/m2-notes.md`](docs/m2-notes.md), [`docs/m3-notes.md`](docs/m3-notes.md), [`docs/m4-notes.md`](docs/m4-notes.md) and [`docs/m5-notes.md`](docs/m5-notes.md) list the choices each milestone made where the design leaves room, and the live results of M2 to M5.

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

The tests start real daemons on Unix sockets, watch files with FSEvents, run the real tasks-axi and drive `flowryn approve` and the board through a pty (`script`), so run them outside any command sandbox. They never reach GitHub or the real no-mistakes: a local fake GitHub and a stand-in no-mistakes answer instead. CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs all of the above on every pull request and on pushes to `main`.

The source layout follows the component table in section 4 of the design: `src/api` (gateway, tokens, idempotency, spool), `src/journal` (intent journal, backlog watcher), `src/lifecycle` (to-do, project, dispatch and plans, launcher, workflow stages, steers, worker and hook verbs, delivery and landing), `src/harness` (the Claude and Pi adapters and the Pi worker extension), `src/runtime` (the Herdr client and runtime, process identity), `src/reconcile`, `src/watch` (the Herdr subscription, the GitHub and no-mistakes watchers), `src/forge` (the GitHub REST client), `src/policy` (approvals, the merge gate, review gates, the cleanup guard and cleanup order), `src/lease` (leader sessions and the lease), `src/sched` (capacity pools, the host check, the scheduler and auto-dispatch, the usage-limit pause), `src/skills` (the three stage skills), `src/attention` (lanes, presentations, the digest and briefing, notifications), `src/leader` (the leader side of the hook verbs), `src/bridges` (the Claude leader settings, the Pi leader extension, the leader skill), `src/contracts` (the harness contract suites and the leader bridge suite), `src/daemon`, `src/cli`, `src/db` (schema, migrations, events, backups), `src/transport`, `src/service` (launchd), `src/init` and `src/doctor`.

The tests never touch a real Herdr or harness: runtime tests use a fake Herdr (`test/helpers/fake-herdr.ts`) that runs a fake worker through the real `flowryn` hook and worker verbs, and the leader tests use a fake Claude leader that runs the real leader settings file's hooks and a fake Pi that loads the real leader extension. The live runs against Herdr, Claude Code and Pi are the contract suites and `scripts/lab/m2-live.sh` to `scripts/lab/m5-live.sh` (see "Running the live runs" below).

## Using flowryn

```bash
flowryn init                        # interactive: tools, data and state directories, tasks-axi files, launchd agent
flowryn doctor                      # checks config, tools, tasks-axi files, database, daemon and service
flowryn daemon status               # start | stop | install | uninstall | run (foreground)
flowryn todo add "renew passport" --due 2026-10-01
flowryn todo list                   # --all, --due today|overdue
flowryn todo due <id> tomorrow      # YYYY-MM-DD, today, tomorrow, +Nd or none
flowryn todo done <id>
flowryn project add ~/code/web      # reads origin and the default branch
flowryn project set web --mode direct-PR --yolo on
flowryn dispatch web --kind scout --body-file - <<'EOF'
Find where the login redirect loop comes from.
EOF
flowryn fleet                       # every worker: state, liveness, what it needs
flowryn show <task>                 # one run in detail
flowryn steer <task> --body-file -  # words for a worker, delivered at its next tool call or idle wake
flowryn answer <decision> <choice>  # answer a worker's question; it arrives as a steer
flowryn interrupt <task>            # stop the current turn (verified); cancel <task>; resume <task>
flowryn doctor --contracts          # run the harness contract suites and record each passing version
flowryn lead                        # start a Claude Code leader here; --pi for Pi; harness args after --
flowryn board                       # a live, read-only view: what needs you, the fleet, updates, to-dos (--once)
flowryn brief                       # the briefing again
flowryn dismiss <item>              # close an item that needs nothing more
flowryn leader status               # which session leads; leader claim [--session <id>] moves the lease
flowryn todo edit <id> --title <t>  # or --body-file -; the due date stays. todo rm <id> removes one
flowryn approve <task>              # your word for a merge: shows the PR, head and checks, reads a code from /dev/tty
flowryn approve <task> --allow-red lint   # waive exactly one failing check; --discard approves throwing work away
flowryn merge <task>                # through the merge gate; it counts only once GitHub (or local main) proves it
flowryn decline <task> --body-file -  # send a delivered ship back with your words
flowryn cleanup <task> [--discard]  # remove a landed, cancelled or failed task's worktree, through the cleanup guard
flowryn dispatch web --kind ship --workflow feature --body-file -   # design, review, build, visual QA, review, ship
flowryn plan web --body-file plan.md  # a phased feature: one "## Phase" section each; each starts once the one before lands
flowryn show p1                     # a plan's phases and where each is
flowryn approve <task> --gate design  # pass a review gate in your terminal (the board's a key lists reviews too)
flowryn gate changes <task> --body-file -  # send a review back with your words (QA goes back to build)
flowryn capacity                    # pools over their caps, the host check, and what waits for a grant
flowryn capacity resume --harness claude  # lift the Claude usage-limit pause now, in your own terminal
flowryn help                        # every verb; `flowryn <verb> --help` for one
```

A leader is the one conversation you talk to. `flowryn lead` runs Claude Code with a leader-only settings file (`--settings`) or Pi with the Flowryn leader extension (`-e`), plus the flowryn skill and the terse style block, all written under `~/.flowryn/leader/`; your own harness settings are never edited. One session holds the leader lease: it gets a briefing at every session start and compaction, a digest of new items on your next message, and a P0 line after its current turn, or as a new turn when it is idle and you are away. Any other leader session is read-only until it runs `flowryn leader claim`. P0s and batched updates also reach you as macOS and Herdr notifications.

Output is TOON by default and JSON with `--json`. Errors print `error`, `code` and `help`, and the exit code says what happened: 0 ok, 2 policy refusal, 3 validation, 4 not found, 69 daemon down, 75 spooled, 76 protocol mismatch, 77 role refused. When the daemon is down, reads come from the database read-only with a banner, worker verbs spool to disk and are delivered at the next start, and leader mutations exit 69.

Configuration lives in `~/.flowryn/config.toml` (`FLOWRYN_HOME` moves the whole home, which tests use). The daemon reloads it on `SIGHUP`, and keeps the old configuration when the new one fails validation. M2 adds `[herdr]` (`socket` or `session`), `[workers]` (`worktree_root`, `branch_prefix`), `[workers.claude]` (`model`, `effort`, `permission_mode`, `pretrust`, `config_dir`, `extra_args`), `[workers.pi]` (`model`, `effort`, `agent_dir`, `session_dir`, `extensions`, `no_extensions`, `no_skills`, `no_context_files`, `extra_args`, `env`) and `[reconcile]` (the reconciler's clocks, for tests and the lab); [`docs/m2-notes.md`](docs/m2-notes.md) explains each. M3 adds `[notify]` (`macos`, `herdr`, `min_interval_min`, `p0_coalesce_s`, `max_triggered_turns_per_hour`, `p0_renotify_min`) and `[leader]` (the leader's clocks, for tests and the lab); [`docs/m3-notes.md`](docs/m3-notes.md) explains them. M4 adds `[github]` (`api_url`, `web_url`, `token_env`, `poll_ms`, `timeout_ms`, `merge_method`) and `[cleanup]` (the cleanup guard's clocks); [`docs/m4-notes.md`](docs/m4-notes.md) explains them. The macOS notification channel is on in your own setup unless `[notify] macos = false` (`flowryn init` asks and writes the answer; `flowryn doctor` warns when the key is missing). `FLOWRYN_NOTIFY=off` makes a daemon record its notifications without delivering any: the tests and live runs set it, and refuse to start a daemon without it. M5 adds `[workflows.<id>]` (`stages = [{ id, skill, gate, pools, fresh }]`), `[capacity]` (a cap per pool) and `[capacity.host]` (`min_free_mem_gb`, `max_load_per_core`, `probe`), `[autonomy]` (`default`), `[style]` (`terse`, `text` or `file`), `[sched]` (the scheduler's clocks, for tests and the lab) and `docker` in `[tools]`; [`docs/m5-notes.md`](docs/m5-notes.md) explains them. The daemon sends a GitHub token (from `GH_TOKEN`, `GITHUB_TOKEN` or `gh auth token`) only to GitHub's own API.

Workers call the same CLI from their pane, with the run's token: `report`, `ask`, `inbox`, `ack`, `stage done` (with `--review <lavish url>` before a review gate), `stage begin <last stage>` (a no-mistakes ship calls it before its pipeline, so the pipeline runs under the ship stage's `validation` slot; `stage_waiting` means end the turn until a steer says it has started) and `stage show`, `deliver` (`--report` for a scout; `--pr <url>` or `--local` for a ship, by the project's delivery mode) and `fail`, and the `hook` verbs their Claude hooks or Pi extension call. A merge needs your word: a Claude leader's `flowryn merge` puts Claude's own prompt in front of you, and a Pi leader merges through its `flowryn_merge` tool, which asks you with a confirm; or approve in your shell (`flowryn approve`) or on the board (`a`). Dispatch refuses a harness version that has no passing contract run, so run `flowryn doctor --contracts` after installing or updating Claude Code or Pi.

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

It provisions a Herdr lab session through Firstmate's `fm-herdr-lab.sh` (or reuses `FLOWRYN_LAB_SESSION`), builds a scratch Flowryn home and daemon, and removes both at the end. `--keep` leaves the home for inspection. Pi works in a fresh clone of this repository inside that home, with a scratch agent dir and the offline scripted provider; set `M2_PI_MODEL` to use another model. Claude runs only with `--claude-project <checkout>`: a checkout Claude already trusts, whose linked worktrees inherit that trust. `pretrust = "check"` means `~/.claude.json` is never written. Every branch the run creates is named `flowryn/contract-<runid>-…`, and the run removes exactly those branches and their worktrees on exit, including on failure or a signal. Results print as PASS/FAIL lines and go to `spikes/.runs/m2-live-results.json`. Run it outside any command sandbox. [`docs/m2-notes.md`](docs/m2-notes.md) records the latest results.

### The M3 leader bridges, live

The shared leader bridge contract suite runs in `bun test` against fake leaders. The live run proves it against real leaders started with `flowryn lead` in a Herdr lab session.

```bash
scripts/lab/m3-live.sh --claude-project "$PWD"               # Claude Code and Pi
scripts/lab/m3-live.sh pi                                     # Pi only (the offline scripted provider)
```

It provisions a Herdr lab session through Firstmate's `fm-herdr-lab.sh` (or reuses `FLOWRYN_LAB_SESSION`), builds a scratch Flowryn home and daemon, starts two leaders of each harness in lab panes, types into them as you would, and removes everything at the end (`--keep` leaves the home). Claude leads from a linked worktree of the checkout you name, which Claude must already trust, on a `flowryn/contract-<runid>-leader` branch removed with its worktree on exit; `M3_CLAUDE_MODEL` defaults to `haiku`. Pi leads from a scratch directory with a scratch agent dir and the offline scripted provider; set `M3_PI_MODEL` (and `M3_PI_AGENT_DIR` with a copy of its `auth.json`) to use another model. Results print as PASS/FAIL lines and go to `spikes/.runs/m3-live-results.json`. Run it outside any command sandbox.

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

## Running the M0 spikes

The spikes are throwaway shell scripts under [`spikes/`](spikes), grouped as `claude/`, `herdr/`, `tasks-axi/`, `no-mistakes/` and `pi/`. Each script prints one `VERDICT <id>: <verdict>` line and writes `spikes/.runs/results/<id>.json`. `spikes/.runs/` is gitignored and holds every log, probe event and transcript pointer.

Requirements: macOS, `bash`, `jq`, `perl`, and the tools under test (`claude`, `herdr`, `tasks-axi`, `no-mistakes`; Pi for the Pi group, found as `PI_BIN`, then `/opt/homebrew/bin/pi-signed`, then `pi` on `PATH`). Herdr and Claude spikes need Firstmate's lab helper at `${FIRSTMATE_REPO:-$HOME/projects/firstmate}/bin/fm-herdr-lab.sh`; set `FIRSTMATE_REPO` or `HERDR_LAB_HELPER` to point elsewhere.

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

- Every Herdr call goes through `fm-herdr-lab.sh`, which pins a named `fm-lab-*` session and checks that the default session is unchanged at teardown. No spike touches the default session or a pane it did not create.
- Each Claude spike passes a per-spike settings file with `--settings` and runs in its own lab workspace. Sessions start from the repo root with `--setting-sources user`, so the repo's `CLAUDE.md` import raises no dialog and no project or local settings load. No spike edits `~/.claude/settings.json`, project settings or `~/.claude.json`.
- tasks-axi spikes use scratch backlogs under `spikes/.runs/`.
- `spikes/no-mistakes/n01-gate-env.sh` is read-only; `--watch <seconds>` scans a live gate run's processes for worker-only variable names.
- The Herdr and Claude spikes need access to Herdr's sockets, so run them outside any command sandbox.

Pi spikes need no model account: every turn comes from an offline scripted provider (`spikes/pi/lib/scripted-provider.ts`), and each Pi process uses a scratch agent dir, so `~/.pi` is never read or written. [`spikes/pi/NOTES.md`](spikes/pi/NOTES.md) covers the method and an optional real-model smoke pass.

Claude spikes use Haiku by default (`CLAUDE_SPIKE_MODEL`). The ask-prompt and steer spikes, and the auto-mode run in `c09`, default to Sonnet, because their outcome depends on the model. A full run makes real model calls: about two dozen short sessions.

The cleanup-guard fixtures are separate: `fixtures/cleanup-guard/run.sh` builds and checks all 21 landed-work cases, and `fixtures/cleanup-order/run.sh` the 23 cleanup-order cases (index locks, parked no-mistakes runs, leaked processes, the order of the steps); `run.sh --impl <cmd>` runs an implementation against either set. See [`fixtures/cleanup-guard/README.md`](fixtures/cleanup-guard/README.md) and [`fixtures/cleanup-order/README.md`](fixtures/cleanup-order/README.md).
