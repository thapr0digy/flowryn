# Flowryn

Flowryn is a self-contained coordinator for a fleet of coding agents. You talk to one leader agent (Claude Code or Pi), and it dispatches workers into isolated worktrees in Herdr panes. Workers push their updates to a single daemon, `flowrynd`, which keeps runtime state in SQLite, ranks each update, and delivers it to the leader at a natural pause so your main conversation is not flooded or interrupted.

## Status

M1 (core) is built: one signed binary that is both `flowryn` and `flowrynd`, the SQLite schema and event log, the tasks-axi intent journal and backlog watcher, and the CLI with to-do and project verbs, `init`, `doctor` and the launchd agent.

M2 (runtime, workers, reconciler) is built: the Herdr runtime, Claude Code and Pi worker adapters with their contract suites, the isolation assertion, the worker verbs, steers with re-ring, and the reconciler (evidence ranking, reattach, husks and resume-once). The leader bridges, attention lanes and lease (M3), delivery and merge policy (M4), and workflows and capacity (M5) come next.

The architecture spec is [`docs/design-v3.html`](docs/design-v3.html); open it in a browser. [`docs/m0-verdicts.md`](docs/m0-verdicts.md) records every M0 spike's verdict (Claude Code, Herdr, tasks-axi, no-mistakes and Pi), the tool versions tested, and each edit the verdicts made to the design. [`docs/m1-notes.md`](docs/m1-notes.md) and [`docs/m2-notes.md`](docs/m2-notes.md) list the choices each milestone made where the design leaves room, and M2's live results.

## Development

Requirements: macOS, [Bun](https://bun.sh) 1.3.8, Node with `tasks-axi` 0.2.5 on PATH (`npm install -g tasks-axi@0.2.5`), `git`, and `jq` for the fixtures.

```bash
bun install                      # dependencies
bun run typecheck                # tsc --noEmit
bunx oxlint                      # lint (.oxlintrc.json); `bun run lint` runs the same
bun test                         # unit and integration tests, including the kill -9 exit test
bun run build                    # dist/flowryn plus the dist/flowrynd link, re-signed on macOS
fixtures/cleanup-guard/run.sh    # the 21 cleanup-guard fixtures
```

The tests start real daemons on Unix sockets, watch files with FSEvents and run the real tasks-axi, so run them outside any command sandbox. CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs all of the above on every pull request and on pushes to `main`.

The source layout follows the component table in section 4 of the design: `src/api` (gateway, tokens, idempotency, spool), `src/journal` (intent journal, backlog watcher), `src/lifecycle` (to-do, project, dispatch, launcher, steers, worker and hook verbs), `src/harness` (the Claude and Pi adapters and the Pi worker extension), `src/runtime` (the Herdr client and runtime, process identity), `src/reconcile`, `src/watch` (the Herdr subscription), `src/contracts` (the harness contract suites), `src/daemon`, `src/cli`, `src/db` (schema, migrations, events, backups), `src/transport`, `src/service` (launchd), `src/init` and `src/doctor`.

The tests never touch a real Herdr or harness: runtime tests use a fake Herdr (`test/helpers/fake-herdr.ts`) that runs a fake worker through the real `flowryn` hook and worker verbs. The live runs against Herdr, Claude Code and Pi are the contract suites and `scripts/lab/m2-live.sh` (see "Running the M2 live exit" below).

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
flowryn help                        # every verb; `flowryn <verb> --help` for one
```

Output is TOON by default and JSON with `--json`. Errors print `error`, `code` and `help`, and the exit code says what happened: 0 ok, 2 policy refusal, 3 validation, 4 not found, 69 daemon down, 75 spooled, 76 protocol mismatch, 77 role refused. When the daemon is down, reads come from the database read-only with a banner, worker verbs spool to disk and are delivered at the next start, and leader mutations exit 69.

Configuration lives in `~/.flowryn/config.toml` (`FLOWRYN_HOME` moves the whole home, which tests use). The daemon reloads it on `SIGHUP`, and keeps the old configuration when the new one fails validation. M2 adds `[herdr]` (`socket` or `session`), `[workers]` (`worktree_root`, `branch_prefix`), `[workers.claude]` (`model`, `effort`, `permission_mode`, `pretrust`, `config_dir`, `extra_args`), `[workers.pi]` (`model`, `effort`, `agent_dir`, `session_dir`, `extensions`, `no_extensions`, `no_skills`, `no_context_files`, `extra_args`, `env`) and `[reconcile]` (the reconciler's clocks, for tests and the lab); [`docs/m2-notes.md`](docs/m2-notes.md) explains each.

Workers call the same CLI from their pane, with the run's token: `report`, `ask`, `inbox`, `ack`, `deliver` and `fail`, and the `hook` verbs their Claude hooks or Pi extension call. Dispatch refuses a harness version that has no passing contract run, so run `flowryn doctor --contracts` after installing or updating Claude Code or Pi.

## Key choices

- The control plane is CLI-first: an agent-ergonomic `flowryn` CLI over the daemon socket. An MCP wrapper is optional.
- Runtime state lives in SQLite, owned by `flowrynd`. Tasks and to-dos live in tasks-axi, whose location is set during setup.
- Claude Code and Pi are first-class leaders, and Herdr is the runtime.

## Running the M2 live exit

M2's exit test runs a real scout on each harness, kills a worker mid-run and, separately, the daemon, and checks that both recover. Unit and integration tests cover the same paths against the fake Herdr; the live run proves them against Herdr 0.7.5, Claude Code and Pi.

```bash
scripts/lab/m2-live.sh --claude-project "$PWD"               # every phase
scripts/lab/m2-live.sh contracts                              # one phase: contracts, scouts, kill-worker or kill-daemon
```

It provisions a Herdr lab session through Firstmate's `fm-herdr-lab.sh` (or reuses `FLOWRYN_LAB_SESSION`), builds a scratch Flowryn home and daemon, and removes both at the end. `--keep` leaves the home for inspection. Pi works in a fresh clone of this repository inside that home, with a scratch agent dir and the offline scripted provider; set `M2_PI_MODEL` to use another model. Claude runs only with `--claude-project <checkout>`: a checkout Claude already trusts, whose linked worktrees inherit that trust. `pretrust = "check"` means `~/.claude.json` is never written. Every branch the run creates is named `flowryn/contract-<runid>-…`, and the run removes exactly those branches and their worktrees on exit, including on failure or a signal. Results print as PASS/FAIL lines and go to `spikes/.runs/m2-live-results.json`. Run it outside any command sandbox. [`docs/m2-notes.md`](docs/m2-notes.md) records the latest results.

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

The cleanup-guard fixtures are separate: `fixtures/cleanup-guard/run.sh` builds and checks all 21 cases, and `run.sh --impl <cmd>` runs a guard implementation against them. See [`fixtures/cleanup-guard/README.md`](fixtures/cleanup-guard/README.md).
