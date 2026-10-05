#!/usr/bin/env bash
# M5 exit, live (docs/m5-notes.md "Live runs"): two two-phase features run side
# by side, each through design, review, build, visual QA, review, ship and
# merge, and each phase 2 starts by itself once its phase 1 has landed, on a real leader started with `flowryn lead`
# in a pane of an isolated Herdr lab session from spikes/lib/herdr-lab.sh,
# never the default session. The helper tears the session down on exit and
# checks the default session is unchanged.
#
#   scripts/lab/m5-live.sh [--claude-project <checkout>] [--seed-contracts] [--keep] [flow ...]
#   flows: pi claude (default: both)
#
#   pi      Pi leader; both phases on Pi workers (the offline scripted provider),
#           each feature in its own scratch local-only repository. Gates: the design through the
#           flowryn_gate_pass confirm, QA through the board's approve key.
#   claude  Claude leader; phase 1 on a scripted Pi worker, phase 2 on a real
#           Claude worker, each feature in its own linked worktree of a checkout
#           Claude already trusts (--claude-project). Gates: the design through Claude's
#           permission prompt, QA through `flowryn approve --gate qa` in a lab
#           pane (the code read from /dev/tty).
#
# Visual QA runs for real: an nginx:alpine container labelled
# flowryn.run=<run>, a curl of the page and a chrome-devtools-axi screenshot.
# The phase-1 workers of both features are live together, besides the leader:
# the worker pool is capped at 4, and a flow fails unless the sampled peak of
# live worker processes is 2 to 4. The run answers two kinds of prompt
# only, because they are what is under test: the review and merge
# confirmations. It never answers a trust dialog, and never writes
# ~/.claude.json or ~/.pi. M5_CLAUDE_MODEL defaults to haiku; M5_PI_MODEL to
# the scripted provider. Run it outside any command sandbox: Herdr, Docker and
# the hooks need sockets.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
export FLOWRYN_LAB_LABEL="${FLOWRYN_LAB_LABEL:-flowryn-m5}"
# shellcheck source=../../spikes/lib/lab.sh
. "$ROOT/spikes/lib/lab.sh"
lab_ensure
SOCK=$(lab_socket_path) || lab_die "cannot resolve a non-default lab socket"
export M5_RESULTS="${M5_RESULTS:-$SPIKES_RUNS/m5-live-results.json}"
bun "$ROOT/scripts/lab/m5-live.ts" --herdr-socket "$SOCK" --session "$HERDR_LAB_SESSION" "$@"
