#!/usr/bin/env bash
# empty_status_after_abort_refuses_unconfirmed - starts the runtime state (locks, processes, no-mistakes answers) for this cleanup-order case.
# Ported from Firstmate tests/fm-teardown.test.sh:test_empty_status_after_abort_refuses_unconfirmed.
# Usage: setup.sh <scenario-dir>
# shellcheck source=../lib/order-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/order-common.sh"
oc_runtime "${1:?usage: setup.sh <scenario-dir>}"

oc_nm_parked fm/task-x1 "$OC_HEAD"
echo empty > "$OC_DIR/nm/after-abort"
