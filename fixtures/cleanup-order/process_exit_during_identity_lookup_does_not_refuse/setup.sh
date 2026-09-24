#!/usr/bin/env bash
# process_exit_during_identity_lookup_does_not_refuse - starts the runtime state (locks, processes, no-mistakes answers) for this cleanup-order case.
# Ported from Firstmate tests/fm-teardown.test.sh:test_process_exit_during_identity_lookup_does_not_refuse.
# Usage: setup.sh <scenario-dir>
# shellcheck source=../lib/order-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/order-common.sh"
oc_runtime "${1:?usage: setup.sh <scenario-dir>}"

echo 99999998 > "$OC_DIR/runtime/lsof-pid"
echo "$OC_WT" > "$OC_DIR/runtime/lsof-cwd"
echo 1 > "$OC_DIR/runtime/lsof-scans"
