#!/usr/bin/env bash
# run_abort_precedes_process_reap_precedes_worktree_removal - starts the runtime state (locks, processes, no-mistakes answers) for this cleanup-order case.
# Ported from Firstmate tests/fm-teardown.test.sh:test_run_abort_precedes_process_reap_precedes_worktree_removal.
# Usage: setup.sh <scenario-dir>
# shellcheck source=../lib/order-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/order-common.sh"
oc_runtime "${1:?usage: setup.sh <scenario-dir>}"

oc_nm_parked fm/task-x1 "$OC_HEAD"
oc_start_in "$OC_WT" 'sleep 300' > "$OC_DIR/runtime/watch-pids"
sleep 0.3
