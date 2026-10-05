#!/usr/bin/env bash
# persistent_scan_refuses_after_bounded_retries - starts the runtime state (locks, processes, no-mistakes answers) for this cleanup-order case.
# Ported from the reference's tests/fm-teardown.test.sh:test_persistent_scan_refuses_after_bounded_retries.
# Usage: setup.sh <scenario-dir>
# shellcheck source=../lib/order-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/order-common.sh"
oc_runtime "${1:?usage: setup.sh <scenario-dir>}"

echo 99999999 > "$OC_DIR/runtime/lsof-pid"
echo "$OC_WT" > "$OC_DIR/runtime/lsof-cwd"
oc_fake_ps_ghost 99999999
