#!/usr/bin/env bash
# parked_own_run_refuses_when_abort_is_unconfirmed - starts the runtime state (locks, processes, no-mistakes answers) for this cleanup-order case.
# Ported from the reference's tests/fm-teardown.test.sh:test_parked_own_run_refuses_when_abort_is_unconfirmed.
# Usage: setup.sh <scenario-dir>
# shellcheck source=../lib/order-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/order-common.sh"
oc_runtime "${1:?usage: setup.sh <scenario-dir>}"

oc_nm_parked fm/task-x1 "$OC_HEAD"
echo noop > "$OC_DIR/nm/after-abort"
oc_start_in "$OC_WT" 'sleep 300' > "$OC_DIR/runtime/watch-pids"
