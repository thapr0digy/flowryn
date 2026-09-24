#!/usr/bin/env bash
# The v1 completion pass, live (docs/m5-notes.md "The v1 completion pass"):
# the harness version check at startup, a scout that lands with its report and
# is cleaned up, a scout promoted to a ship in place, divergences settled with
# keep-run and accept-edit, and Herdr unreachable as one P1. Everything
# Herdr-side happens in an isolated lab session from Firstmate's
# fm-herdr-lab.sh, never the default session; the last phase stops that
# session through the helper, which also tears it down on exit and checks the
# default session is unchanged.
#
#   scripts/lab/v1-live.sh [--keep] [phase ...]
#   phases: harness scout promote divergence herdr (default: all)
#
# Pi runs the offline scripted provider with a scratch agent dir, never ~/.pi;
# no Claude model is called (the harness phase reads `claude --version` only).
# The projects are fresh clones inside the scratch home, removed at the end.
# Run it outside any command sandbox: Herdr and the worker hooks need sockets.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
export FLOWRYN_LAB_LABEL="${FLOWRYN_LAB_LABEL:-flowryn-v1}"
# shellcheck source=../../spikes/lib/lab.sh
. "$ROOT/spikes/lib/lab.sh"
if [ -n "${FLOWRYN_LAB_SESSION:-}" ]; then
  echo "v1-live: the herdr phase stops its lab session, so it provisions its own; unset FLOWRYN_LAB_SESSION" >&2
  exit 2
fi
lab_ensure
SOCK=$(lab_socket_path) || lab_die "cannot resolve a non-default lab socket"
export V1_RESULTS="${V1_RESULTS:-$SPIKES_RUNS/v1-live-results.json}"
bun "$ROOT/scripts/lab/v1-live.ts" --herdr-socket "$SOCK" --session "$HERDR_LAB_SESSION" "$@"
