#!/usr/bin/env bash
# mismatched_run_after_abort_refuses_unconfirmed - starts the runtime state (locks, processes, no-mistakes answers) for this cleanup-order case.
# Ported from Firstmate tests/fm-teardown.test.sh:test_mismatched_run_after_abort_refuses_unconfirmed.
# Usage: setup.sh <scenario-dir>
# shellcheck source=../lib/order-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/order-common.sh"
oc_runtime "${1:?usage: setup.sh <scenario-dir>}"

oc_nm_parked fm/task-x1 "$OC_HEAD"
echo other:02RUN > "$OC_DIR/nm/after-abort"
