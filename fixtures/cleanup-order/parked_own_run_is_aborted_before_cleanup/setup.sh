#!/usr/bin/env bash
# parked_own_run_is_aborted_before_cleanup - starts the runtime state (locks, processes, no-mistakes answers) for this cleanup-order case.
# Ported from the reference's tests/fm-teardown.test.sh:test_parked_own_run_is_aborted_before_teardown.
# Usage: setup.sh <scenario-dir>
# shellcheck source=../lib/order-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/order-common.sh"
oc_runtime "${1:?usage: setup.sh <scenario-dir>}"

oc_nm_parked fm/task-x1 "$OC_HEAD"
