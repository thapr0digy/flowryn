#!/usr/bin/env bash
# terminal_status_with_gate_is_never_aborted - starts the runtime state (locks, processes, no-mistakes answers) for this cleanup-order case.
# Ported from the reference's tests/fm-teardown.test.sh:test_terminal_status_with_gate_never_queries_or_aborts_ledger_fallback.
# Usage: setup.sh <scenario-dir>
# shellcheck source=../lib/order-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib/order-common.sh"
oc_runtime "${1:?usage: setup.sh <scenario-dir>}"

oc_nm_parked fm/task-x1 "$OC_HEAD"
sed -i.bak "s/status: awaiting_approval/status: completed/" "$OC_DIR/nm/status" && rm -f "$OC_DIR/nm/status.bak"
