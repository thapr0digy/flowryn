#!/usr/bin/env bash
# The cutover live run (docs/cutover-notes.md "Live runs"): a real Claude
# scout raising, and the leader and the user answering, standalone decisions,
# and a real Claude worker wedged by a user-level permission hook. Everything
# Herdr-side happens in an isolated lab session from
# spikes/lib/herdr-lab.sh, never the default session.
#
#   scripts/lab/cutover-live.sh [--keep] [phase ...]
#   phases: decisions prompt (default: both)
#
# No Pi model is ever called beyond the offline scripted provider; the real
# Claude calls are the two phases' own scouts. Everything lives in a scratch
# Flowryn home with fresh clones of this repository, linked into a worktree
# of this already-trusted checkout against your real ~/.claude (pretrust =
# "check", so nothing is ever written to ~/.claude.json); the scratch home is
# removed at the end (--keep leaves it). Run it outside any command sandbox:
# Herdr and the worker hooks need sockets.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
export FLOWRYN_LAB_LABEL="${FLOWRYN_LAB_LABEL:-flowryn-cutover}"
# shellcheck source=../../spikes/lib/lab.sh
. "$ROOT/spikes/lib/lab.sh"
lab_ensure
SOCK=$(lab_socket_path) || lab_die "cannot resolve a non-default lab socket"
export CUTOVER_RESULTS="${CUTOVER_RESULTS:-$SPIKES_RUNS/cutover-live-results.json}"
bun "$ROOT/scripts/lab/cutover-live.ts" --herdr-socket "$SOCK" --session "$HERDR_LAB_SESSION" "$@"
