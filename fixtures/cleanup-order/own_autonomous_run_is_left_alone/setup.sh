#!/usr/bin/env bash
# own_autonomous_run_is_left_alone - starts the runtime state (locks, processes, no-mistakes answers) for this cleanup-order case.
# Ported from the reference's tests/fm-teardown.test.sh:test_own_autonomous_run_is_left_alone.
# Usage: setup.sh <scenario-dir>
# shellcheck source=../lib/order-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/order-common.sh"
oc_runtime "${1:?usage: setup.sh <scenario-dir>}"

oc_nm_running fm/task-x1 "$OC_HEAD"
