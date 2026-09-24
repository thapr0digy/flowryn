#!/usr/bin/env bash
# M3 leader bridges, live (docs/m3-notes.md "Live runs"): the shared leader
# bridge contract suite (src/contracts/bridge-suite.ts) against real Claude
# Code and Pi leaders started with `flowryn lead` in panes of an isolated Herdr
# lab session from Firstmate's fm-herdr-lab.sh, never the default session. The
# helper tears the session down on exit and checks the default session is
# unchanged.
#
#   scripts/lab/m3-live.sh [--claude-project <checkout>] [--keep] [claude] [pi]
#
# Claude runs only with --claude-project: a checkout Claude already trusts,
# whose linked worktrees inherit that trust; the run creates one worktree on a
# `flowryn/contract-<runid>-` branch and removes both by exact name on exit.
# Pi runs in a scratch directory with a scratch agent dir and the offline
# scripted provider (M3_PI_MODEL overrides it; openrouter/openrouter/free with
# M3_PI_AGENT_DIR holding a copy of its auth.json). M3_CLAUDE_MODEL defaults to
# haiku. Run it outside any command sandbox: Herdr and the hooks need sockets.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
export FLOWRYN_LAB_LABEL="${FLOWRYN_LAB_LABEL:-flowryn-m3}"
# shellcheck source=../../spikes/lib/lab.sh
. "$ROOT/spikes/lib/lab.sh"
lab_ensure
SOCK=$(lab_socket_path) || lab_die "cannot resolve a non-default lab socket"
export M3_RESULTS="${M3_RESULTS:-$SPIKES_RUNS/m3-live-results.json}"
bun "$ROOT/scripts/lab/m3-live.ts" --herdr-socket "$SOCK" --session "$HERDR_LAB_SESSION" "$@"
