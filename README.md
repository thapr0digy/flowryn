# Flowryn

Flowryn coordinates a fleet of coding agents. You talk to one leader agent (Claude Code or Pi). It dispatches workers into isolated git worktrees in Herdr panes. Workers report to one daemon, `flowrynd`, which keeps state in SQLite, ranks each update and hands it to the leader at a natural pause, so your conversation is not flooded.

v1 is built; [`docs/v1-status.md`](docs/v1-status.md) lists every item and its PR.

## Install

Requirements:

- macOS, `git`, Node, and [Bun](https://bun.sh) 1.3.8.
- `tasks-axi` 0.2.5 on PATH: `npm install -g tasks-axi@0.2.5`.
- Herdr 0.7.5 or newer, and Claude Code and/or Pi.
- Optional: `no-mistakes` (that delivery mode), Docker (visual QA), `lavish-axi` (review pages), `gh` signed in (GitHub PRs).

Build and link the binary (it is both `flowryn` and `flowrynd`):

```bash
bun install
bun run build                                   # dist/flowryn, re-signed on macOS
ln -sf "$PWD/dist/flowryn" ~/.local/bin/flowryn
```

## Set up

```bash
flowryn init                 # interactive: tools (one y/N installs the missing axi tools, acli, treehouse),
                             # data and state dirs, tasks-axi files, launchd agent, [policy] mode, notifications
flowryn doctor               # checks config, tools (with install commands), database, daemon, service
flowryn doctor --contracts   # run the harness contract suites; needed before any dispatch
flowryn project add ~/code/web   # reads origin and the default branch
```

- zsh tab completion: add `source <(flowryn completion zsh)` to `~/.zshrc` after `compinit` ([docs/notes/2026-10-29-zsh-completions-for-49.md](docs/notes/2026-10-29-zsh-completions-for-49.md)).
- Re-run `flowryn doctor --contracts` after installing or updating Claude Code or Pi. Dispatch refuses an untested harness version.
- Run `doctor` in your own terminal.
- GitHub token: `GH_TOKEN`, `GITHUB_TOKEN` or `gh auth token`. It is sent only to GitHub's API.
- Moved the binary? Run `flowryn daemon uninstall && flowryn daemon install`: the launchd plist records the binary path.

## Use

Start a leader and talk to it:

```bash
flowryn lead                 # Claude Code leader here; --pi for Pi; harness args after --
```

The leader runs with its own settings under `~/.flowryn/leader/`; your harness settings are never edited. It gets a briefing at session start, a digest of updates on your next message, and P0s as they happen.

With work and personal accounts in one home, start one leader per scope: `flowryn lead --account claude-work` leads work only, and a leader on your personal login leads personal only (docs/notes/2026-10-24-leader-scoping-and-vj.md).

The core verbs (you or the leader):

```bash
flowryn dispatch web --kind scout --body-file - <<'EOF'
Find where the login redirect loop comes from.
EOF
flowryn dispatch web --kind ship --workflow feature --body-file -   # design, review, build, ship
flowryn fleet                # every worker and queued task: state, what it needs
flowryn show <id>            # one task, run, item, decision or plan; --full for whole text
flowryn steer <task> --body-file -   # words for a worker; --urgent cuts in
flowryn board                # live read-only view; `a` approves
flowryn approve <task>       # your word for a merge (code from /dev/tty); --gate design passes a review gate
flowryn merge <task>         # through the merge gate
flowryn cleanup <task>       # remove a landed task's worktree through the cleanup guard
flowryn drop <task|plan> --body-file -   # remove queued work that never started; the reason is kept
flowryn help                 # every verb; `flowryn <verb> --help` for one
```

- Merges and review gates need your word: Claude's prompt, Pi's confirm, `flowryn approve` or the board.
- Output is TOON; `--json` for JSON. Exit codes: 0 ok, 2 policy refusal, 3 validation, 4 not found, 69 daemon down, 75 spooled, 76 protocol mismatch, 77 role refused.
- Config: `~/.flowryn/config.toml` (`FLOWRYN_HOME` moves the home). `SIGHUP` reloads it. Each key is explained in the milestone notes and [`docs/notes/`](docs/notes/README.md); `bun run notes` lists them.

## Design and notes

- [`docs/design-v3.html`](docs/design-v3.html): the architecture spec (open in a browser).
- [`docs/m0-verdicts.md`](docs/m0-verdicts.md): what each platform behaviour actually does.
- [`docs/m1-notes.md`](docs/m1-notes.md) to [`docs/m5-notes.md`](docs/m5-notes.md), [`docs/cutover-notes.md`](docs/cutover-notes.md): choices and live results up to 2026-10-09 (frozen).
- [`docs/notes/`](docs/notes/README.md): one file per feature since then.

## Development

```bash
bun install
bun run typecheck            # tsc --noEmit
bunx oxlint                  # lint
bun test                     # unit and integration tests
bun run build                # dist/flowryn plus the dist/flowrynd link
fixtures/cleanup-guard/run.sh --impl "bun $PWD/scripts/guard/landed-impl.ts"   # 21 landed-work fixtures
fixtures/cleanup-order/run.sh --impl "bun $PWD/scripts/guard/cleanup-impl.ts"  # 23 cleanup-order fixtures
```

- Requires `jq` for the fixtures.
- Run `bun test` outside any command sandbox: it starts daemons on Unix sockets, uses FSEvents, runs the real tasks-axi and drives a pty. It never reaches GitHub, Herdr or a real harness.
- A rebuild from `origin/<default branch>` is applied by the daemon by itself (`[daemon] auto_restart`); `flowryn daemon restart` applies any build now.
- CI runs on `ubuntu-latest`; macOS-only tests are skipped there, so run `bun test` on the Mac before a PR. **CI is off until about 2026-11-07** ([how to re-enable](docs/v1-status.md#ci-is-off-2026-10-07)).
- Source layout follows section 4 of the design (`src/<component>`).

## Running the live runs

Live runs drive real Herdr, Claude Code and Pi in a lab session. Run them outside any command sandbox. Each prints PASS/FAIL lines and writes `spikes/.runs/<name>-results.json`.

- `flowryn doctor --contracts`: the harness contract suites.
- `scripts/lab/m2-live.sh` to `m5-live.sh`, `v1-live.sh`, `cutover-live.sh`: each milestone's exit test. Claude phases need `--claude-project <a checkout Claude already trusts>`. Details and latest results: the matching `docs/m*-notes.md`, `docs/m5-notes.md` (v1) and `docs/cutover-notes.md`.

## Running the M0 spikes

Throwaway scripts under [`spikes/`](spikes), grouped as `claude/`, `herdr/`, `tasks-axi/`, `no-mistakes/` and `pi/`. Each prints a `VERDICT <id>: <verdict>` line and writes `spikes/.runs/results/<id>.json`.

```bash
spikes/run-all.sh                        # every group, one lab session
spikes/run-all.sh tasks-axi              # one group
bash spikes/claude/c01-async-rewake.sh   # one spike
```

- Needs `bash`, `jq`, `perl` and the tools under test (Pi via `PI_BIN`, `/opt/homebrew/bin/pi-signed` or `pi`).
- Run outside any command sandbox, from a checkout Claude already trusts; the spikes never accept the trust dialog.
- Herdr calls go through `spikes/lib/herdr-lab.sh` (`fl-lab-*` sessions only; `HERDR_LAB_HELPER` overrides it). To share one session across runs:

  ```bash
  mkdir -p spikes/.runs && spikes/lib/lab-hold.sh &
  export FLOWRYN_LAB_SESSION=$(cat spikes/.runs/lab-session)
  touch spikes/.runs/lab-release           # tears it down
  ```
- Claude spikes make real model calls (Haiku by default, `CLAUDE_SPIKE_MODEL`). Pi spikes use an offline scripted model; see [`spikes/pi/NOTES.md`](spikes/pi/NOTES.md).
- Cleanup-guard fixtures: [`fixtures/cleanup-guard/README.md`](fixtures/cleanup-guard/README.md), [`fixtures/cleanup-order/README.md`](fixtures/cleanup-order/README.md).
