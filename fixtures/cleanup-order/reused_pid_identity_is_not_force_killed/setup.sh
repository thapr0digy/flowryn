#!/usr/bin/env bash
# reused_pid_identity_is_not_force_killed - starts the runtime state (locks, processes, no-mistakes answers) for this cleanup-order case.
# Ported from the reference's tests/fm-teardown.test.sh:test_reused_pid_identity_is_not_force_killed.
# Usage: setup.sh <scenario-dir>
# shellcheck source=../lib/order-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/order-common.sh"
oc_runtime "${1:?usage: setup.sh <scenario-dir>}"

mkdir -p "$OC_DIR/elsewhere"
pid=$(oc_start_in "$OC_DIR/elsewhere" '$SIG{TERM} = "IGNORE"; sleep 300')
echo "$pid" > "$OC_DIR/runtime/watch-pids"
echo "$pid" > "$OC_DIR/runtime/lsof-pid"
echo "$OC_WT" > "$OC_DIR/runtime/lsof-cwd"
echo 3 > "$OC_DIR/runtime/lsof-scans"
oc_fake_ps_flip "$pid" 1
sleep 0.2
