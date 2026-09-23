# Flowryn

Flowryn is a self-contained coordinator for a fleet of coding agents. You talk to one leader agent (Claude Code or Pi), and it dispatches workers into isolated worktrees in Herdr panes. Workers push their updates to a single daemon, `flowrynd`, which keeps runtime state in SQLite, ranks each update, and delivers it to the leader at a natural pause so your main conversation is not flooded or interrupted.

## Status

M0 contract spikes have run for Claude Code, Herdr, tasks-axi and no-mistakes. There is no product code yet. The architecture spec is [`docs/design-v3.html`](docs/design-v3.html); open it in a browser. [`docs/m0-verdicts.md`](docs/m0-verdicts.md) records every spike's verdict, the tool versions tested, and each edit the verdicts made to the design. The Pi spikes are written but have not run, because Pi is not installed on the test machine.

## Key choices

- The control plane is CLI-first: an agent-ergonomic `flowryn` CLI over the daemon socket. An MCP wrapper is optional.
- Runtime state lives in SQLite, owned by `flowrynd`. Tasks and to-dos live in tasks-axi, whose location is set during setup.
- Claude Code and Pi are first-class leaders, and Herdr is the runtime.

## Running the M0 spikes

The spikes are throwaway shell scripts under [`spikes/`](spikes), grouped as `claude/`, `herdr/`, `tasks-axi/`, `no-mistakes/` and `pi/`. Each script prints one `VERDICT <id>: <verdict>` line and writes `spikes/.runs/results/<id>.json`. `spikes/.runs/` is gitignored and holds every log, probe event and transcript pointer.

Requirements: macOS, `bash`, `jq`, `perl`, and the tools under test (`claude`, `herdr`, `tasks-axi`, `no-mistakes`; `pi` for the Pi group). Herdr and Claude spikes need Firstmate's lab helper at `/Users/pr0digy/projects/firstmate/bin/fm-herdr-lab.sh`; set `HERDR_LAB_HELPER` to point elsewhere.

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

Claude spikes use Haiku by default (`CLAUDE_SPIKE_MODEL`). The ask-prompt and steer spikes default to Sonnet, because their outcome depends on the model. A full run makes real model calls: about two dozen short sessions.

The cleanup-guard fixtures are separate: `fixtures/cleanup-guard/run.sh` builds and checks all 21 cases, and `run.sh --impl <cmd>` runs a guard implementation against them. See [`fixtures/cleanup-guard/README.md`](fixtures/cleanup-guard/README.md).
