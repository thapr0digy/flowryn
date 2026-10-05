#!/usr/bin/env bash
# M2 exit, live (docs/m2-notes.md "Live runs"): the harness contract suites,
# a real scout on each harness, and recovery after killing a worker and,
# separately, the daemon mid-run. Everything Herdr-side happens in an isolated
# lab session from spikes/lib/herdr-lab.sh, never the default session; the
# helper tears it down on exit and checks the default session is unchanged.
#
#   scripts/lab/m2-live.sh [--claude-project <checkout>] [--keep] [phase ...]
#   phases: contracts scouts kill-worker kill-daemon (default: all)
#
# Environment: FLOWRYN_LAB_SESSION reuses a held lab session (spikes/lib/lab-hold.sh);
# M2_CLAUDE_MODEL (default haiku); M2_PI_MODEL (default the offline scripted provider;
# openrouter/openrouter/free with M2_PI_AGENT_DIR holding a copy of its auth.json).
# Pi works in a fresh clone inside the scratch home, with a scratch agent dir,
# never ~/.pi. Claude phases run only with --claude-project: a checkout Claude
# already trusts, whose linked worktrees inherit that trust; pretrust = "check",
# so ~/.claude.json is never written. The scratch home is removed at the end.
# Run it outside any command sandbox: Herdr and the worker hooks need sockets.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
export FLOWRYN_LAB_LABEL="${FLOWRYN_LAB_LABEL:-flowryn-m2}"
# shellcheck source=../../spikes/lib/lab.sh
. "$ROOT/spikes/lib/lab.sh"
lab_ensure
SOCK=$(lab_socket_path) || lab_die "cannot resolve a non-default lab socket"
export M2_RESULTS="${M2_RESULTS:-$SPIKES_RUNS/m2-live-results.json}"
bun "$ROOT/scripts/lab/m2-live.ts" --herdr-socket "$SOCK" --session "$HERDR_LAB_SESSION" "$@"
