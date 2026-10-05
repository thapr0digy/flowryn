#!/usr/bin/env bash
# leaked_worktree_process_is_reaped - starts the runtime state (locks, processes, no-mistakes answers) for this cleanup-order case.
# Ported from the reference's tests/fm-teardown.test.sh:test_leaked_worktree_process_is_reaped.
# Usage: setup.sh <scenario-dir>
# shellcheck source=../lib/order-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/order-common.sh"
oc_runtime "${1:?usage: setup.sh <scenario-dir>}"

oc_start_in "$OC_WT" 'sleep 300' > "$OC_DIR/runtime/watch-pids"
sleep 0.3
