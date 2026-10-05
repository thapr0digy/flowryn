#!/usr/bin/env bash
# M4 exit, live (docs/m4-notes.md "Live runs"): ships from dispatch to merged
# and cleaned on a real Claude Code leader and a real Pi leader started with
# `flowryn lead` in panes of an isolated Herdr lab session from
# spikes/lib/herdr-lab.sh, never the default session. Approval comes from each channel:
# Claude's own prompt, Pi's confirm, `flowryn approve` typed in a lab pane (the
# code read back from /dev/tty), and the board's approve key. Local-only ships
# land for real; direct-PR and no-mistakes ships go through a fake GitHub that
# this run serves on 127.0.0.1, so no real GitHub repository is touched. The
# helper tears the session down on exit and checks the default session is
# unchanged.
#
#   scripts/lab/m4-live.sh [--claude-project <checkout>] [--seed-contracts] [--keep] [flow ...]
#   flows: claude-ask cli-tty pi-confirm board forge (default: all)
#
# Claude flows run only with --claude-project: a checkout Claude already
# trusts, whose linked worktrees inherit that trust; every branch the run
# creates is `flowryn/contract-<runid>-...` and is removed with its worktree by
# exact name on exit. Pi runs with a scratch agent dir and the offline scripted
# provider (M4_PI_MODEL overrides it; openrouter/openrouter/free with
# M4_PI_AGENT_DIR holding a copy of its auth.json). M4_CLAUDE_MODEL defaults to
# haiku. Run it outside any command sandbox: Herdr and the hooks need sockets.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
export FLOWRYN_LAB_LABEL="${FLOWRYN_LAB_LABEL:-flowryn-m4}"
# shellcheck source=../../spikes/lib/lab.sh
. "$ROOT/spikes/lib/lab.sh"
lab_ensure
SOCK=$(lab_socket_path) || lab_die "cannot resolve a non-default lab socket"
export M4_RESULTS="${M4_RESULTS:-$SPIKES_RUNS/m4-live-results.json}"
bun "$ROOT/scripts/lab/m4-live.ts" --herdr-socket "$SOCK" --session "$HERDR_LAB_SESSION" "$@"
